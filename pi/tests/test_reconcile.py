"""Day reconciliation tests (issue #161, PR-1): archive vs charger total_day.

No broker, charger, Firestore or FCM is touched: the reconciler runs against
the in-memory fakes with injected clocks. Every scenario also pins the
zero-writes guarantee -- reconciliation reads and journals, it never writes
(#161's read-only invariant): ``FakeDB.writes`` stays empty across every
scenario, and pre-seeded history/session documents are byte-identical after
each pass.
"""

import os
import sys
import unittest
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
from fakes import (  # noqa: E402
    FakeDB,
    FakeResponse,
    FakeSession,
    _StopAfter,
    _host,
    _status_payload,
)
from test_mqtt import _RecordingNotifier  # noqa: E402


def _at(hour, minute=0, second=0, day=20):
    """One exact instant on the scenario day (2026-11-20 by default)."""
    return datetime(2026, 11, day, hour, minute, second, tzinfo=UTC)


class ReconcileBase(unittest.TestCase):
    """Charger-day samples at exact instants, logs captured, writes counted.

    The boottime clock advances with the wall clock between notes, the same
    convention ``test_bridge.HistoryTests`` uses for ``record_history``: the
    step allowance reads ``CLOCK_BOOTTIME``, so a scenario whose samples span
    an hour must advance that clock too or every step looks implausible.
    """

    DAY = "2026-11-20"

    def setUp(self):
        self.db = FakeDB()
        self.logs = []
        self.boot = 10_000.0
        self.now = _at(9)
        self._last_when = None
        self.counter = bridge.ChargerDayCounter()
        self.reconciler = bridge.DayReconciler()
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def note(self, value, when=None):
        """One charger observation at an exact wall-clock instant."""
        when = when or self.now
        if self._last_when is not None:
            self.boot += max(0.0, (when - self._last_when).total_seconds())
        self._last_when = when
        with (
            mock.patch.object(bridge, "_localnow", return_value=when),
            mock.patch.object(
                bridge.time, "clock_gettime", return_value=self.boot, create=True
            ),
            mock.patch.object(bridge.time, "monotonic", return_value=self.boot),
        ):
            self.counter.note(value)

    def evaluate(
        self,
        *,
        archive,
        pending=0.0,
        charger,
        when=None,
        observed=None,
        day=None,
    ):
        """One reconciliation evaluation at an exact wall-clock instant."""
        when = when or self.now
        with mock.patch.object(bridge, "_localnow", return_value=when):
            return self.reconciler.evaluate(
                day=day or self.DAY,
                now_local=when,
                archive_kwh=archive,
                pending_kwh=pending,
                charger_kwh=charger,
                charger_observed_local=observed or when,
            )

    def warnings(self):
        return [line for line in self.logs if "reconciliation warning" in line]

    def notes(self):
        return [line for line in self.logs if "reconciliation note" in line]


class LoopBase(ReconcileBase):
    """The reconcile loop against a tracker, sink and pre-seeded archive."""

    INTERVAL = 3600.0

    def setUp(self):
        super().setUp()
        self.tracker = bridge.StatusTracker(self.db)
        self.tracker.seeded = True
        self.sink = bridge.StatusSink(self.db, self.tracker, _RecordingNotifier())
        self._seeded_data = None

    def seed_history(self, kwh, hours=None, day=None):
        """Pre-seed one archive day document, snapshot it for byte-equality."""
        day = day or self.DAY
        self.db.data.setdefault("history", {})[day] = {
            "kwh": kwh,
            "hours": hours if hours is not None else {"09": kwh},
            "updated_at": "2026-11-20T09:00:00Z",
        }
        self.db.data.setdefault("sessions", {})[
            "1763614800"
        ] = {  # a pre-existing session: also byte-identical after a pass
            "started_at": _at(8),
            "ended_at": _at(9),
            "wh": 4000.0,
            "elapsed": 3600,
        }
        self._seeded_data = deepcopy(self.db.data)

    def seed_pending(self, kwh, when=None):
        """Leave ``kwh`` pending for the scenario day (no write, in memory)."""
        self.tracker.history.observe(kwh, when or self.now)

    def run_loop(self, ticks, on_wait=None):
        with (
            mock.patch.object(bridge, "_localnow", return_value=self.now),
            mock.patch.object(bridge, "_stop", _StopAfter(ticks, on_wait)),
        ):
            bridge.reconcile_loop(
                self.db,
                self.sink,
                self.counter,
                self.reconciler,
                self.INTERVAL,
            )

    def assert_no_writes(self):
        """The #161 invariant: reconciliation never writes anything."""
        self.assertEqual(self.db.writes, [])
        if self._seeded_data is not None:
            self.assertEqual(self.db.data, self._seeded_data)


