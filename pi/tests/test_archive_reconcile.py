"""Seam-B archive reconciliation tests (issue #212, PR-3): day docs vs the
sessions archive, on the tracker's own observation basis.

No broker, charger, Firestore or FCM is touched: the reconciler runs against
the in-memory fakes with injected clocks, driven through the real
:class:`archive_reconcile.SessionBasisTracker` (the same ``observe`` path
the status loop uses), so every fixture exercises the same per-tick
attribution the live bridge runs. The pins, one per plan phase:

- same-basis midnight cancellation -- a session straddling several midnights
  (the Nov 15-19 shape) reconciles to a zero verdict on each spanned day;
- deferral -- a day overlapped by an open session gets no verdict until the
  session closes;
- verdict-is-raw -- a fixed deficit produces ``gap_wh`` equal to the true
  delta, with no tolerance band;
- field-path isolation -- the ``gap_wh`` write provably cannot modify
  ``kwh``/``hours``;
- write-once idempotence and the write budget -- a rerun on an unchanged
  finalized day writes nothing, and a steady state is write-free;
- restart -- the trailing window recomputes from day docs plus one sessions
  range read.
"""

import sys
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import archive_reconcile  # noqa: E402
import bridge  # noqa: E402
from fakes import FakeDB, _StopAfter  # noqa: E402
from write_counter import WriteCounter  # noqa: E402


def _at(day, hour, minute=0, month=11):
    """One exact instant in the scenario window (November 2026, UTC-local)."""
    return datetime(2026, month, day, hour, minute, tzinfo=UTC)


class _QuietNotifier:
    """The notifier surface the sink needs; nothing is ever pushed here."""

    def enqueue(self, *_args):
        return None


class ArchiveBase(unittest.TestCase):
    """A session-basis tracker, sink and reconciler on injected clocks.

    ``apply`` is the status loop in miniature: one observation at an exact
    wall-clock instant runs ``record_history`` then ``observe`` (the sink's
    order), with the boot clock advancing with the wall clock so the step
    allowance reads a plausible charger -- the ``IntervalTests.tick``
    convention. ``tick`` runs one seam-B cadence pass at an exact instant.
    """

    def setUp(self):
        self.db = FakeDB()
        self.logs = []
        self.now = _at(15, 8)
        self.boot = 10_000.0
        self.mono = 500.0
        self._last_when = None
        self._scenario_start = None
        self.total_kwh = 1000.0
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.recon = archive_reconcile.ArchiveReconciler(
            self.db, counter=WriteCounter(clock=lambda: self.mono)
        )
        self.recon._started_at = self.now
        self.tracker = archive_reconcile.SessionBasisTracker(
            self.db, basis=self.recon.basis
        )
        # The seeded history baseline record_history needs (LoopBase's
        # shortcut: no status/current document, but a trusted baseline).
        self.tracker.seeded = True
        self.tracker.total_energy = self.total_kwh
        self.sink = bridge.StatusSink(self.db, self.tracker, _QuietNotifier())

    # -- helpers -------------------------------------------------------------

    def seed_marker(self, recon_from="2026-10-19"):
        """Pretend a previous run already marked recon_from (no backfill)."""
        self.db.data.setdefault("history", {})[
            archive_reconcile.MARKER_DOC_ID
        ] = {"recon_from": recon_from}

    def apply(self, when, state, session_wh, total_kwh=None, vehicle=1):
        """One applied status observation at an exact instant."""
        total_kwh = self.total_kwh if total_kwh is None else total_kwh
        if self._last_when is not None:
            step = max(0.0, (when - self._last_when).total_seconds())
        else:
            step = 0.0
        if self._scenario_start is None:
            # The charger's session timer starts at the plug-in: the first
            # applied charging tick of the scenario is its zero.
            self._scenario_start = when
        self._last_when = when
        self.boot += step
        self.mono += step
        self.total_kwh = total_kwh
        elapsed = max(0, int((when - self._scenario_start).total_seconds()))
        with (
            mock.patch.object(bridge, "_utcnow", return_value=when),
            mock.patch.object(bridge, "_localnow", return_value=when),
            mock.patch.object(bridge.time, "monotonic", return_value=self.mono),
            mock.patch.object(
                bridge.time, "clock_gettime", return_value=self.boot, create=True
            ),
        ):
            self.tracker.record_history(total_kwh)
            self.tracker.observe(
                {
                    "state": state,
                    "session_energy": session_wh,
                    "elapsed": elapsed,
                    "vehicle": vehicle,
                }
            )
        return when

    def tick(self, when):
        """One seam-B cadence pass at an exact instant."""
        with mock.patch.object(bridge, "_localnow", return_value=when):
            self.recon.tick(when, self.sink)

    def verdict_writes(self):
        """The gap_wh/marker writes this module owns (index into db.writes)."""
        return [
            write
            for write in self.db.writes
            if write[1] == "history"
            and (
                write[3] is not None
                and (
                    archive_reconcile.GAP_FIELD in write[3]
                    or archive_reconcile.RECON_FROM_FIELD in write[3]
                )
            )
        ]

    def verdict_lines(self):
        return [line for line in self.logs if "archive reconciliation" in line]

    def seed_day(self, day, kwh, hour="12"):
        self.db.data.setdefault("history", {})[day] = {
            "kwh": kwh,
            "hours": {hour: kwh},
            "updated_at": "2026-11-01T12:00:00Z",
        }

    def seed_session(self, start, end, wh, interval_wh):
        self.db.data.setdefault("sessions", {})[str(int(start.timestamp()))] = {
            "started_at": start,
            "ended_at": end,
            "wh": wh,
            "elapsed": int((end - start).total_seconds()),
            "intervals": [
                {"started_at": start, "ended_at": end, "wh": interval_wh}
            ],
        }

    def charge_block(self, start, hours, wh_per_hour, first_session_wh=None):
        """One contiguous charging block: hourly ticks, then the stop edge.

        Returns the stop instant. The charger's two meters move together
        (``session_energy`` in Wh, ``total_energy`` in kWh), so the day doc
        and the session basis accrue the same observed energy by
        construction -- a fixture that wants a deficit drives the totals
        apart by hand. ``first_session_wh`` seeds the counter for a plug-in
        whose earlier blocks already accumulated (the charger keeps
        session_energy cumulative while the vehicle stays connected); the
        first charging tick of the first block is the baseline (0).
        """
        session_wh = 0.0 if first_session_wh is None else first_session_wh
        moment = start
        self.apply(moment, 3, session_wh)
        for _ in range(hours):
            session_wh += wh_per_hour
            self.total_kwh += wh_per_hour / 1000.0
            moment = moment + timedelta(hours=1)
            self.apply(moment, 3, session_wh)
        self.apply(moment, 1, session_wh)
        return moment

    def day_doc(self, day):
        return self.db.data.get("history", {}).get(day)


