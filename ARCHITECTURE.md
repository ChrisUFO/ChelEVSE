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

Two loops:

| Loop | Interval | Action |
|---|---|---|
| Status | 10 s | `GET http://<charger>/status` → write `status/current`; maintain `history/daily/*` from `total_energy` deltas; finalize a `sessions/*` doc when a charging session ends |
| Config | 60 s | `GET /config` → write `status/config` |
| Schedule | 60 s | Evaluate `schedule/current`; on window **enter** → apply rule amps, on window **exit** → pause. Edge-triggered: manual commands hold until the next boundary |
| Commands | watch + 5 s poll fallback | New pending doc in `commands` → apply to charger → mark acked / delete |

Config via environment file in `private/`: `CHARGER_HOST`, `FIREBASE_SERVICE_ACCOUNT` (path to key), optional intervals.

Failure handling: connection errors (charger or Firebase) retry with backoff; nothing crashes the service.

### 2. Firebase — Firestore + Hosting

**Firestore data model (v1):**

| Path | Writer | Readers | Content |
|---|---|---|---|
| `status/current` | bridge (admin) | signed-in users | Full `/status` snapshot: `{state, state_label, amp, voltage, power, session_energy (Wh), total_energy (kWh), elapsed (s), temp1–temp3, temp_c, pilot, charger_online, schedule: {in_window, active_rule_id}, updated_at}` |
| `status/config` | bridge (admin) | signed-in users | Charger `/config` snapshot (firmware, hostname, service level, limits, integration settings), refreshed ~60 s |
| `history/daily/{YYYY-MM-DD}` | bridge (admin) | signed-in users | `{kwh}` per local day, derived from `total_energy` deltas |
| `sessions/{id}` | bridge (admin) | signed-in users | Completed sessions: `{started_at, ended_at, wh, elapsed}` |
| `schedule/current` | app (write), bridge (read) | allowlisted users | Owner-defined charge schedule: `{enabled, rules: [{id, days [0–6 Mon=0], start "HH:MM", end "HH:MM", amps}]}`; `end < start` wraps past midnight |
| `users/{uid}` | acl sync (admin) | that user (own doc) | Access grant: `{allowed: bool, email}` — synced from `private/acl.txt` by `pi/acl.py` |
| `commands/{id}` | app (create), bridge (ack/delete) | signed-in users | `{type: pause\|resume\|set_current\|rapi, amps?, command?, created_at, status: pending\|acked\|failed}` |

Commands are typed whitelist entries; `rapi` is the explicit advanced escape hatch (string-validated in rules) for anything the curated types don't cover. Security rules enforce: only authenticated reads; only whitelisted command types with validated `amps`/`command` on create; status/history writes and command mutations are admin-only. See `firestore.rules`.

**Hosting** serves the static PWA from `web/` on a free HTTPS domain.

### 3. Android app — PWA (`web/`)

Static HTML/JS using the Firebase Web SDK, installable to the Android home screen (manifest + service worker). Signs in with **Google** (Firebase Auth popup/redirect) — accounts without an allowlist grant see a clear "no access" screen and a sign-out control — and gets **realtime** updates via `onSnapshot`. Screens:

- **Status** — everything the charger reports: state, live current/power/voltage, session energy + charging time, lifetime total, per-sensor temperatures, pilot (setpoint); charge-mode control — **stop / auto / hold** (`pause` = stop, `resume` = clear override → auto, `set_current` = hold at a new setpoint) — and the device name from config as the header.
- **History** — daily kWh bar chart (last 30 days, hand-rolled SVG — no chart library) fed by `history/daily`, plus a recent-sessions list from `sessions`.
- **Schedule** — edit the charge schedule (enable toggle; rules with days, start/end, amps), with a live indicator when a window is currently active (from `status/current.schedule`).
- **Config** — every configuration item the charger exposes, read from `status/config` and presented in our own layout; changes go through the Advanced console.
- **Advanced** — RAPI console (`$` commands via the `rapi` command type) for full configuration parity with the built-in UI, behind a confirmation gate since RAPI can alter safety-relevant settings.

The Firestore contract is the API — a native Android app or FCM push notifications ("charging complete") can be added later without touching the bridge.

## OpenEVSE integration

The charger's official WiFi module (ESP32 firmware) exposes a local JSON/HTTP API:

