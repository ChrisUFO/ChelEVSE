#!/usr/bin/env bash
# ChelEVSE bridge installer for Raspberry Pi OS.
# Idempotent — safe to re-run any time (e.g. after git pull).
# Run with sudo from the repo root on the Pi:
#   sudo bash pi/install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="/opt/chelevse"

if [ "$(id -u)" -ne 0 ]; then
    echo "error: run with sudo: sudo bash pi/install.sh" >&2
    exit 1
fi
command -v rsync >/dev/null || {
    echo "error: rsync is required (sudo apt install rsync)" >&2
    exit 1
}

# --- preflight: private config must exist -----------------------------------
if [ ! -f "$REPO_ROOT/private/bridge.env" ]; then
    echo "error: $REPO_ROOT/private/bridge.env not found" >&2
    echo "       fix:  cp -r private.example private   (then edit private/bridge.env)" >&2
    echo "       see:  private.example/README.md" >&2
    exit 1
fi
KEY_PATH="$(grep -E '^[[:space:]]*FIREBASE_SERVICE_ACCOUNT=' "$REPO_ROOT/private/bridge.env" \
            | tail -n1 | cut -d= -f2- | tr -d "\"'")"
KEY_PATH="${FIREBASE_SERVICE_ACCOUNT:-$KEY_PATH}"
case "$KEY_PATH" in
    /*) ;;
    *) KEY_PATH="$REPO_ROOT/$KEY_PATH" ;;
esac
if [ ! -f "$KEY_PATH" ]; then
    echo "error: Firebase service-account key not found: $KEY_PATH" >&2
    echo "       (from FIREBASE_SERVICE_ACCOUNT in private/bridge.env)" >&2
    echo "       see:  private.example/README.md — Firebase Console > Project settings >" >&2
    echo "             Service accounts > Generate new private key" >&2
    exit 1
fi

# --- sync files to /opt/chelevse (venv is preserved) ------------------------
install -d "$DEST"
rsync -a --delete --exclude '.venv' "$REPO_ROOT/pi/" "$DEST/pi/"
if [ -d "$REPO_ROOT/private" ]; then
    rsync -a "$REPO_ROOT/private/" "$DEST/private/"
fi

# --- venv + dependencies ------------------------------------------------------
if [ ! -x "$DEST/pi/.venv/bin/python" ]; then
    python3 -m venv "$DEST/pi/.venv"
fi
"$DEST/pi/.venv/bin/pip" install -r "$DEST/pi/requirements.txt"

# --- systemd -------------------------------------------------------------------
install -m 0644 "$DEST/pi/chelevse-bridge.service" /etc/systemd/system/chelevse-bridge.service
systemctl daemon-reload
systemctl enable --now chelevse-bridge
systemctl restart chelevse-bridge  # pick up new code on re-runs; harmless on first install

echo
echo "Installed and running."
echo "  status:  systemctl status chelevse-bridge"
echo "  logs:    journalctl -u chelevse-bridge -f"
