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
import { fetchHistory, fetchHistoryDay, fetchSessions, fetchSessionsInRange } from '../store.js';
import {
  DEFAULT_PERIOD,
  PERIODS,
  chartIndexAt,
  dayId,
  dayLabel,
  emptySessionsView,
  historyReadState,
  hourRange,
  hourReadFailure,
  hourReadState,
  maxSeries,
  nextSessionsView,
  periodBounds,
  periodById,
  periodSeries,
  sectionView,
  sessionsControls,
  sessionsRange,
  sumSeries,
} from '../history.js';
import {
  aggregateCostLabel,
  costSettings,
  hasRateSchedule,
  liveSessionContribution,
  liveSessionSpan,
  pointCostSummary,
  sessionCostLabel,
  seriesCostSummary,
} from '../cost.js';
import { planHasUnpriced } from '../settings.js';
import { fmtK, formatDuration, fmtMoney, toNumber } from '../format.js';
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
let todayId = null;
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

// The bucket/series cost summaries live in js/cost.js beside the pricing
// helpers they call; re-exported here so the screen's tests keep this path.
export { pointCostSummary, seriesCostSummary } from '../cost.js';

// The sessions a period's $ prices: the recorded payload plus, while a charge
// is in progress, the live session's contribution (#126) — merged only for a
// range whose series includes a current bucket (today, or this month); the Day
// period's hour bars price from the day document's buckets and never see it.
// The settle guard runs here, against the recorded payload as merged, so
// whichever of the two inputs — the session document or the status snapshot —
// lands first, a charge a recorded session already covers prices exactly once.
function pricingSessions() {
  if (!series.some((point) => point.isCurrent)) return periodSessions;
  const live = liveSessionContribution(liveStatus, periodSessions, settings);
  return live ? [...periodSessions, live] : periodSessions;
}

// One bucket's cost label, or null to hide: flat keeps aggregateCostLabel's
// byte-identical path; under a schedule a bucket whose energy is entirely
// without covering sessions hides rather than showing a figure that covers
// none of it.
function seriesCost(point) {
  if (!hasRateSchedule(settings)) return aggregateCostLabel(point.kwh, settings);
  const summary = pointCostSummary(point, currentPeriod().bucket, settings, pricingSessions());
  if (summary.cost == null || (summary.unpricedEnergy && !summary.pricedEnergy)) return null;
  return fmtMoney(summary.cost, settings.currency);
}

// ---------- summary + chart ----------

// A saved plan with any unpriced instant advertises it on History: with a
// schedule, some sessions can be priced at 0.00 without any other signal. Kept as
// a pure predicate so the wiring is testable without a DOM.
export function showPlanBanner(data) {
  const normalized = costSettings(data);
  return hasRateSchedule(normalized) && planHasUnpriced(normalized.rates);
}

function renderPlanBanner() {
  const banner = $('history-plan-banner');
  if (!banner) return;
  banner.hidden = !showPlanBanner(settings);
}

function currentPeriod() {
  return periodById(periodId);
}

function periodHeading(descriptor) {
  return descriptor.noun.charAt(0).toUpperCase() + descriptor.noun.slice(1);
}

// The chart heading, summary label and SVG label name the selected range; the
// segment control is static markup, so the period copy is applied here instead
// of being duplicated across the markup.
function paintPeriodCopy() {
  const descriptor = currentPeriod();
  setText($('chart-heading'), periodHeading(descriptor));
  setText($('history-total-label'), descriptor.summaryLabel);
  $('history-summary').setAttribute('aria-label', `${descriptor.summaryLabel} summary`);
  $('history-chart').setAttribute('aria-label', descriptor.chartLabel);
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
  // The summary total is the series sum, except for a day whose hours were never
  // recorded: its daily total is real, so the copy and the number agree instead
  // of showing "—" beside "today has a total".
  const total =
    historyState === 'no-intraday' && dayTotal != null
      ? dayTotal
      : series.length
        ? sumSeries(series)
        : null;
  if (total == null) {
    setText($('history-total'), '—');
    $('history-cost-cell').hidden = true;
    $('history-summary').classList.add('solo');
    return;
  }
  setText($('history-total'), fmtK(total));
  let cost = null;
  if (hasRateSchedule(settings)) {
    if (historyState === 'no-intraday') {
      // Today has a total but no hours behind it: the panel copy explains and
      // the cost stays hidden, exactly as before hourly pricing existed.
      cost = null;
    } else {
      const summary = seriesCostSummary(
        series,
        currentPeriod().bucket,
        settings,
        pricingSessions(),
      );
      cost = summary.cost == null ? null : fmtMoney(summary.cost, settings.currency);
    }
  } else {
    // The flat path, byte-identical to the pre-schedule screen.
    cost = aggregateCostLabel(total, settings);
  }
  $('history-cost-cell').hidden = !cost;
  $('history-summary').classList.toggle('solo', !cost);
  setText($('history-cost'), cost || '');
}

