"""The sessions-archive reconciler (issue #212, PR-3): seam B of the chain.

Seam A (:mod:`reconcile`) compares the charger's own period counters with the
``history/{date}`` day documents and never looks at ``sessions`` -- session
layer loss is invisible to it. This module adds the second link: per-day
day-doc totals compared with the sessions archive on the *same observation
basis* the tracker's interval list holds (the allowed per-tick
``session_energy`` deltas), so a day whose intervals lost energy is disclosed
even when the charger-side meters agree.

**The charter, amended for the two-seam world (#212): detection never
corrects; the verdict only discloses.** No measurement field -- ``kwh``,
``hours``, a session's ``wh``, ``elapsed`` or ``intervals`` -- is ever
rewritten, corrected or backfilled by either seam. The only writes this
module ever makes are its own additive disclosure metadata on field paths it
owns: ``gap_wh`` and ``recon_from`` (the date verdicts start; days before it
are legacy/unknown). Both land as field-path merges that cannot touch any
other field, and both are counted in the write counter's ``history`` kind
with the repo's write budget (#96): one write per divergent day, once ever,
plus the one marker write on the first run -- ~zero steady-state writes.

``gap_wh`` is three-state, and the states are the read contract: a **number**
is the raw per-day delta (Wh, signed day-doc-minus-sessions); **null** marks
a day this module cannot verdict honestly (a stored interval straddles its
midnight, so the attribution would be the constant-power approximation --
unknown, not verified clean); **absent** for a day at or after ``recon_from``
means evaluated clean. A restart mid-charge can lose the open interval (the
documented in-memory limitation), so the straddle-touched day is exactly
where a real gap can hide -- its null mark keeps the silence impossible.

A day's verdict is **deferred until final**: it is computed only once no open
charging session overlaps the day (checked against the tracker's open
interval, bounded by the ~3-day trailing window versus the 48 h merge cap),
because that is the moment the session's intervals exist in the archive in
their final form. Until then the day is left alone -- an open session's
energy is still moving. The verdict itself is exact: ``gap_wh`` is the raw
same-basis delta with **no tolerance band** (the band rule stays seam A's);
a session straddling midnight cancels precisely because both sides attribute
each tick's delta to the local day it was observed in. Exactness is also why
a restart's recomputed window verdicts only the days it can attribute
exactly: a stored interval that straddles a midnight can only be split by
the constant-power approximation, so every day it touches gets no verdict
from that process rather than an approximate one -- written once means
exact or absent.

The loop lives in ``bridge.reconcile_loop`` (seam B runs after seam A on the
same cadence, reading only except for its own verdict writes, never blocking
the status path); this module is the core plus the restart recompute,
unit-testable with neither Firestore nor a charger.
"""

from datetime import date, datetime, time, timedelta, timezone

from firebase_admin import firestore

from parsing import _is_number
from status_tracker import StatusTracker, _usable_interval
from write_counter import WriteCounter

# Verdicts start here on a fresh install: precedes 2026-10-20, so the known
# intervals-short days (Oct 22/31, Nov 1/13 -- the live audit of 2026-11-21)
# get verdicts from the one bounded first-run backfill while staying inside
# its single pass. Days before the marker are legacy/unknown by design.
DEFAULT_RECON_FROM = date(2026, 10, 19)
# The first run backfills verdicts over at most this many trailing days (one
# bounded pass: one day-document range query plus one sessions range read).
BACKFILL_WINDOW_DAYS = 60
# How far back a day may still receive its verdict. A charging block gap
# beyond 48 h starts a new session record (SESSION_MERGE_MAX_GAP), so an
# open session stops overlapping a past day well inside three days; a day
# older than this that is still overlapped (a pathological multi-day
# continuous block) is left unevaluated rather than verdicted from a basis
# the archive has not settled.
TRAILING_WINDOW_DAYS = 3
# The disclosure fields this module owns, on the documents it verdicts.
GAP_FIELD = "gap_wh"
RECON_FROM_FIELD = "recon_from"
# One marker document in ``history`` carrying ``recon_from``. The id is
# underscore-led on purpose: documentId range queries over ``YYYY-MM-DD``
# bounds are digit-led, so the marker can never fall inside a month range.
MARKER_DOC_ID = "_reconciliation"


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only

    return bridge.log(message)


