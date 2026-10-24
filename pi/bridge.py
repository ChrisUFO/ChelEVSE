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
from typing import NamedTuple

import requests
import firebase_admin
from firebase_admin import credentials, exceptions, firestore, messaging

from mqtt_source import DEFAULT_ANNOUNCE_TOPIC, MqttPublishError, MqttSource

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

REPO_ROOT = Path(__file__).resolve().parent.parent
HTTP_TIMEOUT = 5  # seconds, per charger request
# First-iteration offsets so /status, /config and /schedule/plan do not fire
# together against the gateway.
CONFIG_INITIAL_DELAY = 3
SCHEDULE_INITIAL_DELAY = 7
# Retry a failed /config sync with this bounded backoff while MQTT is healthy
# (the periodic poll is skipped then, so a failure would otherwise strand the
# config until the charger's next setting change).
CONFIG_RETRY_MIN_SEC = 5
CONFIG_RETRY_MAX_SEC = 60
STATE_LABELS = {
    1: "ready",
    2: "connected",
    3: "charging",
    254: "sleeping",
    255: "disabled",
}
# EVSE states a paused charger reports: 8.2.3 pauses into 254; 255 is the
# firmware's own "disabled" code kept for completeness. A held current shows
# 1/2/3, so this is what separates a pause from a hold.
PAUSED_STATES = frozenset({254, 255})
MIN_AMPS, MAX_AMPS = 6, 48
OFFLINE = {"charger_online": False, "updated_at": firestore.SERVER_TIMESTAMP}
# Firmware scheduler limits: 2 events per rule, 50 events total.
MAX_SCHEDULE_RULES = 20
# Allow for the firmware's randomized window start (scheduler_start_window).
SCHEDULE_JITTER_GRACE = 10
# Retry a failed status/current seed at most this often while running.
SEED_RETRY_INTERVAL = 30
# --- MQTT status source (issue #44) ----------------------------------------
# MQTT is opt-in; with the flag off every cadence and write is unchanged.
DEFAULT_MQTT_TOPIC = "chelevse"
DEFAULT_MQTT_CLIENT_ID = "chelevse-bridge"
# Status reconciliation over HTTP while MQTT is healthy (staleness cover).
MQTT_RECONCILE_SEC = 60
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
# Snapshot fields whose change is a discrete trigger: they publish at the next
# scheduler opportunity. Everything else parse_status emits is continuous and
# never triggers a write. ``updated_at`` is transport bookkeeping, never a
# trigger; ``state_label`` follows ``state``.
TRIGGER_FIELDS = ("state", "vehicle", "pilot", "charger_online")
# --- History write accumulator (issue #94) ------------------------------------
# history/<day> deltas accumulate in memory and flush as one masked-merge
# write per day document on: hour rollover, session close, this interval
# while charging, and shutdown. 300 s is 12 writes/hour while charging and
# zero while idle; the shutdown drain means stops and restarts lose nothing.
HISTORY_FLUSH_SEC = 300
# A granted subscription that never delivers a ``config_version`` still leaves
# ``status/config`` stale: sync once over HTTP straight away, then keep this
# slow safety resync until a version is observed.
CONFIG_SAFETY_RESYNC_SEC = 600
# A pending command older than this is failed without touching the charger.
COMMAND_MAX_AGE = 600
# How long an MQTT-published override command waits for the firmware's retained
# <base>/override document (or the status field) to confirm it.
COMMAND_CONFIRM_SEC = 5
# Command types the bridge applies; anything else fails before a transport is
# chosen.
COMMAND_TYPES = frozenset({"pause", "resume", "set_current", "rapi"})
# Pending commands handled per poll.
COMMAND_BATCH = 10
# Settled-but-unwritten command ids remembered per process (acked or failed), so
# a failed status write is retried instead of re-applying the command.
COMMAND_ACK_MEMORY = 256
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
# Plausibility ceiling for one interval-attribution step, as a power: a step can
# only carry the energy the charger could have delivered in the time that passed
# between the two readings. The charger's own ceiling is 48 A (MAX_AMPS) at ~240 V
# ≈ 11.5 kW, so 25 kW is more than twice what it can draw and still rejects a
# corrupt counter jump; using power × elapsed time (rather than a fixed Wh cap)
# keeps a legitimate step after a long outage — 20 kWh is ~1.7 h of full-power
# charging, not an impossible instant jump. The floor absorbs sub-second gaps and
# clock resolution so two ticks that land together cannot reject a real step.
MAX_INTERVAL_POWER_W = 25000.0
INTERVAL_STEP_FLOOR_WH = 50.0
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
_TRUE_ENV = frozenset({"1", "true", "yes", "on"})
_FALSE_ENV = frozenset({"0", "false", "no", "off"})
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
TIME_RE = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")
# Firmware weekday names, indexed by firmware day (Sunday = 0). Our rules use
# 0 = Monday ... 6 = Sunday, so our day d is firmware day (d + 1) % 7.
FIRMWARE_DAYS = (
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
)

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


class CommandError(ValueError):
    """Command document cannot be applied to the charger.

    ``transport`` names the path that produced the failure (``"mqtt"`` or
    ``"http"``), so the command document can record it. It is None when the
    failure was decided before a transport was chosen.
    """

    def __init__(self, message, transport=None):
        super().__init__(message)
        self.transport = transport


