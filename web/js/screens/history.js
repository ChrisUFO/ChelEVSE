// History screen: a Day / Week / Month / Year energy chart over hand-rolled SVG
// bars, plus the sessions list — the 20 most recent by default, pageable deeper
// into the archive and browsable one month at a time. One-shot reads on first
// tab activation, on Refresh and on a period switch — deliberately no realtime
// listener here — with one pushed input beside them (#126): the status snapshot
// the app's listener fans out, which prices the in-progress session into the
// current bucket and, on the charging→stopped edge, triggers the settle re-read
// that takes the recorded session's pricing over — with one verification
// re-read behind it, for a session write the bridge retried after the settle
// read fetched.

import { $, el, setText } from '../ui.js';
import {
  fetchHistory,
  fetchHistoryDay,
  fetchReconMarker,
  fetchSessions,
  fetchSessionsInRange,
} from '../store.js';
import {
  DEFAULT_PERIOD,
  PERIODS,
  chartIndexAt,
  dayId,
  dayIdsInRange,
  dayLabel,
  emptySessionsView,
  historyReadState,
  hourRange,
  hourReadFailure,
  hourReadState,
  maxSeries,
  nextSessionsView,
  periodAnchor,
  periodBounds,
  periodById,
  periodSeries,
  periodSpan,
  sectionView,
  sessionsControls,
  sessionsRange,
  sumSeries,
} from '../history.js';
import {
  aggregateCostLabel,
  costSettings,
  coverageDisclosure,
  dayVerdicts,
  hasRateSchedule,
  hourCost,
  liveSessionSpan,
  periodCostSpans,
  rangeWindow,
  sessionBucketCost,
  sessionCostLabel,
  seriesWindowUncovered,
  verdictCaption,
  windowCostSummary,
} from '../cost.js';
import { planHasUnpriced } from '../settings.js';
import { fmtK, fmtRate, formatDuration, fmtMoney, toNumber } from '../format.js';
import { BASE, BAR_RATIO, VIEW_W, buildBar, svgEl } from './history-chart.js';

let active = false;
let loaded = false;
let loading = false;
// Full cost settings ({rate, currency, rates}), re-read on every render:
// per-session costs, the flat aggregate and the schedule-priced aggregates
// below all take it per call, so a saved schedule re-prices the whole screen
// with nothing stored. Nothing here is ever written back to history/*.
let settings = null;
// Selected chart range (a PERIODS id), and the read that owns the chart. Every
// history read takes a sequence number so a period switch cannot be repainted by
// the read it superseded.
let periodId = DEFAULT_PERIOD;
let historySeq = 0;
let series = [];
let selectedId = null;
// How many whole calendar units back the chart is paged; 0 is the current unit
// (this month at the default period), and nothing beyond the present is
// reachable. The window itself — its anchor, document range, calendar span and
// the local date the anchor was taken on — is built once per read by
// buildWindow; all window arithmetic stays in js/history.js.
let periodOffset = 0;
let chartWindow = null;
// The window the series on screen was built for: the span every string that names
// the drawn window is painted from. `chartWindow` is the window the *newest read*
// started, and a reload rebuilds it from a fresh clock before its read settles —
// after local midnight the two name different days, and a failed read would
// otherwise relabel the bars it retained with a window they do not cover. The
// label follows the series, never the read; the read's own window still names the
// loading copy, which paints only with no series on screen.
let seriesSpan = null;
// The ms window the applied series was built for — the span pass's window
// (#210): the summary prices exactly the window its points and sessions were
// read for, never the window a newer, failed read names. Set with the series
// in applyHistory and cleared with it.
let seriesWindowMs = null;
// The sessions list's whole view state — page one of the recent list or of a
// browsed month, plus every page appended since. Kept as one object because
// the paging rules (accumulate, adopt a view, conclude exhaustion) belong to
// `nextSessionsView`, which maps one settled read onto the next view.
let sessionsView = emptySessionsView();
// Every sessions read takes a sequence number, like the chart's: a month
// switch, a refresh and a "show more" can supersede each other, and only the
// newest read may paint. `sessionsBusy` marks a read in flight so the
// "show more" control cannot stack a second page onto one already loading.
let sessionsSeq = 0;
let sessionsBusy = false;
// Latest settled read per section: idle | loading | fresh | empty | cached |
// offline | error | no-intraday. Tracked separately so one section's outcome
// never speaks for the other, and so freshness is never inferred from how much
// data is on screen.
let historyState = 'idle';
// The sessions that price the current period's $ (#123): every session
// overlapping the range, read beside the day documents and kept beside the
// series it prices. Cleared with the series; a failed read prices nothing —
// the figure hides rather than pricing uncovered energy.
let periodSessions = [];
// The bridge's per-day verdicts on the applied window (#212): null while the
// `recon_from` marker is off or no read has settled, else the classification
// dayVerdicts returned for the window's own days — `settled` only when every
// day carries a vouching verdict. Kept beside the series it classifies and
// cleared with it: a period switch, a superseded read and a reset all drop
// the previous window's verdicts together with its points.
let periodVerdicts = null;
// The latest status/current snapshot pushed by the app's listener (#126) — the
// input the live contribution prices today's bucket from, kept beside the
// period payload so either input may land first: the contribution is decided
// against the merged state at render time, never at arrival time.
let liveStatus = null;
// The charging→stopped edge was seen after a live-priced write: the bridge
// records the session on that same edge, so one re-read must take the recorded
// pricing over before the estimate could linger or vanish unpinned.
let settlePending = false;
// One verification re-read follows a settle re-read: the bridge keeps a failed
// session write pending and retries it on its next tick, so the settle read can
// fetch just before the record commits. The next status push — or the next
// History activation — earns exactly one more re-read: one-shot, so an idle
// status stream never re-reads forever, and idempotent under the render-time
// settle guard.
let settleVerify = false;
// Today's daily total, kept separately because a day with no hourly buckets has
// a real total the series cannot carry (the chart refuses to draw it as zeros).
let dayTotal = null;
// Whether the payload currently on screen came from an answer the server gave
// (fresh/empty). Cached, offline, and failed reads never set it.
let historyServer = false;
let barEls = [];
let generation = 0;
let scrubbing = false;
let scrubPointer = null;

// ---------- summary + chart costing ----------

// The bucket/window cost summaries and the coverage disclosure live in
// js/cost.js beside the pricing helpers they call; re-exported here so the
// screen's tests keep this path — the day-verdict pair with them (#212).
export {
  coverageDisclosure,
  dayVerdicts,
  periodCostSpans,
  rangeWindow,
  sessionBucketCost,
  seriesWindowUncovered,
  verdictCaption,
  windowCostSummary,
} from '../cost.js';

// The spans a render prices (#210): the period's recorded sessions plus, while
// a charge is live and the series includes a current bucket (today, or this
// month — the window the live window can overlap), the live session's
// contribution — one list of span objects built by periodCostSpans (js/cost.js),
// the only pricing input. There is no pseudo-session merge and no bucket-kind
// branch: the summary and the day/month bars all price this list over their
// own windows. The settle guard runs inside it, against the recorded payload
// as merged, so whichever of the two inputs — the session document or the
// status snapshot — lands first, a charge a recorded session already covers
// prices exactly once.
function pricingSpans() {
  return periodCostSpans(
    liveStatus,
    periodSessions,
    settings,
    series.some((point) => point.isCurrent),
  );
}