def _localnow():
    # seam: tests patch bridge._localnow (PLAN.md facade rule)
    import bridge  # lazy, call-time only

    return bridge._localnow()


def _utcnow():
    # seam: tests patch bridge._utcnow (PLAN.md facade rule)
    import bridge  # lazy, call-time only

    return bridge._utcnow()


class SessionBasisAccumulator:
    """Per-day session-basis Wh, from the same applied observations.

    The session-basis twin of :class:`history_accumulator
    .HistoryAccumulator`: where that accumulates the validated
    ``total_energy`` deltas behind a day document's ``kwh``, this accumulates
    the validated ``session_energy`` deltas behind a day's interval energy --
    the same allowed steps ``StatusTracker._track_interval`` attributes, at
    the same instants, so the two sides of the seam-B comparison share one
    attribution rule and midnight-boundary artifacts cancel exactly (a
    session straddling midnight attributes each tick's delta to the local
    day it was observed in, on both sides).

    Everything here is in-memory and apply-locked: mutations run inside the
    tracker (under the status sink's apply lock, like every accumulator
    touchpoint), so readers take the same lock -- the
    ``HistoryAccumulator.pending_for_day`` accessor pattern. On restart the
    trailing window is reseeded from the stored ``sessions`` intervals by
    :class:`ArchiveReconciler` (one bounded range read).
    """

    def __init__(self, keep_days=TRAILING_WINDOW_DAYS + 2):
        # ISO day -> session-basis Wh observed that day.
        self._by_day = {}
        self._keep_days = keep_days

    def observe(self, delta, moment):
        """Attribute one allowed session delta to the local day of its tick.

        Mirrors ``HistoryAccumulator.observe`` (the caller holds the apply
        lock; the delta is already validated by the tracker).
        """
        if not delta:
            return
        day = moment.date().isoformat()
        self._by_day[day] = self._by_day.get(day, 0.0) + float(delta)
        self.trim(moment.date())

    def seed(self, day, wh):
        """Add restart-recomputed basis for one day (idempotent per process).

        The prime pass calls this only once per run, under the sink's apply
        lock -- ``seed`` is the one accumulator mutation issued off the
        status thread, and ``observe`` mutates the same dict under that
        lock, so the two read-modify-writes must not interleave. Calls land
        after every read and write this depends on, so a retried prime
        cannot double count. Additive on purpose: ``today`` may already hold
        live ticks observed since the process started, and the reseeded
        intervals are the pre-start closed blocks -- disjoint parts of the
        same day.
        """
        if wh:
            self._by_day[day] = self._by_day.get(day, 0.0) + float(wh)

    def basis_for_day(self, day):
        """Session-basis Wh attributed to one day (caller holds the apply lock)."""
        return self._by_day.get(day, 0.0)

    def trim(self, today):
        """Drop days too old to still receive or await a verdict."""
        cutoff = (today - timedelta(days=self._keep_days)).isoformat()
        self._by_day = {
            day: wh for day, wh in self._by_day.items() if day >= cutoff
        }


class SessionBasisTracker(StatusTracker):
    """A :class:`StatusTracker` that mirrors every allowed session delta.

    The one-line seam between the tracker and the reconciler's basis: the
    per-tick delta ``_track_interval`` attributes to the open interval (and
    to ``session_wh``) is observed here at the same instant, by diffing the
    plug-in total across the call -- ``session_wh`` moves only by
    ``+= delta`` and the reset-to-zero branches (a new plug-in's cleared
    counter, which always land on a zero-delta tick), so the diff is exactly
    the tracker's attributed delta, by construction the same observation
    basis the stored intervals hold. Constructed by ``bridge.run``; the
    basis is injectable so the tests drive it without Firestore.
    """

    def __init__(self, db, history=None, counter=None, basis=None):
        super().__init__(db, history=history, counter=counter)
        self.basis = basis

    def _track_interval(self, charging, previous_energy, gap, connected):
        before = self.session_wh
        super()._track_interval(charging, previous_energy, gap, connected)
        delta = self.session_wh - before
        if self.basis is not None and delta > 0:
            self.basis.observe(delta, _localnow())


