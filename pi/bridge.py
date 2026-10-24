#!/usr/bin/env python3
"""ChelEVSE bridge agent: OpenEVSE charger <-> Firebase Firestore.

Failure-isolated loops (daemon threads; the service never crash-loops):
  status every STATUS_INTERVAL: GET /status -> merge into status/current
  config every CONFIG_INTERVAL: GET /config -> replace status/config
  schedule every SCHEDULE_INTERVAL: schedule/current -> firmware scheduler,
    GET /schedule/plan -> the active window published on change (issue #95)
  commands every COMMAND_INTERVAL: pending commands/ docs -> charger HTTP API
  settings every SETTINGS_INTERVAL: settings/current.charger_host -> the live
    charger address, applied without a restart (CHARGER_HOST is the bootstrap)
With MQTT_ENABLED=true the status topics arrive on the MQTT source and /status
becomes reconciliation only (MQTT_RECONCILE_SEC); /config runs on a
config_version change. Everything still flows through one apply_status path.
Config: env vars with fallback to <repo root>/private/bridge.env.
"""

import hashlib
import json
import math
import os
import queue
import re
import signal
import sys
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import firebase_admin
from firebase_admin import credentials, exceptions, firestore, messaging

from mqtt_source import MqttPublishError, MqttSource

# --- Extracted-module facade --------------------------------------------------
# Behavior-preserving re-exports: everything referenced as ``bridge.X`` (tests,
# acl.py, the loops below) keeps resolving here as the god file is decomposed.
# The extracted modules never import bridge at load time; their call-time seams
# resolve through this module, so mock patches on bridge keep working.
from write_counter import (  # noqa: E402
    WRITE_BUDGET_WARNING_AT,
    WRITE_KINDS,
    WRITE_SUMMARY_INTERVAL,
    WRITE_WINDOW_SEC,
    WriteCounter,
    quota_exceeded,
)
from history_accumulator import HISTORY_FLUSH_SEC, HistoryAccumulator  # noqa: E402
from write_policy import (  # noqa: E402
    CHARGING_HEARTBEAT_SEC,
    HEARTBEAT_INTERVAL,
    WRITE_MIN_GAP_SEC,
    WritePolicy,
    WritePolicyConfig,
    _transition_body,
)
from notify import Notifier, notify  # noqa: E402
from charger_host import (  # noqa: E402
    CHARGER_HOST_LABEL_MAX_LEN,
    CHARGER_HOST_MAX_LEN,
    DEFAULT_CHARGER_HOST,
    HTTP_TIMEOUT,
    ChargerHost,
    _bootstrap_host,
    _normalize_charger_host,
    _read_charger_host,
    make_charger_session,
    seed_host,
)
from env_config import (  # noqa: E402
    DEFAULT_MQTT_CLIENT_ID,
    DEFAULT_MQTT_TOPIC,
    MQTT_RECONCILE_SEC,
    HistoryConfig,
    MqttConfig,
    WatchdogConfig,
    _env_bool,
    _env_finite,
    history_config,
    history_config_or_exit,
    mqtt_config,
    mqtt_config_or_exit,
    watchdog_config,
    watchdog_config_or_exit,
    write_policy_config,
    write_policy_config_or_exit,
)
from parsing import (  # noqa: E402
    INTERVAL_STEP_FLOOR_WH,
    MAX_INTERVAL_POWER_W,
    STATE_LABELS,
    CommandError,
    _SNAPSHOT_FIELDS,
    _SNAPSHOT_TEMPS,
    _amps,
    _gap_seconds,
    _interval_clock,
    _interval_step_allowance,
    _is_number,
    _pilot,
    _sensor_temp,
    parse_snapshot,
    parse_status,
)
from schedule import (  # noqa: E402
    FIRMWARE_DAYS,
    MAX_SCHEDULE_RULES,
    SCHEDULE_JITTER_GRACE,
    TIME_RE,
    _drop_overlaps,
    _event_days,
    _event_matches,
    _event_time,
    _hhmm_minutes,
    _http_reason,
    _log_schedule,
    _normalize_rule,
    _require_ok,
    _rule_segments,
    _schedule_plan,
    normalize_schedule,
    schedule_events,
    schedule_hash,
    schedule_state,
    sync_schedule,
)
from transport import (  # noqa: E402
    COMMAND_TYPES,
    ChargerTransport,
    MAX_AMPS,
    MIN_AMPS,
    PAUSED_STATES,
    _apply_command_http,
    _apply_override_mqtt,
    _apply_rapi_mqtt,
    _as_int,
    _command_amps,
    _command_rapi,
    _paused,
    _rapi_result,
    _require_command_ok,
    _setpoint_matches,
    _status_confirms,
    _override_confirms,
    apply_command,
    mqtt_command_ready,
)
from status_tracker import (  # noqa: E402
    MAX_SESSION_INTERVALS,
    SESSION_MERGE_MAX_GAP,
    SESSION_MERGE_TOLERANCE,
    SEED_RETRY_INTERVAL,
    StatusTracker,
    _merge_intervals,
    _merge_session,
    _usable_interval,
    _vehicle_connected,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
# First-iteration offsets so /status, /config and /schedule/plan do not fire
# together against the gateway.
CONFIG_INITIAL_DELAY = 3
SCHEDULE_INITIAL_DELAY = 7
# Retry a failed /config sync with this bounded backoff while MQTT is healthy
# (the periodic poll is skipped then, so a failure would otherwise strand the
# config until the charger's next setting change).
CONFIG_RETRY_MIN_SEC = 5
CONFIG_RETRY_MAX_SEC = 60
OFFLINE = {"charger_online": False, "updated_at": firestore.SERVER_TIMESTAMP}
# How often the status/config loops re-check the MQTT connection. The MQTT
# client itself reconnects in its own network loop; this only bounds how long a
# fallback or a config-version reaction can take.
MQTT_TICK_SEC = 1.0
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
# Consecutive failed reconciles, with no MQTT snapshot in between, before a
# silent charger is treated as an outage. An idle charger publishes nothing for
# minutes, so one failed HTTP poll next to that silence proves nothing; the
# broker-side LWT is #45.
MQTT_OUTAGE_FAILURES = 2
# Snapshot fields whose change is a discrete trigger: they publish at the next
# scheduler opportunity. Everything else parse_status emits is continuous and
# never triggers a write. ``updated_at`` is transport bookkeeping, never a
# trigger; ``state_label`` follows ``state``.
TRIGGER_FIELDS = ("state", "vehicle", "pilot", "charger_online")
# A granted subscription that never delivers a ``config_version`` still leaves
# ``status/config`` stale: sync once over HTTP straight away, then keep this
# slow safety resync until a version is observed.
CONFIG_SAFETY_RESYNC_SEC = 600
# A pending command older than this is failed without touching the charger.
COMMAND_MAX_AGE = 600
# How long an MQTT-published override command waits for the firmware's retained
# <base>/override document (or the status field) to confirm it.
COMMAND_CONFIRM_SEC = 5
# Pending commands handled per poll.
COMMAND_BATCH = 10
# Settled-but-unwritten command ids remembered per process (acked or failed), so
# a failed status write is retried instead of re-applying the command.
COMMAND_ACK_MEMORY = 256
# --- Watchdog (issue #39) ---------------------------------------------------
# A restart of the ESP32 gateway or the EVSE controller is bounded: at most this
# many attempts per trailing hour and at least a cooldown after each one, so a
# charger that stays unreachable (or is simply powered off) is never looped on.
WATCHDOG_WINDOW = 3600
WATCHDOG_ALERT_RESTART = "Charger gateway unresponsive — restart attempted"
WATCHDOG_ALERT_RESTART_EVSE = "Charger controller unresponsive — restart attempted"
WATCHDOG_ALERT_RECOVERED = "Charger recovered"
WATCHDOG_ALERT_FAILED = "Recovery failed — power cycle may be required"
WATCHDOG_ALERT_BLOCKED_CHARGING = (
    "Charger unresponsive — restart blocked while charging "
    "(set WATCHDOG_RESTART_WHILE_CHARGING=true to allow)"
)
WATCHDOG_ALERT_BLOCKED_CAP = (
    "Charger unresponsive — restart blocked (hourly restart cap reached)"
)
WATCHDOG_ALERT_BLOCKED_COOLDOWN = (
    "Charger unresponsive — restart blocked (waiting out the cooldown)"
)
WATCHDOG_RESTART_ACTIONS = frozenset({"restart_gateway", "restart_evse"})
# /config fields that must never be replicated into the cloud-readable doc.
SECRET_CONFIG_KEYS = frozenset(
    {
        "ap_pass",
        "emoncms_apikey",
        "mqtt_pass",
        "ocpp_authkey",
        "pass",
        "tesla_access_token",
        "tesla_refresh_token",
        "www_password",
    }
)
REDACTED = "***"

_stop = threading.Event()


def log(message):
    """One timestamped line to stdout; journald captures it."""
    print(
        f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}  {message}",
        flush=True,
    )


