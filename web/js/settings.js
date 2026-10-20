// Pure helpers for the app-settings form. No DOM, no Firebase — covered by
// test/web.

import {
  RATE_MAX,
  RATE_MIN,
  normalizeRateSchedule,
  normalizeWindow,
  parseRateValue,
  rateWindowsKey,
  validateRateWindows,
} from './rates.js';

// The rate bounds live in rates.js: the same 0–5 limit governs a flat rate and
// a window row, so both validators share one definition.
export { RATE_MAX, RATE_MIN } from './rates.js';

// Mirror firestore.rules: a write must carry both flat fields, rate is a number
// from 0 to 5, currency is a string of 1–8 characters. The optional `rates`
// list keeps the flat rate as its fallback; its rows are validated by
// validateRateWindows (rules only guard the container).
export const CURRENCY_MAX = 8;

// The form trims the currency, so a stray space cannot produce a string that
// rules would accept but people would read as empty. An absent `rates` list is
// a complete configuration: the flat rate covers every moment.
export function validateSettings(draft) {
  const errors = {};
  const rate = parseRateValue(draft && draft.rate);

  if (!Number.isFinite(rate)) {
    errors.rate = 'Enter a rate between 0 and 5.';
  } else if (rate < RATE_MIN || rate > RATE_MAX) {
    errors.rate = `Rate must be between ${RATE_MIN} and ${RATE_MAX}.`;
  }

  const rawCurrency = draft && draft.currency;
  const currency = typeof rawCurrency === 'string' ? rawCurrency.trim() : '';
  if (!currency) {
    errors.currency = 'Enter a currency, like USD or $.';
  } else if (currency.length > CURRENCY_MAX) {
    errors.currency = `Use ${CURRENCY_MAX} characters or fewer.`;
  }

  // The window list has no visible field yet, but a stored schedule must still
  // be validated (and must not be silently dropped) on every save.
  const windows = validateRateWindows(draft && draft.rates);
  if (!windows.valid) {
    // The editor shows per-row errors once the rate table lands (PR-2); for now
    // the first general problem is the one sentence the card can show.
    errors.rates = windows.errors.general[0] || 'Fix the rate windows before saving.';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    values: { rate, currency, rates: windows.values },
  };
}

// Only the documented shape is adopted from Firestore; anything else leaves the
// form empty for the owner to replace. Unusable rate rows are dropped one at a
// time (see rates.js), so a partially corrupt document still prices what it
// can with the flat fallback.
export function normalizeSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const normalized = normalizeRateSchedule(data);
  if (normalized.rate == null || normalized.currency == null) return null;
  return normalized;
}

// The form's fields. `rates` travels with them even though PR-1 has no rate
// table: a rate/currency edit must not delete the stored schedule.
export function settingsFields(settings) {
  const normalized = normalizeSettings(settings);
  return normalized
    ? { rate: String(normalized.rate), currency: normalized.currency, rates: normalized.rates }
    : { rate: '', currency: '', rates: [] };
}

// The exact Firestore payload for a validated settings save. `rates` is omitted
// when empty, so a flat configuration writes byte-for-byte the two fields it
// always has.
export function settingsPayload(values) {
  const source = values || {};
  const payload = { rate: source.rate, currency: source.currency };
  const rates = Array.isArray(source.rates) ? source.rates : [];
  if (rates.length > 0) {
    payload.rates = rates.map((row) => {
      const window = normalizeWindow(row);
      return {
        id: window.id,
        rate: window.rate,
        days: window.days,
        start: window.start,
        end: window.end,
        months: window.months,
      };
    });
  }
  return payload;
}

// ---------- draft comparison ----------

function parseCurrencyValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The form compares parsed values, never raw strings: a rate typed as "0.250"
// and a currency typed as " USD " are the same settings as the canonical
// rendering, so they must not read as unsaved forever. Two non-numeric drafts
// only match each other when their text is identical. Window rows compare
// through rateWindowsKey so day/month order and numeric text do not matter.
export function sameSettingsInput(a, b) {
  const left = a || {};
  const right = b || {};
  const rateLeft = parseRateValue(left.rate);
  const rateRight = parseRateValue(right.rate);
  const ratesMatch =
    Number.isNaN(rateLeft) || Number.isNaN(rateRight)
      ? String(left.rate ?? '').trim() === String(right.rate ?? '').trim()
      : rateLeft === rateRight;
  return (
    ratesMatch &&
    parseCurrencyValue(left.currency) === parseCurrencyValue(right.currency) &&
    rateWindowsKey(left.rates) === rateWindowsKey(right.rates)
  );
}

// Raw input fields against a stored settings document.
export function settingsDraftMatches(draft, settings) {
  return sameSettingsInput(draft, settingsFields(settings));
}

