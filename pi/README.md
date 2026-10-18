# Pi bridge agent

A small Python service that bridges the OpenEVSE charger to Firebase: it polls
the charger's local HTTP API, mirrors status and config into Firestore
(`status/current`, `status/config`), derives daily energy history and completed
sessions, mirrors `schedule/current` into the charger's own scheduler, sends FCM
push notifications on charging/offline transitions, and applies pending
`commands/*` documents back to the charger. Runs under systemd with
`Restart=always`.
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
| `SCHEDULE_INTERVAL`             | `60`            | Seconds between schedule/plan polls and sync checks                                       |
| `COMMAND_INTERVAL`              | `5`             | Seconds between command polls                                                             |

## What the bridge writes

Each loop is failure-isolated: a charger or Firestore error is logged as one
timestamped line and the loop carries on at its next interval.

| Loop     | Firestore document | Content                                                                           |
| -------- | ------------------ | --------------------------------------------------------------------------------- |
| Status   | `status/current`   | Full `/status` snapshot, merged on every poll                                     |
| Status   | `history/<date>`   | `{kwh, updated_at}`, accumulated from `total_energy` deltas                       |
| Status   | `sessions/{id}`    | `{started_at, ended_at, wh, elapsed}` when a charging session ends                |
| Status   | `status/current`   | `schedule: {in_window, active_rule_id}` merged from the firmware's plan           |
| Config   | `status/config`    | Raw `/config` object plus `updated_at`, refreshed every `CONFIG_INTERVAL` seconds |
| Schedule | firmware           | `schedule/current` upserted into the charger's event scheduler (see below)        |
| Status   | `fcmTokens/{id}`   | Deleted when FCM reports the token unregistered/invalid                           |
| Commands | `commands/{id}`    | `status` set to `acked` or `failed` (plus `error` / `result` fields)              |

`status/config` is replaced wholesale (not merged), so removed charger settings
disappear from the document. The charger's config is logged only when it
changes to keep the journal quiet.

Two Tesla config fields report an absent value as `18446744073709551615`
(2^64 − 1), outside Firestore's signed 64-bit integer range; those values (and
non-finite floats) are coerced to float/`null` before the write, so a config
sync never fails on them. Everything else is stored exactly as the charger sent
it.

### Access allowlist (`pi/acl.py`)

`pi/acl.py` syncs `private/acl.txt` (one Google account email per line;
`#` comments and blanks ignored) into Firestore `users/{uid}` grant docs
`{allowed: true, email}` — the docs `firestore.rules` checks for access. Each
person must have signed in once first, because the uid comes from
`auth.get_user_by_email`.

```bash
python3 pi/acl.py            # grant every allowlisted email
python3 pi/acl.py --prune    # also delete grants whose email is no longer listed
```

One result line per email (`ok <email> -> <uid>` or
`failed <email>: must sign in once first (then rerun)`), then a
`N granted, M failed[, K pruned]` summary. It uses the same
`private/bridge.env` / service-account key as the bridge, prints
`private.example/README.md` guidance and exits non-zero when the key or
`acl.txt` is missing, and also exits non-zero when any listed email could not
be granted.

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

### Charging sessions

When the charger transitions out of `state: 3` (charging) with a positive
session energy, the bridge writes one document:

```
sessions/1792345678   { started_at, ended_at, wh, elapsed }
```

`wh` is the charger's `session_energy` (already Wh) and `elapsed` is seconds.
`ended_at` is the transition time; `started_at` is `ended_at - elapsed`, so it
comes from the charger's own session timer, never from when the bridge booted.
The document id is the Unix timestamp of `started_at` and the write is a `set()`
— deterministic, so a restart or a repeated end-tick can never create two
documents for the same session.

The last charging tick's `session_energy` / `elapsed` are used (some firmware
zeros them on the end tick), falling back to the transition tick's values if
they are positive. Failed polls (charger offline) are skipped, so they never
look like the end of a session. At startup `state`, `total_energy`,
`session_energy` and `elapsed` are seeded from `status/current`; if there is no
usable seed, the first successful poll only establishes state.

`status/current` also carries `elapsed`, per-sensor `temp1`–`temp3` in °C (or
`null` when the sensor is absent), `pilot` (amps), and the existing `temp_c`
mean.

### Push notifications (FCM)

The status loop sends one push per state transition, via the Admin SDK:

| Event                                                    | Body               |
| -------------------------------------------------------- | ------------------ |
| Charger enters `state: 3`                                | `Charging started` |
| Charger leaves `state: 3`                                | `Charging stopped` |
| Charger stops answering (first failed poll of an outage) | `Charger offline`  |

The title is always `ChelEVSE`. The transition is computed from the tracker's
pre-tick state, so each edge produces exactly one notification. The first tick
after a start with no seeded state only establishes state and never notifies; a
state seeded from `status/current` is a real baseline, so a change that happened
while the bridge was down notifies once. `charger offline` / `charger online`
are also journaled only on those edges.

