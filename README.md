# ChelEVSE

Personal OpenEVSE monitoring & control — a Raspberry Pi on the home LAN bridges an OpenEVSE charger to Firebase, and an installable PWA gives you realtime status and basic control from anywhere.

**Status: scaffolding** — this repo currently contains the design; components land as separate commits. See [ARCHITECTURE.md](ARCHITECTURE.md).

## What it does

- **Monitor**: live charger status (state, current draw, session/total energy, temperature) from anywhere — not just the home LAN.
- **Control**: pause/resume charging (stop/start) and set the max charge current from your phone.
- **History**: daily kWh graph (last 30 days) and per-session records.
- **Schedule**: time-of-use charging windows, enforced by the charger itself.
- **Alerts**: push notifications when charging starts/stops or the bridge goes offline.
- **Costs**: session and daily energy cost at your electricity rate.
- **Parity**: everything the charger's built-in web UI shows — full status detail, config view, plus a gated RAPI console for advanced changes.
- **Simple**: no backend server to write or run — Firebase Firestore carries the data, Firebase Hosting serves the app, free tier covers a household many times over.

## How it works

1. **Bridge agent** (`pi/`) — a small Python service on the Raspberry Pi. Polls the charger's local HTTP API and writes status to Firestore; watches Firestore for commands and applies them to the charger.
2. **Firebase** — Firestore holds the latest status snapshot and the command queue; security rules + Firebase Auth gate access. Hosting serves the web app.
3. **Android app (PWA)** — a static web app you install to your home screen. Signs in with Firebase Auth, gets **realtime updates** via Firestore listeners (no polling), and writes commands. A native Android app can later use the exact same Firestore.

## Repository layout

| Path                                 | Purpose                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| `pi/`                                | Raspberry Pi bridge agent (Python)                            |
| `web/`                               | PWA served by Firebase Hosting                                |
| `firebase.json`, `firestore.rules`   | Firebase project config + security rules                      |
| `private.example/`                   | Committed template for deployment config                      |
| `private/`, `web/firebase-config.js` | Your real deployment values — **gitignored, never committed** |

## Security model

- The repo is **public**; every deployment value (service-account key, Firebase config, charger IP) lives in gitignored files. See `private.example/`.
- Access control is Google Sign-In (Firebase Auth) plus an owner-managed allowlist: `private/acl.txt` (gitignored) is synced to Firestore grant docs by a script on the Pi, and rules only serve data to granted users. Commands are whitelisted and validated; only the bridge's service account writes status/history.
- No inbound connections to the home network — the Pi only makes outbound requests.

## Getting started

```bash
cp -r private.example private
cp web/firebase-config.example.js web/firebase-config.js
# fill in real values — see private.example/README.md
```

Setup guides for the bridge and the web app ship with their components (`pi/`, `web/`).

## Development

One-time: `npm install` (installs Prettier and points git at `.githooks/`). pre-commit
blocks unformatted staged files; pre-push runs a full `prettier --check .`. Hooks no-op
gracefully where Node isn't installed (e.g. on the Pi) — run `npm run format` before
pushing from such a machine if you touched web/docs files.
