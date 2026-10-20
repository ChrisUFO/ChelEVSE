// Pure helpers for the app-settings form. No DOM, no Firebase — covered by
// test/web.

import {
  MAX_RATE_WINDOWS,
  RATE_MAX,
  RATE_MIN,
  monthsToRange,
  normalizeRateSchedule,
  normalizeWindow,
  overlappingWindowPairs,
  parseRateValue,
  rateWindowsKey,
  validateRateWindows,
} from './rates.js';
import { DAY_NAMES } from './schedule.js';

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

  // The rate editor owns the row and document-level rate messages; this
  // validator only reports the flat pair. A stored schedule must still be valid
  // for the document to be saveable (and must never be silently dropped), so its
  // verdict folds into `valid` without a second message channel.
  const windows = validateRateWindows(draft && draft.rates);

  return {
    valid: Object.keys(errors).length === 0 && windows.valid,
    errors,
    values: { rate, currency, rates: windows.values },
  };
}

// Only the documented shape is adopted from Firestore; anything else leaves the
// form empty for the owner to replace. Every rate row is kept here, invalid
// values included: the editor has to show a malformed stored row with its error
// rather than delete it silently on the next save. The costing layer
// (normalizeRateSchedule) still drops unusable rows, so a partially corrupt
// document prices what it can with the flat fallback.
export function normalizeSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const normalized = normalizeRateSchedule(data);
  if (normalized.rate == null || normalized.currency == null) return null;
  const rates = Array.isArray(data.rates) ? data.rates.map(normalizeWindow) : [];
  return { rate: normalized.rate, currency: normalized.currency, rates };
}

// The form's fields. `rates` travels with them so a rate/currency edit never
// deletes a stored schedule, and the rate table can round-trip rows it does not
// change.
export function settingsFields(settings) {
  const normalized = normalizeSettings(settings);
  return normalized
    ? { rate: String(normalized.rate), currency: normalized.currency, rates: normalized.rates }
    : { rate: '', currency: '', rates: [] };
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTH_SHORT = MONTH_NAMES.map((name) => name.slice(0, 3));

// One rate-table row as the form holds it: the rate is text because it feeds a
// number input, and every other field keeps the stored value (invalid ones too)
// so validation can point at it.
export function rateRowFields(raw) {
  const window = normalizeWindow(raw);
  return {
    id: window.id,
    rate: Number.isFinite(window.rate) ? String(window.rate) : '',
    days: window.days,
    start: window.start,
    end: window.end,
    months: Array.isArray(window.months) ? [...window.months] : window.months,
  };
}

// A fresh row starts on a typical overnight tariff with no price filled in: a
// made-up rate would be easy to save by accident, so the empty field keeps the
// row visibly incomplete until the owner enters their own.
export function defaultRateRow(id) {
  return { id, rate: '', days: [0, 1, 2, 3, 4], start: '00:00', end: '07:00', months: null };
}

// The rate table's validation: the shared window validator plus the one rule
// the stored shape does not have — the month controls can only express one
// inclusive range, so a hand-edited list such as January + June is flagged here
// instead of being quietly rewritten into a range on save.
export function validateRateEditorRows(rows) {
  const base = validateRateWindows(rows);
  const list = Array.isArray(rows) ? rows : [];
  const rowErrors = base.errors.rows.map((errors) => ({ ...errors }));
  list.forEach((row, index) => {
    if (!rowErrors[index] || rowErrors[index].months) return;
    const months = row && row.months;
    if (months != null && monthsToRange(months) == null) {
      rowErrors[index].months = 'Choose one month range (From and To), or all year.';
    }
  });
  const overlaps = overlappingWindowPairs(list);
  const general = [];
  if (list.length > MAX_RATE_WINDOWS) {
    general.push(`A rate schedule can hold at most ${MAX_RATE_WINDOWS} windows.`);
  }
  if (overlaps.length > 0) general.push(rateOverlapMessage(overlaps));
  const valid = rowErrors.every((errors) => Object.keys(errors).length === 0);
  return { valid: valid && general.length === 0, general, rows: rowErrors, overlaps };
}

// One document-level sentence for every colliding pair of rows (positions).
export function rateOverlapMessage(pairs) {
  const labels = pairs.map(([a, b]) => `${a + 1} and ${b + 1}`).join(', ');
  return `Rate windows ${labels} overlap. Change their days, months, or times so no moment has two rates.`;
}

// A short line under a row's title, so a stack of tall rows stays scannable.
// Invalid values stay visible in the controls and their error line; this only
// summarises the row.
export function rateWindowSummary(row) {
  const source = row || {};
  const days = Array.isArray(source.days) ? [...new Set(source.days)].sort((a, b) => a - b) : [];
  let dayText;
  if (days.length === 0) {
    dayText = 'No days';
  } else if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    // Checked before the shorthand labels: seven values that include one outside
    // 0–6 are not every day, and the summary must not claim coverage the row
    // does not have.
    dayText = 'Invalid days';
  } else if (days.length === 7) {
    dayText = 'Every day';
  } else if (days.length === 5 && days.every((day, index) => day === index)) {
    dayText = 'Weekdays';
  } else if (days.length === 2 && days[0] === 5 && days[1] === 6) {
    dayText = 'Weekends';
  } else {
    dayText = days.map((day) => DAY_NAMES[day]).join(', ');
  }

  const start = typeof source.start === 'string' ? source.start : '';
  const end = typeof source.end === 'string' ? source.end : '';
  const timed =
    /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(start) && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(end);
  let timeText;
  if (!start || !end) timeText = 'Times not set';
  else if (!timed) timeText = `${start}–${end}`;
  else if (start === end) timeText = 'All day';
  else if (end < start) timeText = `${start}–${end} next day`;
  else timeText = `${start}–${end}`;

  const months = source.months;
  let monthText;
  if (months == null) {
    monthText = 'All year';
  } else {
    const range = monthsToRange(months);
    monthText = range
      ? range.from === range.to
        ? MONTH_SHORT[range.from - 1]
        : `${MONTH_SHORT[range.from - 1]}–${MONTH_SHORT[range.to - 1]}`
      : 'Custom months';
  }
  return `${dayText} · ${timeText} · ${monthText}`;
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
