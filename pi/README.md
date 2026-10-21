# Pi bridge agent

A small Python service that bridges the OpenEVSE charger to Firebase: it polls
the charger's local HTTP API, mirrors status and config into Firestore
(`status/current`, `status/config`), derives daily energy history and completed
sessions, mirrors `schedule/current` into the charger's own scheduler, sends FCM
push notifications on charging/offline transitions, and applies pending
`commands/*` documents back to the charger, and restarts a charger that stops
answering (see [Watchdog](#watchdog-charger-health)). Status can also arrive
over MQTT from a broker on the LAN (see [MQTT status
source](#mqtt-status-source-issue-44)), behind a feature flag. Runs under
systemd with `Restart=always`.
See [../ARCHITECTURE.md](../ARCHITECTURE.md) for the big picture.

## Prerequisites

- Raspberry Pi OS (Bookworm) on the same LAN as the charger
- `git` and `python3-venv`: `sudo apt install git python3-venv`
- Optional, for MQTT status: `mosquitto` (broker) and `mosquitto-clients` on the
  Pi — see [MQTT status source](#mqtt-status-source-issue-44) and
  [../docs/DEPLOY.md](../docs/DEPLOY.md)

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

| Variable                          | Default               | Meaning                                                                                   |
| --------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `CHARGER_HOST`                    | `192.168.0.145`       | Charger IP on the LAN                                                                     |
| `CHARGER_USER` / `CHARGER_PASS`   | unset                 | HTTP Basic auth if set on the charger (blank username is valid)                           |
| `FIREBASE_SERVICE_ACCOUNT`        | —                     | Path to the service-account key (**required**; relative paths resolve from the repo root) |
| `STATUS_INTERVAL`                 | `10`                  | Seconds between charger status polls                                                      |
| `CONFIG_INTERVAL`                 | `60`                  | Seconds between charger config polls                                                      |
| `SCHEDULE_INTERVAL`               | `60`                  | Seconds between schedule/plan polls and sync checks                                       |
| `SCHEDULE_RECONCILE_INTERVAL`     | `300`                 | Seconds between full `/schedule` reconciles even when the desired digest is unchanged     |
| `COMMAND_INTERVAL`                | `5`                   | Seconds between command polls                                                             |
| `WATCHDOG_ENABLED`                | `true`                | Probe, restart and alert when `/status` keeps failing (see below)                         |
| `WATCHDOG_FAILURES`               | `3`                   | Consecutive failed `/status` polls before the charger is treated as unhealthy             |
| `WATCHDOG_COOLDOWN_SEC`           | `600`                 | Minimum seconds between restart attempts                                                  |
| `WATCHDOG_MAX_PER_HOUR`           | `3`                   | Hard cap on restart attempts in a trailing hour                                           |
| `WATCHDOG_RESTART_WHILE_CHARGING` | `false`               | Allow a restart while the last known state is charging                                    |
| `MQTT_ENABLED`                    | `false`               | Ingest status from the charger's MQTT topics (see below); HTTP stays the fallback         |
| `MQTT_HOST`                       | —                     | Broker host (required when `MQTT_ENABLED=true`)                                           |
| `MQTT_PORT`                       | `1883`                | Broker port                                                                               |
| `MQTT_USER` / `MQTT_PASS`         | unset                 | Broker credentials; keep the password in `private/bridge.env` only                        |
| `MQTT_TOPIC`                      | `chelevse`            | Base topic the charger publishes to (`mqtt_topic` in the charger config)                  |
| `MQTT_RECONCILE_SEC`              | `60`                  | Seconds between HTTP `/status` reconciles while MQTT is connected                         |
| `MQTT_CLIENT_ID`                  | `chelevse-bridge`     | MQTT client id                                                                            |
| `MQTT_ANNOUNCE_TOPIC`             | `openevse/announce/#` | Broker filter carrying the gateway's announce/Last Will (see the watchdog)                |

Bad `WATCHDOG_*` values (a non-number, `WATCHDOG_FAILURES=0`, a cooldown below
zero, a cap below 1, a non-boolean flag) stop the bridge at startup with a
message naming the variable, like the interval settings. The same applies to bad
`MQTT_*` values — a non-boolean flag, a port outside 1–65535, a
`MQTT_RECONCILE_SEC` of zero or `nan`, a blank topic, or `MQTT_ENABLED=true`
without `MQTT_HOST`.

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

### MQTT status source (issue #44)

With `MQTT_ENABLED=true` the bridge subscribes to `<MQTT_TOPIC>/#` and writes
status as the charger publishes it, instead of inferring freshness from a 10 s
poll. The flag is **off by default**; with it off nothing below changes.

The firmware publishes one topic per value (`<base>/amp`, `<base>/state`, …)
when its EVSE poll reports a change. Topic values are handed over in their raw
units and every snapshot runs through the same `parse_status` / `apply_status`
path as an HTTP poll, so the document shape, unit conversions, history,
sessions and notifications are shared — a second source describing the same
state cannot fire a second transition, ring up history twice, or write a
second session. `status/current` therefore carries only the curated fields
listed under [What the bridge writes](#what-the-bridge-writes); the raw
`/status` keys (`comm_*`, `ipaddress`, `macaddress`, `mqtt_connected`, …) never
reach it.

| Topic                     | `status/current` field | Notes                                               |
| ------------------------- | ---------------------- | --------------------------------------------------- |
| `<base>/amp`              | `amp`                  | milliamps → amps in `parse_status`                  |
| `<base>/voltage`, `power` | `voltage`, `power`     | volts; watts (the app shows kW)                     |
| `<base>/pilot`            | `pilot`                | amps                                                |
| `<base>/state`            | `state`, `state_label` | numeric EVSE state                                  |
| `<base>/vehicle`          | `vehicle`              | 1 = plugged in                                      |
| `<base>/session_energy`   | `session_energy`       | Wh                                                  |
| `<base>/session_elapsed`  | `elapsed`              | seconds (the deprecated `elapsed` topic is ignored) |
| `<base>/total_energy`     | `total_energy`         | kWh                                                 |
| `<base>/temp1`–`temp3`    | `temp1`–`temp3`        | 10ths of °C; `false` when absent                    |
| `<base>/config_version`   | —                      | triggers one `/config` sync                         |

Everything else on the base topic (retained `config`/`claim`/`schedule`/
`limit`/`boost`, availability counters) is ignored by the status path. The
retained `override` document and `rapi/out` feed the command acknowledgements
([Commands over MQTT](#commands-over-mqtt-issue-46)); `override/set` and
`rapi/in` are our own publishes; LWT handling is #45.

**Cadence.** While the broker is connected **and the subscription is granted**,
`/status` is fetched once every `MQTT_RECONCILE_SEC` (60 s) and merged into the
snapshot — reconciliation only. A broker that accepts the connection and then
denies `<MQTT_TOPIC>/#` delivers nothing, which looks exactly like an idle
charger: the bridge keeps HTTP as the status source at its usual 10 s cadence,
logs the degraded source once (`status source: http (mqtt connected,
<topic>/# not subscribed)`) and writes `source: "http"` with
`mqtt_connected: true` to `status/health`. `/config` follows the same
subscription gate: while the subscription is granted it is fetched when
`config_version` changes (the retained value on connect counts as the first
change), **not** every 60 s; while the subscription is denied or the broker is
disconnected it is polled every 60 s instead, with the degraded edge logged once
(`config source: http (mqtt connected, <topic>/# not subscribed)`). A denied
subscribing broker therefore cannot freeze `status/config`. A _granted_ but
silent subscription can — a topic mismatch, charger-side MQTT off, or no
retained version delivers no event at all — so until a `config_version` is
observed the loop bootstraps with one HTTP `/config` straight away, resyncs
every `CONFIG_SAFETY_RESYNC_SEC` (10 min) instead of waiting on the event, and
logs `config: mqtt subscribed but no config_version observed; …` once. A failed
`/config` fetch **or write** is not lost either: the trigger is consumed and the
retry is owed with a bounded backoff (5 s, doubling to 60 s); only a _new_
`config_version` — including the retained value republished on a reconnect —
re-arms the event and retries immediately. The schedule loop is unchanged. While
the broker is disconnected — or the flag is off — the bridge polls exactly as
before: 10 s status, 60 s config, 60 s schedule.

**Merged snapshots.** A burst carries only the fields that changed, so a burst is
buffered for ~500 ms and merged into a snapshot seeded from the last `/status`
reply. The seed stays raw (the same units a `/status` reply uses), so the
parser sees the fields MQTT never publishes (`comm_sent`, `comm_success`,
`rapi_connected`) alongside the burst. A burst that only carries `amp` cannot
null `voltage`, and before the first successful `/status` seed a snapshot is a
**field update, not an observation**: its fields are merged into
`status/current` (and `total_energy` still feeds history), but the charging
state machine, sessions and transition pushes only run once a snapshot is
complete — it was flushed from a seeded source and carries a numeric `state`.
Completeness is a **flush-time** fact carried with the snapshot, so a seed that
lands while it waits in the queue does not promote it. Without that gate a
bridge that restarted while the charger's HTTP was wedged would read the first
`amp` update as "charging stopped". The 60 s reconcile refreshes both the seed
and the authoritative document.

**Apply queue.** Flushes are handed to the apply worker through a bounded queue
(`MQTT_PENDING_SNAPSHOTS` telemetry slots plus `MQTT_PENDING_EDGES` reserved
edge records, 36). Each entry carries its raw fields, its arrival number and its
seeded-at-flush flag, so the worker never re-reads state that has moved on.
Telemetry that repeats the queued `state` coalesces to the newest field set, so a
slow Firestore write never builds a backlog of stale snapshots; a snapshot that
_changes_ `state` is an edge, though — the start or stop of a charging session
and its notification — so it is kept in order behind the queued ones rather than
discarded, in the reserved edge capacity. Only a hostile burst of more than 32
queued transitions drops the oldest, and that loss is logged
(`mqtt snapshot backlog over capacity …`), never silent.

**Reconcile ordering.** A `/status` reply can be older than MQTT data that
arrived while the request was in flight (a stop arrives during the reconcile's
round trip). The status loop reads two counters before its GET: each MQTT apply,
and each delivered snapshot (a flush advances it before the worker applies it,
so a snapshot still queued counts too). It seeds the snapshot through the source's
compare-and-seed (`seed_if_current`), which compares that arrival counter and
merges in one critical section: a flush that lands between the check and the
merge cannot be overwritten by the older reply. A reply older than either
counter is logged as `status reconcile discarded (mqtt advanced during the poll)`
and dropped (including its seed) instead of rewinding the tracker or re-firing an
edge; it still counts as a successful poll for the watchdog. An applied reply also
records its arrival as a watermark, so a snapshot that was queued before it —
`mqtt snapshot dropped (a reconcile applied a newer view)` — is dropped when the
worker reaches it rather than replaying an older observation over a newer one.

**Liveness, fallback and outages.** Liveness is the client's connection state
_and_ a granted subscription, not message recency: an idle charger publishes
nothing for minutes and must not look dead, and a denied `<topic>/#` SUBACK is
caught by the source-selection check above rather than by silence. On top of
that, the charger's own presence comes from the broker's announce topic
(`MQTT_ANNOUNCE_TOPIC`, default `openevse/announce/#`): the firmware publishes a
retained `{"state": "connected"}` on connect and the broker publishes
`{"state": "disconnected"}` as its Last Will when the gateway drops. That is
availability evidence independent of the HTTP server, so a Last Will counts as
the gateway being unavailable even while the Pi's link to the broker stays up
(status falls back to HTTP, health says so). Each source change is logged once (`status source: mqtt (mqtt connected)` /
`status source: http (mqtt disconnected after N messages)`, `(mqtt not
connected)` when the broker was never reached, or `(mqtt connected, <topic>/#
not subscribed)` when the topics are denied, or `(mqtt connected, gateway announced
disconnected)` when only the charger is gone), written to
`status/health.source` together with the transport fields (a link that drops
while the source stays `http` is rewritten too, as is the first announcement), and a drop resumes the 10 s poll immediately. The broker
link's own failures are logged too — `mqtt connect refused (…)`, `mqtt connect
failed (…)`, `mqtt subscription denied (…)`, `mqtt announce subscription denied
(…)`, `mqtt disconnected (…)` — so a wrong `MQTT_PASS` or an ACL-denied
subscription is not silent. A failed HTTP
reconcile while MQTT carries status is logged as `status reconcile failed (…)`
and still counts towards the watchdog's failure streak (only a successful HTTP
poll clears it). An idle charger is silent by design, so silence plus **one**
failed poll proves nothing: that case is logged as `status reconcile failed (…);
no mqtt snapshot, outage unconfirmed` and the charger stays online.
`MQTT_OUTAGE_FAILURES` (2) consecutive failed reconciles with no MQTT snapshot in
between write `charger_online: false` and push once, and any snapshot resets the
count. That second decision is revalidated under the sink lock: the source's
arrival sequence is re-read in the same critical section as the tracker and
document writes, so a flush that lands between the "no snapshot" check and the
offline write refuses the outage — logged as
`status reconcile failed (…); mqtt snapshot arrived, outage refused` — instead of
flagging a publishing charger offline.

**Health.** `status/health` gains transport fields, written with merge semantics
so neither the watchdog's writes nor these can clobber the other:

```text
status/health  { …, source: "mqtt"|"http", mqtt_connected: bool,
                 mqtt_announced: bool|null, mqtt_last_lwt_at: timestamp|null }
```

`mqtt_connected` means the MQTT path to the charger is usable: the broker link
is up **and** the gateway has not announced `disconnected`. `mqtt_announced` is
the raw announce view (`null` until the first announcement) and
`mqtt_last_lwt_at` is when the Last Will last fired. `source` is where status
data actually comes from. A connected broker with a denied subscription (or a
silent one) therefore reads `source: "http"` with `mqtt_connected: true` — the
degraded case that is easy to miss — while a gateway that announced
`disconnected` reads `source: "http"`, `mqtt_connected: false` and
`mqtt_announced: false`. All of them are rewritten on any change, including a
link drop that leaves `source` at `http`.

**Rollback.** Set `MQTT_ENABLED=false` in the file the service actually reads —
`/opt/chelevse/private/bridge.env` (`EnvironmentFile` in the unit, plus
`bridge.py`'s env file) — and restart. Editing this checkout's
`private/bridge.env` alone does nothing to the running service: either edit the
deployed file or `sudo bash pi/install.sh` and restart. No redeploy of code is
needed, and the startup line reads `mqtt: disabled (HTTP status polling)`.
The charger's own MQTT settings are independent: `POST /config
{"mqtt_enabled":false}` plus a gateway restart stops its publishing without
touching the bridge. The charger stores `mqtt_pass` in plain text like its other
credentials (it is redacted from `status/config`).

### Watchdog (charger health)

The status loop counts consecutive `/status` failures. After `WATCHDOG_FAILURES`
(default 3, ≈ 30 s at the 10 s poll — under MQTT the reconcile is the only
`/status` poll, so the same three failures take ≈ 3 min) the charger is
**unhealthy** and the bridge tries a bounded recovery instead of only logging
`charger offline`:

1. **Probe.** One extra `GET /status`. Only a usable reply means the gateway can
   be reached over HTTP. A timeout, connection error, auth failure or non-2xx
   reply means it cannot (mains off, Wi-Fi dropped, wrong credentials) — but
   that alone no longer ends the attempt: with `MQTT_ENABLED=true` and a ready
   MQTT link the restart goes out over MQTT instead. When **neither** transport
   can carry one, **no restart is attempted**: the watchdog alerts only, with
   `Recovery failed — power cycle may be required`.
2. **Classify.** The last two successful `/status` samples decide the domain:
   `rapi_connected`/`evse_connected` false, or `comm_success` frozen while
   `comm_sent` rises, is controller-side (firmware v5.1.5 counters); otherwise
   it is gateway-side (a healthy controller behind a failing HTTP server).
   Missing fields are treated as healthy — the watchdog never invents a
   controller fault it cannot see. This stays on the HTTP replies: MQTT
   publishes no `comm_*` or `rapi_connected`, so the Last Will supplements the
   classification, never replaces it.
3. **Restart.** `POST /restart` with `{"device": "gateway"}` or
   `{"device": "evse"}` through the shared session, or — only when the probe
   could not reach HTTP and MQTT is ready — a QoS 0 publish of the same JSON
   document on `<MQTT_TOPIC>/restart` through the MQTT source. Exactly one
   transport is used per attempt (a published MQTT restart is never also posted
   over HTTP). Each attempt logs its inputs (`failures`, `http_ok`,
   `controller_ok`, `charging`, `mqtt_ready`) and its outcome; `status/health`
   records `last_transport` (`"http"`/`"mqtt"`) beside `last_action`. A publish
   the client rejects is recorded as `failed (…)` and still spends the attempt
   and its cooldown; a publish it accepts is fire-and-forget (QoS 0).
4. **Guards.** At most `WATCHDOG_MAX_PER_HOUR` (3) attempts in a trailing hour,
   at least `WATCHDOG_COOLDOWN_SEC` (600 s) between attempts, and no restart
   while the last known state is charging unless
   `WATCHDOG_RESTART_WHILE_CHARGING=true`. A stale "charging" state keeps
   blocking, because with no successful poll there is no fresher one. The
   guards are transport-independent: a blocked restart publishes nothing.
5. **Recover.** A successful `/status` poll clears the streak and pushes
   `Charger recovered`. A published restart is fire-and-forget, so that next
   successful probe (the 60 s reconcile while MQTT carries status) is what
   proves recovery and clears the health state.

**The Last Will as an availability input (issue #45).** The source subscribes to
`MQTT_ANNOUNCE_TOPIC` (`openevse/announce/#`, or any filter ending in `/#` — a
filter without that suffix is matched exactly), whose retained payload flips to
`{"state": "disconnected"}` when the broker's keepalive expires. A gateway that
announced `disconnected` is treated as unavailable even though our broker link
is intact: `status/health.mqtt_connected` becomes `false` (with
`mqtt_announced: false` and `mqtt_last_lwt_at`), status falls back to the 10 s
HTTP poll, and an HTTP outage in that state is **alert-only** — publishing a
restart to a gateway that is not on the broker would not reach it. The first
`{"state": "connected"}` after a reconnect clears the flag and MQTT becomes a
restart transport again. Unknown is not disconnected: until an announcement
arrives the watchdog infers no outage, and a ready MQTT link (connected, status
subscription granted) remains a restart transport — only `mqtt_announced: false`
withdraws it. A denied or mis-set announce filter therefore still allows MQTT
restarts; it is the outage inference that stays on HTTP.

While unhealthy the bridge makes one probe per tick in addition to the failed
poll; a restart attempt is recorded only when the probe (and the guards) allow
one. Pushes are edge-only: one per unhealthy episode — the restart body, the
alert-only `Recovery failed — power cycle may be required` when neither HTTP nor
MQTT can carry a restart, or `Charger unresponsive — restart blocked (…)` when a
guard stopped the attempt (charging guard, cooldown, hourly cap; the charging
body names `WATCHDOG_RESTART_WHILE_CHARGING`) — then one when the episode still
has not recovered after an attempt (`Recovery failed — power cycle may be
required`, also raised when the hour's allowance is spent), and one on recovery.
A blocked entry never claims a failure, because nothing was attempted. The
existing `Charger offline` push still fires on the first failed poll of an
outage, so one outage can produce two pushes.

`status/health` is written on every transition and every attempt — not on every
tick, so a healthy bridge writes it once:

```text
status/health  { state, reason, http_ok, controller_ok, last_attempt_at,
                 attempts_last_hour, last_action, last_transport, last_result,
                 updated_at, source, mqtt_connected, mqtt_announced,
                 mqtt_last_lwt_at }
```

`state` is `healthy` or `unhealthy`; `source`/`mqtt_connected`/
`mqtt_announced`/`mqtt_last_lwt_at` are the transport fields from the MQTT
section above (present only when MQTT is configured, and merged so they survive
watchdog writes — the watchdog refreshes them on each of its own writes);
`reason` is the decision's explanation (e.g. `cooldown after the last attempt
(600s)`, or `HTTP unreachable; restarting the gateway over MQTT`); `last_action`
is `restart_gateway`, `restart_evse`, `alert` (no transport could carry a
restart, never attempted) or `none` (a guard blocked the attempt);
`last_transport` is the path the last attempt used (`"http"`/`"mqtt"`, `null`
until one exists); `last_result` is the outcome of the last attempt (`HTTP 200`
/ `MQTT published` / `failed (…)`), or the explanation when no attempt has been
made. Once an attempt exists, the attempt's fields stay on record for the rest of
the process — later probe results are carried by `http_ok` and `reason`.

**When a physical power cycle is still required.** A gateway that answers
nothing over HTTP **and** is gone from the broker (its Last Will fired, or the
bridge's MQTT link is down) cannot be restarted from the Pi; the watchdog alerts
`Recovery failed — power cycle may be required` without attempting anything. A
controller that does not come back after `{"device": "evse"}` needs hands-on
attention too. If `status/health.http_ok` stays `false` and `mqtt_connected` is
`false`, check the charger's power and its LAN association before assuming a
firmware problem. The hourly cap bounds restart attempts only when some
transport can reach the gateway; a device with no reachable transport gets the
edge alert and is probed once per status tick until it recovers or the watchdog
is disabled, so no restart allowance is consumed.

**Disabling.** `WATCHDOG_ENABLED=false` stops all probes, restarts, health writes
and watchdog pushes, and the failure counter is not kept; `status/health` is then
left exactly as it was (possibly stale). Charging/offline notifications are
unaffected.

## What the bridge writes

Each loop is failure-isolated: a charger or Firestore error is logged as one
timestamped line and the loop carries on at its next interval.

| Loop     | Firestore document | Content                                                                                            |
| -------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| Status   | `status/current`   | Curated `/status` fields, merged on every poll                                                     |
| Status   | `history/<date>`   | `{kwh, hours: {"00"…"23"}, updated_at}`, both counters accumulated from `total_energy` deltas      |
| Status   | `sessions/{id}`    | `{started_at, ended_at, wh, elapsed, intervals?}` per completed plug-in session                    |
| Status   | `status/current`   | `schedule: {in_window, active_rule_id}` merged from the firmware's plan                            |
| Status   | `status/health`    | Watchdog state, decision reason, probe results and the last restart attempt                        |
| Status   | `status/health`    | `source`/`mqtt_connected`/`mqtt_announced`/`mqtt_last_lwt_at` transport fields (MQTT mode, merged) |
| Config   | `status/config`    | `/config` object with credential fields redacted, plus `updated_at`                                |
| Schedule | firmware           | `schedule/current` mirrored into the charger's event scheduler (see below)                         |
| Status   | `fcmTokens/{id}`   | Deleted when FCM reports the token unregistered/invalid                                            |
| Commands | `commands/{id}`    | `status` set to `acked` or `failed` (plus `error` / `result` fields)                               |

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
reading and increments `history/<YYYY-MM-DD>` by the difference. One write
moves both counters: the day's total and the bucket for the local hour the
bridge observed the delta in.

```js
history/2026-10-18 {
  kwh: 12.34,                        // the whole local day
  hours: { "19": 5.1, "20": 7.24 },  // Pi-local hour buckets (keys 00–23)
  updated_at: <server timestamp>
}
```

`hours` carries only the hours that recorded energy; a day written before
hourly capture existed has `kwh` and no `hours`.

The document id is the **local** date and the bucket key the **local** hour
(`datetime.now().astimezone()`), both taken from one clock read, so the day
rolls over at the Pi's local midnight and a tick cannot attribute its delta to
one hour and its document to another. Both counters use
`firestore.Increment`, so ticks and concurrent writes accumulate instead of
overwriting.

The write is a **field-path merge**,
``doc.set({…}, merge=["kwh", f"hours.`{hour}`", "updated_at"])``: the hour
segment is backtick-quoted (``hours.`<HH>` ``) because the SDK's field-path
parser rejects a bare numeric segment (`hours.21` is a syntax error, not a nested
path), and `pi/tests/fakes.py` enforces the same rule so a regression fails in
tests. Two simpler forms do not work. `merge=True` merges top-level keys only, so
a dotted `"hours.21"` key is stored as a literal field name rather than a bucket —
the SDK expands dotted keys in `update()` only. `update()` cannot create the
document: it defaults to `exists=True` and raises `NotFound` on the first write
of a new day. The merge list emits one write whose mask and transforms touch
exactly `kwh`, that one hour bucket and `updated_at`, so sibling hours and every
other field in the document survive. `Increment` on a missing field creates it,
so no read-before-write or transaction is needed. Elsewhere in these notes a stored
map key is written `hours["<HH>"]`, while the backticked dotted form
``hours.`<HH>` `` is reserved for the Firestore field path in a merge mask.

**Daylight saving.** Buckets are local wall-clock hours. On a fall-back day the
repeated hour merges into one bucket (both `01` hours accumulate under
`hours["01"]`, so that bucket can hold two hours of energy); on a spring-forward
day `hours["02"]` is absent. `kwh` stays the day's true total either way, so for a
day recorded since hourly capture began `sum(hours) == kwh`.

**Accuracy.** A delta lands in the hour the bridge observed it in, so it can be
misattributed by at most one status interval: 10 s over HTTP, or the reconcile
interval under MQTT.

`history/<date>` — not `history/daily/<date>` — because
Firestore document paths must have an even number of segments, and
`firestore.rules` exposes exactly `/history/{day}`. The first observation after
boot is a baseline and is never written (otherwise the all-time `total_energy`
would count as today's usage); at startup that baseline is seeded from the
existing `status/current` document. If the seed read fails (e.g. the Pi booted
before the network), the bridge retries it on later status ticks (at most every
30 s) and pauses history until it succeeds, so the eventual first delta still
starts at the last stored reading instead of dropping the downtime energy. If
`total_energy` drops (firmware reset), the bridge logs
`total_energy reset; rebaselining history` and starts a new baseline without
writing a negative delta. A failed history write does not advance the in-memory
baseline: the same delta is retried on the next tick, and lands in the bucket
for the hour that retry happens in.

### Charging sessions

The charger keeps `session_energy` (Wh) and `elapsed` cumulative for the whole
plug-in event and clears them only when the vehicle disconnects. A pause, a
scheduled-window end, or a manual stop ends the charging _state_ but not the
session. The bridge therefore treats a session as one plug-in event and writes
one document:

```
sessions/1792345678   { started_at, ended_at, wh, elapsed, intervals? }
```

`wh` is the charger's `session_energy` and `elapsed` is seconds. `ended_at` is
the stop time and `started_at` comes from the charger's own timer
(`ended_at - elapsed`), never from when the bridge booted.

`intervals` records **when** that energy was actually drawn: one entry per
contiguous charging block, `{started_at, ended_at, wh}`, in start order. The
bridge opens an interval when it first sees `state: 3`, adds each charging
tick's `session_energy` growth to it, and closes it when the state leaves 3 (or
at finalisation). The bounds are observation times — the charger's transition
happened between two polls, so an interval starts at the first tick that saw it
rather than at the aggregate's charger-timer start. The web app prices each
interval over its own start and end, which is what makes a paused session
accurate.

**What the intervals are guaranteed to account for.** In a session the bridge
observed end to end with no counter reset, the intervals add up to `wh` except
for the session's first charging tick, which only supplies the baseline (so up
to one poll of energy can be missing — ~0.03 kWh at the charger's ceiling). The
equality is _not_ universal:

- a **restart mid-charge** leaves the energy drawn before it in the aggregate
  and in no interval (the seeded baseline starts the new interval at zero);
- an **in-block counter reset** makes the intervals exceed the reset aggregate;
- a **dropped implausible step** leaves the aggregate whole and the list short.

A step is attributed only when the charger could have delivered it: at most
`MAX_INTERVAL_POWER_W` (25 kW, more than twice the 48 A ceiling) × the measured
seconds between the two readings, plus a small floor — so a legitimate step
after a long outage is kept and an impossible jump is not. The gap is measured
with `CLOCK_BOOTTIME`, which keeps counting across suspend (falling back to
`time.monotonic()` where the platform lacks it), so a Pi that suspends
mid-charge is judged on the time that actually elapsed rather than the awake
time. Every other timer in the bridge stays on `time.monotonic()`.

A non-positive step is never negative energy: it is dropped and the tick's
reading becomes the next baseline. What it means depends on where it happens,
and each case has its own journal line:

- `interval opened: baseline <n> Wh` — a fresh interval starts here (a new
  plug-in, or the resume half of a pause). Its first reading is only a baseline;
  a new plug-in's cleared counter is routine, not an anomaly.
- `interval step skipped: counter reset inside the open interval (<Δ> Wh, <gap>)`
  — the counter went backwards while an interval was already open (a firmware
  restart mid-session). The step is dropped and the reading becomes the new
  baseline.
- `interval step dropped: <Δ> Wh in <gap> exceeds the <n> Wh the charger could
deliver` — the step is physically impossible. The energy stays in the
  aggregate and the interval stays short.

A cap fold is logged too, naming the session and the number of intervals
dropped.

Because of those three cases the web app does not trust the list blindly: it
prices per interval only when the intervals add up to the session's `wh` within
`max(250 Wh, 2%)` and otherwise falls back to pro-rating the aggregate. So a
session with intervals _and_ a divergent energy total still shows a correct
figure — just computed the older way.

The aggregates are unchanged and still describe the whole plug-in: `wh`,
`elapsed`, `started_at` and `ended_at` mean exactly what they meant before
intervals existed, so an older reader (and a session with no intervals, see
below) is unaffected. `intervals` is absent when no interval had positive
energy — a zero-wh plug-in is skipped entirely, and a bridge restart that never
saw the counters grow writes the aggregates alone rather than inventing a
block. Such a record is priced by the old uniform pro-rating.

`intervals` is capped at 100 per record (`MAX_SESSION_INTERVALS`). Past that the
oldest entries are folded into the oldest retained interval — its start becomes
the earliest dropped start and its energy their sum — so the list keeps the most
recent 100 blocks in start order without losing energy (the fold is logged); only
that folded head is pro-rated over the idle stretch it spans.

A restart mid-charge does not fabricate intervals. `status/current` seeds
`session_energy`, so the first tick after the restart opens one interval whose
energy is the growth from that baseline: **the block that spans the restart is
one interval**. Everything drawn before the seed reading — the whole pre-restart
part of the session — is in `wh` and in no interval, so such a record's list is
energy-short by design and the web layer prices its aggregate instead (above).
Nothing is written for the part of the session the bridge never observed.

On every `state 3 → non-3` edge the bridge looks up the most recent session. It
**merges** the new record into it (keeping the earlier `started_at`, the later
`ended_at`, and `max(wh)` / `max(elapsed)`) when the previous interval still
touches the new one, the start is within 120 s, or the vehicle is still plugged
in and both cumulative counters kept growing (with the previous record less
than 48 hours old). This is what makes pause/resume and
back-to-back scheduled windows one record instead of two documents that
double-count the same cumulative energy. The merged write keeps the previous
document id; a brand-new session uses the Unix timestamp of `started_at`.
`wh` is never negative and never lowered by a merge. A merged record's
intervals are concatenated in start order (one corrupt entry is dropped without
discarding the rest, and the drop is logged), and the aggregates still cover the
whole session even when the cap has folded the oldest blocks.

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
  are still never evaluated locally — the firmware enforces them. An empty
  `[]` plan (no events configured) is normal and publishes
  `{in_window: false, active_rule_id: null}` without a failure log; any other
  non-object payload is still an error.
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

### Commands over MQTT (issue #46)

With `MQTT_ENABLED=true` **and** the source ready — broker `connected` and
`<MQTT_TOPIC>/#` `subscribed` — the command loop publishes to the charger's
native topics instead of calling the HTTP API. Readiness is checked once,
immediately before the publish. HTTP stays the fallback when MQTT is not ready
_at that moment_; the flag alone does not switch the command path if the
subscription was denied or the link is down.

| `type`        | Publish on `<base>/…`                                                                                                                   | Acknowledged by                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pause`       | `override/set` `{"state":"disabled"}`                                                                                                   | retained `override` `{"state":"disabled",…}`, or a status view with `manual_override: 1` and `state: 254/255`                                               |
| `resume`      | `override/set` `clear`                                                                                                                  | retained `override` `{"state":"null"}` (the firmware's auto state) or `manual_override: 0`                                                                  |
| `set_current` | `override/set` `{"state":"active","charge_current":N,"max_current":N}`                                                                  | retained `override` with `state: "active"` and `charge_current: N` (or `manual_override: 1` with `pilot: N`; clamped holds confirm at `pilot: max_current`) |
| `rapi`        | `rapi/in/<command>` with the parameters as the payload (`$FS 20` → topic `rapi/in/$FS`, payload `20`; empty payload without parameters) | the next `rapi/out` reply: `$OK…` → `acked` with the reply in `result`; `$NK…` → `failed` with the reply in `error`                                         |

Override commands wait `COMMAND_CONFIRM_SEC` (5 s) for the retained
`<base>/override` document, which the firmware rewrites on every change — it
distinguishes `"null"` (auto), `"disabled"` (pause) and `"active"` (hold),
whereas the status `manual_override` field is `1` for either override. The raw
status seed is the fallback for the moment before that document lands. Because
`manual_override` alone cannot separate pause from hold, a pause is confirmed
from a status view only by `manual_override: 1` **plus** a non-charging EVSE
state (`254` sleeping or `255` disabled; 8.2.3 pauses into `254` and `255` is
never observed). A sleeping charger with no override reports the same `254`
with `manual_override: 0`, so the override flag is what separates the two. A
hold is confirmed from `pilot`, which tracks the held setpoint up to the EVSE's
configured maximum, so a command above that maximum is confirmed at the clamp
(`pilot` == the `/status` `max_current`). A retained document that is
`"active"` but names no current confirms nothing — it cannot distinguish an
applied hold from a lost publish — and falls through to the `/status`
reconcile. A timeout does **not** re-apply the command: the
bridge reads `/status` once (read-only) and accepts it if the status already
reflects the target state, otherwise marks it `failed` with
`no confirmation within 5s (…)`.

RAPI replies carry no correlation id, so RAPI publishes are serialised: one
lock covers the publish and the wait, making the next `rapi/out` belong to the
command in flight. The topic is the command itself (`$FS`), the parameters go in
the payload, and the wait starts from the reply count captured _before_ the
publish; the _first_ reply after that count is the command's answer (a second
reply in the same window cannot displace it). A reply that is not `$OK…` fails
the command with the reply in `error`; a missing reply fails with
`no rapi/out within 5s` and keeps the lock for `RAPI_QUARANTINE_SEC` (2 s), so a
reply arriving late for the abandoned command is retired instead of settling the
next one. A reply arriving after that quarantine still cannot be distinguished —
the firmware sends no correlation id.

**Fallback and double-apply.** HTTP runs only when MQTT was not usable _before_
a publish (disabled, disconnected, or subscription denied), with identical
validation, acknowledgement and lifecycle semantics. A publish the client
refuses (no connection, `rc ≠ 0`) also falls back, because nothing was
delivered. A publish the client accepted never falls back: if the broker drops
before the acknowledgement, the command is reconciled from the retained
override/`rapi/out`/status or marked `failed`, never re-applied. The settled
memory also covers failed commands whose status write did not land, so a
published command is not repeated on the next poll. Every command document
records the transport that **carried** the request — `transport: "mqtt"` or
`"http"` — on success and on any failure after a send (a refused MQTT publish
that falls back and then fails over HTTP records `"http"`); a command rejected
before anything was sent (validation, unsupported type, stale) records no
transport. The journal logs `command transport: <transport> (…)` when the path
changes. Validation (`amps` 6–48, RAPI `$` and ≤32 characters), the 10-minute
staleness rule, `status` lifecycle and error copy are unchanged.

## Tests

The bridge and ACL helper have stdlib `unittest` coverage under `pi/tests/`
with in-memory Firestore/HTTP/MQTT fakes; no charger, broker, Firestore, or FCM
access is needed. `pi/tests/test_mqtt.py` covers the topic mapping, the
debounce/merge, the raw-snapshot → `parse_status` → document path (units,
derived fields, no uncurated keys), the no-nulling rule, the pre-seed partial
snapshot (no transition, no session), fallback, the config-version trigger with
its failure retry, source transitions, the stale-reconcile ordering guard, the
CONNACK/SUBACK failure logs and the no-duplicate-transition rule.
`pi/tests/test_mqtt_commands.py` covers the command path: each command type's
topic/payload, override acknowledgement (success, mismatched current, timeout,
read-only status reconcile), RAPI `$OK`/`$NK`/timeout and serialisation, HTTP
fallback when the source is not ready, a refused publish, no double-apply, and
the recorded `transport`. Run it with the same venv as the service:

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
