# Pi bridge agent

A small Python service that bridges the OpenEVSE charger to Firebase: it polls
the charger's local HTTP API, mirrors status and config into Firestore
(`status/current`, `status/config`), derives daily energy history and completed
sessions, mirrors `schedule/current` into the charger's own scheduler, sends FCM
push notifications for charger-health alerts, outages and watchdog restarts, and
applies pending
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

| Variable                          | Default               | Meaning                                                                                                                                                                                                                                                          |
| --------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHARGER_HOST`                    | `192.168.0.145`       | Bootstrap charger address; the app's Charger connection value overrides it at runtime (below)                                                                                                                                                                    |
| `CHARGER_USER` / `CHARGER_PASS`   | unset                 | HTTP Basic auth if set on the charger (blank username is valid)                                                                                                                                                                                                  |
| `FIREBASE_SERVICE_ACCOUNT`        | —                     | Path to the service-account key (**required**; relative paths resolve from the repo root)                                                                                                                                                                        |
| `STATUS_INTERVAL`                 | `10`                  | Seconds between charger status polls                                                                                                                                                                                                                             |
| `CONFIG_INTERVAL`                 | `60`                  | Seconds between charger config polls                                                                                                                                                                                                                             |
| `SCHEDULE_INTERVAL`               | `60`                  | Seconds between schedule/plan polls and sync checks                                                                                                                                                                                                              |
| `SCHEDULE_RECONCILE_INTERVAL`     | `300`                 | Seconds between full `/schedule` reconciles even when the desired digest is unchanged                                                                                                                                                                            |
| `COMMAND_INTERVAL`                | `5`                   | Seconds between command polls                                                                                                                                                                                                                                    |
| `SETTINGS_INTERVAL`               | `60`                  | Seconds between `settings/current` reads (the live charger-address refresh)                                                                                                                                                                                      |
| `NOTIFICATIONS_INTERVAL`          | `300`                 | Seconds between charger health polls (`GET /notifications`; see [Charger health](#charger-health-issue-158))                                                                                                                                                     |
| `WRITE_MIN_GAP_SEC`               | `30`                  | Minimum seconds between `status/current` writes (the write policy's rate-limit bound)                                                                                                                                                                            |
| `CHARGING_HEARTBEAT_SEC`          | `60`                  | Seconds between `status/current` heartbeat writes while charging (state 3)                                                                                                                                                                                       |
| `HEARTBEAT_INTERVAL`              | `300`                 | Seconds between `status/current` heartbeat writes while idle                                                                                                                                                                                                     |
| `HISTORY_FLUSH_SEC`               | `300`                 | Seconds between `history/<date>` flush writes while charging (rollover, session close and shutdown flush too)                                                                                                                                                    |
| `RECONCILE_INTERVAL`              | `3600`                | Seconds between day-reconciliation evaluations of `history/<date>` against the charger's `total_day` (and, once per local day, the month's documents against `total_month`) (`0` disables; reads only — see [Day reconciliation](#day-reconciliation-issue-161)) |
| `WATCHDOG_ENABLED`                | `true`                | Probe, restart and alert when `/status` keeps failing (see below)                                                                                                                                                                                                |
| `WATCHDOG_FAILURES`               | `3`                   | Consecutive failed `/status` polls before the charger is treated as unhealthy                                                                                                                                                                                    |
| `WATCHDOG_COOLDOWN_SEC`           | `600`                 | Minimum seconds between restart attempts                                                                                                                                                                                                                         |
| `WATCHDOG_MAX_PER_HOUR`           | `3`                   | Hard cap on restart attempts in a trailing hour                                                                                                                                                                                                                  |
| `WATCHDOG_RESTART_WHILE_CHARGING` | `false`               | Allow a restart while the last known state is charging                                                                                                                                                                                                           |
| `MQTT_ENABLED`                    | `false`               | Ingest status from the charger's MQTT topics (see below); HTTP stays the fallback                                                                                                                                                                                |
| `MQTT_HOST`                       | —                     | Broker host (required when `MQTT_ENABLED=true`)                                                                                                                                                                                                                  |
| `MQTT_PORT`                       | `1883`                | Broker port                                                                                                                                                                                                                                                      |
| `MQTT_USER` / `MQTT_PASS`         | unset                 | Broker credentials; keep the password in `private/bridge.env` only                                                                                                                                                                                               |
| `MQTT_TOPIC`                      | `chelevse`            | Base topic the charger publishes to (`mqtt_topic` in the charger config)                                                                                                                                                                                         |
| `MQTT_RECONCILE_SEC`              | `60`                  | Seconds between HTTP `/status` reconciles while MQTT is connected                                                                                                                                                                                                |
| `MQTT_CLIENT_ID`                  | `chelevse-bridge`     | MQTT client id                                                                                                                                                                                                                                                   |
| `MQTT_ANNOUNCE_TOPIC`             | `openevse/announce/#` | Broker filter carrying the gateway's announce/Last Will (see the watchdog)                                                                                                                                                                                       |

Bad `WATCHDOG_*` values (a non-number, `WATCHDOG_FAILURES=0`, a cooldown below
zero, a cap below 1, a non-boolean flag) stop the bridge at startup with a
message naming the variable, like the interval settings. The same applies to bad
`MQTT_*` values — a non-boolean flag, a port outside 1–65535, a
`MQTT_RECONCILE_SEC` of zero or `nan`, a blank topic, or `MQTT_ENABLED=true`
without `MQTT_HOST`.

### Charger address

The charger's address is owned by the app, not by the env file. At startup the
bridge reads `settings/current.charger_host` and, when it is valid, uses it
instead of `CHARGER_HOST`; it then re-reads that document every
`SETTINGS_INTERVAL` (60 s) and swaps the address live — same process, same PID,
no restart and no edit to `private/bridge.env`. Every consumer (status, config,
schedule, commands, the watchdog probe and restart) builds its next URL from
the one holder, so a swap takes effect on the very next request.

The value is one host and nothing else: an IPv4 literal or a hostname, e.g.
`192.168.1.50` or `evse.local`. At most 253 characters, only `A–Z a–z 0–9 . -`,
an alphanumeric first and last character, labels of 1–63 characters with no
leading or trailing hyphen, and every octet 0–255 in a four-part IPv4 literal.
A scheme (`http://`), port (`:8080`), path, userinfo, inner space or a leading
or trailing dot/hyphen is rejected. Case is preserved as typed. The base stays
`http://<host>` — no port, no TLS, no userinfo override (credentials stay in
`private/bridge.env`).

Journal lines:

- `charger host: http://192.168.1.50 (app settings)` — the address chosen at
  startup, with its source (`environment` when the app has no value).
- `charger host: http://192.168.0.145 -> http://192.168.1.50 (app settings)` —
  a live change. Clearing is the same line with `(environment)` as the source.
- `charger host rejected: 192.168.1.50:8080 (keeping http://192.168.0.145)` — a
  stored value the grammar rejects: logged, current address kept. At startup
  the same rejection names the bootstrap it falls back to, and the bridge starts
  normally.
- `charger host: settings read failed (...); keeping http://…` — a Firestore
  read error changes nothing.

Clearing the field in the app removes `charger_host` from the document (it is
not stored as an empty string), and the bridge reverts to `CHARGER_HOST` on the
next refresh. Nothing reverts because the charger stopped answering: a saved
address is honoured until the owner changes it, and the charger-offline banner
in the app is the feedback path.

### One charger HTTP session