class SessionBasisMirrorTests(ArchiveBase):
    """The accumulator is the interval list's per-day twin, tick for tick."""

    def test_a_midnight_straddling_block_splits_the_same_on_both_sides(self):
        # Charging 22:00-02:00 at 1000 Wh/h: each tick's delta lands on the
        # day it was observed in (23:00's on the 20th; midnight's and later
        # on the 21st), so the basis, the interval list and the history
        # attribution all carry the same 1000/3000 split -- the same-basis
        # property the verdict's exactness stands on.
        self.seed_marker()
        self.tick(_at(20, 9))  # prime: nothing stored yet, clean reseed
        end = self.charge_block(_at(20, 22), hours=4, wh_per_hour=1000)
        (record,) = self.db.data.get("sessions", {}).values()
        (interval,) = record["intervals"]
        with self.sink._lock:
            basis_20 = self.recon.basis.basis_for_day("2026-11-20")
            basis_21 = self.recon.basis.basis_for_day("2026-11-21")
        self.assertEqual(basis_20, 1000.0)
        self.assertEqual(basis_21, 3000.0)
        self.assertEqual(interval["wh"], 4000.0)
        self.assertEqual(interval["started_at"], _at(20, 22))
        self.assertEqual(interval["ended_at"], end)
        self.assertEqual(self.day_doc("2026-11-20")["kwh"], 1.0)
        self.assertEqual(self.day_doc("2026-11-21")["kwh"], 3.0)

    def test_the_basis_rides_the_tracker_not_the_document(self):
        # Deltas are attributed at observe time (in memory), so a mid-block
        # state -- the closed hour flushed, the open one still pending --
        # already carries the full session basis, exactly like the history
        # accumulator's pending half of the same ticks.
        self.seed_marker()
        self.tick(_at(20, 9))
        start = _at(20, 12)
        self.apply(start, 3, 0, total_kwh=1000.0)
        self.apply(start + timedelta(minutes=30), 3, 300, total_kwh=1000.3)
        self.apply(start + timedelta(hours=1), 3, 700, total_kwh=1000.7)
        self.apply(start + timedelta(hours=1, minutes=30), 3, 1000, total_kwh=1001.0)
        with self.sink._lock:
            basis = self.recon.basis.basis_for_day("2026-11-20")
            pending = self.tracker.history.pending_for_day("2026-11-20")
        doc = self.day_doc("2026-11-20")
        self.assertEqual(basis, 1000.0)
        # The hour-rollover flush spans both buckets (issue #94): the
        # closed hour and the rollover tick's own hour both landed.
        self.assertAlmostEqual(doc["kwh"], 0.7)
        self.assertAlmostEqual(pending, 0.3)  # the open hour's later delta
        self.assertAlmostEqual(doc["kwh"] + pending, 1.0)


