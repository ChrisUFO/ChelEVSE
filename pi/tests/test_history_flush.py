"""History accumulator tests (issue #94): the cadence of history/<day> writes.

No broker, charger, Firestore or FCM is touched: the accumulator runs against
the in-memory fakes with injected wall and monotonic clocks, so every flush
boundary -- hour rollover, midnight, the charging interval, session close,
shutdown -- is tested at exact simulated times.
"""

import os
import sys
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
from fakes import FakeDB  # noqa: E402
from test_mqtt import _RecordingNotifier, status_payload  # noqa: E402
from test_write_policy import _Clock  # noqa: E402


class HistoryBase(unittest.TestCase):
    """A tracker whose accumulator runs on the injected monotonic clock."""

    FLUSH = 300.0

    def setUp(self):
        self.db = FakeDB()
        self.clock = _Clock()
        self.tracker = self._build_tracker()
        self.tracker.seeded = True

    def _build_tracker(self):
        return bridge.StatusTracker(
            self.db,
            history=bridge.HistoryAccumulator(
                self.db, flush_sec=self.FLUSH, clock=self.clock
            ),
        )

    def record(self, total, when):
        """One observation at an exact wall-clock instant (the local clock)."""
        with mock.patch.object(bridge, "_localnow", return_value=when):
            self.tracker.record_history(total)

    def history_writes(self):
        return [write for write in self.db.writes if write[1] == "history"]


class AttributionTests(HistoryBase):
    """Deltas land in the hour they were observed in, not the flush hour."""

    def test_multi_hour_accumulation_flushes_each_observed_bucket(self):
        start = datetime(2026, 10, 21, 20, 50, tzinfo=UTC)
        self.record(100.0, start)
        # Energy creeps through three local hours. No flush point fires
        # until each rollover, so each flush writes the buckets it holds.
        self.record(101.0, start + timedelta(minutes=11))  # 21:01 -> hours 21
        self.record(103.5, start + timedelta(minutes=12))  # 21:02
        self.record(104.5, start + timedelta(minutes=70))  # 22:00 -> rollover
        # One write spans both buckets: kwh plus every touched hours.<HH>.
        (first,) = self.history_writes()
        self.assertEqual(first[2], "2026-10-21")
        self.assertEqual(
            first[4], ["kwh", "hours.`21`", "hours.`22`", "updated_at"]
        )
        self.assertEqual(first[3]["hours"]["21"]._value, 3.5)
        self.assertEqual(first[3]["hours"]["22"]._value, 1.0)
        self.assertEqual(first[3]["kwh"]._value, 4.5)
        # The flush hour (22:00) did not steal the 21:xx energy.
        self.assertEqual(self.db.data["history"]["2026-10-21"]["hours"]["21"], 3.5)
        # More energy in 22, then the 23:00 rollover flushes again.
        self.record(106.0, start + timedelta(minutes=71))
        self.record(
            107.5, start + timedelta(minutes=130)
        )  # 23:00 -> rollover
        (first, second) = self.history_writes()
        self.assertEqual(
            second[4], ["kwh", "hours.`22`", "hours.`23`", "updated_at"]
        )
        doc = self.db.data["history"]["2026-10-21"]
        self.assertAlmostEqual(doc["kwh"], 7.5)
        self.assertAlmostEqual(doc["hours"]["21"], 3.5)
        self.assertAlmostEqual(doc["hours"]["22"], 2.5)
        self.assertAlmostEqual(doc["hours"]["23"], 1.5)

    def test_a_flush_spanning_midnight_is_one_write_per_day_document(self):
        start = datetime(2026, 10, 21, 23, 58, tzinfo=UTC)
        self.record(100.0, start)
        self.record(103.0, start + timedelta(seconds=110))  # 23:59:50, hour 23
        self.record(105.0, start + timedelta(seconds=130))  # 00:00:10, hour 00
        # The midnight rollover flushed both days at once: one write per day
        # document, each carrying only its own day's deltas.
        self.assertEqual(
            [(write[2], write[4]) for write in self.history_writes()],
            [
                ("2026-10-21", ["kwh", "hours.`23`", "updated_at"]),
                ("2026-10-22", ["kwh", "hours.`00`", "updated_at"]),
            ],
        )
        first = self.db.data["history"]["2026-10-21"]
        self.assertAlmostEqual(first["kwh"], 3.0)
        self.assertAlmostEqual(first["hours"]["23"], 3.0)
        second = self.db.data["history"]["2026-10-22"]
        self.assertAlmostEqual(second["kwh"], 2.0)
        self.assertAlmostEqual(second["hours"]["00"], 2.0)

    def test_a_session_spanning_midnight_attributes_to_both_days(self):
        # The session-close and midnight cases compose: energy observed
        # before midnight stays in the old day even though the session (and
        # its close flush) land in the new one.
        start = datetime(2026, 10, 21, 23, 30, tzinfo=UTC)
        self.record(100.0, start)
        self.record(104.0, start + timedelta(minutes=29))  # 23:59, hour 23
        self.record(106.0, start + timedelta(minutes=31))  # 00:01 -> rollover
        self.record(107.0, start + timedelta(minutes=45))  # 00:15, still hour 00
        self.tracker.history.flush("session close")
        self.assertEqual(sorted(self.db.data["history"]), ["2026-10-21", "2026-10-22"])
        self.assertAlmostEqual(self.db.data["history"]["2026-10-21"]["kwh"], 4.0)
        self.assertAlmostEqual(self.db.data["history"]["2026-10-21"]["hours"]["23"], 4.0)
        self.assertAlmostEqual(self.db.data["history"]["2026-10-22"]["kwh"], 3.0)
        self.assertAlmostEqual(self.db.data["history"]["2026-10-22"]["hours"]["00"], 3.0)