def _utcnow():
    """Current aware UTC time; one seam for tests."""
    return datetime.now(timezone.utc)


def _localnow():
    """Current aware local time; the seam the day/hour attribution reads.

    Pi-local wall clock is authoritative for ``history/<date>``: one read per
    tick keeps the document id and its hour bucket on the same instant.
    """
    return datetime.now().astimezone()


def load_env_file(path):
    """Parse KEY=VALUE lines; skip blanks, comments, and lines without '='."""
    values = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    return values


_FILE_ENV = load_env_file(REPO_ROOT / "private" / "bridge.env")


def cfg(name, default=None):
    """Real environment wins over the env file."""
    return os.environ[name] if name in os.environ else _FILE_ENV.get(name, default)


def service_account_file():
    """Resolved path to the Firebase service-account key, or None if unset."""
    key_path = cfg("FIREBASE_SERVICE_ACCOUNT")
    if not key_path:
        return None
    key_file = Path(key_path)
    if not key_file.is_absolute():
        key_file = REPO_ROOT / key_file
    return key_file


def init_firestore():
    """Initialize the Admin SDK (idempotent) and return a Firestore client."""
    key_file = service_account_file()
    if key_file is None:
        raise RuntimeError(
            "FIREBASE_SERVICE_ACCOUNT not set — see private.example/README.md"
        )
    if not key_file.is_file():
        raise RuntimeError(f"service-account key not found: {key_file}")
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(credentials.Certificate(str(key_file)))
    return firestore.client()


FIRESTORE_INT_MIN = -(2**63)
FIRESTORE_INT_MAX = 2**63 - 1