Tokens are read from `fcmTokens/{id}`: the token is the document's `token` field
when it is a non-empty string, otherwise the document id itself. Every token is
sent independently inside its own try/except — one failing push never blocks
the others or the status writes. `UnregisteredError` / `InvalidArgumentError`
means the token is dead, so its document is deleted and the bridge logs
`pruned fcm token`; any other send error logs one line and leaves the token in
place for the next event. A failed token read or send is only ever a log line,
never a loop failure.

### Charge schedule sync

The app owns `schedule/current`:

```
schedule/current   { enabled: bool, rules: [{id, days: [0-6], start, end, amps}] }
```

`days` uses **0 = Monday … 6 = Sunday**. `start`/`end` are `HH:MM` (24-hour);
`end < start` means the window wraps past midnight. Every `SCHEDULE_INTERVAL`
seconds the bridge normalizes the doc and mirrors it into the charger's own
scheduler, so windows keep being enforced by the charger even while the Pi is
down.

- **Validation.** A rule is used only when it has a non-empty string `id`, a
  non-empty `days` list of integers 0–6, `start`/`end` matching
  `^([01]\d|2[0-3]):[0-5]\d$`, and a numeric `amps`. Malformed rules are logged
  and skipped; at most 20 rules are synced (2 firmware events each, within the
  firmware's 50-event limit).
- **Missing document never clears anything.** If `schedule/current` does not
  exist, the bridge logs once and leaves the charger's schedule untouched. Only
  an existing document with `enabled: false` (or no valid rules) clears it.
- **Event mapping.** Rules are sorted by `id`; rule index `i` becomes a window
  start event `2*i+1` (`state: "active"`, `time: start + ":00"`) and a window
  end event `2*i+2` (`state: "disabled"`, `time: end + ":00"`). Deterministic
  ids make the upsert idempotent and stable across polls. Our weekdays map to
  the firmware's lowercase full names (`0 → monday` … `6 → sunday`); for an
  overnight rule the end event's days shift +1 day (Sunday → Monday), so e.g.
  Sunday 22:00–06:00 ends Monday 06:00.
- **Sync.** The bridge keeps a sha256 of the normalized `{enabled, rules}` and
  only talks to the charger when it changes (or on the first tick). It then
  `GET /schedule`, `POST`s **one event per request** (the firmware's POST body
  buffer is 1 KB), and finally `DELETE`s every existing firmware event id not
  in the desired set — that is how removed rules and disabled schedules are
  cleared. Every request's HTTP status and body are logged, followed by
  `schedule synced: N events, removed M`. The digest is recorded only after
  every request succeeded, so a failure is retried on the next tick.
- **Window status.** Every tick (changed or not) reads `GET /schedule/plan` and
  merges exactly `schedule: {in_window, active_rule_id}` into `status/current`.
  `in_window` is true when the firmware's `current_event` is an `active` event
  **and** the next event (its end) is due within that event's `duration`.
  `active_rule_id` is the rule that owns the event id when in a window, else
  `null`. The extra delay check matters because the plan can briefly still
  describe an event whose start lies ahead of now (right after a sync, or the
  previous week's instance); it uses only firmware-computed values, so windows
  are still never evaluated locally — the firmware enforces them.
- **Amps are not pushed.** Firmware v5.1.5 has no per-event current: its
  schedule events are flat `{id, state, time, days}` and the event charges at
  the EVSE's configured limit. `amps` is validated and stored, but the bridge
  logs `schedule: firmware v5.1.5 has no per-event current; amps not applied`
  once per changed sync rather than pretending to apply it.

## Commands

The app writes pending documents to `commands/{id}`; the bridge polls them every
`COMMAND_INTERVAL` seconds, applies each one to the charger, then updates the
same document to `acked` or `failed`.

| `type`        | Charger request                                                          | Meaning                                                        |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `pause`       | `POST /override` `{"state":"disabled"}`                                  | Stop charging                                                  |
| `resume`      | `DELETE /override`                                                       | Clear the manual override; the firmware scheduler/auto resumes |
| `set_current` | `POST /override` `{"state":"active","charge_current":N,"max_current":N}` | Hold at `N` amps (clamped to 6–48)                             |
| `rapi`        | `POST /rapi` form body `rapi=<command>&json=1`                           | Advanced escape hatch for any RAPI command                     |

`rapi.command` must be a string starting with `$` and at most 32 characters;
anything else is marked `failed` with `error: "invalid rapi"` without contacting
the charger. On a 2xx reply the document becomes `acked` and gets
`result: <ret>` (the reply's `ret` field; the raw body if it is not JSON, `null`
if absent). Non-2xx replies and request errors are marked `failed` with a short
reason containing the HTTP status/body snippet or the exception class. Unknown
`type` values fail with `unsupported type`.

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