class FailureRetentionTests(HistoryBase):
    """A failed flush keeps the accumulator; the retry never drops energy."""

    def test_a_failed_flush_is_retained_and_the_retry_lands_both_deltas(self):
        start = datetime(2026, 10, 21, 21, 0, tzinfo=UTC)
        self.record(100.0, start)
        self.tracker.state = 3  # the interval trigger is charging-gated
        self.db.fail_writes = True
        self.record(110.0, start + timedelta(minutes=10))  # +10, hour 21
        self.clock.advance(self.FLUSH)
        self.tracker.consider_history_flush()  # the interval flush fails
        self.assertEqual(self.tracker.history.pending_kwh, 10.0)
        self.record(115.0, start + timedelta(minutes=65))  # 22:05 -> rollover fails
        self.assertEqual(self.tracker.history.pending_kwh, 15.0)
        self.assertNotIn("history", self.db.data)
        self.db.fail_writes = False
        self.clock.advance(self.FLUSH)
        self.tracker.consider_history_flush()  # the retry lands everything
        (write,) = self.history_writes()
        self.assertEqual(
            write[4], ["kwh", "hours.`21`", "hours.`22`", "updated_at"]
        )
        self.assertEqual(write[3]["hours"]["21"]._value, 10.0)
        self.assertEqual(write[3]["hours"]["22"]._value, 5.0)
        self.assertEqual(self.tracker.history.pending_kwh, 0.0)
        doc = self.db.data["history"]["2026-10-21"]
        self.assertAlmostEqual(doc["kwh"], 15.0)
        self.assertAlmostEqual(doc["hours"]["21"], 10.0)
        self.assertAlmostEqual(doc["hours"]["22"], 5.0)

    def test_a_partial_midnight_failure_keeps_only_the_failed_day(self):
        start = datetime(2026, 10, 21, 23, 59, tzinfo=UTC)
        self.record(100.0, start)
        self.record(102.0, start + timedelta(seconds=30))  # 23:59:30, hour 23
        # Only the second day's document write fails.
        real_collection = self.db.collection

        def failing_second_day(name):
            collection = real_collection(name)

            if name != "history":
                return collection
            document = collection.document

            def maybe_failing(doc_id):
                reference = document(doc_id)
                if doc_id == "2026-10-22":
                    set_ = reference.set

                    def set_raising(_data, merge=False):
                        raise RuntimeError("write failed")

                    reference.set = set_raising
                    return reference
                return reference

            collection.document = maybe_failing
            return collection

        self.db.collection = failing_second_day
        self.record(104.0, start + timedelta(seconds=70))  # 00:00:10 -> rollover
        # Day one landed and was cleared; day two is still pending.
        self.assertEqual(list(self.db.data["history"]), ["2026-10-21"])
        self.assertAlmostEqual(self.db.data["history"]["2026-10-21"]["kwh"], 2.0)
        self.assertEqual(
            self.tracker.history.pending_hours, {("2026-10-22", "00"): 2.0}
        )
        self.assertEqual(self.tracker.history.pending_kwh, 2.0)
        self.db.collection = real_collection
        self.assertTrue(self.tracker.history.flush("shutdown"))
        self.assertAlmostEqual(self.db.data["history"]["2026-10-22"]["kwh"], 2.0)
        self.assertAlmostEqual(self.db.data["history"]["2026-10-21"]["kwh"], 2.0)


