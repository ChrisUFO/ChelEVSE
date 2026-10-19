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
  historySeries,
  lastDayIds,
  maxSeries,
  sumSeries,
} from '../history.js';
import { fmtCost, fmtK, formatDuration, toNumber } from '../format.js';

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
let rate = null;
let currency = '';
let series = [];
let selectedId = null;
let todayId = null;
let sessions = [];
let historyState = 'idle';
let sessionsState = 'idle';
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

function seriesCost(kwh) {
  return fmtCost(kwh, rate, currency);
}

function renderSummary() {
  if (!series.length) {
    setText($('history-total'), '—');
    $('history-cost-cell').hidden = true;
    $('history-summary').classList.add('solo');
    return;
  }
  const total = sumSeries(series);
  setText($('history-total'), fmtK(total));
  const cost = seriesCost(total);
  $('history-cost-cell').hidden = !cost;
  $('history-summary').classList.toggle('solo', !cost);
  setText($('history-cost'), cost || '');
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
  setText($('chart-day'), `${point.id === todayId ? 'Today · ' : ''}${point.label}`);
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

function renderHistory() {
  if (historyState === 'loading' && !series.length) {
    renderSummary();
    showChartEmpty('Loading daily energy…', 'Reading the last 30 days.');
    return;
  }
  if (historyState === 'error' && !series.length) {
    setText($('history-total'), '—');
    $('history-cost-cell').hidden = true;
    $('history-summary').classList.add('solo');
    showChartEmpty("Couldn't load daily energy.", 'Check your connection and refresh.');
    return;
  }
  if (!series.length) {
    renderSummary();
    showChartEmpty('No history yet', 'Daily totals appear once the charger logs a day.');
    return;
  }
  renderSummary();
  if (sumSeries(series) === 0) {
    showChartEmpty(
      'No energy recorded in the last 30 days.',
      'Days without charging count as zero.',
    );
    return;
  }
  renderChart();
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
  const cost = kwh == null ? null : seriesCost(kwh);
  if (cost) {
    const dot = el('span', 'session-dot', '·');
    dot.setAttribute('aria-hidden', 'true');
    meta.append(dot, el('span', 'session-cost', cost));
  }
  what.append(meta);
  li.append(when, what);
  return li;
}

function renderSessions() {
  const list = $('sessions-list');
  const state = $('sessions-state');
  list.replaceChildren();
  setText(
    $('sessions-count'),
    sessions.length ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}` : '',
  );
  if (sessionsState === 'loading' && !sessions.length) {
    state.hidden = false;
    state.className = 'section-state';
    setText(state, 'Loading recent sessions…');
    return;
  }
  if (sessionsState === 'error' && !sessions.length) {
    state.hidden = false;
    state.className = 'section-state err';
    setText(state, "Couldn't load recent sessions. Check your connection and refresh.");
    return;
  }
  if (!sessions.length) {
    state.hidden = false;
    state.className = 'section-state';
    setText(state, 'No completed sessions yet. They appear after a car unplugs.');
    return;
  }
  state.hidden = true;
  for (const item of sessions) list.append(renderSession(item));
  list.hidden = false;
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

async function loadAll() {
  if (loading) return;
  loading = true;
  loaded = true;
  const gen = generation;
  const first = !series.length;
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

  if (hist.status === 'fulfilled') {
    series = historySeries(ids, hist.value);
    historyState = 'ready';
    if (!series.some((point) => point.id === selectedId)) selectedId = todayId;
  } else if (!series.length) {
    historyState = 'error';
  }

  if (sess.status === 'fulfilled') {
    sessions = sess.value;
    sessionsState = 'ready';
  } else if (!sessions.length) {
    sessionsState = 'error';
  }

  loading = false;
  setRefreshBusy(false);
  renderHistory();
  renderSessions();

  if (hist.status === 'rejected' && sess.status === 'rejected') {
    setFeedback("Couldn't refresh — check your connection.", 'err');
  } else if (hist.status === 'rejected') {
    setFeedback("Daily energy couldn't be refreshed.", 'err');
  } else if (sess.status === 'rejected') {
    setFeedback("Recent sessions couldn't be refreshed.", 'err');
  } else {
    const stamp = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
    setFeedback(`Updated ${stamp}.`, 'ok');
  }
}

// ---------- screen lifecycle ----------

export function initHistory() {
  $('history-refresh').addEventListener('click', loadAll);
  const svg = $('history-chart');
  svg.addEventListener('keydown', (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key) || !series.length) return;
    e.preventDefault();
    const current = series.findIndex((point) => point.id === selectedId);
    let next = current < 0 ? series.length - 1 : current;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next -= 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next += 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = series.length - 1;
    selectIndex(next, { focus: true });
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
}

export function enterHistory() {
  active = true;
}

export function activateHistory() {
  if (!active) return;
  if (!loaded && !loading) loadAll();
}

// settings/current — costs update in place; no reload needed.
export function showHistorySettings(settings) {
  const r = settings && settings.rate;
  rate = typeof r === 'number' && Number.isFinite(r) ? r : null;
  currency = settings && typeof settings.currency === 'string' ? settings.currency : '';
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
  rate = null;
  currency = '';
  series = [];
  selectedId = null;
  todayId = null;
  sessions = [];
  historyState = 'idle';
  sessionsState = 'idle';
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
    setText($('sessions-count'), '');
    setFeedback('', '');
    setRefreshBusy(false);
    showChartEmpty('No history yet', 'Daily totals appear once the charger logs a day.');
    const state = $('sessions-state');
    state.hidden = true;
    state.className = 'section-state';
  }
}