class KnownGoodDayTests(LoopBase):
    """Scenario (a): a known-good day reconciles silently."""

    def test_matching_totals_are_clean_and_write_free(self):
        self.seed_history(12.4)
        self.seed_pending(0.1)
        self.note(12.5)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assertIn("warning authority granted", " ".join(self.logs))
        self.assert_no_writes()

    def test_within_one_percent_is_clean(self):
        self.note(100.0)
        self.assertEqual(self.evaluate(archive=100.0, charger=100.9), "clean")
        self.assertEqual(self.warnings(), [])

    def test_the_floor_governs_small_days(self):
        # max(0.05 kwh, 1% of the larger side): small totals use the floor.
        self.note(0.1)
        self.assertEqual(self.evaluate(archive=0.1, charger=0.14), "clean")
        self.assertEqual(self.evaluate(archive=0.1, charger=0.16), "warned")

    def test_one_percent_governs_large_days(self):
        self.note(100.0)
        self.assertEqual(self.evaluate(archive=100.0, charger=100.9), "clean")
        self.assertEqual(self.evaluate(archive=100.0, charger=102.0), "warned")

    def test_a_missing_archive_document_is_a_zero_day(self):
        # No history doc yet (early morning): archive 0 vs counter 0 is clean.
        self.note(0.0)
        self.assertEqual(self.evaluate(archive=0.0, charger=0.0), "clean")
        self.assert_no_writes()


class AbsentCounterTests(LoopBase):
    """Scenario (b): firmware below 4.2.2 reports no period counters."""

    def test_non_numeric_samples_never_make_the_counter_present(self):
        self.counter.note(None)
        self.counter.note(float("nan"))
        self.counter.note(-1.0)
        self.assertTrue(self.counter.fed)
        self.assertFalse(self.counter.present)
        self.assertIsNone(self.counter.sample())

    def test_the_loop_is_inactive_after_one_info_line(self):
        self.counter.note(None)  # an applied observation without counters
        self.run_loop(2)
        inactive = [line for line in self.logs if "inactive" in line]
        self.assertEqual(len(inactive), 1)
        self.assertIn("total_day", inactive[0])
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assert_no_writes()

    def test_an_unfed_counter_is_not_declared_inactive(self):
        # No status observation has applied yet (startup race): the loop
        # stays quiet rather than declaring a firmware it has not asked.
        self.run_loop(1)
        self.assertEqual([line for line in self.logs if "inactive" in line], [])

    def test_a_counter_that_appears_later_activates_the_loop(self):
        self.counter.note(None)
        self.run_loop(1)
        self.assertIn("inactive", " ".join(self.logs))
        self.seed_history(5.0)
        self.note(5.0, _at(10))
        self.now = _at(10)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assertIn("warning authority granted", " ".join(self.logs))