def firestore_safe(value):
    """Coerce JSON values Firestore cannot store: uint64 sentinels, NaN, inf.

    The charger reports absent numeric settings as 18446744073709551615
    (2**64 - 1), outside Firestore's signed 64-bit integer range.
    """
    if isinstance(value, dict):
        return {key: firestore_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [firestore_safe(item) for item in value]
    if isinstance(value, bool):  # bool subclasses int; keep it a bool
        return value
    if isinstance(value, int):
        if FIRESTORE_INT_MIN <= value <= FIRESTORE_INT_MAX:
            return value
        return float(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def redact_config(data):
    """Copy /config, replacing credential values with a sentinel.

    status/config is readable by every allowlisted account, so charger and
    integration secrets must never leave the LAN. Non-secret fields stay raw.
    """
    return {
        key: REDACTED if key in SECRET_CONFIG_KEYS else value
        for key, value in data.items()
    }
def settings_loop(db, host, bootstrap, interval, initial_delay=0):
    """Apply ``settings/current.charger_host`` to the running bridge.

    Its own thread, so an address saved in the app reaches every consumer
    within one interval with no restart and the same PID. Each tick:

    - a valid, changed value is adopted and logged as an old -> new transition;
    - an absent or cleared key reverts to the env bootstrap (same log, named
      ``environment``), so clearing the field in the app is the way back;
    - a malformed value is rejected with a log line and the current host is
      kept: a console-written scheme or port must not build a broken URL;
    - a read failure is logged and the current host is kept.

    Nothing reverts because the charger stopped answering: a saved value is
    honoured until the owner changes it.
    """
    fallback = _bootstrap_host(bootstrap)
    if initial_delay:
        _stop.wait(initial_delay)
    while not _stop.is_set():
        try:
            raw = _read_charger_host(db)
        except Exception as exc:
            log(
                f"charger host: settings read failed "
                f"({exc.__class__.__name__}: {exc}); keeping {host.base}"
            )
        else:
            cleared = raw is None or (isinstance(raw, str) and not raw.strip())
            target = fallback if cleared else _normalize_charger_host(raw)
            if target is None:
                log(f"charger host rejected: {raw} (keeping {host.base})")
            elif target != host.host:
                previous = host.base
                host.set(target)
                source = "environment" if cleared else "app settings"
                log(f"charger host: {previous} -> {host.base} ({source})")
        _stop.wait(interval)


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


def mqtt_status_loop(sink, snapshots):
    """Apply debounced MQTT snapshots as they arrive (state updates only).

    Runs on its own thread so a Firestore write never blocks paho's network
    loop. Every snapshot is parsed here with the same ``parse_status`` the HTTP
    poll uses, so units and derived fields match the HTTP path and only curated
    fields reach the document. A snapshot counts as a complete observation only
    once the source held a ``/status`` seed **when it was flushed** and it
    carries a numeric state; before that it is a field update only, and a seed
    that lands afterwards does not promote it. A snapshot no newer than the last
    applied reconcile is dropped: that reply already carries a later view of the
    charger. Writes are the write policy's decision (issue #93): the apply
    publishes only when a first snapshot, a discrete trigger past its rate
    limit, or a forced write is due, and the status loop's scheduler tick
    resolves the rest.
    """
    while not _stop.is_set():
        try:
            record = snapshots.get(timeout=MQTT_TICK_SEC)
        except queue.Empty:
            continue
        try:
            fields = parse_snapshot(record.fields)
            complete = bool(record.complete) and _is_number(fields.get("state"))
            if not sink.apply_status(
                fields, "mqtt", complete=complete, arrival=record.arrival
            ):
                log("mqtt snapshot dropped (a reconcile applied a newer view)")
        except Exception as exc:
            log(f"mqtt status apply failed ({exc.__class__.__name__}: {exc})")


def attempts_within(now, attempts, window):
    """Attempt timestamps inside the trailing ``window`` seconds.

    An attempt exactly ``window`` seconds old still counts, so the cap is a
    closed hour rather than one that silently forgets its oldest entry.
    """
    return [at for at in attempts if (now - at).total_seconds() <= window]


def _decision(action, reason, alert=None, transport=None):
    """One watchdog decision; ``alert`` is the push body when one is due.

    ``transport`` names the path a restart action used (``"http"``/``"mqtt"``);
    it is ``None`` for an alert or a guard-blocked ``none``.
    """
    return {"action": action, "reason": reason, "alert": alert, "transport": transport}


def recovery_decision(
    *,
    now,
    consecutive_failures,
    threshold,
    http_reachable,
    controller_ok,
    charging,
    last_attempt_at,
    attempts_in_window,
    window,
    max_attempts,
    cooldown,
    restart_while_charging,
    enabled,
    mqtt_ready=False,
):
    """Decide what the watchdog does about the current failure streak.

    Pure: every input, the clock included, is injected, so the whole guard
    matrix is testable without a charger or Firestore. ``attempts_in_window`` is
    the sequence of previous attempt times; entries older than ``window``
    seconds are ignored here, so the caller can keep the full history and let
    the window expire it.

    Returns ``{action, reason, alert, transport}``: action is ``none``,
    ``alert``, ``restart_gateway`` or ``restart_evse``, ``alert`` is the body
    the caller should push when it enters an unhealthy episode (it owns edge
    detection), and ``transport`` is the path a restart would use. A
    guard-blocked ``none`` carries a body naming the guard, so a blocked episode
    never reads as a failed restart.

    Reachability is "at least one transport can restart": HTTP answering (the
    normal path) or, when it is not, a ready MQTT link — the firmware accepts
    ``restart`` over MQTT, so a wedged HTTP server no longer means hands-on
    recovery. Both down is alert-only. The transport is chosen only for a
    restart action; every guard is transport-independent.
    """
    if not enabled:
        return _decision("none", "watchdog disabled")
    if consecutive_failures < threshold:
        return _decision(
            "none", f"{consecutive_failures}/{threshold} consecutive failures"
        )
    if not http_reachable and not mqtt_ready:
        # Neither transport can carry a restart: a gateway that answers nothing
        # and has dropped off the broker (or whose Last Will fired) needs a
        # human to power-cycle it.
        return _decision(
            "alert",
            "charger unreachable over HTTP and MQTT",
            WATCHDOG_ALERT_FAILED,
        )
    if charging and not restart_while_charging:
        return _decision(
            "none",
            "charging in progress; WATCHDOG_RESTART_WHILE_CHARGING is off",
            WATCHDOG_ALERT_BLOCKED_CHARGING,
        )
    recent = attempts_within(now, attempts_in_window, window)
    if len(recent) >= max_attempts:
        return _decision(
            "none",
            f"hourly cap reached ({len(recent)}/{max_attempts} attempts)",
            WATCHDOG_ALERT_BLOCKED_CAP,
        )
    if last_attempt_at is not None:
        if (now - last_attempt_at).total_seconds() < cooldown:
            return _decision(
                "none",
                f"cooldown after the last attempt ({cooldown:g}s)",
                WATCHDOG_ALERT_BLOCKED_COOLDOWN,
            )
    transport = "http" if http_reachable else "mqtt"
    if controller_ok:
        reason = (
            "HTTP answered but the gateway was failing"
            if http_reachable
            else "HTTP unreachable; restarting the gateway over MQTT"
        )
        return _decision(
            "restart_gateway", reason, WATCHDOG_ALERT_RESTART, transport
        )
    reason = (
        "controller is not answering"
        if http_reachable
        else "HTTP unreachable; controller was not answering; restarting it over MQTT"
    )
    return _decision("restart_evse", reason, WATCHDOG_ALERT_RESTART_EVSE, transport)


def _counter_delta(before, after):
    """Increment of a cumulative firmware counter, or None when unusable."""
    if not (_is_number(before) and _is_number(after)):
        return None
    delta = after - before
    return delta if delta >= 0 else None


def controller_healthy(previous, latest):
    """True when the EVSE controller looks alive from two ``/status`` samples.

    Firmware v5.1.5 reports cumulative ``comm_sent``/``comm_success`` counters
    (RAPI commands sent to the controller and answered) plus ``rapi_connected``
    and ``evse_connected``. A frozen success count while commands keep being
    sent, or a dropped connection flag, is a controller-side failure; a healthy
    controller behind an HTTP server that stopped answering is gateway-side.
    Missing fields (other firmware) are assumed healthy: the watchdog must not
    invent a controller fault it cannot see.
    """
    if not isinstance(latest, dict):
        return True
    for flag in ("rapi_connected", "evse_connected"):
        value = latest.get(flag)
        if value is not None and not value:
            return False
    if isinstance(previous, dict):
        sent = _counter_delta(previous.get("comm_sent"), latest.get("comm_sent"))
        success = _counter_delta(
            previous.get("comm_success"), latest.get("comm_success")
        )
        if sent is not None and success is not None and sent > 0 and success <= 0:
            return False
    return True


class Watchdog:
    """Bounded recovery for a stalled gateway or controller (issue #39).

    Holds the failure streak, the last two successful ``/status`` samples and
    the restart-attempt history; ``recovery_decision`` stays pure. This class
    only feeds it, performs the restart, publishes ``status/health`` and raises
    the edge notifications (one per unhealthy episode, one on recovery, one when
    a restart did not bring the charger back or the allowance is spent).

    ``mqtt`` (an ``MqttSource``) adds the MQTT restart path: a ready link lets a
    restart go out when HTTP cannot answer, and the gateway's Last Will counts
    as its being unavailable even while our broker link stays up. The HTTP
    probe is still the only source of controller classification — ``comm_*``
    and ``rapi_connected`` are not published over MQTT.
    """

    def __init__(
        self,
        db,
        host,
        auth,
        transport,
        notifier,
        config,
        clock=None,
        mqtt=None,
        counter=None,
    ):
        self.db = db
        self.host = host
        self.auth = auth
        self.transport = transport
        self.notifier = notifier
        self.config = config
        self.clock = clock or _utcnow
        self.mqtt = mqtt
        # Successful health writes are counted here (issue #96); the same
        # counter as every other write site's.
        self.counter = counter or WriteCounter()
        self.health_doc = db.collection("status").document("health")
        self.failures = 0
        self.samples = []
        self.attempts = []
        self.last_attempt_at = None
        self.state = None  # None (no observation yet) | "healthy" | "unhealthy"
        self.reason = "starting"
        self.last_action = None
        self.last_transport = None
        self.last_result = None
        self.last_decision = None
        self.failed_alerted = False
        self.episode_attempts = 0

    def _remember(self, payload):
        """Keep the last two successful samples for controller classification."""
        self.samples.append(payload)
        del self.samples[:-2]

    def _controller_ok(self):
        latest = self.samples[-1] if self.samples else None
        previous = self.samples[-2] if len(self.samples) > 1 else None
        return controller_healthy(previous, latest)

    def _probe(self):
        """One fresh ``/status`` request: ``(http_ok, payload or None)``.

        A restart is only worth attempting when the gateway answers this request
        with a usable ``/status`` reply; a timeout, connection error, auth
        failure or non-2xx reply means the watchdog cannot reach it (or the
        config is wrong) and alerts instead. A stale pooled socket can make the
        probe fail where a later poll would succeed: treated as unreachable
        (conservative), and the next successful poll clears the streak.
        """
        try:
            resp = self.transport.get(
                f"{self.host.base}/status", auth=self.auth, timeout=HTTP_TIMEOUT
            )
            resp.raise_for_status()
            payload = resp.json()
            if not isinstance(payload, dict):
                raise ValueError("status response is not a JSON object")
        except (requests.RequestException, ValueError) as exc:
            log(f"watchdog: probe failed ({_offline_reason(exc)})")
            return False, None
        return True, payload

    def _mqtt_ready(self):
        """True when an MQTT restart would reach the charger.

        The link and its subscription must be granted, and the gateway must not
        have announced ``disconnected``: a Last Will means the charger is gone
        (or rebooting) even though our own broker connection is healthy.
        """
        mqtt = self.mqtt
        if mqtt is None:
            return False
        return bool(mqtt.mqtt_ready and mqtt.announced is not False)

    def _decide(self, now, charging, http_ok, controller_ok, mqtt_ready):
        return recovery_decision(
            now=now,
            consecutive_failures=self.failures,
            threshold=self.config.threshold,
            http_reachable=http_ok,
            controller_ok=controller_ok,
            charging=charging,
            last_attempt_at=self.last_attempt_at,
            attempts_in_window=self.attempts,
            window=WATCHDOG_WINDOW,
            max_attempts=self.config.max_per_hour,
            cooldown=self.config.cooldown,
            restart_while_charging=self.config.restart_while_charging,
            enabled=self.config.enabled,
            mqtt_ready=mqtt_ready,
        )

    def _restart(self, device):
        """POST /restart for one device; return a short result string."""
        try:
            resp = self.transport.post(
                f"{self.host.base}/restart",
                json={"device": device},
                auth=self.auth,
                timeout=HTTP_TIMEOUT,
            )
            _require_ok(resp)
        except (CommandError, requests.RequestException) as exc:
            return f"failed ({exc})"
        return f"HTTP {resp.status_code}"

    def _restart_mqtt(self, device):
        """Publish ``<base>/restart`` for one device; return a short result.

        Fire-and-forget at QoS 0 (the issue's default): the firmware restarts on
        receipt and drops the connection, so a grant would not survive to prove
        anything. The caller waits for the next successful probe before clearing
        health, which is the real proof.
        """
        try:
            self.mqtt.publish("restart", json.dumps({"device": device}), qos=0)
        except MqttPublishError as exc:
            return f"failed ({exc})"
        return "MQTT published"

    def _attempt(self, action, now, http_ok, controller_ok, charging, transport):
        """Send one restart and record its outcome."""
        device = "evse" if action == "restart_evse" else "gateway"
        inputs = (
            f"failures={self.failures} http_ok={http_ok} "
            f"controller_ok={controller_ok} charging={charging}"
        )
        if transport == "mqtt":
            log(
                f"watchdog: {action} -> mqtt restart device={device} "
                f"({inputs} mqtt_ready=True)"
            )
            self.last_result = self._restart_mqtt(device)
        else:
            log(
                f"watchdog: {action} -> POST /restart device={device} ({inputs})"
            )
            self.last_result = self._restart(device)
        self.last_attempt_at = now
        self.attempts.append(now)
        self.last_action = action
        self.last_transport = transport
        self.episode_attempts += 1
        log(f"watchdog: restart device={device} via {transport} -> {self.last_result}")

    def _cap_reached(self, now):
        recent = attempts_within(now, self.attempts, WATCHDOG_WINDOW)
        return len(recent) >= self.config.max_per_hour

    def _log_decision(self, decision):
        key = (decision["action"], decision["reason"])
        if key != self.last_decision:
            self.last_decision = key
            log(f"watchdog: {decision['action']} ({decision['reason']})")

    def write_health(self, http_ok, controller_ok):
        """Publish status/health; a failed write is a log line, not a crash.

        Called on every state transition and every attempt, not on every tick,
        so a healthy bridge writes it once. Merged so neither writer erases the
        other's fields: the transport fields (``source``, ``mqtt_connected``,
        the Last Will pair) are refreshed from the live source here, so a
        watchdog write cannot leave a stale announcement behind. The write
        also carries the rolling write counts (issue #96) -- riding this
        document's transition cadence is how the counter is exposed without
        costing a write.
        """
        now = self.clock()
        document = {
            "state": self.state,
            "reason": self.reason,
            "http_ok": http_ok,
            "controller_ok": controller_ok,
            "last_attempt_at": self.last_attempt_at,
            "attempts_last_hour": len(
                attempts_within(now, self.attempts, WATCHDOG_WINDOW)
            ),
            "last_action": self.last_action,
            "last_transport": self.last_transport,
            "last_result": self.last_result,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }
        if self.mqtt is not None:
            document.update(mqtt_health_fields(self.mqtt))
        document.update(self.counter.health_fields())
        try:
            self.health_doc.set(document, merge=True)
        except Exception as exc:
            self.counter.note_failure(exc)
            log(f"watchdog: health write failed ({exc.__class__.__name__}: {exc})")
        else:
            self.counter.record("health")

    def record_success(self, payload):
        """A successful ``/status`` poll: clear the streak and note recovery."""
        if not self.config.enabled:
            return
        self._remember(payload)
        self.failures = 0
        if self.state == "healthy":
            return
        previous, self.state = self.state, "healthy"
        self.reason = "status polls succeeding"
        self.last_decision = None
        self.failed_alerted = False
        self.episode_attempts = 0
        self.write_health(True, self._controller_ok())
        if previous == "unhealthy":
            log("watchdog: charger recovered")
            self.notifier.enqueue(WATCHDOG_ALERT_RECOVERED)

    def observe_failure(self, charging):
        """Count one failed poll; act once the streak reaches the threshold.

        ``charging`` is the last known charging state: with no successful poll
        there is no fresher one, and a stale "charging" must keep blocking a
        restart rather than interrupting a session.
        """
        if not self.config.enabled:
            return
        self.failures += 1
        if self.failures < self.config.threshold:
            return
        now = self.clock()
        http_ok, payload = self._probe()
        if payload is not None:
            self._remember(payload)
        controller_ok = self._controller_ok()
        mqtt_ready = self._mqtt_ready()
        decision = self._decide(now, charging, http_ok, controller_ok, mqtt_ready)
        action = decision["action"]
        entered = self.state != "unhealthy"
        if entered:
            self.state = "unhealthy"
            self.failed_alerted = False
            self.episode_attempts = 0
            log(
                f"watchdog: unhealthy after {self.failures} failed polls "
                f"(http_ok={http_ok} controller_ok={controller_ok} "
                f"charging={charging} mqtt_ready={mqtt_ready})"
            )
        self.reason = decision["reason"]
        self._log_decision(decision)

        alert = decision["alert"] if entered else None
        changed = entered
        if action in WATCHDOG_RESTART_ACTIONS:
            self._attempt(
                action, now, http_ok, controller_ok, charging, decision["transport"]
            )
            changed = True
        elif action == "alert":
            if self.episode_attempts and not self.failed_alerted:
                # The probe cannot reach a gateway that a restart was meant to
                # revive: automatic recovery has failed, which is exactly what
                # the operator has to hear. Once per episode.
                alert = WATCHDOG_ALERT_FAILED
                self.failed_alerted = True
                changed = True
        elif (
            self.episode_attempts
            and self._cap_reached(now)
            and not self.failed_alerted
        ):
            # This episode already spent an attempt and the hour's allowance is
            # gone while the charger is still down. The last attempt stays on
            # record; only the push is added.
            alert = WATCHDOG_ALERT_FAILED
            self.failed_alerted = True
            changed = True

        if self.last_attempt_at is None:
            # Nothing was ever attempted, so there is no attempt to report: say
            # what the watchdog did (or why a guard stopped it) instead of
            # claiming the last attempt's fields. It never ran on a transport
            # either, so last_transport stays null.
            self.last_action = "alert" if action == "alert" else "none"
            self.last_result = (
                f"{decision['reason']}; not restarted"
                if action == "alert"
                else decision["reason"]
            )
        if alert == WATCHDOG_ALERT_FAILED:
            # One "recovery failed" push per unhealthy episode.
            self.failed_alerted = True
        if changed:
            self.write_health(http_ok, controller_ok)
        if alert is not None:
            self.notifier.enqueue(alert)


def _offline_reason(exc):
    """Classify a failed status poll for the journal (auth/HTTP/transport)."""
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return _http_reason(exc.response)
    detail = str(exc).strip()[:120]
    reason = exc.__class__.__name__
    return f"{reason}: {detail}" if detail else reason


def status_loop(
    db,
    host,
    auth,
    transport,
    interval,
    tracker,
    notifier,
    watchdog,
    mqtt=None,
    reconcile_interval=MQTT_RECONCILE_SEC,
    sink=None,
):
    """Poll /status and apply it; with MQTT, poll only to reconcile.

    With ``mqtt`` the status topics are the primary source (applied by
    ``mqtt_status_loop``) and this loop polls every ``reconcile_interval`` for
    staleness cover and to seed the snapshot with HTTP-only fields. When the
    broker is down it falls back to ``interval`` and flags offline exactly as
    before; an HTTP failure while MQTT is connected is logged and feeds the
    watchdog, but only marks the charger offline after repeated failures with no
    MQTT snapshot in between (an idle charger is silent by design).

    The loop is also the write-policy scheduler's tick (issue #93): each pass
    resolves a deferred trigger or a forced write, and a due heartbeat forces a
    fresh HTTP observation (ahead of the reconcile cadence in MQTT mode) before
    publishing the full curated payload. Without MQTT every tick already polls,
    so the heartbeat just publishes what the poll applied.
    """
    sink = sink or StatusSink(
        db,
        tracker,
        notifier,
        arrivals=mqtt.arrival_generation if mqtt is not None else None,
    )
    source = None
    transport_state = None
    next_poll = 0.0
    mqtt_snapshots = 0
    # Consecutive failed reconciles with no MQTT snapshot in between: one
    # failure next to a silent idle charger is not outage evidence.
    reconcile_failures = 0
    while not _stop.is_set():
        now = time.monotonic()
        announced = mqtt.announced if mqtt is not None else None
        # The usable path to the charger, not just our link: a gateway that has
        # announced `disconnected` (its Last Will) is gone even while the broker
        # connection stays up, so status falls back to HTTP and health says so.
        mqtt_connected = (
            mqtt is not None and mqtt.connected and announced is not False
        )
        # A granted subscription is what makes the topics a status source: a
        # broker that accepts the connection and then denies ``<topic>/#``
        # delivers nothing, which looks exactly like an idle charger. Until the
        # SUBACK grants it the HTTP poll is the source, and a denial keeps it
        # there (logged once per source change) with the 10 s cadence.
        mqtt_ready = mqtt is not None and mqtt.mqtt_ready and announced is not False
        current = "mqtt" if mqtt_ready else "http"
        # The triplet, not just the source: a link that drops while the source
        # stays ``http`` (a denied subscription, then a disconnect) still has to
        # refresh ``status/health.mqtt_connected``, and the first announcement
        # must land even though nothing else changed.
        if (
            mqtt is not None
            and (current, mqtt_connected, announced) != transport_state
        ):
            previous, transport_state = transport_state, (
                current,
                mqtt_connected,
                announced,
            )
            previous = previous[0] if previous is not None else None
            source = current
            if mqtt_ready:
                detail = "mqtt connected"
                mqtt_snapshots = mqtt.snapshots
            elif mqtt.connected and not mqtt.mqtt_ready:
                detail = f"mqtt connected, {mqtt.subscription} not subscribed"
            elif mqtt.connected:
                detail = "mqtt connected, gateway announced disconnected"
            elif previous == "mqtt":
                detail = f"mqtt disconnected after {mqtt.messages} messages"
            else:
                detail = "mqtt not connected"
            log(f"status source: {source} ({detail})")
            write_transport_health(
                db,
                source,
                mqtt_connected,
                announced,
                mqtt.last_lwt_at,
                counter=sink.counter,
            )
            reconcile_failures = 0
            next_poll = now
        try:
            # A due heartbeat forces a fresh HTTP observation before any
            # publish: a heartbeat is a full curated payload, never a
            # republish of stale values. The forced poll is paced once per
            # heartbeat period so a failing one keeps the reconcile cadence.
            heartbeat, watermark = sink.heartbeat_due()
            force_poll = heartbeat and sink.heartbeat_poll_due()
            # Without MQTT the wait interval is the cadence (unchanged): every
            # tick polls, and the heartbeat then just publishes what the poll
            # applied. With MQTT the loop ticks every second and polls when
            # reconciliation is due, the source just changed, or a heartbeat
            # needs its fresh observation.
            if mqtt is None or now >= next_poll or force_poll:
                if heartbeat:
                    # This poll serves the heartbeat, forced or not: pace the
                    # next heartbeat poll a full period out so a failing
                    # reconcile keeps the reconcile cadence (two failures a
                    # second apart would flag an outage an idle charger does
                    # not deserve).
                    sink.note_heartbeat_poll()
                # The deadline advances before the poll body: a Firestore
                # failure inside the apply must not leave it overdue, or the 1 s
                # tick turns into a 1 Hz charger poll for the whole outage.
                next_poll = now + (reconcile_interval if mqtt_ready else interval)
                sink.maybe_seed()
                # MQTT applies that land while the GET is in flight make this
                # response stale: it was generated before them. A flush that is
                # only queued has not applied yet, so the apply counter stands
                # still; its arrival counter is what catches that race.
                mqtt_mark = sink.mqtt_generation() if mqtt is not None else None
                mqtt_arrivals = mqtt.arrival_generation() if mqtt is not None else None
                try:
                    resp = transport.get(
                        f"{host.base}/status", auth=auth, timeout=HTTP_TIMEOUT
                    )
                    resp.raise_for_status()
                    payload = resp.json()
                    if not isinstance(payload, dict):
                        raise ValueError("status response is not a JSON object")
                    fields = parse_status(payload)
                except (requests.RequestException, ValueError) as exc:
                    if mqtt_ready and mqtt.snapshots != mqtt_snapshots:
                        # The charger is publishing: the failure belongs to the
                        # reconciliation path, not to the charger.
                        log(f"status reconcile failed ({_offline_reason(exc)})")
                        # Compare the next failure against this check, not the
                        # last successful poll (which may be long past).
                        mqtt_snapshots = mqtt.snapshots
                        reconcile_failures = 0
                    elif mqtt_ready:
                        # No snapshot since the last reconcile: the charger may
                        # be idle (normal) or gone, and one failed poll cannot
                        # tell them apart. Ask for consecutive evidence before
                        # writing an outage and pushing it.
                        reconcile_failures += 1
                        if reconcile_failures < MQTT_OUTAGE_FAILURES:
                            log(
                                f"status reconcile failed ({_offline_reason(exc)}); "
                                "no mqtt snapshot, outage unconfirmed"
                            )
                        elif not sink.apply_offline_if_no_snapshot(
                            mqtt_snapshots, _offline_reason(exc)
                        ):
                            # A flush landed between the comparison above and
                            # the offline decision. That is the same proof of
                            # life the first branch uses, so the outage is
                            # refused and the streak restarts from this
                            # snapshot.
                            log(
                                f"status reconcile failed ({_offline_reason(exc)}); "
                                "mqtt snapshot arrived, outage refused"
                            )
                            mqtt_snapshots = mqtt.snapshots
                            reconcile_failures = 0
                    else:
                        # Charger unreachable or sent garbage: flag offline
                        # through the sink lock, so the tracker and document
                        # writes cannot interleave with an MQTT apply. Journal
                        # and push once per outage.
                        sink.apply_offline(_offline_reason(exc))
                    # Only a successful HTTP poll clears the streak, so a
                    # failure still means what it always meant to the watchdog.
                    watchdog.observe_failure(tracker.state == 3)
                else:
                    # Seed before applying: the snapshot then carries the
                    # fields MQTT never publishes (comm_*, rapi_connected).
                    # The seed stays raw; every delivery is parsed. Freshness
                    # and seed are one compare-and-merge in the source, and the
                    # apply is one locked decision with it, so a reply a flush or
                    # an apply overtook can neither rewind the snapshot nor be
                    # applied.
                    seed_snapshot = (
                        (lambda: mqtt.seed_if_current(mqtt_arrivals, payload))
                        if mqtt is not None
                        else None
                    )
                    if not sink.apply_status(
                        fields,
                        "http",
                        mqtt_mark=mqtt_mark,
                        seed=seed_snapshot,
                        arrival=mqtt_arrivals,
                    ):
                        # An MQTT snapshot applied, or a flush queued one, while
                        # this poll was in flight, so the reply predates it;
                        # applying it would rewind the tracker and re-fire a
                        # transition (a stale state=3 after an MQTT stop).
                        log("status reconcile discarded (mqtt advanced during the poll)")
                    else:
                        if mqtt is not None:
                            mqtt_snapshots = mqtt.snapshots
                        reconcile_failures = 0
                    watchdog.record_success(payload)
            if heartbeat:
                # Publishes only when the poll (or an MQTT apply that landed
                # during it) produced an observation newer than the watermark;
                # a failed poll never stamps stale values fresh.
                sink.publish_heartbeat(watermark)
            # Deferred triggers, forced writes and owed retries resolve here,
            # one scheduler tick at a time.
            sink.publish_pending()
            # The history accumulator's charging interval resolves here too
            # (issue #94): applies carry it between ticks, and a tick covers
            # an apply gap.
            sink.consider_history_flush()
            # The write counter's hourly journal summary (issue #96) rides
            # the same tick: the counter keeps its own lock and its own
            # clock, so this is just the scheduler opportunity.
            sink.counter.maybe_summary()
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"status loop error ({exc.__class__.__name__}: {exc})")
        _stop.wait(interval if mqtt is None else MQTT_TICK_SEC)


def config_loop(
    db,
    host,
    auth,
    transport,
    interval,
    initial_delay=0,
    mqtt=None,
    config_event=None,
    tick=MQTT_TICK_SEC,
    counter=None,
):
    """Sync /config; with MQTT, only when ``config_version`` changed.

    The version event is set by the MQTT source. While the broker is connected
    *and the subscription is granted* the periodic HTTP poll is skipped; the
    ``tick`` wait bounds how long a disconnect can go unnoticed (then the 60 s
    poll resumes). A denied ``<base>/#`` subscription delivers no
    ``config_version`` at all, so it cannot be the trigger: the poll stays the
    source (logged once per source change) instead of freezing the config.

    A *granted* subscription can be silent too (topic mismatch, charger-side
    MQTT off, no retained version). Waiting on an event that never comes would
    leave ``status/config`` stale forever, so until a ``config_version`` is
    observed the loop bootstraps over HTTP immediately and then resyncs at
    ``CONFIG_SAFETY_RESYNC_SEC``, logging the degraded state once.

    A failed sync must not leave the config stale until the charger's next
    setting change, so the failed trigger is consumed and the retry is owed
    under ``pending``/``retry_at`` with a bounded backoff. A write that fails
    after a good fetch is the same failure as a failed fetch: the document is
    equally stale. A version change that arrives meanwhile (the retained value
    republished on a reconnect is one) retries immediately.
    """
    config_doc = db.collection("status").document("config")
    # Successful config writes are counted here (issue #96).
    counter = counter or WriteCounter()
    last_synced = None
    # A sync is owed after a failure; retry_at is the current backoff deadline.
    pending = False
    retry_delay = 0.0
    retry_at = 0.0
    # When the next HTTP safety sync is due while no config_version is observed.
    next_sync = 0.0
    # The silent-subscription state is degraded and worth one journal line.
    version_missing_logged = False

    def retry(exc):
        """Consume the trigger and arm the bounded retry after a failed sync."""
        nonlocal retry_delay, retry_at, pending
        retry_delay = min(
            max(retry_delay * 2, CONFIG_RETRY_MIN_SEC), CONFIG_RETRY_MAX_SEC
        )
        retry_at = time.monotonic() + retry_delay
        # The owed retry is tracked here, so the trigger is consumed; a *new*
        # version still retries immediately.
        config_event.clear()
        pending = True
        log(
            f"config sync failed ({exc.__class__.__name__}); "
            f"retrying in {retry_delay:g}s"
        )

    if initial_delay:
        # Offset from the other pollers; only the first iteration is delayed.
        _stop.wait(initial_delay)
    source = None
    while not _stop.is_set():
        mqtt_mode = False
        version = None
        try:
            connected = mqtt is not None and mqtt.connected
            # A granted subscription is what makes the version event a sync
            # trigger: a broker that accepts the connection and then denies
            # ``<topic>/#`` delivers no ``config_version`` ever, so waiting on
            # the event would freeze ``status/config`` for as long as the link
            # stays up. Until the SUBACK grants it the HTTP poll is the source
            # and keeps its own cadence. A gateway that announced
            # ``disconnected`` publishes nothing at all, so it is treated the
            # same way: no event will arrive, and the HTTP poll resumes.
            mqtt_mode = (
                connected
                and mqtt.announced is not False
                and config_event is not None
                and mqtt.subscribed
            )
            if mqtt is not None:
                current = "mqtt" if mqtt_mode else "http"
                if current != source:
                    source = current
                    if mqtt_mode:
                        detail = "mqtt connected"
                    elif not connected:
                        detail = "mqtt not connected"
                    elif mqtt.announced is False:
                        detail = "mqtt connected, gateway announced disconnected"
                    elif config_event is None:
                        detail = "mqtt connected, no config version trigger"
                    else:
                        detail = f"mqtt connected, {mqtt.subscription} not subscribed"
                    log(f"config source: {current} ({detail})")
            if mqtt_mode:
                now = time.monotonic()
                version_known = getattr(mqtt, "config_version", None) is not None
                if not version_known:
                    # A granted subscription with no version: the event may
                    # never be set, so bootstrap over HTTP and keep a slow
                    # safety resync instead of waiting on it.
                    if not version_missing_logged:
                        log(
                            "config: mqtt subscribed but no config_version observed; "
                            f"syncing over HTTP every {CONFIG_SAFETY_RESYNC_SEC:g}s "
                            "until one arrives"
                        )
                        version_missing_logged = True
                    if not pending and now < next_sync:
                        config_event.wait(min(tick, next_sync - now))
                        continue
                elif version_missing_logged:
                    version_missing_logged = False
                if pending and now < retry_at:
                    # Waiting out a failed sync's backoff; a new version is a
                    # reason to retry now rather than when it expires.
                    if not config_event.wait(min(tick, retry_at - now)):
                        continue
                elif version_known and not pending and not config_event.wait(tick):
                    # Only a config_version change (or a reconnect republish)
                    # syncs.
                    continue
                # Advance the safety deadline before the fetch: a failure must
                # not leave it in the past and turn the tick into a hot loop.
                next_sync = time.monotonic() + CONFIG_SAFETY_RESYNC_SEC
                version = getattr(mqtt, "config_version", None)
            try:
                resp = transport.get(f"{host.base}/config", auth=auth, timeout=HTTP_TIMEOUT)
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    raise ValueError("config response is not a JSON object")
            except (requests.RequestException, ValueError) as exc:
                if mqtt_mode:
                    retry(exc)
                else:
                    log(f"config sync failed ({exc.__class__.__name__})")
            else:
                try:
                    redacted = redact_config(data)
                    safe_data = firestore_safe(redacted)
                    config_doc.set(
                        {**safe_data, "updated_at": firestore.SERVER_TIMESTAMP}
                    )
                except Exception as exc:
                    counter.note_failure(exc)
                    if not mqtt_mode:
                        # Unchanged flag-off path: the loop's error handler logs
                        # a non-fetch failure.
                        raise
                    # A failed write leaves the config as stale as a failed
                    # fetch, so it takes the same bounded retry instead of
                    # escaping with the trigger still set (a hot loop).
                    retry(exc)
                else:
                    counter.record("config")
                    if config_event is not None:
                        config_event.clear()
                        if (
                            mqtt_mode
                            and getattr(mqtt, "config_version", None) != version
                        ):
                            # The version moved while the fetch was in flight:
                            # keep the newer change pending instead of losing it.
                            config_event.set()
                    pending = False
                    retry_delay = 0.0
                    retry_at = 0.0
                    # Only log when the charger config actually changed: this
                    # loop runs every minute and would otherwise spam the
                    # journal.
                    if data != last_synced:
                        secret_count = sum(
                            1 for key in data if key in SECRET_CONFIG_KEYS
                        )
                        if secret_count:
                            log(f"config: redacted {secret_count} credential fields")
                        if firestore_safe(data) != data:
                            log("config: coerced values Firestore cannot store")
                        log("config synced")
                        last_synced = data
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"config loop error ({exc.__class__.__name__}: {exc})")
        if mqtt_mode:
            # Never spin: the tail wait bounds every MQTT-mode iteration, so
            # even a failure that escaped the backoff costs at most one tick.
            _stop.wait(tick)
        else:
            _stop.wait(interval)


