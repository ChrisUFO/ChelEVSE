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
// runtime). Booleans are not numbers, and neither is an empty or whitespace-only
// string (Number('   ') is 0, which would display as a plausible reading).
export function toNumber(value) {
  if (value == null || typeof value === 'boolean') return Number.NaN;
  if (typeof value === 'string' && value.trim() === '') return Number.NaN;
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

// Session-clock helpers. Interpolation is anchored to the local receipt of a
// status write, never to the device's wall clock matching Firestore: the bridge
// stamps `updated_at` with a server timestamp, so a device clock that is behind
// would produce a negative age and freeze the clock. Returns null when elapsed
// is absent or malformed (null, undefined, '', false).
const FRESH_MS = 60000;

function writeMillis(data) {
  const updated = data && data.updated_at;
  return updated && typeof updated.toMillis === 'function' ? updated.toMillis() : null;
}

// Identity of the status write behind a document. The bridge merges schedule
// state into status/current without touching these fields, so a changed key is
// the signal that the charger reported a genuinely new status write.
export function statusWriteKey(data) {
  if (!data) return null;
  return `${writeMillis(data)}|${data.elapsed}|${data.state_label ?? ''}`;
}

// Render one step of a clock. `data` is null when the snapshot must be ignored
// (an older write), which keeps the liveness of the write we already anchored
// to. `floor` is the largest value rendered for this write: the clock is
// monotonic within a session, so the freshness gate closing freezes it instead
// of snapping back to the raw base.
function clockStep(clock, nowMs, data) {
  const age = Math.max(0, nowMs - clock.anchorMs);
  const live =
    data == null
      ? clock.live === true && age <= FRESH_MS
      : data.state_label === 'charging' && data.charger_online !== false && age <= FRESH_MS;
  const ticked = clock.base + (live ? age / 1000 : 0);
  const seconds = Math.max(0, clock.floor, ticked);
  return { clock: { ...clock, live, floor: seconds }, seconds };
}

// Advance the session clock to `nowMs` for a status document. `prev` is the
// clock returned by the previous call (null on first use). The anchor is the
// receipt time, clamped to the document's own write time, and it only moves
// when the write itself changes — so schedule-only merges keep ticking instead
// of rewinding, and a device clock behind the server still advances. The anchor
// never moves backwards for the same session: an older or duplicate write
// arriving late is ignored rather than trusted, while a genuinely new write
// (including a session reset) still re-anchors.
export function elapsedClock(prev, data, nowMs = Date.now()) {
  if (!data) return { clock: null, seconds: null };
  const raw = data.elapsed;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { clock: null, seconds: null };
  const writeMs = writeMillis(data);
  let clock = prev || null;
  if (!clock) {
    clock = { writeMs, base: raw, anchorMs: Math.min(nowMs, writeMs ?? nowMs), floor: raw };
  } else if (writeMs != null && clock.writeMs != null && writeMs < clock.writeMs) {
    // A stale or duplicated write from before the one we anchored to says
    // nothing new: keep that clock (and its state) and re-render it.
    return clockStep(clock, nowMs, null);
  } else if (clock.writeMs !== writeMs) {
    clock = {
      writeMs,
      base: raw,
      // Clamp to the previous anchor so the same session can never rewind.
      anchorMs: Math.max(clock.anchorMs, Math.min(nowMs, writeMs ?? nowMs)),
      floor: raw,
    };
  } else if (raw > clock.base) {
    // The same write reported more elapsed seconds (a document refreshed in
    // place). Move the anchor by the same amount so the displayed value stays
    // continuous instead of counting those seconds twice.
    clock = {
      ...clock,
      base: raw,
      anchorMs: Math.min(clock.anchorMs + (raw - clock.base) * 1000, nowMs),
    };
  }
  return clockStep(clock, nowMs, data);
}

// One-shot form of elapsedClock for a status document at `nowMs`.
export function displayElapsed(data, nowMs = Date.now()) {
  return elapsedClock(null, data, nowMs).seconds;
}

// Freeze the session clock when a stop command is sent: the last snapshot still
// reports charging until the bridge's next write, so interpolating past it would
// overshoot and then snap back. The hold records the status write it froze.
export function freezeClock(seconds, data) {
  return seconds == null ? null : { value: seconds, key: statusWriteKey(data) };
}

// A hold survives snapshots that do not report a new status write (schedule-only
// merges) and is released by a different write or an explicit command failure.
export function holdAfterSnapshot(hold, data) {
  if (hold == null) return null;
  return hold.key === statusWriteKey(data) ? hold : null;
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

// Distinguish "the bridge stopped writing" from "the bridge is fine but the
// charger is unreachable" — both used to render the same banner.
export const STALE_AFTER_MS = 60000;

export function freshnessState({ chargerOnline, ageMs: age, staleAfterMs = STALE_AFTER_MS }) {
  if (!Number.isFinite(age) || age > staleAfterMs) return 'bridge';
  if (chargerOnline === false) return 'charger';
  return null;
}
