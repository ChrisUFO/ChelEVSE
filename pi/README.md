# Pi bridge agent

A small Python service that bridges the OpenEVSE charger to Firebase: it polls
the charger's local HTTP API and merges into the Firestore `status/current`
document, and applies pending `commands/*` documents (`pause` / `resume` /
`set_current`) back to the charger. Runs under systemd with `Restart=always`.
See [../ARCHITECTURE.md](../ARCHITECTURE.md) for the big picture.

## Prerequisites

- Raspberry Pi OS (Bookworm) on the same LAN as the charger
- `git` and `python3-venv`: `sudo apt install git python3-venv`

## Install

From a clone of this repo on the Pi:

```bash
cp -r private.example private     # if not already done
nano private/bridge.env           # charger IP, key path, intervals
# place the Firebase service-account key, e.g. private/service-account.json
# (Firebase Console → Project settings → Service accounts → Generate new private key)
sudo bash pi/install.sh
```

The installer syncs `pi/` and `private/` to `/opt/chelevse`, builds a venv at
`/opt/chelevse/pi/.venv`, installs the `chelevse-bridge` systemd unit, and
enables + starts it. It is idempotent — re-run it after `git pull` to update.

**One-time Firestore index:** the pending-commands query (`status ==` pending,
ordered by `created_at`) needs a composite index. If the bridge log shows
"query requires an index", open the link in that log line (or create it in
Firebase Console → Firestore → Indexes: collection `commands`, `status` Ascending + `created_at` Ascending).

## Configuration

Environment variables, read from `private/bridge.env` (see
[../private.example/bridge.env.example](../private.example/bridge.env.example));
real environment variables take precedence.

| Variable | Default | Meaning |
|---|---|---|
| `CHARGER_HOST` | `192.168.0.145` | Charger IP on the LAN |
| `CHARGER_USER` / `CHARGER_PASS` | unset | HTTP Basic auth if set on the charger (blank username is valid) |
| `FIREBASE_SERVICE_ACCOUNT` | — | Path to the service-account key (**required**; relative paths resolve from the repo root) |
| `STATUS_INTERVAL` | `10` | Seconds between charger status polls |
| `COMMAND_INTERVAL` | `5` | Seconds between command polls |

## Logs

```bash
journalctl -u chelevse-bridge -f
```

## Uninstall

```bash
sudo systemctl disable --now chelevse-bridge
sudo rm /etc/systemd/system/chelevse-bridge.service
sudo systemctl daemon-reload
sudo rm -rf /opt/chelevse
```
