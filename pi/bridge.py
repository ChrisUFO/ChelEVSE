#!/usr/bin/env python3
"""ChelEVSE bridge agent: OpenEVSE charger <-> Firebase Firestore.

Failure-isolated loops (daemon threads; the service never crash-loops):
  status every STATUS_INTERVAL: GET /status -> merge into status/current
  config every CONFIG_INTERVAL: GET /config -> replace status/config
  schedule every SCHEDULE_INTERVAL: schedule/current -> firmware scheduler,
    GET /schedule/plan -> status/current.schedule
  commands every COMMAND_INTERVAL: pending commands/ docs -> charger HTTP API
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

from mqtt_source import MqttSource

REPO_ROOT = Path(__file__).resolve().parent.parent
HTTP_TIMEOUT = 5  # seconds, per charger request
# First-iteration offsets so /status, /config and /schedule/plan do not fire
# together against the gateway.
CONFIG_INITIAL_DELAY = 3
SCHEDULE_INITIAL_DELAY = 7
STATE_LABELS = {
    1: "ready",
    2: "connected",
    3: "charging",
    254: "sleeping",
    255: "disabled",
}
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
# A pending command older than this is failed without touching the charger.
COMMAND_MAX_AGE = 600
# Pending commands handled per poll.
COMMAND_BATCH = 10
# Applied-but-unacked command ids remembered per process, so a failed ack write
# is retried instead of re-applying the command.
COMMAND_ACK_MEMORY = 256
# Two session records whose intervals touch within this window are the same
# charger session (the firmware keeps cumulative counters while plugged in).
SESSION_MERGE_TOLERANCE = 120
# While plugged in, a cumulative continuation may span a long idle gap (nightly
# scheduled charging); beyond this the previous record is too old to assume the
# same plug-in event and is left as its own session.
SESSION_MERGE_MAX_GAP = 48 * 3600
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
    """Command document cannot be applied to the charger."""


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


class StatusTracker:
    """Status-derived state carried across ticks and bridge restarts."""

    def __init__(self, db):
        self.db = db
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
        if state == 3:
            energy = data.get("session_energy")
            if _is_number(energy) and energy >= 0:
                self.last_charging_energy = energy
            elapsed = data.get("elapsed")
            if _is_number(elapsed) and elapsed >= 0:
                self.last_charging_elapsed = elapsed
        if self.has_state and self.previous_state == 3 and state != 3:
            # A seeded state lets the first tick after a restart close a
            # session that ended while the bridge was down; with no seed the
            # first tick only establishes state.
            self._finalize_session(data)
        self.previous_state = state
        self.has_state = True
        self.state = state
        self.session_energy = data.get("session_energy")
        self.elapsed = data.get("elapsed")

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
        """
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
            self.pending_session = {**payload, "_id": session_id}
            log(f"session write failed ({exc.__class__.__name__}: {exc}); will retry")
        else:
            self.pending_session = None
            log(f"session recorded: {session_id} ({payload['wh']:g} Wh)")

    def _flush_pending_session(self):
        """Retry a session write that failed on an earlier tick."""
        if self.pending_session is None:
            return
        record = self.pending_session
        self._write_session(record.get("_id"), record)

    def record_history(self, total):
        """Accumulate the total_energy delta into history/<local date>."""
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
        day = datetime.now().astimezone().date().isoformat()
        try:
            self.db.collection("history").document(day).set(
                {
                    "kwh": firestore.Increment(delta),
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
        except Exception as exc:
            # Keep the old baseline so the same delta is retried next tick.
            log(f"history write failed ({exc.__class__.__name__}: {exc})")
            return
        self.total_energy = total


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
    if candidate.get("_id") is not None:
        merged["_id"] = candidate["_id"]
    return merged


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


def _rapi_result(resp):
    """RAPI reply's ret value, or the raw text when the body is not JSON."""
    try:
        body = resp.json()
    except ValueError:
        return resp.text.strip() or None
    return body.get("ret") if isinstance(body, dict) else None


def apply_command(transport, base, auth, cmd):
    """Apply one command document; return extra fields for the command doc."""
    ctype = cmd.get("type")
    if ctype == "pause":
        resp = transport.post(
            f"{base}/override",
            json={"state": "disabled"},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_ok(resp)
        return {}
    if ctype == "resume":
        # Clear the manual override; the firmware scheduler takes over again.
        resp = transport.delete(f"{base}/override", auth=auth, timeout=HTTP_TIMEOUT)
        if not 200 <= resp.status_code < 300:
            # v5.1.5 answers 500 "Failed to release manual override" when there
            # is nothing to release. The intended end state already holds, so
            # confirm it rather than reporting a spurious failure.
            try:
                status = transport.get(f"{base}/status", auth=auth, timeout=HTTP_TIMEOUT)
                status.raise_for_status()
                body = status.json()
                if isinstance(body, dict) and body.get("manual_override") == 0:
                    log("resume: no manual override to release; treating as acked")
                    return {}
            except (requests.RequestException, ValueError):
                pass
        _require_ok(resp)
        return {}
    if ctype == "set_current":
        try:
            amps = max(MIN_AMPS, min(MAX_AMPS, int(cmd.get("amps"))))
        except (TypeError, ValueError):
            raise CommandError("missing or invalid amps")
        resp = transport.post(
            f"{base}/override",
            json={"state": "active", "charge_current": amps, "max_current": amps},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_ok(resp)
        return {}
    if ctype == "rapi":
        command = cmd.get("command")
        if (
            not isinstance(command, str)
            or not command.startswith("$")
            or len(command) > 32
        ):
            raise CommandError("invalid rapi")
        resp = transport.post(
            f"{base}/rapi",
            data={"rapi": command, "json": 1},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_ok(resp)
        result = _rapi_result(resp)
        log(f"rapi {command}: ret={result!r}")
        return {"result": result}
    raise CommandError("unsupported type")


def notify(db, body):
    """Push one notification to every registered FCM token; never raises.

    Tokens live in fcmTokens/{docId} with an optional `token` field (the doc id
    is the fallback). Each token is sent independently so one dead token cannot
    block the rest; unregistered/invalid tokens are pruned.
    """
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
                log(f"pruned fcm token {doc.id}")
            except Exception as exc:
                log(f"fcm token prune failed ({exc.__class__.__name__}: {exc})")
        except Exception as exc:
            log(f"fcm send failed ({exc.__class__.__name__}: {exc})")


class Notifier:
    """Background FCM sender: status ticks enqueue and never wait on a push.

    firebase-admin's HTTP client defaults to a long timeout with retries, so a
    stalled FCM/network call must not hold the status loop (and with it status,
    history and session writes). One daemon worker drains a bounded queue; a
    full queue drops the newest push rather than blocking the caller.
    """

    def __init__(self, db, max_queue=64):
        self.db = db
        self.queue = queue.Queue(maxsize=max_queue)
        self._thread = None
        self._lock = threading.Lock()

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
                notify(self.db, body)
            except Exception as exc:  # never let one push kill the worker
                log(f"fcm notify error ({exc.__class__.__name__}: {exc})")
            finally:
                self.queue.task_done()


def _transition_body(had_state, was_charging, is_charging):
    """FCM body for a charging-state edge, or None when there is no edge."""
    if not had_state or was_charging == is_charging:
        return None
    return "Charging started" if is_charging else "Charging stopped"


class StatusSink:
    """The one status write path, shared by the HTTP poll and MQTT snapshots.

    Both transports describe the same charger state, so history, sessions and
    transition notifications run here exactly once per real change: the edge is
    computed against the tracker's pre-tick state, which the first source
    advances, so a second source reporting the same state has no edge left.
    """

    def __init__(self, db, tracker, notifier):
        self.status_doc = db.collection("status").document("current")
        self.tracker = tracker
        self.notifier = notifier
        # The HTTP poll and the MQTT worker can apply at the same time; the
        # tracker's state machine is not thread-safe on its own.
        self._lock = threading.Lock()

    def apply_status(self, fields, source):
        """Merge one parsed status snapshot and run the derived edge logic."""
        with self._lock:
            self._apply(fields, source)

    def maybe_seed(self):
        """Retry the stored baseline under the same lock as the applies."""
        with self._lock:
            self.tracker.maybe_seed()

    def _apply(self, fields, source):
        tracker = self.tracker
        had_state = tracker.has_state
        was_charging = tracker.has_state and tracker.previous_state == 3
        is_charging = fields.get("state") == 3
        self.status_doc.set(fields, merge=True)
        if tracker.charger_online is False:
            tracker.charger_online = True
            log(f"charger online ({source})")
        tracker.record_history(fields.get("total_energy"))
        tracker.observe(fields)
        body = _transition_body(had_state, was_charging, is_charging)
        if body is not None:
            self.notifier.enqueue(body)


def write_transport_health(db, source, mqtt_connected):
    """Publish the active status source into status/health (merge semantics).

    Merged, never replaced: the watchdog owns the rest of the document and its
    writes merge too, so neither can clobber the other's fields.
    """
    try:
        db.collection("status").document("health").set(
            {
                "source": source,
                "mqtt_connected": mqtt_connected,
                "updated_at": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
    except Exception as exc:
        log(f"health transport write failed ({exc.__class__.__name__}: {exc})")


def enqueue_latest(snapshots, fields):
    """Keep only the newest snapshot queued for the apply worker.

    A slow Firestore write must not build a backlog of stale snapshots: each
    snapshot is complete, so replacing the queued one loses nothing.
    """
    try:
        snapshots.put_nowait(fields)
    except queue.Full:
        try:
            snapshots.get_nowait()
        except queue.Empty:
            pass
        try:
            snapshots.put_nowait(fields)
        except queue.Full:
            pass


def mqtt_status_loop(sink, snapshots):
    """Apply debounced MQTT snapshots as they arrive (event-driven writes).

    Runs on its own thread so a Firestore write never blocks paho's network
    loop. A failed write is a log line; the next snapshot and the 60 s HTTP
    reconciliation both carry the full state.
    """
    while not _stop.is_set():
        try:
            fields = snapshots.get(timeout=MQTT_TICK_SEC)
        except queue.Empty:
            continue
        try:
            sink.apply_status(fields, "mqtt")
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


def mqtt_config():
    """MQTT settings from the environment; bad values raise ValueError."""
    enabled = _env_bool("MQTT_ENABLED", False)
    host = (cfg("MQTT_HOST") or "").strip()
    port = _env_finite("MQTT_PORT", 1883, int)
    reconcile_sec = _env_finite("MQTT_RECONCILE_SEC", MQTT_RECONCILE_SEC, float)
    topic = (cfg("MQTT_TOPIC") or DEFAULT_MQTT_TOPIC).strip().strip("/")
    client_id = (cfg("MQTT_CLIENT_ID") or "").strip() or DEFAULT_MQTT_CLIENT_ID
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
    )


def mqtt_config_or_exit():
    """MQTT settings for ``main()``: a bad value stops the bridge by name."""
    try:
        return mqtt_config()
    except ValueError as exc:
        sys.exit(str(exc))


def attempts_within(now, attempts, window):
    """Attempt timestamps inside the trailing ``window`` seconds.

    An attempt exactly ``window`` seconds old still counts, so the cap is a
    closed hour rather than one that silently forgets its oldest entry.
    """
    return [at for at in attempts if (now - at).total_seconds() <= window]


def _decision(action, reason, alert=None):
    """One watchdog decision; ``alert`` is the push body when one is due."""
    return {"action": action, "reason": reason, "alert": alert}


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
):
    """Decide what the watchdog does about the current failure streak.

    Pure: every input, the clock included, is injected, so the whole guard
    matrix is testable without a charger or Firestore. ``attempts_in_window`` is
    the sequence of previous attempt times; entries older than ``window``
    seconds are ignored here, so the caller can keep the full history and let
    the window expire it.

    Returns ``{action, reason, alert}``: action is ``none``, ``alert``,
    ``restart_gateway`` or ``restart_evse``, and ``alert`` is the body the
    caller should push when it enters an unhealthy episode (it owns edge
    detection). A guard-blocked ``none`` carries a body naming the guard, so a
    blocked episode never reads as a failed restart.
    """
    if not enabled:
        return _decision("none", "watchdog disabled")
    if consecutive_failures < threshold:
        return _decision(
            "none", f"{consecutive_failures}/{threshold} consecutive failures"
        )
    if not http_reachable:
        # POST /restart uses the same HTTP endpoint, so a gateway that answers
        # nothing at all (mains off, Wi-Fi dropped) cannot be recovered
        # remotely; a human has to power-cycle it.
        return _decision(
            "alert",
            "charger unreachable over HTTP; cannot restart remotely",
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
    if controller_ok:
        return _decision(
            "restart_gateway",
            "HTTP answered but the gateway was failing",
            WATCHDOG_ALERT_RESTART,
        )
    return _decision(
        "restart_evse", "controller is not answering", WATCHDOG_ALERT_RESTART_EVSE
    )


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
    """

    def __init__(self, db, base, auth, transport, notifier, config, clock=None):
        self.db = db
        self.base = base
        self.auth = auth
        self.transport = transport
        self.notifier = notifier
        self.config = config
        self.clock = clock or _utcnow
        self.health_doc = db.collection("status").document("health")
        self.failures = 0
        self.samples = []
        self.attempts = []
        self.last_attempt_at = None
        self.state = None  # None (no observation yet) | "healthy" | "unhealthy"
        self.reason = "starting"
        self.last_action = None
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
                f"{self.base}/status", auth=self.auth, timeout=HTTP_TIMEOUT
            )
            resp.raise_for_status()
            payload = resp.json()
            if not isinstance(payload, dict):
                raise ValueError("status response is not a JSON object")
        except (requests.RequestException, ValueError) as exc:
            log(f"watchdog: probe failed ({_offline_reason(exc)})")
            return False, None
        return True, payload

    def _decide(self, now, charging, http_ok, controller_ok):
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
        )

    def _restart(self, device):
        """POST /restart for one device; return a short result string."""
        try:
            resp = self.transport.post(
                f"{self.base}/restart",
                json={"device": device},
                auth=self.auth,
                timeout=HTTP_TIMEOUT,
            )
            _require_ok(resp)
        except (CommandError, requests.RequestException) as exc:
            return f"failed ({exc})"
        return f"HTTP {resp.status_code}"

    def _attempt(self, action, now, http_ok, controller_ok, charging):
        """Send one restart and record its outcome."""
        device = "evse" if action == "restart_evse" else "gateway"
        log(
            f"watchdog: {action} -> POST /restart device={device} "
            f"(failures={self.failures} http_ok={http_ok} "
            f"controller_ok={controller_ok} charging={charging})"
        )
        self.last_result = self._restart(device)
        self.last_attempt_at = now
        self.attempts.append(now)
        self.last_action = action
        self.episode_attempts += 1
        log(f"watchdog: restart device={device} -> {self.last_result}")

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
        so a healthy bridge writes it once. Merged so the transport fields
        (``source``/``mqtt_connected``) survive, and so a transport write never
        erases the watchdog's state.
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
            "last_result": self.last_result,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }
        try:
            self.health_doc.set(document, merge=True)
        except Exception as exc:
            log(f"watchdog: health write failed ({exc.__class__.__name__}: {exc})")

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
        decision = self._decide(now, charging, http_ok, controller_ok)
        action = decision["action"]
        entered = self.state != "unhealthy"
        if entered:
            self.state = "unhealthy"
            self.failed_alerted = False
            self.episode_attempts = 0
            log(
                f"watchdog: unhealthy after {self.failures} failed polls "
                f"(http_ok={http_ok} controller_ok={controller_ok} "
                f"charging={charging})"
            )
        self.reason = decision["reason"]
        self._log_decision(decision)

        alert = decision["alert"] if entered else None
        changed = entered
        if action in WATCHDOG_RESTART_ACTIONS:
            self._attempt(action, now, http_ok, controller_ok, charging)
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
            # claiming the last attempt's fields.
            self.last_action = "alert" if action == "alert" else "none"
            self.last_result = (
                "charger unreachable over HTTP; not restarted"
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
    base,
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
    watchdog, but does not mark the charger offline (it is still reporting).
    """
    status_doc = db.collection("status").document("current")
    sink = sink or StatusSink(db, tracker, notifier)
    source = None
    next_poll = 0.0
    mqtt_snapshots = 0
    while not _stop.is_set():
        now = time.monotonic()
        mqtt_connected = mqtt is not None and mqtt.connected
        current = "mqtt" if mqtt_connected else "http"
        if mqtt is not None and current != source:
            previous, source = source, current
            if mqtt_connected:
                detail = "mqtt connected"
                mqtt_snapshots = mqtt.snapshots
            elif previous == "mqtt":
                detail = f"mqtt disconnected after {mqtt.messages} messages"
            else:
                detail = "mqtt not connected"
            log(f"status source: {source} ({detail})")
            write_transport_health(db, source, mqtt_connected)
            next_poll = now
        try:
            # Without MQTT the wait interval is the cadence (unchanged); with it
            # the loop ticks every second and polls only when reconciliation is
            # due or the source just changed.
            if mqtt is None or now >= next_poll:
                sink.maybe_seed()
                try:
                    resp = transport.get(
                        f"{base}/status", auth=auth, timeout=HTTP_TIMEOUT
                    )
                    resp.raise_for_status()
                    payload = resp.json()
                    if not isinstance(payload, dict):
                        raise ValueError("status response is not a JSON object")
                    fields = parse_status(payload)
                except (requests.RequestException, ValueError) as exc:
                    # A reconcile failure is not an outage while MQTT snapshots
                    # are still arriving. No snapshot since the last poll means
                    # neither transport sees the charger, which is an outage
                    # (the broker-side LWT is PR-3; this needs no timer).
                    silent = mqtt_connected and mqtt.snapshots == mqtt_snapshots
                    if mqtt_connected and not silent:
                        log(f"status reconcile failed ({_offline_reason(exc)})")
                        # Compare the next failure against this check, not the
                        # last successful poll (which may be long past).
                        mqtt_snapshots = mqtt.snapshots
                    elif tracker.charger_online is not False:
                        # Charger unreachable or sent garbage: flag offline, keep
                        # going. Edge only: journal and notify once per outage.
                        log(f"charger offline ({_offline_reason(exc)})")
                        tracker.charger_online = False
                        # Write the state before notifying so a slow push cannot
                        # leave the app showing a stale online status.
                        status_doc.set(OFFLINE, merge=True)
                        notifier.enqueue("Charger offline")
                    else:
                        status_doc.set(OFFLINE, merge=True)
                    # Only a successful HTTP poll clears the streak, so a
                    # failure still means what it always meant to the watchdog.
                    watchdog.observe_failure(tracker.state == 3)
                else:
                    if mqtt is not None:
                        # Seed before applying: the snapshot then carries the
                        # fields MQTT never publishes (comm_*, rapi_connected).
                        mqtt.seed(payload)
                        mqtt_snapshots = mqtt.snapshots
                    sink.apply_status(fields, "http")
                    watchdog.record_success(payload)
                next_poll = now + (
                    reconcile_interval if mqtt_connected else interval
                )
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"status loop error ({exc.__class__.__name__}: {exc})")
        _stop.wait(interval if mqtt is None else MQTT_TICK_SEC)


def config_loop(
    db,
    base,
    auth,
    transport,
    interval,
    initial_delay=0,
    mqtt=None,
    config_event=None,
    tick=MQTT_TICK_SEC,
):
    """Sync /config; with MQTT, only when ``config_version`` changed.

    The version event is set by the MQTT source. While the broker is connected
    the periodic HTTP poll is skipped entirely; the ``tick`` wait bounds how long
    a disconnect can go unnoticed (then the 60 s poll resumes).
    """
    config_doc = db.collection("status").document("config")
    last_synced = None
    if initial_delay:
        # Offset from the other pollers; only the first iteration is delayed.
        _stop.wait(initial_delay)
    while not _stop.is_set():
        mqtt_mode = False
        try:
            mqtt_mode = mqtt is not None and config_event is not None and mqtt.connected
            if mqtt_mode:
                # Only a config_version change (or a reconnect republish) syncs.
                if not config_event.wait(tick):
                    continue
                config_event.clear()
            try:
                resp = transport.get(f"{base}/config", auth=auth, timeout=HTTP_TIMEOUT)
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    raise ValueError("config response is not a JSON object")
            except (requests.RequestException, ValueError) as exc:
                log(f"config sync failed ({exc.__class__.__name__})")
            else:
                redacted = redact_config(data)
                safe_data = firestore_safe(redacted)
                config_doc.set({**safe_data, "updated_at": firestore.SERVER_TIMESTAMP})
                # Only log when the charger config actually changed: this loop
                # runs every minute and would otherwise spam the journal.
                if data != last_synced:
                    secret_count = sum(1 for key in data if key in SECRET_CONFIG_KEYS)
                    if secret_count:
                        log(f"config: redacted {secret_count} credential fields")
                    if firestore_safe(data) != data:
                        log("config: coerced values Firestore cannot store")
                    log("config synced")
                    last_synced = data
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"config loop error ({exc.__class__.__name__}: {exc})")
        if not mqtt_mode:
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


def command_loop(db, base, auth, transport, interval):
    # Commands applied whose ack write failed. Retry the write rather than the
    # charger request; bounded and process-local, so an apply/ack gap that spans
    # a restart can still re-apply (at-least-once across restarts).
    unacked = OrderedDict()
    while not _stop.is_set():
        try:
            for doc in pending_commands(db):
                cmd = _command_data(doc)
                if doc.id in unacked:
                    # Already applied; only its ack write still needs to land.
                    extra = unacked[doc.id]
                else:
                    if command_is_stale(cmd):
                        reason = f"stale command (older than {COMMAND_MAX_AGE}s)"
                        try:
                            doc.reference.update({"status": "failed", "error": reason})
                        except Exception as exc:
                            log(
                                f"command {doc.id} stale update failed "
                                f"({exc.__class__.__name__}: {exc})"
                            )
                            continue
                        log(f"command {doc.id} failed: {reason}")
                        continue
                    try:
                        extra = apply_command(transport, base, auth, cmd)
                    except CommandError as exc:
                        doc.reference.update({"status": "failed", "error": str(exc)})
                        log(f"command {doc.id} failed: {exc}")
                        continue
                    except requests.RequestException as exc:
                        reason = f"charger request failed ({exc.__class__.__name__})"
                        doc.reference.update({"status": "failed", "error": reason})
                        log(f"command {doc.id} failed: {reason}")
                        continue
                    unacked[doc.id] = extra
                    while len(unacked) > COMMAND_ACK_MEMORY:
                        unacked.popitem(last=False)
                try:
                    doc.reference.update({"status": "acked", **extra})
                except Exception as exc:
                    log(
                        f"command {doc.id} ack update failed "
                        f"({exc.__class__.__name__}: {exc}); will retry without re-applying"
                    )
                    continue
                unacked.pop(doc.id, None)
                log(f"command {doc.id} acked: {cmd.get('type')}")
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


def _schedule_plan(transport, base, auth):
    """GET /schedule/plan as a dict; raises on any failure."""
    resp = transport.get(
        f"{base}/schedule/plan", auth=auth, timeout=HTTP_TIMEOUT
    )
    # Logged only on failure (via the caller): this runs every SCHEDULE_INTERVAL.
    _require_ok(resp)
    plan = resp.json()
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


def sync_schedule(transport, base, auth, events):
    """Upsert changed firmware events and delete stale ones.

    The firmware upserts by id and never deletes omitted events, so the current
    event list is read first. Events that already match are left untouched (a
    reconcile pass is otherwise read-mostly); every surplus id is DELETEd
    explicitly. Any request failure raises; the caller retries on the next tick.
    """
    resp = transport.get(f"{base}/schedule", auth=auth, timeout=HTTP_TIMEOUT)
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
            f"{base}/schedule", json=event, auth=auth, timeout=HTTP_TIMEOUT
        )
        _log_schedule(f"POST /schedule id={event['id']}", resp)
        _require_ok(resp)
        posted += 1

    removed = 0
    for event_id in existing_by_id:
        if event_id in desired:
            continue
        resp = transport.delete(
            f"{base}/schedule/{event_id}", auth=auth, timeout=HTTP_TIMEOUT
        )
        _log_schedule(f"DELETE /schedule/{event_id}", resp)
        _require_ok(resp)
        removed += 1
    log(
        f"schedule synced: {len(events)} events ({posted} posted), "
        f"removed {removed}"
    )


def schedule_loop(db, base, auth, transport, interval, reconcile_interval, initial_delay=0):
    """Mirror schedule/current into the firmware and publish the live window."""
    status_doc = db.collection("status").document("current")
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
                            sync_schedule(transport, base, auth, events)
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

            # Always publish the firmware's own view of the active window,
            # mapped through the last event set that actually synced.
            try:
                plan = _schedule_plan(transport, base, auth)
                status_doc.set(
                    {"schedule": schedule_state(plan, synced_event_rules)}, merge=True
                )
            except (CommandError, requests.RequestException, ValueError) as exc:
                log(f"schedule plan failed ({exc.__class__.__name__}: {exc})")
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"schedule loop error ({exc.__class__.__name__}: {exc})")
        _stop.wait(interval)


def run(db, base, auth, intervals, transport, watchdog_config, mqtt=None):
    """Start the pollers; blocks on the command loop until the stop event.

    Every loop gets the same ``transport``: one Session and one bounded
    keep-alive pool per process. With ``mqtt`` (an enabled MqttConfig) the
    source is started and its snapshots are applied on their own worker; the
    status and config loops then reconcile instead of polling.
    """
    (
        status_interval,
        config_interval,
        schedule_interval,
        reconcile_interval,
        command_interval,
    ) = intervals
    tracker = StatusTracker(db)
    tracker.seed()
    notifier = Notifier(db)
    watchdog = Watchdog(db, base, auth, transport, notifier, watchdog_config)
    sink = StatusSink(db, tracker, notifier)

    source = None
    snapshots = None
    config_event = None
    mqtt_status_args = None
    if mqtt is not None and mqtt.enabled:
        snapshots = queue.Queue(maxsize=1)
        config_event = threading.Event()
        source = MqttSource(
            host=mqtt.host,
            port=mqtt.port,
            topic=mqtt.topic,
            user=mqtt.user,
            password=mqtt.password,
            client_id=mqtt.client_id,
            on_status=lambda fields: enqueue_latest(snapshots, fields),
            on_config_version=lambda _version: config_event.set(),
        )
        mqtt_status_args = (sink, snapshots)

    status_args = (
        db,
        base,
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
        base,
        auth,
        transport,
        config_interval,
        CONFIG_INITIAL_DELAY,
        source,
        config_event,
    )
    threading.Thread(target=config_loop, args=config_args, daemon=True).start()
    schedule_args = (
        db,
        base,
        auth,
        transport,
        schedule_interval,
        reconcile_interval,
        SCHEDULE_INITIAL_DELAY,
    )
    threading.Thread(target=schedule_loop, args=schedule_args, daemon=True).start()
    if mqtt_status_args is not None:
        threading.Thread(
            target=mqtt_status_loop, args=mqtt_status_args, daemon=True
        ).start()
        source.start()
    command_loop(db, base, auth, transport, command_interval)
    if source is not None:
        source.stop()


def main():
    base = "http://" + cfg("CHARGER_HOST", "192.168.0.145")
    user = cfg("CHARGER_USER")
    auth = (user, cfg("CHARGER_PASS", "")) if user is not None else None  # blank OK
    try:
        status_interval = float(cfg("STATUS_INTERVAL") or 10)
        config_interval = float(cfg("CONFIG_INTERVAL") or 60)
        schedule_interval = float(cfg("SCHEDULE_INTERVAL") or 60)
        reconcile_interval = float(cfg("SCHEDULE_RECONCILE_INTERVAL") or 300)
        command_interval = float(cfg("COMMAND_INTERVAL") or 5)
    except ValueError:
        sys.exit(
            "STATUS_INTERVAL, CONFIG_INTERVAL, SCHEDULE_INTERVAL, "
            "SCHEDULE_RECONCILE_INTERVAL and COMMAND_INTERVAL must be numbers."
        )

    try:
        db = init_firestore()
    except RuntimeError as exc:
        sys.exit(str(exc))

    watchdog = watchdog_config_or_exit()
    mqtt = mqtt_config_or_exit()

    def stop(signum, _frame):
        log(f"received signal {signum}, stopping")
        _stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)

    log(
        f"bridge started: {base}, polls {status_interval:g}s/"
        f"{config_interval:g}s/{schedule_interval:g}s/{command_interval:g}s, "
        f"schedule reconcile {reconcile_interval:g}s"
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
    )
    run(
        db,
        base,
        auth,
        intervals,
        ChargerTransport(make_charger_session()),
        watchdog,
        mqtt,
    )
    log("bridge stopped")


if __name__ == "__main__":
    main()