class MidDayRestartTests(LoopBase):
    """Scenario (c): the day counter resets mid-day, recovers, and the day's
    figures disagree -- exactly one warning with every field, then silence."""

    def test_exactly_one_warning_with_all_fields(self):
        # Morning: the archive and the charger's day counter grow in
        # lockstep; the 13:58 evaluation is clean (authority granted).
        self.seed_history(9.0, hours={"09": 4.0, "10": 3.0, "11": 2.0})
        self.note(0.0, _at(9))
        self.note(9.0, _at(13, 58))
        self.now = _at(13, 58)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])

        # 13:58:40 the gateway restarts and its day counter restarts at 0.
        reset = _at(13, 58, 40)
        self.note(0.02, reset)
        self.assertIn("day counter rollover", " ".join(self.logs))

        # 15:00: the counter recovered to 3.4 while the archive still holds
        # the whole day (9.0 flushed + 0.1 pending).
        recovered = _at(15)
        self.note(3.4, recovered)
        self.seed_pending(0.1, recovered)
        self.now = recovered
        self.run_loop(1)
        (warning,) = self.warnings()
        for expected in (
            "day 2026-11-20",  # the period and the date
            "9.100 kwh",  # bridge history: archive 9.0 + pending 0.1
            "archive 9.000",
            "pending 0.100",
            "charger total_day 3.400 kwh",
            "5.700 kwh",  # the gap
            "bridge high",  # which side is short
            "[2026-11-20 13:58 -> 2026-11-20 15:00] local",  # outage window
            "no history or session data modified",
        ):
            self.assertIn(expected, warning)
        self.assert_no_writes()

        # The next hour's evaluation is still divergent but the gap neither
        # changed direction nor grew by a kWh: no second warning.
        later = _at(16)
        self.db.data["history"][self.DAY]["kwh"] = 9.2
        self._seeded_data = deepcopy(self.db.data)
        self.note(3.5, later)
        self.now = later
        self.run_loop(1)
        self.assertEqual(self.warnings(), [warning])
        self.assert_no_writes()

    def test_a_gap_grown_by_a_kwh_rearms_the_warning(self):
        self.note(5.0)
        self.evaluate(archive=5.0, charger=5.0)  # clean; authority granted
        self.assertEqual(self.evaluate(archive=7.0, charger=5.0), "warned")
        self.assertEqual(self.evaluate(archive=7.4, charger=5.0), "held")
        self.assertEqual(self.evaluate(archive=8.05, charger=5.0), "warned")
        self.assertEqual(len(self.warnings()), 2)

    def test_a_direction_change_rearms_the_warning(self):
        self.note(5.0)
        self.evaluate(archive=5.0, charger=5.0)
        self.assertEqual(
            self.evaluate(archive=7.0, charger=5.0), "warned"
        )  # bridge high
        self.assertEqual(
            self.evaluate(archive=3.9, charger=5.0), "warned"
        )  # bridge low
        self.assertEqual(len(self.warnings()), 2)

    def test_a_clean_evaluation_closes_the_episode(self):
        self.note(5.0)
        self.evaluate(archive=5.0, charger=5.0)
        self.assertEqual(self.evaluate(archive=7.0, charger=5.0), "warned")
        self.assertEqual(self.evaluate(archive=7.1, charger=7.1), "clean")
        # A fresh divergence is a new episode and warns again.
        self.assertEqual(self.evaluate(archive=9.0, charger=7.1), "warned")
        self.assertEqual(len(self.warnings()), 2)

    def test_a_new_day_starts_a_new_episode(self):
        self.note(5.0)
        self.evaluate(archive=5.0, charger=5.0)
        self.assertEqual(self.evaluate(archive=7.0, charger=5.0), "warned")
        # The next day's first evaluation is clean and its own episode.
        self.note(0.5, _at(9, day=21))
        self.assertEqual(
            self.evaluate(
                archive=0.5, charger=0.5, when=_at(9, day=21), day="2026-11-21"
            ),
            "clean",
        )
        # The stale episode for the old day must not suppress today's warning.
        self.note(2.5, _at(10, day=21))
        self.assertEqual(
            self.evaluate(
                archive=4.5, charger=2.5, when=_at(10, day=21), day="2026-11-21"
            ),
            "warned",
        )


