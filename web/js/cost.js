// Cost presentation: choose between the flat rate and the optional rate
// schedule for one display slot, and format the result.
//
// Costs are computed on read from `settings/current` ({rate, currency, rates})
// and never stored, so saving a new schedule re-prices the live session and the
// whole history at once. With no usable `rates` every helper returns exactly the
// string `fmtCost` produced before schedules existed, which keeps flat output
// byte-identical.
//
// Interval costs — every one of them a span priced by the same engine (#210):
//   - live session   [updated_at - elapsed, updated_at] of the status snapshot
//   - held session   [anchor - elapsed, anchor], the last live window frozen
//   - finished session its stored started_at/ended_at
// The Status tab's labels construct these spans and price them through the
// same slice machinery the period pass uses; there is no second pricer.
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
// since #60/#77, and #110 priced periods from them bucket by bucket. #123 made
// period pricing session-primary, and #210 finishes it: ONE span pass serves
// every period. A period's summary — Day included — and its Week/Month/Year
// bars cost the span list of the *stored sessions* overlapping the range
// (windowCostSummary / sessionBucketCost): every session prices exactly (the
// sessions list's own rule below), the spans are sliced at local day and month
// boundaries and priced through costForInterval, so a period's per-bucket
// costs sum to exactly the per-session figures the sessions list shows — and
// the summary's headline kWh is derived in the same pass as its priced energy,
// so the figure and the energy beside it cannot diverge by construction. The
// day documents' `kwh`/`hours` are chart series only — the bars' figures under
// a flat rate, and always the Day period's hour bars (which keep pricing from
// the hours map as pure display, hourCost below, never as the summary's
// basis); under a schedule a day or month bar prints the energy attributed to
// it (`wh` from sessionBucketCost below, decided in the History screen), never
// its document's total beside a session-priced figure. `aggregateCostLabel`
// itself
// still returns null whenever a schedule exists, because one aggregate kWh
// figure cannot be split across windows; it stays the flat path these
// schedule helpers never touch.
//
// #194 added the summary's coverage disclosure and #211 made it any-gap: the
// pass's attributed Wh is measured against the day documents' recorded kWh
// (`recordedWh` on the summary), so an archive that lost a record — or a
// counter-reset session whose aggregate prices a fraction of the days'
// energy — is disclosed on a small muted caption under the figure ("priced
// 13.7 of 48.1 kWh", coverageDisclosure below) whenever the sessions miss any
// of that energy, at whole-Wh resolution with no tolerance floor and nothing
// that scales with the period's size. Because headline and priced share one
// pass, the tolerance-swallowing class #211 retired cannot recur: there is no
// second aggregation for a tolerance to disagree with. The max(250 Wh, 2%)
// band now belongs only to the interval reconciliation and the buckets' own
// per-bucket $-hiding; the caption no longer shares it. Fully covered periods,
// hidden figures and every kWh total are untouched.
//
// #212 lets the bridge's per-day seam-B verdicts (`gap_wh`) take the caption
// over from that compare when every day of the window is settled — one logic
// for every period, with no Day carve-out (#210): the Day period prices from
// the same session basis the ranges do, so its coverage is comparable.
//
// #193 adds the rate-scope flags: `statusCostFallback`/`heldCostFallback` are
// the informational inverse of the "understates cost" warning's no-fallback
// gate (an uncovered slice that a finite stored flat rate prices), and
// `seriesWindowUncovered` asks the same question of a History period's own
// bucket windows, so the summary can name the fallback — or the 0.00 — for the
// part of the *viewed* window no row covers while the plan-wide banner keeps
// speaking for the whole plan.
//
// While a charge is live, that same interval is also today's history figure
// (#126): the period screens merge `liveSessionContribution` — the live window
// as one more span — into the span list a period prices (periodCostSpans), so
// the Week/Month/Year summary, today's bar and the Day period's summary carry
// the estimate the Status tab shows, attributed across local midnights by the
// same span machinery (#125). The
// contribution is schedule-path only (a flat day total already accrues live)
// and settles exactly once: whichever of the two listener deliveries around a
// charge's end — the session document or the stopped status write — lands
// first, a recorded span that reaches the write's own instant drops it. A
// recorded span that ends *inside* the window no longer drops the whole
// estimate (#128): a pause-resumed charge's recorded prefix prices its own
// slice while the residual — the meter's reading minus the recorded energy
// clipped to the window — returns as the uncovered tail's own span, so the
// resumed block's history figure reconciles with the Status tab's full-window
// estimate instead of hiding beside the energy the record already prices.
// Two validity gates hide it (hide-not-misprice): a negative residual, and a
// recorded end at or past the write's own instant — see liveSessionContribution.
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