def _command_created_at(cmd):
    """created_at as an aware datetime, or None when absent/malformed."""
    value = cmd.get("created_at")
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    timestamp = getattr(value, "timestamp", None)
    if callable(timestamp):
        try:
            seconds = timestamp()
        except Exception:
            return None
        if _is_number(seconds):
            return datetime.fromtimestamp(float(seconds), timezone.utc)
    if _is_number(value):
        return datetime.fromtimestamp(float(value), timezone.utc)
    return None


def _command_sort_key(cmd):
    """Oldest first; docs without created_at sort first (they cannot be aged)."""
    created = _command_created_at(cmd)
    return (created is not None, created.timestamp() if created is not None else 0.0)


def command_is_stale(cmd, now=None):
    """True when a pending command is older than COMMAND_MAX_AGE."""
    created = _command_created_at(cmd)
    if created is None:
        # Rules do not require created_at; tolerate such docs rather than
        # leaving them pending forever. They cannot be proven stale.
        return False
    now = now or _utcnow()
    return (now - created).total_seconds() > COMMAND_MAX_AGE


def _command_data(doc):
    """Document data as a dict; malformed docs become empty (and fail closed)."""
    data = doc.to_dict()
    return data if isinstance(data, dict) else {}


def pending_commands(db):
    """Pending commands, oldest first, without a composite index.

    Filtering on status alone uses Firestore's automatic single-field index;
    ordering by created_at would exclude docs missing the field (and needs a
    composite index). Sort in Python instead, tolerating missing timestamps.
    """
    query = db.collection("commands").where(
        filter=firestore.FieldFilter("status", "==", "pending")
    )
    docs = sorted(query.stream(), key=lambda doc: _command_sort_key(_command_data(doc)))
    return docs[:COMMAND_BATCH]