class ImplausibleJumpTests(LoopBase):
    """Scenario (d): a corrupt counter jump is rejected, not reconciled."""

    def test_an_implausible_jump_is_rejected_and_rebaselined(self):
        self.note(10.0, _at(14))
        self.note(400.0, _at(14, 1))
        dropped = [line for line in self.logs if "day counter step dropped" in line]
        self.assertEqual(len(dropped), 1)
        self.assertIn("390.000 kwh", dropped[0])
        value, _observed = self.counter.sample()
        self.assertEqual(value, 400.0)  # rebaselined to the reading ...
        self.assertFalse(self.counter.eval_ready)  # ... but not trusted yet

    def test_no_false_reconciliation_from_a_rejected_sample(self):
        self.seed_history(10.0)
        self.note(10.0, _at(14))
        self.now = _at(14)
        self.run_loop(1)  # clean; authority granted
        self.assertIn("warning authority granted", " ".join(self.logs))
        self.note(400.0, _at(14, 1))  # corrupt jump: rejected
        self.now = _at(14, 2)
        self.run_loop(1)  # the untrusted sample is not evaluated
        self.assertEqual(self.warnings(), [])
        self.assert_no_writes()

    def test_a_plausible_step_restores_trust(self):
        self.note(10.0, _at(14))
        self.note(400.0, _at(14, 1))
        self.note(400.4, _at(14, 11))  # 0.4 kwh in 10 min: deliverable
        self.assertTrue(self.counter.eval_ready)
        value, _observed = self.counter.sample()
        self.assertEqual(value, 400.4)


class AuthorityTests(ReconcileBase):
    """Divergences before authority are informational notes, never warnings."""

    def test_divergence_before_authority_is_one_informational_note(self):
        self.note(5.0)
        self.assertEqual(self.evaluate(archive=12.0, charger=5.0), "noted")
        (note,) = self.notes()
        self.assertIn("informational", note)
        self.assertIn("authority not yet granted", note)
        self.assertIn("no history or session data modified", note)
        self.assertEqual(self.warnings(), [])

    def test_a_note_is_not_repeated_within_the_episode(self):
        self.note(5.0)
        self.assertEqual(self.evaluate(archive=12.0, charger=5.0), "noted")
        self.assertEqual(self.evaluate(archive=12.2, charger=5.0), "held")
        self.assertEqual(len(self.notes()), 1)

    def test_authority_is_granted_once_and_survives_later_divergences(self):
        self.note(5.0)
        self.evaluate(archive=5.0, charger=5.0)
        grants = [line for line in self.logs if "authority granted" in line]
        self.assertEqual(self.evaluate(archive=9.0, charger=5.0), "warned")
        self.assertEqual(
            [line for line in self.logs if "authority granted" in line], grants
        )

    def test_the_first_ever_divergence_names_the_unknown_window_start(self):
        # No clean evaluation yet, so the outage window has no start stamp.
        self.note(5.0)
        self.assertEqual(self.evaluate(archive=9.0, charger=5.0), "noted")
        (note,) = self.notes()
        self.assertIn("no clean evaluation yet", note)


class ChargerDayCounterTests(ReconcileBase):
    """The charger-side sample stream, guarded the record_history way."""

    def test_the_first_sample_is_only_a_baseline(self):
        self.note(7.5)
        self.assertTrue(self.counter.present)
        value, observed = self.counter.sample()
        self.assertEqual(value, 7.5)
        self.assertEqual(observed, self.now)

    def test_zero_is_a_valid_counter_value(self):
        self.note(0.0)
        self.assertTrue(self.counter.present)
        value, _observed = self.counter.sample()
        self.assertEqual(value, 0.0)

    def test_a_plausible_step_is_accepted(self):
        self.note(10.0, _at(14))
        self.note(12.0, _at(15))  # 2 kWh in an hour: well inside the allowance
        value, _observed = self.counter.sample()
        self.assertEqual(value, 12.0)
        self.assertEqual([line for line in self.logs if "dropped" in line], [])

    def test_a_rollover_is_recorded_for_the_later_authority_rule(self):
        # PR-2 grants authority from a rollover within +/-1h of Pi-local
        # midnight; PR-1 records the observation stamps that rule will read.
        self.note(9.0, _at(23, 59, day=20))
        midnight = _at(0, 0, 10, day=21)
        self.note(0.01, midnight)
        self.assertEqual(self.counter.rollovers, [midnight])
        self.assertIn("day counter rollover", " ".join(self.logs))
        # The rebaselined counter stays usable for evaluations.
        self.assertTrue(self.counter.eval_ready)
        value, _observed = self.counter.sample()
        self.assertEqual(value, 0.01)


