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
//   - held session   [anchor - elapsed, anchor], the last live window frozen
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
// A day's history document has carried hourly buckets alongside its kWh total
// since #60/#77, so a daily/period cost can be re-costed under a schedule after
// all — bucket by bucket (the exports below aggregateCostLabel).
// `aggregateCostLabel` itself still returns null whenever a schedule exists,
// because one aggregate kWh figure cannot be split across windows; the history
// screen prices the buckets instead. Per-session costs keep their own path.
//
// The live interval ends at the snapshot's own `updated_at`, never at the render
// instant, and only while the snapshot is a live charging one (`liveCharging`:
// `state_label` charging and not marked offline). `elapsed` is cumulative for the
// whole plug-in, so pricing a paused, cached or charger-offline snapshot against a
// later clock would slide the window over idle hours that drew no energy.
// Anchoring to the write freezes the figure until a new write arrives.
//
// The held session keeps that figure visible once charging stops with energy
// still on the meter (the common plugged-in-complete end state): the screen
// freezes the last charging write's own `updated_at` and its `elapsed` as one
// anchor (see heldAnchorAfter) and prices `[anchor - elapsed, anchor]`
// (heldCostLabel), so the $ survives the whole plug-in while every later write —
// fresh idle polls, the bridge's offline markers, schedule-only merges — leaves
// the rate window exactly where the last live render priced it. A cold open
// (no charging write witnessed) reconstructs the same kind of anchor from the
// bridge's `charging_stopped_at` stamp (see adoptedAnchor, issue #122): a
// captured anchor always wins, and without the stamp today's hide stands.

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

