// History screen: a Day / Week / Month / Year energy chart over hand-rolled SVG
// bars, plus the 20 most recent sessions. One-shot reads on first tab
// activation, on Refresh and on a period switch — deliberately no realtime
// listener here.

import { $, setText } from '../ui.js';
import { fetchHistory, fetchHistoryDay, fetchSessions } from '../store.js';
import {
  CHART_VIEW_W,
  DEFAULT_PERIOD,
  PERIODS,
  chartIndexAt,
  dayId,
  dayLabel,
  historyReadState,
  hourRange,
  hourReadFailure,
  hourReadState,
  maxSeries,
  periodBounds,
  periodById,
  periodSeries,
  sectionView,
  sumSeries,
} from '../history.js';
import { aggregateCostLabel, costSettings, hasRateSchedule, sessionCostLabel } from '../cost.js';
import { planHasUnpriced } from '../settings.js';
import { fmtK, formatDuration, toNumber } from '../format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = CHART_VIEW_W;
const VIEW_H = 132;
const TOP = 10;
const BASE = 118;
const PLOT_H = BASE - TOP;
// A bar keeps this share of its slot. 0.56 reproduces the 5.6-unit bar of the
// original 30-slot chart at VIEW_W / 30 and fills the viewBox for 7, 12 or 24
// bars.
const BAR_RATIO = 0.56;
// A partial current slot says so in its accessible name: a month holds only its
// recorded days, and an hour holds only what has been recorded so far.
const PARTIAL_SUFFIX = { month: ' (current month)', hour: ' (this hour so far)' };

let active = false;
let loaded = false;
let loading = false;
// Full cost settings ({rate, currency, rates}); per-session costs use the
// schedule, and its presence hides the aggregate daily/period cost below.
let settings = null;
// Selected chart range (a PERIODS id), and the read that owns the chart. Every
// history read takes a sequence number so a period switch cannot be repainted by
// the read it superseded.
let periodId = DEFAULT_PERIOD;
let historySeq = 0;
let series = [];
let selectedId = null;
let todayId = null;
let sessions = [];
// Latest settled read per section: idle | loading | fresh | empty | cached |
// offline | error | no-intraday. Tracked separately so one section's outcome
// never speaks for the other, and so freshness is never inferred from how much
// data is on screen.
let historyState = 'idle';
let sessionsState = 'idle';
// Today's daily total, kept separately because a day with no hourly buckets has
// a real total the series cannot carry (the chart refuses to draw it as zeros).
let dayTotal = null;
// Whether the payload currently on screen came from an answer the server gave
// (fresh/empty). Cached, offline, and failed reads never set it.
let historyServer = false;
let sessionsServer = false;
let barEls = [];
let generation = 0;
let scrubbing = false;
let scrubPointer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}

// ---------- summary + chart ----------

// Period cost from a kWh total. Null when a schedule exists: a day stores one
// kWh figure, so its cost cannot be split across the windows it was drawn in.
// The chart and summary then show kWh only.
function seriesCost(kwh) {
  return aggregateCostLabel(kwh, settings);
}

// Say why the aggregate cost is absent: with a schedule the summary reflows to
// one full-width kWh card and the chart drops its cost readout, and an absence
// alone reads as lost data. Only ever shown beside a rendered summary.
function setCostNote(visible) {
  const note = $('history-cost-note');
  if (note) note.hidden = !visible;
}

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
    setCostNote(false);
    return;
  }
  setText($('history-total'), fmtK(total));
  const cost = seriesCost(total);
  $('history-cost-cell').hidden = !cost;
  $('history-summary').classList.toggle('solo', !cost);
  setText($('history-cost'), cost || '');
  setCostNote(!cost && hasRateSchedule(settings));
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

