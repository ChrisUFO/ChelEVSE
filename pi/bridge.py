#!/usr/bin/env python3
"""ChelEVSE bridge agent: OpenEVSE charger <-> Firebase Firestore.

Failure-isolated loops (daemon threads; the service never crash-loops):
  status every STATUS_INTERVAL: GET /status -> merge into status/current
  config every CONFIG_INTERVAL: GET /config -> replace status/config
  commands every COMMAND_INTERVAL: pending commands/ docs -> charger HTTP API
Config: env vars with fallback to <repo root>/private/bridge.env.
"""

import math
import os
import signal
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import firebase_admin
from firebase_admin import credentials, firestore

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

_stop = threading.Event()


def log(message):
    """One timestamped line to stdout; journald captures it."""
    print(
        f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}  {message}",
        flush=True,
    )


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

    def seed(self):
        """Seed state from status/current; a failed read just starts empty."""
        try:
            data = (
                self.db.collection("status").document("current").get().to_dict() or {}
            )
        except Exception as exc:
            log(f"status seed failed ({exc.__class__.__name__}: {exc})")
            return
        total = data.get("total_energy")
        if _is_number(total):
            self.total_energy = float(total)
        state = data.get("state")
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
        log(f"status seeded: state={state} total_energy={self.total_energy}")

    def observe(self, data):
        """Track charging state from a successful tick; finalize ended sessions."""
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

    def _finalize_session(self, data):
        """Write sessions/<started_at epoch> for a just-ended charging session."""
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
        ended_at = datetime.now(timezone.utc)
        started_at = ended_at - timedelta(seconds=elapsed)
        session_id = str(int(started_at.timestamp()))
        self.last_charging_energy = None
        self.last_charging_elapsed = None
        try:
            self.db.collection("sessions").document(session_id).set(
                {
                    "started_at": started_at,
                    "ended_at": ended_at,
                    "wh": float(energy),
                    "elapsed": int(elapsed),
                }
            )
        except Exception as exc:
            log(f"session write failed ({exc.__class__.__name__}: {exc})")
        else:
            log(f"session recorded: {session_id} ({energy:g} Wh)")

    def record_history(self, total):
        """Accumulate the total_energy delta into history/<local date>."""
        if not _is_number(total):
            return
        total = float(total)
        previous = self.total_energy
        self.total_energy = total
        if previous is None:
            return  # first observation is a baseline only
        delta = total - previous
        if delta < 0:
            log("total_energy reset; rebaselining history")
            return
        if delta <= 0:
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
            log(f"history write failed ({exc.__class__.__name__}: {exc})")


def _http_reason(resp):
    """Short HTTP failure reason with a bounded body snippet."""
    body = " ".join((resp.text or "").split())[:120]
    reason = f"HTTP {resp.status_code}"
    return f"{reason}: {body}" if body else reason


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


def status_loop(db, base, auth, interval, tracker):
    session = requests.Session()
    status_doc = db.collection("status").document("current")
    while not _stop.is_set():
        try:
            try:
                resp = session.get(f"{base}/status", auth=auth, timeout=HTTP_TIMEOUT)
                resp.raise_for_status()
                payload = resp.json()
                if not isinstance(payload, dict):
                    raise ValueError("status response is not a JSON object")
                fields = parse_status(payload)
            except (requests.RequestException, ValueError) as exc:
                # Charger unreachable or sent garbage: flag offline, keep going.
                log(f"charger offline ({exc.__class__.__name__})")
                status_doc.set(OFFLINE, merge=True)
            else:
                status_doc.set(fields, merge=True)
                tracker.record_history(fields.get("total_energy"))
                tracker.observe(fields)
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
                safe_data = firestore_safe(data)
                config_doc.set({**safe_data, "updated_at": firestore.SERVER_TIMESTAMP})
                # Only log when the charger config actually changed: this loop
                # runs every minute and would otherwise spam the journal.
                if data != last_synced:
                    if safe_data != data:
                        log("config: coerced values Firestore cannot store")
                    log("config synced")
                    last_synced = data
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"config loop error ({exc.__class__.__name__}: {exc})")
        _stop.wait(interval)


def command_loop(db, base, auth, interval):
    session = requests.Session()
    while not _stop.is_set():
        try:
            query = db.collection("commands").where("status", "==", "pending")
            pending = query.order_by("created_at").limit(10).stream()
            for doc in pending:
                cmd = doc.to_dict() or {}
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


def main():
    base = "http://" + cfg("CHARGER_HOST", "192.168.0.145")
    user = cfg("CHARGER_USER")
    auth = (user, cfg("CHARGER_PASS", "")) if user is not None else None  # blank OK
    try:
        status_interval = float(cfg("STATUS_INTERVAL") or 10)
        config_interval = float(cfg("CONFIG_INTERVAL") or 60)
        command_interval = float(cfg("COMMAND_INTERVAL") or 5)
    except ValueError:
        sys.exit(
            "STATUS_INTERVAL, CONFIG_INTERVAL and COMMAND_INTERVAL must be numbers."
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
        f"{config_interval:g}s/{command_interval:g}s"
    )
    tracker = StatusTracker(db)
    tracker.seed()

    status_args = (db, base, auth, status_interval, tracker)
    threading.Thread(target=status_loop, args=status_args, daemon=True).start()
    config_args = (db, base, auth, config_interval)
    threading.Thread(target=config_loop, args=config_args, daemon=True).start()
    command_loop(db, base, auth, command_interval)
    log("bridge stopped")


if __name__ == "__main__":
    main()
