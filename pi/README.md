# Pi bridge agent

A small Python service that bridges the OpenEVSE charger to Firebase: it polls
the charger's local HTTP API, mirrors status and config into Firestore
(`status/current`, `status/config`), derives daily energy history and completed
sessions, and applies pending `commands/*` documents back to the charger. Runs
under systemd with `Restart=always`.
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

| Variable                        | Default         | Meaning                                                                                   |
| ------------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `CHARGER_HOST`                  | `192.168.0.145` | Charger IP on the LAN                                                                     |
| `CHARGER_USER` / `CHARGER_PASS` | unset           | HTTP Basic auth if set on the charger (blank username is valid)                           |
| `FIREBASE_SERVICE_ACCOUNT`      | —               | Path to the service-account key (**required**; relative paths resolve from the repo root) |
| `STATUS_INTERVAL`               | `10`            | Seconds between charger status polls                                                      |
| `CONFIG_INTERVAL`               | `60`            | Seconds between charger config polls                                                      |
| `COMMAND_INTERVAL`              | `5`             | Seconds between command polls                                                             |

## What the bridge writes

Each loop is failure-isolated: a charger or Firestore error is logged as one
timestamped line and the loop carries on at its next interval.

| Loop     | Firestore document | Content                                                                           |
| -------- | ------------------ | --------------------------------------------------------------------------------- |
| Status   | `status/current`   | Full `/status` snapshot, merged on every poll                                     |
| Status   | `history/<date>`   | `{kwh, updated_at}`, accumulated from `total_energy` deltas                       |
| Config   | `status/config`    | Raw `/config` object plus `updated_at`, refreshed every `CONFIG_INTERVAL` seconds |
| Commands | `commands/{id}`    | `status` set to `acked` or `failed` (plus `error` / `result` fields)              |

`status/config` is replaced wholesale (not merged), so removed charger settings
disappear from the document. The charger's config is logged only when it
changes to keep the journal quiet.

### Energy history

Each successful status tick compares `total_energy` (kWh) with the previous
reading and increments `history/<YYYY-MM-DD>` by the difference:

```
history/2026-10-18   { kwh: 12.34, updated_at: <server timestamp> }
```

The document id is the **local** date (`datetime.now().astimezone()`), so the
day rolls over at the Pi's local midnight. Uses `firestore.Increment` with
`merge=True`, so ticks and concurrent writes accumulate instead of overwriting.

`history/<date>` — not `history/daily/<date>` — because Firestore document
paths must have an even number of segments, and `firestore.rules` exposes
exactly `/history/{day}`. The first observation after boot is a baseline and is
never written (otherwise the all-time `total_energy` would count as today's
usage); at startup that baseline is seeded from the existing `status/current`
document, so restarts don't skip or double-count energy. If `total_energy` drops
(firmware reset), the bridge logs `total_energy reset; rebaselining history` and
starts a new baseline without writing a negative delta.

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
