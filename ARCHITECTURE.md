# ChelEVSE Architecture

> Status: v1 shipped. This document is the design source of truth for the system as built. It covers the topology, the Firestore contract, runtime flows, the bridge and PWA internals, deployment and test topology, and the known gaps. Behavioural details live in `README.md`, `pi/README.md` and `docs/VALIDATION.md`; this document explains how the pieces fit and why.

## 1. Goals, scope and constraints

### Goals

- Move OpenEVSE charger status and control off the home LAN and onto a phone, reliably.
- Keep the moving parts small: no self-run backend, no inbound connections to the house, no third-party control broker.
- Keep the data contract explicit enough that a native client could replace the PWA without touching the bridge.

### Non-goals

- Multi-tenant operation, fleet management, or a public API.
- Supplier tariff import, standing charges, export rates, or automatic plan optimisation.
- Interval-level metering accuracy beyond the approximations documented below.

### Constraints

- **Firebase is the only public surface.** Firestore carries data, Hosting serves the PWA, Auth gates access. The bridge initiates outbound HTTPS to Firebase and LAN connections to the charger; the only inbound listener is the LAN-only Mosquitto broker for the charger.
- **The Firestore schema evolves additively.** No migration framework and no document version field; new fields are optional and absent means the old behaviour.
- **Local wall clock is authoritative** for charger schedules, rate windows, daily history and session display. Sessions and server timestamps are UTC instants; conversion happens at the edges.
- **The PWA has no build step.** Plain ES modules, no framework, no bundler.
- **Single-household assumptions** are acceptable: one bridge instance, one charger, a small allowlist. Where that assumption is load-bearing it is called out in §11.

## 2. System topology

```
┌────────────────┐   LAN HTTP      ┌────────────────────┐   outbound HTTPS   ┌─────────────────────────┐
│ OpenEVSE       │◄───────────────►│ Raspberry Pi       │───────────────────►│ Firebase                │
│ WiFi module    │   LAN MQTT      │ bridge agent       │   Admin SDK        │ Firestore  (data)       │
│ (ESP32)        │◄───────────────►│ + Mosquitto broker │   status writes    │ Hosting    (PWA)        │
└────────────────┘   status/control└────────────────────┘   command watch    │ Auth       (Google)     │
                                                                              └────────────┬────────────┘
                                                                                           │ HTTPS / WSS
                                                                                ┌──────────▼───────────┐
                                                                                │ Phone / desktop PWA  │
                                                                                │ Firebase Auth sign-in│
                                                                                └──────────────────────┘
```

Trust boundaries:

- **Firebase** is internet-reachable and enforces access with Auth + Firestore rules.
- **The home LAN** is trusted. The charger's HTTP API may be unauthenticated or Basic-auth; the Mosquitto listener is LAN-only and authenticated.
- **The Pi** holds the Admin service-account key, so it is the most privileged component. The bridge initiates Firebase and charger connections; the only inbound listener is Mosquitto on the LAN. Nothing outside the LAN can connect in.

Data flow, in one line: charger → bridge → Firestore → PWA, and PWA → Firestore → bridge → charger. The bridge is the only writer of charger state and the only component that talks to the charger.

## 3. Repository map

| Path                                                         | Role                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `pi/`                                                        | Python bridge (`bridge.py`, `mqtt_source.py`, `acl.py`), systemd unit, installer, venv requirements, `tests/`, operational README |
| `web/`                                                       | Static PWA: `index.html`, `app.js`, `js/` pure modules, `js/screens/` DOM screens, `sw.js`, `styles.css`, manifest, icon          |
| `docs/`                                                      | `DEPLOY.md` (setup/runbook) and `VALIDATION.md` (acceptance and evidence)                                                         |
| `test/web/`                                                  | `node:test` unit tests for the pure web modules and the service-worker shell                                                      |
| `test/rules/`                                                | Firestore emulator tests for `firestore.rules`                                                                                    |
| `scripts/`                                                   | `check-firebase-project.mjs` deploy guard                                                                                         |
| `private.example/`                                           | Committed templates for `private/` (ACL, env, service account)                                                                    |
| `private/`                                                   | Gitignored deployment values: ACL, bridge env, service-account keys                                                               |
| `web/firebase-config.js`                                     | Gitignored Firebase web config                                                                                                    |
| `firebase.json`, `firestore.rules`, `firestore.indexes.json` | Firebase project config, security rules, indexes                                                                                  |
| `.firebaserc`                                                | Gitignored default project id (`chelevse`)                                                                                        |
| `.githooks/`                                                 | Prettier pre-commit/pre-push hooks                                                                                                |
| `node_modules/`, `pi/.venv/`, `__pycache__/`, `.firebase/`   | Generated; never committed                                                                                                        |

