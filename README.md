# ChelEVSE

Personal OpenEVSE monitoring & control — a Raspberry Pi on the home LAN bridges an OpenEVSE charger to Firebase, and an installable PWA gives you realtime status and control from anywhere.

**Status: v1 shipped** — the bridge, the five-tab PWA and the Firebase deployment are implemented. Stand up your own with [docs/DEPLOY.md](docs/DEPLOY.md); validate it with [docs/VALIDATION.md](docs/VALIDATION.md). Design notes live in [ARCHITECTURE.md](ARCHITECTURE.md).

## What it does

- **Monitor**: live charger status (state, current draw, power, session/total energy, temperatures, setpoint) from anywhere — not just the home LAN.
- **Control**: stop, return to auto, or hold at a chosen current (6–48 A) from your phone.
- **History**: daily kWh chart for the last 30 days and the 20 most recent charging sessions, with cost at your electricity rate.
- **Schedule**: time-of-use charging windows (up to 20), enforced by the charger's own firmware, with a live "window active now" badge.
- **Alerts**: push notifications when charging starts/stops or the charger goes offline — background notifications with the app closed, one in-app toast when it is open.
- **Config parity**: every charger setting the firmware exposes (credentials redacted), app settings for rate/currency and the rate schedule, notification opt-in, and a gated RAPI console for anything the curated screens don't cover.
- **Simple**: no backend server to write or run — Firestore carries the data, Hosting serves the app, the free tier covers a household many times over.

## Screens

| Tab          | What it shows                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**   | Live figures, session energy + cost + elapsed, temperatures, setpoint, schedule badge, and the charging controls.                     |
| **History**  | 30-day daily-energy chart (hand-rolled SVG) and recent sessions, each flagged when served from cache or offline.                      |
| **Schedule** | Enable toggle and window editor with per-field validation, optimistic save, and the charger's live window state.                      |
| **Config**   | Charger configuration with secrets redacted, App settings (fallback rate, rate schedule, currency), and the notification opt-in card. |
| **Advanced** | RAPI console with a per-visit confirmation gate and a 20-entry scrollback showing acked/failed results.                               |

## Electricity rates

App settings hold an optional **rate schedule** on top of the fallback rate:

- The **fallback rate** prices every moment no window covers, so a flat rate keeps working with no
  schedule at all.
- A **rate window** sets a rate for a set of weekdays, a local `HH:MM` start and end, and either the
  whole year or a month range. Up to 24 windows.
- Weekdays use `0` = Monday … `6` = Sunday, the same convention as the charging schedule. The editor
  shows the day names, so the numbers only matter in the stored document.
- Times are local wall clock. An end at or before the start wraps past midnight (22:00 → 06:00 is a
  night window), and a window's after-midnight hours belong to the day it started.
- A month range is inclusive and may wrap the year: November → February means November, December,
  January and February. "All year" stores no month limit.
- Windows must not overlap. Two windows that share a day, a month and a time would make the rate
  ambiguous, so the editor rejects the schedule instead of silently choosing one. A document written
  outside the editor (hand-edited, or by an older client) can still hold overlaps: there the **last
  matching window wins**, and the editor asks you to resolve the overlap before it will save again.
- Saving writes the fallback rate, currency, and the window list. With no windows, the document keeps
  exactly its two flat fields.

### How costs are worked out

Costs are calculated whenever a screen is shown, never saved, so editing the schedule re-prices the
live session and the whole history immediately.

- **Live session** cost covers the snapshot's `updated_at - elapsed` to `updated_at`, and only while
  the charger reports **charging**. A paused, ready or cached snapshot hides the scheduled figure
  instead of re-pricing the interval against a later clock, so idle hours that added no energy are
  never priced. The figure is also hidden while the charger is **offline**: the bridge keeps the last
  known state and elapsed but refreshes `updated_at` on every failed poll, so under the "Charger
  offline" banner the last known energy is shown without a scheduled cost. Until it reports a
  positive elapsed time the scheduled cost stays hidden (there is no interval to price yet). For a
  flat rate the figure is still `kWh × rate`, exactly as before.
- **History session** costs use the session's own stored start and end.
- **Uniform pro-rating (approximation).** Sessions store one energy total, not the energy drawn in
  each window. Each slice between rate boundaries is assumed to have drawn energy in proportion to
  its share of the session's duration. A charge that ramps up inside one window is therefore priced
  slightly off; the alternative would require per-window energy from the bridge.
- **Paused sessions: cost is pro-rated over the plug-in span, not the charging intervals.** The
  bridge keeps one record per plug-in, so a session that paused and resumed stores a span that
  includes the idle gap while `wh` and `elapsed` describe charging only. The pro-rating above cannot
  separate the two, so such a session can read under or over its true cost (the error is bounded by
  the rate difference across the gap). Issue #37 accepts this as the best available signal until the
  bridge stores the real charging intervals.