def parse_status(data):
    """OpenEVSE /status JSON -> fields for the status/current document."""
    state = data.get("state")
    # Absent temperature sensors read 0 (or a negative sentinel); ignore them.
    raw_temps = [data.get(k) for k in ("temp1", "temp2", "temp3")]
    temps = [t for t in raw_temps if isinstance(t, (int, float)) and t > 0]
    return {
        "state": state,
        "state_label": STATE_LABELS.get(state, "unknown"),
        "amp": _amps(data.get("amp")),
        "voltage": data.get("voltage"),
        "power": data.get("power"),
        "session_energy": data.get("session_energy"),
        "total_energy": data.get("total_energy"),
        "elapsed": data.get("elapsed"),
        "vehicle": data.get("vehicle"),
        "temp_c": round(sum(temps) / len(temps) / 10, 1) if temps else None,
        "temp1": _sensor_temp(data.get("temp1")),
        "temp2": _sensor_temp(data.get("temp2")),
        "temp3": _sensor_temp(data.get("temp3")),
        "pilot": _pilot(data.get("pilot")),
        "charger_online": True,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }


# parse_status outputs that keep the raw key's name.
_SNAPSHOT_FIELDS = (
    "state",
    "amp",
    "voltage",
    "power",
    "session_energy",
    "total_energy",
    "elapsed",
    "vehicle",
    "pilot",
    "temp1",
    "temp2",
    "temp3",
)
_SNAPSHOT_TEMPS = ("temp1", "temp2", "temp3")


def parse_snapshot(data):
    """parse_status for an MQTT snapshot, which may carry only changed fields.

    A snapshot is the last ``/status`` seed merged with the fields of one
    burst, so before that seed it holds only what changed (``{"amp": …}``).
    Parsing it as a full reply would merge ``None`` over every field the burst
    did not carry, so only the fields the snapshot actually has are emitted.
    ``charger_online`` and ``updated_at`` are transport facts — a snapshot
    proves the charger is publishing — and are always set.
    """
    fields = parse_status(data)
    parsed = {
        "charger_online": fields["charger_online"],
        "updated_at": fields["updated_at"],
    }
    for key in _SNAPSHOT_FIELDS:
        if key in data:
            parsed[key] = fields[key]
    if "state" in data:
        parsed["state_label"] = fields["state_label"]
    if any(key in data for key in _SNAPSHOT_TEMPS):
        parsed["temp_c"] = fields["temp_c"]
    return parsed


def _is_number(value):
    """True for int/float but not bool (bool is a subclass of int)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _sensor_temp(value):
    """Raw tenths-of-°C reading -> °C, or None for absent-sensor sentinels."""
    if _is_number(value) and value > 0:
        return round(value / 10, 1)
    return None


def _amps(value):
    """OpenEVSE reports charge current in milliamps; the contract is amps."""
    if _is_number(value) and value >= 0:
        return round(value / 1000, 2)
    return None


def _pilot(value):
    """Pilot setpoint in amps, or None when the charger reports nothing."""
    if _is_number(value) and value >= 0:
        return value
    return None


def _interval_clock():
    """Seconds on the clock the charging-interval gap is measured with.

    ``CLOCK_BOOTTIME`` advances across suspend, which is what the gap needs:
    ``time.monotonic()`` stops while the Pi sleeps, so a charge that suspends
    mid-session would report a shorter gap than the time actually elapsed and
    the time-aware step allowance could judge a legitimate step impossible.
    Linux provides it; the monotonic fallback keeps every other platform (and a
    test run without the constant) working, simply excluding suspend there.
    """
    if hasattr(time, "CLOCK_BOOTTIME"):
        return time.clock_gettime(time.CLOCK_BOOTTIME)
    return time.monotonic()


def _interval_step_allowance(gap):
    """Energy one attribution step may carry, given seconds since the last one.

    A step is measured between two charging readings, so the charger could have
    delivered ``MAX_INTERVAL_POWER_W × gap`` in between; the floor covers clock
    resolution and sub-second gaps, so two ticks that land together cannot
    reject a real step. Callers pass only a measured gap: an unknown one has
    nothing to judge (see ``_track_interval``).
    """
    if not _is_number(gap) or gap <= 0:
        return INTERVAL_STEP_FLOOR_WH
    return MAX_INTERVAL_POWER_W * float(gap) / 3600.0 + INTERVAL_STEP_FLOOR_WH


def _gap_seconds(gap):
    """The observation gap for a journal line."""
    if not _is_number(gap) or gap < 0:
        return "no earlier reading"
    return f"{float(gap):.0f} s"


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


# --- Charger address (issue #54) -------------------------------------------
# The charger's address is app-managed once the bridge runs:
# ``settings/current.charger_host`` wins over ``CHARGER_HOST``, and
# ``settings_loop`` applies a change without a restart. The grammar below is
# shared with ``web/js/settings.js`` and ``firestore.rules``; the bridge
# re-validates fully because it must survive a value written from the console.
DEFAULT_CHARGER_HOST = "192.168.0.145"
CHARGER_HOST_MAX_LEN = 253
CHARGER_HOST_LABEL_MAX_LEN = 63
_CHARGER_HOST_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?")
_CHARGER_HOST_LABEL_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?")


def _normalize_charger_host(raw):
    """The charger-host grammar: the host as typed, or None when invalid.

    Trimmed first; empty after trim means unset (None). 1..253 characters of
    ``[A-Za-z0-9.-]`` with an alphanumeric first and last character, so a
    scheme, port, path, userinfo, inner whitespace and a leading or trailing
    dot/hyphen are all rejected by construction. Every dot-separated label is
    1..63 characters with no leading or trailing hyphen. A four-label
    all-numeric value is an IPv4 literal, so each octet must be 0..255. Case is
    preserved as typed. No logging here: the caller decides what a rejection
    means for the journal.
    """
    if not isinstance(raw, str):
        return None
    host = raw.strip()
    if not 1 <= len(host) <= CHARGER_HOST_MAX_LEN:
        return None
    if _CHARGER_HOST_RE.fullmatch(host) is None:
        return None
    labels = host.split(".")
    if any(
        not 1 <= len(label) <= CHARGER_HOST_LABEL_MAX_LEN
        or _CHARGER_HOST_LABEL_RE.fullmatch(label) is None
        for label in labels
    ):
        return None
    if len(labels) == 4 and all(label.isdigit() for label in labels):
        if any(int(label) > 255 for label in labels):
            return None
    return host


class ChargerHost:
    """The charger's current address, swapped at runtime (issue #54).

    One lock and nothing else. Every consumer reads ``base`` per request
    instead of capturing the string, so a saved app setting applies to the next
    request with no restart and no stale copy anywhere in the process. The
    shared ``ChargerTransport`` needs no changes: ``requests`` pools per host,
    so a swap simply opens a new socket.
    """

    def __init__(self, host):
        normalized = _normalize_charger_host(host)
        if normalized is None:
            raise ValueError(f"invalid charger host {host!r}")
        self._lock = threading.Lock()
        self._host = normalized

    @property
    def host(self):
        """The bare host the bridge was told to use."""
        with self._lock:
            return self._host

    @property
    def base(self):
        """``http://<host>``: the base every charger URL is built from."""
        with self._lock:
            return f"http://{self._host}"

    def set(self, host):
        """Adopt ``host``; True only when it really changed the address.

        ``None`` (or anything the grammar rejects) sets nothing, so a malformed
        value can never replace a working address.
        """
        normalized = _normalize_charger_host(host)
        if normalized is None:
            return False
        with self._lock:
            if normalized == self._host:
                return False
            self._host = normalized
            return True