def command_loop(
    db, host, auth, transport, interval, source=None, sink=None, counter=None
):
    # Commands already applied — acked or failed — whose status write did not
    # land. Retry the write, never the command: an accepted MQTT publish must
    # not be repeated (over MQTT or HTTP). Bounded and process-local, so a gap
    # spanning a restart can still re-apply (at-least-once across restarts).
    settled = OrderedDict()
    # Successful command status writes are counted here (issue #96).
    counter = counter or WriteCounter()
    last_transport = None
    # Readiness from the last command picked up, used only to word the
    # transport edge log (a retried settled doc may reuse it).
    selected = "http"
    while not _stop.is_set():
        try:
            for doc in pending_commands(db):
                cmd = _command_data(doc)
                if doc.id in settled:
                    # Already settled; only its status write still needs to land.
                    fields = settled[doc.id]
                else:
                    if command_is_stale(cmd):
                        reason = f"stale command (older than {COMMAND_MAX_AGE}s)"
                        try:
                            doc.reference.update({"status": "failed", "error": reason})
                        except Exception as exc:
                            counter.note_failure(exc)
                            log(
                                f"command {doc.id} stale update failed "
                                f"({exc.__class__.__name__}: {exc})"
                            )
                            continue
                        counter.record("command")
                        log(f"command {doc.id} failed: {reason}")
                        continue
                    selected = "mqtt" if mqtt_command_ready(source) else "http"
                    try:
                        extra = apply_command(
                            transport, host, auth, cmd, source=source
                        )
                    except CommandError as exc:
                        # `transport` names the path that carried the request;
                        # a command rejected before any send has none.
                        fields = {"status": "failed", "error": str(exc)}
                        if exc.transport is not None:
                            fields["transport"] = exc.transport
                    except requests.RequestException as exc:
                        # Only an HTTP command send raises these: the MQTT
                        # reconcile catches its own request errors.
                        fields = {
                            "status": "failed",
                            "error": f"charger request failed ({exc.__class__.__name__})",
                            "transport": "http",
                        }
                    else:
                        extra.setdefault("transport", "http")
                        fields = {"status": "acked", **extra}
                    settled[doc.id] = fields
                    while len(settled) > COMMAND_ACK_MEMORY:
                        settled.popitem(last=False)
                used = fields.get("transport")
                if used is not None and used != last_transport:
                    if used == "mqtt":
                        detail = "mqtt connected and subscribed"
                    elif selected == "mqtt":
                        detail = "mqtt publish was refused"
                    else:
                        detail = "mqtt unavailable before publish"
                    log(f"command transport: {used} ({detail})")
                    last_transport = used
                try:
                    doc.reference.update(fields)
                except Exception as exc:
                    counter.note_failure(exc)
                    log(
                        f"command {doc.id} status update failed "
                        f"({exc.__class__.__name__}: {exc}); will retry without re-applying"
                    )
                    continue
                counter.record("command")
                settled.pop(doc.id, None)
                if fields["status"] == "acked":
                    log(f"command {doc.id} acked: {cmd.get('type')}")
                    # The app's holdAfterSnapshot holds its session clock until
                    # a *status* write lands; this document's own write does
                    # not release it, so a completed command forces one
                    # immediately, bypassing the write policy's cadences
                    # (issue #93). A failed command forces nothing: the app
                    # clears its hold only when the send itself fails
                    # client-side, so a bridge-reported failure leaves the
                    # held clock frozen until the next heartbeat (<=60 s
                    # while charging) -- self-clearing, and cheaper than a
                    # write per failed command.
                    if sink is not None:
                        try:
                            sink.force_write()
                        except Exception as exc:
                            log(
                                f"forced status write failed "
                                f"({exc.__class__.__name__}: {exc}); will retry"
                            )
                else:
                    log(f"command {doc.id} failed: {fields['error']}")
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"command loop error ({exc.__class__.__name__}: {exc})")
        _stop.wait(interval)




