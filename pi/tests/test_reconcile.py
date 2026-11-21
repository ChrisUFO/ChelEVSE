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
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
import reconcile  # noqa: E402
from fakes import (  # noqa: E402
    FakeDB,
    FakeResponse,
    FakeSession,
    _StopAfter,
    _host,
    _status_payload,
)
from test_mqtt import _RecordingNotifier  # noqa: E402


def _at(hour, minute=0, second=0, day=20, month=11):
    """One exact instant on the scenario day (2026-11-20 by default)."""
    return datetime(2026, month, day, hour, minute, second, tzinfo=UTC)


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

    def note(self, value, when=None, counter=None):
        """One charger observation at an exact wall-clock instant.

        ``counter`` defaults to the day stream; the month tests point it at
        their month stream -- both read the same shared boot clock, so the
        helper keeps one monotone view across every stream.
        """
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
            (counter or self.counter).note(value)

    def authorize(self, previous=9.0, at=None):
        """Observe one midnight rollover (23:59 -> 00:05) and feed it.

        PR-2's authority rule (#161): warnings need a ``total_day`` reset
        observed within 1 h of Pi-local midnight, so every scenario that
        expects a warning opens by earning its authority the way the real
        bridge would.
        """
        at = at or _at(0, 5, day=20)
        self.note(previous, _at(23, 59, day=19))
        self.note(0.0, at)
        self.reconciler.consider_evidence(
            self.counter.rollovers, self.counter.non_resets
        )
        return at

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
        # The month half (#161 PR-2): None keeps the PR-1 day-only scenarios
        # exactly as they were; the month classes install real ones.
        self.month_counter = None
        self.month_reconciler = None

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

    def run_loop(self, ticks, on_wait=None, sample_max_age=None):
        """Run the loop for ``ticks`` evaluations, optionally at a
        non-default freshness window (run() derives it from the live feed
        cadence; the module default matches the shipped MQTT one)."""
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
                sample_max_age=(
                    sample_max_age
                    if sample_max_age is not None
                    else bridge.RECONCILE_SAMPLE_MAX_AGE_SEC
                ),
                month_counter=self.month_counter,
                month_reconciler=self.month_reconciler,
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
        # PR-2 (#161): a clean evaluation no longer grants warning
        # authority -- only an observed midnight rollover does.
        self.assertFalse(self.reconciler.authorized)
        self.assert_no_writes()

    def test_within_one_percent_is_clean(self):
        self.note(100.0)
        self.assertEqual(self.evaluate(archive=100.0, charger=100.9), "clean")
        self.assertEqual(self.warnings(), [])

    def test_the_floor_governs_small_days(self):
        # max(0.2 kwh, 1% of the larger side): small totals use the floor.
        self.authorize()
        self.note(0.1)
        self.assertEqual(self.evaluate(archive=0.1, charger=0.28), "clean")
        self.assertEqual(self.evaluate(archive=0.1, charger=0.32), "warned")

    def test_one_percent_governs_large_days(self):
        self.authorize()
        self.note(100.0)
        self.assertEqual(self.evaluate(archive=100.0, charger=100.9), "clean")
        self.assertEqual(self.evaluate(archive=100.0, charger=102.0), "warned")

    def test_a_missing_archive_document_is_a_zero_day(self):
        # No history doc yet (early morning): archive 0 vs counter 0 is clean.
        self.note(0.0)
        self.assertEqual(self.evaluate(archive=0.0, charger=0.0), "clean")
        self.assert_no_writes()


class ObservationSkewTests(LoopBase):
    """MQTT mode: the charger side advances at the HTTP reconcile cadence
    (60 s) while the bridge side advances from every applied snapshot, so an
    evaluation between HTTP reconciles compares a sample up to one interval
    old against a seconds-fresh total. The energy delivered in that window
    is on the bridge side only -- observation skew, not energy lost -- and
    the tolerance floor covers it: the window is clamped to the floor's
    coverage at the charger's 48 A ceiling (~59 s on the UK band top)."""

    def test_an_aged_same_day_sample_tolerates_the_feed_gap(self):
        # Midnight earned warning authority (the rollover rule, PR-2); the
        # 13:59 evaluation is clean. 14:00: the
        # hourly HTTP reconcile applied a 5.0 sample; the MQTT snapshots
        # kept the bridge side moving. At 14:00:59 the sample is 59 s old
        # and the bridge total holds ~0.181 kwh (11 kW x 59 s at the 48 A
        # ceiling) the charger has not reported yet: the one-interval
        # window still admits the age and the 0.2 floor absorbs the skew
        # -- with a 0.05 floor this exact interleaving warned "bridge
        # high" about energy nobody lost.
        self.authorize()
        self.seed_history(5.0)
        self.note(5.0, _at(13, 59))
        self.now = _at(13, 59)
        self.run_loop(1)
        self.assertIn("warning authority granted", " ".join(self.logs))
        self.note(5.0, _at(14, 0))
        self.seed_pending(0.181, _at(14, 0, 59))
        self.now = _at(14, 0, 59)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assert_no_writes()

    def test_a_real_divergence_beyond_the_skew_cover_still_warns(self):
        # The floor is a cover for the feed gap, not a blind eye: once the
        # gap exceeds what the cadence can explain -- even inside the
        # freshness window, at a power no charger could deliver in the
        # sample's age -- it is a divergence.
        self.authorize()
        self.seed_history(5.0)
        self.note(5.0, _at(13, 59))
        self.now = _at(13, 59)
        self.run_loop(1)
        self.assertIn("warning authority granted", " ".join(self.logs))
        self.note(5.0, _at(14, 0))
        self.seed_pending(0.35, _at(14, 0, 59))
        self.now = _at(14, 0, 59)
        self.run_loop(1)
        (warning,) = self.warnings()
        self.assertIn("0.350 kwh", warning)
        self.assert_no_writes()


