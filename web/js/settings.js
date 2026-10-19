// Pure helpers for the app-settings form. No DOM, no Firebase — covered by
// test/web.

// Mirror firestore.rules: a write must carry both fields, rate is a number from
// 0 to 5, currency is a string of 1–8 characters.
export const RATE_MIN = 0;
export const RATE_MAX = 5;
export const CURRENCY_MAX = 8;

// The form trims the currency, so a stray space cannot produce a string that
// rules would accept but people would read as empty.
export function validateSettings(draft) {
  const errors = {};
  const rawRate = draft && draft.rate;
  let rate = Number.NaN;
  if (typeof rawRate === 'number') rate = rawRate;
  else if (typeof rawRate === 'string' && rawRate.trim() !== '') rate = Number(rawRate);

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

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    values: { rate, currency },
  };
}

// Only the documented shape is adopted from Firestore; anything else leaves the
// form empty for the owner to replace.
export function normalizeSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const rate = typeof data.rate === 'number' && Number.isFinite(data.rate) ? data.rate : null;
  const currency = typeof data.currency === 'string' ? data.currency : null;
  if (rate == null || currency == null) return null;
  return { rate, currency };
}

export function settingsFields(settings) {
  const normalized = normalizeSettings(settings);
  return normalized
    ? { rate: String(normalized.rate), currency: normalized.currency }
    : { rate: '', currency: '' };
}

// ---------- draft comparison ----------

// Rate parsing shared by validation and the dirty check: the input is text and
// the stored value is a number, so "0.250" and ".5" must compare by value.
function parseRateValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function parseCurrencyValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The form compares parsed values, never raw strings: a rate typed as "0.250"
// and a currency typed as " USD " are the same settings as the canonical
// rendering, so they must not read as unsaved forever. Two non-numeric drafts
// only match each other when their text is identical.
export function sameSettingsInput(a, b) {
  const left = a || {};
  const right = b || {};
  const rateLeft = parseRateValue(left.rate);
  const rateRight = parseRateValue(right.rate);
  const ratesMatch =
    Number.isNaN(rateLeft) || Number.isNaN(rateRight)
      ? String(left.rate ?? '').trim() === String(right.rate ?? '').trim()
      : rateLeft === rateRight;
  return ratesMatch && parseCurrencyValue(left.currency) === parseCurrencyValue(right.currency);
}

// Raw input fields against a stored settings document.
export function settingsDraftMatches(draft, settings) {
  return sameSettingsInput(draft, settingsFields(settings));
}

function settingsEqual(a, b) {
  const left = normalizeSettings(a);
  const right = normalizeSettings(b);
  if (!left || !right) return left === right;
  return left.rate === right.rate && left.currency === right.currency;
}

// ---------- save-state machine ----------

export const OFFLINE_MESSAGE = 'You’re offline — reconnect to save.';
export const WAITING_MESSAGE = 'Waiting for the server — this change may not be saved yet.';
export const SAVE_FAILED_MESSAGE =
  'Couldn’t save — the previous settings are back. Check your connection and try again.';

// The card's whole visible state, derived from the draft and the flags the
// screen owns. `dirty` is computed and returned so the screen never has to keep
// a second, possibly divergent copy.
export function settingsSaveState({
  draft = { rate: '', currency: '' },
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
    text = WAITING_MESSAGE;
    kind = 'warn';
    busy = true;
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
  draft = { rate: '', currency: '' },
  remote = null,
  remoteSeen = false,
} = {}) {
  const attempted = { rate: values.rate, currency: values.currency };
  const untouched = settingsDraftMatches(draft, attempted);
  const draftFields = { rate: String(draft.rate ?? ''), currency: String(draft.currency ?? '') };

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
