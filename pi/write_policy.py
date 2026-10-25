"""The status-write cadence policy (issue #93).

Extracted from ``bridge.py`` (behavior-preserving move): whether a
``status/current`` write follows an observation — discrete triggers, charging
and idle heartbeats, forced writes, and the rate-limit gap — is decided here
and only here.
"""

import time
from typing import NamedTuple



# --- Status write policy (issue #93) -----------------------------------------
# One scheduler owns every status/current write; MQTT applies state and never
# writes. No write may land sooner than this after the previous one (the
# worst-case bound: a flapping charger cannot exceed one write per gap).
WRITE_MIN_GAP_SEC = 30
# While charging (state 3) the continuous values -- energy, elapsed, power,
# voltage, temperatures -- are refreshed at least this often; they never
# trigger a write themselves. Idle (any other state) liveness cadence.
CHARGING_HEARTBEAT_SEC = 60
HEARTBEAT_INTERVAL = 300
def _transition_body(had_state, was_charging, is_charging):
    """FCM body for a charging-state edge, or None when there is no edge."""
    if not had_state or was_charging == is_charging:
        return None
    return "Charging started" if is_charging else "Charging stopped"


class WritePolicyConfig(NamedTuple):
    """Validated write-policy tunables; ``main()`` fills them from env."""

    min_gap: float = WRITE_MIN_GAP_SEC
    charging_heartbeat: float = CHARGING_HEARTBEAT_SEC
    idle_heartbeat: float = HEARTBEAT_INTERVAL


class WritePolicy:
    """The one cadence decision for ``status/current`` writes (issue #93).

    Every observation -- MQTT snapshots and HTTP reconciles alike -- is applied
    to the tracker and an accumulated field view; whether a *write* follows is
    decided here, by field kind:

    - Discrete triggers (``state``, ``vehicle``, ``pilot``, ``charger_online``,
      a session close, the active schedule window -- #95: the schedule loop
      arms it when the firmware's window changes) publish at the next
      scheduler opportunity, never sooner than ``min_gap`` after the previous
      write. A session close is the state edge itself, so the ``state``
      trigger carries it.
    - Continuous values (energy, elapsed, power, voltage, temperatures) never
      trigger a write: they move constantly while charging, so treating them
      as changes would degenerate into a fixed timer. They ride the
      heartbeats -- ``charging_heartbeat`` while state 3, ``idle_heartbeat``
      otherwise. ``elapsed`` in particular never triggers anything; the app
      interpolates it locally from the write anchor.
    - A forced write (a completed command, or the stop stamp of issue #122)
      bypasses both cadences and the gap.

    A heartbeat is always a full curated payload backed by a fresh
    observation, never a timestamp-only merge: a fresh ``updated_at`` on stale
    values would corrupt the app's live-cost interval. The sink enforces the
    freshness; this class owns only the arithmetic. ``last_written`` mirrors
    the document (out-of-policy merges included) for no-op suppression, which
    applies to trigger writes only -- a due heartbeat and a forced write
    always land.
    """

    def __init__(self, config=None, clock=time.monotonic):
        self.config = config or WritePolicyConfig()
        self.clock = clock
        # The policy-clock time of the last write this policy performed. The
        # offline edge writes outside the policy and deliberately does not
        # advance it: the recovery apply must still publish promptly.
        self.last_write_at = None
        self.last_written = None
        self.triggered = False
        self.forced = False
        self._next_heartbeat_poll = 0.0

    def heartbeat_period(self, state):
        """Seconds between heartbeat writes for the current charging state."""
        return (
            self.config.charging_heartbeat if state == 3 else self.config.idle_heartbeat
        )

    def heartbeat_due(self, now, state):
        """True when a heartbeat write is owed, first snapshot included."""
        return (
            self.last_write_at is None
            or now - self.last_write_at >= self.heartbeat_period(state)
        )

    def heartbeat_poll_due(self, now, state):
        """True when a heartbeat may force an HTTP reconcile now.

        Paced once per period: a failing forced reconcile (charger
        unreachable) must keep the reconcile cadence instead of re-polling on
        every 1 s tick -- two failures a second apart would flag an outage an
        idle-but-silent charger does not deserve.
        """
        return now >= self._next_heartbeat_poll and self.heartbeat_due(now, state)

    def note_heartbeat_poll(self, now, state):
        """Mark one heartbeat-driven poll as attempted (paces the next)."""
        self._next_heartbeat_poll = now + self.heartbeat_period(state)

    def note_trigger(self, reason):
        """Arm a discrete trigger; ``reason`` names it for the journal/tests.

        The schedule loop's window change (#95) lands here through
        :meth:`StatusSink.note_schedule`, which merges the new value into
        the accumulated view and arms this in one lock hold.
        """
        self.triggered = True

    def note_external(self, payload):
        """Record a write that happened outside this policy's decision.

        The document moved, so the suppression baseline must move with it:
        without this, an offline edge followed by a recovery whose other
        values are unchanged would read as a no-op and never republish
        ``charger_online: true``.
        """
        if self.last_written is None:
            self.last_written = dict(payload)
        else:
            self.last_written.update(payload)

    def decision(self, now, state, heartbeat=False):
        """The write owed at ``now``, or None.

        Priority: forced, first (no write yet -- the initial payload is due),
        trigger (gap satisfied), heartbeat (only when the caller is serving a
        due heartbeat; the apply path never publishes on heartbeat grounds --
        the observation may be stale).
        """
        if self.forced:
            return "forced"
        if self.last_write_at is None:
            return "first"
        gap = now - self.last_write_at
        if self.triggered and gap >= self.config.min_gap:
            return "trigger"
        if heartbeat and gap >= self.heartbeat_period(state):
            return "heartbeat"
        return None

    def suppressed(self, candidate):
        """True when writing ``candidate`` would change nothing.

        Compared on the candidate's own fields, ignoring ``updated_at``: a
        field the candidate does not carry (one written outside this view)
        must not keep suppression from firing.
        """
        if self.last_written is None:
            return False
        return all(
            value == self.last_written.get(key)
            for key, value in candidate.items()
            if key != "updated_at"
        )

    def record_write(self, payload, now):
        """Consume the write: cadence baseline, suppression baseline, triggers."""
        self.last_write_at = now
        self.last_written = dict(payload)
        self.triggered = False
        self.forced = False


