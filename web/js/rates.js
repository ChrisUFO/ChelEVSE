// Pure rate-schedule helpers: normalization, validation, window matching and
// pro-rated costing. No DOM, no Firebase — covered by test/web/rates.test.js.
//
// The settings document keeps the flat `rate` as the fallback for every moment
// no window covers, so an owner who never adds windows keeps exactly today's
// costs:
//
//   { rate: 0.31, currency: 'USD', rates: [
//     { id: 'w1', rate: 0.12, days: [0, 1, 2, 3, 4], start: '00:00', end: '07:00',
//       months: null },
//   ] }
//
// `days` uses 0 = Sunday … 6 = Saturday, matching Date#getDay(). `months` is
// null (all year) or an inclusive list of 1–12. Windows are matched on the
// local wall clock, so daylight-saving transitions move with the owner's clock
// instead of a fixed UTC offset.

export const RATE_MIN = 0;
export const RATE_MAX = 5;
export const MAX_RATE_WINDOWS = 24;

// ASCII digits only, exactly HH:MM — the same contract as schedule.js.
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ALL_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

// ---------- primitive parsing ----------

// Rate parsing shared by row and flat-rate validation. The stored value is a
// number; a form input is text, so "0.250" must validate the same as 0.25.
export function parseRateValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function parseTime(value) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function toMillis(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value && typeof value.toMillis === 'function') {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value && typeof value.toDate === 'function') return toMillis(value.toDate());
  return null;
}

// ---------- row shape ----------

// The stored row shape is fixed: {id, rate, days, start, end, months}. Values
// are carried through as they are (invalid ones included) so validation can
// flag them instead of silently repairing a document.
export function normalizeWindow(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const months = source.months;
  return {
    id: typeof source.id === 'string' ? source.id : '',
    rate: parseRateValue(source.rate),
    days: Array.isArray(source.days) ? [...source.days] : [],
    start: typeof source.start === 'string' ? source.start : '',
    end: typeof source.end === 'string' ? source.end : '',
    months: months == null ? null : Array.isArray(months) ? [...months] : months,
  };
}

function validateWindow(window) {
  const errors = {};

  if (!window || typeof window.id !== 'string' || window.id.trim() === '') {
    errors.id = 'This window is missing its id.';
  }

  const rate = parseRateValue(window && window.rate);
  if (!Number.isFinite(rate)) {
    errors.rate = `Enter a rate between ${RATE_MIN} and ${RATE_MAX}.`;
  } else if (rate < RATE_MIN || rate > RATE_MAX) {
    errors.rate = `Rate must be between ${RATE_MIN} and ${RATE_MAX}.`;
  }

  const days = window && window.days;
  if (!Array.isArray(days) || days.length === 0) {
    errors.days = 'Pick at least one day.';
  } else if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    errors.days = 'Days must be whole numbers from 0 to 6.';
  } else if (new Set(days).size !== days.length) {
    errors.days = 'Each weekday can only appear once.';
  }

  const start = window && window.start;
  const end = window && window.end;
  if (typeof start !== 'string' || start === '' || typeof end !== 'string' || end === '') {
    errors.start = 'Set a start and end time.';
    errors.end = 'Set a start and end time.';
  } else if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
    errors.start = 'Use 24-hour times like 22:00.';
    errors.end = 'Use 24-hour times like 22:00.';
  }

  const months = window && window.months;
  if (months !== null && months !== undefined) {
    if (!Array.isArray(months) || months.length === 0) {
      errors.months = 'Pick at least one month, or all year.';
    } else if (months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
      errors.months = 'Months must be whole numbers from 1 to 12.';
    } else if (new Set(months).size !== months.length) {
      errors.months = 'Each month can only appear once.';
    }
  }

  return errors;
}

function windowIsValid(window) {
  return Object.keys(validateWindow(window)).length === 0;
}

// ---------- matching ----------

