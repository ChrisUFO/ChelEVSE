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
from fakes import FakeDB  # noqa: E402
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
        self._last_when = when
        self.boot += step
        self.mono += step
        self.total_kwh = total_kwh
        elapsed = max(0, int((when - _at(15, 8)).total_seconds()))
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
