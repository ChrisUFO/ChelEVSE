// Advanced screen: the RAPI console and its scrollback. The confirmation gate
// is per visit — the first send of each visit asks once, cancel aborts, and
// leaving the tab re-arms it. The scrollback is the realtime RAPI history the
// store subscribes to (type == 'rapi', newest first, 20 entries).

import { $, setText } from '../ui.js';
import { commandMillis, rapiErrorMessage, validateRapi } from '../advanced.js';
import { relTime } from '../format.js';
import { sendCommand } from '../store.js';

const STATUS_LABEL = {
  pending: 'Pending',
  acked: 'Acked',
  failed: 'Failed',
};

let commands = [];
let logLoaded = false;
let logError = '';
let sending = false;
let gateSatisfied = false;
let gateOpen = false;
let gateCommand = '';
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
        meta.append(el('span', 'rapi-sep', ' · '), el('span', 'rapi-result err', reason));
      } else if (command.result != null) {
        meta.append(
          el('span', 'rapi-sep', ' · '),
          el('span', 'rapi-result', formatResult(command.result)),
        );
      }

      item.append(top, meta);
      return item;
    }),
  );
}

function renderGate() {
  const gate = $('rapi-gate');
  gate.hidden = !gateOpen;
  $('rapi-send').setAttribute('aria-expanded', String(gateOpen));
  setText($('rapi-gate-cmd'), gateCommand);
  $('rapi-gate-confirm').disabled = sending;
  $('rapi-gate-cancel').disabled = sending;
}

function setBusy(busy) {
  sending = busy;
  $('rapi-input').disabled = busy;
  $('rapi-send').disabled = busy;
  renderGate();
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

function closeGate({ focusInput = false } = {}) {
  gateOpen = false;
  gateCommand = '';
  renderGate();
  if (focusInput) $('rapi-input').focus({ preventScroll: true });
}

function openGate(command) {
  gateOpen = true;
  gateCommand = command;
  gateSatisfied = false;
  paintFeedback('');
  renderGate();
  $('rapi-gate-confirm').focus({ preventScroll: true });
}

async function sendRapi(command) {
  if (sending) return;
  setBusy(true);
  paintFeedback('Sending…', 'busy');
  let ok = true;
  try {
    await sendCommand({ type: 'rapi', command });
  } catch {
    ok = false;
  }
  setBusy(false);
  if (ok) {
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
  if (sending) return;
  const result = validateRapi($('rapi-input').value);
  paintValidation(result);
  if (!result.valid) {
    $('rapi-input').focus();
    return;
  }
  if (gateOpen) {
    $('rapi-gate-confirm').focus({ preventScroll: true });
    return;
  }
  if (!gateSatisfied) {
    openGate(result.command);
    return;
  }
  sendRapi(result.command);
}

function handleInput() {
  // Editing the command invalidates a preview the user was about to confirm.
  if (gateOpen) closeGate();
  const result = validateRapi($('rapi-input').value);
  if ($('rapi-error').hidden === false) paintValidation(result);
}

function confirmGate() {
  if (!gateOpen || sending) return;
  const command = gateCommand;
  closeGate();
  gateSatisfied = true;
  sendRapi(command);
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
  $('rapi-gate-cancel').addEventListener('click', () => closeGate({ focusInput: true }));
  $('panel-advanced').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !gateOpen || sending) return;
    event.preventDefault();
    closeGate({ focusInput: true });
  });
  renderGate();
  renderLog();
}

// A new visit always starts unconfirmed, even if the previous visit’s send was
// already confirmed. Re-clicking the active tab does not count as an entry.
export function enterAdvanced() {
  gateSatisfied = false;
  if (gateOpen) closeGate();
  paintFeedback('');
  renderGate();
  renderLog();
  startTicker();
}

// Leaving the tab re-arms the gate and drops any pending confirmation.
export function leaveAdvanced() {
  gateSatisfied = false;
  if (gateOpen) closeGate();
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
  sending = false;
  gateSatisfied = false;
  gateOpen = false;
  gateCommand = '';
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
