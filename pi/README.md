# Pi bridge agent

A small Python service that bridges the OpenEVSE charger to Firebase: it polls
the charger's local HTTP API, mirrors status and config into Firestore
(`status/current`, `status/config`), derives daily energy history and completed
sessions, mirrors `schedule/current` into the charger's own scheduler, sends FCM
push notifications on charging/offline transitions, and applies pending
`commands/*` documents back to the charger, and restarts a charger that stops
answering (see [Watchdog](#watchdog-charger-health)). Runs under systemd with
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

**No composite Firestore index is required.** The pending-commands query filters
on `status == "pending"` only (a single-field automatic index) and sorts by
`created_at` in Python, so documents without a `created_at` field are still
seen and expired normally.

## Configuration

Environment variables, read from `private/bridge.env` (see
[../private.example/bridge.env.example](../private.example/bridge.env.example));
real environment variables take precedence.

| Variable                          | Default         | Meaning                                                                                   |
| --------------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `CHARGER_HOST`                    | `192.168.0.145` | Charger IP on the LAN                                                                     |
| `CHARGER_USER` / `CHARGER_PASS`   | unset           | HTTP Basic auth if set on the charger (blank username is valid)                           |
| `FIREBASE_SERVICE_ACCOUNT`        | —               | Path to the service-account key (**required**; relative paths resolve from the repo root) |
| `STATUS_INTERVAL`                 | `10`            | Seconds between charger status polls                                                      |
| `CONFIG_INTERVAL`                 | `60`            | Seconds between charger config polls                                                      |
| `SCHEDULE_INTERVAL`               | `60`            | Seconds between schedule/plan polls and sync checks                                       |
| `SCHEDULE_RECONCILE_INTERVAL`     | `300`           | Seconds between full `/schedule` reconciles even when the desired digest is unchanged     |
| `COMMAND_INTERVAL`                | `5`             | Seconds between command polls                                                             |
| `WATCHDOG_ENABLED`                | `true`          | Probe, restart and alert when `/status` keeps failing (see below)                         |
| `WATCHDOG_FAILURES`               | `3`             | Consecutive failed `/status` polls before the charger is treated as unhealthy             |
| `WATCHDOG_COOLDOWN_SEC`           | `600`           | Minimum seconds between restart attempts                                                  |
| `WATCHDOG_MAX_PER_HOUR`           | `3`             | Hard cap on restart attempts in a trailing hour                                           |
| `WATCHDOG_RESTART_WHILE_CHARGING` | `false`         | Allow a restart while the last known state is charging                                    |

Bad `WATCHDOG_*` values (a non-number, `WATCHDOG_FAILURES=0`, a cooldown below
zero, a cap below 1, a non-boolean flag) stop the bridge at startup with a
message naming the variable, like the interval settings.

### One charger HTTP session

All four loops share one `requests.Session` (`ChargerTransport` in
`bridge.py`), capped at two pooled sockets (`pool_connections=1`,
`pool_maxsize=2`). The ESP32 gateway is the constrained side of the link, so
the bridge holds at most two keep-alive connections instead of one per loop.
`requests.Session` is not documented as thread-safe, so every call is made
under a lock. The lock is not free: `HTTP_TIMEOUT` (5 s) is the connect/read
timeout passed to each request, and Requests applies it per socket operation
rather than as a deadline for the whole call. DNS resolution is not covered by
it, and a slow or trickling response can keep the call — and the lock — held
longer than that value, so there is no strict total-duration bound. Another
loop's charger call — including a command — waits for the lock rather than
failing; the command still applies when it lands, only its arrival is late.
Accepted because polls are low-rate. Firestore work and the notifier run
outside the lock. The config and schedule pollers start 3 s and 7 s late so
`/status`, `/config` and `/schedule/plan` do not hit the charger together.
Polling intervals, timeouts, auth, payloads and failure logging are unchanged.

### Watchdog (charger health)

The status loop counts consecutive `/status` failures. After `WATCHDOG_FAILURES`
(default 3, ≈ 30 s at the 10 s poll) the charger is **unhealthy** and the bridge
tries a bounded recovery instead of only logging `charger offline`:

1. **Probe.** One extra `GET /status`. Only a usable reply means the gateway can
   be reached. A timeout, connection error, auth failure or non-2xx reply means
   it cannot (mains off, Wi-Fi dropped, wrong credentials), so **no restart is
   attempted**: the watchdog alerts only, with
   `Recovery failed — power cycle may be required`. `POST /restart` uses the same
   HTTP endpoint, so a gateway that answers nothing cannot be restarted remotely.
2. **Classify.** The last two successful `/status` samples decide the domain:
   `rapi_connected`/`evse_connected` false, or `comm_success` frozen while
   `comm_sent` rises, is controller-side (firmware v5.1.5 counters); otherwise
   it is gateway-side (a healthy controller behind a failing HTTP server).
   Missing fields are treated as healthy — the watchdog never invents a
   controller fault it cannot see.
3. **Restart.** `POST /restart` with `{"device": "gateway"}` or
   `{"device": "evse"}` through the shared session. Each attempt logs its inputs
   (`failures`, `http_ok`, `controller_ok`, `charging`) and its outcome.
4. **Guards.** At most `WATCHDOG_MAX_PER_HOUR` (3) attempts in a trailing hour,
   at least `WATCHDOG_COOLDOWN_SEC` (600 s) between attempts, and no restart
   while the last known state is charging unless
   `WATCHDOG_RESTART_WHILE_CHARGING=true`. A stale "charging" state keeps
   blocking, because with no successful poll there is no fresher one.
5. **Recover.** A successful `/status` poll clears the streak and pushes
   `Charger recovered`.

While unhealthy the bridge makes one probe per tick in addition to the failed
poll; a restart attempt is recorded only when the probe (and the guards) allow
one. Pushes are edge-only: one per unhealthy episode — the restart body, the
alert-only `Recovery failed — power cycle may be required` when HTTP is dead, or
`Charger unresponsive — restart blocked (…)` when a guard stopped the attempt
(charging guard, cooldown, hourly cap; the charging body names
`WATCHDOG_RESTART_WHILE_CHARGING`) — then one when the episode still has not
recovered after an attempt (`Recovery failed — power cycle may be required`,
also raised when the hour's allowance is spent), and one on recovery. A blocked
entry never claims a failure, because nothing was attempted. The existing
`Charger offline` push still fires on the first failed poll of an outage, so one
outage can produce two pushes.

`status/health` is written on every transition and every attempt — not on every
tick, so a healthy bridge writes it once:

```text
status/health  { state, reason, http_ok, controller_ok, last_attempt_at,
                 attempts_last_hour, last_action, last_result, updated_at }
```

`state` is `healthy` or `unhealthy`; `reason` is the decision's explanation
(e.g. `cooldown after the last attempt (600s)`); `last_action` is
`restart_gateway`, `restart_evse`, `alert` (unreachable, never attempted) or
`none` (a guard blocked the attempt); `last_result` is the outcome of the last
attempt (`HTTP 200` / `failed (…)`), or the explanation when no attempt has been
made. Once an attempt exists, the attempt's fields stay on record for the rest of
the process — later probe results are carried by `http_ok` and `reason`.

**When a physical power cycle is still required.** A gateway that is not
answering HTTP at all cannot be restarted from the Pi, and a controller that does
not come back after `{"device": "evse"}` needs hands-on attention. If
`status/health.http_ok` stays `false`, check the charger's power and its LAN
association before assuming a firmware problem; the hourly cap is what stops the
bridge from looping on a device that is simply switched off.

**Disabling.** `WATCHDOG_ENABLED=false` stops all probes, restarts, health writes
and watchdog pushes, and the failure counter is not kept; `status/health` is then
left exactly as it was (possibly stale). Charging/offline notifications are
unaffected.

## What the bridge writes

Each loop is failure-isolated: a charger or Firestore error is logged as one
timestamped line and the loop carries on at its next interval.

| Loop     | Firestore document | Content                                                                     |
| -------- | ------------------ | --------------------------------------------------------------------------- |
| Status   | `status/current`   | Curated `/status` fields, merged on every poll                              |
| Status   | `history/<date>`   | `{kwh, updated_at}`, accumulated from `total_energy` deltas                 |
| Status   | `sessions/{id}`    | `{started_at, ended_at, wh, elapsed}` per completed plug-in session         |
| Status   | `status/current`   | `schedule: {in_window, active_rule_id}` merged from the firmware's plan     |
| Status   | `status/health`    | Watchdog state, decision reason, probe results and the last restart attempt |
| Config   | `status/config`    | `/config` object with credential fields redacted, plus `updated_at`         |
| Schedule | firmware           | `schedule/current` mirrored into the charger's event scheduler (see below)  |
| Status   | `fcmTokens/{id}`   | Deleted when FCM reports the token unregistered/invalid                     |
| Commands | `commands/{id}`    | `status` set to `acked` or `failed` (plus `error` / `result` fields)        |

`status/current` carries the curated set (`state`, `state_label`, `amp`,
`voltage`, `power`, `session_energy`, `total_energy`, `elapsed`, `vehicle`,
`temp1`–`temp3`, `temp_c`, `pilot`, `charger_online`, `updated_at`), not the
whole raw `/status` object.

`status/config` is replaced wholesale (not merged), so removed charger settings
disappear from the document. Credential fields are **redacted before the
write**: `pass`, `ap_pass`, `www_password`, `mqtt_pass`, `emoncms_apikey`,
`ocpp_authkey`, `tesla_access_token` and `tesla_refresh_token` are replaced with
`"***"` (never logged and never stored), because every allowlisted account can
read `status/config`. All other fields are stored as the charger sent them. The
charger's config is logged only when it changes to keep the journal quiet.

Two Tesla config fields report an absent value as `18446744073709551615`
(2^64 − 1), outside Firestore's signed 64-bit integer range; those values (and
non-finite floats) are coerced to float/`null` before the write, so a config
sync never fails on them.

### Access allowlist (`pi/acl.py`)

`pi/acl.py` syncs `private/acl.txt` (one Google account email per line;
`#` comments and blanks ignored) into Firestore `users/{uid}` grant docs
`{allowed: true, email}` — the docs `firestore.rules` checks for access. Each
person must have signed in once first, because the uid comes from
`auth.get_user_by_email`.

```bash
# Run with the venv that has firebase-admin installed. On the Pi that is the
# installer's venv; the repo-local pi/.venv works too.
/opt/chelevse/pi/.venv/bin/python /opt/chelevse/pi/acl.py
/opt/chelevse/pi/.venv/bin/python /opt/chelevse/pi/acl.py --prune
```

One result line per email (`ok <email> -> <uid>` or
`failed <email>: must sign in once first (then rerun)`), then a
`N granted, M failed[, K pruned, U unmanaged grants kept, T tokens removed]`
summary. It uses the same `private/bridge.env` / service-account key as the
bridge, prints `private.example/README.md` guidance and exits non-zero when the
key or `acl.txt` is missing, and also exits non-zero when any listed email could
not be granted.

`--prune` only deletes grants that have a string `email` and are no longer
listed. A grant with no `email` (for example one created by hand in the Firebase
console) is reported as `kept unmanaged grant <uid>` and left in place. When any
allowlisted email failed to grant, prune is skipped entirely — a typo in
`acl.txt` must not revoke the real user's access — unless `--force-prune` is
passed. For every pruned uid, that user's `fcmTokens` documents are deleted too,
so revocation also stops push notifications, and the summary reports the count.

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
document. If the seed read fails (e.g. the Pi booted before the network), the
bridge retries it on later status ticks (at most every 30 s) and pauses history
until it succeeds, so the eventual first delta still starts at the last stored
reading instead of dropping the downtime energy. If `total_energy` drops
(firmware reset), the bridge logs `total_energy reset; rebaselining history` and
starts a new baseline without writing a negative delta. A failed history write
does not advance the in-memory baseline: the same delta is retried on the next
tick.

### Charging sessions

The charger keeps `session_energy` (Wh) and `elapsed` cumulative for the whole
plug-in event and clears them only when the vehicle disconnects. A pause, a
scheduled-window end, or a manual stop ends the charging _state_ but not the
session. The bridge therefore treats a session as one plug-in event and writes
one document:

```
sessions/1792345678   { started_at, ended_at, wh, elapsed }
```

`wh` is the charger's `session_energy` and `elapsed` is seconds. `ended_at` is
the stop time and `started_at` comes from the charger's own timer
(`ended_at - elapsed`), never from when the bridge booted.

On every `state 3 → non-3` edge the bridge looks up the most recent session. It
**merges** the new record into it (keeping the earlier `started_at`, the later
`ended_at`, and `max(wh)` / `max(elapsed)`) when the previous interval still
touches the new one, the start is within 120 s, or the vehicle is still plugged
in and both cumulative counters kept growing (with the previous record less
than 48 hours old). This is what makes pause/resume and
back-to-back scheduled windows one record instead of two documents that
double-count the same cumulative energy. The merged write keeps the previous
document id; a brand-new session uses the Unix timestamp of `started_at`.
`wh` is never negative and never lowered by a merge.

The last charging tick's `session_energy` / `elapsed` are used (some firmware
zeros them on the end tick), falling back to the transition tick's values if
they are positive. A failed session write is kept in memory and retried at the
start of the next status tick. Failed polls (charger offline) are skipped, so
they never look like the end of a session. At startup `state`, `total_energy`,
`session_energy` and `elapsed` are seeded from `status/current`; if there is no
usable seed, the first successful poll only establishes state.

`status/current` also carries `elapsed`, per-sensor `temp1`–`temp3` in °C (or
`null` when the sensor is absent), `pilot` (amps), and the existing `temp_c`
mean.

### Push notifications (FCM)

The status loop queues one push per state transition, and a single background
daemon worker performs the sends via the Admin SDK:

| Event                                                                | Body                                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Charger enters `state: 3`                                            | `Charging started`                                                                                               |
| Charger leaves `state: 3`                                            | `Charging stopped`                                                                                               |
| Charger stops answering (first failed poll of an outage)             | `Charger offline`                                                                                                |
| Watchdog restarts a gateway / controller                             | `Charger gateway unresponsive — restart attempted` / `Charger controller unresponsive — restart attempted`       |
| Restart attempted and the charger is still down (or allowance spent) | `Recovery failed — power cycle may be required`                                                                  |
| Unhealthy but a guard blocked the restart                            | `Charger unresponsive — restart blocked (…)` (names the guard; charging names `WATCHDOG_RESTART_WHILE_CHARGING`) |
| Charger answers again after an unhealthy episode                     | `Charger recovered`                                                                                              |

The title is always `ChelEVSE`. The transition is computed from the tracker's
pre-tick state, so each edge produces exactly one notification. The first tick
after a start with no seeded state only establishes state and never notifies; a
state seeded from `status/current` is a real baseline, so a change that happened
while the bridge was down notifies once. `charger offline` / `charger online`
are also journaled only on those edges, and the offline reason includes the HTTP
status (401/403/5xx) or transport exception so auth failures are distinguishable
from an unreachable charger. Watchdog pushes follow the same edge-only rule — see
[Watchdog](#watchdog-charger-health).

On the offline edge the bridge writes `charger_online: false` **before**
queueing `Charger offline`, so the app sees the outage even if FCM is slow.
Sends never run on the status thread: a stalled FCM/network call cannot delay
status, history, or session writes. The queue is bounded (64 events); if it is
ever full the newest push is dropped with a log line rather than blocking the
loop.

Tokens are read from `fcmTokens/{id}`: the token is the document's `token` field
when it is a non-empty string, otherwise the document id itself. Every token is
sent independently inside its own try/except — one failing push never blocks the
others, and a slow push only delays later pushes, never the status loop.
`UnregisteredError` / `InvalidArgumentError` means the token is dead, so its
document is deleted and the bridge logs `pruned fcm token`; any other send error
logs one line and leaves the token in place for the next event. A failed token
read or send is only ever a log line, never a loop failure.

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
  non-empty `days` list of integers 0–6, `start`/`end` that are exactly `HH:MM`
  as 24-hour ASCII digits matched against the whole string (no trailing
  newline, no non-ASCII digits), `start != end`, and a numeric `amps`. Malformed
  rules are logged and skipped; at most 20 rules are synced (2 firmware events
  each, within the firmware's 50-event limit).
- **No overlapping windows.** Per weekday (including an overnight rule's spill
  into the next day), windows must not overlap or even touch: the firmware
  resolves equal-time events by list order, so touching windows make the
  effective on/off minute ambiguous. The later rule (by `id`) in any clash is
  logged and skipped; a zero-length rule (`start == end`) is rejected.
- **Missing document never clears anything, and neither does a malformed one.**
  If `schedule/current` does not exist, the bridge logs once and leaves the
  charger's schedule untouched. If it exists but `enabled` is not a boolean,
  `rules` is not a list, or `enabled: true` has rules but none are usable, the
  bridge logs once and skips the sync — a malformed document is not an
  intentional clear. Only an explicit `enabled: false` (or `enabled: true` with
  an empty `rules` list) clears the firmware schedule.
- **Event mapping.** Rules are sorted by `id`; rule index `i` becomes a window
  start event `2*i+1` (`state: "active"`, `time: start + ":00"`) and a window
  end event `2*i+2` (`state: "disabled"`, `time: end + ":00"`). Deterministic
  ids make the upsert idempotent and stable across polls. Our weekdays map to
  the firmware's lowercase full names (`0 → monday` … `6 → sunday`); for an
  overnight rule the end event's days shift +1 day (Sunday → Monday), so e.g.
  Sunday 22:00–06:00 ends Monday 06:00.
- **Sync.** The bridge keeps a sha256 of the normalized `{enabled, rules}` and
  only talks to the charger when it changes, on the first tick, or when the
  periodic reconcile is due (`SCHEDULE_RECONCILE_INTERVAL`, default 300 s). The
  reconcile makes a firmware reset or an edit from the charger's own UI
  self-heal even though the Firestore digest is unchanged. Each sync
  `GET`s `/schedule`, `POST`s only events whose state/time/days differ (one
  event per request — the firmware's POST body buffer is 1 KB), and finally
  `DELETE`s every existing firmware event id not in the desired set — that is
  how removed rules and disabled schedules are cleared. Every request's HTTP
  status and body are logged, followed by
  `schedule synced: N events (P posted), removed M`. The digest, the
  event-id→rule-id mapping, and the reconcile clock are recorded only after
  every request succeeded, so a failure is retried on the next tick and the
  published `active_rule_id` always uses the mapping that is actually live.
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
same document to `acked` or `failed`. The query filters on `status == "pending"`
only (no composite index); the bridge sorts the results by `created_at` in
Python, oldest first, and tolerates documents without a timestamp. A pending
command older than **10 minutes** is not applied: it is marked `failed` with
`error: "stale command (older than 600s)"` without contacting the charger, so a
command queued while the Pi was offline cannot start or stop a charge hours
later.

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

Applying a command and writing its `acked` status are separate steps. If the
ack write fails, the bridge remembers that command id in memory and retries the
write on later polls without calling the charger again. That memory is
process-local, so if the bridge restarts between the two steps the command is
re-applied: delivery is **at-least-once across restarts**. `pause`, `resume` and
`set_current` are idempotent; non-idempotent `rapi` commands remain gated
client-side.

## Tests

The bridge and ACL helper have stdlib `unittest` coverage under `pi/tests/`
with in-memory Firestore/HTTP fakes; no charger, Firestore, or FCM access is
needed. Run it with the same venv as the service:

```bash
pi/.venv/bin/python -m unittest discover -s pi/tests -v
```

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
