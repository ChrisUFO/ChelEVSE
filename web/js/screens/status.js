// Status screen: live charger figures, command feedback, and the command-
// oriented pause/resume/set-current controls. All rendering and status-specific
// state lives here so the screen survives tab switches intact.

import { $, setText } from '../ui.js';
import { fmtCost, fmtK, formatElapsed, relTime, stateFor } from '../format.js';
import { sendCommand as postCommand } from '../store.js';

const CMD_TEXT = {
  pause: { busy: () => 'Sending stop…', done: () => 'Stop command applied.' },
  resume: { busy: () => 'Sending auto…', done: () => 'Auto command applied.' },
  set_current: {
    busy: (a) => `Setting ${a} A…`,
    done: (a) => `Current set to ${a} A.`,
  },
};

let status = null;
let schedule = null;
let rate = null;
let currency = '';
let active = false;
let ampsTouched = false;
let holdOpen = false;
let holdAmps = 32;
let ticker = null;
let resultTimer = null;
let shownResultId = null;
let elapsedAnchor = 0;

function ageMs() {
  const ts = status && status.updated_at;
  return ts && typeof ts.toMillis === 'function' ? Date.now() - ts.toMillis() : Infinity;
}

function renderFreshness() {
  if (!status) {
    setText($('updated'), 'waiting for data');
    $('banner').hidden = true;
    return;
  }
  setText($('updated'), `updated ${relTime(ageMs())}`);
  $('banner').hidden = !(status.charger_online === false || ageMs() > 60000);
}

// The snapshot carries elapsed seconds. Between snapshots we add wall-clock
// time only while the charger reports charging and the document is fresh; a new
// snapshot re-anchors, so time is never counted twice.
function renderElapsed() {
  let seconds = status ? Number(status.elapsed) : null;
  if (seconds == null || !Number.isFinite(seconds)) {
    setText($('elapsed'), '—');
    return;
  }
  const live =
    status.state_label === 'charging' && status.charger_online !== false && ageMs() <= 60000;
  if (live) seconds += Math.max(0, (Date.now() - elapsedAnchor) / 1000);
  setText($('elapsed'), formatElapsed(seconds));
}

function renderCost() {
  const kwh = status && status.session_energy != null ? Number(status.session_energy) / 1000 : null;
  const cost = kwh == null ? null : fmtCost(kwh, rate, currency);
  const el = $('session-cost');
  el.hidden = !cost;
  setText(el, cost || '');
  // The tile is half-width: the cost replaces the caption rather than wrapping.
  $('session-sub').hidden = Boolean(cost);
}

function renderScheduleBadge() {
  const el = $('schedule-badge');
  const info = status && status.schedule;
  const inWindow = Boolean(info && info.in_window === true);
  el.hidden = !inWindow;
  if (!inWindow) return;
  const id = typeof info.active_rule_id === 'string' ? info.active_rule_id : '';
  const rules = schedule && Array.isArray(schedule.rules) ? schedule.rules : [];
  const rule = id ? rules.find((r) => r && r.id === id) : null;
  // Only name the window once the id resolves against the live schedule doc;
  // otherwise report just what the charger said.
  setText(
    $('schedule-badge-text'),
    rule ? `Scheduled ${rule.start}–${rule.end}` : 'Scheduled window',
  );
  el.title = rule
    ? `Active rule ${rule.id} (${rule.start}–${rule.end})`
    : 'A schedule window is active';
}

function renderStatus() {
  const theState = stateFor(status && status.state_label);
  document.documentElement.style.setProperty('--state', theState.color);
  setText($('state-label'), theState.label);
  $('state-badge').classList.toggle('pulse', status && status.state_label === 'charging');

  setText($('power'), status && status.power != null ? fmtK(status.power / 1000) : '—');
  setText($('fig-amp'), status && status.amp != null ? String(Math.round(status.amp)) : '—');
  setText($('fig-volt'), status && status.voltage ? `at ${Math.round(status.voltage)} V` : '');
  setText(
    $('fig-session'),
    status && status.session_energy != null ? fmtK(status.session_energy / 1000) : '—',
  );
  setText(
    $('fig-setpoint'),
    status && status.pilot != null ? String(Math.round(status.pilot)) : '—',
  );
  setText($('fig-total'), status && status.total_energy != null ? fmtK(status.total_energy) : '—');
  setText($('fig-temp'), status && status.temp_c != null ? String(Math.round(status.temp_c)) : '—');
  for (const n of [1, 2, 3]) {
    const v = status && status[`temp${n}`];
    setText($(`fig-temp${n}`), v != null && Number.isFinite(Number(v)) ? `${Math.round(v)}°` : '—');
  }

  if (!ampsTouched) {
    // Hold sets a limit: prefill from the pilot setpoint, not the live draw.
    const pilot = status ? Number(status.pilot) : Number.NaN;
    const live = status ? Number(status.amp) : Number.NaN;
    const source = pilot >= 6 && pilot <= 48 ? pilot : live;
    if (Number.isFinite(source) && source > 0) {
      setAmps(Math.min(48, Math.max(6, Math.round(source))));
    }
  }
  renderElapsed();
  renderCost();
  renderScheduleBadge();
  renderFreshness();
}