// A status document's own write time, or null when it is missing or malformed —
// the same reading statusCostLabel/statusCostUncovered make inline.
function snapshotMillis(status) {
  const updated = status && status.updated_at;
  return updated && typeof updated.toMillis === 'function' ? updated.toMillis() : null;
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

// ---------- held session (plugged in, not charging) ----------

// The frozen anchor is a pair, not a timestamp alone: `elapsed` is cumulative for
// the whole plug-in and keeps growing while paused, so re-using a later write's
// value would stretch the interval past the plug-in's start and dilute the
// energy over hours that drew none. Held together, the pair prices exactly the
// figure the last live render showed.
//
// Advance the anchor for a status document — the cost's counterpart of the
// session clock's hold. A live charging write re-anchors on every write (so a
// new charge starts from its own window, and a document refreshed in place
// carries its newer elapsed); a write without a usable timestamp cannot anchor
// anything, and the labels' null rules then hide it exactly like the live one.
// A late, older charging write must not rewind the anchor (the clock's rule).
// Once charging stops, the anchor holds while the session's energy is still on
// the meter — including under the bridge's offline markers, which keep the
// charging label but are not live — and clears when the session resets, so a
// fresh idle state hides the figure again.
export function heldAnchorAfter(prev, status) {
  if (!status) return null;
  if (liveCharging(status)) {
    const ms = snapshotMillis(status);
    if (ms == null) return null;
    return prev && prev.ms > ms ? prev : { ms, elapsed: status.elapsed };
  }
  const energy = toNumber(status.session_energy);
  return Number.isFinite(energy) && energy > 0 ? prev : null;
}

// The cold-open anchor (issue #122): a not-charging snapshot with session
// energy still on the meter and the bridge's `charging_stopped_at` stamp
// yields the anchor the page would have captured had it been open at the
// stop -- `{ms: stamp, elapsed}` -- so a reload or late sign-in still shows
// the session's $. The page cannot reconstruct this alone: `updated_at`
// refreshes on every poll while `elapsed`/`session_energy` freeze, so
// anchoring to any web-known clock would slide the window (forbidden).
//
// Precedence is the caller's explicit `captured ?? adopted` wiring: a
// captured or held anchor always wins -- by construction it prices the same
// stop, from the write that observed it -- and adoption only fills the null
// the held machine leaves on a cold open. A captured anchor is never
// replaced by a later poll's stamp either: once adopted, the anchor is held
// exactly like a captured one, so re-delivery of the same (or a newer)
// stamp cannot move the figure.
//
// The pair is an approximation the captured path shares: `elapsed` is the
// adopting snapshot's cumulative value, so pause time between the stop and
// the cold open is folded into the pro-rated span (the single-span rule of
// §4; the energy itself never moves). A malformed or absent stamp -- an
// older bridge, or a pre-deploy bridge -- returns null and today's hide
// stands. `elapsed` is passed through ungated: the pricer's null rules are
// the single gate for unusable durations.
export function adoptedAnchor(status) {
  if (!status || liveCharging(status)) return null;
  const energy = toNumber(status.session_energy);
  if (!Number.isFinite(energy) || energy <= 0) return null;
  const stamp = status.charging_stopped_at;
  const ms = stamp && typeof stamp.toMillis === 'function' ? stamp.toMillis() : null;
  if (ms == null) return null;
  return { ms, elapsed: status.elapsed };
}

// Held session cost: the schedule over the frozen interval
// [anchorMs - elapsed, anchorMs], the window the last live render priced.
// Null rules mirror liveCostLabel's: no schedule takes the flat path
// (byte-identical, the anchor ignored), and a missing or unusable elapsed or
// anchor hides the figure rather than guessing a window.
export function heldCostLabel(wh, elapsed, anchorMs, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return flatCostLabel(wh, normalized);
  const seconds = toNumber(elapsed);
  const endMs = endMillis(anchorMs);
  if (!Number.isFinite(seconds) || seconds <= 0 || endMs == null) return null;
  const cost = costForInterval(wh, endMs - seconds * 1000, endMs, normalized);
  return cost == null ? null : fmtMoney(cost, normalized.currency);
}

// Whether the held interval includes a slice with no base/window price — the
// same marker the live figure carries, evaluated over the frozen window.
export function heldCostUncovered(elapsed, anchorMs, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return false;
  const seconds = toNumber(elapsed);
  const endMs = endMillis(anchorMs);
  if (!Number.isFinite(seconds) || seconds <= 0 || endMs == null) return false;
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
// the bridge's widest gap is the 60 s cadence of its slowest status observation
// (the HTTP reconcile today, the 60 s charging heartbeat once the write policy
// of #93 lands), and at the charger's 48 A ceiling (~11.5 kW) it is
// 11.5 kW × 60 s ≈ 192 Wh. A 250 Wh floor covers that
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
// (The flat path; the schedule path is the bucket-priced helpers below.)
export function aggregateCostLabel(kwh, settings) {
  const normalized = costSettings(settings);
  if (hasRateSchedule(normalized)) return null;
  const energy = toNumber(kwh);
  if (!Number.isFinite(energy)) return null;
  return fmtCost(energy, normalized.rate, normalized.currency);
}

// ---------- schedule-priced history aggregates ----------
//
// Since #60/#77 every history/<YYYY-MM-DD> document also carries an hourly
// `hours` map ({"00"…"23": kWh}), so a day's energy can be split across the
// windows it was drawn in after all: each bucket is priced over its own
// wall-clock hour by costForInterval, the same engine the live and per-session
// costs use. The flat path is and stays aggregateCostLabel's — these helpers
// price only under a schedule (null / a zero split without one), so flat output
// stays byte-identical and there is exactly one flat implementation.

// Local midnight of a day id, dayId's convention (web/js/history.js): the id
// names the owner's calendar day, so the hour grid starts at that date's local
// midnight. A malformed id (or one that rolls over, 2026-02-31) prices nothing.
function dayStartFromId(id) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(id));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return date;
}

// The day's positive hourly buckets [{hour, kwh}] in bucket order, or null when
// the map has none — the same "no usable hours" reading as the Day period's
// 'no-intraday' state: zero, negative and malformed values are not recorded
// hours, and only the stored zero-padded keys count.
function positiveHours(hours) {
  const map = hours && typeof hours === 'object' && !Array.isArray(hours) ? hours : null;
  if (!map) return null;
  const buckets = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const kwh = Number(map[String(hour).padStart(2, '0')]);
    if (Number.isFinite(kwh) && kwh > 0) buckets.push({ hour, kwh });
  }
  return buckets.length > 0 ? buckets : null;
}

