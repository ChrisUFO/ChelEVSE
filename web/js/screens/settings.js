// App-settings card: fallback rate, currency and the optional rate schedule.
// The flat pair is validated against the same shape as firestore.rules; the
// schedule rows are validated by the pure helpers in settings.js/rates.js.
// Everything is saved as one document (rules reject a partial write), shows
// inline field errors plus an aria-live result, and reconciles a failed write
// back to the last confirmed server state. The Firestore subscription updates
// the Status/History cost lines as soon as the write echoes back.

import { $, setText } from '../ui.js';
import {
  MONTH_NAMES,
  OFFLINE_MESSAGE,
  defaultRateRow,
  normalizeSettings,
  rateRowFields,
  rateWindowSummary,
  reconcileSettingsSave,
  settingsDraftMatches,
  settingsFields,
  settingsSaveState,
  validateRateEditorRows,
  validateSettings,
} from '../settings.js';
import { DAY_NAMES } from '../schedule.js';
import { MAX_RATE_WINDOWS, monthsToRange, rangeToMonths } from '../rates.js';
import { saveSettings as persistSettings } from '../store.js';
import { settleWrite } from '../write.js';

// Last server-confirmed settings and the form state built from them. The flat
// fields live in their inputs; the rate rows live in `draftRates`, with the
// rendered controls in `rateCards`. Saving disables editing so there is no
// mid-write drift.
let confirmedSettings = null;
// A snapshot that arrived while a write was in flight. The wrapper keeps "no
// snapshot arrived" distinct from "the document is missing".
let pendingSettings = null;
let settingsDirty = false;
let settingsSaving = false;
let settingsWaiting = false;
let settingsSaved = false;
let settingsError = '';
let settingsGeneration = 0;
// The rate table's draft rows in the editable shape from rateRowFields().
let draftRates = [];
let rateCards = [];
let rateValidation = validateRateEditorRows([]);

function readFields() {
  return {
    rate: $('setting-rate').value,
    currency: $('setting-currency').value,
    rates: draftRates,
  };
}

function paintFieldError(field, message) {
  const input = $(`setting-${field}`);
  const node = $(`${field}-error`);
  input.setAttribute('aria-invalid', String(Boolean(message)));
  node.hidden = !message;
  setText(node, message);
}

function renderErrors(errors = {}) {
  for (const field of ['rate', 'currency']) paintFieldError(field, errors[field] || '');
}

// The row that owns a field described by `errors`, in paint order.
function firstRateError() {
  return rateCards.find((card) => Object.keys(rateValidation.rows[card.index] || {}).length > 0);
}