class LoopRobustnessTests(LoopBase):
    def test_a_failed_history_read_skips_the_evaluation(self):
        self.note(12.5)
        self.db.fail_reads = True
        self.run_loop(1)
        failures = [line for line in self.logs if "read failed" in line]
        self.assertEqual(len(failures), 1)
        self.assertIn("day reconciliation", failures[0])
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.db.writes, [])

    def test_yesterdays_documents_are_never_touched(self):
        self.seed_history(12.4)
        self.db.data["history"]["2026-11-19"] = {
            "kwh": 30.0,
            "hours": {"19": 30.0},
            "updated_at": "2026-11-19T23:00:00Z",
        }
        self._seeded_data = deepcopy(self.db.data)
        self.note(12.5)
        self.run_loop(1)
        self.assert_no_writes()


class ParsePeriodCounterTests(unittest.TestCase):
    """parse_status passes the period counters through for reconciliation."""

    def test_full_parse_carries_the_counters(self):
        fields = bridge.parse_status(_status_payload(total_day=12.5, total_month=220.4))
        self.assertEqual(fields["total_day"], 12.5)
        self.assertEqual(fields["total_month"], 220.4)

    def test_absent_or_unusable_counters_parse_to_none(self):
        for raw in (None, "soon", -1.0, float("inf"), float("nan"), True):
            with self.subTest(raw=raw):
                fields = bridge.parse_status(_status_payload(total_day=raw))
                self.assertIsNone(fields["total_day"])

    def test_a_pre_422_gateway_parses_to_absent_counters(self):
        fields = bridge.parse_status(_status_payload(total_day=None, total_month=None))
        self.assertIsNone(fields["total_day"])
        self.assertIsNone(fields["total_month"])

    def test_snapshots_never_carry_the_counters(self):
        parsed = bridge.parse_snapshot(_status_payload(total_day=12.5))
        self.assertNotIn("total_day", parsed)
        self.assertNotIn("total_month", parsed)

    def test_counters_never_reach_the_document(self):
        # The temp1-temp3 boundary rule: the counters are parsed for the
        # reconciliation path only, and the sink drops them before anything
        # reaches status/current -- no write of any flavour carries them.
        db = FakeDB()
        tracker = bridge.StatusTracker(db)
        tracker.seeded = True
        sink = bridge.StatusSink(
            db,
            tracker,
            _RecordingNotifier(),
            policy=bridge.WritePolicy(
                bridge.WritePolicyConfig(min_gap=0), clock=lambda: 0.0
            ),
        )
        sink.apply_status(
            bridge.parse_status(_status_payload(total_day=12.5, total_month=220.4)),
            "http",
        )
        status_writes = [write for write in db.writes if write[1] == "status"]
        self.assertTrue(status_writes)
        for write in status_writes:
            for key in ("total_day", "total_month"):
                self.assertNotIn(key, write[3])


class PendingDayAccessorTests(unittest.TestCase):
    def test_pending_for_day_sums_only_the_named_day(self):
        db = FakeDB()
        accumulator = bridge.HistoryAccumulator(db)
        db.fail_writes = True  # the rollover flush fails, so both stay pending
        with mock.patch.object(bridge, "log", lambda _message: None):
            accumulator.observe(1.5, _at(23, day=19))
            accumulator.observe(2.0, _at(0, 10, day=20))
        self.assertAlmostEqual(accumulator.pending_for_day("2026-11-19"), 1.5)
        self.assertAlmostEqual(accumulator.pending_for_day("2026-11-20"), 2.0)
        self.assertEqual(accumulator.pending_for_day("2026-11-21"), 0.0)


