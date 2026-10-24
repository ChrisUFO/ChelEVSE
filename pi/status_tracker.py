"""The status tracker: status-derived state across ticks and restarts.

Extracted from ``bridge.py`` (behavior-preserving move): the charging-state
machine, session finalize/merge logic and interval attribution (issue #122's
stop stamp included), plus the module-level session-merge helpers the tracker
calls. History deltas flow to the accumulator; writes to the tracker's
dependencies.
"""

import time
from datetime import datetime, timedelta

from firebase_admin import firestore

from history_accumulator import HistoryAccumulator
from parsing import (
    _gap_seconds,
    _interval_clock,
    _interval_step_allowance,
    _is_number,
)
from write_counter import WriteCounter


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.log(message)


def _utcnow():
    # seam: tests patch bridge._utcnow (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge._utcnow()


def _localnow():
    # seam: tests patch bridge._localnow (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge._localnow()



# Retry a failed status/current seed at most this often while running.
SEED_RETRY_INTERVAL = 30
# Two session records whose intervals touch within this window are the same
# charger session (the firmware keeps cumulative counters while plugged in).
SESSION_MERGE_TOLERANCE = 120
# While plugged in, a cumulative continuation may span a long idle gap (nightly
# scheduled charging); beyond this the previous record is too old to assume the
# same plug-in event and is left as its own session.
SESSION_MERGE_MAX_GAP = 48 * 3600
# Charging intervals kept per session record. A merge appends the newly closed
# interval and folds anything past this many into the oldest retained one, so the
# retained list still accounts for the session's whole energy while the document
# stays small (a record is one Firestore document).
MAX_SESSION_INTERVALS = 100
class StatusTracker:

    """Status-derived state carried across ticks and bridge restarts."""

    def __init__(self, db, history=None, counter=None):
        self.db = db
        # The history accumulator (issue #94): record_history attributes
        # deltas here; the flush points are rollover / session close / the
        # charging interval / shutdown. Injectable for the tests.
        self.history = history or HistoryAccumulator(db, counter=counter)
        # Successful session writes are counted here (issue #96); the same
        # counter as the accumulator's, so one injected instance counts all
        # of a run's writes.
        self.counter = counter or WriteCounter()
        self.total_energy = None
        self.state = None
        self.charger_online = None
        self.session_energy = None
        self.elapsed = None
        self.previous_state = None
        self.has_state = False
        self.last_charging_energy = None
        self.last_charging_elapsed = None
        self.seeded = False
        self.seed_retry_at = 0.0
        self.pending_session = None
        self._history_paused_logged = False
        # Charging intervals: the open one while state 3 and the session_energy
        # baseline the next tick's grown-by delta is measured from.
        self.open_interval = None
        self.interval_energy = None
        self.interval_seen_at = None
        # The ``charging_stopped_at`` view for status/current (issue #122):
        # the instant charging last ended while still plugged in, or None.
        # The web adopts it as the reconstructed cost anchor on a cold open,
        # so the value is frozen once written (a literal timestamp, never
        # SERVER_TIMESTAMP: the accumulated view republishes it on every
        # later write, and a server stamp would re-resolve each time and
        # move the anchored figure). ``stamp_write_pending`` is the one-shot
        # flag that promotes the stop transition's own status write to a
        # forced write, so the field lands promptly even inside the
        # rate-limit gap; the sink consumes it under the apply lock.
        # ``stamp_adopted`` says the tracker has held a stamp at least once
        # (seeded from the document or stamped on a stop): from then on the
        # field rides every payload -- its value, or None once cleared --
        # so a clear always reaches the document. Before the first stamp
        # the field stays out of the payloads entirely.
        self.charging_stopped_at = None
        self.stamp_write_pending = False
        self.stamp_adopted = False

    def seed(self):
        """Seed state from status/current; return True when the read worked.

        A failure leaves ``seeded`` false so later ticks retry: until the
        stored total_energy is known, history cannot attribute downtime energy.
        """
        try:
            data = (
                self.db.collection("status").document("current").get().to_dict() or {}
            )
        except Exception as exc:
            log(f"status seed failed ({exc.__class__.__name__}: {exc})")
            return False
        if not isinstance(data, dict):
            data = {}
        total = data.get("total_energy")
        if _is_number(total):
            self.total_energy = float(total)
        state = data.get("state")
        # A stored stop stamp outlives a restart: adopting it keeps the
        # tracker's view aligned with the document, so the first write of
        # the new process carries it forward (writing None here would
        # null the field a cold-opened page still needs) and a later
        # clear -- a new charge or the session's reset -- really clears.
        # This sits outside the ``has_state`` gate below on purpose: a
        # boot seed that failed and retried after live ticks already has
        # state, and skipping adoption there would strand the stored
        # stamp -- the sink's merge gate never opens, so no later clear
        # could reach the document. ``stamp_adopted`` keeps a retry from
        # resurrecting: once this process has held a stamp -- stamped on
        # a stop or adopted -- the stored value never overwrites the view.
        stored_stamp = data.get("charging_stopped_at")
        if isinstance(stored_stamp, datetime) and not self.stamp_adopted:
            self.charging_stopped_at = stored_stamp
            self.stamp_adopted = True
        if not self.has_state:
            # Only the first successful seed establishes the state machine. A
            # retry after live ticks must restore the stored baseline without
            # rewinding previous_state and inventing a transition.
            self.state = state
            self.charger_online = data.get("charger_online")
            self.previous_state = state
            self.has_state = _is_number(state)
            self.session_energy = data.get("session_energy")
            self.elapsed = data.get("elapsed")
            if state == 3:
                if _is_number(self.session_energy) and self.session_energy > 0:
                    self.last_charging_energy = self.session_energy
                if _is_number(self.elapsed) and self.elapsed >= 0:
                    self.last_charging_elapsed = self.elapsed
                # A restart mid-charge must not fold the whole session's energy
                # into the interval it opens on the first tick: the stored
                # session_energy is the baseline that tick's delta grows from.
                if _is_number(self.session_energy) and self.session_energy >= 0:
                    self.interval_energy = self.session_energy
        self.seeded = True
        self._history_paused_logged = False
        log(f"status seeded: state={state} total_energy={self.total_energy}")
        return True

    def maybe_seed(self):
        """Retry a failed seed on later ticks, at most once per interval."""
        if self.seeded:
            return
        now = time.monotonic()
        if now < self.seed_retry_at:
            return
        self.seed_retry_at = now + SEED_RETRY_INTERVAL
        self.seed()

    def observe(self, data):
        """Track charging state from a successful tick; finalize ended sessions."""
        self._flush_pending_session()
        state = data.get("state")
        previous_energy = self.interval_energy
        # Seconds between the two charging readings a step is measured across.
        # A monotonic timebase, so a wall-clock jump cannot inflate the
        # allowance; boottime on Linux, so a suspend mid-charge is included and
        # the gap stays the elapsed time rather than the awake time. It spans an
        # outage on purpose, because the energy drawn during one legitimately
        # lands in the recovering tick.
        now = _interval_clock()
        gap = None if self.interval_seen_at is None else now - self.interval_seen_at
        if state == 3:
            energy = data.get("session_energy")
            if _is_number(energy) and energy >= 0:
                self.last_charging_energy = energy
                self.interval_energy = energy
            elapsed = data.get("elapsed")
            if _is_number(elapsed) and elapsed >= 0:
                self.last_charging_elapsed = elapsed
            self.interval_seen_at = now
        self._track_interval(state == 3, previous_energy, gap)
        if self.has_state and self.previous_state == 3 and state != 3:
            # A seeded state lets the first tick after a restart close a
            # session that ended while the bridge was down; with no seed the
            # first tick only establishes state.
            self._finalize_session(data)
            # The session edge is a history flush point (issue #94): the
            # energy observed during the session lands before the tracker
            # goes quiet. An empty accumulator is a no-op, so an interval
            # flush that just fired cannot double it.
            self.history.flush("session close")
            self._note_stop_stamp(data)
        # A session reset while charging had already stopped (the vehicle
        # disconnected after a plugged-in-complete stretch): the counters
        # zeroed, so the plug-in is over and its stop stamp is void. The
        # same energy gate the web's hold uses, so the field is meaningful
        # exactly while a later snapshot could still adopt it. A stop tick
        # that disconnects outright is covered by _note_stop_stamp above.
        new_energy = data.get("session_energy")
        if (
            state != 3
            and _is_number(self.session_energy)
            and self.session_energy > 0
            and not (_is_number(new_energy) and new_energy > 0)
        ):
            self.charging_stopped_at = None
        self.previous_state = state
        self.has_state = True
        self.state = state
        self.session_energy = data.get("session_energy")
        self.elapsed = data.get("elapsed")

    def _track_interval(self, charging, previous_energy, gap):
        """Open a charging interval on the edge and attribute this tick to it.

        An interval starts when the bridge first sees state 3 (the charger's
        transition happened between two polls, so its start is observation
        time, not the aggregate's charger-timer start) and ends when it first
        sees the state leave 3. Each charging tick adds its session_energy
        growth, which is cumulative per plug-in and cleared at unplug, so the
        intervals of one session account for its ``wh`` except where a restart,
        a counter reset or a dropped impossible step intervened.

        A step is only attributed when the charger could have delivered it in
        ``gap`` seconds (``MAX_INTERVAL_POWER_W`` plus a small floor), so an
        outage's legitimate energy is kept while a corrupt jump is not. A step
        with no measurable gap — the first reading after a seed, where the
        baseline predates the tracker — is attributed, because it is real
        counter growth and there is nothing to judge it against. A non-positive
        step is never negative energy: it is dropped and the tick's reading
        becomes the next baseline. Inside an open interval a negative step is a
        mid-session counter reset (a firmware restart) and is logged with its
        size and gap; the first reading of a fresh interval is only a baseline —
        a new plug-in legitimately starts its counter at zero — so it stays
        silent and the opening is logged instead. Every dropped step is logged
        once with its size, gap and reason — a session priced from a short list
        is otherwise undiagnosable.
        """
        if not charging:
            return
        current = self.interval_energy
        delta = 0.0
        if _is_number(current) and _is_number(previous_energy):
            step = float(current) - float(previous_energy)
            if step <= 0:
                # A reset is a counter that went backwards *inside* an interval.
                # A first reading has no interval open yet and no earlier
                # baseline it could contradict: a new plug-in's cleared counter
                # is a fresh start, not an incident worth chasing in the journal.
                if step < 0 and self.open_interval is not None:
                    log(
                        f"interval step skipped: counter reset inside the open "
                        f"interval ({step:.0f} Wh, {_gap_seconds(gap)}); "
                        f"rebaselining"
                    )
            else:
                # An unmeasurable gap has no allowance to compare against.
                allowed = _interval_step_allowance(gap) if _is_number(gap) else None
                if allowed is None or step <= allowed:
                    delta = step
                else:
                    log(
                        f"interval step dropped: {step:.0f} Wh in "
                        f"{_gap_seconds(gap)} exceeds the {allowed:.0f} Wh the "
                        f"charger could deliver; energy stays in the aggregate"
                    )
        if self.open_interval is None:
            # The wall clock anchors the stored bounds; the boottime stamp is the
            # same instant on the clock a wall-clock step cannot move, so an
            # interval whose endpoints a step inverts still has a measured span.
            self.open_interval = {
                "started_at": _utcnow(),
                "started_boot": _interval_clock(),
                "wh": 0.0,
            }
            baseline = f"{float(current):.0f} Wh" if _is_number(current) else "unknown"
            log(f"interval opened: baseline {baseline}")
            # A new charging block voids the previous block's stop stamp: the
            # web re-anchors on this block's own writes, and the next stop
            # restamps. Cleared here rather than on the state edge so the
            # restart-mid-charge case (no state change, but no open interval
            # either) clears too.
            self.charging_stopped_at = None
        self.open_interval["wh"] += delta

    def _note_stop_stamp(self, data):
        """Record ``charging_stopped_at`` on the charging-state stop edge.

        The edge the session machinery already sees (``_finalize_session``
        runs beside this): charging ended, and ``vehicle`` says whether the
        plug-in continues. Still connected -- the plugged-in-complete end
        state the web's frozen anchor covers -- stamps the stop instant and
        asks the sink for one prompt write; disconnected is the session's
        own end, when the counters zero and there is nothing to anchor (the
        web hides the figure on reset regardless), so any earlier stamp from
        the same plug-in is cleared instead. The stamp is the observation
        time of the first not-charging tick, the same convention a closed
        interval's ``ended_at`` uses.
        """
        if _vehicle_connected(data):
            self.charging_stopped_at = _utcnow()
            self.stamp_write_pending = True
            self.stamp_adopted = True
        else:
            self.charging_stopped_at = None

    def _close_interval(self):
        """Detach the open interval for the record being written, ending now.

        Returns the just-closed interval as a one-item list, or an empty list
        when there is nothing trustworthy to store: an interval with no energy
        (a zero-wh plug-in, or a restart whose counters never grew) is dropped
        rather than fabricated.

        An interval whose wall-clock endpoints do not span time — the clock
        stepped backwards between open and close — is *not* dropped while its
        boottime stamps measure a duration: the duration is observed, so only
        the wall-clock anchor is inferred and ``ended_at`` becomes
        ``started_at + measured``. Storing it keeps measured energy in a priced
        session, and the derivation is logged distinctly from a corrupt entry so
        the journal shows the clock moved rather than the data being bad. With
        no measured span (a missing/non-numeric stamp, or a non-advancing one)
        there is nothing to anchor the interval to: it is dropped and logged.
        In both cases the stored shape stays ``{started_at, ended_at, wh}``.
        """
        interval = self.open_interval
        self.open_interval = None
        if interval is None:
            return []
        wh = interval.get("wh")
        started_at = interval.get("started_at")
        if not (_is_number(wh) and wh > 0):
            return []
        ended_at = _utcnow()
        if not isinstance(started_at, datetime):
            return []
        closed_boot = _interval_clock()
        if ended_at <= started_at:
            started_boot = interval.get("started_boot")
            span = None
            if _is_number(started_boot) and _is_number(closed_boot):
                span = float(closed_boot) - float(started_boot)
            if span is None or span <= 0:
                log(
                    f"interval dropped: wall clock stepped backwards and no "
                    f"measured span ({float(wh):.0f} Wh)"
                )
                return []
            step = (started_at - ended_at).total_seconds()
            ended_at = started_at + timedelta(seconds=span)
            log(
                f"interval span derived: wall clock moved back {step:g}s; "
                f"{span:g}s measured on CLOCK_BOOTTIME ({float(wh):.0f} Wh)"
            )
        return [{"started_at": started_at, "ended_at": ended_at, "wh": float(wh)}]

    def _latest_session(self):
        """Most recent session record (a pending write wins), or None."""
        if self.pending_session is not None:
            return self.pending_session
        try:
            docs = list(
                self.db.collection("sessions")
                .order_by("ended_at", direction=firestore.Query.DESCENDING)
                .limit(1)
                .stream()
            )
        except Exception as exc:
            log(f"session lookup failed ({exc.__class__.__name__}: {exc})")
            return None
        if not docs:
            return None
        try:
            data = docs[0].to_dict() or {}
        except Exception as exc:
            log(f"session lookup failed ({exc.__class__.__name__}: {exc})")
            return None
        if not isinstance(data, dict):
            return None
        data["_id"] = docs[0].id
        return data

    def _finalize_session(self, data):
        """Write (or merge into) the record for a just-ended charging session.

        Firmware v5.1.5 keeps session_energy/elapsed cumulative for the whole
        plug-in event and clears them only when the vehicle disconnects. A
        pause, scheduled stop, or manual stop therefore ends the charging
        *state* but not the session, so a second record would double-count the
        same Wh. Merge into the previous record while the counters keep growing
        (vehicle still connected / intervals overlap) and write one document.

        The just-closed charging interval is written beside the aggregates. The
        aggregates keep their meaning exactly: ``wh`` stays the charger's
        cumulative session_energy, ``elapsed`` its own timer, and
        ``started_at``/``ended_at`` the plug-in span — so an older reader, or a
        session with no interval (a restart that never saw growth), still works.
        """
        intervals = self._close_interval()
        energy = self.last_charging_energy
        if not (_is_number(energy) and energy > 0):
            # Firmware may zero session_energy on the end tick; use it if the
            # last charging tick had nothing useful (or was before a restart).
            tick_energy = data.get("session_energy")
            energy = (
                tick_energy if _is_number(tick_energy) and tick_energy > 0 else None
            )
        if energy is None:
            self.last_charging_energy = None
            self.last_charging_elapsed = None
            return
        elapsed = self.last_charging_elapsed
        if not (_is_number(elapsed) and elapsed > 0):
            tick_elapsed = data.get("elapsed")
            if _is_number(tick_elapsed) and tick_elapsed > 0:
                elapsed = tick_elapsed
            elif not (_is_number(elapsed) and elapsed >= 0):
                elapsed = 0
        ended_at = _utcnow()
        started_at = ended_at - timedelta(seconds=elapsed)
        record = {
            "started_at": started_at,
            "ended_at": ended_at,
            "wh": float(energy),
            "elapsed": int(elapsed),
        }
        if intervals:
            record["intervals"] = intervals
        try:
            merged = _merge_session(
                self._latest_session(), record, _vehicle_connected(data)
            )
        except (TypeError, ValueError) as exc:
            # A corrupt previous record must not cost us the current session.
            log(f"session merge skipped ({exc.__class__.__name__}: {exc})")
            merged = dict(record)
        session_id = merged.pop("_id", None)
        if session_id is None:
            session_id = str(int(merged["started_at"].timestamp()))
        self.last_charging_energy = None
        self.last_charging_elapsed = None
        self._write_session(session_id, merged)

    def _write_session(self, session_id, record):
        """Upsert one session; on failure keep it for the next tick."""
        payload = {key: value for key, value in record.items() if key != "_id"}
        try:
            self.db.collection("sessions").document(session_id).set(payload)
        except Exception as exc:
            self.counter.note_failure(exc)
            self.pending_session = {**payload, "_id": session_id}
            log(f"session write failed ({exc.__class__.__name__}: {exc}); will retry")
        else:
            self.counter.record("session")
            self.pending_session = None
            log(f"session recorded: {session_id} ({payload['wh']:g} Wh)")

    def _flush_pending_session(self):
        """Retry a session write that failed on an earlier tick."""
        if self.pending_session is None:
            return
        record = self.pending_session
        self._write_session(record.get("_id"), record)

    def record_history(self, total):
        """Accumulate the total_energy delta into the history accumulator.

        One flush later moves both counters -- the daily ``kwh`` total and
        the ``hours.<HH>`` bucket for the hour each delta was observed in --
        as a single masked-merge write per day document (issue #94). The
        baseline advances on observation; the accumulator holds the energy
        until a write lands, so a failed flush retries the same deltas
        instead of losing them.
        """
        if not _is_number(total):
            return
        total = float(total)
        if not self.seeded:
            # No trustworthy baseline yet: keep a provisional one and retry the
            # seed, so the eventual delta starts at the last stored reading.
            self.total_energy = total
            if not self._history_paused_logged:
                log("history paused: status seed unavailable (retrying)")
                self._history_paused_logged = True
            return
        previous = self.total_energy
        if previous is None:
            self.total_energy = total
            return  # first observation is a baseline only
        delta = total - previous
        if delta < 0:
            log("total_energy reset; rebaselining history")
            self.total_energy = total
            return
        if delta <= 0:
            self.total_energy = total
            return
        self.total_energy = total
        self.history.observe(delta, _localnow())

    def consider_history_flush(self):
        """Flush pending history when the charging interval elapsed (issue #94).

        The other flush points call ``history.flush`` directly: the hour
        rollover inside the accumulator, the session close in ``observe``,
        and the shutdown drain in ``run``.
        """
        self.history.consider(self.state == 3)