`PLAN.md` and `.review/` are local workflow artifacts (gitignored) and are not part of the deployed system.

## 4. Data model — Firestore is the API

### Principles

- **One document shape per concern.** The bridge writes charger state and derived history with the Admin SDK (bypassing rules by design). The PWA writes only the three client-owned documents: `settings/current`, `schedule/current`, `commands/*` (plus its own `fcmTokens/*`).
- **No schema migrations.** Optional fields are added; absent/empty means the previous behaviour. `settings/current.rates` is the worked example: absent = flat rate.
- **Read-time derivation.** Costs, schedule state and config presentation are computed when rendered, never persisted. Changing a rate schedule immediately re-prices history.
- **Curated status, raw config.** `status/current` is a fixed, unit-normalised field set. `status/config` is the charger's `/config` with secrets redacted; it is replaced wholesale, not merged.

### Collections and documents

| Path                   | Writer                           | Readers             | Shape and notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status/current`       | bridge                           | allowlisted         | Curated `/status`: `state`, `state_label`, `amp` (A), `voltage`, `power`, `session_energy` (Wh), `total_energy` (kWh), `elapsed` (s), `vehicle`, `temp1–3`, `temp_c`, `pilot`, `charger_online`, `updated_at`, and a merged `schedule: {in_window, active_rule_id}`. Merge write every 10 s (HTTP) or per MQTT event; 60 s reconciliation while MQTT is healthy. Failed HTTP polls merge `charger_online: false` and refresh `updated_at` while keeping the last known values; under a ready MQTT source, two consecutive failed reconciles with no snapshot are required, and a late snapshot cancels the outage. |
| `status/config`        | bridge                           | allowlisted         | Redacted `/config` snapshot plus `updated_at`; credential fields become `"***"`. Replace write on a `config_version` change under MQTT, or every 60 s over HTTP; a 600 s safety resync runs until a version is seen. Removed keys disappear.                                                                                                                                                                                                                                                                                                                                                                       |
| `status/health`        | bridge (watchdog + MQTT source)  | allowlisted         | Merge writes from two writers: watchdog state (`state`, `reason`, `http_ok`, `controller_ok`, attempts, `last_action`, `last_transport`, `last_result`) and transport view (`source`, `mqtt_connected`, `mqtt_announced`, `mqtt_last_lwt_at`).                                                                                                                                                                                                                                                                                                                                                                     |
| `history/{YYYY-MM-DD}` | bridge                           | allowlisted         | `{kwh, updated_at}` per **Pi-local** day, accumulated from positive `total_energy` deltas with `Increment`. First reading is a baseline; a negative delta rebaselines without writing. No retention/pruning.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sessions/{id}`        | bridge                           | allowlisted         | One record per completed plug-in: `{started_at, ended_at, wh, elapsed}`. The id is deterministic from the start instant. Pause/resume is merged into one record (120 s touching/gap, or counters growing while plugged and the previous record is < 48 h old); merged records keep the original id and `max(wh)`, `max(elapsed)`.                                                                                                                                                                                                                                                                                  |
| `schedule/current`     | PWA (allowlisted)                | allowlisted, bridge | Exactly `{enabled: bool, rules: [{id, days:[0–6, 0=Mon], start:"HH:MM", end:"HH:MM", amps}]}`. `end < start` wraps midnight; `start === end` is invalid; max 20 rules. The bridge mirrors it to the charger's scheduler; `amps` is stored but not applied because firmware v5.1.5 has no per-event current.                                                                                                                                                                                                                                                                                                        |
| `settings/current`     | PWA (allowlisted)                | allowlisted         | `{rate: 0–5, currency: 1–8 chars, rates?: RateWindow[]}`. `rate` is the **fallback**; `rates` is optional, ≤ 24. A flat save omits `rates` and is byte-identical to the original two-field document.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fcmTokens/{token}`    | PWA (own token)                  | —                   | Exactly `{uid, created_at}`. The bridge sends notifications and deletes tokens FCM reports as unregistered. A token owner may delete its doc without the access grant so revocation cannot strand the registration.                                                                                                                                                                                                                                                                                                                                                                                                |
| `users/{uid}`          | `acl.py` (Admin)                 | that user (own doc) | `{allowed: true, email}` grant. Rules require this doc and `email_verified` for every data read. Only the owner may read it; no client writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `commands/{id}`        | PWA (create), bridge (lifecycle) | allowlisted         | `{type: pause / resume / set_current / rapi, amps?, command?, status: pending / acked / failed, created_at, transport?, error?, result?}`. The bridge polls every 5 s, batches 10, and fails pending docs older than 10 min only when `created_at` is a valid past timestamp (missing/malformed timestamps are treated as not stale; a future timestamp defers the sweep). It is the only writer of `status`/`transport`/`error`/`result`.                                                                                                                                                                         |

### Rate schedule (`settings/current.rates`)

```js
{
  rate: 0.245,                 // fallback: every moment no window covers
  currency: "GBP",
  rates: [                     // optional; absent/empty = flat behaviour
    { id: "w1", rate: 0.10, days: [0,1,2,3,4,5,6], start: "00:30", end: "04:30", months: null },
    { id: "w2", rate: 0.32, days: [1,2,3,4,5],     start: "16:00", end: "19:00", months: [11,12,1,2] }
  ]
}
```

- `days`: `0` = Monday … `6` = Sunday, matching the charge schedule and `DAY_NAMES`. `Date#getDay()` is converted with `(getDay() + 6) % 7`.
- `start`/`end`: local `HH:MM`, half-open `[start, end)`. `end <= start` wraps past midnight; `start === end` covers the whole day.
- `months`: `null` = all year, or an inclusive list `1–12`. A range may wrap the year (Nov → Feb = 11, 12, 1, 2).
- `from`/`to` (optional): `"MM-DD"` bounds of a day-precision season, inclusive and recurring annually. Both or neither must be valid; `from > to` wraps the year (`10-15` → `04-15`), `from === to` is one day, and `02-29` is a real date (`02-30` is not). When both are valid they outrank `months`, which is then only the derived compatibility hint a save writes; a one-sided or unreal pair makes the row invalid, so it is dropped from costing instead of falling back to stale months.
- **Season rate:** an ordinary all-day, every-day row (`days: [0..6]`, `start === end`) is one price for every hour of its season. It is not a new field or key order. A season is either one season rate or a set of daily windows: a base season rate plus daily overrides is out of scope (an all-day row would overlap every override under last-match-wins), so the overlap validator rejects the mix.
- **Post-midnight attribution:** a window's after-midnight hours belong to the day the window started. A Monday 22:00–06:00 window covers Tuesday 00:00–05:59; a season ending 15 September prices 16 September 00:00–05:59 with 15 September's rate; a December-only window covers 1 January 00:00–05:59.
- **Overlap rejection:** windows that can both match one local instant are rejected by the editor. Validation compares annual date sets on a 366-slot leap ring (month-day positions, with 29 February as a real slot) and the four main/tail combinations, so adjacent seasons sharing a month but no day do not collide, a December wrap and January's early hours do, and 29 February is exact.
- **Payload:** a month row is `{id, rate, days, start, end, months}` unchanged; a date row appends `from`/`to` after `months`, whose value is derived from the dates (`10-15` → `04-15` = `[10,11,12,1,2,3,4]`). Old clients ignore the dates, read the derived months and over-apply at month edges.
- **Legacy overlaps:** a document written outside the editor may still contain overlaps. Matching is deterministic: the **last matching window in list order wins**. The editor blocks the next save until the overlap is resolved, and payload order is preserved so grouping never changes legacy semantics.
- **Limits:** ≤ 24 windows. `web/js/rates.js` owns normalization, matching, overlap detection and interval costing; `web/js/settings.js` owns form validation, normalization/dirty comparison and the save payload.