function revealCard(card) {
  card.node.scrollIntoView({
    block: 'center',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function focusFirstRateError() {
  const card = firstRateError();
  if (!card) {
    // A document-level problem (an overlap, or more rows than the cap) has no
    // field of its own. The rows it accuses are marked invalid and carry their
    // note, and focus moves to the first of them; the document sentence is the
    // only explanation, so it — not the focused row — is what the viewport
    // shows. Scrolling the row to centre used to push that sentence off-screen.
    const index = rateValidation.overlaps.length > 0 ? rateValidation.overlaps[0][0] : 0;
    const fallback = rateCards[index];
    if (fallback) fallback.rateInput.focus({ preventScroll: true });
    const docError = $('rates-error');
    if (!docError.hidden) docError.scrollIntoView({ block: 'center', behavior: 'auto' });
    else if (fallback) revealCard(fallback);
    return;
  }
  const errors = rateValidation.rows[card.index] || {};
  if (errors.rate) card.rateInput.focus({ preventScroll: true });
  else if (errors.days) {
    const day =
      card.daysEl.querySelector('.day[aria-pressed="true"]') || card.daysEl.querySelector('.day');
    if (day) day.focus({ preventScroll: true });
  } else if (errors.start) card.startInput.focus({ preventScroll: true });
  else if (errors.end) card.endInput.focus({ preventScroll: true });
  else if (errors.months) {
    // The range controls are only visible when "All year" is off.
    const target = card.allYearInput.checked ? card.allYearInput : card.fromSelect;
    target.focus({ preventScroll: true });
  } else card.rateInput.focus({ preventScroll: true });
  revealCard(card);
}

function paintRateValidation() {
  // An overlap is a document-level problem, but the user fixes it on two rows:
  // give each member of a colliding pair its own note so the card that is
  // marked invalid also carries the reason.
  const overlapNotes = new Map();
  for (const [a, b] of rateValidation.overlaps) {
    if (!overlapNotes.has(a)) overlapNotes.set(a, []);
    if (!overlapNotes.has(b)) overlapNotes.set(b, []);
    overlapNotes.get(a).push(`Overlaps Rate ${b + 1}`);
    overlapNotes.get(b).push(`Overlaps Rate ${a + 1}`);
  }
  rateCards.forEach((card) => {
    const errors = rateValidation.rows[card.index] || {};
    const notes = overlapNotes.get(card.index) || [];
    const messages = [...new Set([...Object.values(errors), ...notes])];
    card.errorEl.hidden = messages.length === 0;
    setText(card.errorEl, messages.join(' '));
    card.rateInput.setAttribute('aria-invalid', String(Boolean(errors.rate)));
    card.daysEl.setAttribute('aria-invalid', String(Boolean(errors.days)));
    card.daysEl.classList.toggle('invalid', Boolean(errors.days));
    card.startInput.setAttribute('aria-invalid', String(Boolean(errors.start)));
    card.endInput.setAttribute('aria-invalid', String(Boolean(errors.end)));
    card.fromSelect.setAttribute('aria-invalid', String(Boolean(errors.months)));
    card.toSelect.setAttribute('aria-invalid', String(Boolean(errors.months)));
    card.node.classList.toggle('invalid', messages.length > 0);
    card.node.setAttribute('aria-invalid', String(messages.length > 0));
    if (notes.length > 0) {
      // The row points at the document sentence that names every pair; the row
      // note in `errorEl` is the short reason beside the fields.
      card.node.setAttribute('aria-describedby', 'rates-error');
      card.rateInput.setAttribute('aria-invalid', 'true');
      card.rateInput.setAttribute('aria-describedby', `${card.errorId} rates-error`);
    } else {
      card.node.removeAttribute('aria-describedby');
      card.rateInput.setAttribute('aria-describedby', card.errorId);
    }
  });
  const general = rateValidation.general.join(' ');
  const docError = $('rates-error');
  docError.hidden = !general;
  setText(docError, general);
  $('rates-count').textContent = `${draftRates.length} of ${MAX_RATE_WINDOWS}`;
  $('rates-empty').hidden = draftRates.length > 0;
}

function paintFeedback() {
  const feedback = $('settings-feedback');
  const view = settingsSaveState({
    draft: readFields(),
    confirmed: confirmedSettings,
    saving: settingsSaving,
    waiting: settingsWaiting,
    saved: settingsSaved,
    error: settingsError,
  });
  // The value comparison is the only dirty rule; keep the flag in step.
  settingsDirty = view.dirty;
  feedback.className = `feedback${view.busy ? ' busy' : ''}${view.kind ? ` ${view.kind}` : ''}`;
  setText(feedback, view.text);

  const save = $('save-settings');
  save.disabled = !view.canSave;
  setText(save, settingsSaving ? 'Saving…' : 'Save settings');
  $('settings-form').setAttribute('aria-busy', String(settingsSaving));
  $('setting-rate').disabled = settingsSaving;
  $('setting-currency').disabled = settingsSaving;
  for (const node of $('rate-list').querySelectorAll('input, button, select'))
    node.disabled = settingsSaving;
  $('add-rate').disabled = settingsSaving || draftRates.length >= MAX_RATE_WINDOWS;
}

// Repaint everything derived from the draft.
function refresh() {
  rateValidation = validateRateEditorRows(draftRates);
  paintRateValidation();
  paintFeedback();
}

function writeFields(fields) {
  $('setting-rate').value = fields.rate;
  $('setting-currency').value = fields.currency;
  draftRates = (Array.isArray(fields.rates) ? fields.rates : []).map(rateRowFields);
  renderRates();
}

function setFields(settings) {
  writeFields(settingsFields(settings));
}

function recomputeDirty() {
  settingsDirty = !settingsDraftMatches(readFields(), confirmedSettings);
  if (settingsDirty) {
    settingsSaved = false;
    settingsError = '';
  }
  refresh();
}

function handleInput(field) {
  recomputeDirty();
  // Keep a shown error live: correcting the field clears it immediately, and a
  // still-invalid value keeps its explanation.
  if ($(`${field}-error`).hidden === false) {
    const result = validateSettings(readFields());
    paintFieldError(field, result.errors[field] || '');
  }
}

// ---------- rate table ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function updateRateSummary(card) {
  setText(card.summary, rateWindowSummary(card.row));
}

function markRateEdited(card) {
  updateRateSummary(card);
  // Recompute before clearing: an edit that returns the row to the confirmed
  // schedule must not discard a save failure the form still describes.
  if (!settingsDraftMatches(readFields(), confirmedSettings)) {
    settingsSaved = false;
    settingsError = '';
  }
  refresh();
}

function dayChip(card, day, row, index) {
  const button = el('button', 'day', DAY_NAMES[day]);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(row.days.includes(day)));
  button.setAttribute('aria-label', `${DAY_NAMES[day]} for rate window ${index + 1}`);
  button.setAttribute('aria-describedby', card.errorId);
  button.addEventListener('click', () => {
    if (row.days.includes(day)) row.days = row.days.filter((value) => value !== day);
    else row.days = [...row.days, day].sort((a, b) => a - b);
    button.setAttribute('aria-pressed', String(row.days.includes(day)));
    markRateEdited(card);
  });
  return button;
}

function monthSelect(card, index, which) {
  const select = el('select', 'month-select');
  const label = which === 'from' ? 'From' : 'To';
  select.setAttribute('aria-label', `${label} month for rate window ${index + 1}`);
  select.setAttribute('aria-describedby', card.errorId);
  select.append(new Option('Month', ''));
  MONTH_NAMES.forEach((name, month) => select.append(new Option(name, String(month + 1))));
  return select;
}

function createRateRow(row, index) {
  const node = el('article', 'rate-window');
  node.dataset.id = row.id;
  const errorId = `rate-window-error-${index}`;
  const card = {
    row,
    index,
    node,
    errorId,
    summary: null,
    rateInput: null,
    daysEl: null,
    startInput: null,
    endInput: null,
    allYearInput: null,
    fromSelect: null,
    toSelect: null,
    errorEl: null,
  };

  const head = el('div', 'rate-window-head');
  const heading = el('div', 'rate-window-title');
  heading.append(el('h4', 'rate-title', `Rate ${index + 1}`));
  card.summary = el('p', 'rate-summary');
  heading.append(card.summary);
  const remove = el('button', 'rate-remove', 'Remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove rate window ${index + 1}`);
  remove.addEventListener('click', () => {
    draftRates = draftRates.filter((value) => value !== row);
    renderRates();
    // Focus Add, never another row's Remove: a held or repeated Enter on a
    // destructive control would otherwise delete window after window with no
    // undo. Mirrors the schedule editor's remove handler.
    $('add-rate').focus({ preventScroll: true });
  });
  head.append(heading, remove);

  const rateWrap = el('div', 'input-wrap');
  const rateInput = el('input', 'text-input rate-input');
  rateInput.type = 'number';
  rateInput.min = '0';
  rateInput.max = '5';
  rateInput.step = '0.001';
  rateInput.inputMode = 'decimal';
  rateInput.placeholder = '0.000';
  rateInput.autocomplete = 'off';
  rateInput.value = row.rate;
  rateInput.setAttribute('aria-label', `Rate for window ${index + 1}`);
  rateInput.setAttribute('aria-describedby', errorId);
  const suffix = el('span', 'input-suffix', '/ kWh');
  suffix.setAttribute('aria-hidden', 'true');
  rateWrap.append(rateInput, suffix);
  const rateField = el('label', 'field rate-amount');
  rateField.append(el('span', 'field-label', 'Rate'), rateWrap);
  rateInput.addEventListener('input', () => {
    row.rate = rateInput.value;
    markRateEdited(card);
  });
  card.rateInput = rateInput;

  const days = el('div', 'days');
  days.setAttribute('role', 'group');
  days.setAttribute('aria-label', `Days for rate window ${index + 1}`);
  days.setAttribute('aria-describedby', errorId);
  DAY_NAMES.forEach((_, day) => days.append(dayChip(card, day, row, index)));
  card.daysEl = days;

  const times = el('div', 'time-row');
  const startInput = el('input');
  startInput.type = 'time';
  startInput.value = row.start;
  startInput.setAttribute('aria-label', `Start time for rate window ${index + 1}`);
  startInput.setAttribute('aria-describedby', errorId);
  const startField = el('label', 'field');
  startField.append(el('span', 'field-label', 'Start'), startInput);
  const endInput = el('input');
  endInput.type = 'time';
  endInput.value = row.end;
  endInput.setAttribute('aria-label', `End time for rate window ${index + 1}`);
  endInput.setAttribute('aria-describedby', errorId);
  const endField = el('label', 'field');
  endField.append(el('span', 'field-label', 'End'), endInput);
  const sep = el('span', 'time-sep', '→');
  sep.setAttribute('aria-hidden', 'true');
  times.append(startField, sep, endField);
  const onTime = () => {
    row.start = startInput.value;
    row.end = endInput.value;
    markRateEdited(card);
  };
  startInput.addEventListener('input', onTime);
  endInput.addEventListener('input', onTime);
  card.startInput = startInput;
  card.endInput = endInput;

  const months = el('div', 'months-row');
  const toggle = el('label', 'months-toggle');
  const allYear = el('input');
  allYear.type = 'checkbox';
  allYear.id = `rate-${index}-all-year`;
  allYear.checked = row.months == null;
  allYear.setAttribute('aria-label', `All year for rate window ${index + 1}`);
  allYear.setAttribute('aria-describedby', errorId);
  toggle.append(allYear, el('span', null, 'All year'));
  card.allYearInput = allYear;

  const range = el('div', 'month-range');
  const fromSelect = monthSelect(card, index, 'from');
  const toSelect = monthSelect(card, index, 'to');
  const fromField = el('label', 'field');
  fromField.append(el('span', 'field-label', 'From'), fromSelect);
  const toField = el('label', 'field');
  toField.append(el('span', 'field-label', 'To'), toSelect);
  const rangeSep = el('span', 'time-sep', '→');
  rangeSep.setAttribute('aria-hidden', 'true');
  range.append(fromField, rangeSep, toField);
  months.append(toggle, range);
  card.fromSelect = fromSelect;
  card.toSelect = toSelect;

  const syncMonths = () => {
    range.hidden = row.months == null;
    const span = Array.isArray(row.months) ? monthsToRange(row.months) : null;
    fromSelect.value = span ? String(span.from) : '';
    toSelect.value = span ? String(span.to) : '';
  };

  // A user pick is not normalised back into the selects: the pair the owner
  // chose stays on screen even when it covers every month (November → October
  // is all year, but it is not January → December). Choosing one side alone
  // mirrors it into the other, so the row is always one readable range.
  const applyMonthRange = () => {
    let from = fromSelect.value ? Number(fromSelect.value) : null;
    let to = toSelect.value ? Number(toSelect.value) : null;
    if (from && !to) {
      to = from;
      toSelect.value = String(to);
    } else if (!from && to) {
      from = to;
      fromSelect.value = String(from);
    }
    row.months = from && to ? rangeToMonths(from, to) : [];
    range.hidden = false;
    markRateEdited(card);
  };
  fromSelect.addEventListener('change', applyMonthRange);
  toSelect.addEventListener('change', applyMonthRange);

  allYear.addEventListener('change', () => {
    if (allYear.checked) {
      row.months = null;
    } else {
      // The checkbox has no stored range to restore: start at the current month
      // as a single-month window the owner can widen.
      const span = row.months == null ? null : monthsToRange(row.months);
      const current = new Date().getMonth() + 1;
      row.months = rangeToMonths(span ? span.from : current, span ? span.to : current);
    }
    syncMonths();
    markRateEdited(card);
  });

  const errorEl = el('p', 'rule-error rate-error');
  errorEl.id = errorId;
  errorEl.hidden = true;
  card.errorEl = errorEl;

  node.append(head, rateField, days, times, months, errorEl);
  updateRateSummary(card);
  syncMonths();
  return card;
}

function renderRates() {
  const list = $('rate-list');
  list.replaceChildren();
  rateCards = draftRates.map((row, index) => {
    const card = createRateRow(row, index);
    list.append(card.node);
    return card;
  });
  refresh();
}

// ---------- save-state machine ----------

// settings/current — null means the owner has not saved a rate yet. A remote
// snapshot never overwrites a draft; it only becomes the new confirmed baseline.
export function showSettingsData(data) {
  const next = normalizeSettings(data);
  if (settingsSaving || settingsWaiting) {
    pendingSettings = { settings: next };
    return;
  }
  // "Typed" is the value comparison against the baseline we are replacing.
  const typed = !settingsDraftMatches(readFields(), confirmedSettings);
  confirmedSettings = next;
  if (!typed && !settingsDraftMatches(readFields(), next)) {
    setFields(next);
    // A failed-save message stays until the user acts: a snapshot echoing the
    // server truth does not undo the attempt the message describes.
    settingsSaved = false;
    renderErrors({});
  }
  paintFeedback();
}

// Reconcile a save that has actually settled: adopt on success, roll back to the
// last confirmed snapshot on failure. Runs from the normal path and again from
// the timeout's late callback; the generation guard makes the first one win.
function finishSave(generation, ok, values, previous) {
  if (generation !== settingsGeneration) return;
  settingsSaving = false;
  settingsWaiting = false;
  const pending = pendingSettings;
  pendingSettings = null;
  const next = reconcileSettingsSave({
    ok,
    values,
    previous,
    draft: readFields(),
    remote: pending ? pending.settings : null,
    remoteSeen: pending !== null,
  });
  confirmedSettings = next.confirmed;
  writeFields(next.fields);
  settingsDirty = next.dirty;
  settingsSaved = next.saved;
  settingsError = next.error;
  renderErrors({});
  refresh();
}

async function submit(event) {
  event.preventDefault();
  if (settingsSaving) return;
  // A valid save is the shared document validation plus the table's own rule
  // (the month controls can only author one range). Both must pass, and both
  // paint their errors, so nothing blocks the save without saying why.
  const result = validateSettings(readFields());
  rateValidation = validateRateEditorRows(draftRates);
  paintRateValidation();
  renderErrors(result.errors);
  if (!result.valid || !rateValidation.valid) {
    settingsSaved = false;
    settingsError = 'Fix the highlighted fields before saving.';
    paintFeedback();
    if (result.errors.rate) $('setting-rate').focus();
    else if (result.errors.currency) $('setting-currency').focus();
    else focusFirstRateError();
    return;
  }

  const previous = confirmedSettings;
  const values = result.values;
  // Do not hand a write to Firestore while offline: it would queue until the
  // connection returns, leaving the form locked on "Saving…". Keep the draft
  // and ask the user to retry once they are back.
  //
  // This refusal happens before the generation bump on purpose: a write that
  // already timed out is still running, and a retry that starts no replacement
  // write must not revoke that write's ownership of its late settlement. The
  // form keeps saying why the retry did not start until the real outcome lands.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    settingsSaved = false;
    settingsError = OFFLINE_MESSAGE;
    paintFeedback();
    return;
  }
  const generation = ++settingsGeneration;
  settingsSaving = true;
  settingsWaiting = false;
  settingsSaved = false;
  settingsError = '';
  pendingSettings = null;
  renderErrors({});
  refresh();
  paintFeedback();

  const outcome = await settleWrite(persistSettings(values), {
    onLate: (late) => finishSave(generation, late.status === 'ok', values, previous),
  });
  if (generation !== settingsGeneration) return;
  if (outcome.status === 'timeout') {
    // The browser says online but the backend has not answered. Re-enable the
    // form with an explicit "may not be saved yet" state; the write keeps
    // running and its real outcome reconciles above.
    settingsSaving = false;
    settingsWaiting = true;
    settingsSaved = false;
    settingsError = '';
    // The value is still unconfirmed, so the form stays dirty and Save remains
    // available as a retry.
    settingsDirty = !settingsDraftMatches(readFields(), previous);
    refresh();
    return;
  }
  finishSave(generation, outcome.status === 'ok', values, previous);
}

// ---------- screen lifecycle ----------

export function initSettings() {
  $('settings-form').addEventListener('submit', submit);
  $('setting-rate').addEventListener('input', () => handleInput('rate'));
  $('setting-currency').addEventListener('input', () => handleInput('currency'));
  $('add-rate').addEventListener('click', () => {
    if (settingsSaving || draftRates.length >= MAX_RATE_WINDOWS) return;
    draftRates = [...draftRates, defaultRateRow(crypto.randomUUID())];
    renderRates();
    const last = rateCards[rateCards.length - 1];
    if (!last) return;
    last.node.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    last.rateInput.focus({ preventScroll: true });
  });
  addEventListener('online', () => {
    if (settingsError !== OFFLINE_MESSAGE) return;
    settingsError = '';
    paintFeedback();
  });
  setFields(null);
  renderErrors({});
  refresh();
}

export function resetSettings() {
  settingsGeneration += 1;
  confirmedSettings = null;
  pendingSettings = null;
  settingsDirty = false;
  settingsSaving = false;
  settingsWaiting = false;
  settingsSaved = false;
  settingsError = '';
  if (!$('settings-form')) return;
  setFields(null);
  renderErrors({});
  $('settings-form').setAttribute('aria-busy', 'false');
  refresh();
}