import { fmtCost, fmtK, fmtMoney, liveCharging, toNumber } from './format.js';
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

// ---------- the Status tab's figures (#210: derived from the span pass) ----------
//
// The Status tab prices the very same span objects History prices. The live
// window is liveSessionSpan's — `[updated_at − elapsed, updated_at]`, anchored
// to the status write so a paused, cached or stale write cannot slide it over
// idle hours — and the held/adopted windows are spans built from their frozen
// anchor pairs. All four labels below construct their span and hand it to the
// same slice machinery the period pass prices by (spanCost over the span's own
// window — numerically costForInterval's constant-power split, the single
// engine); there is no second, Status-shaped pricer.

// Live cost straight from a status document. A schedule needs a live charging
// write with a positive elapsed duration and energy on the meter (the span's
// own gates); without one the cost is hidden rather than guessed from the flat
// fallback, because the fallback would silently misprice a tariff whose
// windows apply right now. The bridge keeps the last good state and elapsed
// while the charger is unreachable and stamps a fresh `updated_at` on every
// failed poll, so without the offline gate those markers would re-price the
// frozen interval at whatever windows apply now. The flat path ignores all of
// it, so its output stays byte-identical.
export function statusCostLabel(status, settings) {
  if (!status) return null;
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return flatCostLabel(status.session_energy, normalized);
  const span = liveSessionSpan(status);
  if (!span) return null;
  const cost = spanCost(span, normalized);
  return cost == null ? null : fmtMoney(cost, normalized.currency);
}

// Whether the live span includes a slice no base/window prices at a row. Only
// a non-empty schedule can have such a slice, and — since #188 — the marker
// means the figure genuinely understates cost: the stored flat rate prices the
// slice when one is finite, so the marker fires only when no finite flat
// fallback exists. The status screen adds the marker beside the cost, not a
// second number.
export function statusCostUncovered(status, settings) {
  const span = liveStatusSpan(status, settings);
  if (!span) return false;
  const normalized = costSettings(settings);
  return normalized.rate == null && intervalUncovered(span.started_at, span.ended_at, normalized);
}

// The informational twin of that marker (#193): the span has an uncovered
// slice AND a finite flat fallback prices it — the exact inverse of the
// warning's no-fallback gate, so the two predicates are mutually exclusive by
// the rate they read. The figure is policy-correct, so nothing warns; the
// Status tile adds a subdued line naming the fallback that part prices at,
// beside the cost (the warning stays the only warning-coloured line).
export function statusCostFallback(status, settings) {
  const span = liveStatusSpan(status, settings);
  if (!span) return false;
  const normalized = costSettings(settings);
  return normalized.rate != null && intervalUncovered(span.started_at, span.ended_at, normalized);
}