Every poll loop shares one `requests.Session` (`ChargerTransport` in
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
outside the lock. The config, schedule and health pollers start 3 s, 7 s and
15 s late so `/status`, `/config`, `/schedule/plan` and `/notifications` do not
hit the charger together. Polling intervals, timeouts, auth, payloads and
failure logging are unchanged.

### MQTT status source (issue #44)

With `MQTT_ENABLED=true` the bridge subscribes to `<MQTT_TOPIC>/#` and applies
status as the charger publishes it, instead of inferring freshness from a 10 s
poll — the document itself is written on the [write policy](#write-policy-issue-93)'s
cadence, not per snapshot. The flag is **off by default**; with it off nothing
below changes.

The firmware publishes one topic per value (`<base>/amp`, `<base>/state`, …)
when its EVSE poll reports a change. Topic values are handed over in their raw
units and every snapshot runs through the same `parse_status` / `apply_status`
path as an HTTP poll, so the document shape, unit conversions, history and
sessions are shared — a second source describing the same state cannot ring up
history twice or write a second session. `status/current` therefore carries
only the curated fields listed under
[What the bridge writes](#what-the-bridge-writes); the raw `/status` keys
(`comm_*`, `ipaddress`, `macaddress`, `mqtt_connected`, …) never reach it.

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
| `<base>/temp1`–`temp3`    | —                      | 10ths of °C; liveness only, never mapped (#159)     |
| `<base>/config_version`   | —                      | triggers one `/config` sync                         |

Everything else on the base topic (retained `config`, availability counters) is
ignored by the status path. The `temp1`–`temp3` topics arrive on the wildcard
subscription but are never mapped into a snapshot (#159): no consumer reads a
topic temperature — the health gate's `thermal.high_temp` corroboration reads
temperatures from the
`/status` parse on polls and reconciles (`parse_status` →
`LiveObservations.note_status`), never from the topics — and `status/current`
carries no temperature field. A temp delivery is still **liveness**: an idle
charger may publish nothing but a sensor change for minutes, so a temp-only
burst debounces and flushes with nothing merged, advancing the arrival
generation the outage classifier reads as proof the charger is publishing (a
temp-only publish between failed reconciles refuses an outage escalation). The
retained `claim`, `limit` and `boost` documents
are **ingested as claims evidence** (#159): each delivery is decoded and handed
to the claims holder, parsed defensively (malformed → ignored), and used for
`status/claims` detail enrichment and corroboration only — never as a status
field, and never as the reason (that is `GET /claims/target`; see
[Claims reason](#claims-reason-issue-159)). The retained `schedule` event list
is not ingested: nothing consumes it (the schedule reason's rule id comes from
the schedule loop's `/schedule/plan` window), so it is ignored like any other
unmapped retained document. The
retained `override` document and `rapi/out` feed the command acknowledgements
([Commands over MQTT](#commands-over-mqtt-issue-46)); `override/set` and
`rapi/in` are our own publishes; LWT handling is #45. The retained `override`
document has one more role on the status path (#159): no status topic publishes
`manual_override`, so it is the only fact fresher than the `/status` seed there,
and the firmware rewrites it on every override change. A document that _changes_
the flag (`{"state":"disabled"}` pause and `{"state":"active",…}` hold → 1,
`{"state":"null"}` auto → 0; anything else states no fact) rides the same
debounced snapshot as a burst, so a user Stop arriving as `state 254` over MQTT
labels `stopped` immediately instead of `sleeping` until the next reconcile. A
redelivery that restates the known flag queues nothing — a retained copy is
broker-held, not the charger publishing, and must not advance the arrival
generation the outage classifier reads. The retain flag draws the same line
before the first `/status` seed: the broker's stored copy replayed on subscribe
queues nothing (and the seed carries `manual_override` anyway), while a fresh
publish — the broker clears the flag on a live forward — queues even unseeded,
so a Stop pressed after a bridge restart with the charger's HTTP wedged still
labels `stopped`.

**Cadence.** While the broker is connected **and the subscription is granted**,
`/status` is fetched once every `MQTT_RECONCILE_SEC` (60 s) and merged into the
snapshot — reconciliation only — plus once per charging heartbeat, whose
forced observation refreshes the published values on the
[write policy](#write-policy-issue-93)'s cadence. A broker that accepts the connection and then
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
state machine and sessions only run once a snapshot is
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
— so it is kept in order behind the queued ones rather than
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
left exactly as it was (possibly stale). Offline and health notifications are
unaffected.

## What the bridge writes

Each loop is failure-isolated: a charger or Firestore error is logged as one
timestamped line and the loop carries on at its next interval.

| Loop          | Firestore document     | Content                                                                                                                                                                                                                                                       |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | `status/current`       | Curated `/status` fields on the write policy's cadence (see below)                                                                                                                                                                                            |
| Status        | `history/<date>`       | `{kwh, hours: {"00"…"23"}, updated_at}`, both counters accumulated from `total_energy` deltas, flushed on the [history flush](#history-flush-issue-94) cadence                                                                                                |
| Status        | `sessions/{id}`        | `{started_at, ended_at, wh, elapsed, intervals?}` per completed plug-in session                                                                                                                                                                               |
| Schedule      | `status/current`       | `schedule: {in_window, active_rule_id}` from the firmware's plan, published on change as a write-policy trigger (#95)                                                                                                                                         |
| Status        | `status/health`        | Watchdog state, decision reason, probe results, the last restart attempt, and the rolling write counts (`writes_24h`, `writes_by_kind`)                                                                                                                       |
| Status        | `status/health`        | `source`/`mqtt_connected`/`mqtt_announced`/`mqtt_last_lwt_at` transport fields (MQTT mode, merged)                                                                                                                                                            |
| Config        | `status/config`        | `/config` object with credential fields redacted, plus `updated_at`                                                                                                                                                                                           |
| Notifications | `status/notifications` | The gateway's live advisory ring projected into the three-fact model; written only when the projection changes, ignoring each entry's moving `last_seen` (see [Charger health](#charger-health-issue-158))                                                    |
| Claims        | `status/claims`        | The one authoritative "why isn't it charging?" from `GET /claims/target` (`reason`, the winning clients, evidence `detail`); written only when the content changes — `unknown` when the target is unavailable (see [Claims reason](#claims-reason-issue-159)) |
| Schedule      | firmware               | `schedule/current` mirrored into the charger's event scheduler (see below)                                                                                                                                                                                    |
| Status        | `fcmTokens/{id}`       | Deleted when FCM reports the token unregistered/invalid                                                                                                                                                                                                       |
| Commands      | `commands/{id}`        | `status` set to `acked` or `failed` (plus `error` / `result` fields)                                                                                                                                                                                          |
| Commands      | `status/notifications` | `acks.<notification_id> = <epoch seconds>` after a 2xx `POST /notifications/ack` — a nested map merge the health poll never writes, so the two cannot clobber each other (see [Commands](#commands))                                                          |

`status/current` carries the curated set (`state`, `state_label`, `amp`,
`voltage`, `power`, `session_energy`, `total_energy`, `elapsed`, `vehicle`,
`pilot`, `charger_online`, `updated_at`), not the whole raw `/status` object.
No temperature field is written (#159): the per-sensor readings are parsed for
the health gate alone and dropped at the sink, and values stored by an older
bridge are simply never read again (the schema is additive).

### Write policy (issue #93)

One scheduler owns every `status/current` write; MQTT snapshots and HTTP polls
only **apply** state (tracker, history, sessions, generations — the discard
guards are unchanged). The cadence, by field kind:

- **Discrete triggers** — a snapshot-driven change of `state`, `vehicle`,
  `pilot` or `charger_online`, a session close, the active schedule window
  (#95: the schedule loop feeds it every `SCHEDULE_INTERVAL` and a _change_
  arms the trigger; an unchanged window arms nothing; publication still
  waits for the first status apply, so a window that moves before any
  observation rides that first write), or a **completed
  command** — publish at the next
  scheduler opportunity (the 1 s status-loop tick under MQTT), never sooner
  than `WRITE_MIN_GAP_SEC` (30 s) after the previous write. That gap is the
  worst-case bound: a flapping charger cannot exceed one write per 30 s.
- **Continuous values** — `session_energy`, `total_energy`, `elapsed`, `power`,
  `voltage` — never trigger a write. They move constantly while
  charging, so they are carried by the heartbeats: at least one write per
  `CHARGING_HEARTBEAT_SEC` (60 s) while charging, one per `HEARTBEAT_INTERVAL`
  (300 s) otherwise. No write ever originates from `elapsed` alone — the app
  interpolates it locally from the write anchor.
- **A heartbeat is a full curated payload, never a timestamp-only bump.** When
  due, the scheduler first forces a fresh observation through the existing
  HTTP reconcile path (`GET /status` → `parse_status` → `apply_status` with
  the mqtt-mark/arrival/seed guards) and publishes what that observation
  applied. If nothing fresh landed — the charger did not answer and MQTT
  stayed silent — there is no write: a fresh `updated_at` on stale values
  would corrupt the app's live-cost interval `[updated_at − elapsed,
updated_at]`. Under HTTP-only mode the status poll is the observation and
  the heartbeat just publishes.
- **A completed command forces an immediate write** bypassing both cadences
  and the rate limit: the app holds its session clock until a _status_ write
  lands, so the command document's own write is not a substitute. A failed
  command forces nothing — the app clears its held clock only when the send
  itself fails on the device, so a bridge-reported failure leaves the clock
  frozen until the next heartbeat write (≤60 s while charging), where it
  self-clears.
- **No-op suppression:** a due trigger whose payload equals the last written
  payload (ignoring `updated_at`) writes nothing. A due heartbeat always
  writes.
- The first snapshot after start publishes (no last-written baseline).

Kept outside the policy: the offline edge (`charger_online: false`) still
writes immediately on every failed poll — it is the one write that must not
wait — while its journal line and push fire once per outage, on the edge.
`status/health` and `status/config` keep their own loops' cadences.

### History flush (issue #94)

`history/<date>` no longer writes per observation. Each positive
`total_energy` delta is attributed to the local `(day, hour)` it was observed
in and accumulated in memory; one flush writes **one masked-merge document per
pending day**, carrying `kwh` plus every touched `hours.<HH>` bucket in the
field-path merge list — a flush spanning an hour boundary is still one write,
and midnight is one write per day document. Flush points:

- **Hour rollover** — the first delta observed in a new local hour flushes the
  closed hour's energy; one extra write per boundary crossed.
- **Session close** — the charging (state 3) → not-charging edge flushes
  exactly once.
- **Every `HISTORY_FLUSH_SEC` (300 s) while charging** — 12 writes/hour while
  charging, 0 while idle. Energy that creeps in while idle (standby draw) is
  kept but waits for a rollover, session close or shutdown.
- **Shutdown** — after the SIGTERM/SIGINT stop event ends the loops, the
  bridge drains the accumulator before exiting, so stops and restarts lose
  nothing when the drain's write lands; a drain that fails (Firestore
  unreachable) is logged and that energy is lost with the process, like an
  unclean power loss.

A failed write keeps the accumulator and retries on the next flush point, so
energy is never dropped while the bridge is running, and every delta lands in
its observed hour — including the retry's. An unclean power loss — or a
shutdown drain whose write fails — can lose at most one flush interval of
history.

### Write budget and counter (issue #96)

The bridge counts every successful Firestore write, by kind, in a
process-local counter over a rolling 24 h window: `status` (`status/current`),
`history` (`history/<day>`), `session` (`sessions/<id>`), `config`
(`status/config`), `command` (`commands/<id>`), `health` (`status/health` and
`status/notifications`), `claims` (`status/claims`) and `fcm` (token-prune
deletes — Firestore bills a delete as a write). The status loop logs the
summary once an hour (the first line right after start, proving the counter is
alive):

```
firestore writes: 319 in 24h (status=276 history=12 session=1 config=0 command=27 health=2 claims=1 fcm=0)
```

`status/health` carries the same counts as `writes_24h` and `writes_by_kind`
on its existing watchdog/transport-transition writes — the counter rides
documents that are written anyway, so it costs no writes itself. Two more
journal lines make quota trouble visible before it bites:

- `write budget warning: N writes in 24h — 50% of the free-tier quota` when
  the rolling count crosses 10,000 — once per crossing, re-armed only when
  the window rolls the count back below it.
- `firestore write quota exceeded (RESOURCE_EXHAUSTED) — writes paused until
the daily reset`, at most once per hour while writes fail with the SDK's
  `RetryError`-wrapped 429 (the direct `ResourceExhausted` form counts too).
  Without this line the failure surfaces as `RetryError: Timeout of 60.0s
exceeded, last exception: 429 Quota exceeded.` — which reads like a
  network problem, exactly how the original outage went unnoticed.

**The budget.** The project is on the free Spark plan: **20,000 document
writes/day** and **50,000 document reads/day** are hard stops. The write
policy above (#93/#94/#95) was sized for the real workload — one charger,
two vehicles, 12–14 h/day charging:

| Day                                   | status | history | idle heartbeat | edges + sessions + config + commands | Total  | Share of 20k |
| ------------------------------------- | ------ | ------- | -------------- | ------------------------------------ | ------ | ------------ |
| No charging                           | 0      | 0       | 288            | ~30                                  | ~320   | 1.6 %        |
| 12 h charging (60 s heartbeat)        | 720    | 144     | 144            | ~50                                  | ~1,060 | 5 %          |
| 14 h charging (60 s heartbeat)        | 840    | 168     | 120            | ~50                                  | ~1,180 | 6 %          |
| 14 h, worst case (trigger every 30 s) | 1,680  | 168     | 120            | ~50                                  | ~2,020 | 10 %         |
| Pathological: 24 h charging           | 1,440  | 288     | 0              | ~50                                  | ~1,780 | 9 %          |

(The pre-policy burn, for reference, was ~27,000/day — 135 % of the quota,
exhausting it by early evening every day. Acceptance for #91: ≤400 on a
no-charge day, ≤1,300 typical / ≤2,200 worst case at the 12–14 h workload —
verify against the summary line and `writes_24h` after deploy.)

Two notes on why nothing else was tuned:

- **Reads are not the binding constraint.** The command poll at
  `COMMAND_INTERVAL=5` costs 17,280 reads/day of the 50,000 free; everything
  else is listeners and single reads. Raising the interval would save reads
  nobody needs and make every button press in the app feel up to 5 s slower,
  so it stays at 5 s.
- **Batching is not a saving.** Firestore bills per document written — a
  batched write of N documents costs exactly what N writes cost — so the
  only lever is writing less often, which is what the policy does. A
  separate heartbeat document would be the same: one more write plus a
  listener, for nothing.
- **The health poll adds no steady-state writes.** `status/notifications`
  (#158) is written only when its projection changes — zero on an unchanged
  charger — plus one write when the process starts and the first poll lands.
  Its 300 s `GET /notifications` costs 288 charger reads/day (a GET to the
  gateway, not a Firestore read) and one Firestore read of the stored document
  at start-up.

One deployment caveat the counter makes visible: with `MQTT_ENABLED=false`
the config loop resyncs `status/config` unconditionally every
`CONFIG_INTERVAL` (60 s) — ~1,440 writes/day on its own, dwarfing the table
above. MQTT mode (this deployment) syncs only on a `config_version` change
(~1/day); if the journal ever shows `config=` climbing on an HTTP-only
install, that loop is why.

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

### Charger health (issue #158)

The bridge polls the gateway's advisory ring every `NOTIFICATIONS_INTERVAL`
(300 s) and projects it into the sibling document `status/notifications`. The
gateway's own view cannot be stored as-is: `GET /notifications` returns every
live advisory (acked ones included), but `sticky` is a literal per-rule
constant — every counter-derived advisory (`fault.*`, `wear.*`) ships
`sticky:false` — so the bridge classifies each entry itself (`pi/health.py`):

- **`acknowledged`** — the owner muted it (`acked: true`). Wins over the other two.
- **`active`** — a live signal the bridge already polls corroborates the rule's
  own raise predicate.
- **`historical`** — a record: a counter or lifetime value, a rule with no
  exposed live signal, or a rule family whose firmware gate is still closed.

`severity` is copied from the firmware verbatim and never merged with liveness:
a cleared ground fault stays `critical` while reading as `historical`. The
firmware's `sticky` is stored as `firmware_sticky` and used for nothing else.
`first_seen`/`last_seen` are the gateway's own epoch seconds; the ring is
RAM-only (they restart at gateway boot), which is why the counter — not
`first_seen` — is the firmware's ack token for counter-backed advisories.

Corroboration (`active`) comes from observations other loops already fetch — no
extra charger GET:

| Advisories                                                     | Live proof                                                                                                                                                    | Ack token (`counter_token`)                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `safety.*`                                                     | the matching `/config` boolean is `false` (`ground_check`, `relay_check`, `diode_check`, `vent_check`, `temp_check`) — never `/status.flags`, which is VFLAGS | the five booleans together, `1`/`0` in that order                                          |
| `fault.gfci_tripped` / `fault.no_ground` / `fault.stuck_relay` | controller `state` is 6 / 7 / 8                                                                                                                               | `gfcicount` / `nogndcount` / `stuckcount`                                                  |
| `thermal.high_temp`                                            | a valid sensor at or above `over_temp_shutdown − 5` (default panic 72 °C)                                                                                     | `first_seen`                                                                               |
| `thermal.relay_thermal`                                        | `relay_thermal_warning_level ≥ 1` — 1 (watch) or 2 (warn); 0 is none/not available, so presence alone is not proof                                            | the level                                                                                  |
| `thermal.throttling`                                           | none exposed → always historical                                                                                                                              | `first_seen`                                                                               |
| `wear.relay_cold_open` / `wear.stuck_relay_recovery`           | lifetime records → always historical                                                                                                                          | their counters (`relay_cold_open_count` / `relay_stuck_recovery_count`)                    |
| `wear.relay_life`                                              | lifetime record → always historical                                                                                                                           | the severity step, not the percentage (ordinary wear ticking 20 → 19 must not void an ack) |
| `wear.relay_transit_drift`                                     | lifetime record → always historical                                                                                                                           | `first_seen` (the firmware's own token for this rule is the constant `0`)                  |

The counters come from the status loop's latest `/status` reply and the config
view from the config loop's last `status/config` write, handed over through one
small locked holder. `status/current` is untouched — counters are a health
concern, not a display field.

**Gates.** The gateway evaluates its rules from caches that can still be unknown
and stays silent while they are: no `$GE` answer means no `safety.*` rules at
all, no `$GL` answer means no `wear.*` / `thermal.relay_thermal` rules (and
`/config` omits the relay block). The document therefore carries
`gates: {settings_known, relay_health_known, relay_health_supported}`; a closed
gate means **health incomplete**, never "no faults".

`relay_health_supported` is the _capability_ fact beside the two transient
gates: some controller generations never answer `$GL` at all, so their relay
gate is a permanent fact rather than a gap that may close. It is an exact-match
table (`RELAY_HEALTH_UNSUPPORTED_FIRMWARE`) over the written `/config` view's
`firmware` string — a string is added only for a verified fact, and anything
unlisted (no firmware yet, `master`, any other version) means _may report_,
keeping the transient meaning. Data beats the table: a relay block that does
arrive closes `relay_health_known` whatever the table says. The web renders
`false` neutrally (muted), never as the amber incomplete a still-waiting gate
gets (#181).

**Document.** Merge writes only, and only when the projected content changes:

```json
{
  "reachable": true,
  "checked_at": 1794870706,
  "source": "http",
  "gates": { "settings_known": true, "relay_health_known": false, "relay_health_supported": false },
  "counters": { "nogndcount": 7, "gfcicount": 0, "stuckcount": 0 },
  "advisories": [
    {
      "id": "fault.no_ground",
      "category": "fault",
      "severity": "critical",
      "firmware_sticky": false,
      "acked": true,
      "first_seen": 1794177153,
      "last_seen": 1794870706,
      "classification": "acknowledged",
      "corroborated": false,
      "counter_token": 7,
      "first_observed": 1794870000
    }
  ],
  "alerted": {},
  "updated_at": "<server timestamp>"
}
```

- `checked_at` is the epoch second of the observation that produced the last
  write, `updated_at` the server timestamp of that write. `checked_at` is not a
  heartbeat: the document is written only on change, so the app treats a
  missing/stale document as "health unknown" and takes bridge liveness from
  `status/current`'s freshness banner instead.
- `first_observed` is a bridge-local watermark: the first time this bridge saw
  this `(id, counter_token)`. It is seeded from the stored document at start-up,
  so a restart neither re-stamps an observation nor re-alerts on one.
- **The change test ignores `last_seen`.** The gateway re-stamps it on every
  ~5 s evaluation pass for every live advisory, so it moves on every poll while
  nothing has changed; comparing it would make each 300 s poll a write. Every
  other field still counts as a change — `first_seen`, `acked`, severity,
  classification, `counter_token`, `first_observed`, the gates, the counters and
  the reachability/source transition — and each write stores that poll's fresh
  `last_seen`.
- `alerted` is the health alert's dedupe watermark (D3): `{<id>|<counter_token>:
<epoch seconds>}` for every critical, unacknowledged advisory this bridge has
  already pushed, written by the loop in the same pass that decides the push and
  pruned to the current ring. See [Push notifications](#push-notifications-fcm).
- The advisory list mirrors the gateway's live ring exactly — an entry that
  leaves the ring disappears (no synthetic history), and an acknowledged entry
  stays listed while the gateway still holds it.

**Failure paths.** A non-2xx or unreachable poll projects
`{reachable: false, checked_at, source}` and writes it **only on the
transition**; a 404 (endpoint absent, an older gateway) or a 200 that is not the
notification contract records `source: "unsupported"`. The merge leaves the last
known gates/counters/advisories in place under `reachable: false` — a failed
poll never looks like an empty advisory ring.

**Cost.** One charger GET per poll: 288/day at 300 s, beside the status and
config polls. Firestore writes are the real changes only (zero in steady state)
plus one read of the stored document at process start.

### Claims reason (issue #159)

The gateway resolves every claim — manual pause, schedule, boost, limit, error,
solar divert, OCPP — itself, and firmware ≥ 4.1.5 answers the resolved
arbitration at `GET /claims/target`: which client currently wins `state`,
`charge_current` and `max_current`, plus the resolved target properties. That
answer is the **only** authoritative source for "why isn't it charging?"; the
bridge maps the winning client ids (`pi/claims.py`, treated as opaque names —
priorities are compile-time and version-dependent) onto a bounded vocabulary:

| `reason`          | Winning claim                                                        |
| ----------------- | -------------------------------------------------------------------- |
| `manual_override` | manual (65537) holds `state`                                         |
| `schedule`        | timer/schedule (65540) holds `state`                                 |
| `boost`           | boost (65539) holds `state`                                          |
| `current_limit`   | limit (65542) holds `state`, or holds `charge_current`/`max_current` |
| `safety`          | error (65543), shaper (65548) or temp_throttle (65549) holds `state` |
| `not_connected`   | no winner at all and the vehicle is known disconnected               |
| `unknown`         | no authoritative answer (see below), or an unmapped winner id        |
| `null`            | no restriction — charging/ready; the web hides the line              |

**Fail-closed.** When `/claims/target` is unavailable — firmware below 4.1.5
answers 404, the fetch can fail, the bridge may have just started — the derived
reason is `unknown`, and retained MQTT evidence **never** yields a confident
reason on its own: the retained `claim`/`limit`/`boost` documents carry no
authoritative freshness, so they are ingested as supporting evidence
(`ClaimsObservations`, the same locked-holder pattern as the health facts) that
enriches `detail` (boost type/value/remaining, limit type/value) and
corroborates, but structurally cannot move `reason`. The `schedule` reason's
active rule id is not retained evidence: it comes from the schedule loop's
`/schedule/plan` window, so the retained event list is not ingested at all. The
charger being offline is also `unknown`: the loop reads the tracker's online
fact beside its own fetch, so a stale arbitration never reads as current.

**Cadence.** The claims loop (`bridge.claims_loop`) has no polling interval of
its own — it is woken by a trigger the other loops set: every applied `/status`
observation (the reconcile tick, HTTP or heartbeat-forced), a `claims_version`
move in an observed `/status` reply, a `state`/`state_label` transition
arriving over either transport, or a charger-offline transition the status loop
landed (under MQTT that answers a stop — or an outage, once its
two-failed-reconcile landing fires — within the 5 s debounce plus one 1 s tick
instead of the 60 s reconcile / 300 s safety cadence — a trigger landing inside
the window is deferred to its close, never dropped for the reconcile). A 300 s
safety cadence refreshes the document even if no trigger ever fires. One `GET
/claims/target` per fetched tick, debounced ≥ 5 s.

**Document.** `status/claims`, merge writes only when the comparable content
changes (the change test drops the write stamps and the moving boost countdown,
so an identical answer, an unchanged response or an identical retained
redelivery costs **zero** writes — the same economy as
`status/notifications`):

```json
{
  "reachable": true,
  "checked_at": 1794870706,
  "source": "http",
  "reason": "manual_override",
  "winner_state": "manual",
  "winner_current": null,
  "detail": { "claim": { "state": "disabled", "charge_current": 32000 } },
  "updated_at": "<server timestamp>"
}
```

`winner_state`/`winner_current` name the gateway's winning clients in the
firmware's own words (`manual`, `timer`, `limit`, …); `detail` carries the
evidence for the reason — the retained documents for the claim/limit/boost
reasons, the schedule loop's active rule id for `schedule` (the key is absent
when none resolves); `checked_at` is the
observation that produced the last write, not a heartbeat. `reachable` is
endpoint reachability — whether this loop's own `GET /claims/target` answered —
not the tracker's charger-online verdict: a charger the tracker flags offline
whose endpoint still answers writes `reachable: true` beside
`reason: "unknown"` (the offline fact folds into the reason), and only a
failed fetch writes `reachable: false`. Failure transitions
write `{reachable: false, source: "http"|"unsupported", reason: "unknown"}` once
per transition and merge over the last known winners — a 404 (old firmware) or a
200 that is not the claims contract is `source: "unsupported"`. `status/claims`
is counted under its own `claims` write kind.

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
tests. Two simpler forms do not work. `merge=True` merges every leaf field path,
so nested maps deep-merge; it does **not** expand dots in keys (only `update()`
does), so a dotted `"hours.21"` key is stored as one literal field name rather
than a bucket. `update()` cannot create the document: it defaults to
`exists=True` and raises `NotFound` on the first write of a new day. The merge
list emits one write whose mask and transforms touch exactly `kwh`, that one
hour bucket and `updated_at`, so sibling hours and every other field in the
document survive. `Increment` on a missing field creates it, so no
read-before-write or transaction is needed. Elsewhere in these notes a stored
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
starts at the last stored reading instead of dropping the downtime energy. A transient `total_energy == 0` reading when `total_energy > 0` is ignored and logged without wiping the baseline or advancing the observation clock, so a reconnect spike cannot follow a false zero reset; a genuine non-zero drop (`0 < total < previous`, firmware reset) logs `total_energy reset; rebaselining history` and starts a new baseline without writing a negative delta. Upward steps are checked against `_interval_step_allowance(gap)` over the elapsed monotonic gap (`CLOCK_BOOTTIME`): implausible jumps are dropped, logged, and rebaselined without adding to the accumulator. A failed history write does not advance the in-memory
baseline: the same delta is retried on the next tick, and lands in the bucket
for the hour that retry happens in.

### Day reconciliation (issue #161)

Operator-facing: what a reconciliation warning means and how to investigate
one is in [../docs/RECONCILIATION.md](../docs/RECONCILIATION.md).

A read-only audit of that history: every `RECONCILE_INTERVAL` (3600 s;
`0` disables the loop) the bridge compares today's `history/<date>` total —
the document's `kwh` plus whatever the accumulator still holds pending for
the day, read together under the apply lock so a flush cannot land between
them — with the charger's own `total_day` meter from the latest applied
`/status` observation; once per local day the same loop compares the
month's documents against `total_month` (the next section). The firmware
(≥ 4.2.2; this charger runs 8.2.3)
reports both in kWh, full precision, reset at the charger-local day/month
boundary (the same `time_zone`) and kept
across reboots. A gateway older than 4.2.2 reports no period counters at
all: the reconciler logs one informational line and stays inactive.

The counters ride the temp1–temp3 pattern: `parse_status` keeps
`total_day`/`total_month` for this path only, and the apply boundary drops
them, so they never reach `status/current`. Samples are validated between
evaluations exactly like `total_energy` deltas: an upward step the charger
could not have delivered in the elapsed time is rejected and rebaselined
(and a rejected sample is never compared — a corrupt counter can neither
clear nor damn a day), while a drop from a trusted level is the counter's
own midnight rollover or a mid-day firmware reset, rebaselined and stamped
in memory; a drop measured from a rejected (corrupt) baseline rebaselines
without stamping — it proves nothing about when midnight fell.

A divergence beyond `max(0.2 kWh, 1% of the larger side)` is **one bounded
single-line journal entry per (day, episode)** naming both totals, the gap,
the likely outage window `[last clean evaluation → first divergent
observation]` (local), and that no history or session data was modified;
it re-arms only when the gap changes direction or grows by ≥ 1 kWh.
The floor covers one reconcile interval of the MQTT-mode feed gap: the charger
side advances only at the HTTP reconcile cadence (60 s) while the bridge
side advances from every applied snapshot, so up to a minute of delivering
power can sit on one side only (up to the 0.2 kWh floor at the charger's
ceiling — 48 A at the UK supply-band top of 253 V). The freshness window is
sized to that cover **by construction** — one feed interval, clamped to the
floor's coverage at ceiling power (`reconcile.covered_window_sec`, ~59 s) —
so the two cannot disagree at any configured cadence: a slower
`MQTT_RECONCILE_SEC` or `STATUS_INTERVAL` keeps the window at the clamp and
the evaluation waits for a fresh sample instead of warning about observation
skew, and the same holds when the feed skips or drops reconciles (a failed
HTTP poll, an MQTT-snapshot discard) and the latest sample ages past the
window.

Warnings need **warning authority** — evidence that both sides measure the
same period in the same time zone. The day comparison unlocks it only
after observing one `total_day` rollover within ±1 h of Pi-local midnight
(wall clock, either side; a clean pair of numbers alone proves less than
it appears to). Until then divergences are informational notes, never
warnings. Two observations say the opposite and are each journaled once,
distinctly, while they stand: a reset at the wrong hour (a time-zone or
period mismatch suspected) and a trusted sample pair that crosses local
midnight _without_ dropping — the counter is not measuring the Pi's day.
The latter also revokes a grant it contradicts. The probe is conservative:
if the counter's current value could have been delivered since midnight
(judged by the same step allowance that validates jumps), a
reset-and-rebuilt counter explains it just as well and nothing is
concluded — an overnight outage's recovery never reads as a mismatch.
Authority is in-memory only (the zero-write design persists nothing):
every restart — each deploy — drops it and the next observed midnight
rollover re-grants, so informational notes for up to ~24 h after a
deploy are expected, not a sign of degraded detection.

### Month reconciliation (issue #161)

Once per local day, the same loop compares the month: one documentId range
query over the month's `history/{date}` documents plus every month day's
still-pending energy (gathered under the same apply lock as the day read)
against `total_month` from a second guarded counter stream fed by the same
applied `/status` observations. The tolerance, the episode bounding, the
zero-writes guarantee and the freshness treatment are the day machinery
reused — the month sample is held to the same clamped window, and a
sample that predates the local month line (just past midnight on the 1st)
waits for a same-month sample instead of comparing October's counter
against November's archive. The month's warning authority is one clean
_day_ comparison: the day comparison proving the shared period semantics
and time-zone alignment is exactly what the month needs, since the month
counter rides the same observations and resets on the same local clock —
and the same non-reset evidence that revokes the day's grant revokes the
month's with it. The month counter's own non-reset — a `total_month` that
sails across the month line without dropping, a cumulative counter —
revokes the grant and withholds it: clean days prove the day's alignment,
not a cumulative counter's, so the month stays informational until that
counter is observed resetting at a month boundary.

A divergence near **1000×** at either period is not lost energy — it is a
Wh-scaled counter (a firmware variant or misconfiguration) — and is
rejected with its own bounded line naming both totals once the bridge
total reaches ~1 kWh; below that a ~1000× ratio is what an outage's
opening looks like (a whisker of observed energy against a charger that
delivered on its own schedule) and is warned like any divergence. Either
way it is never reconciled.

**Zero writes, ever.** Reconciliation reads and journals; it never
corrects, backfills or repairs anything. A divergence is evidence for a
human decision, not an automatic one.

### Charging sessions

The charger keeps `session_energy` (Wh) and `elapsed` cumulative for the whole
plug-in event and clears them only when the vehicle disconnects. A pause, a
scheduled-window end, or a manual stop ends the charging _state_ but not the
session. The bridge therefore treats a session as one plug-in event and writes
one document:

```
sessions/1792345678   { started_at, ended_at, wh, elapsed, intervals? }
```

`wh` is the charger's `session_energy` — unless the bridge saw the counter go
backwards inside a charging block, when that cumulative covers only the last
epoch and `wh` becomes the accumulated per-tick deltas across every epoch
(#195), the same observation basis as `intervals`. `elapsed` is seconds.
`ended_at` is the stop time and `started_at` comes from the charger's own timer
(`ended_at - elapsed`), never from when the bridge booted.

`intervals` records **when** that energy was actually drawn: one entry per
contiguous charging block, `{started_at, ended_at, wh}`, in start order. The
bridge opens an interval when it first sees `state: 3`, adds each charging
tick's `session_energy` growth to it, and closes it when the state leaves 3 (or
at finalisation). The bounds are observation times — the charger's transition
happened between two polls, so an interval starts at the first tick that saw it
rather than at the aggregate's charger-timer start (and a wall-clock step that
inverts the pair makes the close the observed open plus the measured span, see
below). The web app prices each interval over its own start and end, which is
what makes a paused session accurate.

**What the intervals are guaranteed to account for.** In a session the bridge
observed end to end with no counter reset, the intervals add up to `wh` except
for the session's first charging tick, which only supplies the baseline (so up
to one poll of energy can be missing — ~0.03 kWh at the charger's ceiling). The
equality is _not_ universal:

- a **restart mid-charge** leaves the energy drawn before it in the aggregate
  and in no interval (the seeded baseline starts the new interval at zero);
- an **in-block counter reset** is accumulated into `wh` (#195): once the
  bridge sees the counter go backwards inside a block, `wh` becomes the sum of
  every epoch's observed per-tick deltas — the same basis as the interval
  list — because the charger's own cumulative then covers only the last epoch
  (records written before #195 still carry the last epoch's cumulative, so
  their list can exceed it). One corner diverges: a reset that lands exactly
  on 0 and stops the charge, with the same plug-in resuming at the cleared 0,
  restarts the accumulation — that boundary is indistinguishable from a new
  plug-in — so the merged record's list exceeds `wh` by the smaller side's
  energy (whichever epoch drew less) and the web prices the aggregate: a
  bounded undercount, never an overcount;
- a **dropped implausible step** stays in the charger's cumulative: `wh` keeps
  it in a plain plug-in while the list goes short, and in a reset-seen plug-in
  `wh` drops it too — keeping the interval basis;
- a **wall-clock step** with no measured span (below) leaves that interval's
  energy in `wh` and in no interval.

**No interval is fabricated.** Its bounds are wall-clock times the bridge
observed, and when a step inverts them the duration comes from a measurement:
the bridge stamps `CLOCK_BOOTTIME` when it opens an interval, beside the
wall-clock `started_at`. When the wall clock steps backwards between open and
close (an NTP correction, a manual set), the pair's endpoints would invert, so
the duration is taken from that measurement and only the absolute wall-clock
anchor is inferred (`ended_at = started_at + measured`) — the interval is kept
and the derivation is logged. The anchor is the pre-step open, so a derived end
can land after the session's own aggregate `ended_at`, which is recorded on the
corrected clock. A step that does not invert the pair takes no derivation: both
bounds stay the observed wall-clock times, so that interval's stored span is off
by the step (a backwards step shortens it) with no line logged. When the
interval clock measured nothing across an inverted interval (a frozen or
too-coarse reading), there is no duration to anchor the pair to: nothing is
written, and the energy stays in `wh` like any other unmeasured part of the
session. The stored shape stays `{started_at, ended_at, wh}` either way.

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
  baseline. The plug-in's accumulated total keeps the epochs before the reset
  (#195), so the finalized `wh` sums every epoch while the charger's own
  cumulative restarts. A drop at a block boundary instead restarts the
  accumulation — indistinguishable from a new plug-in's cleared counter, it
  must never span two plug-ins.
- `interval step dropped: <Δ> Wh in <gap> exceeds the <n> Wh the charger could
deliver` — the step is physically impossible. The energy stays in the
  charger's cumulative and the interval stays short; in a reset-seen plug-in
  `wh` drops it too, keeping the interval basis.
- `interval span derived: wall clock moved back <step>s; <duration>s measured on
CLOCK_BOOTTIME (<wh> Wh)` — the wall clock was corrected backwards while the
  interval was open. The interval is kept with the measured boottime span as its
  duration; only its wall-clock anchor is re-derived. This is a clock incident,
  not bad data: no entry is dropped.
- `interval dropped: wall clock stepped backwards and no measured span (<wh> Wh)`
  — the same step, but the interval clock measured nothing to re-anchor the pair
  with. Nothing is written for that interval; its energy stays in the aggregate.

A stored interval carries no boottime sample (the document shape has no room for
one), so a reversed pair read back from Firestore cannot be re-anchored: the
merge path still drops it and says so on the unusable-entry line below. The
derivation only happens when the bridge closes an interval itself.

A cap fold is logged too, naming the session, how many intervals it folded and
how many it kept: `session <label>: <n> oldest intervals folded into
<start>–<end> (<wh> Wh); <m> kept`. Nothing is lost to a fold — `<wh>` is the
sum of the folded intervals. Only unusable entries are dropped, and they have
their own line: `session <label>: <n> unusable interval(s) dropped`.

Because of those cases the web app does not trust the list blindly: it
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

`status/current` also carries `elapsed` and `pilot` (amps). The per-sensor
temperatures no longer reach it (#159): they are parsed from the live
`/status` reply for the health gate only.

### Maintenance: repairing legacy session energy

`pi/repair_session_wh.py` is the one-time, owner-run repair for the
pre-#195 documents above: sessions whose `wh` carries only the last counter
epoch's cumulative while their interval list is energy-complete (live
examples: 15956 Wh against a list summing 48038). The web's guard refuses to
price such a list — the session falls back to pro-rating a bounded
undercount — so the repair sets `wh` to the interval sum. Run it when that
pre-#195 population shows up (the undercount shows as the coverage
disclosure or `intervals-short`-style pricing); documents written since #195
never need it — and the tool enforces that charter itself: it repairs only
sessions whose `ended_at` is **strictly before** `--before`, which defaults
to `2026-11-20T18:41:52Z`, the instant the Pi restarted onto the #195
bridge. Sessions with no parseable `ended_at` (live ones included) and
sessions closed at or after the bound are skipped as `after-bound` and
never written.

```bash
# Always dry-run first (the default) and read the table it prints.
pi/.venv/bin/python pi/repair_session_wh.py
# Then write — only the wh field of the documents the criteria select.
pi/.venv/bin/python pi/repair_session_wh.py --apply
# Narrow the era further if wanted: --before takes any ISO-8601 instant
# (a malformed one is a usage error, exit 2, before anything is read).
pi/.venv/bin/python pi/repair_session_wh.py --before 2026-11-18T00:00:00Z
```

A document is repaired exactly when: `wh` is a finite number ≥ 0,
`intervals` is a non-empty list, every entry is usable (finite positive
`wh`, both endpoints parseable, start < end),
`sum(intervals) > wh + max(250 Wh, 2%·wh)` — the same tolerance the web's
guard uses, so a repaired document reconciles by construction — and its
`ended_at` is strictly before the era bound. Everything else is classified
for the report and left alone: `reconcile` (already within the band),
`after-bound` (not strictly before the bound — live sessions, malformed
`ended_at`, and every post-#195 close), `intervals-short` (a restart left
energy in the aggregate and in no interval — `wh` is the better figure),
`no-intervals`, `unusable-intervals` and `bad-wh`. The decision is pure
logic (`pi/session_wh_repair.py`, unit-tested), the tool writes no Firestore
field but `wh`, and it is idempotent: once `wh` equals the interval sum the
document reconciles, so a rerun writes nothing.

**Why the bound.** The criteria alone cannot tell a pre-#195 undercount from
the post-#195 "reset-to-exactly-0" resume corner
([../ARCHITECTURE.md](../ARCHITECTURE.md) §4): there the interval list
legitimately exceeds `wh` — a bounded undercount, never an overcount, and
`wh` is the better figure — and repairing it would write a double-counting
sum the web guard would then happily price. The bound is the **second
fence, not the only one**: sessions closed by the post-fix bridge reconcile
by construction and are never repairable anyway. Same-day pre-fix closes
before the restart instant remain eligible.

It refuses `--apply` without a service-account key, printing the expected
paths (`GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT` from
`private/bridge.env`, or `private/service-account.json`). It also refuses
to run at all — dry-run included, exit 1 — when
`GOOGLE_APPLICATION_CREDENTIALS` and the bridge's
`FIREBASE_SERVICE_ACCOUNT` both resolve to keys whose `project_id`s differ:
both key paths and both projects are printed with the remedy (unset
`GOOGLE_APPLICATION_CREDENTIALS` or point it at the bridge key). A stale
deploy variable — the exact workflow
[../docs/DEPLOY.md](../docs/DEPLOY.md) documents — would otherwise silently
win the precedence and retarget the tool to another project's `sessions`;
this is the deploy guard's own cross-check
(`scripts/check-firebase-project.mjs`).

### Maintenance: verifying the month documentId range

`pi/smoke_month_range.py` is the read-only live check of the documentId
range query `_month_totals` runs every tick (#161, #208): per month it
compares the range's documents against an independent client-side scan of
`history`, spot-checks both bounds on the month's first-day document, and
asserts `bridge._month_totals` itself returns the control's sum. Its only
Firestore calls are `stream()` reads — the source contains no write call at
all — and it refuses to run when `GOOGLE_APPLICATION_CREDENTIALS` and the
bridge's `FIREBASE_SERVICE_ACCOUNT` name different projects (the deploy
guard's cross-check again). The owner runs it on the Pi, plain — no
worktree dance needed:

```bash
GOOGLE_APPLICATION_CREDENTIALS=private/service-account.json pi/.venv/bin/python pi/smoke_month_range.py
# Specific months (repeatable; default is the current and previous month):
pi/.venv/bin/python pi/smoke_month_range.py --month 2026-10 --month 2026-11
```

Finding (2026-11-21, project `chelevse`): the string-bound form merged in
#207 is rejected by production Firestore (`InvalidArgument: __key__ filter
value must be a Key`); `DocumentReference` bounds are the documented
requirement (googleapis/python-firestore#153) and returned exactly the
month's documents — the form `_month_totals` has used since. Exit 0 is the
green verdict; the `SMOKE PASS/FAIL` summary line is the evidence to quote.

### Push notifications (FCM)

A single background daemon worker performs every send via the Admin SDK. Three
sources queue a push, and only three (#158, D9):

| Event                                                                                                       | Body                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A newly observed advisory the firmware rated `critical`, unacknowledged, not yet alerted (one per advisory) | `Charger health: No ground recorded — see Health. Not a live fault.` / `Charger health: No ground active now — see Health.` |
| Charger stops answering (first failed poll of an outage)                                                    | `Charger offline`                                                                                                           |
| Watchdog restarts a gateway / controller                                                                    | `Charger gateway unresponsive — restart attempted` / `Charger controller unresponsive — restart attempted`                  |
| Restart attempted and the charger is still down (or allowance spent)                                        | `Recovery failed — power cycle may be required`                                                                             |
| Unhealthy but a guard blocked the restart                                                                   | `Charger unresponsive — restart blocked (…)` (names the guard; charging names `WATCHDOG_RESTART_WHILE_CHARGING`)            |
| Charger answers again after an unhealthy episode                                                            | `Charger recovered`                                                                                                         |

The title is always `ChelEVSE`.

**What no longer pushes.** A charge start or stop is a `status/current` write and
a `sessions/*` record, not a notification. The two `Charging started` /
`Charging stopped` bodies are gone; the health alert below replaced them.

**The health alert's copy.** The body names the advisory with the same rule names
the web Health card uses (`pi/health.py` mirrors `web/js/health.js`; the two
runtimes share no module, and the table is the firmware's bounded 15-id set). The
wording follows the classification, never the severity alone: a
counter-derived advisory keeps the firmware's `critical` rating after the
condition cleared, so it reads _recorded — Not a live fault_, and only a
corroborated entry reads _active now_. Nothing in the body infers safety, and
anything the firmware rated below `critical` never pushes.

**The watermark (D3).** The dedupe key is `(id, counter_token)`, rendered as one
map key — `fault.no_ground|7` — where the token is the controller counter for
`fault.*` and the counter-backed `wear.*` rules, the settings word for
`safety.*`, the severity step for `wear.relay_life`, the `$GL` level for
`thermal.relay_thermal`, and `first_seen` for everything else. The map lives in
`status/notifications.alerted` as `{<key>: <epoch seconds>}` and is written by
the health loop's **own projection write**, in the same pass that decides the
push: the body is enqueued only after that write landed, so a repeat poll or a
failed write cannot push twice for one advisory — the watermark makes a repeat
impossible whenever both the decision and the write complete. Delivery is at most
once, and the loss side stays open: a crash between the write and the enqueue, or
a full notifier queue, can drop that one alert (it can never duplicate it). On
start-up the loop seeds the map from the stored document **before** its first
poll, so a restart whose seed read succeeds sends nothing; a failed seed read
starts from an empty watermark, so that restart re-alerts each live critical
advisory once. A key is pruned when its advisory leaves the live ring, so on a
pass that keys every entry the map stays bounded by the ring (the firmware's 15
ids). An advisory whose token has not been observed yet — no applied `/status`
counters, say — has no key to compare: that pass pushes nothing and leaves the
map whole, and the first pass with the facts decides once, on the real key. A
new trip moves the controller counter — which also voids the firmware's own ack
— so the key changes and the same advisory alerts again; an acknowledged
advisory never alerts.

`charger offline` / `charger online` are journaled only on their edges, and the
offline reason includes the HTTP status (401/403/5xx) or transport exception so
auth failures are distinguishable from an unreachable charger. Watchdog pushes
follow the same edge-only rule — see [Watchdog](#watchdog-charger-health); the
first tick after a start with no seeded state only establishes state and never
notifies, while a state seeded from `status/current` is a real baseline, so a
change that happened while the bridge was down notifies once.

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
schedule/current   { enabled: bool, rules: [{id, days: [0-6], start, end}] }
```

`days` uses **0 = Monday … 6 = Sunday**. `start`/`end` are `HH:MM` (24-hour);
`end < start` means the window wraps past midnight. Every `SCHEDULE_INTERVAL`
seconds the bridge normalizes the doc and mirrors it into the charger's own
scheduler, so windows keep being enforced by the charger even while the Pi is
down.

- **Validation.** A rule is used only when it has a non-empty string `id`, a
  non-empty `days` list of integers 0–6, `start`/`end` that are exactly `HH:MM`
  as 24-hour ASCII digits matched against the whole string (no trailing
  newline, no non-ASCII digits), and `start != end`. Malformed
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
- **Window status.** Every tick reads `GET /schedule/plan` and feeds exactly
  `schedule: {in_window, active_rule_id}` into the write policy — it is
  published only when it changes (issue #95): a change arms the
  schedule-window trigger and the new value rides the status write that
  trigger causes (same write, never a follow-up), subject to the 30 s rate
  limit like any discrete trigger; an unchanged window costs zero writes.
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
- **No per-event current.** Schedule events are `{id, state, time, days}` and
  charge at the EVSE's configured limit. Legacy stored `amps`, `feature`, and
  `feature_value` fields remain readable but are ignored and removed by the
  next editor save.

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

| `type`             | Charger request                                                          | Meaning                                                                             |
| ------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `pause`            | `POST /override` `{"state":"disabled"}`                                  | Stop charging                                                                       |
| `resume`           | `DELETE /override`                                                       | Clear the manual override; the firmware scheduler/auto resumes                      |
| `set_current`      | `POST /override` `{"state":"active","charge_current":N,"max_current":N}` | Hold at `N` amps, only after `/config` verifies `N` is 6 through `max_current_soft` |
| `rapi`             | `POST /rapi` form body `rapi=<command>&json=1`                           | Advanced escape hatch for any RAPI command                                          |
| `ack_notification` | `POST /notifications/ack?id=<notification_id>`                           | Acknowledge one charger-health advisory (HTTP only — see below)                     |

`rapi.command` must be a string starting with `$` and at most 32 characters;
anything else is marked `failed` with `error: "invalid rapi"` without contacting
the charger. On a 2xx reply the document becomes `acked` and gets
`result: <ret>` (the reply's `ret` field; the raw body if it is not JSON, `null`
if absent). Non-2xx replies and request errors are marked `failed` with a short
reason containing the HTTP status/body snippet or the exception class. Unknown
`type` values fail with `unsupported type`.

### Acknowledging a health advisory

`ack_notification` carries one `notification_id` — a firmware rule name such as
`fault.no_ground` — validated against `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$` with a
64-character cap. Anything else fails with `error: "invalid notification id"`
before any request is sent (and with no `transport`, since nothing was). The
same grammar and cap are enforced by `firestore.rules`, so a doc the bridge
would refuse cannot be created.

It is **HTTP-only, deliberately** (D4): the gateway publishes no per-advisory
MQTT surface — only the `{count, severity}` rollup on `<base>/notifications` —
so there is nothing to publish. `apply_command` routes it to the HTTP path
before the MQTT-ready check, even when the broker is connected and subscribed,
and there is no MQTT arm to fall back from.

Success is **2xx only**; the firmware's answers are mapped to plain reasons:

| Charger reply | Command outcome                                                       |
| ------------- | --------------------------------------------------------------------- |
| `2xx`         | `acked` (`transport: "http"`) and the Firestore acknowledgement below |
| `404`         | `failed`, `error: "no such active notification"` (not currently live) |
| `400`         | `failed`, `error: "id required"`                                      |
| `403`/`405`   | `failed`, `error: "acknowledgement refused by the charger (HTTP …)"`  |
| other non-2xx | `failed` with `HTTP <status>: <body snippet>`                         |

On a 2xx the bridge merges `acks: {<notification_id>: <epoch seconds>}` into
`status/notifications` with `set(..., merge=True)` — a **nested map merge**, and
the only field family the command writes there. The health loop's own merges
project their content fields (`reachable`, `source`, `gates`, `counters`,
`advisories`, `alerted`, `ack_command`) and never `acks`, so a poll can neither
clobber an acknowledgement nor be clobbered by one, and no read-modify-write of
the `advisories` list is needed. `ack_command` is a bridge-build capability
fact, not an observation: `true` on every projection this bridge writes, absent
on documents written by an older bridge that cannot acknowledge over HTTP, so
the web's ack control will gate on `=== true` (fail closed; that gate lands
with PR-4). The map is bounded by the firmware's 15 advisory ids, so it is
never pruned. The write is counted as `health` (no new kind).

**Ordering: charger → Firestore → command doc.** The acknowledgement is written
_before_ the command document is settled, so a charger 2xx that cannot reach
Firestore still settles `acked` (the charger really did acknowledge it) and the
next 300 s health poll repairs the visible state from the gateway's own `acked`
flag. A failed or 404 ack writes nothing at all, so the previous state stays
intact. The settled-command retry memory is unchanged: it retries the command
document's status write, never the acknowledgement.

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
configured maximum. The clamp (`pilot` == the `/status` `max_current`) is
defensive-only: a hold above the `/config` soft maximum is now rejected before
any send, so only a `/status.max_current` below that soft limit (firmware
derating) can reach it. A retained document that is
`"active"` but names no current confirms nothing — it cannot distinguish an
applied hold from a lost publish — and falls through to the `/status`
reconcile. A timeout does **not** re-apply the command: the
bridge reads `/status` once (read-only) and accepts it if the status already
reflects the target state, otherwise marks it `failed` with
`no confirmation within 5s (…)`.

That same `254` pair sets the published label: `parse_status` derives
`state_label: "stopped"` for `254` with `manual_override: 1` and `"sleeping"`
for the same `254` otherwise, so a user Stop reads **Stopped** on the Status
screen instead of **Sleeping**. `manual_override` stays a raw `/status` field —
it is not added to `status/current`; the label is the only derived value.

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
before anything was sent (validation, unsupported type, stale, a failed
`/config` read) records no transport. The journal logs
`command transport: <transport> (…)` when the path changes. Validation (verified `/config` soft/hard limits, RAPI `$` and ≤32 characters) and the 10-minute
staleness rule are unchanged, and `status` lifecycle is unchanged; the error
copy gains one pre-send case, a failed `/config` read settling as
`charger config read failed (<exception>)` with no transport.

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

The write counter's hourly `firestore writes: N in 24h (…)` summary, the
`write budget warning:` tripwire at 50 % of the quota, and the
`firestore write quota exceeded` line all land here (see
[Write budget and counter](#write-budget-and-counter-issue-96)).

## Uninstall

```bash
sudo systemctl disable --now chelevse-bridge
sudo rm /etc/systemd/system/chelevse-bridge.service
sudo systemctl daemon-reload
sudo rm -rf /opt/chelevse
```