function showChartEmpty(title, line) {
  $('history-chart').setAttribute('hidden', '');
  $('chart-head').hidden = true;
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
  // Geometry follows the series: every rendered point fills the viewBox, so 7,
  // 12 and 30 bars all use the full width and the hit test has no dead slots.
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
  $('chart-head').hidden = false;
  $('chart-empty').hidden = true;
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
  // bucket (a day or a month). "Today ·" only prefixes a whole-day bucket.
  const label = descriptor.bucket === 'hour' ? hourRange(point.id) : point.label;
  const prefix = descriptor.prefixToday && point.isCurrent ? 'Today · ' : '';
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

const OFFLINE_TITLE = "You're offline — history isn't available.";
const NO_HISTORY_COPY = {
  title: 'No history yet',
  line: 'Totals appear once the charger logs a day.',
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
  const hasData = historyServer && sumSeries(series) > 0;
  const view = sectionView(historyState, hasData);
  if (historyState === 'loading' && !series.length) {
    renderSummary();
    showChartEmpty(`Loading ${descriptor.noun}…`, descriptor.loadingLine);
    setHistoryNote('');
    return;
  }
  if (historyState === 'no-intraday') {
    // The chart has nothing it may draw, but the day's total is a real record:
    // the summary keeps it and the panel names why the hours are missing.
    renderSummary();
    showChartEmpty(descriptor.noIntradayTitle, descriptor.noIntradayLine);
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
    $('history-summary').classList.add('solo');
    const copy =
      historyState === 'offline'
        ? { title: OFFLINE_TITLE, line: descriptor.offlineLine }
        : historyState === 'error'
          ? {
              title: `Couldn't load ${descriptor.noun}.`,
              line: 'Check your connection and refresh.',
            }
          : NO_HISTORY_COPY;
    showChartEmpty(copy.title, copy.line);
    setHistoryNote('');
    return;
  }
  renderSummary();
  if (view.claimEmpty || (sumSeries(series) === 0 && !view.stale)) {
    // Zero days inside a rendered period are real zero-height bars; only a read
    // that found nothing in the whole range uses the empty panel.
    showChartEmpty(descriptor.emptyTitle, descriptor.emptyLine);
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
  return todayId !== dayId(new Date());
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
// captures a fresh `today`, so this check can only fire again at the next local
// midnight, never in a loop.
function reloadIfWindowStale() {
  if (!active || !windowStale()) return;
  loaded = false;
  settlePending = false;
  settleVerify = false;
  loadAll();
}

// The window for the selected period. `today` is captured once per read so the
// bounds, the points and the midnight check are derived from the same local
// date. The Day period's window is exactly today, which is also the document its
// read targets.
function periodRange(descriptor, today = new Date()) {
  const bounds = periodBounds(descriptor, today);
  todayId = bounds.endId;
  return bounds;
}

// The selected period's read, chosen by the descriptor: the Day period reads its
// one document, every other period its contiguous day-id range. Both resolve to
// the input applyHistory classifies, so no caller special-cases a period id.
function fetchPeriod(descriptor, bounds) {
  return descriptor.source === 'day'
    ? fetchHistoryDay(bounds.endId)
    : fetchHistory(bounds.startId, bounds.endId);
}

// The period's session archive read, the $ counterpart of fetchPeriod (#123):
// every session overlapping the range, independent of the sessions list's own
// page. The Day period needs none — its hour bars keep the day document's
// buckets — so it resolves to an empty payload, and a rejected range read
// settles empty too: the history read still paints its kWh while the cost
// hides rather than pricing energy it has no session for. The paged read's
// envelope ({docs, fromCache}) is unwrapped to its docs at exactly this point —
// applyHistory expects the sessions themselves, and `fromCache` has no consumer
// on this path. The read itself arrives as a parameter (defaulting to the
// store's) so the executed harness can drive a successful read through the
// real function — Node cannot bind Firestore, and this unwrap is exactly the
// wiring a source pin could not guard.
export function fetchPeriodSessions(descriptor, bounds, readRange = fetchSessionsInRange) {
  if (descriptor.source === 'day') return Promise.resolve([]);
  const range = sessionsRange(bounds);
  return range ? readRange(range).then((read) => read.docs) : Promise.resolve([]);
}

// Apply one settled history read. A failed read and an offline cache miss set
// the state only: points already on screen must never be relabelled as the newly
// selected period. `sessions` is the same read's session payload and is applied
// with the points it prices — the previous period's sessions must never price
// this one's bars. Exported so the executed harness can drive the fetch→apply
// step readHistory and loadAll perform (with the store seam stubbed): the
// payload's shape crossing this boundary is what the harness must observe.
export function applyHistory(descriptor, result, failure, today, sessions = []) {
  const day = descriptor.source === 'day';
  if (result) historyState = day ? hourReadState(result) : historyReadState(result);
  else historyState = day ? hourReadFailure(failure) : 'error';
  if (historyState === 'offline' || historyState === 'error') return;
  // A Day read's payload is the day document itself; a range read's is its list
  // of daily documents.
  periodSessions = Array.isArray(sessions) ? sessions : [];
  series = periodSeries(descriptor, day ? result : result.docs, today);
  const kwh = Number(result.kwh);
  dayTotal = day && Number.isFinite(kwh) && kwh > 0 ? kwh : null;
  historyServer = historyState === 'fresh' || historyState === 'empty';
  if (!series.some((point) => point.id === selectedId)) {
    // Prefer the slot the series marks as current (today, this month, the hour
    // in progress), else the newest slot.
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
  const today = new Date();
  const bounds = periodRange(descriptor, today);
  series = [];
  selectedId = null;
  dayTotal = null;
  periodSessions = [];
  historyServer = false;
  historyState = 'loading';
  renderHistory();
  // The session read is a sibling, not a gate: a rejected session payload
  // prices nothing (the $ hides) while the history read still paints.
  const [hist, sess] = await Promise.allSettled([
    fetchPeriod(descriptor, bounds),
    fetchPeriodSessions(descriptor, bounds),
  ]);
  if (gen !== generation || seq !== historySeq) return;
  applyHistory(
    descriptor,
    hist.status === 'fulfilled' ? hist.value : null,
    hist.status === 'rejected' ? hist.reason : null,
    today,
    sess.status === 'fulfilled' ? sess.value : [],
  );
  renderHistory();
  reloadIfWindowStale();
}

async function switchPeriod(id) {
  const next = periodById(id);
  if (!next || next.id === periodId) return;
  periodId = next.id;
  paintPeriodSwitch();
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
  const today = new Date();
  const bounds = periodRange(descriptor, today);
  // Refresh re-reads the current view's first page — the month the picker
  // names, or the recent list when none is picked — beside the period's own
  // day documents and overlapping sessions.
  const month = pickedMonth();
  const [hist, sess, periodSess] = await Promise.allSettled([
    fetchPeriod(descriptor, bounds),
    fetchSessions({ range: monthRange(month) }),
    fetchPeriodSessions(descriptor, bounds),
  ]);
  // Signed out (or reset) while the reads were in flight.
  if (gen !== generation) return;

  loading = false;
  setRefreshBusy(false);
  // A period switch during the read owns the chart; this payload belongs to the
  // superseded range and must not be painted.
  if (seq === historySeq) {
    applyHistory(
      descriptor,
      hist.status === 'fulfilled' ? hist.value : null,
      hist.status === 'rejected' ? hist.reason : null,
      today,
      periodSess.status === 'fulfilled' ? periodSess.value : [],
    );
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
  renderHistory();
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
  const svg = $('history-chart');
  svg.addEventListener('keydown', (e) => {
    // Only the documented ←/→ mapping moves the selection. Modified keys and
    // every other key belong to the browser (back/forward, tab switching,
    // scrolling), so they are never consumed here.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
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
// guarded path a period switch takes; the guard inside pricingSessions covers
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
  const hadFocus = $('history-chart').contains(document.activeElement);
  renderHistory();
  if (hadFocus) {
    const index = series.findIndex((point) => point.id === selectedId);
    if (barEls[index]) barEls[index].focus({ preventScroll: true });
  }
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
  series = [];
  selectedId = null;
  dayTotal = null;
  todayId = null;
  periodSessions = [];
  liveStatus = null;
  settlePending = false;
  settleVerify = false;
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
    setText($('sessions-count'), '');
    setFeedback('', '');
    setRefreshBusy(false);
    showChartEmpty('No history yet', 'Daily totals appear once the charger logs a day.');
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
