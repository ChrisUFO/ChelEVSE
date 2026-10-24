// App-settings validation: the charger-address grammar and the settings
// document's rules, normalization and form fields. Pure helpers — no DOM, no
// Firebase. Covered by test/web.

import {
  RATE_MAX,
  RATE_MIN,
  normalizeRateSchedule,
  normalizeWindow,
  parseRateValue,
  validateRateWindows,
} from '../rates.js';

// Mirror firestore.rules: a write must carry both flat fields, rate is a number
// from 0 to 5, currency is a string of 1–8 characters. The optional `rates`
// list is a season plan; the stored flat rate is used only when no usable row
// remains. Its rows are validated by validateRateWindows (rules only guard the
// container).
export const CURRENCY_MAX = 8;

// The charger address grammar (issue #54), mirrored exactly by the bridge's
// `_normalize_charger_host` (pi/bridge.py) so the app rejects and normalizes the
// same values the running bridge does. `firestore.rules` enforces only the
// coarse part (length, character set, first/last alphanumeric): rules cannot
// split labels or compare octets.
export const CHARGER_HOST_MAX = 253;
export const CHARGER_HOST_LABEL_MAX = 63;
const CHARGER_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const CHARGER_HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const OCTET_RE = /^[0-9]+$/;

// An IPv4 literal or a hostname, or an error that names the failure. Empty
// (after trim) is valid and means unset: the bridge then falls back to its
// `CHARGER_HOST` bootstrap. A scheme, port, path, userinfo and inner whitespace
// are rejected by construction, as are a leading/trailing dot or hyphen, a
// 64-character label, a 254-character address and an octet above 255. Case is
// kept exactly as typed.
export function validateChargerHost(value) {
  // A non-string (a console-written number, say) is not an address. Mirroring the
  // bridge: it rejects a non-string outright rather than stringifying it.
  if (value != null && typeof value !== 'string') {
    return {
      value: '',
      error: 'Enter an IPv4 address or hostname, like 192.168.1.50 or evse.local.',
    };
  }
  const host = (value || '').trim();
  if (!host) return { value: '', error: null };
  const reject = (error) => ({ value: '', error });
  if (host.includes('://')) return reject('Enter just the address — no http:// or https://.');
  if (host.includes('@')) return reject('Enter just the address — no username or password.');
  if (host.includes('/')) return reject('Enter just the address — no path.');
  if (host.includes(':')) return reject('Enter just the address — no port number.');
  if (/\s/.test(host)) return reject('Remove the spaces from the address.');
  if (host.length > CHARGER_HOST_MAX) {
    return reject(`Use ${CHARGER_HOST_MAX} characters or fewer.`);
  }
  if (!CHARGER_HOST_RE.test(host)) {
    if (/^\.|\.$/.test(host)) return reject('The address cannot start or end with a dot.');
    if (/^-|-$/.test(host)) return reject('The address cannot start or end with a hyphen.');
    return reject('Use only letters, numbers, dots and hyphens.');
  }
  const labels = host.split('.');
  for (const label of labels) {
    if (label.length === 0) return reject('Each part of the address must be 1–63 characters.');
    if (label.length > CHARGER_HOST_LABEL_MAX) {
      return reject(
        `Each part of the address must be ${CHARGER_HOST_LABEL_MAX} characters or fewer.`,
      );
    }
    if (!CHARGER_HOST_LABEL_RE.test(label)) {
      return reject('A part of the address cannot start or end with a hyphen.');
    }
  }
  // Four all-numeric labels are an IPv4 literal, so each must be a real octet.
  if (labels.length === 4 && labels.every((label) => OCTET_RE.test(label))) {
    if (labels.some((label) => Number(label) > 255)) {
      return reject('Each part of an IPv4 address must be 0–255.');
    }
  }
  return { value: host, error: null };
}