def schedule_loop(
    db, host, auth, transport, interval, reconcile_interval, sink, initial_delay=0
):
    """Mirror schedule/current into the firmware and publish the live window.

    ``sink`` is the run's :class:`StatusSink`: the firmware's active window
    reaches ``status/current.schedule`` only through its write policy (issue
    #95), never a write of this loop's own.
    """
    last_hash = None
    synced_event_rules = {}
    last_sync = None
    missing_logged = False
    malformed_logged = False
    amps_logged_hash = None
    if initial_delay:
        # Offset from the other pollers; only the first iteration is delayed.
        _stop.wait(initial_delay)
    while not _stop.is_set():
        try:
            snapshot = db.collection("schedule").document("current").get()
            if not snapshot.exists:
                # Safety: a never-created schedule doc must not erase whatever
                # the charger already has (e.g. configured from its own UI).
                if not missing_logged:
                    log("schedule/current missing; firmware schedule left untouched")
                    missing_logged = True
            else:
                missing_logged = False
                normalized = normalize_schedule(snapshot.to_dict() or {})
                if normalized is None:
                    # Malformed is not "disabled": leave the firmware untouched.
                    if not malformed_logged:
                        log(
                            "schedule/current is malformed; "
                            "firmware schedule left untouched"
                        )
                        malformed_logged = True
                else:
                    malformed_logged = False
                    enabled, rules = normalized
                    digest = schedule_hash(enabled, rules)
                    events, desired_event_rules = schedule_events(
                        rules if enabled else []
                    )
                    now = time.monotonic()
                    changed = digest != last_hash
                    due = (
                        changed
                        or last_sync is None
                        or now - last_sync >= reconcile_interval
                    )
                    if due:
                        if rules and digest != amps_logged_hash:
                            log(
                                "schedule: firmware v5.1.5 has no per-event "
                                "current; amps not applied"
                            )
                            amps_logged_hash = digest
                        try:
                            sync_schedule(transport, host, auth, events)
                        except (
                            CommandError,
                            requests.RequestException,
                            ValueError,
                        ) as exc:
                            log(f"schedule sync failed ({exc.__class__.__name__}: {exc})")
                        else:
                            last_hash = digest
                            last_sync = now
                            synced_event_rules = desired_event_rules

            # Publish the firmware's own view of the active window, mapped
            # through the last event set that actually synced -- on change
            # only (issue #95): the value feeds the sink's accumulated view
            # and a change arms its write-policy trigger, so the window
            # lands inside the status write it causes. The per-tick
            # republish is gone; an unchanged window costs zero writes.
            try:
                plan = _schedule_plan(transport, host, auth)
                sink.note_schedule(schedule_state(plan, synced_event_rules))
            except (CommandError, requests.RequestException, ValueError) as exc:
                log(f"schedule plan failed ({exc.__class__.__name__}: {exc})")
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"schedule loop error ({exc.__class__.__name__}: {exc})")
        _stop.wait(interval)


