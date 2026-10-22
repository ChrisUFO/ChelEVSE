// Pure formatting helpers — no DOM, no Firebase. Covered by test/web.

// Charger state → label + accent colour (consumed by the status screen and the
// document-level --state custom property).
export const STATES = {
  charging: { label: 'Charging', color: '#38d996' },
  ready: { label: 'Ready', color: '#58a6ff' },
  connected: { label: 'Connected', color: '#46c6d8' },
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

// Bridge write cadences. The write policy planned for #93 keeps status/current
// alive with a 60 s heartbeat while charging and a 300 s heartbeat otherwise;
// the web app widens its staleness tolerance to match BEFORE the bridge adopts
// that cadence, so a deploy-order gap cannot show a false banner. Every age
// threshold below derives from these two numbers — a future cadence change
// edits this block alone.
const CHARGING_HEARTBEAT_MS = 60000;
const IDLE_HEARTBEAT_MS = 300000;
// Charging is the latency-sensitive case: stale at 2.5× its heartbeat (150 s).
export const CHARGING_STALE_AFTER_MS = CHARGING_HEARTBEAT_MS * 2.5;
// Idle only needs a liveness signal: stale at 2× its heartbeat plus a 120 s
// margin (12 min), because an idle charger legitimately writes nothing between
// heartbeats.
export const IDLE_STALE_AFTER_MS = IDLE_HEARTBEAT_MS * 2 + 120000;
// Name kept from the single-threshold era: the charging bound is the tighter of
// the two, so existing imports stay meaningful.
export const STALE_AFTER_MS = CHARGING_STALE_AFTER_MS;

// Session-clock helpers. Interpolation is anchored to the local receipt of a
// status write, never to the device's wall clock matching Firestore: the bridge
// stamps `updated_at` with a server timestamp, so a device clock that is behind
// would produce a negative age and freeze the clock. Returns null when elapsed
// is absent or malformed (null, undefined, '', false).
// The gate matches the charging staleness threshold (derived from the 60 s
// charging heartbeat above): at that cadence the clock must keep interpolating
// between writes instead of freezing for the last portion of every heartbeat.
const FRESH_MS = CHARGING_STALE_AFTER_MS;

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

// A status write that says the charger is charging right now. The bridge derives
// the label from the state code once (STATE_LABELS), so gating on it here keeps
// the session clock and the live cost on one source of truth. A charger the
// bridge has marked offline is not live: its state/elapsed stay frozen while the
// marker refreshes updated_at, so treating that as charging would advance the
// clock (and re-price the live cost) over hours that drew no energy.
export function liveCharging(data) {
  return Boolean(data) && data.state_label === 'charging' && data.charger_online !== false;
}

// Render one step of a clock. `data` is null when the snapshot must be ignored
// (an older write), which keeps the liveness of the write we already anchored
// to. `floor` is the largest value rendered for this write: the clock is
// monotonic within a session, so the freshness gate closing freezes it instead
// of snapping back to the raw base.
function clockStep(clock, nowMs, data) {
  const age = Math.max(0, nowMs - clock.anchorMs);
  const live =
    data == null ? clock.live === true && age <= FRESH_MS : liveCharging(data) && age <= FRESH_MS;
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

// Money is shown with the owner's currency string. A symbol ("$", "€") is
// attached to the amount; a lettered code ("USD", "US cents") gets a space.
// Intl handles decimal rounding (2.945 -> 2.95) and thousands separators.
const MONEY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// A currency that is made of letters is a word ("USD", "US cents") and needs a
// space before the amount, or the two run together. Symbols ("$", "£") attach.
// The 8-character limit on a currency code allows descriptive labels, so this is
// not only the ISO-code case.
function withCurrency(code, amount) {
  return /[A-Za-z]/.test(code) ? `${code} ${amount}` : `${code}${amount}`;
}

export function fmtMoney(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const amount = MONEY.format(Number(value));
  const code = typeof currency === 'string' ? currency.trim() : '';
  if (!code) return amount;
  return withCurrency(code, amount);
}

// Cost for an energy amount at the configured rate. Returns null when either
// input is missing/invalid — callers hide the cost line entirely in that case.
// A per-kWh price keeps the precision a utility bill quotes: five decimals
// (0.15303), so the label must not round it to "0.153". Two decimals stay the
// minimum, so a round price still reads as "0.30" rather than "0.3". The 0–5
// rule is the only bound; money itself stays at two decimals. Same currency
// convention as fmtMoney.
const RATE = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

export function fmtRate(value, currency) {
  // An empty input is "no price yet", not a free rate: Number('') is 0, which
  // used to print USD 0.00 on the first-run path. An explicit 0 still formats.
  if (typeof value === 'string' && value.trim() === '') return '—';
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const amount = RATE.format(Number(value));
  const code = typeof currency === 'string' ? currency.trim() : '';
  if (!code) return amount;
  return withCurrency(code, amount);
}

export function fmtCost(kwh, rate, currency) {
  if (kwh == null || rate == null) return null;
  const energy = Number(kwh);
  const price = Number(rate);
  if (!Number.isFinite(energy) || !Number.isFinite(price)) return null;
  return fmtMoney(energy * price, currency);
}

// Distinguish "the bridge stopped writing" from "the bridge is fine but the
// charger is unreachable" — both used to render the same banner. The age bounds
// come from the cadence block near the top: a charging snapshot is held to the
// 150 s charging threshold, every other online snapshot to the 12 min idle one.
export function freshnessState({ chargerOnline, stateLabel, ageMs: age, staleAfterMs }) {
  // The offline marker needs no age test and outranks every staleness rule:
  // the marker itself refreshes updated_at, and it freezes the last-known
  // state label, so a charging label on an old document must not re-route to
  // an age verdict.
  if (chargerOnline === false) return 'charger';
  // A missing or malformed timestamp says nothing about when the bridge last
  // wrote, so it is bridge-stale immediately, whatever the state says.
  if (!Number.isFinite(age)) return 'bridge';
  // Tests may override the bound; production always derives it from the state.
  const bound =
    staleAfterMs ?? (stateLabel === 'charging' ? CHARGING_STALE_AFTER_MS : IDLE_STALE_AFTER_MS);
  return age > bound ? 'bridge' : null;
}
