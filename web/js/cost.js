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
// since #60/#77, and #110 priced periods from them bucket by bucket. #123 makes
// period pricing session-primary instead: a period's summary and its
// Week/Month/Year bars cost the sum of the *stored sessions* overlapping the
// range — every session prices exactly (the sessions list's own rule below),
// so the archive is itself the pricing record. The session-attribution exports
// (sessionCostSpans / sessionBucketCost) slice each session at local day and
// month boundaries and price the slices through costForInterval, so a period's
// per-bucket costs sum to exactly the per-session figures the sessions list
// shows. The buckets keep exactly one job: the Day period's hourly bars
// (hourCost below). `aggregateCostLabel` itself still returns null whenever a
// schedule exists, because one aggregate kWh figure cannot be split across
// windows; it stays the flat path these schedule helpers never touch.
//
// While a charge is live, that same interval is also today's history figure
// (#126): the period screens merge `liveSessionContribution` — the live window
// as one pseudo-session — into the sessions a period prices, so the Week/
// Month/Year summary and today's bar carry the estimate the Status tab shows,
// attributed across local midnights by the same span machinery (#125). The
// contribution is schedule-path only (a flat day total already accrues live)
// and settles exactly once: any recorded session whose spans overlap the live
// window suppresses it (liveSessionSettled), so the two listener deliveries
// around a charge's end — the session document and the stopped status write —
// never double-count whichever order they arrive in.
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
import { dayStartFromId } from './history.js';

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

// ---------- session-attributed period pricing (#123) ----------

// A ms instant from any stored span endpoint: a Firestore Timestamp (or its
// snapshot shape), a Date, or a raw number — the same readings rates.js's
// pricer accepts, kept local so the attribution layer can slice them.
function valueMillis(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value && typeof value.toMillis === 'function') {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value && typeof value.toDate === 'function') return valueMillis(value.toDate());
  return null;
}

// A session as priceable spans, `{started_at, ended_at, wh}` each: a list whose
// costs sum to exactly the figure sessionCostLabel renders for the document.
// A reconciling intervals list is the intervals themselves — exact attribution,
// one price per charging block, idle gaps excluded — and anything else falls
// back to the stored span as one whole, the same pro-rated approximation and
// the same null rules sessionCostLabel applies (costForSession's: an unusable
// `wh` or endpoints price nothing, and a zero-energy span is a real 0.00). The
// period figures therefore reconcile with the sessions list by construction.
export function sessionCostSpans(session) {
  if (!session || typeof session !== 'object') return null;
  if (sessionIntervalsValid(session.intervals, session.wh)) {
    return session.intervals.map((interval) => ({
      started_at: interval.started_at,
      ended_at: interval.ended_at,
      wh: Number(interval.wh),
    }));
  }
  const wh = toNumber(session.wh);
  const startMs = valueMillis(session.started_at);
  const endMs = valueMillis(session.ended_at);
  if (!Number.isFinite(wh) || wh < 0) return null;
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  return [{ started_at: session.started_at, ended_at: session.ended_at, wh }];
}

// Local midnight starting a month id ('YYYY-MM'), or null when malformed — the
// month-bucket twin of dayStartFromId, so a Year bar's window is exactly the
// local calendar month the id names.
function monthStartFromId(id) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(id));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  if (date.getMonth() !== Number(match[2]) - 1) return null;
  return date;
}

// One local day ('YYYY-MM-DD') or month ('YYYY-MM-DD'→day, 'YYYY-MM'→month)
// bucket priced from the sessions that overlap it — the Week/Month/Year bars'
// and the period summary's only pricing source. Each session's spans
// (sessionCostSpans) are sliced at the bucket's edges and each slice is priced
// over its own wall-clock span by costForInterval, with the slice's energy
// pro-rated by its share of the span's real duration — the same constant-power
// split costForInterval applies inside a span, and every bucket edge is a
// local midnight costForInterval already splits at, so a session's bucket costs
// sum to exactly its per-session figure (the reconciliation the summary leans
// on). kWh totals stay the day documents' (display); `kwh` here only measures
// coverage, with the same max(250 Wh, 2%) tolerance the interval
// reconciliation uses: attributed Wh that accounts for the bucket means
// covered, energy with no covering session hides its figure, never priced
// free.
// Returns {cost, wh, covered}, or null without a usable schedule or bucket id
// (the flat path is and stays aggregateCostLabel's).
export function sessionBucketCost(sessions, id, kwh, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return null;
  const dayStart = dayStartFromId(id);
  const monthStart = dayStart == null ? monthStartFromId(id) : null;
  const start = dayStart != null ? dayStart : monthStart;
  if (!start) return null;
  const windowStart = start.getTime();
  const windowEnd =
    dayStart != null
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime()
      : new Date(start.getFullYear(), start.getMonth() + 1, 1).getTime();
  let cost = 0;
  let wh = 0;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const spans = sessionCostSpans(session);
    if (!spans) continue;
    for (const span of spans) {
      const spanStart = valueMillis(span.started_at);
      const spanEnd = valueMillis(span.ended_at);
      if (spanStart == null || spanEnd == null || spanEnd <= spanStart) continue;
      const from = Math.max(spanStart, windowStart);
      const to = Math.min(spanEnd, windowEnd);
      if (to <= from) continue;
      const sliceWh = (span.wh * (to - from)) / (spanEnd - spanStart);
      const part = costForInterval(sliceWh, from, to, normalized);
      // Unreachable under a schedule (an uncovered slice prices 0.00); kept so
      // a null from the engine hides the bucket instead of half-pricing it.
      if (part == null) return null;
      cost += part;
      wh += sliceWh;
    }
  }
  const totalWh = toNumber(kwh) * 1000;
  const covered =
    !Number.isFinite(totalWh) || totalWh <= 0
      ? true
      : wh >= totalWh - intervalEnergyTolerance(totalWh);
  return { cost, wh, covered };
}