class LiveVerdictTests(ArchiveBase):
    """The live path: deferred while open, one raw verdict when final."""

    def test_a_clean_finalized_day_writes_nothing(self):
        self.seed_marker()
        self.tick(_at(19, 9))
        self.charge_block(_at(19, 12), hours=4, wh_per_hour=1000)
        self.tick(_at(20, 9))
        self.assertEqual(self.verdict_writes(), [])
        self.assertIn("2026-11-19", self.recon._evaluated)
        self.assertEqual(self.verdict_lines(), [])
        self.assertNotIn("gap_wh", self.day_doc("2026-11-19"))

    def test_a_deficit_day_writes_the_raw_gap_once(self):
        # The seam-B shape: the day doc (from total_energy) carries 1000 Wh
        # more than the session basis drew (from session_energy) -- the
        # raw delta lands verbatim, no band, written exactly once.
        self.seed_marker()
        self.tick(_at(19, 9))
        start = _at(19, 12)
        self.apply(start, 3, 0, total_kwh=1000.0)
        for hour in range(1, 5):
            self.apply(
                start + timedelta(hours=hour),
                3,
                1000 * hour,
                total_kwh=1000.0 + 1.25 * hour,
            )
        self.apply(start + timedelta(hours=4), 1, 4000, total_kwh=1005.0)
        self.tick(_at(20, 9))
        (write,) = self.verdict_writes()
        self.assertEqual(
            write,
            ("set", "history", "2026-11-19", {"gap_wh": 1000.0}, ["gap_wh"]),
        )
        self.assertEqual(self.day_doc("2026-11-19")["gap_wh"], 1000.0)
        # Rerun on the unchanged finalized day: nothing more.
        before = len(self.db.writes)
        self.tick(_at(20, 10))
        self.assertEqual(len(self.db.writes), before)

    def test_a_null_marked_day_is_never_re_verdicted(self):
        # The three-state contract on the live path: ``gap_wh: null`` is a
        # settled state (unknown, not clean), and the null was written
        # precisely because the attribution behind any recomputed number
        # cannot be trusted -- so a later process must leave it alone, not
        # overwrite the disclosure with its own verdict.
        self.seed_marker()
        self.seed_day("2026-11-18", 3.0)
        self.db.data["history"]["2026-11-18"]["gap_wh"] = None
        self.tick(_at(19, 9))
        # No sessions record exists, so the day is not inexact here; the
        # settled guard alone stands between the null mark and a
        # re-verdict (the basis is empty, the doc holds 3000 Wh).
        self.assertNotIn("2026-11-18", self.recon._inexact)
        self.assertIn("2026-11-18", self.recon._evaluated)
        self.assertEqual(self.verdict_writes(), [])
        self.assertIsNone(self.day_doc("2026-11-18")["gap_wh"])

    def test_a_day_overlapped_by_an_open_session_is_deferred(self):
        # The Nov 21 resume-band shape: charging is running now and started
        # yesterday, so yesterday's verdict waits -- no read verdict, no
        # write, no verdict line -- until the session closes. The day doc
        # ends 1000 Wh ahead of the session basis (a real deficit the
        # deferral must not lose).
        self.seed_marker()
        self.tick(_at(20, 9))
        start = _at(20, 20)
        self.apply(start, 3, 0, total_kwh=1000.0)
        self.apply(start + timedelta(hours=1), 3, 1000, total_kwh=1001.0)
        self.apply(start + timedelta(hours=2), 3, 2000, total_kwh=1002.0)
        self.apply(start + timedelta(hours=3), 3, 3000, total_kwh=1004.0)
        self.tick(_at(21, 9))
        self.assertEqual(self.verdict_writes(), [])
        self.assertNotIn("2026-11-20", self.recon._evaluated)
        self.assertEqual(self.verdict_lines(), [])
        # The block closes; the next cadence pass verdicts the day: the day
        # doc's 4.0 kWh against the session basis's 3000 Wh.
        self.apply(start + timedelta(hours=10), 1, 3000, total_kwh=1004.0)
        self.tick(_at(21, 11))
        (write,) = self.verdict_writes()
        self.assertEqual(write[2], "2026-11-20")
        self.assertEqual(write[3]["gap_wh"], 1000.0)

    def test_a_day_the_open_session_outlives_is_marked_unknown(self):
        # The deferral horizon: a session open for more than the trailing
        # window keeps its days deferred until the window ages each one
        # out, and an aged-out day is never verdicted again -- not by this
        # process (the tick window has moved past it) and not by a restart
        # (the reseed reads the same window). Its day doc holds real
        # energy the unsettled basis cannot explain, so the last visit
        # must queue the explicit gap_wh null instead of letting the day
        # slip out the back of the window, where its absence would read
        # as the verified-clean verdict.
        self.seed_marker()
        # One charging block opens on the 18th and never closes here: the
        # open interval's start overlaps every candidate day from the
        # 18th on (the day doc's 5 kWh is real metered energy).
        self.apply(_at(18, 12), 3, 0, total_kwh=1000.0)
        self.seed_day("2026-11-18", 5.0)
        self.tick(_at(19, 13))  # prime; the 18th at offset 1: deferred
        self.assertEqual(self.verdict_writes(), [])
        self.assertNotIn("gap_wh", self.day_doc("2026-11-18"))
        self.tick(_at(20, 13))  # offset 2: still deferred, still unmarked
        self.assertEqual(self.verdict_writes(), [])
        # The last visit (the window's oldest offset): the day can never
        # be verdicted after this tick, so the unknown mark lands now.
        self.tick(_at(21, 13))
        self.assertIsNone(self.day_doc("2026-11-18")["gap_wh"])
        self.assertEqual(
            self.verdict_writes(),
            [("set", "history", "2026-11-18", {"gap_wh": None}, ["gap_wh"])],
        )
        self.assertEqual(self.recon._unmarked_inexact, {})
        self.assertTrue(
            any(
                "outlived the verdict window" in line
                for line in self.verdict_lines()
            )
        )
        # The younger overlapped days stay deferred and unmarked: their
        # session may still close inside the window.
        self.assertNotIn("2026-11-19", self.recon._evaluated)
        self.assertNotIn("2026-11-20", self.recon._evaluated)
        # It closes in time: the younger days verdict normally (clean
        # here), and the aged day's mark is untouched -- write-once.
        self.apply(_at(21, 14), 1, 0, total_kwh=1000.0)
        self.tick(_at(22, 13))
        self.assertEqual(
            self.verdict_writes(),
            [("set", "history", "2026-11-18", {"gap_wh": None}, ["gap_wh"])],
        )
        self.assertIn("2026-11-21", self.recon._evaluated)
        self.assertIn("2026-11-19", self.recon._evaluated)

    def test_a_last_visit_read_failure_is_retried_after_the_window_rolls(self):
        # A read failure on a day's final window visit would strand it:
        # the next tick's window has moved past the day, nothing else
        # re-derives it, and its absence -- the clean verdict -- would
        # be a lie. The day is enrolled in the bounded retry set and
        # verdicted on the next day's tick once reads recover, with the
        # gap it carried all along.
        self.seed_marker()
        # The Nov 20 deferral shape, one day older: charging opens on
        # the 18th with the day doc ending 1000 Wh ahead of the basis.
        start = _at(18, 12)
        self.apply(start, 3, 0, total_kwh=1000.0)
        self.apply(start + timedelta(hours=1), 3, 1000, total_kwh=1001.0)
        self.apply(start + timedelta(hours=2), 3, 2000, total_kwh=1002.0)
        self.apply(start + timedelta(hours=3), 3, 3000, total_kwh=1004.0)
        self.tick(_at(20, 9))  # prime; the 18th at offset 2: deferred
        self.assertEqual(self.verdict_writes(), [])
        # Reads fail across the 18th's final local day in the window.
        self.db.fail_reads = True
        self.tick(_at(21, 9))
        self.db.fail_reads = False
        self.assertEqual(self.recon._revisit, {"2026-11-18"})
        self.assertNotIn("2026-11-18", self.recon._evaluated)
        self.assertNotIn("gap_wh", self.day_doc("2026-11-18") or {})
        self.assertTrue(
            any(
                "read failed for 2026-11-18" in line
                for line in self.verdict_lines()
            )
        )
        # The window has rolled and the session closed overnight: the
        # next day's tick retries the day presence-guarded and lands
        # the verdict it was owed all along.
        self.apply(_at(21, 6), 1, 3000, total_kwh=1004.0)
        self.tick(_at(22, 8))
        self.assertEqual(self.day_doc("2026-11-18")["gap_wh"], 1000.0)
        self.assertEqual(self.recon._revisit, set())
        self.assertEqual(
            len([w for w in self.verdict_writes() if w[2] == "2026-11-18"]), 1
        )

    def test_a_last_visit_verdict_write_failure_is_retried_after_the_window_rolls(self):
        # The enrollment covers the verdict-write arm of the failure
        # too: a write failing on the final visit strands a KNOWN
        # divergent day as verified-clean -- the worst silence -- so it
        # rides the same bounded retry and lands on the next day's
        # tick, exactly once.
        self.seed_marker()
        start = _at(18, 12)
        self.apply(start, 3, 0, total_kwh=1000.0)
        self.apply(start + timedelta(hours=1), 3, 1000, total_kwh=1001.0)
        self.apply(start + timedelta(hours=2), 3, 2000, total_kwh=1002.0)
        self.apply(start + timedelta(hours=3), 3, 3000, total_kwh=1004.0)
        self.tick(_at(20, 9))  # prime; the 18th deferred
        self.apply(_at(20, 23), 1, 3000, total_kwh=1004.0)  # closed
        original = self.recon._write_verdict
        failed = []

        def flaky_verdict(day, gap, *, day_wh, basis):
            if day == "2026-11-18" and not failed:
                failed.append(day)
                return False  # a transient single-document write failure
            return original(day, gap, day_wh=day_wh, basis=basis)

        with mock.patch.object(
            self.recon, "_write_verdict", side_effect=flaky_verdict
        ):
            self.tick(_at(21, 9))  # the 18th's last visit
        self.assertEqual(self.recon._revisit, {"2026-11-18"})
        self.assertNotIn("gap_wh", self.day_doc("2026-11-18") or {})
        # Reads and writes recovered: the retry lands the verdict.
        self.tick(_at(22, 8))
        self.assertEqual(self.day_doc("2026-11-18")["gap_wh"], 1000.0)
        self.assertEqual(self.recon._revisit, set())
        self.assertEqual(
            len([w for w in self.verdict_writes() if w[2] == "2026-11-18"]), 1
        )

    def test_a_revisited_day_still_overlapped_takes_the_unknown_mark(self):
        # The retry keeps the last-visit semantics: a session still open
        # over the enrolled day means no verdict is honest, so the
        # retry ages it out into the explicit unknown mark -- the same
        # horizon the in-window last visit enforces -- drained in the
        # same tick.
        self.seed_marker()
        self.apply(_at(18, 12), 3, 0, total_kwh=1000.0)
        self.seed_day("2026-11-18", 5.0)
        self.tick(_at(20, 9))  # prime; the 18th deferred
        self.db.fail_reads = True
        self.tick(_at(21, 9))  # the 18th's last visit fails to read
        self.db.fail_reads = False
        self.assertEqual(self.recon._revisit, {"2026-11-18"})
        # The session never closes: the retry cannot verdict the day,
        # so it takes the null mark instead of silence.
        self.tick(_at(22, 8))
        self.assertIsNone(self.day_doc("2026-11-18")["gap_wh"])
        self.assertEqual(self.recon._revisit, set())
        self.assertEqual(self.recon._unmarked_inexact, {})
        self.assertIn(
            ("set", "history", "2026-11-18", {"gap_wh": None}, ["gap_wh"]),
            self.verdict_writes(),
        )

    def test_a_revisit_expires_loudly_when_reads_never_recover(self):
        # The retry is bounded at one day past the window -- exactly how
        # long the live basis still guarantees the day -- because a
        # verdict derived from a trimmed basis would be permanently
        # wrong. Past the bound the day is dropped with a loud line
        # rather than written dishonestly.
        self.seed_marker()
        self.apply(_at(18, 12), 3, 0, total_kwh=1000.0)
        self.seed_day("2026-11-18", 5.0)
        self.tick(_at(20, 9))  # prime; the 18th deferred
        self.db.fail_reads = True
        self.tick(_at(21, 9))  # the 18th's last visit fails to read
        self.db.fail_reads = False
        self.assertEqual(self.recon._revisit, {"2026-11-18"})
        # No tick recovers within the grace day; the day after, the
        # entry is past the horizon and is dropped loudly, never
        # written -- the documented silence, not a dishonest verdict.
        self.tick(_at(23, 8))
        self.assertEqual(self.recon._revisit, set())
        self.assertEqual(
            [w for w in self.verdict_writes() if w[2] == "2026-11-18"], []
        )
        self.assertNotIn("gap_wh", self.day_doc("2026-11-18") or {})
        self.assertTrue(
            any(
                "left the retry horizon" in line and "2026-11-18" in line
                for line in self.verdict_lines()
            )
        )


