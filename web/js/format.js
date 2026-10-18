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
