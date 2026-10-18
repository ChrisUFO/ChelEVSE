#!/usr/bin/env python3
"""ChelEVSE bridge agent: OpenEVSE charger <-> Firebase Firestore.

Two failure-isolated loops (one thread each; the service never crash-loops):
  status every STATUS_INTERVAL: GET /status -> merge into status/current
  commands every COMMAND_INTERVAL: pending commands/ docs -> POST /override
Config: env vars with fallback to <repo root>/private/bridge.env.
"""

import os
import signal
import sys
import threading
from datetime import datetime, timezone
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
        "temp_c": round(sum(temps) / len(temps) / 10, 1) if temps else None,
        "charger_online": True,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }


def command_body(cmd):
    """Command document -> OpenEVSE /override JSON body."""
    ctype = cmd.get("type")
    if ctype in ("pause", "resume"):
        return {"state": "disabled" if ctype == "pause" else "active"}
    if ctype == "set_current":
        try:
            amps = max(MIN_AMPS, min(MAX_AMPS, int(cmd.get("amps"))))
        except (TypeError, ValueError):
            raise CommandError("missing or invalid amps")
        return {"state": "active", "charge_current": amps, "max_current": amps}
    raise CommandError("unsupported type")


def post_override(session, base, auth, body):
    return session.post(f"{base}/override", json=body, auth=auth, timeout=HTTP_TIMEOUT)


def status_loop(db, base, auth, interval):
    session = requests.Session()
    status_doc = db.collection("status").document("current")
    while not _stop.is_set():
        try:
            try:
                resp = session.get(f"{base}/status", auth=auth, timeout=HTTP_TIMEOUT)
                resp.raise_for_status()
                status_doc.set(parse_status(resp.json()), merge=True)
            except (requests.RequestException, ValueError) as exc:
                # Charger unreachable or sent garbage: flag offline, keep going.
                log(f"charger offline ({exc.__class__.__name__})")
                status_doc.set(OFFLINE, merge=True)
        except Exception as exc:  # anything else (e.g. Firestore blip): log, keep going
            log(f"status loop error ({exc.__class__.__name__}: {exc})")
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
                    resp = post_override(session, base, auth, command_body(cmd))
                    resp.raise_for_status()
                except CommandError as exc:
                    doc.reference.update({"status": "failed", "error": str(exc)})
                    log(f"command {doc.id} failed: {exc}")
                except requests.RequestException as exc:
                    reason = f"charger request failed ({exc.__class__.__name__})"
                    doc.reference.update({"status": "failed", "error": reason})
                    log(f"command {doc.id} failed: {reason}")
                else:
                    doc.reference.update({"status": "acked"})
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
        command_interval = float(cfg("COMMAND_INTERVAL") or 5)
    except ValueError:
        sys.exit("STATUS_INTERVAL and COMMAND_INTERVAL must be numbers.")

    key_path = cfg("FIREBASE_SERVICE_ACCOUNT")
    if not key_path:
        sys.exit("FIREBASE_SERVICE_ACCOUNT not set — see private.example/README.md")
    key_file = Path(key_path)
    if not key_file.is_absolute():
        key_file = REPO_ROOT / key_file
    if not key_file.is_file():
        sys.exit(f"service-account key not found: {key_file}")

    firebase_admin.initialize_app(credentials.Certificate(str(key_file)))
    db = firestore.client()

    def stop(signum, _frame):
        log(f"received signal {signum}, stopping")
        _stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)

    log(f"bridge started: {base}, polls {status_interval:g}s/{command_interval:g}s")
    status_args = (db, base, auth, status_interval)
    threading.Thread(target=status_loop, args=status_args, daemon=True).start()
    command_loop(db, base, auth, command_interval)
    log("bridge stopped")


if __name__ == "__main__":
    main()