class SessionCloseTests(HistoryBase):
    """The 3 -> not-3 edge is a flush point, exactly once per close."""

    def observe(self, state, **fields):
        payload = {"vehicle": 1, "session_energy": 0, "elapsed": 0}
        payload.update(fields)
        when = datetime(2026, 10, 21, 22, 0, tzinfo=UTC)
        with mock.patch.object(bridge, "_utcnow", return_value=when):
            self.tracker.observe({"state": state, **payload})

    def test_a_session_close_flushes_exactly_once(self):
        start = datetime(2026, 10, 21, 21, 0, tzinfo=UTC)
        self.tracker.has_state = True
        self.tracker.state = 3
        self.tracker.previous_state = 3
        self.record(100.0, start)
        self.record(110.0, start + timedelta(minutes=30))  # pending 10
        self.observe(1)
        (write,) = self.history_writes()
        self.assertEqual(write[2], "2026-10-21")
        self.assertAlmostEqual(self.db.data["history"]["2026-10-21"]["kwh"], 10.0)
        # Later ticks have no edge left and add no writes.
        self.observe(1)
        self.observe(1)
        self.assertEqual(len(self.history_writes()), 1)

    def test_a_close_with_nothing_pending_writes_nothing(self):
        self.tracker.has_state = True
        self.tracker.state = 3
        self.tracker.previous_state = 3
        self.observe(1)
        self.assertEqual(self.history_writes(), [])


class BudgetSimulationTests(HistoryBase):
    """The write budget: <= 12/hour charging, 0 idle, +1 per boundary (issue #94)."""

    def test_two_charging_hours_then_an_idle_hour(self):
        start = datetime(2026, 10, 21, 20, 0, tzinfo=UTC)
        total = 100.0
        self.record(total, start)  # the baseline
        cumulative = []
        # One observation per 10 s (the HTTP poll cadence), 2 h charging at
        # 3.6 kW (10 Wh per tick), then 1 h idle.
        for second in range(10, 3 * 3600, 10):
            charging = second < 2 * 3600
            if charging:
                total += 10.0 / 3600.0
                self.record(total, start + timedelta(seconds=second))
            self.clock.advance(10)
            self.tracker.state = 3 if charging else 1
            self.tracker.consider_history_flush()
            cumulative.append(len(self.history_writes()))
        first_hour = cumulative[358]  # writes through 20:59:50 (t=3590)
        second_hour = cumulative[718]  # through 21:59:50 (t=7190)
        idle_hour = cumulative[-1]  # through 22:59:50
        # Charging hours: 11 interval flushes in hour one, 11 plus the one
        # rollover write in hour two -- both inside the 12/hour bound.
        self.assertEqual(first_hour, 11)
        self.assertEqual(second_hour - first_hour, 12)
        self.assertLessEqual(first_hour, 12)
        self.assertLessEqual(second_hour - first_hour, 13)
        # The idle hour wrote nothing at all, and the tail of the charge
        # (after 21:55's flush) is still pending for shutdown.
        self.assertEqual(idle_hour, second_hour)
        self.assertEqual(len(self.history_writes()), 23)
        self.assertGreater(self.tracker.history.pending_kwh, 0.0)
        # The shutdown drain is the one remaining write.
        self.assertTrue(self.tracker.history.flush("shutdown"))
        self.assertEqual(len(self.history_writes()), 24)
        doc = self.db.data["history"]["2026-10-21"]
        self.assertAlmostEqual(doc["kwh"], total - 100.0)
        self.assertEqual(sorted(doc["hours"]), ["20", "21"])
        self.assertAlmostEqual(doc["kwh"], doc["hours"]["20"] + doc["hours"]["21"])