// ---------- the live session's period contribution (#126) ----------

// The in-progress charge as one priceable span `{started_at, ended_at, wh}` —
// raw ms endpoints, the shape sessionCostSpans' fallback path already accepts —
// or null. This is exactly the window the Status tab prices (statusCostLabel's):
// `[updated_at − elapsed, updated_at]`, anchored to the snapshot's own write so
// a paused, cached or stale write cannot slide it over idle hours, and gated by
// `liveCharging` so an offline marker or a stopped snapshot contributes nothing
// (their figures are that screen's held/adopted machinery, not this one). The
// energy gates mirror the label's null rules: no positive session_energy or
// elapsed prices nothing rather than guessing a window.
export function liveSessionSpan(status) {
  if (!liveCharging(status)) return null;
  const wh = toNumber(status.session_energy);
  const seconds = toNumber(status.elapsed);
  const endMs = snapshotMillis(status);
  if (!Number.isFinite(wh) || wh <= 0) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (endMs == null) return null;
  return { started_at: endMs - seconds * 1000, ended_at: endMs, wh };
}

// Whether a recorded session already prices part of the live window: the settle
// guard. The bridge writes the session document at the charging→stopped edge
// while the stopped status write travels its own listener, so for one render
// window history's two inputs can arrive in either order — a settled session
// beside a still-charging snapshot would double-price the same energy. The
// predicate reads the recorded side through the same sessionCostSpans the
// bucket pricing uses, so "covers" means "prices": a session with unusable spans
// prices nothing anywhere and cannot cover anything, and overlap is decided on
// the spans themselves (intervals where they reconcile, else the whole plug-in
// span), which keeps the guard exact for a pause-resumed charge — the recorded
// prefix overlaps the live window, and the whole-window estimate is dropped
// rather than added beside the energy it already prices.
export function liveSessionSettled(span, sessions) {
  const liveStart = valueMillis(span && span.started_at);
  const liveEnd = valueMillis(span && span.ended_at);
  if (liveStart == null || liveEnd == null || liveEnd <= liveStart) return false;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const spans = sessionCostSpans(session);
    if (!spans) continue;
    for (const recorded of spans) {
      const start = valueMillis(recorded.started_at);
      const end = valueMillis(recorded.ended_at);
      if (start == null || end == null || end <= start) continue;
      if (start < liveEnd && end > liveStart) return true;
    }
  }
  return false;
}

// The live window merged into a period's pricing sessions, or null: schedule
// only (a flat day total already prices the accruing kWh, so the flat output is
// byte-identical with or without a charge in progress), live-gated and
// settle-guarded. The returned span flows through sessionBucketCost beside the
// recorded sessions, so its cost lands in exactly the buckets its window
// overlaps — today's bar, and yesterday's when the charge crossed local
// midnight — with the same constant-power split every other span prices by, and
// its Wh counts toward the bucket's coverage, so a live-covered today shows
// its bar $. It is an estimate, excluded from the recorded reconciliation
// while live, and settles to the session's own pricing exactly once: whichever
// input lands first, the guard drops the contribution the moment a recorded
// span overlaps it.
export function liveSessionContribution(status, sessions, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return null;
  const span = liveSessionSpan(status);
  if (!span) return null;
  if (liveSessionSettled(span, sessions)) return null;
  return span;
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

// ---------- schedule-priced hour buckets ----------
//
// Since #60/#77 every history/<YYYY-MM-DD> document also carries an hourly
// `hours` map ({"00"…"23": kWh}). #123 leaves these buckets exactly one job:
// the Day period's hourly bars, each priced over its own wall-clock hour by
// costForInterval — the same engine the live and per-session costs use. Period
// pricing is session-primary (sessionBucketCost above); buckets no longer
// participate, so there is one pricing source per bucket and no energy is
// priced twice. The flat path is and stays aggregateCostLabel's — these
// helpers price only under a schedule (null without one), so flat output stays
// byte-identical and there is exactly one flat implementation.

// Approximation (accepted, unchanged from #110): a bucket's span is local
// midnight + hour·3600 s, i.e. the real hours after midnight, so a DST-shifted
// day prices 24 buckets against the 23 or 25 real hours it has — on the
// spring-forward day the "02" bucket is the first instant that exists
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
// 0.00 — the existing plan-banner rule — so under a schedule the null cases
// are only the unusable-input guards.
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