// The shared gate the two markers read: the same span the figure prices, and
// only under a schedule (a flat plan covers every instant by definition).
function liveStatusSpan(status, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return null;
  return liveSessionSpan(status);
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
// [anchorMs - elapsed, anchorMs] — one span handed to the same pricer the
// live figure and the period pass use (#210) — the window the last live
// render priced. Null rules mirror the span's: no schedule takes the flat
// path (byte-identical, the anchor ignored), and a missing or unusable
// elapsed or anchor hides the figure rather than guessing a window.
export function heldCostLabel(wh, elapsed, anchorMs, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return flatCostLabel(wh, normalized);
  const span = heldSpan(wh, elapsed, anchorMs);
  if (!span) return null;
  const cost = spanCost(span, normalized);
  return cost == null ? null : fmtMoney(cost, normalized.currency);
}

// The frozen window as one span object, or null when the pair cannot name a
// window — the construction the three held labels share.
function heldSpan(wh, elapsed, anchorMs) {
  const seconds = toNumber(elapsed);
  const endMs = endMillis(anchorMs);
  if (!Number.isFinite(seconds) || seconds <= 0 || endMs == null) return null;
  return { started_at: endMs - seconds * 1000, ended_at: endMs, wh };
}

// Whether the held span includes a slice no base/window prices at a row —
// the same marker the live figure carries, evaluated over the frozen window,
// and gated the same way: with a finite flat fallback the slice prices at that
// rate, so only a missing fallback makes the figure understate cost.
export function heldCostUncovered(elapsed, anchorMs, settings) {
  return heldSpanMarker(elapsed, anchorMs, settings, (normalized) => normalized.rate == null);
}

// The informational twin of the held warning (#193), gated exactly like the
// live one: the frozen window has an uncovered slice that the finite stored
// flat rate prices, so the figure is honest and only the fallback deserves
// naming — on the subdued line, never the warning.
export function heldCostFallback(elapsed, anchorMs, settings) {
  return heldSpanMarker(elapsed, anchorMs, settings, (normalized) => normalized.rate != null);
}

// The two markers share everything but the rate they read: the span over the
// frozen window, its uncovered slices, and the schedule-only gate.
function heldSpanMarker(elapsed, anchorMs, settings, wantsRate) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return false;
  if (!wantsRate(normalized)) return false;
  const span = heldSpan(1, elapsed, anchorMs);
  if (!span) return false;
  return intervalUncovered(span.started_at, span.ended_at, normalized);
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

// The local-midnight window a bucket id names, `{start, end}` in ms: a day id
// spans one local day, a month id one local calendar month. Null when the id is
// neither, so the caller hides the bucket.
function bucketWindow(id) {
  const dayStart = dayStartFromId(id);
  const monthStart = dayStart == null ? monthStartFromId(id) : null;
  const start = dayStart != null ? dayStart : monthStart;
  if (!start) return null;
  const end =
    dayStart != null
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime()
      : new Date(start.getFullYear(), start.getMonth() + 1, 1).getTime();
  return { start: start.getTime(), end };
}

// One span's share of the bucket: the part falling inside the window, with the
// span's energy pro-rated by that part's share of the span's real duration and
// priced over its own wall-clock span by costForInterval. Returns `{cost, wh}`
// for a contributing span, `undefined` when the span does not reach the window
// (skip it), or null when the pricer cannot price the slice — unreachable under
// a schedule (a slice no row matches prices at the stored flat rate, 0.00 only
// when no finite flat rate is stored), kept so a null from the engine
// hides the bucket instead of half-pricing it.
function bucketSlice(span, window, settings) {
  const spanStart = valueMillis(span.started_at);
  const spanEnd = valueMillis(span.ended_at);
  if (spanStart == null || spanEnd == null || spanEnd <= spanStart) return undefined;
  const from = Math.max(spanStart, window.start);
  const to = Math.min(spanEnd, window.end);
  if (to <= from) return undefined;
  const sliceWh = (span.wh * (to - from)) / (spanEnd - spanStart);
  const cost = costForInterval(sliceWh, from, to, settings);
  if (cost == null) return null;
  return { cost, wh: sliceWh };
}

// One span priced over its own window — the same slice the window pass prices
// when a span sits inside a bucket (#210). The Status tab's live and held
// figures derive from this: their windows are spans, and the span model is
// the only pricing path, so the two screens can never disagree about the
// engine that priced the same charge. The energy gate is costForInterval's
// own (an unusable or negative `wh` hides the figure); heldSpan passes its
// `wh` through ungated, so the pricer's null rules stay the single gate.
function spanCost(span, settings) {
  const energy = toNumber(span && span.wh);
  if (!Number.isFinite(energy) || energy < 0) return null;
  const startMs = valueMillis(span.started_at);
  const endMs = valueMillis(span.ended_at);
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  const slice = bucketSlice(span, { start: startMs, end: endMs }, settings);
  return slice ? slice.cost : null;
}

// The totals across every span of the list: `{cost, wh}`, or null as soon as
// one slice is unpriceable — the whole window then hides rather than showing a
// figure that prices only part of its energy. The input is span objects
// (#210): the closed sessions' sessionCostSpans and the live contribution's
// span are the same shape, so there is exactly one pricing input and no
// pseudo-session to special-case.
function spansTotals(spans, window, settings) {
  let cost = 0;
  let wh = 0;
  for (const span of Array.isArray(spans) ? spans : []) {
    // A malformed entry is skipped like the series builders skip one —
    // sessionCostSpans never yields it, but the exported pricing entry
    // points take caller input.
    if (!span || typeof span !== 'object') continue;
    const slice = bucketSlice(span, window, settings);
    if (slice === null) return null;
    if (!slice) continue;
    cost += slice.cost;
    wh += slice.wh;
  }
  return { cost, wh };
}

// Whether the attributed Wh cover the bucket's recorded kWh: covered within the
// same max(250 Wh, 2%) tolerance the interval reconciliation uses, and covered
// by definition when the reading is unusable or zero (there is nothing to cover).
function bucketCovered(kwh, wh) {
  const totalWh = toNumber(kwh) * 1000;
  if (!Number.isFinite(totalWh) || totalWh <= 0) return true;
  return wh >= totalWh - intervalEnergyTolerance(totalWh);
}

// One local day ('YYYY-MM-DD') or month ('YYYY-MM'→month) bucket priced from
// the span list — the Week/Month/Year bars' pricing source, slicing the same
// pass the period summary prices (windowCostSummary below) at one bucket's
// edges. Each span is sliced at the bucket's local-midnight boundaries and
// priced over its own wall-clock span by costForInterval, with the slice's
// energy pro-rated by its share of the span's real duration — the same
// constant-power split costForInterval applies inside a span, and every
// bucket edge is a local midnight costForInterval already splits at, so a
// session's bucket costs sum to exactly its per-session figure (the
// reconciliation the summary leans on). `wh` is also the energy a day or month
// bar prints under a schedule (the History screen's displayedKwh) whenever it
// is above zero — so whenever the pass attributes energy to a bucket, its
// bar's kWh is exactly what its cost prices. `kwh` — the day document's
// recorded figure — only measures coverage, with the same max(250 Wh, 2%)
// tolerance the interval reconciliation uses: attributed Wh that accounts for
// the bucket means covered, energy with no covering span beyond that band
// hides its figure and leaves the recorded kWh on the bar, never priced free
// (a day recorded at 0.25 kWh or less is covered with nothing attributed, and
// shows 0.00).
// Returns {cost, wh, covered}, or null without a usable schedule or bucket id
// (the flat path is and stays aggregateCostLabel's).
export function sessionBucketCost(spans, id, kwh, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return null;
  const window = bucketWindow(id);
  if (!window) return null;
  const totals = spansTotals(spans, window, normalized);
  if (!totals) return null;
  return { cost: totals.cost, wh: totals.wh, covered: bucketCovered(kwh, totals.wh) };
}

// The ms window a day-id range names — a period's whole bounds: the first
// day's local midnight to the midnight after its last day, the range twin of
// bucketWindow, so the one summary pass prices exactly the window its series
// was built for.
export function rangeWindow(startId, endId) {
  const first = dayStartFromId(startId);
  const last = dayStartFromId(endId);
  if (!first || !last || last < first) return null;
  return {
    start: first.getTime(),
    end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime(),
  };
}

// ---------- the live session's period contribution (#126, residual #128) ----------

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

// The recorded side of the residual derivation: the energy the merged payload
// already prices inside the live window, and where that pricing ends.
//
// `recorded` is every span of `sessions` — read through the same
// sessionCostSpans the bucket pricing reads, on both of its paths
// (reconciling intervals and the whole-span fallback) — that overlaps the
// window under the settle predicate's own half-open test
// (`start < liveEnd && end > liveStart`: a span touching either edge prices
// none of it). Parity with sessionBucketCost's span set is the
// no-double-count proof: the subtraction below removes exactly the energy the
// bucket will add beside the contribution. Each span's in-window share is its
// duration-pro-rated energy — span.wh × overlap / span duration, the same
// clip the bucket applies at its own edges — and never the whole record's
// `wh`: a straddling record's out-of-window energy is not in the meter
// reading the residual divides, so subtracting it wholesale would drive the
// residual negative and hide a tail the record does not price (a quiet
// misprice).
//
// Returns `{recordedWh, tailStart}`; tailStart — the latest end among the
// overlapping spans, the instant the record stops pricing — is null when
// nothing overlaps (a fresh plug-in, or records entirely outside the window).
function recordedInWindow(sessions, liveStart, liveEnd) {
  let recordedWh = 0;
  let tailStart = null;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const spans = sessionCostSpans(session);
    if (!spans) continue;
    for (const recorded of spans) {
      const start = valueMillis(recorded.started_at);
      const end = valueMillis(recorded.ended_at);
      if (start == null || end == null || end <= start) continue;
      if (!(start < liveEnd && end > liveStart)) continue;
      const overlap = Math.min(end, liveEnd) - Math.max(start, liveStart);
      recordedWh += (recorded.wh * overlap) / (end - start);
      if (tailStart == null || end > tailStart) tailStart = end;
    }
  }
  return { recordedWh, tailStart };
}