class StatusLoopFeedTests(unittest.TestCase):
    def test_applied_observations_feed_the_day_counter(self):
        host = _host()
        session = FakeSession([FakeResponse(200, _status_payload(total_day=7.5))] * 2)
        counter = bridge.ChargerDayCounter()
        db = FakeDB()
        tracker = bridge.StatusTracker(db)
        notifier = _RecordingNotifier()
        transport = bridge.ChargerTransport(session)
        watchdog = bridge.Watchdog(
            db, host, None, transport, notifier, bridge.WatchdogConfig()
        )
        with mock.patch.object(bridge, "_stop", _StopAfter(2)):
            bridge.status_loop(
                db,
                host,
                None,
                transport,
                10,
                tracker,
                notifier,
                watchdog,
                day_counters=counter,
            )
        value, _observed = counter.sample()
        self.assertEqual(value, 7.5)


class ReconcileEnvTests(unittest.TestCase):
    """main() parses the reconciler cadence like the other tunables."""

    def run_main(self, env=None):
        with (
            mock.patch.dict(bridge._FILE_ENV, {}, clear=True),
            mock.patch.dict(os.environ, env or {}, clear=True),
            mock.patch.object(bridge, "init_firestore", return_value=FakeDB()),
            mock.patch.object(bridge, "run") as run,
            mock.patch.object(bridge, "log"),
            mock.patch.object(bridge, "ChargerTransport"),
        ):
            bridge.main()
        return run

    def test_defaults(self):
        run = self.run_main()
        self.assertEqual(
            run.call_args.kwargs["reconcile"], bridge.ReconcileConfig(3600.0)
        )

    def test_overrides(self):
        run = self.run_main({"RECONCILE_INTERVAL": "1800"})
        self.assertEqual(
            run.call_args.kwargs["reconcile"], bridge.ReconcileConfig(1800.0)
        )

    def test_zero_disables_the_loop(self):
        run = self.run_main({"RECONCILE_INTERVAL": "0"})
        self.assertEqual(run.call_args.kwargs["reconcile"], bridge.ReconcileConfig(0.0))

    def assert_bad_tunable_exits(self, raw):
        with (
            mock.patch.dict(bridge._FILE_ENV, {}, clear=True),
            mock.patch.dict(os.environ, {"RECONCILE_INTERVAL": raw}, clear=True),
            mock.patch.object(bridge, "init_firestore", return_value=FakeDB()),
            mock.patch.object(bridge, "run"),
            mock.patch.object(bridge, "log"),
            mock.patch.object(bridge, "ChargerTransport"),
        ):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
        self.assertIn("RECONCILE_INTERVAL", str(cm.exception))

    def test_unparseable_values_exit_loudly(self):
        self.assert_bad_tunable_exits("soon")

    def test_non_finite_values_exit_loudly(self):
        for raw in ("nan", "inf"):
            with self.subTest(raw=raw):
                self.assert_bad_tunable_exits(raw)

    def test_negative_values_exit_loudly(self):
        self.assert_bad_tunable_exits("-1")

    def test_main_logs_the_startup_line(self):
        logs = []
        with (
            mock.patch.dict(bridge._FILE_ENV, {}, clear=True),
            mock.patch.dict(os.environ, {}, clear=True),
            mock.patch.object(bridge, "init_firestore", return_value=FakeDB()),
            mock.patch.object(bridge, "run"),
            mock.patch.object(bridge, "log", logs.append),
            mock.patch.object(bridge, "ChargerTransport"),
        ):
            bridge.main()
        self.assertTrue(any("day reconciliation: every 3600s" in line for line in logs))
