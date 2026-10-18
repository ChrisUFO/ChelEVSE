#!/usr/bin/env python3
"""ChelEVSE bridge agent: OpenEVSE charger <-> Firebase Firestore.

Failure-isolated loops (daemon threads; the service never crash-loops):
  status every STATUS_INTERVAL: GET /status -> merge into status/current
  config every CONFIG_INTERVAL: GET /config -> replace status/config
  schedule every SCHEDULE_INTERVAL: schedule/current -> firmware scheduler,
    GET /schedule/plan -> status/current.schedule
  commands every COMMAND_INTERVAL: pending commands/ docs -> charger HTTP API
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import firebase_admin
from firebase_admin import credentials, exceptions, firestore, messaging

REPO_ROOT = Path(__file__).resolve().parent.parent
HTTP_TIMEOUT = 5  # seconds, per charger request
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
# A pending command older than this is failed without touching the charger.
COMMAND_MAX_AGE = 600
# Pending commands handled per poll.
COMMAND_BATCH = 10
# Two session records whose intervals touch within this window are the same
# charger session (the firmware keeps cumulative counters while plugged in).
SESSION_MERGE_TOLERANCE = 120
# While plugged in, a cumulative continuation may span a long idle gap (nightly
# scheduled charging); beyond this the previous record is too old to assume the
# same plug-in event and is left as its own session.
SESSION_MERGE_MAX_GAP = 48 * 3600
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
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
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
        "amp": data.get("amp"),
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


def apply_command(session, base, auth, cmd):
    """Apply one command document; return extra fields for the command doc."""
    ctype = cmd.get("type")
    if ctype == "pause":
        resp = session.post(
            f"{base}/override",
            json={"state": "disabled"},
            auth=auth,
            timeout=HTTP_TIMEOUT,
        )
        _require_ok(resp)
        return {}
    if ctype == "resume":
        # Clear the manual override; the firmware scheduler takes over again.
        resp = session.delete(f"{base}/override", auth=auth, timeout=HTTP_TIMEOUT)
        if not 200 <= resp.status_code < 300:
            # v5.1.5 answers 500 "Failed to release manual override" when there
            # is nothing to release. The intended end state already holds, so
            # confirm it rather than reporting a spurious failure.
            try:
                status = session.get(f"{base}/status", auth=auth, timeout=HTTP_TIMEOUT)
                status.raise_for_status()
                if (status.json() or {}).get("manual_override") == 0:
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
        resp = session.post(
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
        resp = session.post(
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


def status_loop(db, base, auth, interval, tracker, notifier):
    session = requests.Session()
    status_doc = db.collection("status").document("current")
    while not _stop.is_set():
        try:
            tracker.maybe_seed()
            try:
                resp = session.get(f"{base}/status", auth=auth, timeout=HTTP_TIMEOUT)
                resp.raise_for_status()
                payload = resp.json()
                if not isinstance(payload, dict):
                    raise ValueError("status response is not a JSON object")
                fields = parse_status(payload)
            except (requests.RequestException, ValueError) as exc:
                # Charger unreachable or sent garbage: flag offline, keep going.
                # Edge only: journal and notify once per outage, not per tick.
                if tracker.charger_online is not False:
                    log(f"charger offline ({_offline_reason(exc)})")
                    tracker.charger_online = False
                    # Write the state before notifying so a slow push cannot
                    # leave the app showing a stale online status.
                    status_doc.set(OFFLINE, merge=True)
                    notifier.enqueue("Charger offline")
                else:
                    status_doc.set(OFFLINE, merge=True)
            else:
                # Detect the charging edge against the pre-tick state; observe()
                # updates it afterwards.
                was_charging = tracker.has_state and tracker.previous_state == 3
                is_charging = fields.get("state") == 3
                had_state = tracker.has_state
                status_doc.set(fields, merge=True)
                if tracker.charger_online is False:
                    tracker.charger_online = True
                    log("charger online")
                tracker.record_history(fields.get("total_energy"))
                tracker.observe(fields)
                body = _transition_body(had_state, was_charging, is_charging)
                if body is not None:
                    notifier.enqueue(body)
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"status loop error ({exc.__class__.__name__}: {exc})")
        _stop.wait(interval)


def config_loop(db, base, auth, interval):
    session = requests.Session()
    config_doc = db.collection("status").document("config")
    last_synced = None
    while not _stop.is_set():
        try:
            try:
                resp = session.get(f"{base}/config", auth=auth, timeout=HTTP_TIMEOUT)
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


def command_loop(db, base, auth, interval):
    session = requests.Session()
    while not _stop.is_set():
        try:
            for doc in pending_commands(db):
                cmd = _command_data(doc)
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
                    extra = apply_command(session, base, auth, cmd)
                except CommandError as exc:
                    doc.reference.update({"status": "failed", "error": str(exc)})
                    log(f"command {doc.id} failed: {exc}")
                except requests.RequestException as exc:
                    reason = f"charger request failed ({exc.__class__.__name__})"
                    doc.reference.update({"status": "failed", "error": reason})
                    log(f"command {doc.id} failed: {reason}")
                else:
                    doc.reference.update({"status": "acked", **extra})
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
    if not (isinstance(start, str) and TIME_RE.match(start)):
        log(f"schedule: skipped rule {rule_id} (invalid start)")
        return None
    end = raw.get("end")
    if not (isinstance(end, str) and TIME_RE.match(end)):
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


def _schedule_plan(session, base, auth):
    """GET /schedule/plan as a dict; raises on any failure."""
    resp = session.get(f"{base}/schedule/plan", auth=auth, timeout=HTTP_TIMEOUT)
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


def sync_schedule(session, base, auth, events):
    """Upsert changed firmware events and delete stale ones.

    The firmware upserts by id and never deletes omitted events, so the current
    event list is read first. Events that already match are left untouched (a
    reconcile pass is otherwise read-mostly); every surplus id is DELETEd
    explicitly. Any request failure raises; the caller retries on the next tick.
    """
    resp = session.get(f"{base}/schedule", auth=auth, timeout=HTTP_TIMEOUT)
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
        resp = session.post(
            f"{base}/schedule", json=event, auth=auth, timeout=HTTP_TIMEOUT
        )
        _log_schedule(f"POST /schedule id={event['id']}", resp)
        _require_ok(resp)
        posted += 1

    removed = 0
    for event_id in existing_by_id:
        if event_id in desired:
            continue
        resp = session.delete(
            f"{base}/schedule/{event_id}", auth=auth, timeout=HTTP_TIMEOUT
        )
        _log_schedule(f"DELETE /schedule/{event_id}", resp)
        _require_ok(resp)
        removed += 1
    log(
        f"schedule synced: {len(events)} events ({posted} posted), "
        f"removed {removed}"
    )


def schedule_loop(db, base, auth, interval, reconcile_interval):
    """Mirror schedule/current into the firmware and publish the live window."""
    session = requests.Session()
    status_doc = db.collection("status").document("current")
    last_hash = None
    synced_event_rules = {}
    last_sync = None
    missing_logged = False
    malformed_logged = False
    amps_logged_hash = None
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
                            sync_schedule(session, base, auth, events)
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
                plan = _schedule_plan(session, base, auth)
                status_doc.set(
                    {"schedule": schedule_state(plan, synced_event_rules)}, merge=True
                )
            except (CommandError, requests.RequestException, ValueError) as exc:
                log(f"schedule plan failed ({exc.__class__.__name__}: {exc})")
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"schedule loop error ({exc.__class__.__name__}: {exc})")
        _stop.wait(interval)


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
    tracker = StatusTracker(db)
    tracker.seed()
    notifier = Notifier(db)

    status_args = (db, base, auth, status_interval, tracker, notifier)
    threading.Thread(target=status_loop, args=status_args, daemon=True).start()
    config_args = (db, base, auth, config_interval)
    threading.Thread(target=config_loop, args=config_args, daemon=True).start()
    schedule_args = (db, base, auth, schedule_interval, reconcile_interval)
    threading.Thread(target=schedule_loop, args=schedule_args, daemon=True).start()
    command_loop(db, base, auth, command_interval)
    log("bridge stopped")


if __name__ == "__main__":
    main()
