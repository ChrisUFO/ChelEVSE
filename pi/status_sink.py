"""The status sink: the one apply path shared by the HTTP poll and MQTT.

Extracted from ``bridge.py`` (behavior-preserving move, issues #93/#94/#96):
applies merge into the tracker and an accumulated field view; the write
policy decides when ``status/current`` is written. Also hosts the MQTT
snapshot queue's coalescing/enqueue helpers, the ``status/health`` transport
facts, and the pending-queue capacity constants.
"""

import queue
import threading

from firebase_admin import firestore

from write_counter import WriteCounter
from write_policy import WritePolicy, _transition_body


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.log(message)



OFFLINE = {"charger_online": False, "updated_at": firestore.SERVER_TIMESTAMP}
# Telemetry capacity of the apply queue: only the newest field set of an
# unchanged state matters, so repeated telemetry collapses into one record.
MQTT_PENDING_SNAPSHOTS = 4
# On top of that, every state change is kept in order: it is the edge sessions
# and transition notifications run on, so it must never be evicted as if it were
# redundant telemetry. This bounds a pathological burst of transitions while the
# worker is stuck; exceeding it is logged loudly.
MQTT_PENDING_EDGES = 32
# The queue's real bound: telemetry slots plus the reserved edge backlog.
MQTT_PENDING_QUEUE = MQTT_PENDING_SNAPSHOTS + MQTT_PENDING_EDGES
# Snapshot fields whose change is a discrete trigger: they publish at the next
# scheduler opportunity. Everything else parse_status emits is continuous and
# never triggers a write. ``updated_at`` is transport bookkeeping, never a
# trigger; ``state_label`` follows ``state``.
TRIGGER_FIELDS = ("state", "vehicle", "pilot", "charger_online")
class StatusSink:
    """The one status apply path, shared by the HTTP poll and MQTT snapshots.

    Both transports describe the same charger state, so history, sessions and
    transition notifications run here exactly once per real change: the edge is
    computed against the tracker's pre-tick state, which the first source
    advances, so a second source reporting the same state has no edge left.

    Applies never write ``status/current`` themselves (issue #93): each one
    updates the tracker, merges into the accumulated field view and hands the
    write decision to :class:`WritePolicy`. The scheduler opportunities are
    the applies themselves (a first snapshot, a discrete trigger whose gap is
    satisfied) and the status loop's tick (deferred triggers, forced writes,
    heartbeats -- see :meth:`publish_pending` and :meth:`publish_heartbeat`).
    The offline edge is the one exception: it still writes immediately, as an
    outage edge, outside the policy's cadences.
    """

    def __init__(
        self, db, tracker, notifier, arrivals=None, policy=None, counter=None
    ):
        self.status_doc = db.collection("status").document("current")
        self.tracker = tracker
        self.notifier = notifier
        # Successful status/current writes are counted here (issue #96);
        # ``run()`` threads one counter through every write site.
        self.counter = counter or WriteCounter()
        # The MQTT source's arrival sequence (``MqttSource.arrival_generation``).
        # An outage decision re-reads it under this lock, so a flush cannot land
        # between the "no snapshot" check and the offline write. It stays
        # ``None`` without an MQTT source: HTTP-only runs never use that path.
        self.arrivals = arrivals
        # The write policy. Injectable clock/config for the tests; the
        # production sink uses monotonic time and the env tunables.
        self.policy = policy or WritePolicy()
        # The accumulated curated view of every applied observation, and how
        # many observations have landed. A heartbeat publishes the view only
        # when an apply landed *after* its decision (the count is the
        # watermark): a fresh ``updated_at`` on stale values would corrupt
        # the app's live-cost interval.
        self._latest = {}
        self._applies = 0
        # The HTTP poll and the MQTT worker can apply at the same time; the
        # tracker's state machine is not thread-safe on its own.
        self._lock = threading.Lock()
        # MQTT applies so far. An HTTP response fetched before this mark
        # describes the charger *before* those applies, so it is dropped rather
        # than allowed to rewind the state machine and re-fire an edge.
        self._mqtt_applies = 0
        # Highest MQTT arrival sequence a reconcile has applied. A queued
        # snapshot at or below it was flushed before that reply, so applying it
        # would replay an older observation over a newer one. Arrival sequences
        # start at 1, so -1 means "no reconcile has applied yet". Only MQTT
        # records are gated on it: an HTTP reply is the newest observation that
        # exists when it applies, so it always applies and only advances the
        # watermark.
        self._reconciled_arrival = -1

    def mqtt_generation(self):
        """MQTT apply count; take it before an HTTP GET, pass it to the apply."""
        with self._lock:
            return self._mqtt_applies

    def apply_status(
        self, fields, source, complete=True, mqtt_mark=None, seed=None, arrival=None
    ):
        """Merge one parsed status snapshot and run the derived edge logic.

        ``complete`` says the snapshot is a full observation (a parsed
        ``/status`` reply); a partial MQTT snapshot only merges its fields.
        ``mqtt_mark`` is the ``mqtt_generation()`` taken before an HTTP fetch:
        if an MQTT snapshot applied since, the HTTP result is discarded and
        False is returned. ``arrival`` is the MQTT arrival sequence the data
        stands for -- the ``arrival_generation()`` taken before an HTTP GET, or
        the arrival carried by a queued MQTT snapshot: a queued snapshot no
        newer than the last reconciled arrival is discarded, and an applied HTTP
        reply records its arrival as that watermark, so records flushed before
        it are dropped. The watermark never rejects the HTTP reply itself: with
        no flush since the previous reconcile the generation it read equals the
        watermark, and that reply is still the newest observation (rejecting it
        would freeze the document on an idle charger and for the whole HTTP
        fallback); a reply's own staleness is decided by ``mqtt_mark`` and
        ``seed``. ``seed`` is a callable that merges the raw ``/status`` payload
        into the MQTT snapshot; it returns ``False`` when that reply is no
        longer current, and it runs in the same critical section as the apply,
        so a reply overtaken by newer MQTT data can neither seed nor rewind the
        snapshot. It may take the MQTT source's lock; the source never takes
        this one while holding its own.
        """
        with self._lock:
            if mqtt_mark is not None and mqtt_mark != self._mqtt_applies:
                return False
            # Only a *record* can predate a reconcile reply: it carries the
            # arrival of its flush. An HTTP apply's own arrival is the
            # generation read before its GET, which is the newest observation
            # that exists here -- a flush since then is caught by ``mqtt_mark``
            # and ``seed`` -- so the watermark is recorded, never enforced for
            # it. Enforcing it would discard every reconcile after the first
            # whenever no flush happened in between: an idle charger and the
            # whole HTTP fallback, where it would freeze the status document.
            if (
                source == "mqtt"
                and arrival is not None
                and arrival <= self._reconciled_arrival
            ):
                return False
            if seed is not None and seed() is False:
                return False
            self._apply(fields, source, complete)
            if source == "mqtt":
                self._mqtt_applies += 1
            elif arrival is not None:
                self._reconciled_arrival = arrival
            return True

    def apply_offline(self, reason):
        """Flag the charger offline through the same lock as the applies.

        The tracker and document writes happen under the apply lock, so an MQTT
        snapshot arriving now cannot leave the tracker online with an offline
        document (or a "Charger offline" push racing live data).
        """
        with self._lock:
            self._apply_offline(reason)

    def apply_offline_if_no_snapshot(self, expected_arrival, reason):
        """Flag offline only while no MQTT snapshot arrived since ``expected``.

        The caller's "the charger is silent" decision is made outside this lock,
        so it is revalidated here: the source's arrival sequence is read in the
        same critical section as the tracker/document writes. A flush that
        landed in between proves the charger is publishing, and the outage is
        refused instead of writing ``charger_online: false`` and pushing a false
        alert. A flush after this point is simply the newer observation and
        restores the online state by applying.

        Returns True when the offline transition was written, False when a
        fresh arrival refused it.
        """
        if self.arrivals is None:
            raise RuntimeError("offline guard needs an MQTT arrival source")
        with self._lock:
            if self.arrivals() != expected_arrival:
                return False
            self._apply_offline(reason)
            return True

    def _apply_offline(self, reason):
        """The offline transition; the caller holds the apply lock."""
        edge = self.tracker.charger_online is not False
        if edge:
            self.tracker.charger_online = False
        # Write the state before notifying so a slow push cannot leave the
        # app showing a stale online status.
        self.counter.counted("status", self.status_doc.set, OFFLINE, merge=True)
        # The outage edge writes immediately, outside the policy's rate limit
        # (issue #93 keeps it intact: rare, and the one write that must not
        # wait). The accumulated view and the suppression baseline still have
        # to see it, or the recovery apply's ``charger_online`` change would
        # not read as the discrete trigger it is.
        self._accumulate(OFFLINE)
        self.policy.note_external(OFFLINE)
        if edge:
            # Journal and notify once per outage, on the edge.
            log(f"charger offline ({reason})")
            self.notifier.enqueue("Charger offline")

    def maybe_seed(self):
        """Retry the stored baseline under the same lock as the applies."""
        with self._lock:
            self.tracker.maybe_seed()

    def _accumulate(self, fields):
        """Merge one parsed observation into the accumulated view (lock held).

        Returns nothing; a discrete field that moved arms the policy's
        trigger. The baseline is the accumulated view itself, so a change the
        document has not seen yet stays armed across a rate-limited deferral,
        and a burst that returns to the written values is left to no-op
        suppression at publish time.
        """
        changed = [
            name
            for name in TRIGGER_FIELDS
            if name in fields and fields[name] != self._latest.get(name)
        ]
        self._latest.update(fields)
        if changed:
            self.policy.triggered = True

    def _consider_publish(self, heartbeat=False):
        """Publish now when the policy owes a write (the lock is held).

        Heartbeat servicing is the caller's explicit business
        (:meth:`publish_heartbeat`) because it carries a freshness gate; on
        every other path an observation that may be stale must not publish on
        heartbeat grounds alone.
        """
        if not self._latest or not self._applies:
            # Nothing observed yet. The accumulated view may hold only the
            # offline merge, which is bookkeeping for the suppression baseline,
            # not an observation: the first publish follows the first apply
            # (issue #93: the first snapshot after start publishes).
            return False
        now = self.policy.clock()
        reason = self.policy.decision(now, self.tracker.state, heartbeat=heartbeat)
        if reason is None:
            return False
        if reason == "trigger" and self.policy.suppressed(self._latest):
            # The owed trigger's values all match the document: writing them
            # again would move nothing (a due heartbeat is never skipped).
            self.policy.triggered = False
            return False
        payload = dict(self._latest)
        self.counter.counted("status", self.status_doc.set, payload, merge=True)
        self.policy.record_write(payload, now)
        return True

    def publish_pending(self):
        """One scheduler tick: resolve a deferred trigger or a forced write.

        Also retries a write that failed (the policy only advances on a write
        that landed). The status loop calls this every tick; the applies call
        the same decision inline.
        """
        with self._lock:
            return self._consider_publish()

    def consider_history_flush(self):
        """Flush pending history when the charging interval elapsed (issue #94).

        The applies run the same check inline; this covers the gaps between
        them (a charger gone silent mid-charge keeps the flush schedule).
        """
        with self._lock:
            self.tracker.consider_history_flush()

    def drain_history(self):
        """Flush pending history on shutdown, under the lock like every apply.

        The status and MQTT loops are daemon threads ``run()`` never joins,
        so an apply can still be mid-flight when the drain fires; every
        other accumulator touchpoint holds this lock, and the drain must
        too, or it races the accumulator's dict state (a concurrent observe
        can crash the iteration or drop a just-accumulated delta, and a
        concurrent interval flush would double-write pending energy).
        """
        with self._lock:
            self.tracker.history.flush("shutdown")

    def heartbeat_due(self):
        """(due, watermark) for a heartbeat write, under the lock.

        ``due`` says a heartbeat write is owed (first snapshot included);
        ``watermark`` is the apply count the eventual publish must beat,
        passed to :meth:`publish_heartbeat`. A count, not a clock reading:
        the heartbeat's own forced observation may land without the clock
        moving, and it still counts.
        """
        with self._lock:
            if not self.policy.heartbeat_due(self.policy.clock(), self.tracker.state):
                return False, 0
            return True, self._applies

    def heartbeat_poll_due(self):
        """True when a heartbeat may force an HTTP reconcile on this tick."""
        with self._lock:
            return self.policy.heartbeat_poll_due(
                self.policy.clock(), self.tracker.state
            )

    def note_heartbeat_poll(self):
        """Mark one heartbeat-driven poll as attempted (paces the next)."""
        with self._lock:
            self.policy.note_heartbeat_poll(self.policy.clock(), self.tracker.state)

    def publish_heartbeat(self, watermark):
        """Write the full curated payload a heartbeat owes -- fresh values only.

        ``watermark`` is the apply count the heartbeat decision was made
        against; the publish needs an apply that landed after it (the forced
        reconcile's reply, or an MQTT apply that landed during the poll).
        None arrived -- the charger did not answer and MQTT stayed silent --
        so there is no write: a fresh ``updated_at`` on stale values is
        exactly what a heartbeat must never stamp.
        """
        with self._lock:
            now = self.policy.clock()
            if not self.policy.heartbeat_due(now, self.tracker.state):
                # The forced reconcile's own apply already published.
                return False
            if self._applies <= watermark:
                return False
            return self._consider_publish(heartbeat=True)

    def force_write(self):
        """Publish immediately, bypassing both cadences and the rate limit.

        A completed command owes the app a *status* write: ``holdAfterSnapshot``
        holds its session clock until one lands, and the command document's
        own write does not release it. With no observation yet the flag stays
        armed and the first apply publishes.
        """
        with self._lock:
            self.policy.forced = True
            return self._consider_publish()

    def note_trigger(self, reason):
        """Arm a discrete trigger from outside the apply path.

        Arms only: the value that moved must already be in the accumulated
        view, or the write this trigger causes would not carry it. The
        schedule loop uses :meth:`note_schedule`, which merges and arms
        atomically.
        """
        with self._lock:
            self.policy.note_trigger(reason)

    def note_schedule(self, schedule):
        """Feed the active schedule window in; publish it only when it changes.

        The schedule loop (#95) calls this every ``SCHEDULE_INTERVAL`` with
        ``schedule_state(plan, synced_event_rules)``. The value merges into
        the accumulated view and -- only when it actually moved -- arms the
        write policy, both under one lock hold: the status write this
        trigger causes carries the new window in its own payload, never a
        follow-up write (the same-write guarantee). An unchanged window arms
        nothing and costs zero writes. The publish attempt is inline, like
        an apply, so a crossing whose rate-limit gap is already open lands
        immediately; a deferred trigger resolves on the status loop's next
        tick.

        One narrowing is deliberate: publication still requires a first
        status apply (the ``_applies`` gate in :meth:`_consider_publish`),
        so a window that moves before any observation rides the first
        apply's write instead of publishing on its own -- unlike the old
        unconditional 60 s merge.
        """
        with self._lock:
            if self._latest.get("schedule") == schedule:
                return False
            self._latest["schedule"] = dict(schedule)
            self.policy.note_trigger("schedule window")
            return self._consider_publish()

    def _apply(self, fields, source, complete):
        tracker = self.tracker
        # The observation merges into the accumulated view first -- a discrete
        # field it moves arms the write policy's trigger -- and the write
        # itself is decided after the state machine, so the document and the
        # tracker can never disagree (issue #93: MQTT applies, the scheduler
        # writes).
        self._accumulate(fields)
        if tracker.charger_online is False:
            tracker.charger_online = True
            log(f"charger online ({source})")
        if not complete:
            # A pre-seed burst carries only the fields that changed. Merging
            # them is right, but there is no state observation to make: the
            # absent state would read as "not charging" and stop a session that
            # is still running.
            tracker.record_history(fields.get("total_energy"))
        else:
            had_state = tracker.has_state
            was_charging = tracker.has_state and tracker.previous_state == 3
            is_charging = fields.get("state") == 3
            tracker.record_history(fields.get("total_energy"))
            tracker.observe(fields)
            # The stop stamp rides the accumulated view (issue #122): the
            # tracker's charging_stopped_at is what the document should
            # carry. It merges only once one exists -- seeded from the
            # document or stamped on a stop -- or to clear one that did, so
            # payloads stay byte-identical until the first stamp, and a
            # tracker that never saw a stamp never writes the field at all.
            if (
                tracker.charging_stopped_at is not None
                or tracker.stamp_adopted
                or "charging_stopped_at" in self._latest
            ):
                self._latest["charging_stopped_at"] = tracker.charging_stopped_at
            if tracker.stamp_write_pending:
                # One forced write per charging block's stop: the same write
                # the state change already owes the policy, published at the
                # apply instead of the next gap-open scheduler opportunity,
                # so a reload right after the stop finds the field. The flag
                # is consumed here; a write that fails leaves the policy's
                # forced flag armed for the next tick's publish_pending.
                tracker.stamp_write_pending = False
                self.policy.forced = True
            body = _transition_body(had_state, was_charging, is_charging)
            if body is not None:
                self.notifier.enqueue(body)
        self._applies += 1
        self._consider_publish()
        # The history accumulator's charging interval resolves on every apply
        # (issue #94); rollover and session-close flushes fired inside the
        # record/observe calls above.
        tracker.consider_history_flush()