// The live window's contribution to a period's pricing, or null: schedule
// only (a flat day total already prices the accruing kWh, so the flat output
// is byte-identical with or without a charge in progress), live-gated and
// settle-guarded. The returned span joins the period's span list
// (periodCostSpans below), so its cost lands in exactly the buckets its
// window overlaps — today's bar, and yesterday's when the charge crossed
// local midnight — with the same constant-power split every other span
// prices by, and its Wh counts toward the bucket's coverage, so a
// live-covered today shows its bar $.
//
// With nothing recorded inside the window this is the whole live span,
// byte-identical to #126's fresh-charge contribution. Once a recorded span
// overlaps it, the whole-window estimate would double-price the slice the
// record already prices, so what returns is the residual tail (#128):
// `session_energy` (already Wh — no kWh conversion; costForInterval does
// that) minus the recorded energy clipped to the window, as one span over
// [tailStart, liveEnd] — the TAIL only, never a general complement, because
// interior idle gaps drew nothing and the current block's energy must not
// spread backwards across hours-old rate boundaries.
//
// Exactly two gates hide the contribution before any bucket sees it:
//   - residual < 0 — the records price more energy inside the window than the
//     meter read: an in-block counter reset's overshoot, a foreign overlap,
//     or an overlapping-documents defect. The negative span must be gated
//     here, upstream of sessionBucketCost: costForInterval hides a negative
//     energy, and one null slice nulls the bucket's whole figure
//     (hide-into-breakage — the one place this rule can regress).
//   - tailStart ≥ liveEnd — the record prices through the write's own
//     instant: the settle race's session-first order. The whole window is
//     already priced, exactly once, by the record itself.
// No tolerance gate exists: the residual IS the accruing current block, so a
// max(250 Wh, 2%) branch would hide exactly the case #128 exists to price —
// and downstream "ambiguous" and "settled" are indistinguishable anyway (both
// null; the bucket's own covered check decides what shows). The return
// contract is uniform — whenever records overlap and the gates pass, the
// contribution IS the tail, with no special-cased wh ≈ 0 branch: a
// zero-residual span adds 0 to the bucket's wh and cost alike (identical
// to the span being absent, so coverage cannot flip either way), while a
// non-zero tail's Wh is what feeds the bucket's coverage check.
//
// Approximation (accepted, the Status tab's own class): the residual energy
// is priced at constant power over the tail, leading idle included — the
// resume rarely lands exactly on the record's end — exactly as
// statusCostLabel spreads the whole reading uniformly across the full window.
// On a zero-idle tail the two figures agree exactly; the reconciliation
// target is the Status tab's.
export function liveSessionContribution(status, sessions, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return null;
  const span = liveSessionSpan(status);
  if (!span) return null;
  const liveStart = valueMillis(span.started_at);
  const liveEnd = valueMillis(span.ended_at);
  const { recordedWh, tailStart } = recordedInWindow(sessions, liveStart, liveEnd);
  if (tailStart == null) return span;
  const residualWh = span.wh - recordedWh;
  if (residualWh < 0) return null;
  if (tailStart >= liveEnd) return null;
  return { started_at: tailStart, ended_at: liveEnd, wh: residualWh };
}

