// Status screen: live charger figures, command feedback, and the command-
// oriented pause/resume/set-current controls. All rendering and status-specific
// state lives here so the screen survives tab switches intact.

import { $, setText } from '../ui.js';
import {
  elapsedClock,
  fmtCost,
  fmtK,
  formatElapsed,
  freezeClock,
  freshnessState,
  holdAfterSnapshot,
  numOrDash,
  relTime,
  stateFor,
  toNumber,
} from '../format.js';
import { sendCommand as postCommand } from '../store.js';

const CMD_TEXT = {
  pause: { busy: () => 'Sending stop…', done: () => 'Stop command applied.' },
  resume: { busy: () => 'Sending auto…', done: () => 'Auto command applied.' },
  set_current: {
    busy: (a) => `Setting ${a} A…`,
    done: (a) => `Current set to ${a} A.`,
  },
};
// RAPI entries in the shared command feed must not disable these controls or
// replace their feedback with a generic "Done." Pending commands arrive from
// their own subscription, so RAPI volume cannot evict them from this view.
const CONTROL_TYPES = new Set(Object.keys(CMD_TEXT));

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
// Local receipt anchor for the session clock (see elapsedClock).
let clock = null;
// Value frozen when a stop command is sent, with the status write it belongs
// to; released only by a new status write or an explicit command failure.
let clockHold = null;

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
  const age = ageMs();
  setText($('updated'), Number.isFinite(age) ? `updated ${relTime(age)}` : 'updated unknown');
  const state = freshnessState({ chargerOnline: status.charger_online, ageMs: age });
  const banner = $('banner');
  banner.hidden = !state;
  setText(
    banner,
    state === 'charger'
      ? 'Charger offline — showing last known values'
      : 'Bridge offline — showing last known values',
  );
}

// The snapshot carries elapsed seconds. The clock is anchored to the local
// receipt of the status write it belongs to, so it keeps ticking when this
// device's clock is behind Firestore and cannot rewind on schedule-only merges.
// A stop command freezes the displayed value until the charger reports a new
// status write, so the clock cannot overshoot and then snap back.
function renderElapsed() {
  const step = elapsedClock(clock, status, Date.now());
  clock = step.clock;
  const held = clockHold == null ? null : clockHold.value;
  setText($('elapsed'), formatElapsed(held == null ? step.seconds : held));
}

// Freeze the clock at the value currently on screen.
function freezeElapsed() {
  const step = elapsedClock(clock, status, Date.now());
  clock = step.clock;
  clockHold = freezeClock(step.seconds, status);
}

function renderCost() {
  const energy = status ? toNumber(status.session_energy) : Number.NaN;
  const kwh = Number.isFinite(energy) ? energy / 1000 : null;
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
  // Only name the window once the id resolves against the live schedule doc and
  // the boundary values are strings; otherwise report just what the charger said.
  const named = Boolean(rule) && typeof rule.start === 'string' && typeof rule.end === 'string';
  setText(
    $('schedule-badge-text'),
    named ? `Scheduled ${rule.start}–${rule.end}` : 'Scheduled window',
  );
  el.title = named
    ? `Active rule ${rule.id} (${rule.start}–${rule.end})`
    : 'A schedule window is active';
}

function renderStatus() {
  const theState = stateFor(status && status.state_label);
  document.documentElement.style.setProperty('--state', theState.color);
  setText($('state-label'), theState.label);
  $('state-badge').classList.toggle('pulse', status && status.state_label === 'charging');

  setText($('power'), status && status.power != null ? fmtK(toNumber(status.power) / 1000) : '—');
  setText($('fig-amp'), status ? numOrDash(status.amp) : '—');
  const volts = status ? toNumber(status.voltage) : Number.NaN;
  setText($('fig-volt'), Number.isFinite(volts) && volts ? `at ${Math.round(volts)} V` : '');
  setText(
    $('fig-session'),
    status && status.session_energy != null ? fmtK(toNumber(status.session_energy) / 1000) : '—',
  );
  setText($('fig-setpoint'), status ? numOrDash(status.pilot) : '—');
  setText($('fig-total'), status && status.total_energy != null ? fmtK(status.total_energy) : '—');
  setText($('fig-temp'), status ? numOrDash(status.temp_c) : '—');
  for (const n of [1, 2, 3]) {
    const t = status ? numOrDash(status[`temp${n}`]) : '—';
    setText($(`fig-temp${n}`), t === '—' ? t : `${t}°`);
  }

  if (!ampsTouched) {
    // Hold sets a limit: prefill from the pilot setpoint, not the live draw.
    const pilot = status ? toNumber(status.pilot) : Number.NaN;
    const live = status ? toNumber(status.amp) : Number.NaN;
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
  const controls = (Array.isArray(cmds) ? cmds : []).filter(
    (command) => command && CONTROL_TYPES.has(command.type),
  );
  const pending = controls.find((c) => c.status === 'pending');
  setBusy(Boolean(pending));
  if (pending) {
    const t = CMD_TEXT[pending.type] || CMD_TEXT.resume;
    fb.className = 'feedback busy';
    setText(fb, t.busy(pending.amps));
    return;
  }
  const latest = controls[0];
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
    // The stop never left this device, so let the clock follow the next write.
    clockHold = null;
    renderElapsed();
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
  $('pause').addEventListener('click', () => {
    // Hold the clock where it is on screen: the last snapshot still says
    // "charging" until the bridge reports the new state, and extrapolating past
    // it would overshoot before snapping back.
    freezeElapsed();
    renderElapsed();
    send({ type: 'pause' });
  });
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
  clock = null;
  clockHold = null;
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
  const data = snap && snap.exists() ? snap.data() : null;
  // Only a new status write releases a stop-time hold. The bridge merges only
  // `schedule` into status/current, and releasing on that merge would let the
  // clock interpolate from the old write and jump before the stop lands.
  clockHold = holdAfterSnapshot(clockHold, data);
  status = data;
  renderStatus();
}

export function showStatusError() {
  clock = null;
  clockHold = null;
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
