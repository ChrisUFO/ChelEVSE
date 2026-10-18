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
| Status | 10 s | `GET http://<charger>/status` → write `status/current` in Firestore |
| Commands | watch + 5 s poll fallback | New pending doc in `commands` → apply to charger → mark acked / delete |

Config via environment file in `private/`: `CHARGER_HOST`, `FIREBASE_SERVICE_ACCOUNT` (path to key), optional intervals.

Failure handling: connection errors (charger or Firebase) retry with backoff; nothing crashes the service.

### 2. Firebase — Firestore + Hosting

**Firestore data model (v1):**

| Path | Writer | Readers | Content |
|---|---|---|---|
| `status/current` | bridge (admin) | signed-in users | `{state, amps, session_wh`, `total_kwh`, temp_c, updated_at, bridge_online}` |
| `commands/{id}` | app (create), bridge (ack/delete) | signed-in users | `{type: pause\|resume\|set_current, amps?, created_at, status: pending\|acked\|failed}` |

Commands are typed whitelist entries — never raw pass-through payloads to the charger. Security rules enforce: only authenticated reads; only whitelisted command types with validated `amps` on create; status writes and command mutations are admin-only. See `firestore.rules`.

**Hosting** serves the static PWA from `web/` on a free HTTPS domain.

### 3. Android app — PWA (`web/`)

Static HTML/JS using the Firebase Web SDK. Signs in with Firebase Auth (email/password — a single personal account), subscribes to `status/current` with `onSnapshot` for **realtime** updates, and creates command docs on button press. Installable to the Android home screen (manifest + service worker). The Firestore contract is the API — a native Android app or FCM push notifications ("charging complete") can be added later without touching the bridge.

## OpenEVSE integration

The charger's official WiFi module (ESP32 firmware) exposes a local JSON/HTTP API:

| Purpose | Endpoint |
|---|---|
| Status (`state`, `amp`, `power`, `session_energy` Wh, `total_energy` kWh, `temp1–3`) | `GET /status` |
| Config | `GET /config` |
| Set max current | `POST /override` `{"state":"active","charge_current":N,"max_current":N}` |
| Pause | `POST /override` `{"state":"disabled"}` |
| Resume | `POST /override` `{"state":"active"}` · clear manual override: `DELETE /override` |

Plain HTTP on the trusted home LAN (HTTP Basic auth if an admin password is set on the charger). The API is small enough that the bridge can use a plain HTTP client; [`openevsehttp`](https://github.com/firstof9/python-openevse-http) — the library behind the Home Assistant integration — is the fuller-featured option: actively maintained, async, requires Python ≥ 3.13 on the Pi. The firmware also offers a WebSocket (`GET /ws`) with JSON deltas; v1 polls instead for simplicity.

**HTTP polling vs MQTT**: the WiFi module also speaks MQTT natively, but MQTT needs a broker reachable from both the house and the cloud. HTTP polling is stateless, NAT-friendly, and trivially debuggable — the right fit for "very simple". MQTT remains a documented future alternative.

## Security

- Public repo, private values: `private/` (service-account key, env) and `web/firebase-config.js` are gitignored; `private.example/` and `web/firebase-config.example.js` are the committed templates. (Firebase web config values aren't secrets — access is enforced by Auth + rules — but they stay out of the public repo anyway.)
- AuthN: Firebase Auth, email/password, single personal account.
- AuthZ: Firestore security rules (see `firestore.rules`) — reads require auth; command creates are schema-validated; only the bridge's admin credentials write status or mutate commands.
- HTTPS everywhere (Firebase domains + outbound-only from the Pi).
- No router port forwarding.

## Deployment

- **Firebase**: create a project (Spark/free plan is plenty), enable Firestore + Auth (email/password), register a web app, download a service-account key into `private/`, then `firebase deploy` (Hosting + rules) from this repo.
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
- v1 keeps only the latest snapshot — history/graphs out of scope for now (trivially added as a per-session collection later).
- Future candidates: native Android app, FCM push notifications, energy history, MQTT transport for the LAN leg, firmware's built-in Emoncms posting as a zero-code telemetry fallback.