### Cost semantics

Costs are presentation values, computed on every render from the current settings and never stored:

- **Flat:** `kWh × rate`, exactly the pre-schedule behaviour.
- **Live session:** the interval is `[updated_at − elapsed, updated_at]`, anchored to the status write. It is shown only while the charger is actually charging (`state_label === "charging"` and `charger_online !== false`). Paused/ready snapshots hide the scheduled figure instead of sliding it; a stale cache-only charging snapshot keeps the figure frozen at its own interval; an offline marker hides it.
- **History session:** `costForSession` over the session's own `started_at…ended_at`, pro-rating `wh` uniformly across the rate boundaries.
- **Aggregate daily/30-day cost:** hidden whenever a rate schedule exists. A day stores one kWh total, so it cannot be split across windows; kWh remains visible and per-session costs are still shown.
- **Approximation (accepted):** sessions store one energy total, not energy per window. Uniform pro-rating is the best available signal. A paused-then-resumed plug-in spans idle time while `wh`/`elapsed` cover charging only, so its cost can be off by the rate difference across the gap. Issue #57 tracks recording real charging intervals and pricing them when present; the fallback remains uniform pro-rating.

### Schedule (`schedule/current`) and commands

- The charge schedule is enforced by the charger's firmware, not the bridge. The bridge validates and mirrors it; a missing or malformed document leaves the firmware untouched (never an implicit clear), while `enabled: false` or an empty rule list clears it.
- The bridge converts each rule to two firmware events: an `active` event at the start and a `disabled` event at the end. Overnight ends shift to the next firmware day. A digest skips unchanged schedules; a 300 s reconcile re-posts after a firmware reset.
- The bridge drops a later rule whose window overlaps or touches an earlier one (first rule wins). The web editor validates field shapes but does not detect those cross-rule collisions, so the bridge is the effective validator.
- Commands are a typed whitelist: `pause` (stop), `resume` (clear override → auto), `set_current` (6–48 A), and `rapi` (the advanced escape hatch; must match `^[$][A-Za-z0-9]{1,2}([ ].*)?$`, ≤ 32 chars). Only `pending` creates are accepted; the bridge alone settles them.
- Transport is chosen by the bridge, not the client: MQTT when connected, subscribed and ready; HTTP otherwise. A publish accepted by MQTT is never re-applied over HTTP. The command doc records the transport that carried a request (`"mqtt"` or `"http"`), and none when rejected before send.