// The span list a period prices (#210): every closed session's spans plus,
// when `live` (the rendered series includes a current bucket, so the live
// window can overlap this period), the live session's contribution. The
// contribution is itself one span object — the same shape sessionCostSpans
// yields — so the merge is a concatenation, not a pseudo-session riding the
// sessions array: the pricing pipeline has exactly one input type and the
// span model is the only path. Sessions whose spans are unusable contribute
// nothing (sessionCostSpans' null), exactly as the window pass has always
// skipped them.
export function periodCostSpans(status, sessions, settings, live = false) {
  const spans = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionSpans = sessionCostSpans(session);
    if (sessionSpans) spans.push(...sessionSpans);
  }
  if (live) {
    const contribution = liveSessionContribution(status, sessions, settings);
    if (contribution) spans.push(contribution);
  }
  return spans;
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
// `hours` map ({"00"…"23": kWh}). #210 leaves these buckets exactly one job:
// the Day period's hourly bars, each priced over its own wall-clock hour by
// costForInterval — pure display, the same engine the live and per-session
// costs use. Period pricing — the Day period's summary included — is the span
// pass (windowCostSummary above); the hours map is a chart series, so there is
// one pricing source per figure and no energy is priced twice. The flat path
// is and stays aggregateCostLabel's — these helpers price only under a
// schedule (null without one), so flat output stays byte-identical and there
// is exactly one flat implementation.

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
// at the stored flat rate — 0.00 only when no finite flat rate is stored, the
// existing plan-banner rule — so under a schedule the null cases
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
// A recorded total in Wh — the day documents' own kWh, normalized the way
// `sumSeries` reads a series (an unusable reading is zero), so the summary's
// recorded total can never disagree with the day totals the chart draws.
function recordedWh(kwh) {
  const total = toNumber(kwh);
  return Number.isFinite(total) && total > 0 ? total * 1000 : 0;
}

