# ChelEVSE

Personal OpenEVSE monitoring & control — a Raspberry Pi on the home LAN bridges an OpenEVSE charger to Firebase, and an installable PWA gives you realtime status and control from anywhere.

**Status: v1 shipped** — the bridge, the five-tab PWA and the Firebase deployment are implemented. Stand up your own with [docs/DEPLOY.md](docs/DEPLOY.md); validate it with [docs/VALIDATION.md](docs/VALIDATION.md). Design notes live in [ARCHITECTURE.md](ARCHITECTURE.md).

## What it does

- **Monitor**: live charger status (state, current draw, power, session/total energy, temperatures, setpoint) from anywhere — not just the home LAN.
- **Control**: stop, return to auto, or hold at a chosen current (6–48 A) from your phone.
- **History**: daily kWh chart for the last 30 days and the 20 most recent charging sessions, with cost at your electricity rate.
- **Schedule**: time-of-use charging windows (up to 20), enforced by the charger's own firmware, with a live "window active now" badge.
- **Alerts**: push notifications when charging starts/stops or the charger goes offline — background notifications with the app closed, one in-app toast when it is open.
- **Config parity**: every charger setting the firmware exposes (credentials redacted), app settings for One rate or Seasons & time-of-use (base rates, daily windows, dates, currency), notification opt-in, and a gated RAPI console for anything the curated screens don't cover.
- **Simple**: no backend server to write or run — Firestore carries the data, Hosting serves the app, the free tier covers a household many times over.

## Screens

| Tab          | What it shows                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**   | Live figures, session energy + cost + elapsed, temperatures, setpoint, schedule badge, and the charging controls.                                                           |
| **History**  | 30-day daily-energy chart (hand-rolled SVG) and recent sessions, each flagged when served from cache or offline.                                                            |
| **Schedule** | Enable toggle and window editor with per-field validation, optimistic save, and the charger's live window state.                                                            |
| **Config**   | Charger configuration with secrets redacted, App settings (One rate / Seasons & time-of-use, base rates, daily windows, dates, currency), and the notification opt-in card. |
| **Advanced** | RAPI console with a per-visit confirmation gate and a 20-entry scrollback showing acked/failed results.                                                                     |

## Electricity rates

App settings have two explicit modes. **One rate** is a single flat price and no schedule. **Seasons &
time-of-use** turns the same form into a list of seasons, each with a base price and optional daily
windows. The stored flat rate stays in the document, but is used for pricing only when there is no
schedule.

- **One rate** shows the flat rate and the shared currency. The plan is hidden. Switching to
  **Seasons & time-of-use** is offered only while the flat rate is valid; it seeds one visible
  **All-year** base at that rate, opens the season and focuses **Base rate**. Switching back asks
  to confirm what will be removed; it reuses the single All-year base price when the plan is exactly
  that, otherwise the stored flat rate.
- **Every season opens with Season dates**, above its base and windows: **Starts** and **Ends** use
  native date pickers, with **All year** beside the heading and **Edit dates** on a collapsed header.
  The season repeats every year; the year in the picker is only a reference year (2024 includes 29
  February). Only the month and day are stored. Bounds are inclusive, may wrap the year and may be a
  single day. A range whose end is before its start shows a wrap hint and `(wraps)` wherever it
  appears.
- **All year** clears the start and end dates and stores no month limit. While checked, the pickers
  are replaced by a read-only “All year — every day of the year” value. Unchecking it seeds the
  current month as a real date range. An invalid stored date (for example 30 February) is shown as a
  stored value beside the error and blocks saving until corrected.
- **Months are advanced**, under **Advanced: month ranges** inside Season dates. A legacy month
  scope still loads with its month chips, and its date controls show the derived first and last day
  with a “stored as a month range” note. Editing a date makes the season day-precise; editing a
  month chip rounds it back to whole months. A non-contiguous month set such as January + June cannot
  be represented by one start/end pair: the date fields give way to a short “No single start and
  end” note and the month editor opens for editing. All year is the canonical no-month state
  (`months: null`).