## 5. Bridge agent (`pi/`)

Python 3 service under systemd (`Restart=always`, `User=root`), installed by rsync to `/opt/chelevse` with a venv. It authenticates to Firebase with a service-account key from `private/`. Four loops run as daemon threads (status, config, schedule, and the optional MQTT status apply), the command loop runs on the main thread, and support threads handle FCM delivery and paho's network loop:

| Thread       | Default cadence                           | Responsibility                                                                                                                                             |
| ------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status       | 10 s HTTP / 60 s reconciliation with MQTT | `GET /status` or MQTT snapshots → one `parse_status` → `apply_status` path; `status/current`, history deltas, session finalisation, transitions, FCM edges |
| Config       | 60 s, or on `config_version`              | `GET /config` → redact/coerce → `status/config` (replace write)                                                                                            |
| Schedule     | 60 s, reconcile 300 s                     | Read `schedule/current`, validate, mirror to `POST/DELETE /schedule`; poll `GET /schedule/plan` into `status/current.schedule`                             |
| Commands     | 5 s (main thread)                         | Poll pending `commands`, apply, settle with `status`/`transport`/`result`                                                                                  |
| MQTT apply   | per event (optional)                      | Debounce/merge MQTT status snapshots into the status path; command acknowledgements are awaited by the command thread, not here                            |
| FCM notifier | on transition                             | Daemon worker draining a bounded queue; sends pushes and prunes invalid tokens                                                                             |

### Status ingestion

- HTTP and MQTT converge on `parse_status`: milliamps → amps, tenths °C → °C, absent sensors → `null`, `uint64` sentinels coerced, curated whitelist. Both feed the same state machine, history and session logic.
- MQTT snapshots are debounced (~500 ms), seeded from a `/status` reply, and only run the state machine once complete. Ordering guards (`mqtt_mark`, arrival generations, seed-if-current) prevent a late HTTP reconcile from rewinding a newer MQTT apply.
- MQTT is opt-in (`MQTT_ENABLED=false` by default). When enabled, the broker is Mosquitto on the Pi, LAN-only and authenticated; the bridge subscribes to `<topic>/#` and the firmware announce topic (`openevse/announce/#`, retained state + Last Will). HTTP remains the reconciler and the fallback.
- When HTTP is the status source (or MQTT is not ready), failed polls merge `{charger_online: false, updated_at: SERVER_TIMESTAMP}` and keep the last values. Under a ready MQTT source, offline requires two consecutive failed reconciles with no snapshot; a late snapshot cancels the outage. The app distinguishes bridge staleness from charger offline with `freshnessState`.

### Commands and watchdog

- MQTT commands: `override/set` for pause/resume/set-current (confirmed against the retained `override` doc, with a status fallback), `rapi/in`/`rapi/out` for RAPI (serialised; replies carry no correlation id, so a short quarantine retires timed-out replies). HTTP commands use `/override` and `/rapi`.
- The watchdog probes after consecutive `/status` failures. HTTP answering → `POST /restart`; HTTP unreachable but MQTT connected/subscribed and not Last-Will-disconnected → publish on `<topic>/restart`; neither → alert only. Charging guard, cooldown and hourly cap apply across transports; the transition into unhealthy sends one push and recovery sends another.
- Session tracking merges pause/resume across a plug-in (see §4). History is accumulated from `total_energy` deltas; a failed Firestore write keeps the baseline and retries the next tick.