| Purpose | Endpoint |
|---|---|
| Status (`state`, `amp`, `power`, `session_energy` Wh, `total_energy` kWh, `temp1–3`) | `GET /status` |
| Config | `GET /config` |
| Set max current | `POST /override` `{"state":"active","charge_current":N,"max_current":N}` |
| Pause / stop | `POST /override` `{"state":"disabled"}` |
| Return to auto (clear override) | `DELETE /override` |
| Hold at setpoint / force charge | `POST /override` `{"state":"active"}` |

Plain HTTP on the trusted home LAN (HTTP Basic auth if an admin password is set on the charger). The API is small enough that the bridge can use a plain HTTP client; [`openevsehttp`](https://github.com/firstof9/python-openevse-http) — the library behind the Home Assistant integration — is the fuller-featured option: actively maintained, async, requires Python ≥ 3.13 on the Pi. The firmware also offers a WebSocket (`GET /ws`) with JSON deltas; v1 polls instead for simplicity.

**HTTP polling vs MQTT**: the WiFi module also speaks MQTT natively, but MQTT needs a broker reachable from both the house and the cloud. HTTP polling is stateless, NAT-friendly, and trivially debuggable — the right fit for "very simple". MQTT remains a documented future alternative.

## Security

- Public repo, private values: `private/` (service-account key, env) and `web/firebase-config.js` are gitignored; `private.example/` and `web/firebase-config.example.js` are the committed templates. (Firebase web config values aren't secrets — access is enforced by Auth + rules — but they stay out of the public repo anyway.)
- AuthN: Firebase Auth with **Google Sign-In**. Anyone can authenticate; data access is allowlisted.
- AuthZ: Firestore rules require a `users/{uid}` doc with `allowed == true` (and a verified email). The allowlist lives in gitignored `private/acl.txt` (one email per line) and is synced to those grant docs by `pi/acl.py` using the bridge's Admin credentials — personal emails stay out of the public repo, and grants change without redeploying rules. Each person must have signed in once before they can be granted (their auth user must exist to resolve the uid).
- Command creates are schema-validated; only the bridge's admin credentials write status/history or mutate commands. `schedule/current` is the single client-writable data doc — allowlisted users, shape-validated in rules.
- HTTPS everywhere (Firebase domains + outbound-only from the Pi).
- No router port forwarding.

## Deployment

- **Firebase**: create a project (Spark/free plan is plenty), enable Firestore + Auth (**Google provider**), register a web app, download a service-account key into `private/`, then `firebase deploy` (Hosting + rules) from this repo.
- **Allowlist**: list emails in `private/acl.txt`, then run `python3 pi/acl.py` on the Pi (needs the service account present). Each person must have signed in once first.
- **Pi**: clone repo, `cp -r private.example private`, fill in values, install the provided systemd unit.

Failure modes:

| Failure | Behavior |
|---|---|
| Pi offline | PWA shows stale `updated_at` / "bridge offline" |
| Charger unreachable | Bridge retries with backoff; command marked `failed` if it can't apply |
| Firebase blip | SDKs auto-reconnect; bridge retries writes with backoff |
| PWA offline | Firestore cache shows last known values |

## Decisions & future work

- **Serverless over a backend service** (Firebase vs Railway/custom server): Firestore listeners give realtime updates with zero server code, the free tier is ample, and a future native Android app plugs into the same data.
- **Why the Pi bridge exists** (vs. charger → cloud directly): the ESP32 firmware has no Firebase client; its direct-to-cloud options are telemetry-only (built-in Emoncms HTTPS posting) or MQTT via an internet-reachable broker — which adds a service to run and puts charger control on a third-party broker. A ~100-line LAN bridge is the simplest path covering both status **and** control.
- **V1 scope includes energy history**: per-day kWh (from `total_energy` deltas) and per-session records — both computed bridge-side so the PWA stays a dumb renderer.
- **Config parity by functionality, not UI**: the app exposes all configuration the charger offers (view), with changes via whitelisted commands plus the gated RAPI console — we don't mirror the built-in UI's layout.
- **Bridge-side scheduling**: the Pi evaluates `schedule/current` (edge-triggered at window boundaries) rather than programming firmware-native timers — one model across firmware versions, editable from the app; the firmware's native timer API stays a documented alternative.
- **Deferred from the built-in UI**: session limits are reachable via the RAPI console in v1; a curated screen can follow if wanted.
- Future candidates: native Android app, FCM push notifications, MQTT transport for the LAN leg, firmware's built-in Emoncms posting as a zero-code telemetry fallback.
