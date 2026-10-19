// Pure formatting helpers — no DOM, no Firebase. Covered by test/web.

// Charger state → label + accent colour (consumed by the status screen and the
// document-level --state custom property).
export const STATES = {
  charging: { label: 'Charging', color: '#38d996' },
  ready: { label: 'Ready', color: '#58a6ff' },
  connected: { label: 'Connected', color: '#e0b45c' },
  sleeping: { label: 'Sleeping', color: '#93a0b4' },
  disabled: { label: 'Disabled', color: '#f26d5f' },
  unknown: { label: 'Unknown', color: '#98a1b0' },
};

export function stateFor(label) {
  return STATES[label] || STATES.unknown;
}

// Coerce a possibly-string numeric field (Firestore documents are untyped at
// runtime). Booleans are not numbers, and neither is an empty string.
export function toNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return Number.NaN;
  return Number(value);
}

// Rounded display value for status/session figures, or the em dash when the
// field is absent or malformed.
export function numOrDash(value, digits = 0) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  return digits ? n.toFixed(digits) : String(Math.round(n));
}

// Compact kWh / kW figures: two decimals under 10, one under 100, none above.
export function fmtK(v) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return '—';
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

export function relTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// Session clock: always HH:MM:SS, with hours allowed to grow past two digits.
export function formatElapsed(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

// Session-clock value for a status document at `nowMs`. Interpolation is
// anchored to the document's own write time, not to snapshot receipt: schedule
// merges can deliver a status snapshot whose elapsed is unchanged, and
// re-anchoring on receipt would rewind the clock. Returns null when the field
// is absent or malformed (null, undefined, '', false).
const FRESH_MS = 60000;

export function displayElapsed(data, nowMs = Date.now()) {
  if (!data) return null;
  const raw = data.elapsed;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const updated = data.updated_at;
  const writtenAt = updated && typeof updated.toMillis === 'function' ? updated.toMillis() : null;
  const age = writtenAt == null ? null : nowMs - writtenAt;
  const live =
    data.state_label === 'charging' &&
    data.charger_online !== false &&
    age != null &&
    age >= 0 &&
    age <= FRESH_MS;
  const anchor = writtenAt ?? nowMs;
  return Math.max(0, raw + (live ? Math.max(0, (nowMs - anchor) / 1000) : 0));
}

// Session duration in h:mm (the bridge stores seconds).
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

// Money is shown with the owner's currency string. Short strings are treated
// as symbols ("$", "€") and attached; longer ones as codes ("USD 1.23").
// Intl handles decimal rounding (2.945 -> 2.95) and thousands separators.
const MONEY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmtMoney(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const amount = MONEY.format(Number(value));
  const code = typeof currency === 'string' ? currency.trim() : '';
  if (!code) return amount;
  return /^[A-Za-z]{2,}$/.test(code) ? `${code} ${amount}` : `${code}${amount}`;
}

// Cost for an energy amount at the configured rate. Returns null when either
// input is missing/invalid — callers hide the cost line entirely in that case.
export function fmtCost(kwh, rate, currency) {
  if (kwh == null || rate == null) return null;
  const energy = Number(kwh);
  const price = Number(rate);
  if (!Number.isFinite(energy) || !Number.isFinite(price)) return null;
  return fmtMoney(energy * price, currency);
}