function buildBar(point, index, slot, barW) {
  const descriptor = currentPeriod();
  const cost = seriesCost(point.kwh);
  const suffix = point.isCurrent ? PARTIAL_SUFFIX[descriptor.bucket] || '' : '';
  const label = descriptor.bucket === 'hour' ? hourRange(point.id) : point.label;
  const group = svgEl('g', {
    class: 'bar',
    role: 'button',
    tabindex: '-1',
    'data-index': String(index),
    'aria-label': `${label}${suffix}: ${fmtK(point.kwh)} kWh${cost ? `, ${cost}` : ''}`,
  });
  const hit = svgEl('rect', {
    class: 'bar-hit',
    x: String(index * slot),
    y: '0',
    width: String(slot),
    height: String(VIEW_H),
    fill: 'transparent',
  });
  const guide = svgEl('rect', {
    class: 'bar-guide',
    x: String(index * slot + (slot - barW) / 2),
    y: String(TOP),
    width: String(barW),
    height: String(PLOT_H),
    rx: '2',
  });
  const max = maxSeries(series);
  const height = point.kwh > 0 && max > 0 ? Math.max(2, (point.kwh / max) * (PLOT_H - 2)) : 2;
  const fill = svgEl('rect', {
    class: 'bar-fill',
    x: String(index * slot + (slot - barW) / 2),
    y: String(BASE - height),
    width: String(barW),
    height: String(height),
    rx: '1.2',
  });
  group.append(guide, hit, fill);
  if (point.kwh <= 0) group.classList.add('zero');
  return group;
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
  barEls = series.map((point, index) => {
    const group = buildBar(point, index, slot, barW);
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
  const cost = seriesCost(point.kwh);
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
    setCostNote(false);
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

function sessionsMessage() {
  if (sessionsState === 'loading') return 'Loading recent sessions…';
  if (sessionsState === 'offline') return "You're offline — sessions aren't available.";
  if (sessionsState === 'error') {
    return "Couldn't load recent sessions. Check your connection and refresh.";
  }
  return 'No completed sessions yet. They appear after a car unplugs.';
}

function sessionsNote() {
  if (sessionsState === 'cached') return 'Showing cached sessions — reconnect to refresh.';
  if (sessionsState === 'offline') return "You're offline — showing the last sessions loaded.";
  return "Couldn't refresh recent sessions — showing the last list loaded.";
}

function renderSessions() {
  const list = $('sessions-list');
  const state = $('sessions-state');
  list.replaceChildren();
  setText(
    $('sessions-count'),
    sessions.length ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}` : '',
  );
  const hasData = sessionsServer && sessions.length > 0;
  const view = sectionView(sessionsState, hasData);
  if (sessionsState === 'empty' || !view.showData) {
    list.hidden = true;
    state.hidden = false;
    state.className = sessionsState === 'error' ? 'section-state err' : 'section-state';
    setText(state, sessionsMessage());
    return;
  }
  const note = view.stale ? sessionsNote() : '';
  state.hidden = !note;
  state.className = 'section-state';
  setText(state, note);
  list.hidden = false;
  for (const item of sessions) list.append(renderSession(item));
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
  if (!answered(historyState) || !answered(sessionsState)) {
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

// Apply one settled history read. A failed read and an offline cache miss set
// the state only: points already on screen must never be relabelled as the newly
// selected period.
function applyHistory(descriptor, result, failure, today) {
  const day = descriptor.source === 'day';
  if (result) historyState = day ? hourReadState(result) : historyReadState(result);
  else historyState = day ? hourReadFailure(failure) : 'error';
  if (historyState === 'offline' || historyState === 'error') return;
  // A Day read's payload is the day document itself; a range read's is its list
  // of daily documents.
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
  historyServer = false;
  historyState = 'loading';
  renderHistory();
  let result = null;
  let failure = null;
  try {
    result = await fetchPeriod(descriptor, bounds);
  } catch (err) {
    failure = err;
  }
  if (gen !== generation || seq !== historySeq) return;
  applyHistory(descriptor, result, failure, today);
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

async function loadAll() {
  if (loading) return;
  loading = true;
  loaded = true;
  const gen = generation;
  const first = historyState === 'idle' && sessionsState === 'idle';
  if (first) {
    historyState = 'loading';
    sessionsState = 'loading';
    renderHistory();
    renderSessions();
  }
  setRefreshBusy(true);
  setFeedback('Refreshing…');
  const seq = ++historySeq;
  const descriptor = currentPeriod();
  const today = new Date();
  const bounds = periodRange(descriptor, today);
  const [hist, sess] = await Promise.allSettled([fetchPeriod(descriptor, bounds), fetchSessions()]);
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
    );
  }
  sessionsState = sess.status === 'fulfilled' ? historyReadState(sess.value) : 'error';
  // Only a read that returned rows (fresh or cached) replaces the payload; an
  // offline cache miss or a failed read leaves the previous list alone and
  // sectionView decides whether it is still safe to show it as stale. The
  // provenance flag follows the payload, not the latest read.
  if (sess.status === 'fulfilled' && sessionsState !== 'offline') {
    sessions = sess.value.docs;
    sessionsServer = sessionsState === 'fresh' || sessionsState === 'empty';
  }
  renderHistory();
  renderSessions();
  renderLoadFeedback();

  reloadIfWindowStale();
}

// ---------- screen lifecycle ----------

export function initHistory() {
  $('history-refresh').addEventListener('click', loadAll);
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
}

// settings/current — costs update in place; no reload needed. The whole document
// is kept: sessions are priced over their own interval, and a schedule also
// decides that the aggregate cost is hidden.
export function showHistorySettings(data) {
  settings = costSettings(data);
  renderPlanBanner();
  if (series.length) {
    const hadFocus = $('history-chart').contains(document.activeElement);
    renderHistory();
    if (hadFocus) {
      const index = series.findIndex((point) => point.id === selectedId);
      if (barEls[index]) barEls[index].focus({ preventScroll: true });
    }
  }
  if (sessions.length) renderSessions();
}

export function resetHistory() {
  generation += 1;
  historySeq += 1;
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
  sessions = [];
  historyState = 'idle';
  sessionsState = 'idle';
  historyServer = false;
  sessionsServer = false;
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
    setCostNote(false);
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
  }
}