class BackfillTests(ArchiveBase):
    """The one bounded first-run pass over the trailing window's history."""

    def test_first_run_backfills_the_known_intervals_short_days(self):
        # The live audit's known-bad days (Oct 22/31, Nov 1/13) each carry a
        # day doc with the full metered energy beside sessions whose
        # intervals lost almost all of it -- the Nov 1 shape: 7237 Wh in
        # ``wh`` with intervals carrying only 10 Wh. recon_from precedes
        # 2026-10-20 so all four get verdicts, and the pass stays bounded.
        self.assertLess(
            archive_reconcile.DEFAULT_RECON_FROM.isoformat(), "2026-10-20"
        )
        self.seed_day("2026-10-22", 4.806)
        self.seed_session(_at(22, 12, month=10), _at(22, 13, month=10), 4806.0, 11.0)
        self.seed_day("2026-10-23", 2.0)  # a clean day in range: no write
        self.seed_session(_at(23, 12, month=10), _at(23, 13, month=10), 2000.0, 2000.0)
        self.seed_day("2026-10-31", 9.712)
        self.seed_session(_at(31, 12, month=10), _at(31, 13, month=10), 9712.0, 12.0)
        self.seed_day("2026-11-01", 7.237)
        self.seed_session(_at(1, 12), _at(1, 13), 7237.0, 10.0)
        self.seed_day("2026-11-13", 12.044)
        self.seed_session(_at(13, 12), _at(13, 13), 12044.0, 44.0)
        expected = {
            "2026-10-22": 4795.0,
            "2026-10-31": 9700.0,
            "2026-11-01": 7227.0,
            "2026-11-13": 12000.0,
        }
        before = {
            day: dict(self.day_doc(day)) for day in expected if self.day_doc(day)
        }
        self.tick(_at(21, 10))
        for day, gap in expected.items():
            self.assertEqual(self.day_doc(day)["gap_wh"], gap, day)
            # The measurement fields are byte-identical: the verdict only
            # added its own field (the field-path isolation pin).
            self.assertEqual(self.day_doc(day)["kwh"], before[day]["kwh"], day)
            self.assertEqual(self.day_doc(day)["hours"], before[day]["hours"], day)
        self.assertEqual(
            self.db.data["history"][archive_reconcile.MARKER_DOC_ID],
            {"recon_from": "2026-10-19"},
        )
        # The write shapes, pinned: verdicts and marker are field-path
        # merges on exactly the reconciler's own fields.
        self.assertIn(
            ("set", "history", "2026-11-01", {"gap_wh": 7227.0}, ["gap_wh"]),
            self.verdict_writes(),
        )
        self.assertIn(
            (
                "set",
                "history",
                archive_reconcile.MARKER_DOC_ID,
                {"recon_from": "2026-10-19"},
                ["recon_from"],
            ),
            self.verdict_writes(),
        )
        _total, by_kind = self.recon.counter.snapshot()
        self.assertEqual(by_kind["history"], 5)  # four verdicts + the marker
        # A rerun writes nothing at all: every divergent day carries its
        # verdict, the clean day stays silent, the marker exists.
        writes_before = len(self.db.writes)
        self.tick(_at(21, 11))
        self.assertEqual(len(self.db.writes), writes_before)

    def test_a_day_already_carrying_a_verdict_is_never_rewritten(self):
        # Idempotence across processes: a day doc that already carries
        # gap_wh -- a number (a previous run's verdict) or null (its
        # unknown mark) -- is skipped by the backfill and by the window
        # evaluation alike -- absence is the only clean mark, so presence
        # must mean settled.
        self.seed_day("2026-11-01", 7.237)
        self.db.data["history"]["2026-11-01"]["gap_wh"] = 7000.0
        self.seed_session(_at(1, 12), _at(1, 13), 7237.0, 10.0)
        # The null arm of the same pin: a stored unknown mark settles the
        # backfill day exactly like a number, even though the recomputed
        # gap (9712 - 12) is nonzero.
        self.seed_day("2026-10-31", 9.712)
        self.db.data["history"]["2026-10-31"]["gap_wh"] = None
        self.seed_session(_at(31, 12, month=10), _at(31, 13, month=10), 9712.0, 12.0)
        self.tick(_at(4, 10))
        self.assertEqual(self.day_doc("2026-11-01")["gap_wh"], 7000.0)
        self.assertIsNone(self.day_doc("2026-10-31")["gap_wh"])
        self.assertEqual(
            [
                write
                for write in self.verdict_writes()
                if write[2] in ("2026-11-01", "2026-10-31")
            ],
            [],
        )

    def test_a_day_before_recon_from_never_receives_a_mark(self):
        # First run, an overnight session crossing the marker midnight:
        # its pre-marker part is outside the declared verdict range (days
        # before recon_from are legacy/unknown by design -- the marker
        # exists precisely to fence verdicts), so the unknown-mark queue
        # is clamped at the marker: no null write, and not even a
        # document, for that day. The day at/after the marker still gets
        # its explicit unknown mark.
        self.seed_day("2026-10-19", 2.0)
        self.seed_session(_at(18, 22, month=10), _at(19, 2, month=10), 4000.0, 4000.0)
        self.tick(_at(21, 9))
        # Nothing was written for the pre-marker day -- not even a
        # document (the mark write would have created one) -- while the
        # day at/after the marker got its explicit unknown mark.
        self.assertEqual(
            [w for w in self.verdict_writes() if w[2] == "2026-10-18"], []
        )
        self.assertIsNone(self.day_doc("2026-10-18"))
        self.assertIsNone(self.day_doc("2026-10-19")["gap_wh"])
        self.assertIn(
            ("set", "history", "2026-10-19", {"gap_wh": None}, ["gap_wh"]),
            self.verdict_writes(),
        )

    def test_a_failed_marker_write_retries_the_backfill_without_rewriting(self):
        # The marker lands only after a complete pass, so a marker failure
        # restarts the backfill -- which must converge without repeating a
        # single verdict write (days carrying gap_wh are skipped).
        self.seed_day("2026-11-01", 7.237)
        self.seed_session(_at(1, 12), _at(1, 13), 7237.0, 10.0)
        original = self.recon._write_marker
        failed = []

        def flaky_marker():
            if not failed:
                failed.append(True)
                return False
            return original()

        with mock.patch.object(self.recon, "_write_marker", side_effect=flaky_marker):
            self.tick(_at(21, 10))
        # The marker failed: the pass stays unprimed (the verdict itself
        # landed -- the day doc carries it -- and the retry must not
        # rewrite it).
        self.assertFalse(self.recon._primed)
        self.assertEqual(self.day_doc("2026-11-01")["gap_wh"], 7227.0)
        self.tick(_at(21, 11))
        self.assertTrue(self.recon._primed)
        self.assertIn(
            (
                "set",
                "history",
                archive_reconcile.MARKER_DOC_ID,
                {"recon_from": "2026-10-19"},
                ["recon_from"],
            ),
            self.verdict_writes(),
        )
        # Exactly one verdict write for the day across both passes.
        self.assertEqual(
            len([w for w in self.verdict_writes() if w[2] == "2026-11-01"]), 1
        )

    def test_a_failed_backfill_verdict_write_withholds_the_marker(self):
        # The marker lands only after a complete pass, and complete means
        # every verdict landed: a single failed verdict write must abort
        # the pass before the marker, or the day is stranded -- outside
        # the tick window, below a backfill that will never re-run -- and
        # its absence is the clean verdict, so a real divergence would
        # read as verified-clean forever. The retry re-runs the idempotent
        # pass (days carrying gap_wh are skipped), so exactly the missing
        # verdict lands, then the marker.
        self.seed_day("2026-10-22", 4.806)
        self.seed_session(_at(22, 12, month=10), _at(22, 13, month=10), 4806.0, 11.0)
        self.seed_day("2026-11-01", 7.237)
        self.seed_session(_at(1, 12), _at(1, 13), 7237.0, 10.0)
        original = self.recon._write_verdict
        failed = []

        def flaky_verdict(day, gap, *, day_wh, basis):
            if day == "2026-11-01" and not failed:
                failed.append(day)
                return False  # a transient single-document write failure
            return original(day, gap, day_wh=day_wh, basis=basis)

        with mock.patch.object(
            self.recon, "_write_verdict", side_effect=flaky_verdict
        ):
            self.tick(_at(21, 10))
        # The pass aborted before the marker: unprimed, no marker document
        # and no verdict for the failed day -- while the day whose write
        # landed carries its verdict (the retry must not rewrite it).
        self.assertFalse(self.recon._primed)
        self.assertNotIn(
            archive_reconcile.MARKER_DOC_ID, self.db.data.get("history", {})
        )
        self.assertNotIn("gap_wh", self.day_doc("2026-11-01"))
        self.assertEqual(self.day_doc("2026-10-22")["gap_wh"], 4795.0)
        # The clean retry converges: the missing verdict, then the marker.
        self.tick(_at(21, 11))
        self.assertTrue(self.recon._primed)
        self.assertEqual(self.day_doc("2026-11-01")["gap_wh"], 7227.0)
        self.assertEqual(
            self.db.data["history"][archive_reconcile.MARKER_DOC_ID],
            {"recon_from": "2026-10-19"},
        )
        # Exactly one verdict write per day across both passes.
        self.assertEqual(
            len([w for w in self.verdict_writes() if w[2] == "2026-10-22"]), 1
        )
        self.assertEqual(
            len([w for w in self.verdict_writes() if w[2] == "2026-11-01"]), 1
        )

    def test_a_failed_prime_still_drains_the_queued_unknown_marks(self):
        # A first run whose marker write fails has already queued the
        # straddle-touched days for their explicit unknown marks; the
        # retrying prime must not hold them hostage until it fully
        # succeeds -- their absence would read as the clean verdict
        # downstream, and the drain's writes fail just as
        # harmlessly-retried during whatever is failing the marker.
        self.seed_day("2026-11-19", 2.0)
        self.seed_day("2026-11-20", 2.0)
        self.seed_session(_at(19, 22), _at(20, 2), 4000.0, 4000.0)
        # The stored interval predates this process (the restart fence).
        self.recon._started_at = _at(20, 12)
        original = self.recon._write_marker
        failed = []

        def flaky_marker():
            if not failed:
                failed.append(True)
                return False
            return original()

        with mock.patch.object(self.recon, "_write_marker", side_effect=flaky_marker):
            self.tick(_at(21, 9))
        # Unprimed -- but the queued unknown marks landed anyway, and
        # the queue is empty.
        self.assertFalse(self.recon._primed)
        self.assertIsNone(self.day_doc("2026-11-19")["gap_wh"])
        self.assertIsNone(self.day_doc("2026-11-20")["gap_wh"])
        self.assertEqual(self.recon._unmarked_inexact, {})
        # The retry completes the prime; the marks are write-once.
        self.tick(_at(21, 10))
        self.assertTrue(self.recon._primed)
        self.assertEqual(
            len([w for w in self.verdict_writes() if w[2] == "2026-11-19"]), 1
        )