def mqtt_health_fields(mqtt):
    """The ``status/health`` transport facts for the current MQTT state.

    ``mqtt_connected`` is the usable path to the charger: our broker link is up
    **and** the gateway has not announced ``disconnected``. The Last Will is
    broker-side evidence that the charger is gone even while our own link stays
    healthy, so it must clear the field. ``mqtt_announced`` keeps the raw
    announce view (``None`` until the first announcement) and
    ``mqtt_last_lwt_at`` when the Last Will last fired.

    The subscription grant is deliberately not part of ``mqtt_connected``: a
    connected broker with a denied subscription is the degraded case where
    ``source`` stays ``http`` while the link is up.
    """
    announced = mqtt.announced
    return {
        "mqtt_connected": mqtt.connected and announced is not False,
        "mqtt_announced": announced,
        "mqtt_last_lwt_at": mqtt.last_lwt_at,
    }


def write_transport_health(
    db, source, mqtt_connected, announced=None, last_lwt_at=None, counter=None
):
    """Publish the active status source into status/health (merge semantics).

    Merged, never replaced: the watchdog owns the rest of the document and its
    writes merge too, so neither can clobber the other's fields. The write
    carries the rolling write counts (issue #96): this document's own
    transition-driven cadence is what exposes them, so the counter never
    costs a write.
    """
    counter = counter or WriteCounter()
    try:
        db.collection("status").document("health").set(
            {
                "source": source,
                "mqtt_connected": mqtt_connected,
                "mqtt_announced": announced,
                "mqtt_last_lwt_at": last_lwt_at,
                "updated_at": firestore.SERVER_TIMESTAMP,
                **counter.health_fields(),
            },
            merge=True,
        )
    except Exception as exc:
        counter.note_failure(exc)
        log(f"health transport write failed ({exc.__class__.__name__}: {exc})")
    else:
        counter.record("health")


