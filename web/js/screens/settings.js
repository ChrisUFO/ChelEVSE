// App-settings card: rate + currency, validated against the same shape as
// firestore.rules. Saves both fields together (rules reject a partial write),
// shows inline field errors and an aria-live result, and reconciles a failed
// write back to the last confirmed server state. The Firestore subscription
// updates the Status/History cost lines as soon as the write echoes back.

import { $, setText } from '../ui.js';
import { normalizeSettings, settingsFields, validateSettings } from '../settings.js';
import { saveSettings as persistSettings } from '../store.js';
import { settleWrite } from '../write.js';

// Last server-confirmed settings and the form state built from them. The draft
// lives in the inputs; saving disables editing so there is no mid-write drift.
let confirmedSettings = null;
let pendingSettings = null;
let settingsDirty = false;
let settingsSaving = false;
let settingsWaiting = false;
let settingsSaved = false;
let settingsError = '';
let settingsGeneration = 0;

const OFFLINE_MESSAGE = 'You’re offline — reconnect to save.';
const WAITING_MESSAGE = 'Waiting for the server — this change may not be saved yet.';

function readFields() {
  return { rate: $('setting-rate').value, currency: $('setting-currency').value };
}

function sameFields(a, b) {
  return a.rate === b.rate && a.currency === b.currency;
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

function paintFeedback() {
  const feedback = $('settings-feedback');
  let text = '';
  let kind = '';
  let busy = false;
  if (settingsSaving) {
    text = 'Saving…';
    busy = true;
  } else if (settingsWaiting) {
    text = WAITING_MESSAGE;
    kind = 'warn';
    busy = true;
  } else if (settingsError) {
    text = settingsError;
    kind = 'err';
  } else if (settingsSaved) {
    text = 'Saved.';
    kind = 'ok';
  } else if (settingsDirty) {
    text = 'Unsaved changes.';
    kind = 'warn';
  }
  feedback.className = `feedback${busy ? ' busy' : ''}${kind ? ` ${kind}` : ''}`;
  setText(feedback, text);

  const save = $('save-settings');
  save.disabled = settingsSaving || !settingsDirty;
  setText(save, settingsSaving ? 'Saving…' : 'Save settings');
  $('settings-form').setAttribute('aria-busy', String(settingsSaving));
  $('setting-rate').disabled = settingsSaving;
  $('setting-currency').disabled = settingsSaving;
}

function setFields(settings) {
  const fields = settingsFields(settings);
  $('setting-rate').value = fields.rate;
  $('setting-currency').value = fields.currency;
}

function recomputeDirty() {
  const fields = readFields();
  settingsDirty = !sameFields(fields, settingsFields(confirmedSettings));
  if (settingsDirty) {
    settingsSaved = false;
    settingsError = '';
  }
  paintFeedback();
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

// settings/current — null means the owner has not saved a rate yet. A remote
// snapshot never overwrites a draft; it only becomes the new confirmed baseline.
export function showSettingsData(data) {
  const next = normalizeSettings(data);
  if (settingsSaving || settingsWaiting) {
    pendingSettings = next;
    return;
  }
  if (settingsDirty) {
    confirmedSettings = next;
    if (sameFields(readFields(), settingsFields(next))) {
      settingsDirty = false;
      settingsSaved = false;
    }
    paintFeedback();
    return;
  }
  // Data-identical echo of our own save: keep "Saved." in place.
  const same = sameFields(readFields(), settingsFields(next));
  confirmedSettings = next;
  if (!same) {
    setFields(next);
    settingsSaved = false;
    settingsError = '';
    renderErrors({});
  }
  settingsDirty = false;
  paintFeedback();
}

// Reconcile a save that has actually settled: adopt on success, roll back to the
// last confirmed snapshot on failure. Runs from the normal path and again from
// the timeout's late callback; the generation guard makes the first one win.
function finishSave(generation, ok, values, previous) {
  if (generation !== settingsGeneration) return;
  settingsSaving = false;
  settingsWaiting = false;
  const remote = pendingSettings;
  pendingSettings = null;
  // A late settlement can land after the user typed again; that draft must not
  // be overwritten by canonicalisation or a rollback.
  const untouched = sameFields(
    readFields(),
    settingsFields({ rate: values.rate, currency: values.currency }),
  );
  if (ok) {
    const saved = { rate: values.rate, currency: values.currency };
    confirmedSettings = saved;
    if (untouched) {
      // Canonicalise the fields so the server echo is data-identical and the
      // "Saved." message is not replaced by a hydration pass.
      setFields(saved);
      settingsDirty = false;
      settingsSaved = true;
    } else {
      settingsDirty = true;
      settingsSaved = false;
    }
    settingsError = '';
    // A genuinely different snapshot arrived while the write was in flight;
    // adopt it rather than leave the form on our optimistic values.
    if (remote && !sameFields(settingsFields(remote), settingsFields(confirmedSettings))) {
      confirmedSettings = remote;
      if (!settingsDirty) setFields(remote);
      settingsSaved = false;
    }
  } else {
    // Optimistic UI reconciles back to the last confirmed server state.
    confirmedSettings = previous;
    if (untouched) {
      setFields(previous);
      settingsDirty = false;
    } else {
      settingsDirty = true;
    }
    settingsSaved = false;
    settingsError =
      'Couldn’t save — the previous settings are back. Check your connection and try again.';
  }
  renderErrors({});
  paintFeedback();
}

async function submit(event) {
  event.preventDefault();
  if (settingsSaving) return;
  const result = validateSettings(readFields());
  renderErrors(result.errors);
  if (!result.valid) {
    settingsSaved = false;
    settingsError = 'Fix the highlighted fields before saving.';
    paintFeedback();
    const first = result.errors.rate ? $('setting-rate') : $('setting-currency');
    first.focus();
    return;
  }

  const generation = ++settingsGeneration;
  const previous = confirmedSettings;
  const values = result.values;
  // Do not hand a write to Firestore while offline: it would queue until the
  // connection returns, leaving the form locked on "Saving…". Keep the draft
  // and ask the user to retry once they are back.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    settingsSaved = false;
    settingsError = OFFLINE_MESSAGE;
    paintFeedback();
    return;
  }
  settingsSaving = true;
  settingsWaiting = false;
  settingsSaved = false;
  settingsError = '';
  pendingSettings = null;
  renderErrors({});
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
    settingsDirty = !sameFields(readFields(), settingsFields(previous));
    paintFeedback();
    return;
  }
  finishSave(generation, outcome.status === 'ok', values, previous);
}

// ---------- screen lifecycle ----------

export function initSettings() {
  $('settings-form').addEventListener('submit', submit);
  $('setting-rate').addEventListener('input', () => handleInput('rate'));
  $('setting-currency').addEventListener('input', () => handleInput('currency'));
  addEventListener('online', () => {
    if (settingsError !== OFFLINE_MESSAGE) return;
    settingsError = '';
    paintFeedback();
  });
  setFields(null);
  renderErrors({});
  paintFeedback();
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
  paintFeedback();
}
