// Cost presentation: choose between the flat rate and the optional rate
// schedule for one display slot, and format the result.
//
// Costs are computed on read from `settings/current` ({rate, currency, rates})
// and never stored, so saving a new schedule re-prices the live session and the
// whole history at once. With no usable `rates` every helper returns exactly the
// string `fmtCost` produced before schedules existed, which keeps flat output
// byte-identical.
//
// Interval costs:
//   - live session   [updated_at - elapsed, updated_at] of the status snapshot
//   - finished session its stored started_at/ended_at
//
// A finished session carries `intervals: [{started_at, ended_at, wh}]`, one per
// contiguous charging block (the bridge writes them since #57). Those are priced
// one interval at a time, so a pause over an expensive window no longer dilutes
// the energy that was actually drawn off-peak. A session without intervals —
// everything recorded before #57, and a restart that never measured growth —
// falls back to the aggregate: `costForInterval` pro-rates the stored `wh`
// uniformly across started_at…ended_at (see rates.js), an approximation the UI
// inherits. Either way the rule is all-or-nothing and hide-not-misprice: a
// malformed interval list falls back, and a *valid* list with one unpriceable
// interval hides the figure rather than pro-rating over a tariff it cannot read.
//
// A day's history document stores one kWh total, not the shape of the intervals
// behind it, so a daily/period cost cannot be re-costed under a schedule.
// `aggregateCostLabel` therefore returns null whenever a schedule exists and the
// history screen shows kWh only; per-session costs are still shown.
//
// The live interval ends at the snapshot's own `updated_at`, never at the render
// instant, and only while the snapshot is a live charging one (`liveCharging`:
// `state_label` charging and not marked offline). `elapsed` is cumulative for the
// whole plug-in, so pricing a paused, cached or charger-offline snapshot against a
// later clock would slide the window over idle hours that drew no energy.
// Anchoring to the write freezes the figure until a new write arrives.

import { fmtCost, fmtMoney, liveCharging, toNumber } from './format.js';
import {
  costForInterval,
  costForIntervals,
  costForSession,
  intervalUncovered,
  intervalUsable,
  normalizeRateSchedule,
} from './rates.js';

// Stored settings as a usable schedule: {rate, currency, rates}. Invalid rows are
// dropped by the shared normalizer, so a corrupt list falls back to the flat rate.
export function costSettings(data) {
  return normalizeRateSchedule(data);
}

export function hasRateSchedule(settings) {
  return Boolean(settings && Array.isArray(settings.rates) && settings.rates.length > 0);
}

// Flat cost for an energy amount in Wh — the pre-schedule path, byte-identical.
function flatCostLabel(wh, settings) {
  const energy = toNumber(wh);
  const kwh = Number.isFinite(energy) ? energy / 1000 : null;
  return kwh == null
    ? null
    : fmtCost(kwh, settings && settings.rate, settings && settings.currency);
}

function endMillis(now) {
  if (typeof now === 'number') return Number.isFinite(now) ? now : null;
  if (now instanceof Date) return Number.isFinite(now.getTime()) ? now.getTime() : null;
  return null;
}

// Live session cost: the schedule over the elapsed part of the session, or the
// flat rate when no schedule exists.
//
// A schedule needs a positive elapsed duration and a snapshot that says the
// charger is charging; without either the cost is hidden rather than guessed
// from the flat fallback, because the fallback would silently misprice a tariff
// whose windows apply right now. `now` must be the snapshot's `updated_at`, not
// the render instant, so re-rendering a paused or cached write cannot slide the
// interval forward over hours that added no energy.
export function liveCostLabel(wh, elapsed, now, settings, charging = false) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return flatCostLabel(wh, normalized);
  const seconds = toNumber(elapsed);
  const endMs = endMillis(now);
  if (!charging || !Number.isFinite(seconds) || seconds <= 0 || endMs == null) return null;
  const cost = costForInterval(wh, endMs - seconds * 1000, endMs, normalized);
  return cost == null ? null : fmtMoney(cost, normalized.currency);
}

// Live cost straight from a status document. The interval ends at the write's
// own `updated_at` (a missing or malformed timestamp hides it) and is priced only
// for a live charging write — the gate the session clock uses. The bridge keeps
// the last good state and elapsed while the charger is unreachable and stamps a
// fresh `updated_at` on every failed poll, so without the offline check those
// markers would re-price the frozen interval at whatever windows apply now. The
// flat path ignores all of it, so its output stays byte-identical.
export function statusCostLabel(status, settings) {
  if (!status) return null;
  const updated = status.updated_at;
  const endMs = updated && typeof updated.toMillis === 'function' ? updated.toMillis() : null;
  return liveCostLabel(
    status.session_energy,
    status.elapsed,
    endMs,
    settings,
    liveCharging(status),
  );
}

