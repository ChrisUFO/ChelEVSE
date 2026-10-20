# ChelEVSE Architecture

## Goals

- Move OpenEVSE charger status and basic control off the home LAN and onto the phone, reliably.
- Nothing complex: no backend server, no cloud broker, no inbound connections to the house, minimal moving parts. The LAN-leg broker (Mosquitto on the Pi) is part of the trusted home network, not a public service.

## Topology

```
┌────────────────┐  LAN HTTP     ┌───────────────┐  outbound HTTPS ┌────────────────────────┐
│ OpenEVSE       │◄─────────────►│ Raspberry Pi  │────────────────►│ Firebase               │
│ (WiFi module)  │  LAN MQTT     │ mosquitto +   │  status writes / │ Firestore (data)       │
│                │◄─────────────►│ bridge agent  │  command watch   │ Hosting (PWA)          │
└────────────────┘   status      └───────────────┘                  └───────────┬────────────┘
                                                                               │ HTTPS
                                                                    ┌──────────▼───────────┐
                                                                    │ Android phone (PWA)  │
                                                                    │ Firebase Auth sign-in│
                                                                    └──────────────────────┘
```

The only publicly reachable component is Firebase. The Pi accepts no inbound connection from outside the LAN (the MQTT listener is LAN-only and authenticated), and there is no self-run server anywhere.

## Components

### 1. Bridge agent — `pi/`

Python 3 service on the Raspberry Pi, run under systemd (`Restart=always`). Authenticates to Firebase with a **service-account key** (Admin SDK — bypasses security rules by design, so the key lives in gitignored `private/`).

Four loops:

| Loop     | Interval                                                | Action                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | 10 s (HTTP) / 60 s reconciliation while MQTT is healthy | HTTP: `GET http://<charger>/status` → write curated fields to `status/current`; MQTT: subscribed status topics → the same write path; maintain `history/<date>` from `total_energy` deltas; finalize one `sessions/*` doc per plug-in session |
| Config   | 60 s (HTTP) / on `config_version` change under MQTT     | `GET /config` → write `status/config` with credential fields redacted                                                                                                                                                                         |
| Schedule | on change + 60 s, reconcile every 300 s                 | Sync `schedule/current` → firmware `POST /schedule` (one event per request; each rule becomes a window-start `active` event and a window-end `disabled` event). Poll `GET /schedule/plan` → `status.current.schedule`                         |
| Commands | 5 s poll                                                | New pending doc in `commands` → apply to the charger (MQTT `override/set` / `rapi/in` while the broker is ready, else HTTP) → mark acked / failed with the `transport` used (stale pending docs are failed without contacting the charger)    |

