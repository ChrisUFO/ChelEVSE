// Schedule editor: a draft separate from the last confirmed snapshot, a pure
// validator, and an optimistic save that rolls back on failure. Incoming
// snapshots never replace unsaved edits.

import { $, setText } from '../ui.js';
import { saveSchedule } from '../store.js';
import {
  DAY_NAMES,
  MAX_AMPS,
  MAX_RULES,
  MIN_AMPS,
  defaultRule,
  defaultSchedule,
  normalizeSchedule,
  scheduleKey,
  validateSchedule,
} from '../schedule.js';

// Keep focus/scroll from jumping when a snapshot arrives for an untouched form.
let active = false;
let initialized = false;
let loadError = false;
let confirmed = defaultSchedule();
let draft = defaultSchedule();
let dirty = false;
let saving = false;
let savingPayloadKey = null;
// Latest snapshot received while the form is dirty or a save is in flight.
// It never clobbers the draft; save settle decides whether to adopt it.
let pendingRemote = null;
let remoteNotice = false;
let validation = validateSchedule(defaultSchedule());
let feedbackMode = 'derived'; // derived | saved | save-error | load-error
let feedbackError = '';
let live = { inWindow: false, activeRuleId: null };
let cards = [];
let generation = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clone(schedule) {
  return normalizeSchedule(schedule);
}

function markDirty() {
  dirty = scheduleKey(draft) !== scheduleKey(confirmed);
  if (!dirty) {
    // A remote change queued while we were editing becomes the truth once the
    // draft no longer differs from the last confirmed snapshot.
    if (pendingRemote) {
      adopt(pendingRemote);
      return;
    }
    remoteNotice = false;
  }
  feedbackMode = 'derived';
  validateAndPaint();
}

function renderRemoteNotice() {
  const notice = $('schedule-remote-notice');
  if (notice) notice.hidden = !remoteNotice;
}

function renderFeedback() {
  const fb = $('schedule-feedback');
  let text = '';
  let kind = '';
  let busy = false;
  if (feedbackMode === 'save-error') {
    text = feedbackError;
    kind = 'err';
  } else if (feedbackMode === 'load-error' || loadError) {
    text = "Couldn't load the schedule. Reload the page to try again.";
    kind = 'err';
  } else if (feedbackMode === 'saved') {
    text = 'Saved.';
    kind = 'ok';
  } else if (saving) {
    text = 'Saving…';
    busy = true;
  } else if (!validation.valid) {
    text = 'Fix the highlighted fields before saving.';
  } else if (dirty) {
    text = 'Unsaved changes.';
    kind = 'warn';
  }
  fb.className = `feedback${busy ? ' busy' : ''}${kind ? ` ${kind}` : ''}`;
  setText(fb, text);
}

function syncControls() {
  const locked = !initialized || loadError || saving;
  const editor = $('schedule-editor');
  $('panel-schedule').setAttribute('aria-busy', String(saving));
  for (const node of editor.querySelectorAll('input, button')) node.disabled = locked;
  if (locked) return;
  $('add-rule').disabled = draft.rules.length >= MAX_RULES;
  $('save-schedule').disabled = !dirty || !validation.valid;
}

function validateAndPaint() {
  validation = validateSchedule(draft);
  cards.forEach((card, index) => {
    const errors = validation.ruleErrors[index] || {};
    const messages = [...new Set(Object.values(errors))];
    card.errorEl.hidden = messages.length === 0;
    setText(card.errorEl, messages.join(' '));
    card.startInput.setAttribute('aria-invalid', String(Boolean(errors.start)));
    card.endInput.setAttribute('aria-invalid', String(Boolean(errors.end)));
    card.ampsInput.setAttribute('aria-invalid', String(Boolean(errors.amps)));
    card.stepper.classList.toggle('invalid', Boolean(errors.amps));
    card.daysEl.setAttribute('aria-invalid', String(Boolean(errors.days)));
    card.daysEl.classList.toggle('invalid', Boolean(errors.days));
    card.node.classList.toggle('invalid', messages.length > 0);
  });
  const docError = validation.errors.rules || validation.errors.enabled || '';
  $('schedule-doc-error').hidden = !docError;
  setText($('schedule-doc-error'), docError);
  $('schedule-count').textContent = `${draft.rules.length} of ${MAX_RULES}`;
  setText($('save-schedule'), saving ? 'Saving…' : 'Save schedule');
  syncControls();
  renderFeedback();
  renderRemoteNotice();
  renderLive();
}