// One bucket's cost label, or null to hide: flat keeps aggregateCostLabel's
// byte-identical path. Under a schedule an hour bar prices the day document's
// own bucket over its wall-clock hour — pure display, never the summary's
// basis — and a day or month bar prices the span list attributed to its
// bucket, hiding when the bucket's recorded energy is entirely without
// covering spans (the per-bucket data-validity band, bucketCovered's).
function seriesCost(point) {
  if (!hasRateSchedule(settings)) return aggregateCostLabel(point.kwh, settings);
  if (currentPeriod().bucket === 'hour') {
    const cost = hourCost(point.dayId, point.id, point.kwh, settings);
    return cost == null ? null : fmtMoney(cost, settings.currency);
  }
  const totals = sessionBucketCost(pricingSpans(), point.id, point.kwh, settings);
  if (!totals || (!(totals.wh > 0) && !totals.covered)) return null;
  return fmtMoney(totals.cost, settings.currency);
}

// ---------- summary + chart ----------

// A saved plan with any instant no rate row covers advertises it on History:
// such an instant costs the stored flat rate (#188) — 0.00 only when no
// finite flat rate is stored. Kept as a pure predicate so the wiring is
// testable without a DOM.
export function showPlanBanner(data) {
  const normalized = costSettings(data);
  return hasRateSchedule(normalized) && planHasUnpriced(normalized.rates);
}

function renderPlanBanner() {
  const banner = $('history-plan-banner');
  if (!banner) return;
  banner.hidden = !showPlanBanner(settings);
  if (banner.hidden) return;
  // The banner names a coverage gap, not only under-pricing, so it keeps
  // appearing while a finite flat fallback prices the gap (#188) — but then the
  // copy must say that price instead of claiming 0.00. Only a missing fallback
  // keeps the 0.00 wording.
  setText(
    $('history-plan-banner-text'),
    settings.rate != null
      ? `Some dates or hours fall outside every season window and are priced at your flat rate ${fmtRate(settings.rate, settings.currency)}.`
      : 'Some dates or hours have no price and are shown at 0.00.',
  );
}

// The per-window rate-scope flag (#193): the plan banner above speaks for the
// whole saved plan — it fires on any gap anywhere — while this line speaks for
// the window on screen only. A season that expired mid-month makes a November
// week partly flat-priced (the line names the fallback) while a July week of
// the same plan is fully row-priced (no line), and a flat-only plan never
// flags. The predicate is pure (seriesWindowUncovered, js/cost.js) over the
// series' own bucket windows — exactly the spans the period's figures price —
// so the sentence's "this week/month/year/day" names the same window the
// summary does, and it composes with the cost cell untouched: the #194
// coverage caption keeps its own small muted line under the figure, this one
// adds a second sentence beneath the card.
function renderWindowNote() {
  const note = $('history-window-note');
  if (!note) return;
  const uncovered = seriesWindowUncovered(series, currentPeriod().bucket, settings);
  note.hidden = !uncovered;
  if (note.hidden) return;
  // The #192 copy rule: name the stored flat rate while one is finite; only a
  // missing fallback keeps the 0.00 sentence.
  const unit = currentPeriod().unit;
  setText(
    note,
    settings.rate != null
      ? `Part of this ${unit} prices at your flat rate ${fmtRate(settings.rate, settings.currency)}.`
      : `Part of this ${unit} has no price and is shown at 0.00.`,
  );
}

function currentPeriod() {
  return periodById(periodId);
}

function periodHeading(descriptor) {
  return descriptor.noun.charAt(0).toUpperCase() + descriptor.noun.slice(1);
}

// The chart heading, summary label and SVG label name the selected period's
// calendar unit; the segment control is static markup, so the period copy is
// applied here instead of being duplicated across the markup. Every one of those
// strings comes from the descriptor's copy(span) — the window the chart is
// actually drawing — so a paged window is named by its own month, week, year or
// date ("September 2026", "Mon 5 – Sun 11 Oct 2026") and never by the window the
// clock happens to be in.
function paintPeriodCopy() {
  const descriptor = currentPeriod();
  const span = currentSpan();
  const copy = descriptor.copy(span);
  setText($('chart-heading'), periodHeading(descriptor));
  setText($('history-total-label'), span.label);
  // One sentence for every unit and every offset, in the span's prose register —
  // the same register the SVG label beside it reads. A bare label plus "summary"
  // would glue a hard-spaced date range ("Mon 5 – Sun 11 Oct 2026 summary") where
  // only a month or year noun reads.
  $('history-summary').setAttribute('aria-label', `Energy summary for ${span.phrase}`);
  $('history-chart').setAttribute('aria-label', copy.chartLabel);
  paintPagingControls(descriptor);
}

// The description of the window on screen. The series owns it whenever there is
// one: a read for a different window (a reload that re-anchored at the new local
// date) may not relabel bars it did not produce, so the label keeps naming the
// window those bars were read for. With no series the window being read is the
// honest one — the loading, empty, offline and error copy all name what was
// asked for. Before the first read (and after a reset) there is no window at all,
// so the default view's wording is the honest one — the same strings the read at
// offset 0 would paint. Both ends of that fallback span come from one clock read:
// two `new Date()` calls could straddle local midnight and name two different
// days.
function currentSpan() {
  if (seriesSpan) return seriesSpan;
  if (chartWindow) return chartWindow.span;
  const now = new Date();
  return periodSpan(currentPeriod(), now, now);
}

// "Previous week" / "Next month": the calendar unit the period pages by, so the
// accessible name says what activating the control does.
function pagingName(descriptor, direction) {
  return `${direction} ${descriptor.unit}`;
}

// Next is offered only while a past window is shown: offset 0 is the present and
// no window beyond it exists.
function paintPagingControls(descriptor) {
  const prev = $('chart-prev');
  const next = $('chart-next');
  if (prev) prev.setAttribute('aria-label', pagingName(descriptor, 'Previous'));
  if (!next) return;
  next.setAttribute('aria-label', pagingName(descriptor, 'Next'));
  // A control that disables itself while focused drops the focus to <body> — the
  // next Tab then restarts at the top of the page — so paging back to the
  // present hands it on to the only move left. Disabled controls are not
  // focusable, which is why the destination is Previous rather than itself.
  const handoff = periodOffset === 0 && document.activeElement === next;
  next.disabled = periodOffset === 0;
  if (handoff && prev) prev.focus({ preventScroll: true });
}

function periodButtons() {
  return [...document.querySelectorAll('#period-switch [data-period]')];
}