// The one period summary (#210): a window priced once, from the same span list
// its bars price, with the headline energy derived in the same pass as the
// priced energy — `coveredWh` is both, so the kWh the summary shows and the $
// beside it cannot diverge by construction (the tolerance-swallowing class
// #211 retired cannot recur: there is no second aggregation to disagree with
// the first). `recordedKwh` is the day documents' own total for the window —
// the range series' sum, the day document's `kwh` on the Day period: the pass
// never prices from it. It is the caption's Y (the basis the bridge's
// day-verdicts measured) and the hide rule's guard — the one honest measure of
// energy the archive might be missing. Hide-not-misprice: a window whose day
// documents recorded energy the span list prices none of hides its figure (a
// 0.00 there would read as free); an empty window is a real $0.00. Returns
// `{cost, coveredWh, recordedWh}`, or `{cost: null}` under a flat config —
// the flat path is and stays aggregateCostLabel's.
export function windowCostSummary(spans, window, recordedKwh, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return { cost: null };
  const recorded = recordedWh(recordedKwh);
  if (!window) return { cost: null, coveredWh: 0, recordedWh: recorded };
  const totals = spansTotals(spans, window, normalized);
  if (!totals) return { cost: null, coveredWh: 0, recordedWh: recorded };
  const pricedEnergy = totals.wh > 0;
  const unpricedEnergy = recorded > 0 && !pricedEnergy;
  return {
    cost: unpricedEnergy ? null : totals.cost,
    coveredWh: totals.wh,
    recordedWh: recorded,
  };
}

// The period summary's coverage disclosure (#194, #211): the kWh the figure
// prices, painted beneath it as a small muted caption while the kWh total the
// summary already shows stays the day documents' own, whenever the stored
// sessions cover only part of the recorded energy — any missing Wh at all
// (#211): no tolerance floor and nothing that scales with the period's size,
// so a month can no longer absorb a gap a week would disclose. Both energies
// are compared at whole-Wh resolution — the charger counter's own 0.001 kWh
// quantum — so quantization and attribution float noise cannot flicker the
// line; a gap of exactly zero at that resolution is the only silent one.
// (The interval reconciliation and the buckets' own per-bucket $-hiding keep
// their max(250 Wh, 2%) band; this caption no longer shares it.) Null
// whenever the $ itself hides (a period with nothing covered keeps today's
// hidden presentation); no figure is invented, and the kWh totals are never
// touched. Both energies format the way every kWh in the app does (fmtK) —
// except when that app formatting renders the two figures alike (fmtK shows
// no decimals at ≥100 kWh), where the caption falls back to two-decimal
// figures so a fired line always shows the magnitude it is disclosing.
export function coverageDisclosure(summary) {
  if (!summary || summary.cost == null) return null;
  const recorded = toNumber(summary.recordedWh);
  const covered = toNumber(summary.coveredWh);
  if (!Number.isFinite(recorded) || recorded <= 0 || !Number.isFinite(covered)) return null;
  if (Math.round(recorded) - Math.round(covered) < 1) return null;
  return pricedOfText(covered, recorded);
}