### Configuration and secrets

- `private/bridge.env` supplies `CHARGER_HOST`, `FIREBASE_SERVICE_ACCOUNT`, loop intervals, MQTT settings and optional charger Basic auth. Real environment variables override the file.
- Redaction covers credential/config keys before `status/config` is written. The service account bypasses rules; it must never reach the web app or the repo.
- OTA/firmware flashing is **not implemented** in the bridge. Firmware updates are a manual operation against the charger; `status/config` exposes the firmware version for reference. (See §11 for the documentation drift on this point.)

## 6. Web PWA (`web/`)

### Shell and lifecycle

- One `index.html` with five mutually exclusive screens: `booting`, `boot-error`, `signin`, `noaccess`, and `app`. `app` holds a five-tab `tablist` and five `tabpanel` sections (Status, History, Schedule, Config, Advanced). Hash routing selects the tab; `aria-selected` and roving focus follow the APG tabs pattern.
- Boot: dynamic Firebase SDK init → screen `init*` wiring → tab bar → auth subscription. A missing/invalid `web/firebase-config.js` produces `boot-error`; a missing grant produces `noaccess` with a sign-out control.
- `app.js` owns auth fan-out, data subscriptions, the status ticker lifecycle, lazy history load, Config-time notification refresh, and push toast display. Sign-out closes the store, resets every screen and releases the push token (bounded to 3 s); a revoked grant only releases the token for `no-access`.
- `closeApp` is the teardown boundary: subscriptions stop, screen state resets, `activeUser` clears.

### Module boundaries

**Pure / DOM-free** (unit-tested under `node:test`):

| Module                       | Responsibility                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `js/write.js`                | `settleWrite`: 10 s UI bound plus late reconciliation for Firestore writes                  |
| `js/format.js`               | state map, numeric/clock/money formatting, `liveCharging`, `freshnessState`, `elapsedClock` |
| `js/rates.js`                | rate-window normalize/validate/overlap/match, `costForInterval`, `costForSession`           |
| `js/cost.js`                 | flat-vs-schedule presentation labels for status/history                                     |
| `js/settings.js`             | settings validate/normalize/draft compare/save-state machine                                |
| `js/schedule.js`             | schedule validation, queue/discard state machines, snapshot routing                         |
| `js/history.js`              | day ids, 30-day series, chart hit-test, read classification                                 |
| `js/config.js`               | curated config rows, raw JSON, signature                                                    |
| `js/advanced.js`             | RAPI validation, confirmation gate, scrollback helpers                                      |
| `js/notifications.js`        | notification card copy, token decision/result                                               |
| `js/notification-session.js` | DOM-free FCM token lifecycle (generations, retry markers, sign-out races)                   |
| `js/push.js`                 | push payload reduction, visible-client selection, dedupe                                    |

**DOM / Firebase-facing:**

| Module           | Responsibility                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `app.js`         | boot, auth wiring, screen fan-out, push toast                                                             |
| `js/firebase.js` | SDK init and live bindings; persistent cache with multi-tab manager; `loadMessaging`                      |
| `js/auth.js`     | Google sign-in (popup, redirect fallback), redirect recovery, grant check                                 |
| `js/store.js`    | all Firestore subscriptions and writes                                                                    |
| `js/ui.js`       | `$`/`setText`, network badge, tab router                                                                  |
| `js/screens/*`   | one screen per tab plus settings/notifications panels; together with `app.js`/`ui.js` they own DOM writes |

Screens never contain business rules that belong in a pure module; pure modules never import DOM or Firebase. This is the main testability boundary.

### Store and screens

- `store.js` owns `status/current`, `status/config`, `settings/current`, `schedule/current` (snapshot with metadata), `commands` (recent + pending windows), `history/{date}` and `sessions` reads, and writes for settings, schedule, commands and FCM tokens.
- **Status** keeps the latest snapshot, schedule and settings; a 1 s ticker runs only while the Status tab is selected; the pulse is gated by `liveCharging`; command feedback lasts 5 min; Stop freezes the clock until a genuinely new write.
- **Settings** holds draft rows, a confirmed baseline and an optional pending snapshot. Flags: dirty/saving/waiting/saved/error. Offline saves are refused before the write; a timeout enters "waiting" with late reconciliation; a failure rolls back to the newest server snapshot. The rate editor is season-first: periods are month or date scopes, windows live inside them, scope edits apply immediately, coverage tables show each period's own windows with sibling periods named, and a draft-live checker shows the effective result. The fallback is a non-season line; a season rate is shown as one all-day row. The stored shape and matching are unchanged.
- **Schedule** separates confirmed vs draft, supports optimistic queued writes, a queued-from-snapshot flag, unconfirmed-save handling, discard baseline reads and remote notices. A schedule can be disabled even if its rules are invalid.
- **History** uses one-shot reads for the 30-day series and recent sessions (not listeners), tracks provenance separately, never paints cached/stale data as current, and rechecks midnight while open.
- **Advanced** requires a per-visit confirmation gate and shows a 20-entry RAPI scrollback.
- **Notifications** is a card state machine (`checking/unsupported/no-vapid/denied/granted/default`) backed by the DOM-free token lifecycle.