Both status transports feed **one** `parse_status` → `apply_status` path, so an MQTT snapshot gets the same unit conversion (milliamps → amps, 10ths of °C → °C), the same curated field set, and the same history, session and transition logic as an HTTP reply — once per real change. An MQTT snapshot only runs the state machine once it is complete (the source holds a `/status` seed and the snapshot carries a `state`), and a reconcile reply older than an MQTT apply is discarded rather than allowed to rewind the tracker. MQTT is opt-in (`MQTT_ENABLED=false` by default) and HTTP remains the fallback, the reconciler and the transport for `/config`, `/schedule/plan` and OTA. See [pi/README.md](pi/README.md#mqtt-status-source-issue-44).

**Commands** are MQTT-first too (issue #46) once the broker is connected **and** the `<topic>/#` subscription is granted: pause/resume/set-current publish the firmware's `override/set` payload (`{"state":"disabled"}`, `clear`, `{"state":"active","charge_current":N,"max_current":N}`) and confirm against the retained `override` document (falling back to the status `manual_override` plus a non-charging `state`/`pilot` field) within 5 s; RAPI publishes `rapi/in/<command>` with its parameters as the payload and matches the first `rapi/out` after its publish (`$OK` → acked, `$NK` → failed), serialised because replies carry no correlation id, with a short quarantine retiring the reply of a timed-out transaction. HTTP is used only when MQTT is not ready _before_ a publish (or the client refuses it), with unchanged validation, staleness and lifecycle. A published command is never re-applied over HTTP: a lost acknowledgement is reconciled read-only from `/status` or the command fails. Every command document records the transport that carried the request (`transport: "mqtt"|"http"`), and none when it was rejected before a send. See [pi/README.md](pi/README.md#commands-over-mqtt-issue-46).

The status loop also emits **FCM push notifications** on transitions — charging started, charging stopped, charger offline — sent by a background worker to every registered `fcmTokens` doc via the Admin SDK (invalid tokens are pruned on send error).

Config via environment file in `private/`: `CHARGER_HOST`, `FIREBASE_SERVICE_ACCOUNT` (path to key), optional intervals.

Failure handling: connection errors (charger or Firebase) are logged and retried at the loop's fixed poll interval; writes that fail are retried on the next tick; nothing crashes the service.

**Recovery flow (watchdog, issues #39/#45).** After `WATCHDOG_FAILURES` consecutive failed `/status` polls the bridge makes one extra probe and, if a transport can carry a restart, issues it once:

1. **Probe/classify.** A usable `/status` reply means HTTP can restart the gateway; the last two replies also classify the domain (`rapi_connected`/`evse_connected`, or a frozen `comm_success` while `comm_sent` rises, is controller-side). Those counters are HTTP-only, so MQTT never classifies.
2. **Choose the transport.** HTTP answering → `POST /restart`. HTTP unreachable but MQTT connected, subscribed **and** not Last-Will-disconnected → publish `{"device": "gateway"|"evse"}` on `<topic>/restart` (QoS 0) and do not also post. Neither → alert only (`Recovery failed — power cycle may be required`), because a device that is gone from both paths cannot be revived remotely.
3. **Guards.** Charging guard, cooldown and hourly cap are transport-independent and never publish; one push per unhealthy episode; the next successful probe (the 60 s reconcile while MQTT carries status) clears the state, recording `last_action`, `last_transport` and `last_result` in `status/health`.

The broker's announce topic (`openevse/announce/#`, the firmware's retained `{"state": …}` plus its Last Will) is the availability input: a `disconnected` announcement flips `status/health.mqtt_connected` to `false`, sends status back to the 10 s HTTP poll and makes an HTTP outage alert-only within one tick; a reconnect's `connected` announcement clears it.

### 2. Firebase — Firestore + Hosting

**Firestore data model (v1):**

| Path                | Writer                                  | Readers               | Content                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status/current`    | bridge (admin)                          | verified, allowlisted | Curated `/status` fields: `{state, state_label, amp, voltage, power, session_energy (Wh), total_energy (kWh), elapsed (s), vehicle, temp1–temp3, temp_c, pilot, charger_online, schedule: {in_window, active_rule_id}, updated_at}`          |
| `status/config`     | bridge (admin)                          | verified, allowlisted | Charger `/config` snapshot (firmware, hostname, service level, limits, integration settings) with credential fields redacted to `"***"`; refreshed ~60 s (or on a `config_version` change with MQTT)                                         |
| `status/health`     | bridge (admin)                          | verified, allowlisted | Watchdog state (`healthy`/`unhealthy`, reason, `http_ok`, `controller_ok`, attempt history, `last_transport`) plus the transport view (`source`, `mqtt_connected`, `mqtt_announced`, `mqtt_last_lwt_at`) with merge writes from both writers |
| `history/{date}`    | bridge (admin)                          | verified, allowlisted | `{kwh}` per local day, derived from `total_energy` deltas                                                                                                                                                                                    |
| `sessions/{id}`     | bridge (admin)                          | verified, allowlisted | One record per completed plug-in session (merged across pause/resume): `{started_at, ended_at, wh, elapsed}`                                                                                                                                 |
| `schedule/current`  | app (write), bridge (syncs to firmware) | allowlisted users     | Owner-defined charge schedule: `{enabled, rules: [{id, days [0–6 Mon=0], start "HH:MM", end "HH:MM", amps}]}`; `end < start` wraps past midnight; bridge mirrors it into the firmware scheduler                                              |
| `settings/current`  | app (write)                             | allowlisted users     | App settings: `{rate ($/kWh), currency}` — used client-side for cost display                                                                                                                                                                 |
| `fcmTokens/{token}` | app (create own)                        | —                     | Push registration: `{uid, created_at}`; the bridge sends FCM notifications to these tokens                                                                                                                                                   |
| `users/{uid}`       | acl sync (admin)                        | that user (own doc)   | Access grant: `{allowed: bool, email}` — synced from `private/acl.txt` by `pi/acl.py`                                                                                                                                                        |
| `commands/{id}`     | app (create), bridge (ack/fail)         | verified, allowlisted | `{type: pause\|resume\|set_current\|rapi, amps?, command?, created_at, status: pending\|acked\|failed}` plus `transport: "mqtt"\|"http"` naming the path that carried the request whenever one was sent; pending older than 10 min is failed |

Commands are typed whitelist entries; `rapi` is the explicit advanced escape hatch (string-validated in rules) for anything the curated types don't cover. Security rules enforce: only verified, allowlisted users can read (each user may read their own grant doc); only whitelisted command types with validated `amps`/`command` on create; status/history writes and command mutations are admin-only. `settings/current` is shape-validated in rules. `schedule/current` is container-validated in rules (exact keys, types, max 20 rules) because per-element validation exceeds Firestore's 1000-expression limit; each rule's shape is re-validated by the bridge, which skips and logs malformed rules (the app validates every rule before writing). Overlapping or touching windows are also skipped by the bridge, because the firmware resolves equal-time events by list order. See `firestore.rules`.

**Hosting** serves the static PWA from `web/` on a free HTTPS domain, with an SPA rewrite to `index.html`, `no-cache` headers (`index.html`, `sw.js` and `firebase-config.js` must never be served stale) and `Cross-Origin-Opener-Policy: same-origin-allow-popups` for the popup sign-in.

**Deployed pieces:** `firestore.rules`, `firestore.indexes.json` and `web/`. The single composite index (`commands` by `type` then `created_at` desc) backs the Advanced console's scrollback; the command poll and the status screen's recent-command window use single-field queries and need no index. An index that is still building fails the console query with `failed-precondition` until Firestore reports it ready.

### 3. Android app — PWA (`web/`)

Static HTML/JS using the Firebase Web SDK, installable to the Android home screen (manifest + service worker). Signs in with **Google** (Firebase Auth popup/redirect) — accounts without an allowlist grant see a clear "no access" screen and a sign-out control — and gets **realtime** updates via `onSnapshot`. Screens:

- **Status** — everything the charger reports: state, live current/power/voltage, session energy + cost (rate × energy) + charging time, lifetime total, per-sensor temperatures, pilot (setpoint); charge-mode control — **stop / auto / hold** (`pause` = stop, `resume` = clear override → auto, `set_current` = hold at a new setpoint) — and the device name from config as the header.
- **History** — daily kWh bar chart (last 30 days, hand-rolled SVG — no chart library) fed by `history/{date}`, plus a recent-sessions list from `sessions`; both show costs at the current rate.
- **Schedule** — edit the charge schedule (enable toggle; rules with days, start/end, amps), with a live indicator when a window is currently active (from `status/current.schedule`).
- **Config** — every configuration item the charger exposes (credential fields show `"***"` because the bridge redacts them), read from `status/config` and presented in our own layout; changes go through the Advanced console. Also **App settings**: electricity rate ($/kWh + currency, stored in `settings/current`) and an enable-notifications control (registers the device for FCM push).
- **Advanced** — RAPI console (`$` commands via the `rapi` command type) for full configuration parity with the built-in UI, behind a per-visit confirmation gate since RAPI can alter safety-relevant settings, with a 20-entry scrollback showing each command's acked/failed result.

**Push delivery** uses a plain service worker (`web/sw.js`) with no Firebase SDK: FCM sends a notification-only message, the worker receives a raw `push` event, and it either shows the system notification (title `ChelEVSE`, tag `chelevse-state`) or, when a page is visible, posts a `chelevse-push` message so the app shows exactly one in-app toast. The page dedupes that message against the SDK's defensive `onMessage` inside a 5 s window (with no Firebase-managed worker, `onMessage` never fires in practice). A notification click focuses an existing app window or opens the app URL — same-origin targets only. When the browser rotates the push subscription (`pushsubscriptionchange`), the worker asks open pages to re-acquire and re-save their token; the next app load does the same, so a rotated token recovers without user action. The bridge prunes tokens FCM reports as unregistered/invalid; sign-out and a revoked grant release this device's token document.

The Firestore contract is the API — a native Android app can be added later without touching the bridge, and the push payloads already carry everything a notification needs.

## OpenEVSE integration

The charger's official WiFi module (ESP32 firmware) exposes a local JSON/HTTP API:

| Purpose                                                                              | Endpoint                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Status (`state`, `amp`, `power`, `session_energy` Wh, `total_energy` kWh, `temp1–3`) | `GET /status`                                                            |
| Config                                                                               | `GET /config`                                                            |
| Set max current                                                                      | `POST /override` `{"state":"active","charge_current":N,"max_current":N}` |
| Pause / stop                                                                         | `POST /override` `{"state":"disabled"}`                                  |
| Return to auto (clear override)                                                      | `DELETE /override`                                                       |
| Hold at setpoint / force charge                                                      | `POST /override` `{"state":"active"}`                                    |

Plain HTTP on the trusted home LAN (HTTP Basic auth if an admin password is set on the charger). The API is small enough that the bridge can use a plain HTTP client; [`openevsehttp`](https://github.com/firstof9/python-openevse-http) — the library behind the Home Assistant integration — is the fuller-featured option: actively maintained, async, requires Python ≥ 3.13 on the Pi. The firmware also offers a WebSocket (`GET /ws`) with JSON deltas; v1 polls instead for simplicity.

**HTTP polling vs MQTT**: status is MQTT-first when `MQTT_ENABLED=true` — the
firmware publishes one topic per value as its EVSE poll changes, so Firestore
updates arrive in seconds and the HTTP `/status` poll drops to a 60 s
reconciliation. Commands use the same transport when it is ready: `override/set`
for pause/resume/set-current and `rapi/in`/`rapi/out` for RAPI, acknowledged by
the charger's own retained `override` document or RAPI reply. HTTP stays
authoritative for `/config` (redaction/coercion in one place),
`/schedule/plan` (the firmware computes the plan), OTA, commissioning
and the controller counters (`comm_sent`/`comm_success`/`rapi_connected`) that
the watchdog reads from the HTTP reply and that MQTT does not publish (they stay
out of `status/current`) — and it remains the fallback for status and commands
and the rollback. The broker (Mosquitto) runs on the Pi: LAN-only, authenticated,
no cloud dependency, and a flag flip back to polling.

## Security

- Public repo, private values: `private/` (service-account key, env) and `web/firebase-config.js` are gitignored; `private.example/` and `web/firebase-config.example.js` are the committed templates. (Firebase web config values aren't secrets — access is enforced by Auth + rules — but they stay out of the public repo anyway.)
- AuthN: Firebase Auth with **Google Sign-In**. Anyone can authenticate; data access is allowlisted.
- AuthZ: Firestore rules require a `users/{uid}` doc with `allowed == true` (and a verified email). The allowlist lives in gitignored `private/acl.txt` (one email per line) and is synced to those grant docs by `pi/acl.py` using the bridge's Admin credentials — personal emails stay out of the public repo, and grants change without redeploying rules. Each person must have signed in once before they can be granted (their auth user must exist to resolve the uid).
- Command creates are schema-validated; only the bridge's admin credentials write status/history or mutate commands. `settings/current` and `schedule/current` are the client-writable data docs (allowlisted users): `settings/current` is shape-validated in rules, while `schedule/current` is container-validated in rules (exact keys, types, max 20 rules) because per-element validation exceeds Firestore's 1000-expression limit — each rule's shape is re-validated by the bridge, which skips and logs malformed rules; the app validates every rule before writing. `fcmTokens` docs are own-token-only.
- HTTPS everywhere (Firebase domains + outbound-only from the Pi).
- No router port forwarding.

## Deployment

Full runbook: [docs/DEPLOY.md](docs/DEPLOY.md). End-to-end checklist: [docs/VALIDATION.md](docs/VALIDATION.md).

- **Firebase**: create a project, a **Native mode** Firestore database (region is permanent; some projects need Blaze billing to create it), and enable Auth with the **Google provider**. Register a web app and copy its config into `web/firebase-config.js`; generate a Web Push certificate and add the public key as `vapidKey` (missing key disables opt-in with a clear message). Add every serving hostname — `<project-id>.web.app`, `<project-id>.firebaseapp.com`, the custom domain — to Auth's authorized domains.
- **Service accounts**: the bridge key holds Cloud Datastore User, Firebase Authentication Viewer and Firebase Cloud Messaging API Admin; deploy credentials (a separate key or `firebase login`) hold Firebase Admin and Cloud Datastore Index Admin. Keys live in gitignored `private/`.
- **Deploy**: rules, indexes and Hosting, from `main`, via `npm run deploy:rules`, `npm run deploy:indexes` and `npm run deploy:hosting` (or `npm run deploy`). Each script runs `scripts/check-firebase-project.mjs` first, which blocks a release whose target project (`FIREBASE_PROJECT`, else `.firebaserc`) differs from the service-account key's project. `npm run deploy:dry-run` compiles and validates without publishing. Let the command index finish building before relying on the Advanced scrollback.
- **Allowlist**: each person signs in once; list emails in `private/acl.txt`, then run `/opt/chelevse/pi/.venv/bin/python /opt/chelevse/pi/acl.py` on the Pi (the venv the installer builds; needs the service account present). `--prune` removes grants no longer listed and their FCM tokens.
- **Pi**: clone repo, copy the templates from `private.example/` to `private/`, fill in values, `sudo bash pi/install.sh` (idempotent; syncs `pi/` + `private/` to `/opt/chelevse`, builds the venv, installs and enables the systemd unit).

Failure modes:

| Failure              | Behavior                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi offline           | PWA shows stale `updated_at` / **"Bridge offline"** (no status write for 60 s)                                                                                                                                                                                                                                          |
| Charger unreachable  | Bridge retries at the fixed poll interval, writes `charger_online: false`, and the PWA banner distinguishes **"Charger offline"** from the bridge case; the watchdog restarts over HTTP, or over MQTT when HTTP is wedged, and alerts only when neither path can reach it; a command it cannot apply is marked `failed` |
| MQTT broker down     | The bridge logs one `status source: http (mqtt disconnected …)`, resumes the 10 s HTTP poll and records `status/health.source: "http"`; when the broker returns it switches back and logs once. The charger keeps publishing into the void (QoS 0) with no impact on charging                                           |
| Firebase blip        | SDKs auto-reconnect; the bridge retries failed writes on the next tick; history baselines only advance after a successful write                                                                                                                                                                                         |
| PWA offline          | An already-loaded app keeps working from the Firestore cache and the service-worker shell; a cold reload needs the network because the Firebase SDK and `firebase-config.js` are deliberately network-only                                                                                                              |
| Stale deployed shell | Shell files are cache-first: `index.html`, `sw.js` and `firebase-config.js` are served `no-cache`, and a shell change must bump `CACHE` in `web/sw.js`; an open tab keeps old modules until reopened                                                                                                                    |
| Index still building | The Advanced console reports the in-progress index (`failed-precondition`) instead of a generic error; reload once Firestore shows it ready                                                                                                                                                                             |

Each row is triggered and checked in [docs/VALIDATION.md](docs/VALIDATION.md).

## Decisions & future work

- **Serverless over a backend service** (Firebase vs Railway/custom server): Firestore listeners give realtime updates with zero server code, the free tier is ample, and a future native Android app plugs into the same data.
- **Why the Pi bridge exists** (vs. charger → cloud directly): the ESP32 firmware has no Firebase client; its direct-to-cloud options are telemetry-only (built-in Emoncms HTTPS posting) or MQTT via an internet-reachable broker — which adds a service to run and puts charger control on a third-party broker. A ~100-line LAN bridge is the simplest path covering both status **and** control.
- **V1 scope includes energy history**: per-day kWh (from `total_energy` deltas) and per-session records — both computed bridge-side so the PWA stays a dumb renderer.
- **Config parity by functionality, not UI**: the app exposes all configuration the charger offers (view), with changes via whitelisted commands plus the gated RAPI console — we don't mirror the built-in UI's layout.
- **Firmware-native scheduling**: the app edits `schedule/current` in Firestore; the bridge pushes it to the charger's own scheduler (`POST /schedule`; v5.1.5 events are flat `{id, state, time, days}` with no per-event current, so `amps` is stored but not applied). Windows are enforced by the charger itself and survive a Pi outage; a periodic reconcile re-posts them after a firmware reset. `/override` remains the dynamic manual path. (Research confirmed the v5.x scheduler API — bridge-side window evaluation was considered and rejected.)
- **Deferred from the built-in UI**: session limits are reachable via the RAPI console in v1; a curated screen can follow if wanted.
- **MQTT-first status, HTTP for the rest**: the charger publishes per-field
  status topics and accepts commands on native topics, so the bridge subscribes
  and publishes instead of polling, keeping HTTP for `/config`,
  `/schedule/plan`, OTA and as the automatic fallback
  (`MQTT_ENABLED=false` reverts to 10 s polling and HTTP commands). The broker
  lives on the Pi — the existing always-on host on the charger's LAN — so the
  design stays serverless from the internet's point of view and adds no cloud
  service.
- **FCM in v1**: push for charging started/stopped and offline events — the PWA self-registers its token, the bridge sends via the Admin SDK. Costs are computed client-side from the stored rate.
- Future candidates: native Android app, per-event notification preferences, the
  firmware's built-in Emoncms posting as a zero-code telemetry fallback.
