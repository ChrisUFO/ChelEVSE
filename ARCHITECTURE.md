# ChelEVSE Architecture

## Goals

- Move OpenEVSE charger status and basic control off the home LAN and onto the phone, reliably.
- Nothing complex: no backend server, no message broker, no inbound connections to the house, minimal moving parts.

## Topology

```
┌────────────────┐  LAN HTTP     ┌───────────────┐  outbound HTTPS ┌────────────────────────┐
│ OpenEVSE       │◄─────────────►│ Raspberry Pi  │────────────────►│ Firebase               │
│ (WiFi module)  │ 192.168.0.145 │ bridge agent  │  status writes / │ Firestore (data)       │
└────────────────┘               └───────────────┘  command watch   │ Hosting (PWA)          │
                                                                   └───────────┬────────────┘
                                                                               │ HTTPS
                                                                    ┌──────────▼───────────┐
                                                                    │ Android phone (PWA)  │
                                                                    │ Firebase Auth sign-in│
                                                                    └──────────────────────┘
```

The only publicly reachable component is Firebase. The Pi never accepts inbound connections, and there is no self-run server anywhere.

## Components

### 1. Bridge agent — `pi/`

Python 3 service on the Raspberry Pi, run under systemd (`Restart=always`). Authenticates to Firebase with a **service-account key** (Admin SDK — bypasses security rules by design, so the key lives in gitignored `private/`).

Four loops:

| Loop     | Interval                                | Action                                                                                                                                                                                                                |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | 10 s                                    | `GET http://<charger>/status` → write curated fields to `status/current`; maintain `history/<date>` from `total_energy` deltas; finalize one `sessions/*` doc per plug-in session                                     |
| Config   | 60 s                                    | `GET /config` → write `status/config` with credential fields redacted                                                                                                                                                 |
| Schedule | on change + 60 s, reconcile every 300 s | Sync `schedule/current` → firmware `POST /schedule` (one event per request; each rule becomes a window-start `active` event and a window-end `disabled` event). Poll `GET /schedule/plan` → `status.current.schedule` |
| Commands | 5 s poll                                | New pending doc in `commands` → apply to charger → mark acked / failed (stale pending docs are failed without contacting the charger)                                                                                 |

The status loop also emits **FCM push notifications** on transitions — charging started, charging stopped, charger offline — sent by a background worker to every registered `fcmTokens` doc via the Admin SDK (invalid tokens are pruned on send error).

Config via environment file in `private/`: `CHARGER_HOST`, `FIREBASE_SERVICE_ACCOUNT` (path to key), optional intervals.

Failure handling: connection errors (charger or Firebase) are logged and retried at the loop's fixed poll interval; writes that fail are retried on the next tick; nothing crashes the service.

### 2. Firebase — Firestore + Hosting

**Firestore data model (v1):**

