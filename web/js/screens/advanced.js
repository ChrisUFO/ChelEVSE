// Advanced screen: the RAPI console and its scrollback. The confirmation gate
// is per visit — the first send of each visit asks once, cancel aborts, and
// leaving the tab re-arms it. The scrollback is the realtime RAPI history the
// store subscribes to (type == 'rapi', newest first, 20 entries).

import { $, setText } from '../ui.js';
import {
  GATE_INITIAL,
  commandMillis,
  gateTransition,
  rapiErrorMessage,
  validateRapi,
} from '../advanced.js';
import { relTime } from '../format.js';
import { sendCommand } from '../store.js';
import { settleWrite } from '../write.js';

const STATUS_LABEL = {
  pending: 'Pending',
  acked: 'Acked',
  failed: 'Failed',
};

let commands = [];
let logLoaded = false;
let logError = '';
let sendGeneration = 0;
let gate = { ...GATE_INITIAL };
let ticker = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatResult(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderLog() {
  const state = $('rapi-log-state');
  const list = $('rapi-log');

  if (logError) {
    state.hidden = false;
    state.className = 'section-state err';
    setText(state, logError);
    list.hidden = true;
    list.replaceChildren();
    return;
  }
  if (!logLoaded) {
    state.hidden = false;
    state.className = 'section-state';
    setText(state, 'Loading recent commands…');
    list.hidden = true;
    list.replaceChildren();
    return;
  }
  if (!commands.length) {
    state.hidden = false;
    state.className = 'section-state';
    setText(state, 'No commands sent yet. Recent RAPI commands will appear here.');
    list.hidden = true;
    list.replaceChildren();
    return;
  }

  state.hidden = true;
  list.hidden = false;
  list.replaceChildren(
    ...commands.map((command) => {
      const status = typeof command.status === 'string' ? command.status : '';
      const item = el('li', 'rapi-item');
      item.dataset.status = status;
      const top = el('div', 'rapi-item-top');
      const code = el(
        'code',
        'rapi-cmd',
        typeof command.command === 'string' ? command.command : '(missing command)',
      );
      // The row keeps the command and the chip on one line; a long command is
      // truncated. Expose the whole one as the tooltip, and make the code
      // focusable so keyboard and touch users can expand it by Tab/tap
      // instead of needing a mouse hover (see .rapi-cmd:focus).
      code.tabIndex = 0;
      if (typeof command.command === 'string') code.title = command.command;
      const chip = el(
        'span',
        `chip${Object.hasOwn(STATUS_LABEL, status) ? ` ${status}` : ''}`,
        STATUS_LABEL[status] || status || 'Unknown',
      );
      top.append(code, chip);

      const when = commandMillis(command.created_at);
      const meta = el('p', 'rapi-meta');
      meta.append(el('span', 'rapi-time', when == null ? '—' : relTime(Date.now() - when)));

      if (status === 'failed') {
        const reason =
          typeof command.error === 'string' && command.error
            ? command.error
            : 'The charger did not apply this command.';
        meta.append(el('span', 'rapi-result err', reason));
      } else if (command.result != null) {
        // The separator is part of the result text (CSS ::before) so it can
        // never be left dangling at the end of a wrapped line on its own.
        meta.append(el('span', 'rapi-result', formatResult(command.result)));
      }

      item.append(top, meta);
      return item;
    }),
  );
}

function applyGate(event) {
  const step = gateTransition(gate, event);
  gate = step.state;
  renderGate();
  return step;
}

function renderGate() {
  const node = $('rapi-gate');
  node.hidden = !gate.open;
  $('rapi-send').setAttribute('aria-expanded', String(gate.open));
  setText($('rapi-gate-cmd'), gate.command);
  $('rapi-gate-confirm').disabled = gate.sending;
  $('rapi-gate-cancel').disabled = gate.sending;
}

function setBusy(busy) {
  $('rapi-input').disabled = busy;
  $('rapi-send').disabled = busy;
  applyGate({ type: 'sending', value: busy });
}

function paintFeedback(text, kind = '') {
  const feedback = $('rapi-feedback');
  feedback.className = `feedback${kind ? ` ${kind}` : ''}`;
  setText(feedback, text);
}

function paintValidation(result) {
  const input = $('rapi-input');
  const error = $('rapi-error');
  input.setAttribute('aria-invalid', String(!result.valid));
  error.hidden = result.valid;
  setText(error, result.valid ? '' : result.error);
}

function cancelGate({ focusInput = false } = {}) {
  applyGate({ type: 'cancel' });
  if (focusInput) $('rapi-input').focus({ preventScroll: true });
}

// A settled or late write paints the same outcome the normal path does; the
// generation guard drops the report when a newer send has taken over.
function reconcileSend(generation, command, late) {
  if (generation !== sendGeneration) return;
  if (late.status === 'ok') {
    paintFeedback('Command queued for the charger.', 'ok');
    return;
  }
  paintFeedback('Couldn’t send — check your connection and try again.', 'err');
  // The queued command never reached the server; keep it for a retry unless the
  // user has already typed something else.
  const input = $('rapi-input');
  if (!$('rapi-input').disabled && !input.value) input.value = command;
}

async function sendRapi(command) {
  if (gate.sending) return;
  const generation = ++sendGeneration;
  setBusy(true);
  paintFeedback('Sending…', 'busy');
  const outcome = await settleWrite(sendCommand({ type: 'rapi', command }), {
    onLate: (late) => reconcileSend(generation, command, late),
  });
  if (generation !== sendGeneration) return;
  setBusy(false);
  if (outcome.status === 'timeout') {
    // Online as far as the browser knows, but the backend has not answered. Tell
    // the operator the command is queued and may not be saved yet; if it settles
    // later it appears in the scrollback (or reports the failure) on its own.
    $('rapi-input').value = '';
    paintValidation({ valid: true });
    paintFeedback('Waiting for the server — the command is queued but may not arrive yet.', 'warn');
  } else if (outcome.status === 'ok') {
    $('rapi-input').value = '';
    paintValidation({ valid: true });
    paintFeedback('Command queued for the charger.', 'ok');
  } else {
    paintFeedback('Couldn’t send — check your connection and try again.', 'err');
  }
  $('rapi-input').focus({ preventScroll: true });
}

function handleSubmit(event) {
  event.preventDefault();
  if (gate.sending) return;
  const result = validateRapi($('rapi-input').value);
  paintValidation(result);
  if (!result.valid) {
    $('rapi-input').focus();
    return;
  }
  const step = applyGate({ type: 'submit', command: result.command });
  if (step.action === 'gate') {
    paintFeedback('');
  }
  if (step.action === 'gate' || step.action === 'confirm') {
    $('rapi-gate-confirm').focus({ preventScroll: true });
    return;
  }
  if (step.action === 'send') sendRapi(step.command);
}

function handleInput() {
  // Editing the command invalidates a preview the user was about to confirm.
  if (gate.open) applyGate({ type: 'edit' });
  const result = validateRapi($('rapi-input').value);
  if ($('rapi-error').hidden === false) paintValidation(result);
}

function confirmGate() {
  const step = applyGate({ type: 'confirm' });
  if (step.action !== 'send') return;
  // Confirming hides the gate that contained the focused button. Hand focus to
  // the live status before the form goes busy, so it never falls to <body>
  // while the command is pending; sendRapi restores the input on settlement.
  $('rapi-feedback').focus({ preventScroll: true });
  sendRapi(step.command);
}

function startTicker() {
  stopTicker();
  // Relative timestamps and the pending chip age in the background.
  ticker = setInterval(renderLog, 30000);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

// ---------- screen lifecycle ----------

export function initAdvanced() {
  $('rapi-form').addEventListener('submit', handleSubmit);
  $('rapi-input').addEventListener('input', handleInput);
  $('rapi-gate-confirm').addEventListener('click', confirmGate);
  $('rapi-gate-cancel').addEventListener('click', () => cancelGate({ focusInput: true }));
  $('panel-advanced').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !gate.open || gate.sending) return;
    event.preventDefault();
    cancelGate({ focusInput: true });
  });
  renderGate();
  renderLog();
}