function settingsEqual(a, b) {
  const left = normalizeSettings(a);
  const right = normalizeSettings(b);
  if (!left || !right) return left === right;
  return (
    left.rate === right.rate &&
    left.currency === right.currency &&
    rateWindowsKey(left.rates) === rateWindowsKey(right.rates)
  );
}

// ---------- save-state machine ----------

export const OFFLINE_MESSAGE = 'You’re offline — reconnect to save.';
export const WAITING_MESSAGE = 'Waiting for the server — this change may not be saved yet.';
export const SAVE_FAILED_MESSAGE =
  'Couldn’t save — the previous settings are back. Check your connection and try again.';
// A first-ever save has no previous document to restore, so the generic copy
// would describe a rollback that never happened.
export const SAVE_FAILED_FIRST_MESSAGE = 'Couldn’t save — try again.';

// The card's whole visible state, derived from the draft and the flags the
// screen owns. `dirty` is computed and returned so the screen never has to keep
// a second, possibly divergent copy.
export function settingsSaveState({
  draft = { rate: '', currency: '', rates: [] },
  confirmed = null,
  saving = false,
  waiting = false,
  saved = false,
  error = '',
} = {}) {
  const dirty = !settingsDraftMatches(draft, confirmed);
  let text = '';
  let kind = '';
  let busy = false;
  if (saving) {
    text = 'Saving…';
    busy = true;
  } else if (waiting) {
    // A refusal raised while an earlier write is still in flight explains more
    // than "waiting" and must stay visible: the offline copy says why this
    // retry did not start. The write itself is still running, so the retry
    // stays available and its late settlement still reconciles the form.
    text = error || WAITING_MESSAGE;
    kind = error ? 'err' : 'warn';
    busy = !error;
  } else if (error) {
    text = error;
    kind = 'err';
  } else if (saved && !dirty) {
    text = 'Saved.';
    kind = 'ok';
  } else if (dirty) {
    text = 'Unsaved changes.';
    kind = 'warn';
  }
  return { dirty, saved: saved && !dirty && !error, text, kind, busy, canSave: dirty && !saving };
}

// Decide the post-settlement form state for one save. `draft` is what is in the
// inputs right now (a late settlement can land after the user typed again),
// `remote` is the snapshot observed while the write was in flight (`remoteSeen`
// distinguishes "none arrived" from "the document is missing").
export function reconcileSettingsSave({
  ok,
  values,
  previous = null,
  draft = { rate: '', currency: '', rates: [] },
  remote = null,
  remoteSeen = false,
} = {}) {
  const rates = Array.isArray(values.rates) ? values.rates : [];
  const attempted = { rate: values.rate, currency: values.currency, rates };
  const untouched = settingsDraftMatches(draft, attempted);
  const draftFields = {
    rate: String(draft.rate ?? ''),
    currency: String(draft.currency ?? ''),
    rates: Array.isArray(draft.rates) ? draft.rates : [],
  };

  if (ok) {
    // The write is confirmed; canonicalise the fields when only formatting
    // differs so the form is not left looking dirty after a successful save.
    let confirmed = attempted;
    let saved = untouched;
    let fields = untouched ? settingsFields(attempted) : draftFields;
    let dirty = !untouched;
    const snapshot = normalizeSettings(remote);
    if (snapshot && !settingsEqual(snapshot, confirmed)) {
      // A genuinely different snapshot arrived while the write was in flight;
      // adopt it rather than leave the form on our optimistic values.
      confirmed = snapshot;
      saved = false;
      // Only an untouched form is hydrated: a draft typed during the save wins.
      if (untouched) {
        fields = settingsFields(snapshot);
        dirty = false;
      }
    }
    return { confirmed, fields, dirty, saved, error: '' };
  }

  // Failure: roll back to the newest known server state — a snapshot that
  // arrived during the write outranks the baseline captured before it.
  const baseline = remoteSeen ? normalizeSettings(remote) : normalizeSettings(previous);
  if (!baseline) {
    // Nothing was ever confirmed (the account has no settings document): there
    // is no previous state to restore. Keep exactly what the user typed, stay
    // dirty, and leave Save available so the attempt can be repeated without
    // retyping both fields.
    return {
      confirmed: null,
      fields: draftFields,
      dirty: !settingsDraftMatches(draftFields, null),
      saved: false,
      error: SAVE_FAILED_FIRST_MESSAGE,
    };
  }
  const dirty = untouched ? false : !settingsDraftMatches(draft, baseline);
  return {
    confirmed: baseline,
    // Only an untouched form (or one whose draft already matches the baseline)
    // is hydrated; a typed draft is never overwritten.
    fields: untouched || !dirty ? settingsFields(baseline) : draftFields,
    dirty,
    saved: false,
    error: SAVE_FAILED_MESSAGE,
  };
}