def run(
    db,
    host,
    auth,
    intervals,
    transport,
    watchdog_config,
    mqtt=None,
    bootstrap=DEFAULT_CHARGER_HOST,
    write_policy=None,
    history=None,
):
    """Start the pollers; blocks on the command loop until the stop event.

    Every loop gets the same ``transport``: one Session and one bounded
    keep-alive pool per process. With ``mqtt`` (an enabled MqttConfig) the
    source is started and its snapshots are applied on their own worker; the
    status and config loops then reconcile instead of polling.

    ``host`` is the one charger-address holder every loop reads per request, so
    ``settings_loop`` can swap it live. ``bootstrap`` is the env address that
    refresh reverts to when the app clears the setting. ``write_policy`` is the
    validated WritePolicyConfig from env; the sink owns the WritePolicy itself
    and with it every ``status/current`` write (issue #93). ``history`` is the
    validated HistoryConfig (issue #94): the tracker's accumulator flushes
    history/<day> on its cadence and on the shutdown drain below. One
    :class:`WriteCounter` (issue #96) is built here and threaded through
    every write site, ``status/health`` and the status loop's summary tick,
    so the journal's counts cover the whole process.
    """
    (
        status_interval,
        config_interval,
        schedule_interval,
        reconcile_interval,
        command_interval,
        settings_interval,
    ) = intervals
    # The process's one write counter (issue #96): every write site records
    # here, ``status/health``'s transition writes expose the rolling count,
    # and the status loop logs the hourly summary. Built once, threaded
    # everywhere, so the totals are the process's.
    counter = WriteCounter()
    tracker = StatusTracker(
        db,
        history=HistoryAccumulator(
            db, flush_sec=(history or HistoryConfig()).flush_sec, counter=counter
        ),
        counter=counter,
    )
    tracker.seed()
    notifier = Notifier(db, counter=counter)

    source = None
    snapshots = None
    config_event = None
    mqtt_status_args = None
    if mqtt is not None and mqtt.enabled:
        # Telemetry slots plus the reserved edge backlog: a blocked worker must
        # not lose a session edge to queue capacity.
        snapshots = queue.Queue(maxsize=MQTT_PENDING_QUEUE)
        config_event = threading.Event()
        source = MqttSource(
            host=mqtt.host,
            port=mqtt.port,
            topic=mqtt.topic,
            user=mqtt.user,
            password=mqtt.password,
            client_id=mqtt.client_id,
            announce_topic=mqtt.announce_topic,
            on_status=lambda record: enqueue_latest(snapshots, record),
            on_config_version=lambda _version: config_event.set(),
            log=log,
        )
    # Built after the source: the outage decision needs its arrival sequence,
    # and the watchdog needs the link/LWT state for its restart transport.
    watchdog = Watchdog(
        db,
        host,
        auth,
        transport,
        notifier,
        watchdog_config,
        mqtt=source,
        counter=counter,
    )
    sink = StatusSink(
        db,
        tracker,
        notifier,
        arrivals=source.arrival_generation if source is not None else None,
        policy=WritePolicy(write_policy),
        counter=counter,
    )
    if source is not None:
        mqtt_status_args = (sink, snapshots)

    status_args = (
        db,
        host,
        auth,
        transport,
        status_interval,
        tracker,
        notifier,
        watchdog,
        source,
        mqtt.reconcile_sec if source is not None else MQTT_RECONCILE_SEC,
        sink,
    )
    threading.Thread(target=status_loop, args=status_args, daemon=True).start()
    config_args = (
        db,
        host,
        auth,
        transport,
        config_interval,
        CONFIG_INITIAL_DELAY,
        source,
        config_event,
    )
    # ``counter`` binds by keyword: it follows defaulted parameters (``tick``
    # among them), and the positional form once landed it in ``tick`` — a
    # WriteCounter where seconds belong, fatal to the MQTT-mode tail wait.
    threading.Thread(
        target=config_loop, args=config_args, kwargs={"counter": counter}, daemon=True
    ).start()
    settings_args = (db, host, bootstrap, settings_interval)
    threading.Thread(target=settings_loop, args=settings_args, daemon=True).start()
    schedule_args = (
        db,
        host,
        auth,
        transport,
        schedule_interval,
        reconcile_interval,
        sink,
        SCHEDULE_INITIAL_DELAY,
    )
    threading.Thread(target=schedule_loop, args=schedule_args, daemon=True).start()
    if mqtt_status_args is not None:
        threading.Thread(
            target=mqtt_status_loop, args=mqtt_status_args, daemon=True
        ).start()
        source.start()
    command_loop(db, host, auth, transport, command_interval, source, sink, counter)
    if source is not None:
        source.stop()
    # The SIGTERM/SIGINT handlers only set the stop event; with the command
    # loop down, the pending history energy is written before the process
    # exits (issue #94) -- the drain runs here, off the signal handler and
    # under the sink's lock, serialized against the still-running daemon
    # loop threads. A failure is logged by the flush itself; the energy is
    # lost with the process, bounded by the flush interval (the
    # unclean-power-loss window).
    sink.drain_history()