class SampleFreshnessTests(LoopBase):
    """A same-day sample can still be too old to compare (#161): the feed
    skips an HTTP reconcile on a failed poll or an ``mqtt_mark`` discard
    while the bridge side keeps advancing from every applied snapshot, so
    the skew grows with the sample's age. Past the freshness window (one
    feed interval, clamped to the tolerance floor's coverage at the
    charger's ceiling -- ~59 s at the default cadence) the evaluation
    waits for a fresh sample instead of warning about energy nobody
    lost."""

    def test_a_same_day_sample_past_the_freshness_window_is_not_compared(self):
        # The false-warning reproduction at the power that exposes the
        # band: authority is earned at midnight (the rollover rule, PR-2),
        # the 14:00:00 HTTP
        # reconcile then fails (a failed poll advances the next deadline
        # and never notes), the charger delivers ~11 kW via MQTT
        # snapshots, and the tick at 14:00:45 sees a 105 s-old sample
        # with 0.322 kwh (11 kW x 105 s at the 48 A ceiling) of skew on
        # the bridge side only -- past the 0.2 floor. A window two
        # intervals wide admitted exactly this age and warned "bridge
        # high" about energy nobody lost; the one-interval window
        # suppresses the evaluation instead.
        self.authorize()
        self.seed_history(5.0)
        self.note(5.0, _at(13, 59))
        self.now = _at(13, 59)
        self.run_loop(1)
        self.assertIn("warning authority granted", " ".join(self.logs))
        self.seed_pending(0.322, _at(14, 0, 45))
        self.now = _at(14, 0, 45)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assert_no_writes()

        # The next applied reconcile catches the counter up: comparison
        # resumes and the day is clean -- the guard held the evaluation,
        # not the episode, hostage.
        self.note(5.322, _at(14, 1))
        self.now = _at(14, 1)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assert_no_writes()

    def test_a_sample_at_the_window_edge_is_still_compared(self):
        # 59 s old at the default cadence -- just inside the window, which
        # the clamp holds at the tolerance floor's coverage (~59.3 s = the
        # 0.2 floor at 48 A x 253 V, the UK band top): the evaluation
        # runs -- proven by the last-clean stamp a clean evaluation leaves
        # -- and the ceiling-power
        # skew of that age (12.1 kW x 59 s ~ 0.199 kwh) sits inside the
        # floor: the window and the floor meet at exactly this age, even
        # at the top of the supply band.
        self.authorize()
        self.seed_history(5.0)
        self.note(5.0, _at(14, 0))
        self.seed_pending(0.199, _at(14, 0, 59))
        self.now = _at(14, 0, 59)
        self.run_loop(1)
        self.assertEqual(self.reconciler._last_clean, _at(14, 0, 59))
        self.assertEqual(self.warnings(), [])
        self.assert_no_writes()

    def test_a_slow_feed_cadence_does_not_widen_the_window(self):
        # The round-4 reproduction: MQTT_RECONCILE_SEC=120 is a
        # documented, legal setting, and an unclamped window of one feed
        # interval (120 s) admitted this exact interleaving -- a sample
        # 100 s old beside 0.305 kwh (11 kW x 100 s at the 48 A ceiling)
        # of bridge-only energy -- and warned "bridge high" about
        # observation skew on a day nobody lost energy. run() clamps the
        # window to the tolerance floor's coverage at ceiling power, so
        # the raised cadence suppresses the evaluation instead.
        self.authorize()
        self.seed_history(5.0)
        self.note(5.0, _at(13, 59))
        self.now = _at(13, 59)
        self.run_loop(1)
        self.assertIn("warning authority granted", " ".join(self.logs))
        self.note(5.0, _at(14, 0))
        self.seed_pending(0.305, _at(14, 1, 40))
        self.now = _at(14, 1, 40)
        self.run_loop(1, sample_max_age=bridge.covered_window_sec(120.0))
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assert_no_writes()

        # The next applied reconcile catches the counter up: comparison
        # resumes and the day is clean -- the clamp held the evaluation,
        # not the episode, hostage.
        self.note(5.305, _at(14, 2))
        self.now = _at(14, 2)
        self.run_loop(1, sample_max_age=bridge.covered_window_sec(120.0))
        self.assertEqual(self.warnings(), [])
        self.assert_no_writes()


class FreshnessWindowInvariantTests(unittest.TestCase):
    """The floor<->window relationship holds by construction (#161, round
    4): whatever the feed cadence, the window reconcile hands the loop
    never admits more ceiling-power skew than the tolerance floor covers.
    Before round 4 this invariant lived in comments only, and any
    configured cadence above ~62 s re-opened the false "bridge high"
    warning rounds 2-3 had closed."""

    CADENCES_SEC = (0.5, 1, 5, 10, 30, 59, 60, 62.5, 90, 120, 300, 3600, 86400)

    def test_the_covered_window_never_admits_more_than_the_floor_covers(self):
        # ceiling power x window <= TOLERANCE_KWH for every cadence:
        # below the clamp the window is the cadence itself, above it the
        # floor's coverage bound, so the sweep cannot fall out from
        # between the two.
        for cadence in self.CADENCES_SEC:
            window = reconcile.covered_window_sec(cadence)
            self.assertLessEqual(window, cadence)
            self.assertLessEqual(
                reconcile.CEILING_POWER_KW * window / 3600.0,
                reconcile.TOLERANCE_KWH + 1e-9,
                f"cadence {cadence:g}s admits skew past the floor",
            )

    def test_the_ceiling_is_the_supply_band_top(self):
        # 48 A at 253 V (the UK 230 V +10% band top), not the ~240 V
        # nominal: the band top is the most power the charger can
        # deliver, and the 240 V figure left only 8 Wh of headroom at
        # the old 60 s window edge -- thin enough for the GET->note
        # stamp latency to cross at full current.
        self.assertEqual(reconcile.SUPPLY_BAND_MAX_V, 253.0)
        self.assertAlmostEqual(reconcile.CEILING_POWER_KW, 48 * 253 / 1000.0)
        self.assertAlmostEqual(
            reconcile.MAX_COVERED_AGE_SEC, 3600.0 * 0.2 / 12.144, places=6
        )
        # And the default cadence is already at the clamp's edge: the
        # shipped 60 s feed buys a 59.3 s window, not a 60 s one.
        self.assertEqual(
            bridge.RECONCILE_SAMPLE_MAX_AGE_SEC,
            reconcile.covered_window_sec(60.0),
        )
        self.assertLess(bridge.RECONCILE_SAMPLE_MAX_AGE_SEC, 60.0)


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
        # The counter appears (firmware upgraded, say) and the totals
        # diverge: the comparison runs again, as an informational note --
        # PR-2 (#161): without an observed midnight rollover it can never
        # be more than that.
        self.seed_history(12.0)
        self.note(5.0, _at(10))
        self.now = _at(10)
        self.run_loop(1)
        (note,) = self.notes()
        self.assertIn("informational", note)
        self.assertEqual(self.warnings(), [])
        self.assertFalse(self.reconciler.authorized)


