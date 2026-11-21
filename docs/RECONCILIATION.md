# Energy-history reconciliation runbook (issue #161)

The bridge audits its own energy archive every hour against the charger's
independent day/month meters (`total_day`/`total_month`). When the two
disagree beyond tolerance, something lost energy on one side — the bridge
journals one line and **touches nothing**. This page is what to do when you
see that line. Design detail lives in
[../pi/README.md](../pi/README.md) § "Day/month reconciliation".

## Anatomy of a warning

```
day reconciliation warning (day 2026-11-21): bridge history 11.420 kwh
(archive 10.100 + pending 1.320) vs charger total_day 11.995 kwh, gap
0.575 kwh (bridge low); likely outage window [2026-11-21 09:00 ->
2026-11-21 12:00] local; no history or session data modified
```

| Field                                         | Meaning                                                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `day`/`month reconciliation`                  | Which period drifted. The month line is identical in shape with `(month 2026-11)` and `total_month`.                                                                                                                                               |
| `warning` vs `note`                           | A **warning** means the bridge has proven both sides measure the same period (see below). A `note (…, informational, warning authority not yet granted)` means the same divergence without that proof — read it the same way, with less certainty. |
| `bridge history 11.420 kwh`                   | The bridge's total for the period: today's `history/{date}` document **plus energy still pending** in the accumulator, read together under one lock.                                                                                               |
| `(archive 10.100 + pending 1.320)`            | That total's split: written doc kWh + not-yet-flushed kWh.                                                                                                                                                                                         |
| `vs charger total_day 11.995 kwh`             | The charger's own period counter, from the same `/status` replies the bridge consumes. Both sides are **kWh**.                                                                                                                                     |
| `gap 0.575 kwh (bridge low)`                  | How far apart, and which side is short. Tolerance is `max(0.2 kWh, 1% of the larger side)`.                                                                                                                                                        |
| `likely outage window [09:00 -> 12:00] local` | Last clean evaluation → first divergent observation, Pi-local. The event that lost energy fell in this window (`no clean evaluation yet` = since bridge start).                                                                                    |
| `no history or session data modified`         | The promise: this check never writes, corrects or backfills anything.                                                                                                                                                                              |

Two cousins you may see beside it:

- `… reconciliation rejected (…): charger total_day … is about 1000x the
bridge history …` — not lost energy; the charger counter looks Wh-scaled
  (firmware variant or misconfiguration). Nothing reconciled; check the
  firmware.
- `day/month reconciliation read failed (…)` — Firestore read failed; the
  next tick retries. Not a divergence.

## Investigating a warning

1. Pull the full picture from the journal (the bridge logs to journald as
   `chelevse-bridge`):

   ```sh
   sudo journalctl -u chelevse-bridge --since "2026-11-21 08:00" --no-pager \
     | grep -E "reconciliation (warning|note|rejected)"
   sudo journalctl -u chelevse-bridge -b --no-pager | grep -E "counter (rollover|step dropped|did not reset)"
   ```

   The counter lines show what the bridge itself observed: rollovers
   (the counter rebasing at its boundary), dropped implausible steps, and
   midnights that passed without a reset.

2. Read the gap direction:

   - **`bridge low`** (archive < charger): the bridge recorded less than the
     charger delivered — missed intervals. Typical causes: a bridge restart
     or offline span inside the outage window, the charger unreachable for
     part of the day, or implausible charger steps the validator dropped
     (`counter step dropped` lines).
   - **`bridge high`** (archive > charger): the bridge recorded energy the
     charger's period counter does not account for — usually a charger
     counter event: `/emeter.json` loss with a lifetime re-import from RAPI
     `$GU` (the double-count class), a mid-day firmware reflash/reset, or a
     period counter zeroed by a boot before NTP.

3. Corroborate inside the window: bridge restarts (`journalctl -u
chelevse-bridge --list-boots`, gaps in the log), charger reachability
   lines, `counter step dropped` entries, and the web app's day total for
   the same date.

4. Compare by hand if you need the number: the `history/{date}` document's
   `kwh` + that day's still-pending energy vs the charger's `total_day`
   read over HTTP. The warning's own totals were gathered this way — a
   hand check confirms, it does not extend, the finding.

5. Stop there. The check never repairs anything, and there is no tool to
   run: a divergence is evidence for a human decision (accept the gap,
   or correct history deliberately as an explicit, reviewed change).
   An episode journals one line and stays quiet unless the gap flips
   direction or grows ≥ 1 kWh — silence later in the day is bounding,
   not recovery.

## Charger counter semantics

- **Units**: `total_day`/`total_week`/`total_month`/`total_year`/
  `total_energy` are all **kWh**; lifetime `total_energy` never auto-resets.
- **Boundaries**: period counters reset at the **charger's local midnight**
  (firmware `time_zone` setting), not the Pi's. Weeks start Sunday
  (`total_week` is not compared today).
- **Reboots**: counters survive via `/emeter.json` on the charger's
  filesystem, saved every 5 minutes **while charging**.

## Verifying a known-good day / timezone alignment

The bridge must earn the right to warn (warning authority is **in-memory
only**; every restart — each deploy — drops it and re-earns it, so ~24 h of
informational notes after a deploy is expected, not a fault):

- A `total_day` rollover observed within ±1 h of Pi-local midnight grants
  authority — both sides provably measure the same day in the same zone.
  Journaled as `day reconciliation: warning authority granted (…period and
time-zone alignment verified)`.
- A rollover at the wrong hour keeps comparisons informational with a
  one-time `time-zone or period mismatch suspected` note; a midnight the
  counter crosses **without** resetting revokes authority outright.
- The month needs one clean day comparison first (`month reconciliation:
warning authority granted (one clean day comparison…)`).

To check alignment yourself: read the charger's `time_zone` from its
`/config` endpoint (the same one the bridge polls) and compare with the
Pi's zone (`timedatectl`). If they differ, fix the charger's `time_zone`
and let the next midnight rollover re-grant authority.

## Firmware caveats

- Needs gateway firmware **≥ 4.2.2** (this charger runs 8.2.3). Older
  firmware reports no period counters; the bridge logs one startup line
  (`day reconciliation inactive: the charger reports no total_day period
counter (firmware below 4.2.2?); nothing to reconcile`) and stays
  inactive.
- A boot before NTP sync can zero period counters (a 1970 date) — shows up
  as `bridge high`.
- Losing `/emeter.json` re-imports lifetime from RAPI `$GU` and can
  double-count — the classic `bridge high` cause.
- A power cut while charging loses up to 5 minutes of energy (the save
  cadence) — usually inside the 0.2 kWh floor on typical power.

## What the check never does

Zero Firestore writes. No history or session document is created, mutated
or backfilled; nothing is auto-corrected; no status doc, UI card or push
notification exists for it. Journal lines only.

## Disabling / tuning

`RECONCILE_INTERVAL` in `private/bridge.env` (default `3600` s, hourly)
sets the cadence; `0` disables the loop (confirmed at startup by
`day reconciliation: disabled (RECONCILE_INTERVAL=0)`). The tolerance —
`max(0.2 kWh, 1% of the larger side)` — and the sample freshness window —
one feed interval clamped to the floor's coverage at the charger's ceiling
power (48 A × 253 V ≈ 59 s) — are fixed in code: slowing the feed cannot
widen the window past the clamp; evaluations simply wait for a fresh
sample.