// A window covers the local time-of-day [start, end); `end <= start` wraps
// midnight, and start === end therefore covers the whole day.
function coversTimeOfDay(window, minutes) {
  const start = parseTime(window.start);
  const end = parseTime(window.end);
  if (start == null || end == null) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function windowMatches(window, date) {
  if (!window || !(date instanceof Date) || !Number.isFinite(date.getTime())) return false;
  const days = Array.isArray(window.days) ? window.days : [];
  if (!days.includes(date.getDay())) return false;
  const months = window.months;
  if (months != null && (!Array.isArray(months) || !months.includes(date.getMonth() + 1))) {
    return false;
  }
  return coversTimeOfDay(window, date.getHours() * 60 + date.getMinutes());
}

// A stored document's optional window list. Invalid rows are dropped one at a
// time — a hand-edited or half-written document keeps its usable windows and
// the flat rate still covers every gap. Order is preserved: it only matters as
// the tie-break for overlapping rows an older writer may have stored.
export function normalizeRateSchedule(data) {
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const rate = typeof source.rate === 'number' && Number.isFinite(source.rate) ? source.rate : null;
  const currency = typeof source.currency === 'string' ? source.currency : null;
  const rows = Array.isArray(source.rates) ? source.rates : [];
  return {
    rate,
    currency,
    rates: rows.map(normalizeWindow).filter(windowIsValid),
  };
}

function rateFor(schedule, date) {
  let rate = null;
  // Last matching window wins. Validation rejects overlapping windows, so this
  // only decides between rows stored by an older or hand-edited writer; it
  // keeps matching deterministic instead of depending on the read order.
  for (const window of schedule.rates) {
    if (windowMatches(window, date)) rate = window.rate;
  }
  return rate == null ? schedule.rate : rate;
}

// The rate for one local instant: the last matching window, else the flat rate.
// Returns null when the schedule has neither.
export function rateAt(date, schedule) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return rateFor(normalizeRateSchedule(schedule), date);
}

// ---------- overlap validation ----------