### Settings save state machine

The settings editor is the most stateful screen. The flow is:

1. A draft is compared to the confirmed snapshot as parsed values, not text.
2. A save validates the document plus the rate rows; invalid input paints field errors and focuses the first problem.
3. Offline → refuse before incrementing the write generation.
4. Write → `settleWrite`; a timeout re-enables the form in a "waiting" state while the write continues.
5. Success adopts the sent values and the latest remote echo; failure rolls back to the newest confirmed snapshot; a late settlement is generation-guarded so the first outcome wins.

Any future editor (including #58) must preserve these semantics.

### Offline, service worker and push

- `web/sw.js` is a plain service worker with no Firebase SDK. `CACHE` is currently `chelevse-v35`; `SHELL` lists every runtime `web/js/**` module plus the root assets. `test/web/sw-shell.test.js` fails if a module is missing, duplicated, or if `CACHE` is malformed.
- Fetch is cache-first for same-origin GETs, except `firebase-config.js`, which is deliberately network-only. Navigation falls back to `index.html`; other failures return 503. Cross-origin/Firebase requests always go to the network.
- Install precaches the shell and `skipWaiting`; activate deletes old caches and `clients.claim`; the page reloads once on `controllerchange` only if a controller already existed. **Any shell change must bump `CACHE`**, or existing clients keep the old modules.
- Firestore uses its persistent cache with a multi-tab manager and an in-memory fallback. A cold reload still needs the network for the SDK and `firebase-config.js`.
- Push: FCM sends a notification-only message; the worker shows the system notification or posts `chelevse-push` to a visible page for exactly one in-app toast. The page dedupes against the SDK's defensive `onMessage` within 5 s. `pushsubscriptionchange` asks open pages to re-acquire and re-save the token; a token rotation therefore recovers without user action. The bridge prunes invalid tokens.

## 7. Firebase platform and security

### Auth and allowlist

- Firebase Auth with Google Sign-In. Anyone can authenticate; data access requires a `users/{uid}` grant with `allowed == true` **and** a verified email.
- `private/acl.txt` (one email per line) is the owner-managed allowlist. `pi/acl.py` syncs it to grant docs with the Admin SDK; `--prune` removes grants and their FCM tokens. A person must sign in once before they can be granted (the auth user must exist).

### Rules boundaries

| Path                                             | Rules                                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}`                                    | read own only; write `false`                                                                                                  |
| `status/{doc}`, `history/{day}`, `sessions/{id}` | read allowlisted; write `false`                                                                                               |
| `schedule/{doc}`                                 | allowlisted write; exact keys `enabled`, `rules`; bool/list/≤20; per-rule shape re-validated by the bridge                    |
| `settings/{doc}`                                 | allowlisted write; `rate` 0–5, `currency` 1–8, optional `rates` list ≤24; per-window shape and overlaps validated client-side |
| `fcmTokens/{token}`                              | read false; create/update own uid with exact keys; delete own doc even after grant revocation                                 |
| `commands/{cmd}`                                 | create allowlisted and `pending`, with one of the four typed shapes; update/delete false                                      |

Rules cannot iterate a list, and per-element checks on the 20/24-entry arrays exceed the 1,000-expression evaluation limit. The design therefore uses **container-only guards** for `schedule.rules` and `settings.rates`, with the app validating before write and the bridge re-validating the schedule it receives. This is a deliberate trade-off, not an oversight.

### Hosting and indexes

- Hosting serves `web/` with an SPA rewrite to `index.html`. Every path is served `no-cache, max-age=0, must-revalidate`; there is no per-file split. `Cross-Origin-Opener-Policy: same-origin-allow-popups` supports popup sign-in; COEP is not set.
- One composite index: `commands` by `type` ascending, `created_at` descending, for the Advanced scrollback. The pending-command query and recent-command window use single-field indexes.
- The custom domain `charge.chelydra.dev` points at the `chelevse-906d4` Hosting site; Auth authorized domains must include the Firebase domains and the custom domain.

## 8. Deployment and operations

### Project and credentials

- Firebase project **`chelevse`** (`.firebaserc` default). Never deploy ChelEVSE to `boxedturtle-30096`.
- Bridge key: `private/service-account.json` (Cloud Datastore User, Firebase Auth Viewer, FCM Admin).
- Deploy key: `private/chelevse-deploy-service-account.json` (Firebase Admin, Datastore Index Admin). The README/DEPLOY examples still name `private/deploy-service-account.json`; the operator convention and the file actually present are the explicit `chelevse-` name.
- Web config: `web/firebase-config.js`, gitignored.

### Deploy pipeline

`npm run deploy:*` scripts each run `scripts/check-firebase-project.mjs` first. The guard resolves the target from `FIREBASE_PROJECT` or `.firebaserc`, resolves the key from `GOOGLE_APPLICATION_CREDENTIALS` or `private/service-account.json`, and blocks a mismatch. **Caveat:** with no key present the guard warns and exits 0, so a deploy is only truly guarded when credentials resolve.

- `deploy:dry-run` compiles rules and validates the release without publishing.
- Rules first, then indexes (wait for the index to build), then hosting. `npm run deploy` does all three.
- Deploy from `main` after the merge, never from a feature branch; no `--force`. Fix forward on a branch.

### Pi deployment

`sudo bash pi/install.sh` is the only supported path. It rsyncs `pi/` (with `--delete`) and `private/` (without `--delete`) to `/opt/chelevse`, builds/updates the venv, installs the unit and restarts the service. It is idempotent. Do not hand-edit `/opt/chelevse`.

### Failure modes

| Failure              | Behaviour                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi offline           | PWA shows stale `updated_at` / bridge-offline treatment; no status writes for ~60 s                                                                                       |
| Charger unreachable  | Bridge retries, writes `charger_online: false`, distinguishes charger-offline from bridge-offline; watchdog restarts over HTTP or MQTT and alerts when neither path works |
| MQTT broker down     | Bridge logs one transition, resumes 10 s HTTP polling, records `source: "http"`; the charger publishes into the void without affecting charging                           |
| Firebase blip        | SDKs reconnect; bridge retries failed writes next tick; history baselines advance only after a successful write                                                           |
| PWA offline          | Loaded app works from the Firestore cache and SW shell; cold reload needs the network (SDK/config are network-only)                                                       |
| Stale deployed shell | Shell is cache-first; a shell change must bump `CACHE`; an open tab keeps old modules until reload                                                                        |
| Index building       | Advanced reports `failed-precondition` until Firestore reports the index ready                                                                                            |

## 9. Testing and quality gates

| Suite | Command                                                | Current size | Scope                                                                                        |
| ----- | ------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------- |
| Web   | `npm test`                                             | 190 tests    | pure modules, store helpers, router, SW shell, DOM-stub status pulse; no browser or Firebase |
| Rules | `npm run test:rules`                                   | 34 tests     | emulator `demo-chelevse`; command/auth/schedule/settings/FCM shapes                          |
| Pi    | `pi/.venv/bin/python -m unittest discover -s pi/tests` | 267 tests    | bridge parsing, commands, MQTT, schedule, history, sessions, watchdog, ACL; in-memory fakes  |

- **No CI.** Gates are local and operator-enforced: hooks (Prettier pre-commit/pre-push), full test runs, a reviewed head SHA, and squash merges with `--match-head-commit`.
- The browser harness under `/tmp/opencode/chelevse-preview` is an ephemeral manual/preview tool; it is not part of the repo and must not be a merge dependency.
- Rules coverage has gaps: `status`/`history`/`sessions` reads and `users` self-read are not directly tested; `settings` rate bounds are only partly covered; command-create coverage is concentrated on `rapi`, not `pause`/`resume`/`set_current`.

## 10. Key decisions

| Decision                                      | Rationale                                                                                                                      | Consequence                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Serverless Firebase over a custom backend     | Firestore listeners give realtime updates with no server code; free tier is ample; a native client can reuse the contract      | Rules are the security boundary; client validation is UX, not enforcement                                         |
| Raspberry Pi bridge                           | The ESP32 firmware has no Firebase client; a LAN bridge covers status **and** control without a cloud broker                   | One always-on host; service-account key on the Pi; no inbound ports                                               |
| MQTT-first status and commands, HTTP fallback | The firmware publishes per-field topics and accepts native commands; latency drops to seconds and polling drops to a reconcile | Broker on the Pi; `MQTT_ENABLED=false` is the rollback; HTTP remains for config, plan, commissioning and counters |
| Firestore as the API                          | Both bridge and PWA speak the same documents; no RPC surface to version                                                        | Additive schema evolution; no migrations; document shapes are the contract                                        |
| Flat rate as fallback, schedule optional      | Existing configs keep working; costs stay meaningful when no window matches                                                    | `rates` is optional; flat payloads are byte-identical; aggregate history cost is hidden when a schedule exists    |
| Read-time pricing                             | Changing a tariff must re-price history immediately; no stale persisted costs                                                  | Costs are approximate where sessions lack interval energy (#57)                                                   |
| Local wall clock                              | Tariffs and schedules are expressed in the owner's local time, including DST                                                   | All boundary logic uses local `Date` helpers; day numbering is explicit (`0=Mon`)                                 |
| Presentation-only TOU refresh                 | Seasons can be made legible without a schema migration (#58, shipped in #63)                                                   | Grouping/periods are derived from month scopes; window order and semantics are preserved                          |
| No build step / plain ES modules              | The app is small, auditable, and deployable as static files                                                                    | Manual module wiring; SW shell list must be maintained; cache bumps are mandatory                                 |

## 11. Known gaps and future work

- **Charging intervals (#57):** sessions store aggregate `wh`/`elapsed`, so paused-then-resumed sessions are costed over the plug-in span. Record per-interval energy in the bridge and price intervals when present; keep uniform pro-rating as the legacy fallback.
- **TOU/seasonality editor (#58):** shipped in #63. Season-first periods (month scopes), immediate month apply, own/effective coverage tables with named sibling periods, a non-season fallback line and a draft-live checker. Stored shape and pricing semantics unchanged. Residual: the settings form's `addEventListener('submit')` binding is covered only by the external harness, not an in-repo DOM test.
- **OTA is not implemented.** The bridge has no firmware upload/version/rollback path. `ARCHITECTURE.md` and `docs/DEPLOY.md` historically described OTA as an HTTP responsibility; treat firmware updates as manual until the code exists.
- **Deploy guard is weak without a key:** `check-firebase-project.mjs` warns and exits 0 when no credentials resolve. Deploy commands in README/DEPLOY also use a key filename that differs from the operator convention.
- **Rules test coverage:** add read-authorization tests for `status`, `history`, `sessions` and `users`; the core data paths are currently unexercised.
- **Command hardening:** rules do not require `created_at` or reject extra keys; the bridge treats a missing/malformed `created_at` as not stale, so a crafted pending doc can bypass the 10-minute sweep and sit indefinitely. There is no command claim/lease, so two bridge instances would double-apply.
- **Settings listener error handling:** `settings/current` has no error callback; a permission/backend failure leaves the card silently empty instead of showing an error.
- **Single-bridge assumptions:** session upsert is read-then-write (not transactional), schedule sync uses a digest, and watchdog counters are process-local. These are acceptable for one Pi but not for HA.
- **Bridge runs as root.** The unit is `User=root`; a dedicated service user with access to `private/` and the charger would reduce blast radius.
- **History retention:** `history/*` and `sessions/*` grow without pruning; the UI only reads 30 days / 20 sessions.
- **Docs drift:** `docs/DEPLOY.md` still mentions OTA; README/DEPLOY deploy-key filenames differ from `AGENTS.md`; `firestore.rules` still carries a stale comment about schedule validation landing later; README’s paused-session note cites #37, the scope that accepted the approximation, while #57 is the charging-interval follow-up.

## 12. Glossary

| Term                | Meaning                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Fallback rate**   | `settings/current.rate`; prices every local instant no rate window covers                                       |
| **Rate window**     | One entry in `settings/current.rates`: price + weekday set + local time range + month set or date bounds        |
| **Season rate**     | An all-day, every-day window: one price for every hour of its season (no new field)                             |
| **Period / season** | A presentation grouping of windows that share a month or date scope; not persisted (`#58` design)               |
| **Live cost**       | Scheduled cost for the current session, anchored to `status.updated_at − elapsed` and shown only while charging |
| **Aggregate cost**  | Daily/30-day cost from one kWh total; hidden when a schedule exists                                             |
| **MQTT source**     | The bridge's optional event-driven status/command path; HTTP is the reconciler and fallback                     |
| **Transport**       | `mqtt` or `http`, recorded on a command when the bridge actually sent it                                        |
| **Bridge stale**    | No status write for a threshold; distinct from charger offline                                                  |
| **Grant**           | `users/{uid}` doc with `allowed: true`; the allowlist primitive                                                 |
| **SHELL**           | The service-worker precache list; any change requires a `CACHE` bump                                            |
