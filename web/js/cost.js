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
//   - live session   [now - elapsed, now] (the snapshot's own elapsed seconds)
//   - finished session its stored started_at/ended_at
//
// Sessions store only a total `wh`, so `costForInterval` pro-rates it uniformly
// across the span (see rates.js) — an approximation the UI inherits.
//
// A day's history document stores one kWh total, not the shape of the intervals
// behind it, so a daily/30-day cost cannot be re-costed under a schedule.
// `aggregateCostLabel` therefore returns null whenever a schedule exists and the
// history screen shows kWh only; per-session costs are still shown.
//
// The live interval ends at the render instant. A status snapshot can be one
// poll interval old, so a session that just crossed a window boundary can be
// priced a few seconds late; the next write re-renders it.

import { fmtCost, fmtMoney, toNumber } from './format.js';
import { costForInterval, costForSession, normalizeRateSchedule } from './rates.js';

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
// A schedule needs a positive elapsed duration to price an interval; without one
// the cost is hidden rather than guessed from the flat fallback, because the
// fallback would silently misprice a tariff whose windows apply right now.
export function liveCostLabel(wh, elapsed, now, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return flatCostLabel(wh, normalized);
  const seconds = toNumber(elapsed);
  const endMs = endMillis(now);
  if (!Number.isFinite(seconds) || seconds <= 0 || endMs == null) return null;
  const cost = costForInterval(wh, endMs - seconds * 1000, endMs, normalized);
  return cost == null ? null : fmtMoney(cost, normalized.currency);
}

// Finished session cost: its own stored interval under the schedule, or the flat
// rate. A session with unusable endpoints hides (costForSession returns null).
export function sessionCostLabel(session, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return flatCostLabel(session && session.wh, normalized);
  const cost = costForSession(session, normalized);
  return cost == null ? null : fmtMoney(cost, normalized.currency);
}

// Aggregate daily/30-day cost from a kWh total. Null whenever a schedule exists:
// one kWh figure cannot be split across the windows it was drawn in, so the
// screens keep the energy figure and drop the cost instead of mispricing it.
export function aggregateCostLabel(kwh, settings) {
  const normalized = costSettings(settings);
  if (hasRateSchedule(normalized)) return null;
  const energy = toNumber(kwh);
  if (!Number.isFinite(energy)) return null;
  return fmtCost(energy, normalized.rate, normalized.currency);
}