// Approximation (accepted, same family as the interval one above): a bucket's
// span is local midnight + hour·3600 s, i.e. the real hours after midnight, so
// a DST-shifted day prices 24 buckets against the 23 or 25 real hours it has —
// on the spring-forward day the "02" bucket is the first instant that exists
// (wall 03:00), and on the fall-back day every bucket after the repeated hour
// sits one wall hour late (bucket "03" covers the repeated wall 02:00).
// costForInterval's own boundaries are wall-clock too, so the two readings
// agree outside the transition itself. Hour buckets are the finest shape a day
// document stores, so no path can beat the hour it attributes energy to.
function hourStartMs(start, hour) {
  return start.getTime() + hour * 3600000;
}

// One hour bucket priced over its own span (kWh in, like the buckets
// themselves; costForInterval takes Wh). An hour no base/window covers prices
// 0.00 — the existing plan-banner rule — so under a schedule the null cases are
// only the unusable-input guards.
export function hourCost(dayId, hour, kwh, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return null;
  const start = dayStartFromId(dayId);
  const index = toNumber(hour);
  const energy = toNumber(kwh);
  if (!start) return null;
  if (!Number.isInteger(index) || index < 0 || index > 23) return null;
  if (!Number.isFinite(energy) || energy < 0) return null;
  const from = hourStartMs(start, index);
  return costForInterval(energy * 1000, from, from + 3600000, normalized);
}

// One day priced from its hourly buckets: the sum of its buckets' hourCosts.
// `kwh` is the day's own total and decides the degenerate cases: a day with
// energy but no usable bucket (recorded before hourly capture began) is
// *unpriceable* — null, distinct from a 0.00 day — while a day with no energy
// at all is fully priced at 0, so a range of empty days is never "partial".
// Buckets that sum to less than the day's total are priced as they are; the
// history screen's partial note covers that gap.
export function dayCost(id, hours, kwh, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return null;
  const buckets = positiveHours(hours);
  if (!buckets) {
    const total = toNumber(kwh);
    // No bucket to price: a real zero-energy day costs 0.00; energy without
    // buckets, or an unusable total, cannot be priced at all.
    return Number.isFinite(total) && total <= 0 ? 0 : null;
  }
  const start = dayStartFromId(id);
  if (!start) return null;
  let cost = 0;
  for (const bucket of buckets) {
    const from = hourStartMs(start, bucket.hour);
    const part = costForInterval(bucket.kwh * 1000, from, from + 3600000, normalized);
    // Unreachable under a schedule (an uncovered slice prices 0.00); kept so a
    // null from the engine hides the day instead of half-pricing it.
    if (part == null) return null;
    cost += part;
  }
  return cost;
}

// A period's schedule-priced sum over day documents ({id, kwh, hours}): the
// cost of every priceable day plus the priced/unpriced split the history screen
// drives its partial note with. Zero-energy days count as priced (they cost
// 0.00); only a day with energy and no usable buckets is unpriced. Without a
// schedule the split stays zeroed: aggregateCostLabel is the flat path.
export function periodCost(docs, settings) {
  const normalized = costSettings(settings);
  const totals = { cost: 0, pricedDays: 0, unpricedDays: 0 };
  if (!hasRateSchedule(normalized)) return totals;
  for (const doc of Array.isArray(docs) ? docs : []) {
    // A malformed row is not a day document: skipped like the series builders
    // skip it, rather than counted as an unpriceable day.
    if (!doc || typeof doc !== 'object') continue;
    const cost = dayCost(doc.id, doc.hours, doc.kwh, normalized);
    if (cost == null) totals.unpricedDays += 1;
    else {
      totals.cost += cost;
      totals.pricedDays += 1;
    }
  }
  return totals;
}