// Roving tabindex, like the rate-mode control: one stop for the whole group.
function paintPeriodSwitch() {
  for (const button of periodButtons()) {
    const selected = button.dataset.period === periodId;
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

function renderSummary() {
  renderPlanBanner();
  renderWindowNote();
  // The window's recorded total (kWh) — the day documents' own, never the
  // pricing pass's: a range series' points are the day docs' totals, and the
  // Day period's is its document's own `kwh` (the hours map is the chart
  // series, which a partially-hourly day can under-report).
  const recorded =
    currentPeriod().source === 'day' && dayTotal != null
      ? dayTotal
      : series.length
        ? sumSeries(series)
        : 0;
  // One pass (#210): under a schedule the headline kWh and the $ both come
  // from the span list over the window the series was built for — the same
  // energy, so the kWh shown cannot claim more than the figure prices. The
  // day documents' totals feed the bars alone; `recorded` rides along as the
  // caption's Y and the hide rule's guard. The flat path keeps the
  // pre-schedule day-document headline, byte-identical.
  const summary =
    hasRateSchedule(settings) && series.length && seriesWindowMs
      ? windowCostSummary(pricingSpans(), seriesWindowMs, recorded, settings)
      : null;
  // Hide-not-misprice, applied to the headline (#210): a window whose day
  // documents recorded energy the span pass priced none of has no honest kWh
  // figure — coveredWh / 1000 would paint 0.00 beside the energy the bars
  // draw, reading as free exactly the way the hidden $ would — so the total
  // takes the null branch and renders the app's unknown (—). A window the
  // pass did price keeps its own energy, an empty one included: its 0.00 is
  // real, and so is its $0.00.
  const unpriced = !!(summary && recorded > 0 && !(summary.coveredWh > 0));
  const total = hasRateSchedule(settings)
    ? summary && !unpriced
      ? summary.coveredWh / 1000
      : null
    : historyState === 'no-intraday' && dayTotal != null
      ? dayTotal
      : series.length
        ? sumSeries(series)
        : null;
  if (total == null) {
    setText($('history-total'), '—');
    $('history-cost-cell').hidden = true;
    $('history-cost-coverage').hidden = true;
    setText($('history-cost-coverage'), '');
    $('history-summary').classList.add('solo');
    return;
  }
  setText($('history-total'), fmtK(total));
  let cost = null;
  let disclosure = null;
  if (summary) {
    cost = summary.cost == null ? null : fmtMoney(summary.cost, settings.currency);
    // Partial coverage (#194): the archive the $ prices holds less energy
    // than the day documents recorded — a lost record, or a counter-reset
    // session whose aggregate prices a fraction of it — so the figure says
    // what it prices on a small muted caption of its own beneath it, never
    // inside the figure's display type. A covered period paints no caption;
    // the kWh total is untouched either way.
    //
    // #212: a window whose every day carries a vouching bridge verdict
    // takes its caption from those verdicts instead — the exact same-basis
    // measure is the authority, so a clean verdict silences the attribution
    // compare's noise beside it, and any verdict the marker cannot vouch
    // for (legacy, null-marked, deferred-but-unsettled) keeps the #211
    // any-gap compare exactly as it is. One logic for every period (#210):
    // Day prices from the same session basis, so no carve-out remains.
    disclosure =
      periodVerdicts && periodVerdicts.settled
        ? verdictCaption(periodVerdicts, summary)
        : coverageDisclosure(summary);
  } else {
    // The flat path, byte-identical to the pre-schedule screen.
    cost = aggregateCostLabel(total, settings);
  }
  $('history-cost-cell').hidden = !cost;
  $('history-summary').classList.toggle('solo', !cost);
  setText($('history-cost'), cost || '');
  // The caption stands only under a shown figure: coverageDisclosure already
  // returns null whenever the $ hides, and the caption hides with it.
  $('history-cost-coverage').hidden = !(cost && disclosure);
  setText($('history-cost-coverage'), disclosure || '');
}

// The chart's hint names only what the state on screen can do — two dimensions,
// one source. The selection keys need bars to move through; and the paging
// register depends on the window shown: at the present, Next is disabled and
// PageDown is deliberately not consumed (it scrolls the page), so neither is
// advertised, while a paged window offers both directions.
const CHART_HINT = {
  bars: {
    present: 'Tap or ← → · PageUp pages back',
    paged: 'Tap or ← → · PageUp/PageDown pages',
  },
  paging: {
    present: 'Use ‹ or PageUp to page back',
    paged: 'Use ‹ › or PageUp/PageDown to page',
  },
};

function paintChartHint(barsDrawn) {
  const register = periodOffset === 0 ? 'present' : 'paged';
  setText($('chart-hint'), (barsDrawn ? CHART_HINT.bars : CHART_HINT.paging)[register]);
}

function showChartEmpty(title, line) {
  $('history-chart').setAttribute('hidden', '');
  // With no bars there is nothing to tap or arrow through: the hint keeps the
  // pager it does offer and drops the selection clause.
  paintChartHint(false);
  // The head is never hidden: the paging controls live in it, and an empty window
  // is still a window the owner has to be able to page out of. Its readout
  // describes a bar that is no longer drawn, so it returns to its initial
  // "nothing selected" state instead of naming the previous window.
  setText($('chart-day'), '—');
  setText($('chart-kwh'), '—');
  $('chart-cost').hidden = true;
  setText($('chart-cost'), '');
  $('chart-empty').hidden = false;
  // A hidden chart must not keep another period's points in the DOM; the next
  // paint rebuilds them from the selected range.
  $('chart-bars').replaceChildren();
  barEls = [];
  setText($('chart-empty-title'), title);
  setText($('chart-empty-line'), line);
}

function renderChart() {
  const svg = $('history-chart');
  const bars = $('chart-bars');
  bars.replaceChildren();
  bars.append(
    svgEl('line', {
      class: 'chart-base',
      x1: '0',
      y1: String(BASE),
      x2: String(VIEW_W),
      y2: String(BASE),
    }),
  );
  // Geometry follows the series: every rendered bucket fills the viewBox, so a
  // 7-bar week, a 28–31-bar month, a part-year's 10 months and 24 hours all use
  // the full width and the hit test has no dead slots. The slot width is the one
  // thing a variable-length period costs, and it is derived here.
  const slot = VIEW_W / Math.max(1, series.length);
  const barW = slot * BAR_RATIO;
  // The screen resolves each bar's inputs — the period's bucket kind, the
  // resolved cost label, the shared series maximum; the chart module owns the
  // geometry.
  const bucket = currentPeriod().bucket;
  const max = maxSeries(series);
  barEls = series.map((point, index) => {
    const group = buildBar(point, index, slot, barW, {
      bucket,
      cost: seriesCost(point),
      max,
    });
    bars.append(group);
    return group;
  });
  svg.removeAttribute('hidden');
  $('chart-empty').hidden = true;
  paintChartHint(true);
  const index = Math.max(
    0,
    series.findIndex((point) => point.id === selectedId),
  );
  selectedId = series[index] ? series[index].id : null;
  paintSelection(index);
}

function paintSelection(index) {
  if (!series.length) return;
  const descriptor = currentPeriod();
  const x = Math.max(0, Math.min(series.length - 1, index));
  const point = series[x];
  selectedId = point.id;
  const cost = seriesCost(point);
  // The Day period names the selected hour's span; every other period names its
  // bucket (a day or a month). "Today ·" prefixes only a day bucket that the
  // clock marks current — the bucket containing today, in the window that is
  // being drawn — so a paged window and a Year's month bucket never claim it.
  const label = descriptor.bucket === 'hour' ? hourRange(point.id) : point.label;
  const prefix = descriptor.bucket === 'day' && point.isCurrent ? 'Today · ' : '';
  setText($('chart-day'), `${prefix}${label}`);
  setText($('chart-kwh'), fmtK(point.kwh));
  $('chart-cost').hidden = !cost;
  setText($('chart-cost'), cost || '');
  barEls.forEach((bar, i) => {
    const selected = i === x;
    bar.classList.toggle('selected', selected);
    bar.setAttribute('tabindex', selected ? '0' : '-1');
    if (selected) bar.setAttribute('aria-current', 'true');
    else bar.removeAttribute('aria-current');
  });
}

function selectIndex(index, { focus = false } = {}) {
  paintSelection(index);
  const target = barEls[Math.max(0, Math.min(series.length - 1, index))];
  if (focus && target) target.focus({ preventScroll: true });
}

// Focus continuity across a read: the loading paint removes the bars, so the bar
// that held the focus is gone long before the new window is drawn. A caller that
// repaints under a keyboard user hands the focus back here — to the bar the new
// window selected, or to the pager when it drew none — so the paging keys stay
// deliverable and the focus never comes to rest on <body>, where PageUp/PageDown
// scroll the page instead of paging.
function chartHasFocus() {
  return $('history-chart').contains(document.activeElement);
}

function focusChart() {
  const index = series.findIndex((point) => point.id === selectedId);
  const target = barEls[index] || $('chart-prev');
  if (target) target.focus({ preventScroll: true });
}

// True from the moment a read parks the focus on the pager until the repaint that
// hands it back. It is screen state, not a per-read snapshot: a read superseded
// before it settles must not lose the reservation (the read that supersedes it
// starts with the bars already gone, so it would capture nothing), and only the
// repaint that lands may consume it. Both read paths paint and release under their
// own sequence guard, so a superseded read — a paged read or a reload — leaves the
// reservation to the read that superseded it, and that newest read always owns the
// settle focus however many reads it superseded.
let chartFocusReserved = false;

// Reserve the chart's focus before a paint that removes the focused bar: the bar
// is about to leave the document, so the focus moves to Previous first — a control
// the always-visible head renders, that is never disabled, and that lives inside
// #chart-card where the paging keys are bound. A press arriving *during* the read
// (a double tap, or every key-repeat event of a held key) therefore still pages
// instead of scrolling the viewport from <body>.
function parkChartFocus() {
  const prev = $('chart-prev');
  if (!prev || !chartHasFocus()) return;
  chartFocusReserved = true;
  prev.focus({ preventScroll: true });
}

// Hand the reserved focus to the window that just landed. Skipped when the reader
// has since tabbed or clicked elsewhere: the reservation only starts from the
// pager this interaction parked the focus on, so nobody is yanked back into the
// chart from a control they moved to themselves.
function releaseChartFocus() {
  if (!chartFocusReserved) return;
  chartFocusReserved = false;
  const at = document.activeElement;
  if (at === $('chart-prev') || chartHasFocus()) focusChart();
}

const OFFLINE_TITLE = "You're offline — history isn't available.";
const NO_HISTORY_COPY = {
  title: 'No history yet',
  line: 'Daily totals appear once the charger logs a day.',
};

function setHistoryNote(text) {
  const note = $('history-state');
  if (!note) return;
  note.hidden = !text;
  setText(note, text);
}

// A section note always describes the last read, never the points on screen.
function historyNote(view) {
  if (!view.stale) return '';
  const noun = currentPeriod().noun;
  if (historyState === 'cached') return `Showing cached ${noun} — reconnect to refresh.`;
  if (historyState === 'offline') return `You're offline — showing the last ${noun} loaded.`;
  return `Couldn't refresh ${noun} — showing the last values loaded.`;
}

function renderHistory() {
  const descriptor = currentPeriod();
  paintPeriodCopy();
  const copy = descriptor.copy(currentSpan());
  const hasData = historyServer && sumSeries(series) > 0;
  const view = sectionView(historyState, hasData);
  if (historyState === 'loading' && !series.length) {
    renderSummary();
    showChartEmpty(`Loading ${descriptor.noun}…`, copy.loadingLine);
    setHistoryNote('');
    return;
  }
  if (historyState === 'no-intraday') {
    // The chart has nothing it may draw, but the day's total is a real record:
    // the summary keeps it and the panel names why the hours are missing.
    renderSummary();
    showChartEmpty(copy.noIntradayTitle, copy.noIntradayLine);
    setHistoryNote('');
    return;
  }
  if (!view.showData) {
    // Nothing current to draw: never paint zeroes for a read that did not reach
    // the server, or a cache miss would read as "no energy recorded". A day with
    // a total but no hourly buckets is a message for the same reason — its hours
    // were never recorded and must not be drawn as 24 empty bars.
    setText($('history-total'), '—');
    $('history-cost-cell').hidden = true;
    $('history-window-note').hidden = true;
    $('history-cost-coverage').hidden = true;
    setText($('history-cost-coverage'), '');
    $('history-summary').classList.add('solo');
    // The rescue line names the window the next Refresh will load, which is the
    // one this render is reporting: a series the server answered with nothing
    // draws no bars, so a failed re-entry over it has no drawn window to defend
    // and must not send the owner back to the superseded dates (see currentSpan
    // for the label, which still names what that read covered).
    const offlineLine = chartWindow
      ? descriptor.copy(chartWindow.span).offlineLine
      : copy.offlineLine;
    const message =
      historyState === 'offline'
        ? { title: OFFLINE_TITLE, line: offlineLine }
        : historyState === 'error'
          ? {
              title: `Couldn't load ${descriptor.noun}.`,
              line: 'Check your connection and refresh.',
            }
          : NO_HISTORY_COPY;
    showChartEmpty(message.title, message.line);
    setHistoryNote('');
    return;
  }
  renderSummary();
  if (view.claimEmpty || (sumSeries(series) === 0 && !view.stale)) {
    // Zero days inside a rendered period are real zero-height bars; only a read
    // that found nothing in the whole range uses the empty panel.
    showChartEmpty(copy.emptyTitle, copy.emptyLine);
  } else {
    renderChart();
  }
  setHistoryNote(historyNote(view));
}

function indexAt(clientX) {
  return chartIndexAt(clientX, $('history-chart').getBoundingClientRect(), series.length);
}

// ---------- sessions ----------

function toDate(value) {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (typeof value === 'number') return new Date(value);
  return null;
}

function renderSession(item) {
  const li = el('li', 'session');
  const started = toDate(item.started_at);
  const when = el('div', 'session-when');
  if (started) {
    const date = el('span', 'session-date', dayLabel(dayId(started)));
    const time = el('span', 'session-time');
    time.textContent = started.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
    when.append(date, time);
  } else {
    when.append(el('span', 'session-date', 'Date unknown'));
  }

  const what = el('div', 'session-what');
  const wh = toNumber(item.wh);
  const kwh = Number.isFinite(wh) ? wh / 1000 : null;
  what.append(el('span', 'session-kwh', kwh == null ? '— kWh' : `${fmtK(kwh)} kWh`));
  const meta = el('span', 'session-meta');
  const duration = formatDuration(item.elapsed);
  meta.textContent = duration === '—' ? '—' : `${duration} h`;
  const cost = sessionCostLabel(item, settings);
  if (cost) {
    const dot = el('span', 'session-dot', '·');
    dot.setAttribute('aria-hidden', 'true');
    meta.append(dot, el('span', 'session-cost', cost));
  }
  what.append(meta);
  li.append(when, what);
  return li;
}

// ---------- sessions view (pure) ----------

// The sessions paging model lives in js/history.js beside its read-state
// helpers; re-exported here so the screen's harness keeps its import path.
export { mergeSessions, nextSessionsView, sessionsControls } from '../history.js';

// A month id's half-open [start, end) range: Date values convert to the
// Timestamps `started_at` stores, and the filter rides the orderBy's automatic
// single-field index. Null (the recent view) reads the unfiltered newest page.
export function monthRange(month) {
  if (!month) return null;
  const [year, index] = month.split('-').map(Number);
  return { start: new Date(year, index - 1, 1), end: new Date(year, index, 1) };
}

// 'YYYY-MM' from the month picker, or null when it is empty or holds something
// the native control would not have produced (a browser without it falls back
// to a text input). An unparsable value reads the recent view rather than
// firing a query with garbage bounds.
function pickedMonth() {
  const input = $('sessions-month');
  const value = input && typeof input.value === 'string' ? input.value : '';
  return /^\d{4}-\d{2}$/.test(value) ? value : null;
}

function sessionsMessage() {
  if (sessionsView.state === 'loading') {
    // The picker names the read being started; the view still holds the
    // previous month until the first page lands, so the copy must not read it.
    return pickedMonth() ? 'Loading sessions…' : 'Loading recent sessions…';
  }
  if (sessionsView.state === 'offline') return "You're offline — sessions aren't available.";
  if (sessionsView.state === 'error') {
    // View-agnostic: a failed month switch keeps the previous view's list, so
    // the message must not promise which read failed.
    return "Couldn't load sessions. Check your connection and refresh.";
  }
  return sessionsView.month
    ? 'No sessions recorded in this month.'
    : 'No completed sessions yet. They appear after a car unplugs.';
}

function sessionsNote() {
  if (sessionsView.state === 'cached') return 'Showing cached sessions — reconnect to refresh.';
  if (sessionsView.state === 'offline') return "You're offline — showing the last sessions loaded.";
  return "Couldn't refresh sessions — showing the last list loaded.";
}

function renderSessions() {
  const list = $('sessions-list');
  const state = $('sessions-state');
  list.replaceChildren();
  setText(
    $('sessions-count'),
    sessionsView.sessions.length
      ? `${sessionsView.sessions.length} session${sessionsView.sessions.length === 1 ? '' : 's'}`
      : '',
  );
  const controls = sessionsControls(sessionsView);
  const more = $('sessions-more');
  if (more) {
    more.hidden = !controls.more;
    more.disabled = sessionsBusy;
  }
  // Rows exist, whatever their provenance: an offline or failed read keeps a
  // cached view's list on screen (with its stale note) instead of hiding it
  // beside a still-painted count.
  const hasData = sessionsView.sessions.length > 0;
  const view = sectionView(sessionsView.state, hasData);
  if (sessionsView.state === 'empty' || !view.showData) {
    list.hidden = true;
    state.hidden = false;
    state.className = sessionsView.state === 'error' ? 'section-state err' : 'section-state';
    setText(state, sessionsMessage());
    return;
  }
  const note = view.stale ? sessionsNote() : '';
  state.hidden = !note;
  state.className = 'section-state';
  setText(state, note);
  list.hidden = false;
  for (const item of sessionsView.sessions) list.append(renderSession(item));
}

// ---------- loading ----------

function setRefreshBusy(busy) {
  const btn = $('history-refresh');
  btn.disabled = busy;
  setText(btn, busy ? 'Refreshing…' : 'Refresh');
  $('panel-history').setAttribute('aria-busy', String(busy));
}

function setFeedback(text, kind) {
  const fb = $('history-feedback');
  fb.className = `feedback${kind ? ` ${kind}` : ''}`;
  setText(fb, text);
}

// Page-level feedback only reports work in progress or a fully successful
// refresh. Offline/cached/error outcomes are section-specific and are reported
// beside the section they belong to, so a mixed refresh never speaks for both.
function renderLoadFeedback() {
  const answered = (state) => state === 'fresh' || state === 'empty';
  if (!answered(historyState) || !answered(sessionsView.state)) {
    setFeedback('', '');
    return;
  }
  const stamp = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  setFeedback(`Updated ${stamp}.`, 'ok');
}

function windowStale() {
  // The day the window was anchored to, never the day its range ends: a paged
  // window's endId is a past date, so comparing that would make every read
  // permanently stale and re-enter it in a loop.
  return !chartWindow || chartWindow.anchorDay !== dayId(new Date());
}

// Reload once the local date moves past the day the window was built for.
function recheckWindow() {
  if (!windowStale()) return;
  loaded = false;
  // A full reload re-reads the period, so a settle queued against the older
  // window — and the verification re-read behind it — is subsumed rather than
  // re-fired on top of it.
  settlePending = false;
  settleVerify = false;
  if (!loading) loadAll();
}

// Every one-shot read ends here: a read that was in flight across local midnight
// has painted yesterday's window under today's labels, so re-enter it once with
// today's ids instead of leaving "Today · <yesterday>" on screen. Re-entry
// captures a fresh window, so this check can only fire again at the next local
// midnight, never in a loop.
function reloadIfWindowStale() {
  if (!active || !windowStale()) return;
  loaded = false;
  settlePending = false;
  settleVerify = false;
  loadAll();
}

// The window the selected period is paged to. `now` is captured once per read,
// and the anchor, the bounds, the span wording and the midnight check all come
// from it: the anchor decides which window is drawn, `now` decides which bucket
// (if any) is current. Every bit of window arithmetic happens in js/history.js.
function buildWindow(descriptor, now) {
  const anchor = periodAnchor(descriptor, periodOffset, now);
  return {
    anchor,
    bounds: periodBounds(descriptor, anchor, now),
    span: periodSpan(descriptor, anchor, now),
    anchorDay: dayId(now),
  };
}

// The store reads behind one period: the Day period's single document and the
// day-id range every other period reads. They are indirected through this object
// for the reason fetchPeriodSessions takes its range read as a parameter — Node
// cannot bind Firestore, so in the executed harness every store read rejects, and
// a rejection cannot express *when* a read settles. Substituting the read is what
// lets the harness drive a read that succeeds and the two orders in which a read
// and the one that superseded it can settle (#154). The screen only ever reads
// this object; production never assigns to it.
export const periodReads = {
  day: (day) => fetchHistoryDay(day),
  range: (startId, endId) => fetchHistory(startId, endId),
  // The seam-B marker, read beside the period's own documents (#212): null
  // (feature off) on a missing marker or a failed read.
  marker: () => fetchReconMarker(),
};

// The selected period's read, chosen by the descriptor: the Day period reads its
// one document, every other period its contiguous day-id range. Both resolve to
// the input applyHistory classifies, so no caller special-cases a period id.
function fetchPeriod(descriptor, bounds) {
  return descriptor.source === 'day'
    ? periodReads.day(bounds.endId)
    : periodReads.range(bounds.startId, bounds.endId);
}

// The period's session archive read, the $ counterpart of fetchPeriod (#123,
// #210): every session overlapping the range — the Day period's included,
// because its summary prices the same session basis every period does; its
// hour bars alone price the day document's own buckets (display). A rejected
// range read settles empty in the callers' allSettled: the history read still
// paints its kWh while the cost hides rather than pricing energy it has no
// session for. The paged read's envelope ({docs, fromCache}) is unwrapped to
// its docs at exactly this point — applyHistory expects the sessions
// themselves, and `fromCache` has no consumer on this path. The read itself
// arrives as a parameter (defaulting to the store's) so the executed harness
// can drive a successful read through the real function — Node cannot bind
// Firestore, and this unwrap is exactly the wiring a source pin could not
// guard. `descriptor` is deliberately unread: no period branches here anymore.
export function fetchPeriodSessions(descriptor, bounds, readRange = fetchSessionsInRange) {
  const range = sessionsRange(bounds);
  return range ? readRange(range).then((read) => read.docs) : Promise.resolve([]);
}

// Apply one settled history read. A failed read and an offline cache miss set
// the state only: points already on screen must never be relabelled as the newly
// selected period. `sessions` is the same read's session payload and is applied
// with the points it prices — the previous period's sessions must never price
// this one's bars. `anchor` is the window the read was built for and `now` the
// clock it was captured at (defaulting to the anchor, the pre-paging shape): the
// series marks a current bucket only when its window contains now, so a paged
// window marks none. `recon` is the same read's `history/_reconciliation`
// marker (#212; null when off) and is applied the same way, as the verdict
// classification of the window's own days — a paged window's verdicts come from
// its days, never the clock's. Exported so the executed harness can drive the
// fetch→apply step readHistory and loadAll perform (with the store seam
// stubbed): the payload's shape crossing this boundary is what the harness must
// observe.
export function applyHistory(
  descriptor,
  result,
  failure,
  anchor,
  sessions = [],
  now = anchor,
  recon = null,
) {
  const day = descriptor.source === 'day';
  if (result) historyState = day ? hourReadState(result) : historyReadState(result);
  else historyState = day ? hourReadFailure(failure) : 'error';
  if (historyState === 'offline' || historyState === 'error') return;
  // A Day read's payload is the day document itself; a range read's is its list
  // of daily documents.
  periodSessions = Array.isArray(sessions) ? sessions : [];
  series = periodSeries(descriptor, day ? result : result.docs, anchor, now);
  // The window these points were built for — the only place a series acquires the
  // window it is labelled by (see seriesSpan), and the one the span pass prices
  // (see seriesWindowMs).
  seriesSpan = periodSpan(descriptor, anchor, now);
  // The same window's verdict classification (#212): per day, whatever the
  // period's buckets are — the Day period's single day, every day of a range.
  const bounds = periodBounds(descriptor, anchor, now);
  seriesWindowMs = rangeWindow(bounds.startId, bounds.endId);
  periodVerdicts = dayVerdicts(
    day ? [bounds.endId] : dayIdsInRange(bounds.startId, bounds.endId),
    day ? [result] : result.docs,
    recon && recon.reconFrom,
    dayId(now),
  );
  const kwh = Number(result.kwh);
  dayTotal = day && Number.isFinite(kwh) && kwh > 0 ? kwh : null;
  historyServer = historyState === 'fresh' || historyState === 'empty';
  if (!series.some((point) => point.id === selectedId)) {
    // Prefer the slot the series marks as current (today, this month, the hour
    // in progress), else the newest slot — which is what a paged window, whose
    // buckets are all in the past, lands on.
    const current = series.findIndex((point) => point.isCurrent);
    selectedId = series.length ? series[current >= 0 ? current : series.length - 1].id : null;
  }
}

// A period switch re-reads history only: the sessions list keeps its own read.
// The chart is cleared before the read, so a cache miss shows that period's
// offline copy instead of the previous range's bars.
async function readHistory() {
  const gen = generation;
  const seq = ++historySeq;
  const descriptor = currentPeriod();
  const now = new Date();
  // One window build owns the anchor, the range, the span wording and the
  // midnight guard's day; the value is kept so the guard can ask what date the
  // window on screen was anchored to.
  const readWindow = buildWindow(descriptor, now);
  chartWindow = readWindow;
  const { bounds } = readWindow;
  // A paging keystroke arrives with the focus on a bar, and the loading paint
  // below removes it; the pager holds the focus until the settled window hands it
  // back (see releaseChartFocus).
  parkChartFocus();
  series = [];
  selectedId = null;
  dayTotal = null;
  periodSessions = [];
  periodVerdicts = null;
  historyServer = false;
  // The previous window's series leaves with its span and its pricing window:
  // the new read's own window names the loading copy, and a failed read falls
  // back to its panel.
  seriesSpan = null;
  seriesWindowMs = null;
  historyState = 'loading';
  renderHistory();
  // The session read is a sibling, not a gate: a rejected session payload
  // prices nothing (the $ hides) while the history read still paints. The
  // marker read is the same kind of sibling (#212): a rejection or a missing
  // marker turns the verdict feature off for this window without touching
  // the rest.
  const [hist, sess, marker] = await Promise.allSettled([
    fetchPeriod(descriptor, bounds),
    fetchPeriodSessions(descriptor, bounds),
    periodReads.marker(),
  ]);
  if (gen !== generation || seq !== historySeq) return;
  applyHistory(
    descriptor,
    hist.status === 'fulfilled' ? hist.value : null,
    hist.status === 'rejected' ? hist.reason : null,
    readWindow.anchor,
    sess.status === 'fulfilled' ? sess.value : [],
    now,
    marker.status === 'fulfilled' ? marker.value : null,
  );
  renderHistory();
  releaseChartFocus();
  reloadIfWindowStale();
}

async function switchPeriod(id) {
  const next = periodById(id);
  if (!next || next.id === periodId) return;
  periodId = next.id;
  // A Week offset of 4 has no meaning as a Month offset, so a switch returns to
  // the default view.
  periodOffset = 0;
  paintPeriodSwitch();
  await readHistory();
}

// Page the window by one calendar unit: +1 goes back in time, -1 toward the
// present. Offset 0 is the current unit, so Next cannot advance past it (and the
// control is disabled there); no window beyond the present is reachable.
async function pageBy(step) {
  const next = Math.max(0, periodOffset + step);
  if (next === periodOffset) return;
  periodOffset = next;
  await readHistory();
}

// Page one of the view the picker names (a month, or the recent list when it
// is cleared): the previous view keeps the screen until this read lands, and a
// failed read leaves it there for a retry. Refresh, a month pick and the
// Recent reset all funnel through here.
async function readSessionsFirstPage() {
  const seq = ++sessionsSeq;
  const gen = generation;
  const month = pickedMonth();
  sessionsBusy = true;
  // The list on screen still belongs to the previous view; the loading state
  // only says a new one is being fetched, and a failure brings the old list
  // back with the error note beside it.
  sessionsView = { ...sessionsView, state: 'loading' };
  renderSessions();
  let read = null;
  try {
    read = await fetchSessions({ range: monthRange(month) });
  } catch {
    read = null;
  }
  if (gen !== generation || seq !== sessionsSeq) return;
  sessionsBusy = false;
  sessionsView = nextSessionsView(sessionsView, read, { kind: 'first', month });
  renderSessions();
}

// The next page of the rendered view, continued after its cursor: appended
// without duplicates, and a failed page keeps the list and the control for a
// retry.
async function loadMoreSessions() {
  if (sessionsBusy || loading) return;
  const seq = ++sessionsSeq;
  const gen = generation;
  sessionsBusy = true;
  renderSessions();
  let read = null;
  try {
    read = await fetchSessions({
      after: sessionsView.cursor,
      range: monthRange(sessionsView.month),
    });
  } catch {
    read = null;
  }
  if (gen !== generation || seq !== sessionsSeq) return;
  sessionsBusy = false;
  sessionsView = nextSessionsView(sessionsView, read, { kind: 'more' });
  renderSessions();
}

async function loadAll() {
  if (loading) return;
  loading = true;
  loaded = true;
  const gen = generation;
  // The same focus continuity a paged read keeps: this reload can land under a
  // keyboard user (the midnight re-entry a paged read triggers), and its repaint
  // must not leave the focus on <body>.
  parkChartFocus();
  const first = historyState === 'idle' && sessionsView.state === 'idle';
  if (first) {
    historyState = 'loading';
    sessionsView = { ...sessionsView, state: 'loading' };
    renderHistory();
    renderSessions();
  }
  setRefreshBusy(true);
  setFeedback('Refreshing…');
  const seq = ++historySeq;
  // The sessions read takes its own sequence: a month pick or a "show more"
  // during the refresh supersedes this page, and this page supersedes theirs.
  const sessSeq = ++sessionsSeq;
  sessionsBusy = true;
  const descriptor = currentPeriod();
  const now = new Date();
  const readWindow = buildWindow(descriptor, now);
  chartWindow = readWindow;
  const { bounds } = readWindow;
  // Refresh re-reads the current view's first page — the month the picker
  // names, or the recent list when none is picked — beside the period's own
  // day documents and overlapping sessions.
  const month = pickedMonth();
  const [hist, sess, periodSess, marker] = await Promise.allSettled([
    fetchPeriod(descriptor, bounds),
    fetchSessions({ range: monthRange(month) }),
    fetchPeriodSessions(descriptor, bounds),
    periodReads.marker(),
  ]);
  // Signed out (or reset) while the reads were in flight.
  if (gen !== generation) return;

  loading = false;
  setRefreshBusy(false);
  // A period switch during the read owns the chart; this payload belongs to the
  // superseded range and must not be painted. The settle repaint and the focus
  // handoff belong to the newest read for the same reason: repainting here would
  // rebuild the bars the newest read has just focused (a superseded reload landing
  // second would drop the focus to <body>), and releasing here would consume the
  // reservation before the window that earned it is on screen. `loading` and the
  // refresh control are finished above either way — they belong to this reload,
  // not to the chart.
  if (seq === historySeq) {
    applyHistory(
      descriptor,
      hist.status === 'fulfilled' ? hist.value : null,
      hist.status === 'rejected' ? hist.reason : null,
      readWindow.anchor,
      periodSess.status === 'fulfilled' ? periodSess.value : [],
      now,
      marker.status === 'fulfilled' ? marker.value : null,
    );
    renderHistory();
    releaseChartFocus();
  }
  // Same contract for the sessions view: only the newest sessions read paints,
  // and a failed read or an offline cache miss keeps the previous payload with
  // `nextSessionsView` deciding whether it is still safe to show as stale.
  if (sessSeq === sessionsSeq) {
    sessionsBusy = false;
    sessionsView = nextSessionsView(sessionsView, sess.status === 'fulfilled' ? sess.value : null, {
      kind: 'first',
      month,
    });
  }
  renderSessions();
  renderLoadFeedback();

  reloadIfWindowStale();
}

// ---------- screen lifecycle ----------

export function initHistory() {
  $('history-refresh').addEventListener('click', loadAll);
  // The sessions browse controls: a month pick swaps the read to that month's
  // first page, Recent clears it back, and "show more" pages the rendered view
  // deeper. All three keep the read path shared — only the request differs.
  const monthInput = $('sessions-month');
  if (monthInput) {
    monthInput.addEventListener('change', () => {
      // The Recent reset is offered exactly while a month is in the picker —
      // including one whose read failed, so the way back is always visible.
      const recent = $('sessions-recent');
      if (recent) recent.hidden = !pickedMonth();
      return readSessionsFirstPage();
    });
  }
  const recentButton = $('sessions-recent');
  if (recentButton) {
    recentButton.addEventListener('click', () => {
      if (monthInput) monthInput.value = '';
      recentButton.hidden = true;
      return readSessionsFirstPage();
    });
  }
  const moreButton = $('sessions-more');
  if (moreButton) moreButton.addEventListener('click', loadMoreSessions);
  // The chart's paging controls: one window back, one window toward the present.
  const prevButton = $('chart-prev');
  if (prevButton) prevButton.addEventListener('click', () => pageBy(1));
  const nextButton = $('chart-next');
  if (nextButton) nextButton.addEventListener('click', () => pageBy(-1));
  const periodSwitch = $('period-switch');
  if (periodSwitch) {
    periodSwitch.addEventListener('click', (e) => {
      const button = e.target.closest('[data-period]');
      if (!button || !periodSwitch.contains(button)) return;
      switchPeriod(button.dataset.period);
    });
    // Arrow keys move through the radiogroup and wrap at the ends, matching the
    // rate-mode control. One tab stop — the checked option — owns the group.
    periodSwitch.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const index = PERIODS.findIndex((period) => period.id === periodId);
      const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const next = PERIODS[(index + step + PERIODS.length) % PERIODS.length];
      const button = periodSwitch.querySelector(`[data-period="${next.id}"]`);
      if (button) button.focus({ preventScroll: true });
      switchPeriod(next.id);
    });
    paintPeriodSwitch();
  }
  // The paging keys are bound to the card that holds the chart and its pager, not
  // to the SVG: a paged read clears the bars (and the loading/empty/offline states
  // hide the SVG outright), so the chart cannot keep the focus the key needs. The
  // pager in the always-visible head can, and the hint beside it advertises the
  // keys in exactly those states.
  const card = $('chart-card');
  if (card) {
    card.addEventListener('keydown', (e) => {
      // Modified keys and every other key belong to the browser (back/forward,
      // tab switching, scrolling), so they are never consumed here.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
      // The present is the newest window, so PageDown there moves nothing: the key
      // stays the browser's and scrolls, instead of being swallowed by an action
      // that does not happen. PageUp always has a window to go back to.
      if (e.key === 'PageDown' && periodOffset === 0) return;
      e.preventDefault();
      pageBy(e.key === 'PageUp' ? 1 : -1);
    });
  }
  const svg = $('history-chart');
  svg.addEventListener('keydown', (e) => {
    // Modified keys and every other key belong to the browser (back/forward,
    // tab switching, scrolling), so they are never consumed here.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    // ←/→ move the bar selection inside the window already drawn; paging belongs
    // to the card (above), which survives the repaint the paged read performs.
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!series.length) return;
    e.preventDefault();
    const current = series.findIndex((point) => point.id === selectedId);
    const base = current < 0 ? series.length - 1 : current;
    selectIndex(e.key === 'ArrowLeft' ? base - 1 : base + 1, { focus: true });
  });
  svg.addEventListener('pointerdown', (e) => {
    const index = indexAt(e.clientX);
    if (index == null) return;
    selectIndex(index, { focus: true });
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      scrubbing = true;
      scrubPointer = e.pointerId;
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers have no capture target; scrubbing still works.
      }
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      if (!scrubbing || e.pointerId !== scrubPointer) return;
    }
    const index = indexAt(e.clientX);
    if (index != null && series[index].id !== selectedId) selectIndex(index);
  });
  const endScrub = (e) => {
    if (!scrubbing || e.pointerId !== scrubPointer) return;
    scrubbing = false;
    scrubPointer = null;
    try {
      svg.releasePointerCapture(e.pointerId);
    } catch {
      // Nothing captured (synthetic pointer or the browser already released it).
    }
  };
  svg.addEventListener('pointerup', endScrub);
  svg.addEventListener('pointercancel', endScrub);
  // Returning to the tab or restoring the app from the back/forward cache must
  // re-check the local date: no route change happens, so the router hook alone
  // would leave yesterday's window on screen.
  const resume = () => {
    if (!active) return;
    if ($('panel-history').hidden) {
      // Off-screen: mark the window stale so the next activation reloads it.
      if (windowStale()) loaded = false;
      return;
    }
    activateHistory();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
  addEventListener('pageshow', resume);
}