// The `priced X of Y kWh` caption text both disclosures share (#194): the
// app's own kWh formatting, with the two-decimal fallback that keeps a fired
// line legible whenever fmtK renders both figures alike.
function pricedOfText(coveredWh, recordedWh) {
  const coveredText = fmtK(coveredWh / 1000);
  const recordedText = fmtK(recordedWh / 1000);
  if (coveredText === recordedText) {
    return `priced ${(coveredWh / 1000).toFixed(2)} of ${(recordedWh / 1000).toFixed(2)} kWh`;
  }
  return `priced ${coveredText} of ${recordedText} kWh`;
}

// ---------- the day-verdict caption (#212) ----------
//
// The bridge's seam-B reconciler writes a per-day verdict on the day
// documents themselves: `gap_wh`, the raw signed same-basis delta (the day's
// recorded Wh minus the sessions archive's Wh for that local day), written
// once and never corrected — detection only discloses. The read contract is
// three-state: a number is a settled verdict; null marks a day the
// reconciler cannot verdict honestly (a stored interval straddles its
// midnight, so the split would be the constant-power approximation); absent
// means evaluated clean — but only for days at or after the `recon_from`
// marker, and only once the day has settled: the reconciler defers a day's
// verdict while an open session may still overlap it (its ~3-day trailing
// window), so an absent verdict there is "not yet settled", never clean.
// Verdicts therefore vouch for a period only when every day of the window
// carries one; anything less and the #211 attribution compare above keeps
// the caption exactly as it is.

// How many days before today an absent verdict still counts as deferred: the
// reconciler's own trailing window (pi/archive_reconcile.py
// TRAILING_WINDOW_DAYS), so the two sides of this contract agree on when a
// day's silence becomes the clean verdict.
const VERDICT_DEFERRAL_DAYS = 3;

// Whether a day sits inside that trailing window. Calendar-day distance, not
// milliseconds: a DST transition makes today−3 up to an hour more or less
// than 72 h of wall clock, and the reconciler's window is calendar days.
// An unparsable id can never be vouched for, so it reads as deferred.
function deferredDay(id, todayId) {
  const day = dayStartFromId(id);
  const today = dayStartFromId(todayId);
  if (!day || !today) return true;
  const back = Math.round((today.getTime() - day.getTime()) / 86400000);
  return back >= 0 && back <= VERDICT_DEFERRAL_DAYS;
}

// One day's verdict in Wh — a number when the verdict vouches for the day,
// null when it cannot: before `recon_from` (legacy), the explicit null mark
// (unverdictable), a malformed value, or an absent verdict still inside the
// deferral window. `gapWh` is the day document's own `gap_wh` field,
// undefined when the day carries none.
function dayVerdictWh(id, gapWh, reconFrom, todayId) {
  if (!reconFrom || id < reconFrom) return null;
  if (typeof gapWh === 'number' && Number.isFinite(gapWh)) return gapWh;
  if (gapWh === undefined && !deferredDay(id, todayId)) return 0;
  return null;
}

// The period's day-verdict state for one viewed window: null when the marker
// is off (a bridge without seam B — the whole feature is off, today's caption
// everywhere), else `{settled, sumWh, maxAbsWh, posSumWh, maxPosWh}` —
// `settled` only when every day of the window carries a vouching verdict,
// `sumWh` their signed sum, `maxAbsWh` the largest single day's |gap|
// (informational), and `posSumWh`/`maxPosWh` the sum and largest of the
// POSITIVE verdicts alone — `maxPosWh` is the drift-vs-gap discriminator
// below. `dayIds` are the window's own days oldest first
// (dayIdsInRange, or the Day period's single id); `docs` are the read's day
// documents, the only place a verdict lives; `todayId` is the clock the
// window was captured at, which is what the deferral boundary means.
export function dayVerdicts(dayIds, docs, reconFrom, todayId) {
  if (!reconFrom || !Array.isArray(dayIds) || dayIds.length === 0) return null;
  const gaps = new Map();
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (doc && typeof doc.id === 'string') gaps.set(doc.id, doc.gap_wh);
  }
  let settled = true;
  let sumWh = 0;
  let maxAbsWh = 0;
  let posSumWh = 0;
  let maxPosWh = 0;
  for (const id of dayIds) {
    const wh = dayVerdictWh(id, gaps.get(id), reconFrom, todayId);
    if (wh == null) settled = false;
    else {
      sumWh += wh;
      maxAbsWh = Math.max(maxAbsWh, Math.abs(wh));
      if (wh > 0) {
        posSumWh += wh;
        maxPosWh = Math.max(maxPosWh, wh);
      }
    }
  }
  return { settled, sumWh, maxAbsWh, posSumWh, maxPosWh };
}

