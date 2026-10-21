// History screen: 30 local days of daily energy in a hand-rolled SVG bar chart
// plus the 20 most recent sessions. One-shot reads on first tab activation and
// on Refresh — deliberately no realtime listener here.

import { $, setText } from '../ui.js';
import { fetchHistory, fetchSessions, historyBounds } from '../store.js';
import {
  CHART_SLOTS,
  CHART_VIEW_W,
  chartIndexAt,
  dayId,
  dayLabel,
  historyReadState,
  historySeries,
  lastDayIds,
  maxSeries,
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
const SLOT = VIEW_W / CHART_SLOTS;
const BAR_W = 5.6;

let active = false;
let loaded = false;
let loading = false;
// Full cost settings ({rate, currency, rates}); per-session costs use the
// schedule, and its presence hides the aggregate daily/30-day cost below.
let settings = null;
let series = [];
let selectedId = null;
let todayId = null;
let sessions = [];
// Latest settled read per section: idle | loading | fresh | empty | cached |
// offline | error. Tracked separately so one section's outcome never speaks for
// the other, and so freshness is never inferred from how much data is on screen.
let historyState = 'idle';
let sessionsState = 'idle';
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

// Daily/30-day cost from a kWh total. Null when a schedule exists: a day stores
// one kWh figure, so its cost cannot be split across the windows it was drawn in.
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

function renderSummary() {
  renderPlanBanner();
  if (!series.length) {
    setText($('history-total'), '—');
    $('history-cost-cell').hidden = true;
    $('history-summary').classList.add('solo');
    setCostNote(false);
    return;
  }
  const total = sumSeries(series);
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
  setText($('chart-empty-title'), title);
  setText($('chart-empty-line'), line);
}

function buildBar(point, index) {
  const group = svgEl('g', {
    class: 'bar',
    role: 'button',
    tabindex: '-1',
    'data-index': String(index),
    'aria-label': `${point.label}: ${fmtK(point.kwh)} kWh${
      seriesCost(point.kwh) ? `, ${seriesCost(point.kwh)}` : ''
    }`,
  });
  const hit = svgEl('rect', {
    class: 'bar-hit',
    x: String(index * SLOT),
    y: '0',
    width: String(SLOT),
    height: String(VIEW_H),
    fill: 'transparent',
  });
  const guide = svgEl('rect', {
    class: 'bar-guide',
    x: String(index * SLOT + (SLOT - BAR_W) / 2),
    y: String(TOP),
    width: String(BAR_W),
    height: String(PLOT_H),
    rx: '2',
  });
  const max = maxSeries(series);
  const height = point.kwh > 0 && max > 0 ? Math.max(2, (point.kwh / max) * (PLOT_H - 2)) : 2;
  const fill = svgEl('rect', {
    class: 'bar-fill',
    x: String(index * SLOT + (SLOT - BAR_W) / 2),
    y: String(BASE - height),
    width: String(BAR_W),
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
  barEls = series.map((point, index) => {
    const group = buildBar(point, index);
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
  const x = Math.max(0, Math.min(series.length - 1, index));
  const point = series[x];
  selectedId = point.id;
  const cost = seriesCost(point.kwh);
  setText($('chart-day'), `${point.id === dayId(new Date()) ? 'Today · ' : ''}${point.label}`);
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

const OFFLINE_COPY = {
  title: "You're offline — history isn't available.",
  line: 'Reconnect, then tap Refresh to load the last 30 days.',
};
const ERROR_COPY = {
  title: "Couldn't load daily energy.",
  line: 'Check your connection and refresh.',
};
const EMPTY_COPY = {
  title: 'No history yet',
  line: 'Daily totals appear once the charger logs a day.',
};

function setHistoryNote(text) {
  const note = $('history-state');
  if (!note) return;
  note.hidden = !text;
  setText(note, text);
}

// A section note always describes the last read, never the rows on screen.
function historyNote(view) {
  if (!view.stale) return '';
  if (historyState === 'cached') return 'Showing cached daily energy — reconnect to refresh.';
  if (historyState === 'offline') return "You're offline — showing the last daily energy loaded.";
  return "Couldn't refresh daily energy — showing the last values loaded.";
}

function renderHistory() {
  const hasData = historyServer && sumSeries(series) > 0;
  const view = sectionView(historyState, hasData);
  if (historyState === 'loading' && !series.length) {
    renderSummary();
    showChartEmpty('Loading daily energy…', 'Reading the last 30 days.');
    setHistoryNote('');
    return;
  }
  if (!view.showData) {
    // Nothing current to draw: never paint zeroes for a read that did not reach
    // the server, or a cache miss would read as "no energy recorded".
    setText($('history-total'), '—');
    $('history-cost-cell').hidden = true;
    $('history-summary').classList.add('solo');
    setCostNote(false);
    const copy =
      historyState === 'offline'
        ? OFFLINE_COPY
        : historyState === 'error'
          ? ERROR_COPY
          : EMPTY_COPY;
    showChartEmpty(copy.title, copy.line);
    setHistoryNote('');
    return;
  }
  renderSummary();
  if (view.claimEmpty || (sumSeries(series) === 0 && !view.stale)) {
    showChartEmpty(
      'No energy recorded in the last 30 days.',
      'Days without charging count as zero.',
    );
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
  const ids = lastDayIds(30);
  todayId = ids[ids.length - 1];
  const bounds = historyBounds(ids);
  const [hist, sess] = await Promise.allSettled([
    fetchHistory(bounds.startId, bounds.endId),
    fetchSessions(),
  ]);
  // Signed out (or reset) while the reads were in flight.
  if (gen !== generation) return;

  historyState = hist.status === 'fulfilled' ? historyReadState(hist.value) : 'error';
  sessionsState = sess.status === 'fulfilled' ? historyReadState(sess.value) : 'error';
  // Only a read that returned rows (fresh or cached) replaces the payload; an
  // offline cache miss or a failed read leaves the previous payload alone and
  // sectionView decides whether it is still safe to show it as stale. The
  // provenance flag follows the payload, not the latest read.
  if (historyState === 'fresh' || historyState === 'empty' || historyState === 'cached') {
    series = historySeries(ids, hist.value.docs);
    historyServer = historyState !== 'cached';
    if (!series.some((point) => point.id === selectedId)) selectedId = todayId;
  }
  if (sessionsState === 'fresh' || sessionsState === 'empty' || sessionsState === 'cached') {
    sessions = sess.value.docs;
    sessionsServer = sessionsState !== 'cached';
  }

  loading = false;
  setRefreshBusy(false);
  renderHistory();
  renderSessions();
  renderLoadFeedback();

  // A read that was in flight across local midnight leaves yesterday's window
  // on screen; reload once with today's ids.
  if (active && windowStale()) {
    loaded = false;
    loadAll();
  }
}

// ---------- screen lifecycle ----------

export function initHistory() {
  $('history-refresh').addEventListener('click', loadAll);
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
  // A tab left open across local midnight would keep yesterday's 30-day window
  // and label it "Today"; reload once when the local date has changed.
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
  active = false;
  loaded = false;
  loading = false;
  settings = null;
  const planBanner = $('history-plan-banner');
  if (planBanner) planBanner.hidden = true;
  series = [];
  selectedId = null;
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