export function enterHistory() {
  active = true;
}

export function activateHistory() {
  if (!active) return;
  // A tab left open across local midnight would keep yesterday's window and
  // label it "Today"; reload once when the local date has changed.
  recheckWindow();
  if (!loaded && !loading) loadAll();
  else if (settlePending && !loading) {
    // The charge ended while another tab was showing: take the recorded
    // pricing over exactly once, now that this screen is visible again.
    settlePending = false;
    settleVerify = true;
    readHistory();
  } else if (settleVerify && !loading) {
    // The settle read's verification, same contract as the push route in
    // showHistoryStatus: after a stop the bridge goes quiet, so the return
    // visit — not the next push — spends the one re-read.
    settleVerify = false;
    readHistory();
  } else {
    // Status pushes that arrived while the tab was hidden left any live
    // figure unpainted; the return visit renders them (#126).
    renderKeepingFocus();
  }
}

// settings/current — costs update in place; no reload needed. The whole document
// is kept: sessions are priced over their own interval, and a schedule also
// decides that the aggregate cost is hidden.
export function showHistorySettings(data) {
  settings = costSettings(data);
  renderPlanBanner();
  renderKeepingFocus();
  if (sessionsView.sessions.length) renderSessions();
}

// status/current — the live session's pricing input (#126). The snapshot is
// kept whole and priced per render, so the contribution stays anchored to the
// write's own `updated_at` exactly like the Status tab's figure and cannot
// slide on a repaint. The charging→stopped edge is also the bridge's
// session-record edge, so it queues one settle re-read through the same
// guarded path a period switch takes; the guard inside pricingSpans covers
// the listener that lands first. Bounded to the visible tab: a push while
// hidden only updates the snapshot, and activateHistory renders or re-reads
// on return.
export function showHistoryStatus(data) {
  const previous = liveStatus;
  // A null push is the listener's error state, not a charger observation:
  // keep the last write rather than dropping the screen's input — the figure
  // is anchored to that write and cannot slide while it is held.
  if (data) liveStatus = data;
  if (!active) return;
  // The settle edge: a write that ended charging after one that priced live.
  // The bridge's offline markers keep the charging label and are not an edge —
  // the charge has not ended, the contribution simply hides until a live
  // write returns.
  if (liveSessionSpan(previous) && data && data.state_label !== 'charging') {
    settlePending = true;
  }
  if ($('panel-history').hidden) return;
  if (settlePending && !loading) {
    settlePending = false;
    settleVerify = true;
    readHistory();
    return;
  }
  // The settle read's verification: exactly one more re-read on the next
  // status push, for the session write the bridge retried after the settle
  // read fetched. Hidden pushes hold it for a visible one — or the return
  // visit spends it, in activateHistory — and once spent the idle stream
  // re-reads nothing further.
  if (settleVerify && !loading) {
    settleVerify = false;
    readHistory();
    return;
  }
  // A repaint only when the push could move a live figure — a live span on
  // either side of it — so idle polls of a hidden charge never rebuild the
  // chart.
  if (series.length && (liveSessionSpan(liveStatus) || liveSessionSpan(previous))) {
    renderKeepingFocus();
  }
}

