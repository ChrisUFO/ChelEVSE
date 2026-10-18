// Status screen: live charger figures, command feedback, and the pause/resume/
// set-current controls. All rendering and status-specific state lives here so
// the screen survives tab switches intact.

import { $, setText } from '../ui.js';
import { fmtK, relTime, stateFor } from '../format.js';
import { sendCommand as postCommand } from '../store.js';

const CMD_TEXT = {
  pause: { busy: () => 'Pausing…', done: () => 'Paused.' },
  resume: { busy: () => 'Resuming…', done: () => 'Resumed.' },
  set_current: { busy: (a) => `Setting current to ${a} A…`, done: (a) => `Current set to ${a} A.` },
};

let status = null;
let ampsPrefilled = false;
let ticker = null;
let resultTimer = null;
let shownResultId = null;

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
  setText($('fig-total'), status && status.total_energy != null ? fmtK(status.total_energy) : '—');
  setText($('fig-temp'), status && status.temp_c != null ? String(Math.round(status.temp_c)) : '—');

  const charging = status && status.state_label === 'charging';
  $('pause').classList.toggle('primary', charging);
  $('resume').classList.toggle('primary', !charging);

  if (!ampsPrefilled && status && status.amp > 0) {
    setAmps(Math.min(48, Math.max(6, Math.round(status.amp))));
    ampsPrefilled = true;
  }
  renderFreshness();
}

function setBusy(busy) {
  for (const el of [$('pause'), $('resume'), $('amps'), $('apply')]) el.disabled = busy;
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
  $('amps').value = v;
  paintSlider();
}

function paintSlider() {
  const v = Number($('amps').value);
  setText($('amps-out'), `${v} A`);
  $('amps').style.setProperty('--fill', `${((v - 6) / 42) * 100}%`);
}

// ---------- screen lifecycle ----------

export function initStatus() {
  $('pause').addEventListener('click', () => send({ type: 'pause' }));
  $('resume').addEventListener('click', () => send({ type: 'resume' }));
  $('apply').addEventListener('click', () =>
    send({ type: 'set_current', amps: Number($('amps').value) }),
  );
  $('amps').addEventListener('input', paintSlider);
}

export function enterStatus() {
  clearInterval(ticker);
  ticker = setInterval(renderFreshness, 1000);
  paintSlider();
}

export function leaveStatus() {
  clearInterval(ticker);
  clearTimeout(resultTimer);
  ticker = resultTimer = null;
  status = null;
  ampsPrefilled = false;
  shownResultId = null;
  setBusy(false);
  const fb = $('feedback');
  fb.className = 'feedback';
  setText(fb, '');
  $('banner').hidden = true;
}

// ---------- data callbacks ----------

export function showStatus(snap) {
  status = snap && snap.exists() ? snap.data() : null;
  renderStatus();
}

export function showStatusError() {
  status = null;
  renderStatus();
}

export function showCommands(cmds) {
  renderCommands(cmds);
}