def _next_local_midnight(moment, zone):
    """The first local midnight strictly after ``moment`` (aware datetime)."""
    local = moment.astimezone(zone)
    return datetime.combine(local.date() + timedelta(days=1), time.min, tzinfo=zone)


def attribute_interval(started_at, ended_at, wh, zone):
    """``{iso day: Wh}`` for one stored interval, split at local midnights.

    The persisted form of the session basis is the interval summary
    ``{started_at, ended_at, wh}``; re-attributing it across a midnight it
    straddles uses the constant-power split by each part's share of the
    span's real duration -- the same span machinery the web prices and
    covers by (#125) -- while an interval inside one day lands whole. The
    live accumulator needs no split (each tick carries its own instant), so
    this approximation only ever applies to restart/backfill recomputes of
    already-closed intervals -- and an interval that straddles a midnight
    makes every day it touches one this process cannot attribute exactly
    (see :meth:`ArchiveReconciler._prime`), so those days get no verdict
    rather than an approximate one.
    """
    total = (ended_at - started_at).total_seconds()
    if total <= 0:
        return {}
    parts = {}
    cursor = started_at
    while cursor < ended_at:
        boundary = min(_next_local_midnight(cursor, zone), ended_at)
        day = cursor.astimezone(zone).date().isoformat()
        share = (boundary - cursor).total_seconds() / total
        parts[day] = parts.get(day, 0.0) + float(wh) * share
        cursor = boundary
    return parts