// The form trims the currency, so a stray space cannot produce a string that
// rules would accept but people would read as empty. An absent `rates` list is
// a complete configuration: the flat rate covers every moment; likewise an
// absent/blank charger address means "use the bridge's bootstrap".
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

  // An empty charger address is a valid (unset) choice, never a blocker: the
  // save then omits the key and the bridge reverts to its bootstrap.
  const host = validateChargerHost(draft && draft.chargerHost);
  if (host.error) errors.chargerHost = host.error;

  // The temperature toggle is a checkbox, so the draft is already boolean;
  // anything else (a form built without the field) reads as the default
  // "visible" and can never block a save.
  const showTemperature = !(draft && draft.showTemperature === false);

  // The rate editor owns the row and document-level rate messages; this
  // validator only reports the flat pair. A stored schedule must still be valid
  // for the document to be saveable (and must never be silently dropped), so its
  // verdict folds into `valid` without a second message channel.
  const windows = validateRateWindows(draft && draft.rates);

  return {
    valid: Object.keys(errors).length === 0 && windows.valid,
    errors,
    values: { rate, currency, rates: windows.values, chargerHost: host.value, showTemperature },
  };
}

// Only the documented shape is adopted from Firestore; anything else leaves the
// form empty for the owner to replace. Every rate row is kept here, invalid
// values included: the editor has to show a malformed stored row with its error
// rather than delete it silently on the next save. The costing layer
// (normalizeRateSchedule) still drops unusable rows, so a partially corrupt
// document prices what it can; the flat rate remains only when no usable row is
// left.
//
// The charger address is optional and never blocks a save: a stored value the
// grammar rejects (a console-written scheme or port, say) normalizes to '' so the
// form stays saveable and the next write replaces it. A valid host is carried
// through so an unrelated rate edit re-sends it instead of deleting it — the
// settings write replaces the whole document.
//
// `show_temperature` is optional the same way, with absent/non-bool meaning
// visible: a corrupt value must not hide the stat nor block a save.
export function normalizeSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const normalized = normalizeRateSchedule(data);
  if (normalized.rate == null || normalized.currency == null) return null;
  const rates = Array.isArray(data.rates) ? data.rates.map(normalizeWindow) : [];
  return {
    rate: normalized.rate,
    currency: normalized.currency,
    rates,
    // Stored shape, like every other key here: normalizeSettings output is fed
    // back into settingsFields (showSettingsData -> setFields), so the key must
    // survive that round trip.
    charger_host: validateChargerHost(data.charger_host).value,
    show_temperature: data.show_temperature !== false,
  };
}

// The form's fields. `rates` travels with them so a rate/currency edit never
// deletes a stored schedule, and the rate table can round-trip rows it does not
// change. `chargerHost` travels the same way: the form always holds the stored
// address, so a rate-only save does not drop it from the whole-document write.
// `showTemperature` rides along identically.
export function settingsFields(settings) {
  const normalized = normalizeSettings(settings);
  return normalized
    ? {
        rate: String(normalized.rate),
        currency: normalized.currency,
        rates: normalized.rates,
        chargerHost: normalized.charger_host,
        showTemperature: normalized.show_temperature,
      }
    : { rate: '', currency: '', rates: [], chargerHost: '', showTemperature: true };
}

// The form before the first settings snapshot is blank apart from whatever the
// owner typed into it, so it carries none of the stored values that a
// whole-document write must re-send. Hydrating it as-is would discard that
// typing; adopting it as-is would delete the stored rate plan and charger
// address. Fill the blanks from the snapshot and keep what the owner typed.
export function firstLoadFields(draft, stored) {
  const fields = settingsFields(stored);
  const kept = (value) => typeof value === 'string' && value.trim() !== '';
  const rows = Array.isArray(draft && draft.rates) ? draft.rates : [];
  // The checkbox's untouched state is checked (visible), so only an explicit
  // off-toggle counts as typing; anything else adopts the stored preference.
  const toggledOff = draft && draft.showTemperature === false;
  // Stored values arrive in the stored shape; a draft row the owner typed is
  // already an editor row. writeFields normalizes both, and rateRowFields maps
  // an editor row to itself, so the mix is inert.
  return {
    rate: kept(draft && draft.rate) ? draft.rate : fields.rate,
    currency: kept(draft && draft.currency) ? draft.currency : fields.currency,
    chargerHost: kept(draft && draft.chargerHost) ? draft.chargerHost : fields.chargerHost,
    showTemperature: toggledOff ? false : fields.showTemperature,
    rates: rows.length ? rows : fields.rates,
  };
}