- **The 30-day total and the daily bar cost are hidden when a schedule exists**, because a history
  document holds a single kWh figure per day and it cannot be split across the windows it was drawn
  in. Energy (kWh) stays visible, per-session costs are still shown, and one line under the summary
  says so. With no schedule, every total and bar cost is exactly what it was before schedules
  existed.

## How it works

1. **Bridge agent** (`pi/`) — a small Python service on the Raspberry Pi. Polls the charger's local HTTP API and writes status, config, history and sessions to Firestore; mirrors the schedule into the charger's scheduler; watches Firestore for commands and applies them; sends FCM notifications on state transitions.
2. **Firebase** — Firestore holds the status snapshot, history, sessions, schedule, settings, push tokens and the command queue; security rules + Firebase Auth gate access. Hosting serves the web app.
3. **Android app (PWA)** — a static web app you install to your home screen. Signs in with Firebase Auth, gets **realtime updates** via Firestore listeners (no polling), and writes commands. A native Android app can later use the exact same Firestore.

## Repository layout

| Path                                                         | Purpose                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `pi/`                                                        | Raspberry Pi bridge agent (Python) + installer + ACL helper                     |
| `web/`                                                       | PWA served by Firebase Hosting (no build step)                                  |
| `docs/`                                                      | [Deploy runbook](docs/DEPLOY.md) and [validation checklist](docs/VALIDATION.md) |
| `firebase.json`, `firestore.rules`, `firestore.indexes.json` | Firebase project config, security rules and indexes                             |
| `scripts/`                                                   | Deploy guard (`check-firebase-project.mjs`)                                     |
| `test/`                                                      | Web unit tests and Firestore rules tests                                        |
| `private.example/`                                           | Committed template for deployment config                                        |
| `private/`, `web/firebase-config.js`                         | Your real deployment values — **gitignored, never committed**                   |

## Security model

- The repo is **public**; every deployment value (service-account key, Firebase config, charger IP) lives in gitignored files. See `private.example/`.
- Access control is Google Sign-In (Firebase Auth) plus an owner-managed allowlist: `private/acl.txt` (gitignored) is synced to Firestore grant docs by `pi/acl.py`, and rules only serve data to granted users. Commands are whitelisted and validated; only the bridge's service account writes status/history.
- Deploys are guarded: `scripts/check-firebase-project.mjs` refuses a release whose target project and service-account key disagree.
- No inbound connections to the home network — the Pi only makes outbound requests.

## Getting started

The full runbook is [docs/DEPLOY.md](docs/DEPLOY.md). In short:

```bash
npm install                                  # Node 20+; installs the Firebase CLI
cp -r private.example private                # then fill in the real values
cp private/bridge.env.example private/bridge.env
cp private/acl.txt.example private/acl.txt
cp web/firebase-config.example.js web/firebase-config.js
export FIREBASE_PROJECT=<project-id>
export GOOGLE_APPLICATION_CREDENTIALS=private/deploy-service-account.json
npm run deploy:dry-run && npm run deploy
sudo bash pi/install.sh                      # on the Pi
```

Then sign in once, add that address to `private/acl.txt`, and run `pi/.venv/bin/python pi/acl.py` (or the installer's venv on the Pi). [docs/DEPLOY.md](docs/DEPLOY.md) covers the console setup, service-account roles, VAPID key, indexes, the custom domain and troubleshooting.

## Development

One-time: `npm install` (installs Prettier and the Firebase CLI, and points git at
`.githooks/`). pre-commit blocks unformatted staged files; pre-push runs a full
`prettier --check .`. Hooks no-op gracefully where Node isn't installed (e.g. on
the Pi) — run `npm run format` before pushing from such a machine if you touched
web/docs files.

```bash
npm test           # web unit tests (node:test, no browser or Firebase needed)
npm run test:rules # Firestore rules tests in the emulator (needs Java 11+)
npm run format      # write Prettier formatting
npm run format:check
```

Deployment is part of the development flow:

```bash
npm run deploy:dry-run   # compile rules, validate the release, publish nothing
npm run deploy:rules     # firestore.rules
npm run deploy:indexes   # firestore.indexes.json (one composite index)
npm run deploy:hosting   # web/
npm run deploy           # all three
```

Each `deploy*` script first runs the guard, which blocks when
`FIREBASE_PROJECT` (or `.firebaserc`) and the key in
`GOOGLE_APPLICATION_CREDENTIALS` / `private/service-account.json` belong to
different projects. Never bypass it with raw `firebase deploy --force`.