def _bootstrap_host(bootstrap):
    """The env bootstrap as a valid host, else the built-in default (logged)."""
    host = _normalize_charger_host(bootstrap)
    if host is None:
        log(f"charger host rejected: {bootstrap} (using {DEFAULT_CHARGER_HOST})")
        return DEFAULT_CHARGER_HOST
    return host


def _read_charger_host(db):
    """The stored ``settings/current.charger_host``, or None when unset.

    Raises on a Firestore read failure; the caller decides how to keep going.
    """
    snapshot = db.collection("settings").document("current").get()
    data = snapshot.to_dict() if snapshot.exists else None
    return data.get("charger_host") if isinstance(data, dict) else None


def seed_host(db, bootstrap):
    """The charger host the bridge starts with; logs the choice and its source.

    A valid ``settings/current.charger_host`` wins over the env bootstrap, so an
    address saved in the app survives a service restart. A malformed stored
    value is logged and ignored, and a read failure falls back to the bootstrap:
    a fresh Pi with no settings document must still start.
    """
    host = _bootstrap_host(bootstrap)
    try:
        raw = _read_charger_host(db)
    except Exception as exc:
        log(
            f"charger host: settings read failed "
            f"({exc.__class__.__name__}: {exc}); using {host}"
        )
        log(f"charger host: http://{host} (environment)")
        return host
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        log(f"charger host: http://{host} (environment)")
        return host
    stored = _normalize_charger_host(raw)
    if stored is None:
        log(f"charger host rejected: {raw} (using {host})")
        log(f"charger host: http://{host} (environment)")
        return host
    log(f"charger host: http://{stored} (app settings)")
    return stored


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


def make_charger_session():
    """One keep-alive session for the charger, capped at two pooled sockets."""
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=1, pool_maxsize=2, max_retries=0
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


class ChargerTransport:
    """The process's one charger Session, serialised by a lock.

    ``requests.Session`` is not documented as thread-safe, and the ESP32 gateway
    is the constrained side of the link: four loops sharing one session and its
    keep-alive pool (capped at two sockets) is cheaper than four sessions. The
    lock is not free: ``HTTP_TIMEOUT`` is the connect/read timeout given to each
    request, and Requests applies it per socket operation rather than as a
    deadline for the whole call. Name resolution is not covered by it, and a
    response that trickles in under the read timeout can keep the call — and the
    lock — held past that value, so there is no strict total-duration bound.
    Other loops' charger calls (commands included) wait for the lock rather than
    fail; Firestore work and the notifier stay outside it.
    """

    def __init__(self, session):
        self._session = session
        self._lock = threading.Lock()

    def get(self, url, **kwargs):
        with self._lock:
            return self._session.get(url, **kwargs)

    def post(self, url, **kwargs):
        with self._lock:
            return self._session.post(url, **kwargs)

    def delete(self, url, **kwargs):
        with self._lock:
            return self._session.delete(url, **kwargs)


def _http_reason(resp):
    """Short HTTP failure reason with a bounded body snippet."""
    body = " ".join((resp.text or "").split())[:120]
    reason = f"HTTP {resp.status_code}"
    return f"{reason}: {body}" if body else reason


def _offline_reason(exc):
    """Classify a failed status poll for the journal (auth/HTTP/transport)."""
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return _http_reason(exc.response)
    detail = str(exc).strip()[:120]
    reason = exc.__class__.__name__
    return f"{reason}: {detail}" if detail else reason


def _require_ok(resp):
    if not 200 <= resp.status_code < 300:
        raise CommandError(_http_reason(resp))


def _require_command_ok(resp):
    """``_require_ok`` for a command's HTTP reply, labelled with its transport.

    Only called after a request was sent, so ``transport: "http"`` really names
    the path that carried it. Validation failures are raised before this point
    and keep ``transport`` unset.
    """
    try:
        _require_ok(resp)
    except CommandError as exc:
        exc.transport = "http"
        raise


def _rapi_result(resp):
    """RAPI reply's ret value, or the raw text when the body is not JSON."""
    try:
        body = resp.json()
    except ValueError:
        return resp.text.strip() or None
    return body.get("ret") if isinstance(body, dict) else None


def _command_amps(cmd):
    """Validated, firmware-clamped amps; CommandError when absent/invalid."""
    try:
        return max(MIN_AMPS, min(MAX_AMPS, int(cmd.get("amps"))))
    except (TypeError, ValueError):
        raise CommandError("missing or invalid amps")