class MidDayRestartTests(LoopBase):
    """Scenario (c): the day counter resets mid-day, recovers, and the day's
    figures disagree -- exactly one warning with every field, then silence."""

    def test_exactly_one_warning_with_all_fields(self):
        # Authority first: the counter's real midnight rollover (23:59 ->
        # 00:05) unlocks warnings under the PR-2 rule. Morning: the archive
        # and the charger's day counter grow in lockstep; the 13:58
        # evaluation is clean.
        self.authorize()
        self.seed_history(9.0, hours={"09": 4.0, "10": 3.0, "11": 2.0})
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
        self.authorize()
        self.note(5.0)
        self.evaluate(archive=5.0, charger=5.0)  # clean
        self.assertEqual(self.evaluate(archive=7.0, charger=5.0), "warned")
        self.assertEqual(self.evaluate(archive=7.4, charger=5.0), "held")
        self.assertEqual(self.evaluate(archive=8.05, charger=5.0), "warned")
        self.assertEqual(len(self.warnings()), 2)

    def test_a_direction_change_rearms_the_warning(self):
        self.authorize()
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
        self.authorize()
        self.note(5.0)
        self.evaluate(archive=5.0, charger=5.0)
        self.assertEqual(self.evaluate(archive=7.0, charger=5.0), "warned")
        self.assertEqual(self.evaluate(archive=7.1, charger=7.1), "clean")
        # A fresh divergence is a new episode and warns again.
        self.assertEqual(self.evaluate(archive=9.0, charger=7.1), "warned")
        self.assertEqual(len(self.warnings()), 2)

    def test_a_new_day_starts_a_new_episode(self):
        self.authorize()
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
        self.authorize()
        self.seed_history(10.0)
        self.note(10.0, _at(14))
        self.now = _at(14)
        self.run_loop(1)  # clean
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


class MidnightOutageTests(LoopBase):
    """The charger unreachable across local midnight while the bridge keeps
    running: the last accepted sample (yesterday's ``total_day``) never
    expires, so the first new-day tick must not compare it against the new
    day's fresh totals; recovery resumes normal reconciliation."""

    def test_a_stale_pre_midnight_sample_is_not_compared_against_the_new_day(self):
        # Day 20 ends healthy: authority was earned at the midnight
        # rollover into day 20, the 23:10 sample reconciles clean against
        # the archive (the tick lands 59 s after the note, inside the
        # clamped window), then the charger goes unreachable.
        self.authorize()
        self.seed_history(11.0)
        self.note(11.0, _at(23, 10, day=20))
        self.now = _at(23, 10, 59, day=20)
        self.run_loop(1)
        self.assertIn("warning authority granted", " ".join(self.logs))

        # Day 21, 00:10: no history document yet, nothing pending -- without
        # the same-day guard the stale 11 kwh sample would warn a whole
        # yesterday-sized "bridge low" divergence against zeroes.
        self.now = _at(0, 10, day=21)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assert_no_writes()

        # The outage continues: hourly ticks keep holding, not re-warning.
        self.now = _at(1, 10, day=21)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assert_no_writes()

    def test_recovery_resumes_normal_reconciliation(self):
        self.authorize()
        self.seed_history(11.0)
        self.note(11.0, _at(23, 10, day=20))
        self.now = _at(23, 10, 59, day=20)
        self.run_loop(1)
        self.assertIn("warning authority granted", " ".join(self.logs))
        self.now = _at(0, 10, day=21)
        self.run_loop(1)  # stale sample: skipped
        self.assertEqual(self.warnings(), [])

        # 09:00: the charger is back. Its counter reset at its own midnight
        # (a recorded rollover) and reports 0.3 kwh delivered overnight --
        # energy the bridge never observed while the charger was dark, so
        # the new day genuinely diverges and the (same-day) sample must be
        # evaluated and warned about normally: the guard suppressed the
        # stale sample, not the loop.
        back = _at(9, day=21)
        self.note(0.3, back)
        self.assertIn("day counter rollover", " ".join(self.logs))
        self.now = back
        self.run_loop(1)
        (warning,) = self.warnings()
        self.assertIn("day 2026-11-21", warning)
        self.assertIn("bridge low", warning)
        self.assertIn("0.300 kwh", warning)
        self.assert_no_writes()


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
        # The grant comes from the observed rollover (authorize), and only
        # from it: later evaluations neither add nor repeat the grant.
        self.authorize()
        grants = [line for line in self.logs if "authority granted" in line]
        self.assertEqual(len(grants), 1)
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

    def test_a_rollover_from_a_rejected_baseline_is_not_stamped(self):
        # A corrupt jump poisons the level; a later drop measured FROM that
        # untrusted number is not evidence of when midnight fell, so PR-2's
        # authority rule must not read it. The drop's fresh reading is still
        # the counter's own truth, so the counter rebaselines evaluation-ready
        # rather than suppressing the next hourly evaluation.
        self.note(10.0, _at(23, 5, day=20))
        self.note(400.0, _at(23, 6, day=20))  # corrupt jump: rejected
        midnight = _at(0, 0, 10, day=21)
        self.note(0.01, midnight)
        self.assertEqual(self.counter.rollovers, [])
        self.assertTrue(self.counter.eval_ready)
        value, _observed = self.counter.sample()
        self.assertEqual(value, 0.01)