function setsIntersect(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function monthSet(window) {
  const months = window.months;
  return new Set(Array.isArray(months) ? months : ALL_MONTHS);
}

// [start, end) segments on a circular 0…1440 clock. `end <= start` wraps
// midnight; equal endpoints cover the whole day.
function timeSegments(window) {
  const start = parseTime(window.start);
  const end = parseTime(window.end);
  if (start == null || end == null) return [];
  if (start < end) return [[start, end]];
  if (start === end) return [[0, MINUTES_PER_DAY]];
  return [
    [start, MINUTES_PER_DAY],
    [0, end],
  ];
}

// Two windows collide when they can both match one instant: a shared weekday, a
// shared month, and an overlapping time-of-day range. Touching endpoints do not
// overlap (one window ends exactly where the other starts).
export function windowsOverlap(left, right) {
  if (!left || !right) return false;
  if (!setsIntersect(new Set(left.days), new Set(right.days))) return false;
  if (!setsIntersect(monthSet(left), monthSet(right))) return false;
  for (const [leftStart, leftEnd] of timeSegments(left)) {
    for (const [rightStart, rightEnd] of timeSegments(right)) {
      if (leftStart < rightEnd && rightStart < leftEnd) return true;
    }
  }
  return false;
}

// Validate the optional window list. Per-row problems stay attached to their
// row (aligned with `values`) so the editor can paint them inline; container
// and overlap problems are general messages. Absent/null `rates` is valid: the
// flat rate alone is a complete configuration.
export function validateRateWindows(rows) {
  if (rows != null && !Array.isArray(rows)) {
    return {
      valid: false,
      errors: { general: ['Rate windows must be a list.'], rows: [] },
      values: [],
    };
  }
  const list = Array.isArray(rows) ? rows : [];
  const values = list.map(normalizeWindow);
  const rowErrors = values.map(validateWindow);
  const general = [];

  if (values.length > MAX_RATE_WINDOWS) {
    general.push(`A rate schedule can hold at most ${MAX_RATE_WINDOWS} windows.`);
  }
  for (let i = 0; i < values.length; i += 1) {
    if (Object.keys(rowErrors[i]).length > 0) continue;
    for (let j = i + 1; j < values.length; j += 1) {
      if (Object.keys(rowErrors[j]).length > 0) continue;
      if (windowsOverlap(values[i], values[j])) {
        const left = values[i].id || `#${i + 1}`;
        const right = values[j].id || `#${j + 1}`;
        general.push(`Window “${left}” overlaps window “${right}”.`);
      }
    }
  }

  return {
    valid: general.length === 0 && rowErrors.every((errors) => Object.keys(errors).length === 0),
    errors: { general, rows: rowErrors },
    values,
  };
}

// Stable comparison for drafts against stored settings. Day and month order is
// not meaningful; text that parses to the same number is the same value.
export function rateWindowsKey(rows) {
  const list = Array.isArray(rows) ? rows.map(normalizeWindow) : [];
  const sorted = (values) =>
    Array.isArray(values) ? [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : [];
  return JSON.stringify(
    list.map((window) => ({
      id: window.id,
      rate: Number.isFinite(window.rate) ? window.rate : String(window.rate),
      days: sorted(window.days),
      start: window.start,
      end: window.end,
      months: Array.isArray(window.months) ? sorted(window.months) : window.months,
    })),
  );
}

// ---------- costing ----------

// A local wall-clock instant on the local day `reference` falls on. Local Date
// constructors keep DST transitions in the owner's clock: a boundary inside the
// spring-forward gap lands on the first instant that exists, and a fall-back
// boundary is built once (the repeated hour is therefore priced as part of the
// surrounding slice).
function localBoundary(reference, minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    hours,
    mins,
  ).getTime();
}

// Every local midnight and every window start/end inside the interval. Without
// the midnights a month, weekday or season change would never split a slice.
function intervalBoundaries(startMs, endMs, schedule) {
  const times = [];
  for (const window of schedule.rates) {
    for (const value of [window.start, window.end]) {
      const minutes = parseTime(value);
      if (minutes != null) times.push(minutes);
    }
  }
  const firstDay = new Date(startMs);
  firstDay.setHours(0, 0, 0, 0);
  const lastDay = new Date(endMs);
  lastDay.setHours(0, 0, 0, 0);
  const dayCount = Math.round((lastDay.getTime() - firstDay.getTime()) / MS_PER_DAY) + 1;

  const boundaries = new Set([startMs, endMs]);
  for (let i = 0; i < dayCount; i += 1) {
    const day = new Date(firstDay);
    day.setDate(firstDay.getDate() + i);
    boundaries.add(new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime());
    for (const minutes of times) boundaries.add(localBoundary(day, minutes));
  }
  return [...boundaries].filter((ms) => ms >= startMs && ms <= endMs).sort((a, b) => a - b);
}

// Cost for an energy amount over one interval.
//
// Sessions store only `wh` plus their endpoints, so the energy an interval used
// is assumed to have been drawn at a constant power: each slice between rate
// boundaries gets `wh × slice duration / interval duration`. This is an
// approximation (a charger that ramps or pauses inside a slice is mispriced by
// no more than the rate difference across that slice), and it is documented
// because the stored data cannot do better.
//
// Returns null when the interval or rate information is unusable — callers hide
// the cost line instead of showing a made-up number.
export function costForInterval(wh, start, end, schedule) {
  if (typeof wh === 'boolean' || wh == null) return null;
  if (typeof wh === 'string' && wh.trim() === '') return null;
  const energy = Number(wh);
  const startMs = toMillis(start);
  const endMs = toMillis(end);
  if (!Number.isFinite(energy) || energy < 0) return null;
  if (startMs == null || endMs == null || endMs <= startMs) return null;

  const normalized = normalizeRateSchedule(schedule);
  const boundaries = intervalBoundaries(startMs, endMs, normalized);
  const duration = endMs - startMs;
  let cost = 0;
  for (let i = 1; i < boundaries.length; i += 1) {
    const from = boundaries[i - 1];
    const to = boundaries[i];
    if (to <= from) continue;
    const rate = rateFor(normalized, new Date(from));
    // A slice no window covers needs the flat fallback; without one the cost is
    // unknown for that part of the interval.
    if (rate == null) return null;
    cost += ((energy * (to - from)) / duration / 1000) * rate;
  }
  return cost;
}

// A session document from `sessions`: {wh, started_at, ended_at, ...}.
export function costForSession(session, schedule) {
  if (!session || typeof session !== 'object') return null;
  return costForInterval(session.wh, session.started_at, session.ended_at, schedule);
}