// The single-day magnitude that separates drift from a real gap (owner
// decision, 2026-11-22): production clean-day verdicts run ±0.6–3.1 Wh of
// two-meter disagreement, so 10 Wh is a full quantum beyond anything the
// meters argue about — one day that far out is archive loss, not drift.
const VERDICT_GAP_WH = 10;

// The verdict-driven caption for a period whose every day is settled (#212,
// replacing the #211 attribution compare there — the exact same-basis verdict
// is the authority, and a clean verdict must silence the attribution noise
// beside it). One logic for every period (#210): Day prices from the same
// session basis the ranges do, so its coverage is comparable and no period
// carries a carve-out:
//   - any single day with a POSITIVE gap ≥ 10 Wh renders the full
//     `priced X of Y kWh` caption: X = the recorded total minus the sum of
//     the POSITIVE verdicts (missing energy; over-attribution on other days
//     must not cancel it out of the warning), clamped so X never exceeds Y
//     nor goes negative. The discriminator stays the single positive day —
//     a month of sub-10 Wh drift days is the tolerance note's shape, not a
//     caption, per the owner decision;
//   - any other nonzero NET sum renders the quiet tolerance note stating
//     the |net| drift honestly — including all-negative windows (the
//     archive holds more than the day documents recorded, which the
//     `priced X of Y` shape cannot say) and lone large negative days
//     (over-coverage is not missing data);
//   - a net sum of exactly zero (at whole-Wh resolution, the caption's own)
//     renders nothing: vouched clean is clean.
// `summary` is the same windowCostSummary pass whose caption this replaces
// (it contributes the recorded total); the $ figure itself is untouched.
export function verdictCaption(verdicts, summary) {
  if (!verdicts || !verdicts.settled) return null;
  const sum = Math.round(verdicts.sumWh);
  if (verdicts.maxPosWh >= VERDICT_GAP_WH) {
    const recorded = toNumber(summary && summary.recordedWh);
    if (Number.isFinite(recorded) && recorded > 0) {
      const covered = Math.min(Math.max(recorded - Math.round(verdicts.posSumWh), 0), recorded);
      return pricedOfText(covered, recorded);
    }
  }
  if (sum !== 0) {
    const kwh = Math.abs(sum) / 1000;
    // The drift formats like every kWh (two decimals), falling back to the
    // counter's own 0.001 kWh quantum whenever that would print 0.00 — a
    // fired note always shows the magnitude it states.
    const drift = kwh.toFixed(2) === '0.00' ? kwh.toFixed(3) : kwh.toFixed(2);
    return `charger day meters differ by ${drift} kWh over this period — within meter tolerance`;
  }
  return null;
}

// ---------- the per-window rate-scope flag (#193) ----------

// The ms window one rendered bucket names — the same span its figure is priced
// over — or null when the point carries no usable bucket. An hour point needs
// its day (the Day period's bars): the window is that day's own wall-clock
// hour, exactly the span hourCost prices.
function pointWindowMs(point, bucket) {
  if (!point) return null;
  if (bucket === 'hour') {
    const start = dayStartFromId(point.dayId);
    const hour = toNumber(point.id);
    if (!start || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    const from = hourStartMs(start, hour);
    return { start: from, end: from + 3600000 };
  }
  return bucketWindow(point.id);
}

// Whether the viewed window contains time no rate row covers (#193): true when
// any bucket of the rendered series — each priced over exactly the span
// pointWindowMs names — has an uncovered slice. That is a statement about the
// window, not the plan: a flat plan covers every instant by definition, and a
// plan whose gap lies outside the window reads fully row-priced here, which is
// what separates this flag from the plan-wide banner (settings.js's
// planHasUnpriced). The flag names scope, not price — since #188 such a slice
// costs the stored flat rate (0 only when no finite flat rate is stored) — so
// the History summary says which price that part of the window carries instead
// of letting it read as a TOU figure.
export function seriesWindowUncovered(points, bucket, settings) {
  const normalized = costSettings(settings);
  if (!hasRateSchedule(normalized)) return false;
  for (const point of Array.isArray(points) ? points : []) {
    const window = pointWindowMs(point, bucket);
    if (window && intervalUncovered(window.start, window.end, normalized)) return true;
  }
  return false;
}