def _vehicle_connected(data):
    """True when the charger reports a plugged-in vehicle (counters persist)."""
    vehicle = data.get("vehicle")
    return _is_number(vehicle) and vehicle != 0


def _merge_session(candidate, record, vehicle_connected):
    """Merge one session record into the previous one when it is a continuation.

    Returns a copy of ``record`` (with the previous ``_id`` when merged) and
    never lowers wh/elapsed, so a merged write cannot double-count or go
    negative.
    """
    if not candidate:
        return dict(record)
    try:
        existing_start = candidate["started_at"]
        existing_end = candidate["ended_at"]
        existing_wh = float(candidate["wh"])
        existing_elapsed = float(candidate.get("elapsed") or 0)
    except (KeyError, TypeError, ValueError):
        return dict(record)
    tolerance = timedelta(seconds=SESSION_MERGE_TOLERANCE)
    overlaps = (
        existing_end + tolerance >= record["started_at"]
        and record["ended_at"] + tolerance >= existing_start
    )
    close_start = abs(record["started_at"] - existing_start) <= tolerance
    # While plugged in the charger counters are cumulative; neither value may
    # shrink (a shrink means a firmware counter reset, i.e. a new session).
    gap = (record["started_at"] - existing_end).total_seconds()
    cumulative = (
        vehicle_connected
        and gap <= SESSION_MERGE_MAX_GAP
        and record["wh"] >= existing_wh
        and record["elapsed"] >= existing_elapsed
    )
    if not (overlaps or close_start or cumulative):
        return dict(record)
    merged = dict(record)
    merged["started_at"] = min(existing_start, record["started_at"])
    merged["ended_at"] = max(existing_end, record["ended_at"])
    merged["wh"] = max(existing_wh, record["wh"])
    merged["elapsed"] = int(max(existing_elapsed, record["elapsed"]))
    intervals = _merge_intervals(
        candidate.get("intervals"),
        record.get("intervals"),
        session_id=candidate.get("_id"),
    )
    if intervals:
        merged["intervals"] = intervals
    else:
        # Never carry an empty list: a session with no measured interval stays
        # shaped like a legacy record and is priced by the fallback.
        merged.pop("intervals", None)
    if candidate.get("_id") is not None:
        merged["_id"] = candidate["_id"]
    return merged


