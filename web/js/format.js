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

// Session duration as HH:MM:SS. Hours are not capped (a long session keeps
// counting) and invalid/negative input clamps to zero.
export function formatElapsed(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}

// Currency formatting for the rate/cost lines. Settings allow any 1–8 char
// currency string, so an unknown code falls back to a plain "CODE 1.23".
export function formatMoney(amount, currency = 'USD', locale = undefined) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';
  const raw = String(currency || 'USD');
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: raw.toUpperCase(),
    }).format(value);
  } catch {
    return `${raw} ${value.toFixed(2)}`;
  }
}

// Cost is hidden until a rate is saved (null rate); a saved rate of 0 is a
// real value and formats as zero.
export function formatCost(kwh, rate, currency = 'USD', locale = undefined) {
  if (rate == null || rate === '' || !Number.isFinite(Number(rate))) return null;
  if (kwh == null || !Number.isFinite(Number(kwh))) return null;
  return formatMoney(Number(kwh) * Number(rate), currency, locale);
}