class RestartTests(ArchiveBase):
    """The trailing window recomputes from day docs + one sessions read."""

    def test_restart_recovers_the_day_just_past_the_trailing_window(self):
        # A final-visit read/write failure enrolls the oldest window day in
        # the process-local revisit set.  If the bridge restarts before the
        # next tick, that set disappears; the restart prime must therefore
        # cover exactly the one-day retry horizon as well as the ordinary
        # trailing window, reseed its exact basis, and reconsider the day.
        self.seed_marker()
        self.seed_day("2026-11-18", 4.0)
        self.seed_session(_at(18, 12), _at(18, 15), 4000.0, 3000.0)
        self.recon._started_at = _at(19, 8)

        # On Nov 22 the 18th is one day past the three-day window: without
        # restart recovery it is neither read nor considered, so its missing
        # 1000 Wh remains indistinguishable from a verified-clean day.
        self.tick(_at(22, 9))

        self.assertEqual(self.day_doc("2026-11-18")["gap_wh"], 1000.0)
        self.assertEqual(self.recon._revisit, set())
        with self.sink._lock:
            self.assertEqual(
                self.recon.basis.basis_for_day("2026-11-18"), 3000.0
            )
        self.assertEqual(
            [w for w in self.verdict_writes() if w[2] == "2026-11-18"],
            [("set", "history", "2026-11-18", {"gap_wh": 1000.0}, ["gap_wh"])],
        )

    def test_the_restart_retry_horizon_never_gets_an_approximate_verdict(self):
        # The retry-horizon enrollment is exactness-guarded: a straddling
        # stored interval makes the horizon day's rebuilt basis the
        # constant-power approximation, and ``_consider_day`` recomputes
        # without consulting ``_inexact`` -- so the ``_inexact`` test at the
        # enrollment site is the sole barrier between that approximation and
        # a numeric verdict, which is written once and therefore permanent.
        self.seed_marker()
        # The 17th's doc is 3000 Wh against the straddler's 2000 Wh duration
        # share, so the approximation's gap is a nonzero +1000 Wh: removing
        # the guard writes a number that a behavioral assertion can see.
        self.seed_day("2026-11-17", 3.0)
        self.seed_day("2026-11-18", 2.0)
        self.seed_session(_at(16, 22), _at(17, 2), 4000.0, 4000.0)
        self.recon._started_at = _at(20, 12)

        # On Nov 21 the retry horizon is the 17th (start = today - (3 + 1)),
        # and the straddler's before-side is pre-range, so the 17th is the
        # one inexact day the horizon could have re-enrolled.
        considered = []
        original = self.recon._consider_day

        def recording(day, *args, **kwargs):
            considered.append(day)
            return original(day, *args, **kwargs)

        with mock.patch.object(self.recon, "_consider_day", recording):
            self.tick(_at(21, 9))

        # The outcome: the archive keeps only the explicit unknown mark,
        # never the approximation's +1000 Wh.
        self.assertIn("2026-11-17", self.recon._inexact)
        self.assertNotIn("2026-11-17", self.recon._revisit)
        self.assertIsNone(self.day_doc("2026-11-17")["gap_wh"])
        self.assertEqual(
            [w for w in self.verdict_writes() if w[2] == "2026-11-17"],
            [("set", "history", "2026-11-17", {"gap_wh": None}, ["gap_wh"])],
        )
        # No numeric verdict for the day, at any point in the tick.
        self.assertEqual(
            [
                w
                for w in self.verdict_writes()
                if w[2] == "2026-11-17"
                and isinstance(w[3].get("gap_wh"), (int, float))
            ],
            [],
        )
        # Defence in depth: the guard's mechanism, which is what produces
        # the outcome above.
        self.assertNotIn("2026-11-17", considered)
        # The before-side day is before ``start``: the presence guard is
        # blind to a document the prime never read, so the queue must skip
        # it rather than blind-null whatever verdict it stores.
        self.assertEqual(
            [w for w in self.verdict_writes() if w[2] == "2026-11-16"], []
        )

    def collection_counter(self):
        counts = {}
        original = self.db.collection

        def counting(name):
            counts[name] = counts.get(name, 0) + 1
            return original(name)

        return counts, counting

    def test_a_restart_recomputes_the_window_with_one_sessions_read(self):
        # A clean intraday block on the 18th and one block across the
        # Nov 19/20 midnight, both verdicted by the live process (no
        # writes). The restart rebuilds the trailing window from the stored
        # intervals with one bounded range read: the intraday day re-
        # verdicts clean from the rebuilt basis, while the straddle-touched
        # days -- whose rebuilt basis is the constant-power approximation,
        # not the per-tick truth -- get no verdict rather than an
        # approximate one (a verdict is written once, so it is exact or
        # absent).
        self.seed_marker()
        self.tick(_at(18, 9))
        self.charge_block(_at(18, 12), hours=3, wh_per_hour=1000)
        self.charge_block(_at(19, 22), hours=4, wh_per_hour=1000)
        self.tick(_at(20, 9))
        self.assertEqual(self.verdict_writes(), [])
        # -- the restart: a new tracker and reconciler over the same db.
        restarted = archive_reconcile.ArchiveReconciler(
            self.db, counter=WriteCounter(clock=lambda: self.mono)
        )
        restarted._started_at = _at(21, 8)
        tracker = archive_reconcile.SessionBasisTracker(self.db, basis=restarted.basis)
        tracker.seeded = True
        tracker.total_energy = self.total_kwh
        sink = bridge.StatusSink(self.db, tracker, _QuietNotifier())
        counts, counting = self.collection_counter()
        with (
            mock.patch.object(bridge, "_localnow", return_value=_at(21, 9)),
            mock.patch.object(self.db, "collection", counting),
        ):
            restarted.tick(_at(21, 9), sink)
        with sink._lock:
            # The rebuilt basis: the intraday day whole, the straddling
            # block split by duration share (uniform here).
            self.assertEqual(restarted.basis.basis_for_day("2026-11-18"), 3000.0)
            self.assertEqual(restarted.basis.basis_for_day("2026-11-19"), 2000.0)
            self.assertEqual(restarted.basis.basis_for_day("2026-11-20"), 2000.0)
        self.assertIn("2026-11-18", restarted._evaluated)
        self.assertNotIn("2026-11-18", restarted._inexact)
        # The straddle-touched days carry an explicit unknown mark instead
        # of a verdict: their absence would read as verified clean
        # downstream (the three-state contract), so the mark is not
        # optional -- and it lands even though the rebuild's basis for
        # them is the approximation the verdict must never use.
        self.assertIn("2026-11-19", restarted._inexact)
        self.assertIn("2026-11-20", restarted._inexact)
        self.assertIsNone(self.day_doc("2026-11-19")["gap_wh"])
        self.assertIsNone(self.day_doc("2026-11-20")["gap_wh"])
        self.assertEqual(
            self.verdict_writes(),
            [
                ("set", "history", "2026-11-19", {"gap_wh": None}, ["gap_wh"]),
                ("set", "history", "2026-11-20", {"gap_wh": None}, ["gap_wh"]),
            ],
        )
        # The bounded recompute: one sessions range read; the marker read
        # plus one day-doc range in the prime, one get for the one
        # exactly-attributable in-window candidate day, one presence-guarded
        # get for the restart retry-horizon day, plus the two unknown marks.
        self.assertEqual(counts["sessions"], 1)
        self.assertEqual(counts["history"], 6)
        # Steady state after that: a further tick reads and writes nothing.
        counts2, counting2 = self.collection_counter()
        with mock.patch.object(self.db, "collection", counting2):
            restarted.tick(_at(21, 10), sink)
        self.assertNotIn("history", counts2)
        self.assertNotIn("sessions", counts2)

    def test_the_restart_reseed_holds_the_sinks_apply_lock(self):
        # The reseed is the one accumulator mutation issued off the status
        # thread: ``observe`` mutates the same ``_by_day`` dict under the
        # sink's apply lock on the status thread, so an unlocked seed
        # could interleave its read-modify-write with one and drop a
        # day's basis -- a corrupted verdict, written once and therefore
        # permanently wrong. Pin: every seed the prime issues observes
        # the lock already held (a plain Lock's non-blocking acquire
        # succeeds only when nothing holds it).
        self.seed_marker()
        self.seed_day("2026-11-18", 3.0)
        self.seed_session(_at(18, 12), _at(18, 15), 3000.0, 3000.0)
        self.recon._started_at = _at(18, 16)
        sink = self.sink
        original = self.recon.basis.seed
        seeded = []

        def probing_seed(day, wh):
            grabbed = sink._lock.acquire(blocking=False)
            try:
                self.assertFalse(
                    grabbed, f"reseed of {day} ran without the apply lock"
                )
            finally:
                if grabbed:
                    sink._lock.release()
            seeded.append(day)
            return original(day, wh)

        with mock.patch.object(self.recon.basis, "seed", probing_seed):
            self.tick(_at(19, 9))
        # The window really reseeded from the stored interval, under the
        # lock throughout.
        self.assertIn("2026-11-18", seeded)
        with sink._lock:
            self.assertEqual(self.recon.basis.basis_for_day("2026-11-18"), 3000.0)

    def test_a_restart_does_not_requeue_an_already_null_marked_day(self):
        # Write-once across processes, null arm: a straddle-touched day
        # the previous process already marked ``gap_wh: null`` is settled
        # -- presence, not number-ness, is the test -- so this process's
        # prime must not re-queue it for the mark drain, and no history
        # write happens at all.
        self.seed_marker()
        self.seed_day("2026-11-19", 2.0)
        self.seed_day("2026-11-20", 2.0)
        self.db.data["history"]["2026-11-19"]["gap_wh"] = None
        self.db.data["history"]["2026-11-20"]["gap_wh"] = None
        self.seed_session(_at(19, 22), _at(20, 2), 4000.0, 4000.0)
        self.recon._started_at = _at(20, 12)
        self.tick(_at(21, 9))
        # Still known-inexact to this process -- just nothing left to write.
        self.assertIn("2026-11-19", self.recon._inexact)
        self.assertNotIn("2026-11-19", self.recon._unmarked_inexact)
        self.assertNotIn("2026-11-20", self.recon._unmarked_inexact)
        self.assertEqual(self.verdict_writes(), [])
        self.assertIsNone(self.day_doc("2026-11-19")["gap_wh"])
        self.assertIsNone(self.day_doc("2026-11-20")["gap_wh"])

    def test_a_pre_start_verdict_survives_a_start_straddle(self):
        # The mirror of the pre-marker clamp: on a restart the prime reads
        # day docs only over [start, today) -- start = max(marker,
        # today - (window_days + 1)), the trailing window widened by its
        # one-day retry horizon -- so a stored interval straddling the
        # start midnight touches a day whose document was never read. The
        # presence guard cannot see that day's stored verdict (docs.get(day)
        # is None by construction), so the unknown-mark queue must be
        # bounded at the read range's start, which subsumes the marker
        # bound: the pre-start day's numeric verdict survives a start
        # straddle restart intact -- no blind null write, ever (a mark is
        # write-once, so the overwrite would be permanent). The bound still
        # matters with the widened start: the straddler crossing the
        # (start - 1)/start midnight is read from the sessions archive even
        # though its before-side day is pre-range, so the horizon day is
        # reconsidered while the before-side day must stay untouched.
        self.seed_marker()
        self.seed_day("2026-11-16", 3.0)
        self.db.data["history"]["2026-11-16"]["gap_wh"] = 5000.0
        self.seed_day("2026-11-17", 2.0)
        self.seed_session(_at(16, 22), _at(17, 2), 4000.0, 4000.0)
        self.recon._started_at = _at(20, 12)
        self.tick(_at(21, 9))
        # start = 2026-11-17 (today - (3 + 1)): the 16th was never read,
        # never queued, never written -- the previous process's verdict on
        # it is intact.
        self.assertEqual(
            [w for w in self.verdict_writes() if w[2] == "2026-11-16"], []
        )
        self.assertNotIn("2026-11-16", self.recon._unmarked_inexact)
        self.assertEqual(self.day_doc("2026-11-16")["gap_wh"], 5000.0)
        # The in-range straddle-touched day still gets its unknown mark.
        self.assertIn("2026-11-17", self.recon._inexact)
        self.assertEqual(
            self.verdict_writes(),
            [("set", "history", "2026-11-17", {"gap_wh": None}, ["gap_wh"])],
        )
        self.assertIsNone(self.day_doc("2026-11-17")["gap_wh"])

    def test_a_delayed_prime_does_not_double_count_this_process_sessions(self):
        # The reseed only takes intervals closed at or before the process
        # started: a block this process observed live (and wrote on close)
        # is already in the live basis -- seeding its stored form again
        # would double the day and verdict a false gap.
        self.seed_marker()
        self.charge_block(_at(20, 12), hours=3, wh_per_hour=1000)
        # No tick yet: the prime is delayed past the block (a slow first
        # cadence, or the first reads failed and retried).
        self.tick(_at(21, 9))
        self.assertEqual(self.verdict_writes(), [])
        self.assertEqual(self.verdict_lines(), [])
        with self.sink._lock:
            self.assertEqual(self.recon.basis.basis_for_day("2026-11-20"), 3000.0)

    def test_straddle_touched_days_carry_an_explicit_unknown_mark(self):
        # Absence is the clean verdict's own mark, so a day this process
        # cannot attribute exactly (a stored interval straddles its
        # midnight) must not be silently absent -- a restart mid-charge can
        # lose the open interval, and the straddle-touched day is exactly
        # where a real gap hides. It carries gap_wh null; a failed mark
        # write retries next tick (the one silence this module must not
        # keep); and the mark is write-once like every verdict.
        self.seed_marker()
        self.seed_day("2026-11-19", 2.0)
        self.seed_day("2026-11-20", 2.0)
        self.seed_session(_at(19, 22), _at(20, 2), 4000.0, 4000.0)
        # The stored interval predates this process (the restart fence).
        self.recon._started_at = _at(20, 12)
        self.db.fail_writes = True
        self.tick(_at(21, 9))
        self.assertIn("2026-11-19", self.recon._inexact)
        self.assertIn("2026-11-20", self.recon._inexact)
        self.assertNotIn("gap_wh", self.day_doc("2026-11-19"))
        self.db.fail_writes = False
        self.tick(_at(21, 10))
        self.assertIsNone(self.day_doc("2026-11-19")["gap_wh"])
        self.assertIsNone(self.day_doc("2026-11-20")["gap_wh"])
        self.assertIn(
            ("set", "history", "2026-11-19", {"gap_wh": None}, ["gap_wh"]),
            self.verdict_writes(),
        )
        # Write-once: a further tick writes nothing at all.
        writes_before = len(self.db.writes)
        self.tick(_at(21, 11))
        self.assertEqual(len(self.db.writes), writes_before)