class SinkIntervalTests(unittest.TestCase):
    """The apply path and the scheduler tick both resolve the interval."""

    def setUp(self):
        self.db = FakeDB()
        self.notifier = _RecordingNotifier()
        self.clock = _Clock()
        self.tracker = bridge.StatusTracker(
            self.db,
            history=bridge.HistoryAccumulator(
                self.db, flush_sec=300.0, clock=self.clock
            ),
        )
        self.tracker.seeded = True
        self.sink = bridge.StatusSink(self.db, self.tracker, self.notifier)

    def apply(self, when, **overrides):
        with mock.patch.object(bridge, "_localnow", return_value=when):
            fields = bridge.parse_status(status_payload(**overrides))
            self.sink.apply_status(fields, "http")

    def history_writes(self):
        return [write for write in self.db.writes if write[1] == "history"]

    def test_charging_applies_flush_on_the_interval(self):
        start = datetime(2026, 10, 21, 21, 0, tzinfo=UTC)
        self.apply(start, total_energy=100)
        self.apply(start, state=3, session_energy=0, elapsed=0, total_energy=100)
        # The interval is measured from the first pending delta, not from
        # the charging start: energy that just arrived is not due yet.
        self.clock.advance(290)
        self.apply(start + timedelta(seconds=290), state=3, total_energy=105)
        self.assertEqual(self.history_writes(), [])
        self.clock.advance(290)
        self.apply(start + timedelta(seconds=580), state=3, total_energy=108)
        self.assertEqual(self.history_writes(), [])  # 290 s of pending: not due
        self.clock.advance(10)
        self.apply(start + timedelta(seconds=590), state=3, total_energy=110)
        (write,) = self.history_writes()
        self.assertEqual(write[2], "2026-10-21")
        self.assertEqual(write[4], ["kwh", "hours.`21`", "updated_at"])
        self.assertEqual(write[3]["kwh"]._value, 10.0)

    def test_the_scheduler_tick_flushes_without_a_new_apply(self):
        # A charger gone silent mid-charge: the pending energy still flushes
        # on schedule, from the status loop's tick.
        start = datetime(2026, 10, 21, 21, 0, tzinfo=UTC)
        self.apply(start, state=3, session_energy=100, elapsed=600, total_energy=100)
        self.apply(start, state=3, session_energy=200, elapsed=700, total_energy=105)
        self.assertEqual(self.tracker.history.pending_kwh, 5.0)
        self.clock.advance(300)
        self.sink.consider_history_flush()
        (write,) = self.history_writes()
        self.assertEqual(write[3]["kwh"]._value, 5.0)

    def test_idle_energy_waits_for_a_non_interval_flush_point(self):
        # Standby creep while idle never triggers the interval (0 idle
        # writes); the energy rides until a rollover, close or shutdown.
        start = datetime(2026, 10, 21, 21, 0, tzinfo=UTC)
        self.apply(start, total_energy=100)
        self.clock.advance(600)
        self.apply(start + timedelta(seconds=600), total_energy=100.01)
        self.assertEqual(self.history_writes(), [])
        self.assertAlmostEqual(self.tracker.history.pending_kwh, 0.01)
        self.assertTrue(self.tracker.history.flush("shutdown"))
        (write,) = self.history_writes()
        self.assertAlmostEqual(write[3]["kwh"]._value, 0.01)

    def test_a_session_close_through_the_sink_flushes_once(self):
        start = datetime(2026, 10, 21, 21, 0, tzinfo=UTC)
        self.apply(start, total_energy=100)
        self.apply(start, state=3, session_energy=0, elapsed=0, total_energy=100)
        self.apply(
            start + timedelta(minutes=30),
            state=3,
            session_energy=500,
            total_energy=105,
        )
        self.assertEqual(self.history_writes(), [])  # pending, no flush point yet
        self.apply(
            start + timedelta(minutes=31),
            state=1,
            session_energy=500,
            total_energy=105,
        )
        (write,) = self.history_writes()
        self.assertEqual(write[3]["kwh"]._value, 5.0)
        self.apply(start + timedelta(minutes=32), state=1, total_energy=105)
        self.assertEqual(len(self.history_writes()), 1)