function dayChip(rule, day, index) {
  const button = el('button', 'day', DAY_NAMES[day]);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(rule.days.includes(day)));
  button.setAttribute('aria-label', `${DAY_NAMES[day]} for window ${index + 1}`);
  button.addEventListener('click', () => {
    if (rule.days.includes(day)) rule.days = rule.days.filter((d) => d !== day);
    else rule.days = [...rule.days, day].sort((a, b) => a - b);
    button.setAttribute('aria-pressed', String(rule.days.includes(day)));
    markDirty();
  });
  return button;
}

function createCard(rule, index) {
  const node = el('article', 'rule-card');
  node.dataset.id = rule.id;
  const errorId = `rule-error-${index}`;

  const head = el('div', 'rule-head');
  head.append(el('h3', 'rule-title', `Window ${index + 1}`), el('span', 'rule-live', 'Active now'));
  const remove = el('button', 'rule-remove', 'Remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove window ${index + 1}`);
  remove.addEventListener('click', () => {
    draft.rules = draft.rules.filter((r) => r !== rule);
    markDirty();
    renderRules();
    $('add-rule').focus({ preventScroll: true });
  });
  head.append(remove);

  const days = el('div', 'days');
  days.setAttribute('role', 'group');
  days.setAttribute('aria-label', `Days for window ${index + 1}`);
  days.setAttribute('aria-describedby', errorId);
  DAY_NAMES.forEach((_, day) => days.append(dayChip(rule, day, index)));

  const times = el('div', 'time-row');
  const startInput = el('input');
  startInput.type = 'time';
  startInput.value = rule.start;
  startInput.setAttribute('aria-describedby', errorId);
  const startField = el('label', 'field');
  startField.append(el('span', 'field-label', 'Start'), startInput);
  const endInput = el('input');
  endInput.type = 'time';
  endInput.value = rule.end;
  endInput.setAttribute('aria-describedby', errorId);
  const endField = el('label', 'field');
  endField.append(el('span', 'field-label', 'End'), endInput);
  const sep = el('span', 'time-sep', '→');
  sep.setAttribute('aria-hidden', 'true');
  times.append(startField, sep, endField);
  const onTime = () => {
    rule.start = startInput.value;
    rule.end = endInput.value;
    markDirty();
  };
  startInput.addEventListener('input', onTime);
  endInput.addEventListener('input', onTime);

  const ampsRow = el('div', 'amps-row');
  const ampsInput = el('input', 'amps-input');
  ampsInput.type = 'number';
  ampsInput.min = String(MIN_AMPS);
  ampsInput.max = String(MAX_AMPS);
  ampsInput.step = '1';
  ampsInput.inputMode = 'numeric';
  ampsInput.value = Number.isFinite(rule.amps) ? String(rule.amps) : '';
  ampsInput.setAttribute('aria-label', `Current for window ${index + 1}`);
  ampsInput.setAttribute('aria-describedby', errorId);
  const step = (delta) => {
    const base = Number.isFinite(rule.amps) ? rule.amps : 32;
    rule.amps = Math.min(MAX_AMPS, Math.max(MIN_AMPS, Math.round(base) + delta));
    ampsInput.value = String(rule.amps);
    markDirty();
  };
  const minus = el('button', 'step', '−');
  minus.type = 'button';
  minus.setAttribute('aria-label', `Decrease current for window ${index + 1}`);
  minus.addEventListener('click', () => step(-1));
  const plus = el('button', 'step', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', `Increase current for window ${index + 1}`);
  plus.addEventListener('click', () => step(1));
  ampsInput.addEventListener('input', () => {
    rule.amps = ampsInput.value === '' ? Number.NaN : Number(ampsInput.value);
    markDirty();
  });
  const stepper = el('div', 'stepper');
  stepper.append(minus, ampsInput, el('span', 'stepper-unit', 'A'), plus);
  ampsRow.append(el('span', 'field-label', 'Current'), stepper);

  const errorEl = el('p', 'rule-error');
  errorEl.id = errorId;
  errorEl.hidden = true;

  node.append(head, days, times, ampsRow, errorEl);
  return { rule, node, daysEl: days, startInput, endInput, ampsInput, stepper, errorEl };
}

function renderRules() {
  const list = $('rule-list');
  list.replaceChildren();
  cards = draft.rules.map((rule, index) => {
    const card = createCard(rule, index);
    list.append(card.node);
    return card;
  });
  $('schedule-empty').hidden = draft.rules.length > 0;
  $('schedule-count').textContent = `${draft.rules.length} of ${MAX_RULES}`;
  validateAndPaint();
}

function renderLive() {
  const wrap = $('schedule-live');
  if (!wrap) return;
  wrap.hidden = !live.inWindow || !initialized;
  // Resolve the banner from the last server snapshot, never the draft: a
  // changed start time is not the charger's active window until Save lands.
  const rule = live.activeRuleId
    ? confirmed.rules.find((r) => r && r.id === live.activeRuleId)
    : null;
  setText(
    $('schedule-live-text'),
    rule ? `Window active now · ${rule.start}–${rule.end}` : 'Window active now',
  );
  for (const card of cards) {
    const isActive = Boolean(live.inWindow && live.activeRuleId === card.rule.id);
    card.node.classList.toggle('active', isActive);
    card.node.querySelector('.rule-live').hidden = !isActive;
  }
}

function renderToggle() {
  const toggle = $('schedule-enabled');
  toggle.checked = draft.enabled;
  setText(
    $('schedule-enabled-sub'),
    draft.enabled ? 'Charging follows these windows.' : 'Charging is not restricted by a schedule.',
  );
}

function renderLoading() {
  $('schedule-loading').hidden = loadError;
  $('schedule-load-error').hidden = !loadError;
  $('schedule-editor').hidden = !initialized;
  $('schedule-live').hidden = true;
  renderRemoteNotice();
  if (loadError) {
    setText($('schedule-feedback'), "Couldn't load the schedule. Reload the page to try again.");
    $('schedule-feedback').className = 'feedback err';
  }
}

function renderAll() {
  $('schedule-loading').hidden = initialized || loadError;
  $('schedule-load-error').hidden = !loadError;
  $('schedule-editor').hidden = !initialized;
  if (!initialized) {
    setText($('schedule-feedback'), '');
    $('schedule-feedback').className = 'feedback';
    renderRemoteNotice();
    return;
  }
  renderToggle();
  renderRules();
  renderLive();
}

function adopt(schedule) {
  // clone() normalizes the editable shape and drops server metadata such as
  // timestamps, so snapshots and local payloads share one representation.
  confirmed = clone(schedule);
  draft = clone(confirmed);
  dirty = false;
  pendingRemote = null;
  remoteNotice = false;
  initialized = true;
  loadError = false;
  feedbackMode = 'derived';
  renderAll();
}

async function save() {
  if (saving || loadError || !validation.valid || !dirty || !initialized) return;
  saving = true;
  feedbackMode = 'derived';
  validateAndPaint();
  const gen = generation;
  const payload = {
    enabled: draft.enabled,
    rules: draft.rules.map((rule) => ({
      id: rule.id,
      days: rule.days,
      start: rule.start,
      end: rule.end,
      amps: rule.amps,
    })),
  };
  savingPayloadKey = scheduleKey(payload);
  try {
    await saveSchedule(payload);
    if (gen !== generation) return;
    // A snapshot that arrived while saving is at least as new as this write
    // (the client stream is ordered); otherwise our payload is the baseline.
    const next = pendingRemote ?? payload;
    confirmed = clone(next);
    draft = clone(confirmed);
    dirty = false;
    pendingRemote = null;
    remoteNotice = false;
    saving = false;
    savingPayloadKey = null;
    feedbackMode = 'saved';
    renderAll();
  } catch {
    if (gen !== generation) return;
    // Never present a rollback that hides a concurrent external change.
    const rollback = pendingRemote ?? confirmed;
    const hadRemote = Boolean(pendingRemote);
    confirmed = clone(rollback);
    draft = clone(confirmed);
    dirty = false;
    pendingRemote = null;
    remoteNotice = false;
    saving = false;
    savingPayloadKey = null;
    feedbackMode = 'save-error';
    feedbackError = hadRemote
      ? "Couldn't save. The latest server schedule was restored."
      : "Couldn't save. The previous schedule was restored.";
    renderAll();
    $('schedule-feedback').focus({ preventScroll: true });
  }
}

// ---------- screen lifecycle ----------

export function initSchedule() {
  $('schedule-enabled').addEventListener('change', () => {
    draft.enabled = $('schedule-enabled').checked;
    markDirty();
    setText(
      $('schedule-enabled-sub'),
      draft.enabled
        ? 'Charging follows these windows.'
        : 'Charging is not restricted by a schedule.',
    );
  });
  $('add-rule').addEventListener('click', () => {
    if (draft.rules.length >= MAX_RULES) return;
    draft.rules.push(defaultRule(crypto.randomUUID()));
    markDirty();
    renderRules();
    const last = cards[cards.length - 1];
    if (last) {
      last.node.scrollIntoView({
        block: 'center',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      const firstDay = last.daysEl.querySelector('.day');
      if (firstDay) firstDay.focus({ preventScroll: true });
    }
  });
  $('save-schedule').addEventListener('click', save);
  renderAll();
}

export function enterSchedule() {
  active = true;
}

export function activateSchedule() {
  if (!active) return;
  renderLive();
}

// schedule/current — first snapshot adopts; later ones never clobber edits.
export function showSchedule(data) {
  if (!active) return;
  const incoming = clone(data);
  if (!initialized) {
    adopt(incoming);
    return;
  }
  if (saving) {
    // Queue the latest snapshot (including the local write echo). Save settle
    // decides whether it becomes the confirmed baseline; the draft is untouched.
    pendingRemote = incoming;
    remoteNotice = savingPayloadKey ? scheduleKey(incoming) !== savingPayloadKey : false;
    validateAndPaint();
    return;
  }
  if (dirty) {
    if (scheduleKey(incoming) === scheduleKey(confirmed)) {
      // The server is still on the snapshot we based the draft on.
      pendingRemote = null;
      remoteNotice = false;
    } else {
      pendingRemote = incoming;
      remoteNotice = true;
    }
    validateAndPaint();
    return;
  }
  if (scheduleKey(incoming) === scheduleKey(confirmed)) {
    // Data-identical echo: refresh the normalized baseline without rebuilding
    // the form, and keep "Saved." in place.
    confirmed = incoming;
    if (pendingRemote || remoteNotice) {
      pendingRemote = null;
      remoteNotice = false;
      renderRemoteNotice();
    }
    return;
  }
  // Clean form and a genuinely new server state: adopt it (and clear "Saved.").
  adopt(incoming);
}

export function showScheduleError() {
  if (!active) return;
  loadError = true;
  if (!initialized) {
    renderLoading();
  } else {
    feedbackMode = 'load-error';
    renderAll();
  }
}

// status/current — the charger's own live window report.
export function showLiveStatus(data) {
  if (!active) return;
  const info = data && data.schedule;
  live = {
    inWindow: Boolean(info && info.in_window === true),
    activeRuleId: info && typeof info.active_rule_id === 'string' ? info.active_rule_id : null,
  };
  renderLive();
}

export function resetSchedule() {
  generation += 1;
  active = false;
  initialized = false;
  loadError = false;
  confirmed = defaultSchedule();
  draft = defaultSchedule();
  dirty = false;
  saving = false;
  savingPayloadKey = null;
  pendingRemote = null;
  remoteNotice = false;
  validation = validateSchedule(defaultSchedule());
  feedbackMode = 'derived';
  feedbackError = '';
  live = { inWindow: false, activeRuleId: null };
  cards = [];
  if ($('rule-list')) {
    $('panel-schedule').setAttribute('aria-busy', 'false');
    $('rule-list').replaceChildren();
    $('schedule-empty').hidden = false;
    $('schedule-count').textContent = `0 of ${MAX_RULES}`;
    $('schedule-doc-error').hidden = true;
    $('schedule-feedback').className = 'feedback';
    setText($('schedule-feedback'), '');
    $('schedule-live').hidden = true;
    $('schedule-editor').hidden = true;
    $('schedule-loading').hidden = false;
    $('schedule-load-error').hidden = true;
    renderRemoteNotice();
    setText($('schedule-enabled-sub'), 'Charging is not restricted by a schedule.');
    $('schedule-enabled').checked = false;
  }
}