class MidnightCancellationTests(ArchiveBase):
    """The Nov 15-19 shape: one 48 kWh session spanning four days."""

    def test_every_spanned_day_reconciles_to_a_zero_verdict(self):
        # The real live shape: nightly scheduled blocks on a plug-in that
        # stays connected, merging into ONE session record spanning
        # 2026-11-15 through 2026-11-18 -- 48 kWh across four days, one
        # block straddling the Nov 17/18 midnight. Every spanned day
        # reconciles to exactly zero (both sides attribute each tick to the
        # day it was observed in), so no verdict is written anywhere.
        self.seed_marker()
        self.tick(_at(15, 9))
        self.charge_block(_at(15, 12), hours=4, wh_per_hour=3000)  # 12 kWh
        self.charge_block(_at(16, 12), hours=4, wh_per_hour=3000)  # 12 kWh
        self.charge_block(_at(17, 22), hours=4, wh_per_hour=3000)  # straddles
        self.charge_block(_at(18, 14), hours=4, wh_per_hour=3000)  # 12 kWh
        # One merged record: the whole plug-in, four intervals, 48 kWh.
        sessions = self.db.data.get("sessions", {})
        self.assertEqual(len(sessions), 1)
        (record,) = sessions.values()
        self.assertEqual(record["started_at"], _at(15, 12))
        self.assertEqual(record["ended_at"], _at(18, 18))
        self.assertEqual(record["wh"], 48000.0)
        self.assertEqual(len(record["intervals"]), 4)
        # Daily cadence ticks from the day after the first block.
        for day in (16, 17, 18, 19, 20):
            self.tick(_at(day, 9))
        self.assertEqual(self.verdict_writes(), [])
        self.assertEqual(self.verdict_lines(), [])
        # The per-day split both sides hold, exactly: the 22:00-02:00 block
        # gives the 17th its 23:00 tick (3 kWh) and the 18th the rest.
        expected = {
            "2026-11-15": 12.0,
            "2026-11-16": 12.0,
            "2026-11-17": 3.0,
            "2026-11-18": 21.0,
        }
        for day, kwh in expected.items():
            self.assertEqual(self.day_doc(day)["kwh"], kwh, day)
            self.assertNotIn("gap_wh", self.day_doc(day), day)