class CounterThreadSafetyTests(ReconcileBase):
    """One counter, two threads: the status loop notes while the reconcile
    loop samples (the run() wiring shares one instance across both). The
    pair a reader gets must carry one note's value with the same note's
    stamp -- separate attributes tore across threads, and a torn pair
    (yesterday's value, today's stamp) walks straight past the loop's
    same-day guard and can fabricate an authorized warning.

    The rejected-ordering half (a just-rejected reading still read as
    eval-ready) cannot be reproduced from outside single bytecodes; it is
    closed structurally, by carrying eval_ready inside the one atomically
    replaced state tuple.
    """

    def test_concurrent_notes_never_tear_the_sampled_pair(self):
        import threading

        count = 2000
        base = _at(9)
        noted = {}  # note index -> the exact value that note stored
        lock = threading.Lock()
        violations = []
        seen = []

        def instant(i):
            return base + timedelta(seconds=i)

        notes = iter(range(count))
        boots = iter(range(10_000, 10_000 + count))
        with (
            mock.patch.object(
                bridge, "_localnow", side_effect=lambda: instant(next(notes))
            ),
            mock.patch.object(
                bridge.time,
                "clock_gettime",
                side_effect=lambda *_clock: float(next(boots)),
                create=True,
            ),
            mock.patch.object(
                bridge.time, "monotonic", side_effect=lambda: float(next(boots))
            ),
        ):
            # Both iterators feed note()'s clock reads only (the writer is
            # the sole caller), so note i observes instant(i) exactly.

            def writer():
                for i in range(count):
                    value = 5.0 + i * 0.001  # 1 Wh steps: always plausible
                    self.counter.note(value)
                    with lock:
                        noted[i] = value

            def reader():
                for _ in range(count):
                    pair = self.counter.sample()
                    ready = self.counter.eval_ready  # the loop reads both
                    if pair is None or not isinstance(ready, bool):
                        continue
                    value, observed = pair
                    seen.append(observed)
                    i = int((observed - base).total_seconds())
                    with lock:
                        expected = noted.get(i)
                    if expected is not None and value != expected:
                        violations.append((i, value, expected))

            threads = [
                threading.Thread(target=writer),
                threading.Thread(target=reader),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(30)
                self.assertFalse(thread.is_alive())
        self.assertEqual(violations, [])
        self.assertTrue(seen)  # the reader did observe samples


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


class RunWiringTests(unittest.TestCase):
    """run()-level wiring of the day reconciler (#161): ``RECONCILE_INTERVAL=0``
    creates no reconcile thread, the enabled loop is joined (bounded) before
    the shutdown history drain takes the same sink lock (the drain is the
    #94 data-loss critical path, so nothing may reorder the two), and the
    sample freshness window is resolved from the live feed cadence and
    clamped to the tolerance floor's coverage at ceiling power."""

    INTERVALS = (10, 60, 60, 300, 5, 60, 300)

    def run_bridge(self, *, reconcile, events, mqtt=None):
        started = []

        class RecordingThread:
            def __init__(self, target, args=(), kwargs=None, **_thread_options):
                self.target = target
                self.args = args
                self.kwargs = kwargs or {}
                started.append(self)

            def start(self):
                pass

            def join(self, timeout=None):
                events.append(f"join:{self.target.__name__}")

        class RecordingSink(bridge.StatusSink):
            def drain_history(self):
                events.append("drain_history")

        # run() builds the real MqttSource only for an enabled config; the
        # stub keeps the MQTT wiring case offline and is unused otherwise.
        with (
            mock.patch.object(bridge.threading, "Thread", RecordingThread),
            mock.patch.object(bridge, "StatusSink", RecordingSink),
            mock.patch.object(bridge, "command_loop"),
            mock.patch.object(bridge, "MqttSource", return_value=mock.Mock()),
        ):
            bridge.run(
                FakeDB(),
                bridge.ChargerHost("charger"),
                None,
                self.INTERVALS,
                object(),
                bridge.WatchdogConfig(enabled=False),
                mqtt=mqtt,
                reconcile=reconcile,
            )
        return started

    def test_interval_zero_creates_no_reconcile_thread(self):
        started = self.run_bridge(reconcile=bridge.ReconcileConfig(0), events=[])
        targets = [thread.target.__name__ for thread in started]
        self.assertNotIn("reconcile_loop", targets)
        # Only the reconciler drops out; the pollers start as usual.
        self.assertIn("status_loop", targets)

    def test_the_reconcile_thread_joins_before_the_history_drain(self):
        events = []
        started = self.run_bridge(reconcile=bridge.ReconcileConfig(3600), events=events)
        self.assertIn("reconcile_loop", [t.target.__name__ for t in started])
        self.assertIn("join:reconcile_loop", events)
        self.assertIn("drain_history", events)
        self.assertLess(
            events.index("join:reconcile_loop"), events.index("drain_history")
        )

    def test_the_freshness_window_scales_with_the_feed_cadence(self):
        # No MQTT source: the day counter rides the status poll (10 s in
        # INTERVALS), so the window passed to the loop is one status
        # interval -- not the module constant sized for the MQTT cadence.
        started = self.run_bridge(reconcile=bridge.ReconcileConfig(3600), events=[])
        (thread,) = [t for t in started if t.target.__name__ == "reconcile_loop"]
        self.assertEqual(thread.kwargs["sample_max_age"], 10.0)

    def test_the_freshness_window_in_mqtt_mode_uses_the_reconcile_cadence(self):
        # MQTT mode (the shipped one): the day counter rides the HTTP
        # reconcile cadence, so the window passed to the loop is one
        # reconcile interval of the configured cadence, clamped to the
        # tolerance floor's coverage -- with the default 60 s that is
        # exactly the module constant. A 2x factor, or the cadence passed
        # through unclamped, would admit ages past the floor's coverage
        # and warn about observation skew while charging.
        config = bridge.MqttConfig(enabled=True, host="broker", topic="chelevse")
        started = self.run_bridge(
            reconcile=bridge.ReconcileConfig(3600), events=[], mqtt=config
        )
        (thread,) = [t for t in started if t.target.__name__ == "reconcile_loop"]
        self.assertEqual(
            thread.kwargs["sample_max_age"],
            bridge.covered_window_sec(config.reconcile_sec),
        )
        self.assertEqual(
            thread.kwargs["sample_max_age"], bridge.RECONCILE_SAMPLE_MAX_AGE_SEC
        )

    def test_the_reconcile_thread_carries_the_month_half(self):
        # PR-2 (#161): the loop compares the month on the same tick, from
        # the same observation family -- run() builds and threads both.
        started = self.run_bridge(reconcile=bridge.ReconcileConfig(3600), events=[])
        (thread,) = [t for t in started if t.target.__name__ == "reconcile_loop"]
        self.assertIsInstance(thread.kwargs["month_counter"], bridge.ChargerDayCounter)
        self.assertIsInstance(thread.kwargs["month_reconciler"], bridge.MonthReconciler)

    def test_a_slow_reconcile_cadence_clamps_the_freshness_window(self):
        # MQTT_RECONCILE_SEC=120 is a legal, documented setting; the
        # window it buys stops at the tolerance floor's coverage instead
        # of one 120 s interval -- which admitted 100 s-old
        # ceiling-power samples and warned about observation skew (the
        # round-4 finding). Every cadence above the bound buys the same
        # window.
        config = bridge.MqttConfig(
            enabled=True, host="broker", topic="chelevse", reconcile_sec=120.0
        )
        started = self.run_bridge(
            reconcile=bridge.ReconcileConfig(3600), events=[], mqtt=config
        )
        (thread,) = [t for t in started if t.target.__name__ == "reconcile_loop"]
        self.assertLess(thread.kwargs["sample_max_age"], 120.0)
        self.assertEqual(
            thread.kwargs["sample_max_age"], bridge.covered_window_sec(120.0)
        )
        self.assertEqual(
            thread.kwargs["sample_max_age"], bridge.covered_window_sec(3600.0)
        )


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

    def test_main_logs_the_disabled_line_when_interval_is_zero(self):
        logs = []
        with (
            mock.patch.dict(bridge._FILE_ENV, {}, clear=True),
            mock.patch.dict(os.environ, {"RECONCILE_INTERVAL": "0"}, clear=True),
            mock.patch.object(bridge, "init_firestore", return_value=FakeDB()),
            mock.patch.object(bridge, "run"),
            mock.patch.object(bridge, "log", logs.append),
            mock.patch.object(bridge, "ChargerTransport"),
        ):
            bridge.main()
        self.assertTrue(any("day reconciliation: disabled" in line for line in logs))


# -- PR-2: rollover authority, month comparison, mismatch rejection (#161) --


class RolloverWindowTests(unittest.TestCase):
    """The authority window (#161 PR-2): a ``total_day`` reset stamp within
    1 h of Pi-local midnight -- on either side, measured on the same wall
    clock the archive's day documents use -- is the one piece of evidence
    that the two sides measure the same day in the same time zone. The
    window is inclusive at exactly one hour."""

    CASES = (
        (_at(0, 0, 0), True),  # midnight sharp
        (_at(0, 59, 59), True),
        (_at(1, 0, 0), True),  # exactly one hour after: inside
        (_at(1, 0, 1), False),
        (_at(9), False),
        (_at(13, 58), False),  # the mid-day firmware reset
        (_at(22, 59, 59), False),
        (_at(23, 0, 0), True),  # exactly one hour before: inside
        (_at(23, 59, 59), True),
    )

    def test_the_window_is_one_hour_either_side_of_local_midnight(self):
        for when, expected in self.CASES:
            with self.subTest(when=when):
                self.assertEqual(reconcile.within_rollover_window(when), expected)


class RolloverAuthorityTests(LoopBase):
    """PR-2's false-alarm guard: the day comparison warns only after one
    ``total_day`` rollover observed within 1 h of Pi-local midnight. A reset
    at any other hour is boundary evidence of a time-zone or period
    mismatch: comparisons stay informational and the mismatch is said once,
    distinctly -- never repeatedly, never as a warning."""

    def test_a_rollover_just_after_midnight_grants_authority(self):
        self.seed_history(0.5)
        self.note(9.0, _at(23, 59, day=19))
        self.note(0.5, _at(0, 5, day=20))
        self.now = _at(0, 5, day=20)
        self.run_loop(1)
        self.assertTrue(self.reconciler.authorized)
        (grant,) = [line for line in self.logs if "authority granted" in line]
        self.assertIn("rollover", grant)
        self.assertIn("within 1 h of local midnight", grant)
        self.assertEqual(self.warnings(), [])  # the day itself is clean
        self.assert_no_writes()

    def test_a_rollover_just_before_midnight_grants_authority(self):
        # 23:00 is exactly the other edge: a charger whose midnight falls up
        # to an hour early still measures (almost) the Pi's day.
        self.note(9.0, _at(22, 59, day=19))
        self.note(0.1, _at(23, 0, day=19))
        self.now = _at(23, 0, 59, day=19)
        self.run_loop(1)
        self.assertTrue(self.reconciler.authorized)
        self.assert_no_writes()

    def test_a_clean_evaluation_alone_no_longer_grants_authority(self):
        # PR-1 granted on one clean evaluation; PR-2 replaces that with the
        # rollover rule; a clean pair of numbers proves less than it appears
        # (a fresh install over an old archive agrees by construction),
        # while an observed midnight rollover proves the period and the zone.
        self.seed_history(12.4)
        self.seed_pending(0.1)
        self.note(12.5)
        self.run_loop(1)
        self.assertFalse(self.reconciler.authorized)
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assert_no_writes()

    def test_a_reset_at_the_wrong_hour_stays_informational_with_one_note(self):
        self.seed_history(3.0)  # the archive holds the morning ...
        self.note(9.0, _at(12))
        self.note(0.02, _at(13, 58))  # ... the charger reset mid-day
        self.now = _at(13, 58)
        self.run_loop(1)
        (mismatch,) = [
            line for line in self.logs if "outside 1 h of local midnight" in line
        ]
        self.assertIn("time-zone or period mismatch", mismatch)
        self.assertFalse(self.reconciler.authorized)
        (note,) = self.notes()  # the divergence is informational
        self.assertIn("gap 2.980 kwh", note)
        self.assertEqual(self.warnings(), [])
        # The next tick says neither line again: both are bounded.
        self.note(0.03, _at(14, 58))
        self.now = _at(14, 58)
        self.run_loop(1)
        self.assertEqual(len(self.notes()), 1)
        self.assertEqual(
            len(
                [line for line in self.logs if "outside 1 h of local midnight" in line]
            ),
            1,
        )
        self.assert_no_writes()

    def test_a_valid_rollover_after_a_wrong_hour_one_grants(self):
        self.note(9.0, _at(12))
        self.note(0.02, _at(13, 58))  # wrong hour: one note
        self.now = _at(13, 58)
        self.run_loop(1)
        self.note(0.05, _at(23, 59))
        self.note(0.01, _at(0, 5, day=21))  # the charger's real midnight
        self.now = _at(0, 5, day=21)
        self.run_loop(1)
        self.assertTrue(self.reconciler.authorized)
        self.assertEqual(
            len([l for l in self.logs if "outside 1 h of local midnight" in l]), 1
        )
        self.assertEqual(len([l for l in self.logs if "authority granted" in l]), 1)
        self.assert_no_writes()

    def test_a_grant_survives_a_mid_day_reset(self):
        # A mid-day firmware reset is not a time-zone mismatch: authority
        # earned at a real midnight survives it, and the divergence it causes
        # is the mid-day restart scenario -- a warning, not a mismatch note.
        self.authorize()
        self.seed_history(9.0, hours={"09": 4.0, "10": 3.0, "11": 2.0})
        self.note(9.0, _at(13, 58))
        self.now = _at(13, 58)
        self.run_loop(1)
        self.note(0.02, _at(13, 58, 40))  # mid-day reset: another rollover
        self.note(3.4, _at(15))
        self.seed_pending(0.1, _at(15))
        self.now = _at(15)
        self.run_loop(1)
        self.assertTrue(self.reconciler.authorized)
        self.assertEqual(
            [line for line in self.logs if "outside 1 h of local midnight" in line],
            [],
        )
        (warning,) = self.warnings()
        self.assertIn("day 2026-11-20", warning)
        self.assert_no_writes()


class NonResetCounterTests(LoopBase):
    """A day counter that sails across Pi-local midnight without resetting
    is not measuring the Pi's day (period or time-zone mismatch): the
    observation is rejected as boundary evidence -- one distinct line, no
    authority -- and a grant it contradicts is revoked. The probe is sound
    only where a reset could not have hidden: a reset-and-rebuilt counter
    (the outage recovery) must never read as a non-reset."""

    def test_a_non_resetting_counter_is_rejected_as_a_period_mismatch(self):
        self.seed_history(25.0)  # the archive's morning ...
        self.note(30.0, _at(23, 59, day=19))
        self.note(30.1, _at(0, 5, day=20))  # ... carried across: no reset
        self.now = _at(0, 5, day=20)
        self.run_loop(1)
        (mismatch,) = [
            line for line in self.logs if "day counter did not reset" in line
        ]
        self.assertIn("period mismatch", mismatch)
        self.assertFalse(self.reconciler.authorized)
        (note,) = self.notes()  # 25.0 vs 30.1: informational only
        self.assertIn("bridge low", note)
        self.assertEqual(self.warnings(), [])
        self.assert_no_writes()

    def test_a_non_reset_after_a_grant_revokes_authority(self):
        self.authorize()
        self.note(9.0, _at(23, 59))
        self.note(9.1, _at(0, 5, day=21))  # no reset at the second midnight
        self.seed_history(5.0, day="2026-11-21")
        self.now = _at(0, 5, day=21)
        self.run_loop(1)
        (revoked,) = [line for line in self.logs if "warning authority revoked" in line]
        self.assertIn("did not reset", revoked)
        self.assertFalse(self.reconciler.authorized)
        (note,) = self.notes()  # 5.0 vs 9.1 stays informational
        self.assertIn("bridge low", note)
        self.assertEqual(self.warnings(), [])
        self.assert_no_writes()

    def test_a_reset_and_rebuilt_counter_is_not_a_non_reset(self):
        # The charger reset at its midnight and rebuilt past yesterday's
        # level while the bridge was dark: inside the observation gap the
        # current value alone cannot exclude a reset, so the probe stays
        # quiet (MidnightOutageTests' recovery warning depends on it).
        self.note(5.0, _at(23, 10, day=19))
        self.note(5.2, _at(9, day=20))
        self.assertEqual(self.counter.non_resets, [])
        self.assertEqual(self.counter.rollovers, [])

    def test_a_tiny_baseline_rise_across_midnight_is_not_a_non_reset(self):
        # Yesterday ended at 0.01 kwh and the new day passed that within the
        # gap: a midnight reset explains the reading, so nothing is deduced.
        self.note(0.01, _at(23, 59, day=19))
        self.note(0.03, _at(0, 1, day=20))
        self.assertEqual(self.counter.non_resets, [])
        self.assertEqual(self.counter.rollovers, [])

    def test_a_non_reset_from_an_untrusted_baseline_is_not_recorded(self):
        # A corrupt jump poisoned the level; whether the counter dropped in
        # the dark after it is unknowable from that baseline.
        self.note(30.0, _at(23, 5, day=19))
        self.note(400.0, _at(23, 6, day=19))  # rejected as implausible
        self.note(400.4, _at(0, 5, day=20))  # straddles, no drop, untrusted base
        self.assertEqual(self.counter.non_resets, [])


class MonthLoopBase(LoopBase):
    """LoopBase plus the month half: a ``total_month`` sample stream and a
    month reconciler, driven by the same helpers and the same shared boot
    clock (both counters ride the same applied observations)."""

    def setUp(self):
        super().setUp()
        self.month_counter = bridge.ChargerDayCounter(period="month")
        self.month_reconciler = bridge.MonthReconciler()

    def note_month(self, value, when=None):
        self.note(value, when, counter=self.month_counter)

    def evaluate_month(
        self,
        *,
        archive,
        pending=0.0,
        charger,
        when=None,
        observed=None,
        month="2026-11",
    ):
        """One month evaluation at an exact wall-clock instant."""
        when = when or self.now
        with mock.patch.object(bridge, "_localnow", return_value=when):
            return self.month_reconciler.evaluate(
                day=month,
                now_local=when,
                archive_kwh=archive,
                pending_kwh=pending,
                charger_kwh=charger,
                charger_observed_local=observed or when,
            )

    def month_lines(self):
        return [line for line in self.logs if "month reconciliation" in line]

    def seed_month_docs(self, kwh_by_day):
        """Pre-seed the month's earlier day documents (today: seed_history)."""
        history = self.db.data.setdefault("history", {})
        for day, kwh in kwh_by_day.items():
            history[day] = {
                "kwh": kwh,
                "hours": {"18": kwh},
                "updated_at": "2026-11-19T23:00:00Z",
            }


class MonthKnownGoodTests(MonthLoopBase):
    """The month comparison (#161 PR-2): one documentId range query over the
    month's ``history/{date}`` documents plus today's pending energy, once
    per local day, against ``total_month`` from the same observation family
    that feeds the day counter. Same tolerance, same episode bounding, same
    zero-writes guarantee."""

    def test_matching_month_totals_are_clean_and_write_free(self):
        self.seed_month_docs(
            {"2026-11-01": 8.2, "2026-11-05": 12.9, "2026-11-19": 30.0}
        )
        self.seed_history(12.4)
        self.seed_pending(0.1)
        self.note(12.5)
        self.note_month(63.6)  # 8.2 + 12.9 + 30.0 + 12.4 + 0.1
        self.run_loop(1)
        # The day comparison is clean, which is the month's authority gate:
        # exactly one grant line, and the month itself reconciles silently.
        (grant,) = self.month_lines()
        self.assertIn("warning authority granted", grant)
        self.assertIn("one clean day comparison", grant)
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assert_no_writes()

    def test_the_month_tolerance_is_the_day_machinery(self):
        self.note_month(100.0)
        self.month_reconciler.note_clean_day(self.now)
        self.assertEqual(self.evaluate_month(archive=100.0, charger=100.9), "clean")
        self.assertEqual(self.evaluate_month(archive=100.0, charger=102.0), "warned")

    def test_an_empty_month_archive_is_a_zero_month(self):
        # The 1st, before any document exists: zeros against the early
        # counter is a normal clean comparison, not a divergence.
        self.now = _at(9, day=1)
        self.note(0.05, _at(9, day=1))
        self.note_month(0.05, _at(9, day=1))
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assertEqual([l for l in self.month_lines() if "(month" in l], [])
        self.assert_no_writes()

    def test_a_month_divergence_after_a_clean_day_warns_with_all_fields(self):
        self.seed_month_docs({"2026-11-01": 8.2, "2026-11-19": 30.0})
        self.seed_history(12.4)
        self.seed_pending(0.1)
        self.note(12.5)
        self.note_month(55.0)  # 4.3 kwh ahead of the archive
        self.run_loop(1)
        (warning,) = [l for l in self.month_lines() if "warning (month" in l]
        for expected in (
            "month 2026-11",
            "50.700 kwh",  # bridge month: 8.2 + 30.0 + 12.4 + 0.1
            "archive 50.600",
            "pending 0.100",
            "charger total_month 55.000 kwh",
            "4.300 kwh",
            "bridge low",
            "no clean evaluation yet",
            "no history or session data modified",
        ):
            self.assertIn(expected, warning)
        self.assert_no_writes()

    def test_a_month_divergence_before_any_clean_day_is_informational(self):
        self.seed_month_docs({"2026-11-01": 8.2, "2026-11-19": 30.0})
        self.seed_history(9.0)  # the day is short: no clean day comparison
        self.note(12.5)
        self.note_month(55.0)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        (note,) = [l for l in self.month_lines() if "note (month" in l]
        self.assertIn("informational", note)
        self.assertIn("authority not yet granted", note)
        self.assert_no_writes()

    def test_the_month_is_compared_once_per_local_day(self):
        self.seed_history(9.0)
        self.note(12.5)  # the day diverges: no month authority
        self.note_month(55.0)
        self.run_loop(1)
        month_output = [l for l in self.month_lines() if "(month" in l]
        self.assertEqual(len(month_output), 1)
        # The same day's next tick, with a gap grown past the re-arm bound,
        # does not compare again: the range query runs once per local day.
        self.note(12.5, _at(15))
        self.note_month(53.0, _at(15))
        self.now = _at(15)
        self.run_loop(1)
        self.assertEqual(len([l for l in self.month_lines() if "(month" in l]), 1)
        # The next local day compares again -- and the gap grown by another
        # kWh overnight re-arms the episode.
        self.note(12.5, _at(9, day=21))
        self.note_month(60.0, _at(9, day=21))
        self.now = _at(9, day=21)
        self.run_loop(1)
        self.assertEqual(len([l for l in self.month_lines() if "(month" in l]), 2)
        self.assert_no_writes()

    def test_a_stale_month_sample_waits_for_a_fresh_one(self):
        self.seed_history(9.0)
        self.note(12.5)  # a fresh day sample ...
        self.note_month(55.0, _at(8, 30))  # ... but the month sample is old
        self.run_loop(1)
        self.assertEqual([l for l in self.month_lines() if "(month" in l], [])
        # A fresh month sample lets the once-per-day comparison run.
        self.note(12.5, _at(10))
        self.note_month(55.0, _at(10))
        self.now = _at(10)
        self.run_loop(1)
        self.assertEqual(len([l for l in self.month_lines() if "(month" in l]), 1)
        self.assert_no_writes()

    def test_a_sample_from_the_previous_month_is_not_compared(self):
        # October ended reconciled; the November 1st 00:00:30 tick sees a
        # month sample from 23:59:31 on the 31st -- inside the freshness
        # window but measuring October. The same-month guard holds the
        # evaluation until a November sample arrives.
        self.seed_month_docs({"2026-10-28": 11.0})
        self.seed_history(9.0, day="2026-10-31")
        self.note(9.0, _at(23, 59, 31, day=31, month=10))
        self.note_month(20.0, _at(23, 59, 31, day=31, month=10))
        self.now = _at(23, 59, 31, day=31, month=10)
        self.run_loop(1)
        self.assertTrue(self.month_reconciler.authorized)  # clean October day
        self.now = _at(0, 0, 30, day=1, month=11)
        self.run_loop(1)
        self.assertEqual([l for l in self.month_lines() if "(month 2026-11" in l], [])
        self.assert_no_writes()
        # A November sample arrives: the comparison runs -- and November's
        # missing archive is a real, authorized warning.
        self.note(0.02, _at(0, 10, day=1, month=11))
        self.note_month(5.0, _at(0, 10, day=1, month=11))
        self.now = _at(0, 10, day=1, month=11)
        self.run_loop(1)
        (warning,) = [l for l in self.month_lines() if "(month 2026-11" in l]
        self.assertIn("bridge low", warning)
        self.assertIn("5.000 kwh", warning)
        self.assert_no_writes()

    def test_the_month_range_query_reads_only_the_months_documents(self):
        # Days either side of the month line are not summed: October's and
        # December's documents stay out of November's total.
        self.seed_month_docs({"2026-10-31": 40.0, "2026-12-01": 50.0})
        self.seed_history(9.0)
        self.note(9.0)
        self.note_month(9.0)
        self.run_loop(1)
        self.assertEqual([l for l in self.month_lines() if "(month" in l], [])
        self.assert_no_writes()


class MonthCounterTests(MonthLoopBase):
    """The month counter stream: the same guarded machinery as the day
    counter, with the reset boundary at the month line."""

    def test_a_month_rollover_rebaselines_the_counter(self):
        self.note_month(220.0, _at(9, day=30))
        self.note_month(0.5, _at(9, day=1, month=12))  # the charger's month line
        self.assertEqual(self.month_counter.rollovers, [_at(9, day=1, month=12)])
        value, _observed = self.month_counter.sample()
        self.assertEqual(value, 0.5)
        self.assertIn("month counter rollover", " ".join(self.logs))

    def test_a_month_counter_that_does_not_reset_at_the_month_line(self):
        self.note_month(68.0, _at(23, 59, day=30))
        self.note_month(68.1, _at(0, 5, day=1, month=12))
        self.assertEqual(len(self.month_counter.non_resets), 1)
        self.assertIn("month counter did not reset", " ".join(self.logs))

    def test_an_ordinary_midnight_does_not_probe_the_month_counter(self):
        # The month counter resets monthly: sailing over a plain midnight is
        # its normal behaviour, not evidence of anything.
        self.note_month(68.0, _at(23, 59))
        self.note_month(68.1, _at(0, 5, day=21))
        self.assertEqual(self.month_counter.non_resets, [])


class MonthNonResetTests(MonthLoopBase):
    """The month's grant falls with the day's (#161): the same day-counter
    non-reset that revokes the day's authority disproves the shared clock
    for both periods, so the month's comparisons go informational again
    until the next clean day comparison."""

    def test_a_day_non_reset_after_both_grants_revokes_the_month_too(self):
        self.authorize()
        self.seed_month_docs({"2026-11-19": 9.0})
        self.seed_history(0.0, day="2026-11-21")
        self.seed_history(9.0)  # day 20: 9.0 vs 9.0 is the clean day ...
        self.note(9.0)
        self.note_month(18.0)  # ... and 18.0 vs 18.0 the clean month
        self.run_loop(1)
        self.assertTrue(self.reconciler.authorized)
        self.assertTrue(self.month_reconciler.authorized)
        # The alignment breaks after the grants (a time_zone change, a
        # reflash): the next midnight produces a day non-reset, and both
        # grants fall in the same tick -- one revoke line each.
        self.note(9.0, _at(23, 59))
        self.note(9.1, _at(0, 5, day=21))
        self.note_month(27.0, _at(0, 5, day=21))
        self.now = _at(0, 5, day=21)
        self.run_loop(1)
        revoked = [line for line in self.logs if "warning authority revoked" in line]
        self.assertEqual(len(revoked), 2)
        self.assertIn("day reconciliation", revoked[0])
        self.assertIn("did not reset", revoked[0])
        self.assertIn("month reconciliation", revoked[1])
        self.assertIn("did not reset", revoked[1])
        self.assertFalse(self.reconciler.authorized)
        self.assertFalse(self.month_reconciler.authorized)
        # Both periods' divergences are informational again: 0.0 vs 9.1
        # and 18.0 vs 27.0, neither a warning.
        (day_note,) = [line for line in self.logs if "note (day" in line]
        self.assertIn("bridge low", day_note)
        (month_note,) = [line for line in self.month_lines() if "note (month" in line]
        self.assertIn("bridge low", month_note)
        self.assertEqual(self.warnings(), [])
        self.assert_no_writes()


class MonthRobustnessTests(MonthLoopBase):
    def test_a_failed_month_read_skips_the_evaluation(self):
        self.note(12.5)
        self.note_month(68.0)
        self.db.fail_reads = True
        self.run_loop(1)
        failures = [
            line for line in self.logs if "month reconciliation read failed" in line
        ]
        self.assertEqual(len(failures), 1)
        self.assertEqual([l for l in self.month_lines() if "(month" in l], [])
        self.assertEqual(self.db.writes, [])


class UnitMismatchTests(MonthLoopBase):
    """A counter reporting Wh where the contract says kWh reads ~1000x the
    bridge total: that signature is rejected with its own structured line --
    never warned, never reconciled -- at either period."""

    def test_a_wh_scaled_day_counter_is_rejected_not_warned(self):
        self.seed_history(12.5)
        self.note(12_500.0)  # first sample: a baseline, no step to judge
        self.run_loop(1)
        (rejected,) = [l for l in self.logs if "reconciliation rejected" in l]
        self.assertIn("unit mismatch", rejected)
        self.assertIn("1000x", rejected)
        self.assertIn("12.500 kwh", rejected)
        self.assertIn("12500.000 kwh", rejected)
        self.assertIn("no history or session data modified", rejected)
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        self.assert_no_writes()
        # The episode is bounded: the next hourly tick says nothing new.
        self.note(12_500.0, _at(10))
        self.now = _at(10)
        self.run_loop(1)
        self.assertEqual(
            len([l for l in self.logs if "reconciliation rejected" in l]), 1
        )

    def test_a_wh_scaled_month_counter_is_rejected_not_warned(self):
        self.month_reconciler.note_clean_day(self.now)
        self.assertEqual(
            self.evaluate_month(archive=220.0, charger=220_000.0), "rejected"
        )
        (rejected,) = [l for l in self.logs if "reconciliation rejected" in l]
        self.assertIn("total_month", rejected)
        self.assertIn("unit mismatch", rejected)
        self.assertEqual([l for l in self.month_lines() if "warning (month" in l], [])

    def test_a_real_divergence_is_not_classified_as_a_unit_mismatch(self):
        self.authorize()
        self.note(12.5)
        self.assertEqual(self.evaluate(archive=12.5, charger=30.0), "warned")
        self.assertEqual([l for l in self.logs if "rejected" in l], [])

    def test_a_sub_floor_thousandfold_ratio_is_the_outage_not_the_counter_day(self):
        # The bridge was dark all day and restarted into a charging
        # session seconds old: a whisker of observed energy against a
        # charger that delivered all day on its own schedule. The ratio
        # reads exactly 1000x, but below REARM_KWH that is the outage
        # path the warning exists for -- a genuine Wh-scaled counter
        # crosses 1 kWh on its first charge session and is rejected from
        # then on.
        self.authorize()
        self.assertEqual(
            self.evaluate(archive=0.0, pending=0.05, charger=50.0), "warned"
        )
        (warning,) = self.warnings()
        self.assertIn("bridge low", warning)
        self.assertEqual([l for l in self.logs if "reconciliation rejected" in l], [])

    def test_a_sub_floor_thousandfold_ratio_is_the_outage_not_the_counter_month(self):
        # The month twin: a Pi dead since the month start, the charger
        # ~100 kwh ahead on its own schedule, the bridge's first observed
        # energy 0.1 kwh in. Ratio exactly 1000x at a magnitude too small
        # to carry only the counter signature: the authorized bridge-low
        # warning is the right line, not the unit-mismatch rejection.
        self.month_reconciler.note_clean_day(self.now)
        self.assertEqual(
            self.evaluate_month(archive=0.0, pending=0.1, charger=100.0), "warned"
        )
        (warning,) = [l for l in self.month_lines() if "warning (month" in l]
        self.assertIn("bridge low", warning)
        self.assertEqual([l for l in self.logs if "reconciliation rejected" in l], [])


class DSTFallBackTests(MonthLoopBase):
    """The fall-back day (2026-10-25, London's last October Sunday): the fold
    repeats hour 01 and the day is 25 wall hours, but the reconciler's
    totals are wall-clock sums -- the folded hour's two passes merge into
    one ``01`` bucket and nothing about either comparison changes."""

    BST = timezone(timedelta(hours=1))
    GMT = timezone.utc
    DAY = "2026-10-25"

    @classmethod
    def _bst(cls, hour, minute=0, second=0, day=25):
        return datetime(2026, 10, day, hour, minute, second, tzinfo=cls.BST)

    @classmethod
    def _gmt(cls, hour, minute=0, second=0, day=25):
        return datetime(2026, 10, day, hour, minute, second, tzinfo=cls.GMT)

    def test_the_fall_back_day_reconciles_on_both_periods(self):
        # One ``01`` bucket holds both passes (1.2 kwh BST + 0.8 kwh GMT) --
        # the accumulator's DST contract -- and the day and month totals
        # still match the charger's counters.
        self.seed_month_docs({"2026-10-20": 10.0, "2026-10-24": 6.0})
        self.seed_history(5.5, hours={"00": 0.5, "01": 2.0, "08": 3.0}, day=self.DAY)
        self.note(5.5, self._gmt(15))
        self.note_month(21.5, self._gmt(15))  # 10.0 + 6.0 + 5.5
        self.now = self._gmt(15)
        self.run_loop(1)
        self.assertEqual(self.warnings(), [])
        self.assertEqual(self.notes(), [])
        (grant,) = self.month_lines()  # the clean day is the month's gate
        self.assertIn("one clean day comparison", grant)
        self.assert_no_writes()

    def test_a_rollover_just_after_midnight_grants_across_the_fold(self):
        self.note(9.0, self._bst(23, 59, day=24))
        self.note(0.1, self._bst(0, 5))  # 00:05 BST: 300 wall seconds in
        self.now = self._bst(0, 5)
        self.run_loop(1)
        self.assertTrue(self.reconciler.authorized)
        self.assert_no_writes()

    def test_a_rollover_in_the_folded_hour_is_judged_by_wall_clock(self):
        # 01:30 GMT is the second pass of the folded hour -- 2.5 real hours
        # after midnight but 1.5 wall hours: outside the window either way,
        # so the fold cannot smuggle a misaligned midnight past the rule.
        self.note(9.0, self._bst(1, 0))
        self.note(0.5, self._gmt(1, 30))
        self.now = self._gmt(1, 30)
        self.run_loop(1)
        self.assertFalse(self.reconciler.authorized)
        self.assertEqual(
            len([l for l in self.logs if "outside 1 h of local midnight" in l]), 1
        )
        self.assert_no_writes()


class MonthWiringTests(unittest.TestCase):
    def test_status_loop_feeds_the_month_counter(self):
        host = _host()
        session = FakeSession(
            [FakeResponse(200, _status_payload(total_month=228.9))] * 2
        )
        month_counters = bridge.ChargerDayCounter(period="month")
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
                day_counters=bridge.ChargerDayCounter(),
                month_counters=month_counters,
            )
        value, _observed = month_counters.sample()
        self.assertEqual(value, 228.9)
