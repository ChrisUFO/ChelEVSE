"""The in-memory ``history/<day>`` accumulator (issue #94).

Extracted from ``bridge.py`` (behavior-preserving move): ``StatusTracker``
attributes each positive total_energy delta to the local ``(day, hour)`` and
hands it to this accumulator; one flush is one masked-merge write per pending
day document.
"""

import time

from firebase_admin import firestore

from write_counter import WriteCounter


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.log(message)



# --- History write accumulator (issue #94) ------------------------------------
# history/<day> deltas accumulate in memory and flush as one masked-merge
# write per day document on: hour rollover, session close, this interval
# while charging, and shutdown. 300 s is 12 writes/hour while charging and
# zero while idle; the shutdown drain means stops and restarts lose nothing.
HISTORY_FLUSH_SEC = 300
class HistoryAccumulator:
    """In-memory ``history/<day>`` deltas; one flush is one write per day.

    ``StatusTracker.record_history`` attributes each positive total_energy
    delta to the local ``(day, hour)`` it was observed in and hands it to
    this accumulator; the write itself is deferred (issue #94). One flush
    writes one document per pending day, carrying ``kwh`` plus every touched
    ``hours.<HH>`` bucket in the same field-path merge list the per-delta
    write used -- a flush spanning an hour boundary or midnight stays one
    write per day document. Flush points: the hour rolls over, a session
    closes, ``flush_sec`` elapses while charging, and shutdown.

    A failed write keeps the accumulator, so the same energy is retried on
    the next flush and never dropped; attribution stays with the observed
    hour, not the hour the retry lands in.
    """

    def __init__(
        self, db, flush_sec=HISTORY_FLUSH_SEC, clock=time.monotonic, counter=None
    ):
        self.db = db
        self.flush_sec = flush_sec
        # Injectable monotonic clock, the WritePolicy(clock=...) precedent.
        self.clock = clock
        # Successful flush writes are counted here (issue #96).
        self.counter = counter or WriteCounter()
        # (day, "HH") -> pending kWh observed in that bucket.
        self.pending_hours = {}
        # Total pending kWh across days (the sum of pending_hours' values).
        self.pending_kwh = 0.0
        # The (day, "HH") of the most recent attribution. A delta observed in
        # a different bucket means the hour rolled over: the pending energy
        # belongs to a closed hour, so it is due now.
        self.hour_key = None
        # The clock time the charging interval is measured from: the first
        # pending delta (the batch's birth) or the last flush attempt. A
        # failed flush advances it too -- the retry rides the next flush
        # point instead of spinning on every tick.
        self.timed_from = None

    def observe(self, delta, moment):
        """Attribute one positive delta to the (day, hour) it was observed in.

        The hour-rollover flush runs *after* accumulating, so one write spans
        both buckets: the energy already belongs to its observed hours, and
        splitting it into two writes would spend the boundary-crossing write
        twice.
        """
        key = (moment.date().isoformat(), moment.strftime("%H"))
        rolled = self.hour_key is not None and key != self.hour_key
        self.hour_key = key
        if not self.pending_hours:
            self.timed_from = self.clock()
        self.pending_hours[key] = self.pending_hours.get(key, 0.0) + delta
        self.pending_kwh += delta
        if rolled:
            self.flush("hour rollover")

    def due(self, now, charging):
        """True when the charging interval elapsed with energy pending.

        Charging-gated on purpose (issue #94: zero idle writes): energy a
        charging session left unflushed waits for a rollover, session close
        or shutdown rather than an idle timer.
        """
        return (
            charging
            and bool(self.pending_hours)
            and self.timed_from is not None
            and now - self.timed_from >= self.flush_sec
        )

    def consider(self, charging):
        """Flush when the charging interval is due."""
        if self.due(self.clock(), charging):
            self.flush("charging interval")

    def flush(self, reason):
        """Write one masked-merge document per pending day; keep failures.

        Returns True when nothing is left pending (nothing was, or every
        write landed). A failed day keeps exactly its own deltas -- days that
        landed are cleared, so a partial midnight flush never re-writes the
        day that succeeded.
        """
        if not self.pending_hours:
            return True
        self.timed_from = self.clock()
        by_day = {}
        for (day, hour), delta in self.pending_hours.items():
            by_day.setdefault(day, {})[hour] = delta
        drained = True
        landed_kwh = 0.0
        landed_buckets = 0
        landed_days = 0
        for day in sorted(by_day):
            hours = by_day[day]
            payload = {
                "kwh": firestore.Increment(sum(hours.values())),
                "hours": {
                    hour: firestore.Increment(delta)
                    for hour, delta in sorted(hours.items())
                },
                "updated_at": firestore.SERVER_TIMESTAMP,
            }
            # The same field-path merge list the per-delta write used (see
            # record_history): one write increments kwh and exactly the
            # touched hours.<HH> leaves, so sibling hours and every other
            # field survive, and a missing document is created.
            merge = ["kwh"] + [f"hours.`{hour}`" for hour in sorted(hours)] + [
                "updated_at"
            ]
            try:
                self.db.collection("history").document(day).set(payload, merge=merge)
            except Exception as exc:
                self.counter.note_failure(exc)
                log(
                    f"history flush failed on {reason} "
                    f"({exc.__class__.__name__}: {exc}); "
                    f"keeping {self.pending_kwh:.3f} kWh pending"
                )
                drained = False
            else:
                self.counter.record("history")
                for hour, delta in hours.items():
                    del self.pending_hours[(day, hour)]
                    self.pending_kwh -= delta
                landed_kwh += sum(hours.values())
                landed_buckets += len(hours)
                landed_days += 1
        if landed_days:
            # The success counterpart of the failure log above: one line
            # per flush that wrote, so the journal shows the write budget
            # in operation (issue #94's <= 13 lines/h while charging; an
            # empty flush writes nothing and stays silent).
            log(
                f"history flush on {reason}: {landed_kwh:.3f} kWh across "
                f"{landed_buckets} bucket(s), {landed_days} day doc(s)"
            )
        return drained