class MidChargeRestartLossTests(ArchiveBase):
    """The Nov 1 class disclosed on the live path: wh kept, intervals short."""

    def test_a_mid_charge_restarts_intervals_are_disclosed_as_the_gap(self):
        # A bridge restart mid-charge keeps the record's wh whole (the
        # charger's cumulative) but its intervals carry only the
        # post-restart block -- the sessions archive is short exactly the
        # pre-restart energy the day doc still holds. The verdict discloses
        # that as the raw delta; nothing is corrected.
        self.seed_marker()
        self.tick(_at(19, 9))
        # -- the first process: two observed hours, flushed by the hour
        # rollover, then it dies mid-block.
        self.apply(_at(19, 12), 3, 0, total_kwh=1000.0)
        self.apply(_at(19, 13), 3, 3000, total_kwh=1003.0)
        self.apply(_at(19, 14), 3, 6000, total_kwh=1006.0)
        self.assertEqual(self.day_doc("2026-11-19")["kwh"], 6.0)
        # -- the restart: a new tracker seeds off the stored total and opens
        # its own interval; the charger's cumulative keeps counting.
        restarted = archive_reconcile.ArchiveReconciler(
            self.db, counter=WriteCounter(clock=lambda: self.mono)
        )
        restarted._started_at = _at(19, 14, 30)
        tracker = archive_reconcile.SessionBasisTracker(self.db, basis=restarted.basis)
        tracker.seeded = True
        tracker.total_energy = 1006.0
        sink = bridge.StatusSink(self.db, tracker, _QuietNotifier())
        # From here the scenario's applies drive the restarted process.
        self.tracker = tracker
        self.apply(_at(19, 15), 3, 6000, total_kwh=1006.0)  # baseline only
        self.apply(_at(19, 16), 3, 7000, total_kwh=1007.0)
        self.apply(_at(19, 16), 1, 7000, total_kwh=1007.0)
        (record,) = self.db.data.get("sessions", {}).values()
        self.assertEqual(record["wh"], 7000.0)
        (interval,) = record["intervals"]
        self.assertEqual(interval["wh"], 1000.0)
        with mock.patch.object(bridge, "_localnow", return_value=_at(20, 9)):
            restarted.tick(_at(20, 9), sink)
        (write,) = [
            w
            for w in self.db.writes
            if w[1] == "history" and archive_reconcile.GAP_FIELD in (w[3] or {})
        ]
        self.assertEqual(
            write,
            ("set", "history", "2026-11-19", {"gap_wh": 6000.0}, ["gap_wh"]),
        )
        # The day doc's measurements are untouched beside the verdict.
        self.assertEqual(self.day_doc("2026-11-19")["kwh"], 7.0)


