# ChelEVSE

Personal OpenEVSE monitoring & control — a Raspberry Pi on the home LAN bridges an OpenEVSE charger to Firebase, and an installable PWA gives you realtime status and control from anywhere.

**Status: v1 shipped** — the bridge, the four-tab PWA and the Firebase deployment are implemented. Stand up your own with [docs/DEPLOY.md](docs/DEPLOY.md); validate it with [docs/VALIDATION.md](docs/VALIDATION.md). Design notes live in [ARCHITECTURE.md](ARCHITECTURE.md).

## What it does

- **Monitor**: live charger status (state, current draw, power, session/total energy, setpoint) from anywhere — not just the home LAN.
- **Control**: stop, return to auto, or hold at a current up to the charger's verified soft maximum from your phone.
- **History**: Day / Week / Month / Year energy chart whose periods are calendar units — Day is a date (24 hourly bars), Week an ISO Monday–Sunday week (7 daily bars), Month a calendar month (28–31 daily bars) and Year a calendar year (one bar per month) — that pages back one unit at a time with **Previous**/**Next** or PageUp/PageDown. The unit holding today is clipped at today: this week runs Monday..today, this month 1..today and this year January..this month, so no bar is a future bucket, while a completed October is 1–31 and a completed year December-inclusive; every label and empty/offline message names the unit it shows ("October 2026", "Mon 5 – Sun 11 Oct 2026"). Plus the 20 most recent charging sessions, with cost at your electricity rate. A day recorded before hourly capture began shows its total and says the hours are missing, never 24 empty bars; on the deploy day itself — under One rate — Day counts only the hours recorded after it, while Month and Year use the day's total: expected, and gone the next day.
- **Schedule**: time-of-use charging windows (up to 20), enforced by the charger's own firmware, with a live "window active now" badge.
- **Alerts**: one push when the charger records a critical health fault it has not already flagged, and one when it goes offline — background notifications with the app closed, one in-app toast when it is open. The charger's health is also shown (and acknowledgeable) on the Status screen, and nothing infers safety from a charging state.
- **Config parity**: every charger setting the firmware exposes (credentials redacted), app settings for One rate or Seasons & time-of-use (base rates, daily windows, dates, currency), notification opt-in, and a gated RAPI console for anything the curated screens don't cover.
- **Simple**: no backend server to write or run — Firestore carries the data, Hosting serves the app, the free tier covers a household many times over.

## Screens

| Tab          | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**   | Live figures, session energy + cost + elapsed, setpoint, schedule badge, and the charging controls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **History**  | Day / Week / Month / Year energy chart over calendar units (a date's 24 hourly bars, an ISO week's 7 daily bars, a calendar month's 28–31 daily bars, a calendar year's monthly bars — hand-rolled SVG), pageable with **Previous**/**Next** or PageUp/PageDown one calendar unit at a time, each window named by its own month, week, year or date. The unit holding today is clipped at today — this week Monday..today, this month 1..today, this year January..this month — so no future bar is ever drawn. Recent sessions beside it are flagged when served from cache or offline. Day reads one date's document and a day with no hourly buckets shows its total and says the hours were not recorded. |
| **Settings** | A list of four cards, each opening its own screen with the Settings tab still selected: **Charge schedule** (enable toggle and window editor with per-field validation, optimistic save, and the charger's live window state), **Prices and charger address** (the Charger connection and Electricity price cards: One rate / Seasons & time-of-use, base rates, daily windows, dates, currency), **Notifications** (the opt-in card) and **Charger** (the read-only charger configuration with secrets redacted, Raw JSON, and the way to the Advanced console). Each card shows its saved state in one line.                                                                                                |
| **Advanced** | RAPI console with a per-visit confirmation gate and a 20-entry scrollback showing acked/failed results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Electricity rates

**Electricity price** has two explicit modes. **One rate** is a single flat price and no schedule. **Seasons &
time-of-use** turns the same form into a list of seasons, each with a base price and optional daily
windows. The stored flat rate stays in the document and, once a schedule exists, is also the fallback
price: any instant no row matches — a date outside every season, or an hour a season does not price —
costs that flat rate, and 0.00 only when no finite flat rate is stored.

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
- **Uncovered dates cost your flat rate.** A line under the seasons lists the dates no season covers —
  “Uncovered dates — priced at your flat rate USD 0.12”, or 0.00 when no finite flat rate is stored —
  and offers **Fill N gaps**. Filling creates an empty base season for each gap, opens the first one and
  focuses its base rate; nothing is silently repriced. With every date covered and a base already
  present, **Add a season** is disabled and the reason is printed beside it (edit a season's dates to
  make room); it is never silently absent. A season with windows but no base shows “No base rate —
  hours outside the windows cost your flat rate unless another season's base covers them” (no price at
  all when no finite flat rate is stored) and **Add base rate**; adding it uses the stored One rate
  value, visibly. If another season's base already overlaps those dates, the add action is withheld
  because two bases on one date are invalid.
- **Switching One rate → Seasons seeds the current month**, not the whole year: the flat price
  becomes a date-bounded base season, a note says so, the rest of the year stays an uncovered gap
  (it costs your flat rate until covered) and **Add a season** is immediately usable for a
  Summer/Winter split.