# Serializes the drain-and-refill in ``enqueue_latest``: the worker only ever
# removes from the front, so producers must not interleave.
_enqueue_lock = threading.Lock()


def enqueue_latest(snapshots, snapshot):
    """Queue a delivered snapshot for the apply worker without losing an edge.

    Only the newest field set of an unchanged ``state`` is worth writing, so a
    snapshot that repeats the queued state replaces it. A snapshot that changes
    ``state`` is an edge — the start or stop of a charging session and its
    notification — so it is kept in order behind the queued ones instead of
    being discarded while the worker is busy.

    The bound reserves room for the edges: coalescing removes repeated telemetry
    only, and the queue holds ``MQTT_PENDING_SNAPSHOTS`` telemetry slots plus
    ``MQTT_PENDING_EDGES`` distinct-state records, so a blocked worker cannot
    lose a session by having its transitions mistaken for redundant telemetry.
    Past that bound — a genuinely stuck worker — the oldest transition is
    dropped and that loss is logged, never silently absorbed.

    The whole ``Snapshot`` record travels, not just its fields: its arrival and
    seeded-at-flush flag are what the worker orders it by.
    """
    with _enqueue_lock:
        pending = []
        while True:
            try:
                pending.append(snapshots.get_nowait())
            except queue.Empty:
                break
        capacity = snapshots.maxsize or MQTT_PENDING_QUEUE
        records = _coalesce(pending + [snapshot])
        if len(records) > capacity:
            overflow = len(records) - capacity
            dropped = records[:overflow]
            records = records[overflow:]
            log(
                f"mqtt snapshot backlog over capacity ({capacity}); dropped "
                f"{overflow} state transition(s), oldest state "
                f"{dropped[0].fields.get('state')}"
            )
        for record in records:
            snapshots.put_nowait(record)


def _coalesce(pending):
    """Collapse repeated telemetry; keep every state change, in order."""
    kept = []
    for record in pending:
        if kept and kept[-1].fields.get("state") == record.fields.get("state"):
            kept[-1] = record
        else:
            kept.append(record)
    return kept