class WriteBudgetTests(ArchiveBase):
    """Steady state: all clean, all finalized -- zero writes per tick."""

    def test_clean_steady_state_ticks_are_write_free(self):
        self.seed_marker()
        self.tick(_at(18, 9))
        self.charge_block(_at(18, 12), hours=3, wh_per_hour=1000)
        self.tick(_at(19, 9))
        writes_before = len(self.db.writes)
        for hour in (10, 11, 12):
            self.tick(_at(19, hour))
        self.assertEqual(len(self.db.writes), writes_before)
        self.assertEqual(self.verdict_lines(), [])

    def test_the_verdict_write_is_isolated_to_its_field_path(self):
        # A verdict lands beside a two-bucket day doc: kwh, both hour
        # buckets and updated_at are byte-identical after it, and the write
        # itself names exactly ["gap_wh"] -- the merge cannot reach any
        # other field, by construction and by pin.
        self.seed_marker()
        self.tick(_at(18, 9))
        self.apply(_at(18, 12), 3, 0, total_kwh=1000.0)
        self.apply(_at(18, 13), 3, 1000, total_kwh=1001.0)
        self.apply(_at(18, 14), 3, 2000, total_kwh=1003.0)
        self.apply(_at(18, 14), 1, 2000, total_kwh=1003.0)
        before = dict(self.day_doc("2026-11-18"))
        self.tick(_at(19, 9))
        after = self.day_doc("2026-11-18")
        self.assertEqual(after["kwh"], before["kwh"])
        self.assertEqual(after["hours"], before["hours"])
        self.assertEqual(after["updated_at"], before["updated_at"])
        self.assertEqual(after["gap_wh"], 1000.0)
        (write,) = [
            w
            for w in self.db.writes
            if w[2] == "2026-11-18" and archive_reconcile.GAP_FIELD in (w[3] or {})
        ]
        self.assertEqual(write[4], ["gap_wh"])
        self.assertEqual(write[3].keys(), {"gap_wh"})


class LoopWiringTests(unittest.TestCase):
    """Seam B rides the seam-A loop: same cadence, after it, never blocked."""

    def setUp(self):
        self.logs = []
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_seam_b_runs_even_while_seam_a_is_inactive(self):
        # A charger with no period counters (firmware below 4.2.2) makes
        # seam A log its inactive line and stop; seam B still runs -- it
        # needs no counters, only the tracker and the archive.
        db = FakeDB()
        tracker = bridge.StatusTracker(db)
        tracker.seeded = True
        sink = bridge.StatusSink(db, tracker, _QuietNotifier())
        counter = bridge.ChargerDayCounter()
        counter.note(None)  # fed, but no usable total_day ever
        archive = mock.Mock()
        when = _at(21, 9)
        with (
            mock.patch.object(bridge, "_localnow", return_value=when),
            mock.patch.object(bridge, "_stop", _StopAfter(1)),
        ):
            bridge.reconcile_loop(
                db,
                sink,
                counter,
                bridge.DayReconciler(),
                3600.0,
                archive_reconciler=archive,
            )
        archive.tick.assert_called_once_with(when, sink)
        self.assertTrue(
            any("day reconciliation inactive" in line for line in self.logs)
        )

    def test_run_threads_the_archive_reconciler_into_the_loop(self):
        started = []

        class RecordingThread:
            def __init__(self, target, args=(), kwargs=None, **_options):
                self.target = target
                self.kwargs = kwargs or {}
                started.append(self)

            def start(self):
                pass

            def join(self, timeout=None):
                pass  # the reconcile loop's bounded shutdown join (#161)

        with (
            mock.patch.object(bridge.threading, "Thread", RecordingThread),
            mock.patch.object(bridge, "StatusSink"),
            mock.patch.object(bridge, "command_loop"),
            mock.patch.object(bridge, "MqttSource", return_value=mock.Mock()),
        ):
            bridge.run(
                FakeDB(),
                bridge.ChargerHost("charger"),
                None,
                (10, 60, 60, 3600, 5, 60, 300),
                object(),
                bridge.WatchdogConfig(enabled=False),
                reconcile=bridge.ReconcileConfig(3600),
            )
        (thread,) = [t for t in started if t.target.__name__ == "reconcile_loop"]
        self.assertIsInstance(
            thread.kwargs["archive_reconciler"], archive_reconcile.ArchiveReconciler
        )

    def test_the_run_tracker_is_the_session_basis_tracker(self):
        # run() builds the SessionBasisTracker so the live deltas feed the
        # archive reconciler's basis (patched here to observe construction).
        with mock.patch.object(
            bridge, "SessionBasisTracker"
        ) as tracker, mock.patch.object(
            bridge, "StatusSink"
        ), mock.patch.object(
            bridge.threading, "Thread"
        ), mock.patch.object(
            bridge, "command_loop"
        ):
            bridge.run(
                FakeDB(),
                bridge.ChargerHost("charger"),
                None,
                (10, 60, 60, 3600, 5, 60, 300),
                object(),
                bridge.WatchdogConfig(enabled=False),
                reconcile=bridge.ReconcileConfig(3600),
            )
        (call_args, call_kwargs) = tracker.call_args
        self.assertIsInstance(
            call_kwargs["basis"], archive_reconcile.SessionBasisAccumulator
        )


class AttributionTests(unittest.TestCase):
    """The stored-interval split: whole inside a day, pro-rated across."""

    def test_an_intraday_interval_lands_whole_on_its_day(self):
        parts = archive_reconcile.attribute_interval(
            _at(19, 12), _at(19, 16), 4000.0, UTC
        )
        self.assertEqual(parts, {"2026-11-19": 4000.0})

    def test_a_straddling_interval_splits_by_duration_share(self):
        parts = archive_reconcile.attribute_interval(
            _at(19, 22), _at(20, 2), 4000.0, UTC
        )
        self.assertEqual(parts, {"2026-11-19": 2000.0, "2026-11-20": 2000.0})

    def test_a_multi_day_interval_splits_at_every_midnight(self):
        parts = archive_reconcile.attribute_interval(
            _at(18, 12), _at(21, 12), 7200.0, UTC
        )
        self.assertEqual(
            parts,
            {
                "2026-11-18": 1200.0,
                "2026-11-19": 2400.0,
                "2026-11-20": 2400.0,
                "2026-11-21": 1200.0,
            },
        )