- Editing a date applies to every row in the season at once. The season repaints in place, so the
  Tab or click that ended the edit is delivered — opening **Advanced**, **All year** or **Duplicate**
  works on the first press. A commit that merges or splits the season rebuilds on the next task and
  returns focus to that season's own date control.
- **Base rate** is one price for every hour the season's daily windows do not override. It is stored
  as an ordinary all-day, every-day row (`days: [0..6]`, `start === end`), with no new field. A
  season with only a base is a single price for the whole season; a season can also have a base plus
  daily windows, or daily windows with no base.
- A **daily window** sets a price for a set of weekdays and a local `HH:MM` start and end, and
  overrides the base for those hours. **Add window** is always available, up to 24 rows. Day presets
  (Every day / Weekdays / Weekends) are shortcuts over the same weekday set; Custom reveals the
  individual day chips. A window whose start equals its end is **All day**; the editor shows that
  instead of `00:00 → 00:00`, and the table shows 00:00–24:00. **Set times** reveals the stored
  start and end without inventing hours.
- **Uncovered dates cost 0.00.** A line under the seasons lists the dates no season covers and
  offers **Fill N gaps**. Filling creates an empty base season for each gap, opens the first one and
  focuses its base rate; nothing is silently repriced. With every date covered and a base already
  present, **Add a season** is disabled and the reason is printed beside it (edit a season's dates to
  make room); it is never silently absent. A season with windows but no base shows “No base rate —
  hours outside the windows have no price” and **Add base rate**; adding it uses the stored One rate
  value, visibly. If another season's base already overlaps those dates, the add action is withheld
  because two bases on one date are invalid.
- **Switching One rate → Seasons seeds the current month**, not the whole year: the flat price
  becomes a date-bounded base season, a note says so, the rest of the year stays an uncovered gap
  (0.00 until covered) and **Add a season** is immediately usable for a Summer/Winter split.
- **Warnings do not block Save.** Uncovered dates, a base-less season and a base-less hour are
  warnings, not errors. Saving stays enabled, and the checker and history say which moments are
  0.00. An empty base or invalid row is a normal field error and does block Save.
- **Duplicate** copies a season's rows into the rest of the year in one action: the months it does
  not cover, or the single date range a date season leaves (Summer Jun 15–Sep 15 becomes Winter
  Sep 16–Jun 14). It is only offered when that complement is free and the copy stays within the
  24-row limit.
- **Layering, not a partition.** A day can carry rows from more than one season (for example an
  every-month overnight window plus a November–February peak). A base prices its season's ordinary
  hours; a daily window overrides it. A base from any season covers every hour of its dates, so it
  can price another season's base-less hours. Two bases that cover the same date are rejected, as are
  two daily windows that collide.
- **Price bands** (Peak / Off-peak / Shoulder / Same price) are derived for display from the
  season's own base and override prices; no band or season name is stored. A base row is always
  labelled **Base**, never a relative tier. The strip legend, table and checker read the same
  resolved rows.
- **What applies at** checks a local date and time against the current draft — saved or not — and
  names what prices it. A base reads `Base · Jun 15–Sep 15`; an override reads its day/time summary
  and scope (`Weekdays · 16:00–19:00 · Jun 15–Sep 15`); no row at all reads `Uncovered date — no
season covers this date — priced at 0.00.`; a season with no base or window for that hour reads
  `Uncovered hour — this season has no price for this hour — 0.00.` **Now** fills in the current
  moment. A definitive answer is withheld while a row is incomplete or two rows collide; the checker
  points back to the blocking fields and asks for the rate when that is the only missing value.
- The plan summary names the number of seasons and rates, the advertised range and any uncovered
  dates (`2 seasons · 3 rates · USD 0.00–0.40 · 1 gap`). The range includes 0 whenever some instant
  is unpriced. The save row still carries `N to fix` for errors; warnings never add to that count.