def _usable_interval(entry):
    """One stored interval as {started_at, ended_at, wh}, or None if unusable.

    A stored document carries no boottime sample (the shape has no room for
    one), so a reversed pair read back from Firestore cannot be re-anchored and
    is dropped — the bridge only derives a span from the live tracker, before
    the entry is written. Callers log the drop.
    """
    if not isinstance(entry, dict):
        return None
    started_at = entry.get("started_at")
    ended_at = entry.get("ended_at")
    wh = entry.get("wh")
    if not isinstance(started_at, datetime) or not isinstance(ended_at, datetime):
        return None
    if ended_at <= started_at:
        return None
    if not _is_number(wh) or wh <= 0:
        return None
    return {"started_at": started_at, "ended_at": ended_at, "wh": float(wh)}


def _merge_intervals(*groups, session_id=None):
    """Concatenate interval lists oldest-first, capped at MAX_SESSION_INTERVALS.

    A merged record's aggregates cover the whole plug-in, so the interval list
    has to as well without growing without bound. Past the cap the oldest
    entries are folded into the oldest retained interval (its start becomes the
    earliest dropped start and its energy their sum): the list keeps the most
    recent MAX_SESSION_INTERVALS intervals in start order, no energy is lost,
    and only that folded head is pro-rated over the idle stretch it spans — the
    same approximation a legacy record gets. Entries that are not usable
    intervals (a hand-edited document, a half-written one) are dropped
    individually, so one corrupt entry cannot discard a session's good blocks;
    a fold and any dropped entries are logged, because both change what the
    session can be priced from.
    """
    entries = []
    unusable = 0
    for group in groups:
        if not isinstance(group, (list, tuple)):
            continue
        for entry in group:
            interval = _usable_interval(entry)
            if interval is None:
                unusable += 1
            else:
                entries.append(interval)
    label = session_id or "pending"
    if unusable:
        log(f"session {label}: {unusable} unusable interval(s) dropped")
    if not entries:
        return []
    entries.sort(key=lambda item: item["started_at"])
    if len(entries) <= MAX_SESSION_INTERVALS:
        return entries
    head = entries[: len(entries) - MAX_SESSION_INTERVALS + 1]
    tail = entries[len(entries) - MAX_SESSION_INTERVALS + 1 :]
    folded = {
        "started_at": head[0]["started_at"],
        "ended_at": head[-1]["ended_at"],
        "wh": sum(interval["wh"] for interval in head),
    }
    log(
        f"session {label}: {len(head)} oldest intervals folded into "
        f"{folded['started_at'].isoformat()}–{folded['ended_at'].isoformat()} "
        f"({folded['wh']:.0f} Wh); {len(tail)} kept"
    )
    return [folded] + tail
