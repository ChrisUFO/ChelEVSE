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
// Sessions store only a total `wh`, so `costForInterval` pro-rates it uniformly
// across the span (see rates.js) — an approximation the UI inherits. For a
// merged pause-then-resume record the stored span also covers the idle gap, so
// the pro-rating is over the plug-in span, not the charging intervals.
//
// A day's history document stores one kWh total, not the shape of the intervals
// behind it, so a daily/30-day cost cannot be re-costed under a schedule.
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