The stored document is unchanged: one flat `rates` list. A month row keeps
`{ id, rate, days, start, end, months }`. A date row adds `from` and `to` (`MM-DD`, inclusive)
after `months`; `months` remains the coarse compatibility hint derived on write, so an older client
still knows roughly when the season applies. A base is exactly an all-day, every-day row, so no
schema key is added. All year stores `months: null` and no dates. There is no migration, no new
field, and payload order is preserved. A flat configuration still writes exactly `{ rate, currency }`
with no `rates` key.

Technical rules:

- Weekdays use `0` = Monday … `6` = Sunday, the same convention as the charging schedule. The editor
  shows the day names, so the numbers only matter in the stored document.
- Times are local wall clock. An end at or before the start wraps past midnight (22:00 → 06:00 is a
  night window), and a window's after-midnight hours belong to the day it started. A date season is
  evaluated on that starting day, so a 22:00 window on 14 June still belongs to 14 June when it runs
  into 15 June.
- A month scope is an inclusive list that may wrap the year: November → February means November,
  December, January and February. A non-contiguous list such as January + June is valid and is shown
  as month chips, not repaired. "All year" stores no month limit (`null`).
- Date matching compares `MM-DD` keys on the local calendar. The editor uses native date pickers with
  2024 as a reference year; only the month and day are stored. Bounds are inclusive; `from === to`
  is a single day; a reversed range wraps. Leap day is a real annual day (the stored ring always
  includes 29 February); a non-leap year simply has no instant there.
- Resolution is **override → season base → 0**. The stored flat rate applies only when `rates` is
  empty. A row's after-midnight tail uses the season of the day it started. The last matching row
  within each tier is the deterministic tie-break for a hand-edited overlap, but the editor rejects
  same-tier collisions: two bases on one date, or two daily windows that can both match one instant.
  A base plus a daily window is the supported model, not a collision.
- A malformed stored row stays visible with its error and blocks saving until it is fixed or
  removed; loading never deletes or repairs it. A non-contiguous legacy month scope stays editable in
  Advanced: month ranges.
- Saving writes the stored flat rate, currency, and the row list in its original order. With no
  rows, the document keeps exactly its two flat fields. Changing a date or month applies to every row
  in that season; the payload never reorders rows.

### How costs are worked out

Costs are calculated whenever a screen is shown, never saved, so editing the plan re-prices the
live session and the whole history immediately.

- **Live session** cost covers the snapshot's `updated_at - elapsed` to `updated_at`, and only while
  the charger reports **charging**. A paused or ready snapshot hides the scheduled figure instead of
  re-pricing the interval against a later clock, so idle hours that added no energy are never
  priced. A stale snapshot — a cached read that still says `charging` with `charger_online: true` —
  keeps the cost frozen at that snapshot's own interval: the figure is anchored to the write, so it
  does not slide as the clock moves on. The figure is also hidden while the charger is **offline**:
  the bridge keeps the last known state and elapsed but refreshes `updated_at` on every failed poll,
  so under the "Charger offline" banner the last known energy is shown without a scheduled cost.
  Until it reports a positive elapsed time the scheduled cost stays hidden (there is no interval to
  price yet). For a flat rate the figure is still `kWh × rate`, exactly as before. When any slice
  of the live interval has no base/window price, that slice costs 0.00 and the figure gains a
  warning-coloured **understates cost** line (tooltip: the 0.00 slices); the figure is not hidden.
- **History session** costs use the session's own stored start and end. A schedule with any
  unpriced dates or base-less hours also shows a plan banner above history saying those moments are
  shown at 0.00, with a link back to settings.
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
- **The 30-day total and the daily bar cost are hidden when a rate plan exists**, because a history
  document holds a single kWh figure per day and it cannot be split across the windows it was drawn
  in. Energy (kWh) stays visible, per-session costs are still shown, and one line under the summary
  says so; the plan banner additionally flags any 0.00 moments. With no plan, every total and bar
  cost is exactly what it was before rate plans existed.

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