class ArchiveReconciler:
    """Day-doc totals vs the sessions archive; verdicts disclose, once.

    One tick is one pass over the trailing window's candidate days
    (yesterday back to ``TRAILING_WINDOW_DAYS``): a day still overlapped by
    the tracker's open charging interval is deferred (its session has not
    settled in the archive); a day nobody has verdicted yet is compared --
    the day document's ``kwh`` plus whatever the history accumulator still
    holds pending for the day, read under the sink's apply lock beside the
    basis, exactly the seam-A gather -- against the session-basis Wh, and
    the raw signed delta is written once as ``gap_wh`` when (and only when)
    it is nonzero. Exactly zero writes nothing: absence of ``gap_wh`` is the
    clean verdict. Reads only otherwise; the write is a ``["gap_wh"]``
    field-path merge that cannot touch ``kwh``/``hours``, counted as a
    ``history`` write (#96).
    """

    def __init__(
        self,
        db,
        counter=None,
        recon_from=DEFAULT_RECON_FROM,
        window_days=TRAILING_WINDOW_DAYS,
        backfill_days=BACKFILL_WINDOW_DAYS,
    ):
        self.db = db
        self.counter = counter or WriteCounter()
        self.recon_from = recon_from
        self.window_days = window_days
        self.backfill_days = backfill_days
        # The live session basis (fed by SessionBasisTracker under the
        # apply lock; reseeded on restart from the stored intervals).
        self.basis = SessionBasisAccumulator(keep_days=window_days + 2)
        # The instant this reconciler was built. The restart reseed only
        # takes intervals closed at or before it: anything closed later is
        # this process's own write, whose per-tick deltas are already (or
        # will be) in the live basis -- seeding them too would double-count
        # a prime that landed after live ticks (a delayed first run).
        self._started_at = _utcnow()
        # The marker date verdicts are judged from, as ISO text once primed.
        self._recon_from_iso = recon_from.isoformat()
        self._primed = False
        # Days this process has settled (verdict written, or clean by
        # evaluation) so a steady-state tick re-reads nothing.
        self._evaluated = set()
        # Days this process cannot attribute exactly: a stored interval
        # straddling a midnight contributed to them, and the constant-power
        # split is an approximation the live per-tick basis never makes. A
        # verdict is exact or absent (#212: written once, raw), so these
        # days get no verdict from this process -- the next one, observing
        # their successors tick by tick, has the exact basis again. Their
        # absence is not a clean verdict: they carry an explicit
        # ``gap_wh: null`` mark so downstream readers cannot mistake
        # unknown for verified-clean (the three-state contract: number =
        # raw gap, null = not verdictable, absent = evaluated clean).
        self._inexact = set()
        # The inexact days whose null mark has not landed yet (a failed
        # write retries next tick; an unmarked inexact day would read as
        # clean downstream -- the one silence this module must not keep).
        self._unmarked_inexact = set()

    # -- the tick ------------------------------------------------------------

    def tick(self, now_local, sink):
        """One cadence pass: prime once, then verdict finalizable days."""
        if not self._primed and not self._prime(now_local, sink):
            return
        self._drain_inexact_marks()
        today = now_local.date()
        zone = now_local.tzinfo
        for offset in range(1, self.window_days + 1):
            day = (today - timedelta(days=offset)).isoformat()
            if day < self._recon_from_iso:
                continue  # before the marker: legacy/unknown by design
            if day in self._evaluated or day in self._inexact:
                continue
            outcome = self._consider_day(day, sink, zone)
            if outcome in ("clean", "written", "verdicted"):
                self._evaluated.add(day)
        self._trim(today)

    def _consider_day(self, day, sink, zone):
        """Verdict one candidate day; returns the outcome word.

        Deferred while an open charging session overlaps the day: its
        intervals are still moving, and the verdict must wait for the form
        the archive will keep. The gather (document, pending energy, basis,
        the open interval's start) is one apply-lock hold -- the
        ``_day_totals`` pattern: outside it a flush landing between the
        reads would move energy from pending to the document after the
        document was read.
        """
        try:
            with sink._lock:
                interval = sink.tracker.open_interval
                started = (
                    interval.get("started_at")
                    if isinstance(interval, dict)
                    else None
                )
                if isinstance(started, datetime):
                    if started.astimezone(zone).date().isoformat() <= day:
                        return "deferred"
                snapshot = self.db.collection("history").document(day).get()
                data = snapshot.to_dict() if snapshot.exists else None
                kwh = data.get("kwh") if isinstance(data, dict) else None
                # ``gap_wh`` presence is the settled test (the three-state
                # contract: number = raw verdict, null = explicitly
                # unknown, absent = not settled yet) -- a stored null must
                # settle the day exactly like a number, so ``in``, not
                # ``is not None``.
                marked = isinstance(data, dict) and GAP_FIELD in data
                pending = sink.tracker.history.pending_for_day(day)
                basis = self.basis.basis_for_day(day)
        except Exception as exc:
            log(
                f"archive reconciliation read failed for {day} "
                f"({exc.__class__.__name__}: {exc}); retrying next tick"
            )
            return "error"
        if marked:
            # A previous run already settled this day -- a number is the
            # raw verdict, a null the explicit unknown mark: either way
            # the marker is the idempotence, nothing to recompute or
            # rewrite.
            return "verdicted"
        day_wh = (float(kwh) if _is_number(kwh) else 0.0) + pending
        gap = round(day_wh * 1000.0 - basis, 3)
        if gap == 0.0:
            return "clean"
        if self._write_verdict(day, gap, day_wh=day_wh, basis=basis):
            return "written"
        return "error"

    def _write_verdict(self, day, gap, *, day_wh, basis):
        """Write one day's ``gap_wh`` once, on a field path this module owns.

        The ``["gap_wh"]`` merge list is the isolation: the write cannot
        create, touch or clear ``kwh``, ``hours`` or any other field, so the
        measurements stay exactly what the accumulator wrote (#212's
        never-rewrite charter). A failure is counted, logged once, and left
        unmarked so the next tick retries the same verdict.
        """
        try:
            self.db.collection("history").document(day).set(
                {GAP_FIELD: gap}, merge=[GAP_FIELD]
            )
        except Exception as exc:
            self.counter.note_failure(exc)
            log(
                f"archive reconciliation verdict write failed for {day} "
                f"({exc.__class__.__name__}: {exc}); will retry"
            )
            return False
        self.counter.record("history")
        log(
            f"archive reconciliation verdict (day {day}): day doc "
            f"{day_wh * 1000.0:.1f} Wh vs sessions basis {basis:.1f} Wh, "
            f"gap_wh {gap:+.1f} written; disclosure only -- no measurement "
            f"is ever rewritten"
        )
        return True

    def _drain_inexact_marks(self):
        """Land the pending ``gap_wh: null`` marks for inexact days.

        A straddle-touched day's absence would read as verified-clean
        downstream (the three-state contract makes absence the clean
        verdict), so the unknown mark is not optional: each pending day
        gets one bounded write attempt per tick, on the same owned field
        path, until it lands. Skipped silently when nothing is pending --
        the steady-state tick stays write-free.
        """
        for day in sorted(self._unmarked_inexact):
            try:
                self.db.collection("history").document(day).set(
                    {GAP_FIELD: None}, merge=[GAP_FIELD]
                )
            except Exception as exc:
                self.counter.note_failure(exc)
                log(
                    f"archive reconciliation unknown-mark write failed for "
                    f"{day} ({exc.__class__.__name__}: {exc}); will retry"
                )
                continue
            self.counter.record("history")
            self._unmarked_inexact.discard(day)
            log(
                f"archive reconciliation: day {day} marked unknown "
                f"(gap_wh null -- a straddled attribution is approximate, "
                f"so no verdict is honest; not verified clean)"
            )

    def _trim(self, today):
        """Keep the settled-day sets bounded with the basis window."""
        cutoff = (today - timedelta(days=self.window_days + 1)).isoformat()
        self._evaluated = {day for day in self._evaluated if day >= cutoff}
        self._inexact = {day for day in self._inexact if day >= cutoff}

    # -- restart / first-run priming -----------------------------------------

    def _prime(self, now_local, sink):
        """Settle the restart state once: marker, backfill, window reseed.

        Returns True when primed; False (and retried next tick) on any read
        or marker-write failure -- the backfill is idempotent (days already
        carrying ``gap_wh`` are skipped, clean days write nothing), so a
        retried first run converges without repeating a single verdict
        write. The marker lands only after a complete pass, so a crash
        mid-backfill restarts it rather than silently truncating it.
        """
        try:
            marker = self.db.collection("history").document(MARKER_DOC_ID).get()
            stored = marker.to_dict() if marker.exists else None
        except Exception as exc:
            log(
                f"archive reconciliation marker read failed "
                f"({exc.__class__.__name__}: {exc}); retrying next tick"
            )
            return False
        first_run = not (
            isinstance(stored, dict)
            and isinstance(stored.get(RECON_FROM_FIELD), str)
            and stored[RECON_FROM_FIELD]
        )
        today = now_local.date()
        zone = now_local.tzinfo
        if first_run:
            start = max(self.recon_from, today - timedelta(days=self.backfill_days))
        else:
            self._recon_from_iso = stored[RECON_FROM_FIELD]
            start = max(
                date.fromisoformat(self._recon_from_iso),
                today - timedelta(days=self.window_days),
            )
        window_start = today - timedelta(days=self.window_days)
        try:
            docs = self._read_day_docs(start, today)
            records = self._read_sessions_since(start, zone)
        except Exception as exc:
            log(
                f"archive reconciliation prime read failed "
                f"({exc.__class__.__name__}: {exc}); retrying next tick"
            )
            return False
        # The archived basis over the whole primed range, from the stored
        # intervals -- the persisted form of the same per-tick deltas. Only
        # intervals closed at or before this process started: later ones are
        # its own writes, already accumulating in the live basis. An
        # interval straddling a local midnight marks every day it touched
        # inexact: the constant-power split is an approximation, and a
        # verdict written once must be raw, never approximate.
        archived = {}
        for record in records:
            for entry in record.get("intervals") or []:
                interval = _usable_interval(entry)
                if interval is None:
                    continue
                if interval["ended_at"] > self._started_at:
                    continue
                parts = attribute_interval(
                    interval["started_at"], interval["ended_at"], interval["wh"], zone
                )
                if len(parts) > 1:
                    self._inexact.update(parts)
                    # Their absence must not read as clean downstream: any
                    # touched day not already carrying a mark (number or
                    # null -- presence is the settled test) is queued for
                    # an explicit unknown mark, and only days inside the
                    # declared verdict range may receive one: days before
                    # recon_from are legacy/unknown by design, so a
                    # straddling overnight interval's pre-marker part is
                    # left unmarked rather than written out of contract.
                    for day in parts:
                        if day < self._recon_from_iso:
                            continue
                        data = docs.get(day)
                        if not (isinstance(data, dict) and GAP_FIELD in data):
                            self._unmarked_inexact.add(day)
                for day, wh in parts.items():
                    archived[day] = archived.get(day, 0.0) + wh
        verdicts = 0
        if first_run:
            # One bounded backfill pass: verdicts for the finalized days the
            # trailing window does not own, from the stored day documents
            # beside the archived basis just read. Days the window will
            # verdict live (deferral included) are left to the tick.
            for day in sorted(docs):
                if day >= window_start.isoformat():
                    break
                if day < self._recon_from_iso or day in self._inexact:
                    continue
                data = docs[day]
                # Presence (number or null), not number-ness: a stored
                # unknown mark settles the backfill exactly like a
                # verdict.
                if isinstance(data, dict) and GAP_FIELD in data:
                    continue  # already verdicted or marked unknown: settled
                kwh = data.get("kwh") if isinstance(data, dict) else None
                day_wh = float(kwh) if _is_number(kwh) else 0.0
                gap = round(day_wh * 1000.0 - archived.get(day, 0.0), 3)
                if gap != 0.0 and self._write_verdict(
                    day, gap, day_wh=day_wh, basis=archived.get(day, 0.0)
                ):
                    verdicts += 1
            if not self._write_marker():
                return False
            log(
                f"archive reconciliation backfill: {self.recon_from} through "
                f"{(window_start - timedelta(days=1)).isoformat()}, "
                f"{verdicts} divergent day(s) verdicted, "
                f"{len(docs)} day document(s) read in one pass"
            )
        # Reseed the trailing window (today included: a restart mid-day has
        # closed blocks already stored beside the ticks this process will
        # observe -- disjoint parts of today, added not replaced). Last, and
        # once: every read and write this depends on has landed, so a retried
        # prime cannot double count. The reseed is the one accumulator
        # mutation off the status thread, so it takes the sink's apply lock:
        # ``observe`` mutates the same ``_by_day`` dict under that lock on
        # the status thread, and either side's read-modify-write landing
        # inside the other's would drop a day's basis -- a corrupted verdict,
        # written once and therefore permanently wrong.
        with sink._lock:
            for offset in range(self.window_days + 1):
                day = (today - timedelta(days=offset)).isoformat()
                self.basis.seed(day, archived.get(day, 0.0))
        self._primed = True
        return True

    def _write_marker(self):
        """Write the one-time ``recon_from`` marker on this module's path."""
        try:
            self.db.collection("history").document(MARKER_DOC_ID).set(
                {RECON_FROM_FIELD: self.recon_from.isoformat()},
                merge=[RECON_FROM_FIELD],
            )
        except Exception as exc:
            self.counter.note_failure(exc)
            log(
                f"archive reconciliation marker write failed "
                f"({exc.__class__.__name__}: {exc}); will retry the backfill"
            )
            return False
        self.counter.record("history")
        log(
            f"archive reconciliation: recon_from {self.recon_from} marked "
            f"(days before it are legacy/unknown; absence of gap_wh at or "
            f"after it means clean)"
        )
        return True

    def _read_day_docs(self, start, end):
        """``{day: data}`` for ``[start, end)`` -- one documentId range query.

        The bounds are :class:`~google.cloud.firestore.DocumentReference`
        values (byte-lexicographic on the id): the string-bound form is
        rejected by the server (``__key__ filter value must be a Key``), the
        lesson ``bridge._month_totals`` verified live (#208/#214).
        """
        history = self.db.collection("history")
        snapshots = (
            history.where(
                filter=firestore.FieldFilter(
                    "__name__", ">=", history.document(start.isoformat())
                )
            )
            .where(
                filter=firestore.FieldFilter(
                    "__name__", "<", history.document(end.isoformat())
                )
            )
            .stream()
        )
        return {snapshot.id: snapshot.to_dict() for snapshot in snapshots}

    def _read_sessions_since(self, start, zone):
        """Session records ending at/after local midnight of ``start``.

        One bounded range read on ``ended_at`` (a single-field range, the
        automatic index): a record ending before the window cannot hold an
        interval overlapping it. Records still open do not exist yet --
        their days stay deferred -- and a mid-charge restart's lost
        pre-restart ticks are genuinely absent from the archive, which is
        exactly the loss the verdict discloses.
        """
        start_utc = datetime.combine(start, time.min, tzinfo=zone).astimezone(
            timezone.utc
        )
        snapshots = (
            self.db.collection("sessions")
            .where(filter=firestore.FieldFilter("ended_at", ">=", start_utc))
            .stream()
        )
        return [snapshot.to_dict() or {} for snapshot in snapshots]