def _command_rapi(cmd):
    """The validated RAPI command string, or CommandError."""
    command = cmd.get("command")
    if (
        not isinstance(command, str)
        or not command.startswith("$")
        or len(command) > 32
    ):
        raise CommandError("invalid rapi")
    return command


def mqtt_command_ready(source):
    """True when MQTT may carry a command: connected **and** subscribed."""
    return bool(source is not None and getattr(source, "ready", False))


def _apply_command_http(transport, host, auth, cmd):
    """The existing HTTP path: fallback, and the only path with MQTT off."""
    ctype = cmd.get("type")
    if ctype == "pause":
        resp = transport.post(
            f"{host.base}/override",
            json={"state": "disabled"},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_command_ok(resp)
        return {}
    if ctype == "resume":
        # Clear the manual override; the firmware scheduler takes over again.
        resp = transport.delete(f"{host.base}/override", auth=auth, timeout=HTTP_TIMEOUT)
        if not 200 <= resp.status_code < 300:
            # v5.1.5 answers 500 "Failed to release manual override" when there
            # is nothing to release. The intended end state already holds, so
            # confirm it rather than reporting a spurious failure.
            try:
                status = transport.get(
                    f"{host.base}/status", auth=auth, timeout=HTTP_TIMEOUT
                )
                status.raise_for_status()
                body = status.json()
                if isinstance(body, dict) and body.get("manual_override") == 0:
                    log("resume: no manual override to release; treating as acked")
                    return {}
            except (requests.RequestException, ValueError):
                pass
        _require_command_ok(resp)
        return {}
    if ctype == "set_current":
        amps = _command_amps(cmd)
        resp = transport.post(
            f"{host.base}/override",
            json={"state": "active", "charge_current": amps, "max_current": amps},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_command_ok(resp)
        return {}
    if ctype == "rapi":
        command = _command_rapi(cmd)
        resp = transport.post(
            f"{host.base}/rapi",
            data={"rapi": command, "json": 1},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_command_ok(resp)
        result = _rapi_result(resp)
        log(f"rapi {command}: ret={result!r}")
        return {"result": result}
    raise CommandError("unsupported type")


def _as_int(value):
    """int(value) for numeric-ish input, else None (never raises)."""
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _paused(status):
    """Does this status view show a paused (disabled) charger?

    Firmware 8.2.3 pauses into EVSE ``state`` 254 and reports ``manual_override``
    1; it never reports 255 for a pause. ``manual_override`` alone is 1 for
    *any* override (a hold included), so it only counts together with a
    non-charging EVSE state: a held current still shows ready/connected/
    charging, and a sleeping charger with no override reports the same 254 with
    ``manual_override`` 0. The HTTP ``/status`` reply also carries ``status: "disabled"``, which
    the MQTT status topics do not, so it is accepted when present.
    """
    if not isinstance(status, dict):
        return False
    if status.get("status") == "disabled":
        return True
    return (
        _as_int(status.get("manual_override")) == 1
        and _as_int(status.get("state")) in PAUSED_STATES
    )


def _setpoint_matches(status, amps):
    """Does a status view show ``manual_override`` holding ``amps``?

    The EVSE clamps above its own configured maximum, so a command beyond it
    (``amps`` > ``max_current``) is confirmed by ``pilot`` sitting at that
    maximum rather than at the commanded value. ``max_current`` comes from the
    raw ``/status`` reply: firmware 8.2.3 carries it there (live on the test
    charger: ``pilot`` 16 with ``max_current`` 16, the soft limit), while
    ``/config`` spells the pair ``max_current_soft``/``max_current_hard`` and
    never a bare ``max_current``.
    """
    if _as_int(status.get("manual_override")) != 1:
        return False
    pilot = _as_int(status.get("pilot"))
    if pilot == amps:
        return True
    cap = _as_int(status.get("max_current"))
    return cap is not None and pilot == cap and amps > cap


def _override_confirms(ctype, amps, view):
    """Does an acknowledged override view reflect ``ctype`` / ``amps``?

    The retained ``<base>/override`` document is authoritative: ``null`` is
    auto, ``disabled`` is paused, ``active`` carries the held current. The raw
    status seed is the fallback for the moment before the retained copy lands
    (``manual_override`` 0 = auto, 1 = any override, ``pilot`` = held setpoint).
    Firmware v8.2.3 publishes ``manual_override`` but does not distinguish
    active from disabled with it, hence the override document and ``_paused``.
    """
    override = view.get("override") or {}
    status = view.get("status") or {}
    state = override.get("state")
    # Once the retained document has been seen it is authoritative; the status
    # seed is only a fallback for the moment before it lands (state is None).
    if ctype == "pause":
        if state == "disabled":
            return True
        return state is None and _paused(status)
    if ctype == "resume":
        # "null" is the firmware's auto state (observed on 8.2.3).
        if state in ("null", "auto", "clear"):
            return True
        return state is None and _as_int(status.get("manual_override")) == 0
    # set_current: confirm from the commanded field, not `max_current`, so a
    # firmware that normalises the latter cannot make every hold time out.
    # A document that names no current at all confirms nothing: it cannot tell
    # an applied hold from a lost publish. The read-only /status reconcile in
    # `_apply_override_mqtt` is the second opinion for that shape.
    if state == "active":
        current = override.get("charge_current", override.get("max_current"))
        return current is not None and _as_int(current) == amps
    return state is None and _setpoint_matches(status, amps)


def _status_confirms(ctype, amps, status):
    """The same predicate against a plain HTTP ``/status`` reply."""
    if not isinstance(status, dict):
        return False
    if ctype == "pause":
        return _paused(status)
    if ctype == "resume":
        return _as_int(status.get("manual_override")) == 0
    return _setpoint_matches(status, amps)


def _apply_override_mqtt(transport, host, auth, source, ctype, cmd, confirm_sec):
    """Publish one override command and wait for the firmware to reflect it."""
    if ctype == "pause":
        amps = None
        payload = {"state": "disabled"}
    elif ctype == "resume":
        amps = None
        payload = "clear"
    else:
        amps = _command_amps(cmd)
        payload = {"state": "active", "charge_current": amps, "max_current": amps}
    try:
        source.publish(
            "override/set", json.dumps(payload) if isinstance(payload, dict) else payload
        )
    except MqttPublishError as exc:
        # The client refused the message, so nothing was delivered and the HTTP
        # fallback cannot double-apply. An *accepted* publish never falls back.
        log(f"command transport: http (mqtt publish failed: {exc})")
        return _apply_command_http(transport, host, auth, cmd)
    try:
        confirmed = source.wait_for_state(
            lambda view: _override_confirms(ctype, amps, view), confirm_sec
        )
    except Exception as exc:  # never re-apply because an ack wait crashed
        raise CommandError(
            f"mqtt acknowledgement failed ({exc.__class__.__name__}: {exc})",
            transport="mqtt",
        ) from exc
    if confirmed:
        return {"transport": "mqtt"}
    # The command may have applied while its broadcast was lost. Reconcile
    # read-only over HTTP (the command itself is never re-applied).
    try:
        resp = transport.get(f"{host.base}/status", auth=auth, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        status = resp.json()
    except (requests.RequestException, ValueError):
        status = None
    if _status_confirms(ctype, amps, status):
        log(f"{ctype}: mqtt confirmation missed; confirmed by status reconcile")
        return {"transport": "mqtt"}
    raise CommandError(
        f"no confirmation within {confirm_sec:g}s "
        f"(manual_override/state did not reflect {ctype})",
        transport="mqtt",
    )


def _apply_rapi_mqtt(transport, host, auth, source, cmd, confirm_sec):
    """Publish one RAPI command and map the next rapi/out reply."""
    command = _command_rapi(cmd)
    parts = command.split(None, 1)
    head = parts[0]
    params = parts[1].strip() if len(parts) > 1 else ""
    try:
        reply = source.rapi_transaction(f"rapi/in/{head}", params, confirm_sec)
    except MqttPublishError as exc:
        log(f"command transport: http (mqtt publish failed: {exc})")
        return _apply_command_http(transport, host, auth, cmd)
    except Exception as exc:  # never re-publish because an ack wait crashed
        raise CommandError(
            f"mqtt rapi failed ({exc.__class__.__name__}: {exc})",
            transport="mqtt",
        ) from exc
    if reply is None:
        raise CommandError(
            f"no rapi/out within {confirm_sec:g}s", transport="mqtt"
        )
    text = str(reply).strip()
    if text.startswith("$OK"):
        log(f"rapi {command}: ret={text!r}")
        return {"result": text, "transport": "mqtt"}
    raise CommandError(
        f"rapi {command} failed: {text or 'empty reply'}", transport="mqtt"
    )


def apply_command(transport, host, auth, cmd, source=None, confirm_sec=None):
    """Apply one command document; return extra fields for the command doc.

    MQTT carries the command only while ``source.ready`` (connected and
    subscribed) at the moment it is picked up; otherwise the existing HTTP path
    runs unchanged. A command accepted by the MQTT client is never re-applied
    over HTTP — a missing confirmation fails it instead. The returned
    ``transport`` names the path that carried the command; the HTTP path leaves
    it out, as it always has, and the loop supplies the default. Failures carry
    their transport on ``CommandError.transport`` — unset when the command was
    rejected before anything was sent.
    """
    ctype = cmd.get("type")
    if ctype not in COMMAND_TYPES:
        raise CommandError("unsupported type")
    confirm_sec = COMMAND_CONFIRM_SEC if confirm_sec is None else float(confirm_sec)
    if mqtt_command_ready(source):
        if ctype == "rapi":
            return _apply_rapi_mqtt(
                transport, host, auth, source, cmd, confirm_sec
            )
        return _apply_override_mqtt(
            transport, host, auth, source, ctype, cmd, confirm_sec
        )
    return _apply_command_http(transport, host, auth, cmd)


def notify(db, body, counter=None):
    """Push one notification to every registered FCM token; never raises.

    Tokens live in fcmTokens/{docId} with an optional `token` field (the doc id
    is the fallback). Each token is sent independently so one dead token cannot
    block the rest; unregistered/invalid tokens are pruned.
    """
    counter = counter or WriteCounter()
    try:
        docs = list(db.collection("fcmTokens").stream())
    except Exception as exc:
        log(f"fcm token read failed ({exc.__class__.__name__}: {exc})")
        return
    for doc in docs:
        try:
            data = doc.to_dict() or {}
        except Exception:
            data = {}
        token = data.get("token") if isinstance(data, dict) else None
        if not (isinstance(token, str) and token):
            token = doc.id
        try:
            messaging.send(
                messaging.Message(
                    notification=messaging.Notification(title="ChelEVSE", body=body),
                    token=token,
                )
            )
        except (messaging.UnregisteredError, exceptions.InvalidArgumentError):
            try:
                doc.reference.delete()
            except Exception as exc:
                counter.note_failure(exc)
                log(f"fcm token prune failed ({exc.__class__.__name__}: {exc})")
            else:
                # A delete is a billed write; it counts (issue #96).
                counter.record("fcm")
                log(f"pruned fcm token {doc.id}")
        except Exception as exc:
            log(f"fcm send failed ({exc.__class__.__name__}: {exc})")


class Notifier:
    """Background FCM sender: status ticks enqueue and never wait on a push.

    firebase-admin's HTTP client defaults to a long timeout with retries, so a
    stalled FCM/network call must not hold the status loop (and with it status,
    history and session writes). One daemon worker drains a bounded queue; a
    full queue drops the newest push rather than blocking the caller.
    """

    def __init__(self, db, max_queue=64, counter=None):
        self.db = db
        self.queue = queue.Queue(maxsize=max_queue)
        self._thread = None
        self._lock = threading.Lock()
        # The write counter the token prunes record into (issue #96).
        self.counter = counter or WriteCounter()

    def enqueue(self, body):
        self._ensure_worker()
        try:
            self.queue.put_nowait(body)
        except queue.Full:
            log(f"fcm queue full; dropped notification: {body}")

    def _ensure_worker(self):
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._run, name="fcm-notifier", daemon=True
            )
            self._thread.start()

    def _run(self):
        while True:
            body = self.queue.get()
            try:
                notify(self.db, body, counter=self.counter)
            except Exception as exc:  # never let one push kill the worker
                log(f"fcm notify error ({exc.__class__.__name__}: {exc})")
            finally:
                self.queue.task_done()


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


class WatchdogConfig(NamedTuple):
    """Validated watchdog settings; ``watchdog_config()`` fills them from env."""

    enabled: bool = True
    threshold: int = 3
    cooldown: float = 600.0
    max_per_hour: int = 3
    restart_while_charging: bool = False


def _env_bool(name, default):
    """Parse one boolean env var; anything unparseable is a loud config error."""
    raw = cfg(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in _TRUE_ENV:
        return True
    if value in _FALSE_ENV:
        return False
    raise ValueError(f"{name} must be a boolean (true/false), got {raw!r}.")


def _env_finite(name, default, parse):
    """Parse one numeric env var; unparseable or non-finite values are loud errors.

    ``nan``/``inf`` must never reach a comparison: against ``nan`` every elapsed
    time reads as "long enough", which would silently disable a cooldown.
    """
    raw = cfg(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = parse(raw.strip())
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number, got {raw!r}.") from None
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite, got {raw!r}.")
    return value


def watchdog_config():
    """Watchdog settings from the environment; bad values raise ValueError."""
    threshold = _env_finite("WATCHDOG_FAILURES", 3, int)
    cooldown = _env_finite("WATCHDOG_COOLDOWN_SEC", 600.0, float)
    max_per_hour = _env_finite("WATCHDOG_MAX_PER_HOUR", 3, int)
    if threshold < 1:
        raise ValueError("WATCHDOG_FAILURES must be at least 1.")
    if cooldown < 0:
        raise ValueError("WATCHDOG_COOLDOWN_SEC must be zero or more.")
    if max_per_hour < 1:
        raise ValueError("WATCHDOG_MAX_PER_HOUR must be at least 1.")
    return WatchdogConfig(
        enabled=_env_bool("WATCHDOG_ENABLED", True),
        threshold=threshold,
        cooldown=cooldown,
        max_per_hour=max_per_hour,
        restart_while_charging=_env_bool("WATCHDOG_RESTART_WHILE_CHARGING", False),
    )


def watchdog_config_or_exit():
    """Watchdog settings for ``main()``: a bad value stops the bridge by name."""
    try:
        return watchdog_config()
    except ValueError as exc:
        sys.exit(str(exc))


class MqttConfig(NamedTuple):
    """Validated MQTT settings; ``mqtt_config()`` fills them from env."""

    enabled: bool = False
    host: str = ""
    port: int = 1883
    user: str = ""
    password: str = ""
    topic: str = DEFAULT_MQTT_TOPIC
    reconcile_sec: float = MQTT_RECONCILE_SEC
    client_id: str = DEFAULT_MQTT_CLIENT_ID
    announce_topic: str = DEFAULT_ANNOUNCE_TOPIC


def mqtt_config():
    """MQTT settings from the environment; bad values raise ValueError."""
    enabled = _env_bool("MQTT_ENABLED", False)
    host = (cfg("MQTT_HOST") or "").strip()
    port = _env_finite("MQTT_PORT", 1883, int)
    reconcile_sec = _env_finite("MQTT_RECONCILE_SEC", MQTT_RECONCILE_SEC, float)
    topic = (cfg("MQTT_TOPIC") or DEFAULT_MQTT_TOPIC).strip().strip("/")
    client_id = (cfg("MQTT_CLIENT_ID") or "").strip() or DEFAULT_MQTT_CLIENT_ID
    announce_topic = (
        cfg("MQTT_ANNOUNCE_TOPIC") or ""
    ).strip() or DEFAULT_ANNOUNCE_TOPIC
    if not 1 <= port <= 65535:
        raise ValueError(f"MQTT_PORT must be 1-65535, got {port}.")
    if reconcile_sec <= 0:
        raise ValueError(f"MQTT_RECONCILE_SEC must be above zero, got {reconcile_sec}.")
    if not topic:
        raise ValueError("MQTT_TOPIC must not be blank.")
    if enabled and not host:
        raise ValueError("MQTT_HOST is required when MQTT_ENABLED is true.")
    return MqttConfig(
        enabled=enabled,
        host=host,
        port=port,
        user=cfg("MQTT_USER") or "",
        password=cfg("MQTT_PASS") or "",
        topic=topic,
        reconcile_sec=reconcile_sec,
        client_id=client_id,
        announce_topic=announce_topic,
    )


def mqtt_config_or_exit():
    """MQTT settings for ``main()``: a bad value stops the bridge by name."""
    try:
        return mqtt_config()
    except ValueError as exc:
        sys.exit(str(exc))


def write_policy_config():
    """Write-policy tunables from the environment; bad values raise ValueError.

    Non-finite and non-positive values are equally rejected: against ``nan``
    every cadence comparison reads "not due yet", which would silently
    freeze all status writes, while a negative period is always due and
    would write on every scheduler tick.
    """
    tunables = (
        ("WRITE_MIN_GAP_SEC", WRITE_MIN_GAP_SEC),
        ("CHARGING_HEARTBEAT_SEC", CHARGING_HEARTBEAT_SEC),
        ("HEARTBEAT_INTERVAL", HEARTBEAT_INTERVAL),
    )
    values = []
    for name, default in tunables:
        value = _env_finite(name, default, float)
        if value <= 0:
            raise ValueError(f"{name} must be above zero, got {value:g}.")
        values.append(value)
    return WritePolicyConfig(*values)


def write_policy_config_or_exit():
    """Write-policy tunables for ``main()``: a bad value stops the bridge by name."""
    try:
        return write_policy_config()
    except ValueError as exc:
        sys.exit(str(exc))


class HistoryConfig(NamedTuple):
    """Validated history-accumulator tunables; ``main()`` fills them from env."""

    flush_sec: float = HISTORY_FLUSH_SEC


def history_config():
    """History flush tunable from the environment; bad values raise ValueError.

    The same rejection rationale as the write-policy tunables: ``nan`` makes
    every interval comparison read "not due yet" (freezing history writes),
    and a non-positive period is always due.
    """
    flush_sec = _env_finite("HISTORY_FLUSH_SEC", HISTORY_FLUSH_SEC, float)
    if flush_sec <= 0:
        raise ValueError(f"HISTORY_FLUSH_SEC must be above zero, got {flush_sec:g}.")
    return HistoryConfig(flush_sec=flush_sec)


def history_config_or_exit():
    """History flush tunable for ``main()``: a bad value stops the bridge by name."""
    try:
        return history_config()
    except ValueError as exc:
        sys.exit(str(exc))


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


def _normalize_rule(raw):
    """One schedule rule -> canonical dict, or None (logged) when malformed."""
    if not isinstance(raw, dict):
        log("schedule: skipped rule (not an object)")
        return None
    rule_id = raw.get("id")
    if not (isinstance(rule_id, str) and rule_id):
        log("schedule: skipped rule (missing string id)")
        return None
    days = raw.get("days")
    if not isinstance(days, list) or not days:
        log(f"schedule: skipped rule {rule_id} (missing days)")
        return None
    clean_days = []
    for day in days:
        if not isinstance(day, int) or isinstance(day, bool) or not 0 <= day <= 6:
            log(f"schedule: skipped rule {rule_id} (day must be an integer 0-6)")
            return None
        if day not in clean_days:
            clean_days.append(day)
    start = raw.get("start")
    if not (isinstance(start, str) and TIME_RE.fullmatch(start)):
        log(f"schedule: skipped rule {rule_id} (invalid start)")
        return None
    end = raw.get("end")
    if not (isinstance(end, str) and TIME_RE.fullmatch(end)):
        log(f"schedule: skipped rule {rule_id} (invalid end)")
        return None
    if start == end:
        log(f"schedule: skipped rule {rule_id} (start equals end)")
        return None
    amps = raw.get("amps")
    if not _is_number(amps) or not math.isfinite(amps):
        log(f"schedule: skipped rule {rule_id} (amps must be a number)")
        return None
    return {
        "id": rule_id,
        "days": sorted(clean_days),
        "start": start,
        "end": end,
        "amps": amps,
    }


def _hhmm_minutes(value):
    """'HH:MM' -> minutes since midnight."""
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def _rule_segments(rule):
    """(day, start, end) minute segments this rule occupies, incl. overnight spill."""
    start = _hhmm_minutes(rule["start"])
    end = _hhmm_minutes(rule["end"])
    segments = []
    for day in rule["days"]:
        if end > start:
            segments.append((day, start, end))
        else:
            # Wraps past midnight: the tail belongs to the following day. A
            # 00:00 end means the window finishes exactly at midnight.
            segments.append((day, start, 24 * 60))
            if end > 0:
                segments.append(((day + 1) % 7, 0, end))
    return segments


def _drop_overlaps(rules):
    """Keep rules with non-overlapping windows per day; log and skip clashes.

    The firmware builds a time-ordered event list and resolves equal-time
    events by order, so overlapping (or merely touching) windows make the
    effective on/off window ambiguous. Drop the later rule instead.
    """
    kept = []
    accepted = []
    for rule in rules:
        clashes = False
        for day, start, end in _rule_segments(rule):
            for other_day, other_start, other_end, _other_id in accepted:
                if day == other_day and start <= other_end and other_start <= end:
                    clashes = True
                    break
            if clashes:
                break
        if clashes:
            log(f"schedule: skipped rule {rule['id']} (overlaps another rule)")
            continue
        accepted.extend(
            (day, start, end, rule["id"]) for day, start, end in _rule_segments(rule)
        )
        kept.append(rule)
    return kept


def normalize_schedule(data):
    """schedule/current -> (enabled, canonical rules), or None when malformed.

    None means "leave the firmware exactly as it is": a doc whose enabled flag
    or rules list is malformed, or whose enabled rules are all unusable, is not
    an intentional clear.
    """
    if not isinstance(data, dict):
        log("schedule: skipped (document is not an object)")
        return None
    enabled = data.get("enabled")
    if not isinstance(enabled, bool):
        log("schedule: skipped (enabled must be a boolean)")
        return None
    raw_rules = data.get("rules")
    if not isinstance(raw_rules, list):
        log("schedule: skipped (rules must be a list)")
        return None
    rules = []
    for raw in raw_rules:
        rule = _normalize_rule(raw)
        if rule is not None:
            rules.append(rule)
    # Sort before capping so event ids stay stable when rules are reordered.
    rules.sort(key=lambda rule: rule["id"])
    rules = _drop_overlaps(rules)
    if len(rules) > MAX_SCHEDULE_RULES:
        log(f"schedule: only the first {MAX_SCHEDULE_RULES} rules are synced")
        rules = rules[:MAX_SCHEDULE_RULES]
    if enabled and raw_rules and not rules:
        log("schedule: skipped (no usable rules; firmware schedule left untouched)")
        return None
    return enabled, rules


def schedule_hash(enabled, rules):
    """Canonical digest of the desired schedule, used to skip unchanged syncs."""
    payload = json.dumps({"enabled": enabled, "rules": rules}, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def schedule_events(rules):
    """Rules -> (firmware events, event id -> rule id).

    Rule index i owns event 2*i+1 (window start, active) and 2*i+2 (window end,
    disabled). Event ids are deterministic for a given rule set, so the sync is
    an idempotent upsert. End events for overnight rules (end < start) shift to
    the following firmware day.
    """
    events = []
    event_rules = {}
    for index, rule in enumerate(rules):
        on_id, off_id = 2 * index + 1, 2 * index + 2
        days = sorted(
            (FIRMWARE_DAYS[(day + 1) % 7] for day in rule["days"]),
            key=FIRMWARE_DAYS.index,
        )
        if rule["end"] < rule["start"]:
            end_days = sorted(
                (FIRMWARE_DAYS[(day + 2) % 7] for day in rule["days"]),
                key=FIRMWARE_DAYS.index,
            )
        else:
            end_days = days
        events.append(
            {
                "id": on_id,
                "state": "active",
                "time": rule["start"] + ":00",
                "days": days,
            }
        )
        events.append(
            {
                "id": off_id,
                "state": "disabled",
                "time": rule["end"] + ":00",
                "days": end_days,
            }
        )
        event_rules[on_id] = rule["id"]
        event_rules[off_id] = rule["id"]
    return events, event_rules


def schedule_state(plan, event_rules):
    """Firmware /schedule/plan -> the status/current.schedule field.

    The firmware's current_event is the event whose claim is in effect, but it
    can lag the plan by a moment after a sync. An active event is only a real
    open window when the next event (its end) is due within the event's own
    duration; otherwise the plan is still describing a window whose start is
    ahead of now (e.g. yesterday's instance). Both values come from the
    firmware -- windows are never evaluated here.
    """
    current = plan.get("current_event") if isinstance(plan, dict) else None
    if not isinstance(current, dict):
        return {"in_window": False, "active_rule_id": None}
    delay = plan.get("next_event_delay")
    duration = current.get("duration")
    in_window = bool(
        current.get("state") == "active"
        and _is_number(delay)
        and _is_number(duration)
        and 0 <= delay <= duration + SCHEDULE_JITTER_GRACE
    )
    return {
        "in_window": in_window,
        "active_rule_id": event_rules.get(current.get("id")) if in_window else None,
    }


def _log_schedule(label, resp):
    """Log one scheduler request: method/target, status and body snippet."""
    body = " ".join((resp.text or "").split())[:160]
    log(f"schedule: {label} -> HTTP {resp.status_code}" + (f" {body}" if body else ""))


def _schedule_plan(transport, host, auth):
    """GET /schedule/plan as a dict; raises on any failure."""
    resp = transport.get(
        f"{host.base}/schedule/plan", auth=auth, timeout=HTTP_TIMEOUT
    )
    # Logged only on failure (via the caller): this runs every SCHEDULE_INTERVAL.
    _require_ok(resp)
    plan = resp.json()
    # The firmware answers [] when no events exist; that is an empty plan, not
    # a malformed one. Anything else that is not an object is still an error.
    if isinstance(plan, list) and not plan:
        return {}
    if not isinstance(plan, dict):
        raise ValueError("schedule plan is not a JSON object")
    return plan


def _event_time(value):
    """Firmware times may include seconds; compare at minute precision."""
    return value[:5] if isinstance(value, str) else None


def _event_days(value):
    """Normalized weekday names for comparison (firmware order-insensitive)."""
    if not isinstance(value, list):
        return ()
    return tuple(sorted(str(day).strip().lower() for day in value if isinstance(day, str)))


def _event_matches(existing, desired):
    """True when the firmware already holds this exact event."""
    if not isinstance(existing, dict):
        return False
    return (
        existing.get("state") == desired["state"]
        and _event_time(existing.get("time")) == _event_time(desired["time"])
        and _event_days(existing.get("days")) == _event_days(desired["days"])
    )


def sync_schedule(transport, host, auth, events):
    """Upsert changed firmware events and delete stale ones.

    The firmware upserts by id and never deletes omitted events, so the current
    event list is read first. Events that already match are left untouched (a
    reconcile pass is otherwise read-mostly); every surplus id is DELETEd
    explicitly. Any request failure raises; the caller retries on the next tick.
    """
    resp = transport.get(f"{host.base}/schedule", auth=auth, timeout=HTTP_TIMEOUT)
    _log_schedule("GET /schedule", resp)
    _require_ok(resp)
    existing = resp.json()
    if not isinstance(existing, list):
        raise ValueError("GET /schedule response is not a JSON array")

    existing_by_id = {}
    for event in existing:
        if not isinstance(event, dict):
            continue
        event_id = event.get("id")
        if not isinstance(event_id, int) or isinstance(event_id, bool):
            continue
        existing_by_id[event_id] = event

    desired = {event["id"] for event in events}
    posted = 0
    for event in events:
        if _event_matches(existing_by_id.get(event["id"]), event):
            continue
        # One event per request: the firmware parses POST bodies into 1 KB.
        resp = transport.post(
            f"{host.base}/schedule", json=event, auth=auth, timeout=HTTP_TIMEOUT
        )
        _log_schedule(f"POST /schedule id={event['id']}", resp)
        _require_ok(resp)
        posted += 1

    removed = 0
    for event_id in existing_by_id:
        if event_id in desired:
            continue
        resp = transport.delete(
            f"{host.base}/schedule/{event_id}", auth=auth, timeout=HTTP_TIMEOUT
        )
        _log_schedule(f"DELETE /schedule/{event_id}", resp)
        _require_ok(resp)
        removed += 1
    log(
        f"schedule synced: {len(events)} events ({posted} posted), "
        f"removed {removed}"
    )


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