| Path                | Writer                                  | Readers             | Content                                                                                                                                                                                                                             |
| ------------------- | --------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status/current`    | bridge (admin)                          | signed-in users     | Curated `/status` fields: `{state, state_label, amp, voltage, power, session_energy (Wh), total_energy (kWh), elapsed (s), vehicle, temp1–temp3, temp_c, pilot, charger_online, schedule: {in_window, active_rule_id}, updated_at}` |
| `status/config`     | bridge (admin)                          | signed-in users     | Charger `/config` snapshot (firmware, hostname, service level, limits, integration settings) with credential fields redacted to `"***"`; refreshed ~60 s                                                                            |
| `history/{date}`    | bridge (admin)                          | signed-in users     | `{kwh}` per local day, derived from `total_energy` deltas                                                                                                                                                                           |
| `sessions/{id}`     | bridge (admin)                          | signed-in users     | One record per completed plug-in session (merged across pause/resume): `{started_at, ended_at, wh, elapsed}`                                                                                                                        |
| `schedule/current`  | app (write), bridge (syncs to firmware) | allowlisted users   | Owner-defined charge schedule: `{enabled, rules: [{id, days [0–6 Mon=0], start "HH:MM", end "HH:MM", amps}]}`; `end < start` wraps past midnight; bridge mirrors it into the firmware scheduler                                     |
| `settings/current`  | app (write)                             | allowlisted users   | App settings: `{rate ($/kWh), currency}` — used client-side for cost display                                                                                                                                                        |
| `fcmTokens/{token}` | app (create own)                        | —                   | Push registration: `{uid, created_at}`; the bridge sends FCM notifications to these tokens                                                                                                                                          |
| `users/{uid}`       | acl sync (admin)                        | that user (own doc) | Access grant: `{allowed: bool, email}` — synced from `private/acl.txt` by `pi/acl.py`                                                                                                                                               |
| `commands/{id}`     | app (create), bridge (ack/fail)         | signed-in users     | `{type: pause\|resume\|set_current\|rapi, amps?, command?, created_at, status: pending\|acked\|failed}`; pending older than 10 min is failed                                                                                        |

Commands are typed whitelist entries; `rapi` is the explicit advanced escape hatch (string-validated in rules) for anything the curated types don't cover. Security rules enforce: only authenticated reads; only whitelisted command types with validated `amps`/`command` on create; status/history writes and command mutations are admin-only. See `firestore.rules`.

**Hosting** serves the static PWA from `web/` on a free HTTPS domain.

### 3. Android app — PWA (`web/`)

Static HTML/JS using the Firebase Web SDK, installable to the Android home screen (manifest + service worker). Signs in with **Google** (Firebase Auth popup/redirect) — accounts without an allowlist grant see a clear "no access" screen and a sign-out control — and gets **realtime** updates via `onSnapshot`. Screens:

- **Status** — everything the charger reports: state, live current/power/voltage, session energy + cost (rate × energy) + charging time, lifetime total, per-sensor temperatures, pilot (setpoint); charge-mode control — **stop / auto / hold** (`pause` = stop, `resume` = clear override → auto, `set_current` = hold at a new setpoint) — and the device name from config as the header.
- **History** — daily kWh bar chart (last 30 days, hand-rolled SVG — no chart library) fed by `history/{date}`, plus a recent-sessions list from `sessions`; both show costs at the current rate.
- **Schedule** — edit the charge schedule (enable toggle; rules with days, start/end, amps), with a live indicator when a window is currently active (from `status/current.schedule`).
- **Config** — every configuration item the charger exposes (credential fields show `"***"` because the bridge redacts them), read from `status/config` and presented in our own layout; changes go through the Advanced console. Also **App settings**: electricity rate ($/kWh + currency, stored in `settings/current`) and an enable-notifications control (registers the device for FCM push).
- **Advanced** — RAPI console (`$` commands via the `rapi` command type) for full configuration parity with the built-in UI, behind a confirmation gate since RAPI can alter safety-relevant settings.

The Firestore contract is the API — a native Android app or FCM push notifications ("charging complete") can be added later without touching the bridge.

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

**HTTP polling vs MQTT**: the WiFi module also speaks MQTT natively, but MQTT needs a broker reachable from both the house and the cloud. HTTP polling is stateless, NAT-friendly, and trivially debuggable — the right fit for "very simple". MQTT remains a documented future alternative.

## Security

- Public repo, private values: `private/` (service-account key, env) and `web/firebase-config.js` are gitignored; `private.example/` and `web/firebase-config.example.js` are the committed templates. (Firebase web config values aren't secrets — access is enforced by Auth + rules — but they stay out of the public repo anyway.)
- AuthN: Firebase Auth with **Google Sign-In**. Anyone can authenticate; data access is allowlisted.
- AuthZ: Firestore rules require a `users/{uid}` doc with `allowed == true` (and a verified email). The allowlist lives in gitignored `private/acl.txt` (one email per line) and is synced to those grant docs by `pi/acl.py` using the bridge's Admin credentials — personal emails stay out of the public repo, and grants change without redeploying rules. Each person must have signed in once before they can be granted (their auth user must exist to resolve the uid).
- Command creates are schema-validated; only the bridge's admin credentials write status/history or mutate commands. `schedule/current` and `settings/current` are the client-writable data docs — allowlisted users, shape-validated in rules; `fcmTokens` docs are own-token-only.
- HTTPS everywhere (Firebase domains + outbound-only from the Pi).
- No router port forwarding.

## Deployment

- **Firebase**: create a project (Spark/free plan is plenty), enable Firestore + Auth (**Google provider**), register a web app, download a service-account key into `private/`, then `firebase deploy` (Hosting + rules) from this repo.
- **Allowlist**: list emails in `private/acl.txt`, then run `/opt/chelevse/pi/.venv/bin/python /opt/chelevse/pi/acl.py` on the Pi (the venv the installer builds; needs the service account present). Each person must have signed in once first.
- **Pi**: clone repo, `cp -r private.example private`, fill in values, install the provided systemd unit.

Failure modes:

| Failure             | Behavior                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| Pi offline          | PWA shows stale `updated_at` / "bridge offline"                                      |
| Charger unreachable | Bridge retries at the fixed poll interval; command marked `failed` if it can't apply |
| Firebase blip       | SDKs auto-reconnect; the bridge retries failed writes on the next tick               |
| PWA offline         | Firestore cache shows last known values                                              |

## Decisions & future work

- **Serverless over a backend service** (Firebase vs Railway/custom server): Firestore listeners give realtime updates with zero server code, the free tier is ample, and a future native Android app plugs into the same data.
- **Why the Pi bridge exists** (vs. charger → cloud directly): the ESP32 firmware has no Firebase client; its direct-to-cloud options are telemetry-only (built-in Emoncms HTTPS posting) or MQTT via an internet-reachable broker — which adds a service to run and puts charger control on a third-party broker. A ~100-line LAN bridge is the simplest path covering both status **and** control.
- **V1 scope includes energy history**: per-day kWh (from `total_energy` deltas) and per-session records — both computed bridge-side so the PWA stays a dumb renderer.
- **Config parity by functionality, not UI**: the app exposes all configuration the charger offers (view), with changes via whitelisted commands plus the gated RAPI console — we don't mirror the built-in UI's layout.
- **Firmware-native scheduling**: the app edits `schedule/current` in Firestore; the bridge pushes it to the charger's own scheduler (`POST /schedule`; v5.1.5 events are flat `{id, state, time, days}` with no per-event current, so `amps` is stored but not applied). Windows are enforced by the charger itself and survive a Pi outage; a periodic reconcile re-posts them after a firmware reset. `/override` remains the dynamic manual path. (Research confirmed the v5.x scheduler API — bridge-side window evaluation was considered and rejected.)
- **Deferred from the built-in UI**: session limits are reachable via the RAPI console in v1; a curated screen can follow if wanted.
- **FCM in v1**: push for charging started/stopped and offline events — the PWA self-registers its token, the bridge sends via the Admin SDK. Costs are computed client-side from the stored rate.
- Future candidates: native Android app, MQTT transport for the LAN leg, per-event notification preferences, firmware's built-in Emoncms posting as a zero-code telemetry fallback.