def main():
    user = cfg("CHARGER_USER")
    auth = (user, cfg("CHARGER_PASS", "")) if user is not None else None  # blank OK
    try:
        status_interval = float(cfg("STATUS_INTERVAL") or 10)
        config_interval = float(cfg("CONFIG_INTERVAL") or 60)
        schedule_interval = float(cfg("SCHEDULE_INTERVAL") or 60)
        reconcile_interval = float(cfg("SCHEDULE_RECONCILE_INTERVAL") or 300)
        command_interval = float(cfg("COMMAND_INTERVAL") or 5)
        settings_interval = float(cfg("SETTINGS_INTERVAL") or 60)
    except ValueError:
        sys.exit(
            "STATUS_INTERVAL, CONFIG_INTERVAL, SCHEDULE_INTERVAL, "
            "SCHEDULE_RECONCILE_INTERVAL, COMMAND_INTERVAL and SETTINGS_INTERVAL "
            "must be numbers."
        )
    write_policy = write_policy_config_or_exit()
    history = history_config_or_exit()

    try:
        db = init_firestore()
    except RuntimeError as exc:
        sys.exit(str(exc))

    # Seeded only once Firestore is available: an address saved in the app
    # (settings/current.charger_host) overrides CHARGER_HOST at startup, while
    # CHARGER_HOST stays the bootstrap a fresh Pi with no settings doc uses.
    bootstrap = cfg("CHARGER_HOST", DEFAULT_CHARGER_HOST)
    host = ChargerHost(seed_host(db, bootstrap))

    watchdog = watchdog_config_or_exit()
    mqtt = mqtt_config_or_exit()

    def stop(signum, _frame):
        log(f"received signal {signum}, stopping")
        _stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)

    log(
        f"bridge started: {host.base}, polls {status_interval:g}s/"
        f"{config_interval:g}s/{schedule_interval:g}s/{command_interval:g}s, "
        f"schedule reconcile {reconcile_interval:g}s, "
        f"settings {settings_interval:g}s, "
        f"status writes gap >={write_policy.min_gap:g}s, "
        f"heartbeats {write_policy.charging_heartbeat:g}s charging/"
        f"{write_policy.idle_heartbeat:g}s idle, "
        f"history flush {history.flush_sec:g}s charging"
    )
    log(
        f"watchdog: enabled={watchdog.enabled} failures={watchdog.threshold} "
        f"cooldown={watchdog.cooldown:g}s cap={watchdog.max_per_hour}/h "
        f"restart_while_charging={watchdog.restart_while_charging}"
    )
    if mqtt.enabled:
        # Host/topic only: the broker password never reaches the journal.
        log(
            f"mqtt: enabled host={mqtt.host}:{mqtt.port} topic={mqtt.topic} "
            f"announce={mqtt.announce_topic} "
            f"reconcile={mqtt.reconcile_sec:g}s client_id={mqtt.client_id} "
            f"user={'set' if mqtt.user else 'none'}"
        )
    else:
        log("mqtt: disabled (HTTP status polling)")
    intervals = (
        status_interval,
        config_interval,
        schedule_interval,
        reconcile_interval,
        command_interval,
        settings_interval,
    )
    run(
        db,
        host,
        auth,
        intervals,
        ChargerTransport(make_charger_session()),
        watchdog,
        mqtt,
        bootstrap,
        write_policy=write_policy,
        history=history,
    )
    log("bridge stopped")


if __name__ == "__main__":
    # Script mode ("python pi/bridge.py"): expose this module as "bridge" so
    # the extracted modules' call-time seams resolve here, not to a second
    # copy of this file.
    sys.modules.setdefault("bridge", sys.modules[__name__])
    main()