// A repaint that keeps chart focus: the rebuild replaces the bars, so a
// keyboard user scrubbing them keeps the selected one focused.
function renderKeepingFocus() {
  if (!series.length) return;
  const hadFocus = chartHasFocus();
  renderHistory();
  if (hadFocus) focusChart();
}

export function resetHistory() {
  generation += 1;
  historySeq += 1;
  sessionsSeq += 1;
  active = false;
  loaded = false;
  loading = false;
  settings = null;
  periodId = DEFAULT_PERIOD;
  const planBanner = $('history-plan-banner');
  if (planBanner) planBanner.hidden = true;
  const windowNote = $('history-window-note');
  if (windowNote) windowNote.hidden = true;
  series = [];
  selectedId = null;
  dayTotal = null;
  periodOffset = 0;
  chartWindow = null;
  seriesSpan = null;
  seriesWindowMs = null;
  periodSessions = [];
  periodVerdicts = null;
  liveStatus = null;
  settlePending = false;
  settleVerify = false;
  chartFocusReserved = false;
  sessionsView = emptySessionsView();
  sessionsBusy = false;
  historyState = 'idle';
  historyServer = false;
  barEls = [];
  scrubbing = false;
  scrubPointer = null;
  if ($('sessions-list')) $('sessions-list').replaceChildren();
  if ($('chart-bars')) $('chart-bars').replaceChildren();
  if ($('history-total')) {
    paintPeriodSwitch();
    paintPeriodCopy();
    setText($('history-total'), '—');
    $('history-cost-cell').hidden = true;
    $('history-summary').classList.add('solo');
    setText($('history-cost'), '');
    $('history-cost-coverage').hidden = true;
    setText($('history-cost-coverage'), '');
    setText($('sessions-count'), '');
    setFeedback('', '');
    setRefreshBusy(false);
    showChartEmpty(NO_HISTORY_COPY.title, NO_HISTORY_COPY.line);
    const note = $('history-state');
    if (note) {
      note.hidden = true;
      setText(note, '');
    }
    const state = $('sessions-state');
    state.hidden = true;
    state.className = 'section-state';
    // The browse controls reset with the view: no month picked, no Recent
    // offered, no page to continue.
    const monthInput = $('sessions-month');
    if (monthInput) monthInput.value = '';
    const recentButton = $('sessions-recent');
    if (recentButton) recentButton.hidden = true;
    const moreButton = $('sessions-more');
    if (moreButton) {
      moreButton.hidden = true;
      moreButton.disabled = false;
    }
  }
}