class ShutdownDrainTests(unittest.TestCase):
    """run() drains the accumulator once the loops stop (the SIGTERM path)."""

    def test_stop_drains_pending_history_before_exit(self):
        db = FakeDB()

        def stopped_charging(_db, _host, _auth, _transport, _interval, _source, sink):
            # The sink the loops share: one baseline observation, then a
            # charging burst, then the stop event (SIGTERM/SIGINT) ends the
            # command loop with the energy still pending.
            sink.apply_status(
                bridge.parse_status(status_payload(state=3, total_energy=100)),
                "http",
            )
            sink.apply_status(
                bridge.parse_status(status_payload(state=3, total_energy=108)),
                "http",
            )

        with mock.patch.object(bridge, "status_loop"), mock.patch.object(
            bridge, "config_loop"
        ), mock.patch.object(bridge, "settings_loop"), mock.patch.object(
            bridge, "schedule_loop"
        ), mock.patch.object(
            bridge, "command_loop", side_effect=stopped_charging
        ):
            bridge.run(
                db,
                bridge.ChargerHost("charger"),
                None,
                (10, 60, 60, 300, 5, 60),
                object(),  # every consumer is mocked
                bridge.WatchdogConfig(enabled=False),
            )
        history = db.data.get("history", {})
        (day,) = history
        self.assertAlmostEqual(history[day]["kwh"], 8.0)
        (hour,) = history[day]["hours"]
        self.assertAlmostEqual(history[day]["hours"][hour], 8.0)


class HistoryEnvTests(unittest.TestCase):
    """main() parses the new tunable like the other intervals."""

    def run_main(self, env=None):
        with mock.patch.dict(bridge._FILE_ENV, {}, clear=True), mock.patch.dict(
            os.environ, env or {}, clear=True
        ), mock.patch.object(
            bridge, "init_firestore", return_value=FakeDB()
        ), mock.patch.object(
            bridge, "run"
        ) as run, mock.patch.object(
            bridge, "log"
        ), mock.patch.object(
            bridge, "ChargerTransport"
        ):
            bridge.main()
        return run

    def test_defaults(self):
        run = self.run_main()
        self.assertEqual(run.call_args.kwargs["history"], bridge.HistoryConfig(300.0))

    def test_overrides(self):
        run = self.run_main({"HISTORY_FLUSH_SEC": "120"})
        self.assertEqual(run.call_args.kwargs["history"], bridge.HistoryConfig(120.0))

    def assert_bad_tunable_exits(self, name, raw):
        """main() must stop on a bad tunable, and only on that.

        init_firestore is patched (a missing service-account key exits just
        as loudly), so the tunable validation at the top of main() is the
        only exit source exercised, and the message must name the offending
        tunable.
        """
        with mock.patch.dict(bridge._FILE_ENV, {}, clear=True), mock.patch.dict(
            os.environ, {name: raw}, clear=True
        ), mock.patch.object(
            bridge, "init_firestore", return_value=FakeDB()
        ), mock.patch.object(
            bridge, "run"
        ), mock.patch.object(
            bridge, "log"
        ), mock.patch.object(
            bridge, "ChargerTransport"
        ):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
        self.assertIn(name, str(cm.exception))

    def test_unparseable_values_exit_loudly(self):
        self.assert_bad_tunable_exits("HISTORY_FLUSH_SEC", "soon")

    def test_non_finite_values_exit_loudly(self):
        for raw in ("nan", "inf"):
            with self.subTest(raw=raw):
                self.assert_bad_tunable_exits("HISTORY_FLUSH_SEC", raw)

    def test_non_positive_values_exit_loudly(self):
        for raw in ("-1", "0"):
            with self.subTest(raw=raw):
                self.assert_bad_tunable_exits("HISTORY_FLUSH_SEC", raw)


if __name__ == "__main__":
    unittest.main()
