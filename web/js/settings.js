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
