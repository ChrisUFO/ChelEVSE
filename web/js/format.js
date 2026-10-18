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

// Compact kWh / kW figures: two decimals under 10, one under 100, none above.
export function fmtK(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

export function relTime(ms) {
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