function setBusy(busy) {
  for (const el of [$('pause'), $('resume'), $('hold'), $('amps'), $('apply')]) el.disabled = busy;
}

function renderCommands(cmds) {
  const fb = $('feedback');
  const pending = cmds.find((c) => c.status === 'pending');
  setBusy(Boolean(pending));
  if (pending) {
    const t = CMD_TEXT[pending.type] || CMD_TEXT.resume;
    fb.className = 'feedback busy';
    setText(fb, t.busy(pending.amps));
    return;
  }
  const latest = cmds[0];
  const created =
    latest && latest.created_at && typeof latest.created_at.toMillis === 'function'
      ? latest.created_at.toMillis()
      : 0;
  if (!latest || !created || Date.now() - created > 5 * 60000) {
    fb.className = 'feedback';
    setText(fb, '');
    return;
  }
  const t = CMD_TEXT[latest.type] || { busy: () => 'Working…', done: () => 'Done.' };
  if (latest.status === 'acked') {
    if (shownResultId === latest.id) return;
    shownResultId = latest.id;
    fb.className = 'feedback ok';
    setText(fb, t.done(latest.amps));
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      if (shownResultId === latest.id) {
        fb.className = 'feedback';
        setText(fb, '');
      }
    }, 6000);
  } else if (latest.status === 'failed') {
    shownResultId = latest.id;
    fb.className = 'feedback err';
    setText(fb, `Failed: ${latest.error || 'command was not applied'}`);
  } else {
    fb.className = 'feedback';
    setText(fb, '');
  }
}

async function send(payload) {
  setBusy(true); // optimistic; the commands listener keeps this set until the bridge acks
  try {
    await postCommand(payload);
  } catch {
    setBusy(false);
    const fb = $('feedback');
    fb.className = 'feedback err';
    setText(fb, 'Could not send — check your connection and try again.');
  }
}

function setAmps(v) {
  holdAmps = v;
  $('amps').value = v;
  paintSlider();
}

function paintSlider() {
  const v = Number($('amps').value);
  setText($('amps-out'), `${v} A`);
  $('amps').style.setProperty('--fill', `${((v - 6) / 42) * 100}%`);
}

// Hold reveals the set-current editor; it does not claim a mode is active.
// Stop and Auto send their commands immediately.
function setHoldOpen(open) {
  holdOpen = open;
  $('hold-panel').hidden = !open;
  $('hold').setAttribute('aria-expanded', String(open));
  if (open) $('amps').focus({ preventScroll: true });
  else $('hold').focus({ preventScroll: true });
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    renderFreshness();
    renderElapsed();
  }, 1000);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

// ---------- screen lifecycle ----------

export function initStatus() {
  $('pause').addEventListener('click', () => send({ type: 'pause' }));
  $('resume').addEventListener('click', () => send({ type: 'resume' }));
  $('hold').addEventListener('click', () => setHoldOpen(!holdOpen));
  $('apply').addEventListener('click', () =>
    send({ type: 'set_current', amps: Number($('amps').value) }),
  );
  $('amps').addEventListener('input', () => {
    ampsTouched = true;
    holdAmps = Number($('amps').value);
    paintSlider();
  });
}

export function enterStatus() {
  active = true;
  if (!$('panel-status').hidden) startTicker();
}

export function focusStatus() {
  if (!active) return;
  startTicker();
  renderElapsed();
  renderFreshness();
}

export function blurStatus() {
  stopTicker();
}

export function leaveStatus() {
  active = false;
  stopTicker();
  clearTimeout(resultTimer);
  ticker = resultTimer = null;
  status = null;
  schedule = null;
  rate = null;
  currency = '';
  ampsTouched = false;
  holdOpen = false;
  holdAmps = 32;
  shownResultId = null;
  setBusy(false);
  const fb = $('feedback');
  fb.className = 'feedback';
  setText(fb, '');
  $('banner').hidden = true;
  $('hold-panel').hidden = true;
  $('hold').setAttribute('aria-expanded', 'false');
  setText($('elapsed'), '—');
  setText($('session-cost'), '');
  $('session-cost').hidden = true;
  $('session-sub').hidden = false;
  $('schedule-badge').hidden = true;
  setAmps(32);
  showConfig(null);
  renderStatus();
}

// ---------- data callbacks ----------

export function showStatus(snap) {
  status = snap && snap.exists() ? snap.data() : null;
  elapsedAnchor = Date.now();
  renderStatus();
}

export function showStatusError() {
  status = null;
  renderStatus();
}

export function showCommands(cmds) {
  renderCommands(cmds);
}

// settings/current — null until an owner saves a rate.
export function showSettings(settings) {
  const r = settings && settings.rate;
  rate = typeof r === 'number' && Number.isFinite(r) ? r : null;
  currency = settings && typeof settings.currency === 'string' ? settings.currency : '';
  renderCost();
}

// status/config — the device name is the header's first consumer.
export function showConfig(config) {
  const raw = config && typeof config.hostname === 'string' ? config.hostname.trim() : '';
  setText($('device-name'), raw || 'ChelEVSE');
  $('device-name').title = raw || 'ChelEVSE';
}

// schedule/current — used only to resolve the active rule's window.
export function showStatusSchedule(data) {
  schedule = data;
  renderScheduleBadge();
}