// Whether the live cost interval includes a slice with no base/window price.
// Only a non-empty schedule can have such a slice; the status screen adds the
// marker beside the cost, not a second number.
export function statusCostUncovered(status, settings) {
  if (!status) return false;
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return false;
  const updated = status.updated_at;
  const endMs = updated && typeof updated.toMillis === 'function' ? updated.toMillis() : null;
  const seconds = toNumber(status.elapsed);
  if (!liveCharging(status) || !Number.isFinite(seconds) || seconds <= 0 || endMs == null) {
    return false;
  }
  return intervalUncovered(endMs - seconds * 1000, endMs, normalized);
}

// ---------- interval reconciliation ----------

// A session can carry well-shaped intervals whose energy does not add up to its
// aggregate: a mid-charge bridge restart seeds the counter baseline, so the
// energy drawn before the restart is in `wh` but in no interval (short); an
// in-block counter reset leaves the intervals summing above the reset aggregate
// (long). Pricing on either list moves real money, so the label only takes the
// interval path when the two agree within the tolerance below.
//
// The one legitimate divergence is the session's first charging tick, which
// supplies the baseline only. That costs at most one observation gap of energy:
// the bridge's widest gap is a 60 s MQTT reconcile, and at the charger's 48 A
// ceiling (~11.5 kW) it is 11.5 kW × 60 s ≈ 192 Wh. A 250 Wh floor covers that
// with margin (2.5× the 10 s HTTP poll's 32 Wh) and keeps a small session's
// single-poll loss inside the rule; 2% of `wh` then scales it with the session
// (600 Wh at 30 kWh) so ordinary counter jitter never forces a fallback.
// Everything larger is a defect, not jitter: the restart orphan in this PR's
// own fixture is 4 kWh and the reset overshoot 1.9 kWh.
const INTERVAL_ENERGY_FLOOR_WH = 250;
const INTERVAL_ENERGY_SHARE = 0.02;

function intervalEnergyTolerance(wh) {
  return Math.max(INTERVAL_ENERGY_FLOOR_WH, INTERVAL_ENERGY_SHARE * wh);
}

// Whether a session's stored intervals can be priced as they are: a non-empty
// list of usable intervals that also accounts for the session's energy. The
// second argument is the session's own `wh`; anything else (absent, not a list,
// one bad entry, too little or too much energy, an unusable aggregate) is the
// legacy path, so the whole fallback rule is testable here on its own.
export function sessionIntervalsValid(intervals, wh) {
  if (!Array.isArray(intervals) || intervals.length === 0) return false;
  if (!intervals.every(intervalUsable)) return false;
  const aggregate = toNumber(wh);
  // An unusable aggregate cannot reconcile anything: keep the pre-interval
  // behaviour for such a document (costForSession, which hides a bad `wh`)
  // instead of pricing a list that nothing can check.
  if (!Number.isFinite(aggregate) || aggregate <= 0) return false;
  const total = intervals.reduce((sum, interval) => sum + Number(interval.wh), 0);
  return Math.abs(total - aggregate) <= intervalEnergyTolerance(aggregate);
}

// Finished session cost: its charging intervals when they are usable *and* add
// up to the session's energy, else its own stored span, else the flat rate. A
// session with unusable endpoints and no intervals hides (costForSession
// returns null). Both directions of a divergence fall back — an under-priced or
// over-priced interval sum is never shown.
export function sessionCostLabel(session, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return flatCostLabel(session && session.wh, normalized);
  const intervals = session && session.intervals;
  const cost = sessionIntervalsValid(intervals, session && session.wh)
    ? costForIntervals(intervals, normalized)
    : costForSession(session, normalized);
  return cost == null ? null : fmtMoney(cost, normalized.currency);
}

// Aggregate daily/period cost from a kWh total. Null whenever a schedule exists:
// one kWh figure cannot be split across the windows it was drawn in, so the
// screens keep the energy figure and drop the cost instead of mispricing it.
export function aggregateCostLabel(kwh, settings) {
  const normalized = costSettings(settings);
  if (hasRateSchedule(normalized)) return null;
  const energy = toNumber(kwh);
  if (!Number.isFinite(energy)) return null;
  return fmtCost(energy, normalized.rate, normalized.currency);
}