- **Warnings do not block Save.** Uncovered dates, a base-less season and a base-less hour are
  warnings, not errors. Saving stays enabled, and the checker and history say which moments fall
  outside every window and what they cost — your flat rate, or 0.00 when no finite flat rate is
  stored. An empty base or invalid row is a normal field error and does block Save.
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
season covers this date — priced at your flat rate USD 0.12.`; a season with no base or window for
  that hour reads `Uncovered hour — this season has no price for this hour — your flat rate USD 0.12.`
  (both 0.00 when no finite flat rate is stored). **Now** fills in the current
  moment. A definitive answer is withheld while a row is incomplete or two rows collide; the checker
  points back to the blocking fields and asks for the rate when that is the only missing value.
- The plan summary names the number of seasons and rates, the advertised range and any uncovered
  dates (`2 seasons · 3 rates · USD 0.00–0.40 · 1 gap`). The range unions the flat rate in whenever
  some instant is uncovered — exactly what those hours cost — and includes 0.00 only when no finite
  flat rate is stored. The save row still carries `N to fix` for errors; warnings never add to that
  count.

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
- Resolution is **override → season base → the stored flat rate**. An instant no row matches — a
  date outside every season, or an hour a season does not price — costs the stored flat rate whether
  or not rows exist; it is 0.00 only when rows exist, none matches, and no finite flat rate is
  stored. A row's after-midnight tail uses the season of the day it started. The last matching row
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
  of the live interval has no base/window price, that slice costs the stored flat rate, and a
  subdued line under the figure names it — `part at your flat rate GBP 0.30` (#193); only when no
  finite flat rate is stored does the slice cost 0.00 and the line become the warning-coloured
  **understates cost** one (tooltip: the 0.00 slices). The figure is not hidden either way.
- **History session** costs use the session's own charging intervals when it has them: each
  contiguous charging block is priced over its own start and end, so a top-up at 03:00 stays at the
  off-peak price even though the plug-in began the previous evening. The intervals are only trusted
  when they add up to the session's energy total within `max(250 Wh, 2%)` — the band that allows for
  the one legitimate shortfall (the first charging tick supplies the counter baseline only). Anything
  else falls back to the whole stored span, byte-identically to a session with no intervals: a
  mid-charge bridge restart leaves the pre-restart energy in the total and in no interval, and a
  counter reset or a dropped implausible reading can make the intervals disagree in either
  direction. When a usable interval list cannot be priced (a malformed timestamp or an unreadable
  rate), the figure is hidden rather than guessed. A schedule with any uncovered dates or base-less
  hours also shows a plan banner above history saying those moments are priced at your flat rate
  (shown at 0.00 only when no finite flat rate is stored), with a link back to settings.
- **Uniform pro-rating (fallback, an approximation).** A session's energy is one total, not the energy
  drawn in each window, so each slice between rate boundaries is assumed to have drawn energy in
  proportion to its share of the span it is priced over. A charge that ramps up inside one window is
  therefore priced slightly off. This path applies to records without charging intervals — everything
  recorded before the bridge wrote them — and to records whose intervals do not account for their
  total; a session priced per interval has only the constant-power assumption inside each block.
- **Paused sessions** are priced by their intervals, not over the plug-in span: the idle gap between a
  pause and a resume carries no energy and no cost. A record without usable intervals still pro-rates
  over the plug-in span, so a paused-then-resumed legacy one can read under or over its true cost by
  the rate difference across the gap.
- **Period costs price the stored sessions, and the summary says when it prices only part of the
  energy.** Under a rate plan the Week, Month and Year summary and bar costs come from the sessions
  overlapping the window — each priced over its own charging intervals or plug-in span and
  attributed to its local days and months, so the figures reconcile with the sessions list — while
  the Day period's hourly bars price the day document's own hour buckets. Each day and month bar
  prints the energy its own cost prices, so a day reads the same in every period — even while its
  document and the sessions archive briefly disagree — except while a charge that crossed local
  midnight is still running: its live estimate shows only in periods that include today, until the
  session is recorded. Under One rate the kWh totals stay the day documents' own. A bucket no
  session covers hides its figure rather than pricing itself free,
  and when the summary's $ prices only part of the period's kWh — any missing Wh at all, with no
  tolerance floor and nothing that scales with the period's size (#211) — a small muted caption
  under the figure discloses it, `priced 13.7 of 48.1 kWh` (#194). When part
  of the _viewed_ window itself falls outside every row — a season that expired
  mid-month — a subdued line under the summary says so, `Part of this month prices at your flat
rate USD 0.12.` (or `Part of this month has no price and is shown at 0.00.` when no finite flat
  rate is stored); it is per window, so the same plan adds nothing on a fully row-priced month,
  and it never touches the cost figure or its coverage caption (#193). The plan banner additionally
  flags the moments outside every window and what they cost
  (your flat rate, or 0.00 when none is stored). With no plan, every total and bar cost is exactly
  what it was before rate plans existed.

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

- The repo is **public**; every deployment value (service-account key, Firebase config, charger default) lives in gitignored files. See `private.example/`. The charger address is the one value that can also be set at runtime: the app's **Charger connection** card writes `settings/current.charger_host` and the running bridge applies it without a restart. `CHARGER_HOST` in `private/bridge.env` is the bootstrap default — used by a fresh Pi, and again once the field is cleared.
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
different projects. The hosting-capable scripts (`deploy`, `deploy:dry-run`,
`deploy:hosting`) also block when the gitignored `web/firebase-config.js` is
missing or still contains the example Firebase app values; `deploy:rules` and
`deploy:indexes` publish nothing from `web/`, so they are unaffected. Never
bypass the guard with raw `firebase deploy --force`.