// A new visit always starts unconfirmed, even if the previous visit’s send was
// already confirmed. Re-clicking the active tab does not count as an entry.
export function enterAdvanced() {
  applyGate({ type: 'enter' });
  // A command that is still being written owns the feedback line: re-entering
  // the tab during the send must keep explaining why the form is disabled,
  // instead of showing an inert form until the write settles.
  if (gate.sending) paintFeedback('Sending…', 'busy');
  else paintFeedback('');
  renderLog();
  startTicker();
}

// Leaving the tab re-arms the gate and drops any pending confirmation.
export function leaveAdvanced() {
  applyGate({ type: 'leave' });
  stopTicker();
}

export function showRapiCommands(data) {
  commands = Array.isArray(data) ? data : [];
  logLoaded = true;
  logError = '';
  renderLog();
}

export function showRapiError(err) {
  logLoaded = true;
  logError = rapiErrorMessage(err);
  renderLog();
}

export function resetAdvanced() {
  commands = [];
  logLoaded = false;
  logError = '';
  sendGeneration += 1;
  gate = { ...GATE_INITIAL };
  stopTicker();
  if (!$('rapi-input')) return;
  $('rapi-input').value = '';
  $('rapi-input').disabled = false;
  $('rapi-input').setAttribute('aria-invalid', 'false');
  $('rapi-send').disabled = false;
  $('rapi-send').setAttribute('aria-expanded', 'false');
  $('rapi-error').hidden = true;
  setText($('rapi-error'), '');
  paintFeedback('');
  renderGate();
  renderLog();
}
