// Pure rate-schedule helpers: normalization, validation, window matching and
// pro-rated costing. No DOM, no Firebase — covered by test/web/rates.test.js.
//
// The settings document keeps a flat `rate` for One rate. A non-empty `rates`
// list is a season plan: the all-day, every-day row is a base, day-restricted
// rows are overrides, and an unmatched instant costs 0. The stored flat rate is
// ignored while that list has usable rows:
//
//   { rate: 0.31, currency: 'USD', rates: [
//     { id: 'base', rate: 0.30, days: [0,1,2,3,4,5,6], start: '00:00',
//       end: '00:00', months: null },
//     { id: 'night', rate: 0.12, days: [0, 1, 2, 3, 4], start: '22:00',
//       end: '06:00', months: null },
//   ] }
//
// `days` uses 0 = Monday … 6 = Sunday: the same convention as `DAY_NAMES`, the
// schedule editor's weekday chips and `schedule/current`, so the two `days`
// fields in the database agree. `Date#getDay()` counts 0 = Sunday, so it is
// converted with `(getDay() + 6) % 7`. `months` is null (all year) or an
// inclusive list of 1–12. `start`/`end` are `HH:MM` on a half-open
// `[start, end)` local interval; `end <= start` wraps midnight, and
// `start === end` covers the whole day. Windows are matched on the local wall
// clock, so daylight-saving transitions move with the owner's clock instead of
// a fixed UTC offset.
//
// `from`/`to` are an optional day-precision season scope: `MM-DD` strings,
// inclusive, recurring every year, wrapping when `from > to` (and `from === to`
// is one day). Both or neither must be valid. When both are, date mode is active
// and outranks `months`, which is then only the coarse compatibility hint the
// settings payload derives. A **season rate** is an ordinary all-day, every-day
// row (`start === end`); it needs no new field.
//
// A window's post-midnight hours belong to the day the window *started*
// (matching the bridge's schedule model): a Monday 22:00–06:00 window also
// covers Tuesday 00:00–05:59, and a December-only 22:00–06:00 window covers
// 1 January 00:00–05:59. See `windowSegments`.

export const RATE_MIN = 0;
export const RATE_MAX = 5;
export const MAX_RATE_WINDOWS = 24;

// ASCII digits only, exactly HH:MM — the same contract as schedule.js.
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// Zero-padded MM-DD: the stored date contract. A real-date check follows.
const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The annual date model is a 366-slot leap ring: 0 = 1 January, 59 = 29
// February, 365 = 31 December. Pinning February to 29 is what makes date
// matching and overlap leap-exact; a non-leap year simply has no instant on
// slot 59. `DAYS_IN_MONTH` is the leap-year shape and `MONTH_START` the first
// slot of each month.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_START = DAYS_IN_MONTH.map((_, index) =>
  DAYS_IN_MONTH.slice(0, index).reduce((total, days) => total + days, 0),
);
const RING_DAYS = 366;
const FEB_28 = MONTH_START[1] + 27;
const MAR_1 = MONTH_START[2];

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

// A stored `MM-DD` bound as `{month, day}`, or null when it is not a strict
// zero-padded, real annual date. February is checked against the leap ring, so
// `02-29` is valid and `02-30` is not.
export function parseMonthDay(value) {
  if (typeof value !== 'string' || !MONTH_DAY_RE.test(value)) return null;
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(3));
  if (day > DAYS_IN_MONTH[month - 1]) return null;
  return { month, day };
}

// Integer `MMDD` comparison key, the same ordering as the calendar within a
// year and across a wrap.
function monthDayKey(month, day) {
  return month * 100 + day;
}

// The last day of a month in the leap-year shape used by the annual ring
// (February is 29). A month outside 1–12 has no last day.
export function lastDayOfMonth(month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return 0;
  return DAYS_IN_MONTH[month - 1];
}

// The months a date range spans, in calendar order (a wrap goes forward through
// December). `months` is the coarse compatibility hint: new clients derive it on
// write, old clients read it and over-apply at the edges.
export function monthsCovering(from, to) {
  const start = parseMonthDay(from);
  const end = parseMonthDay(to);
  if (!start || !end) return [];
  const wraps = monthDayKey(start.month, start.day) > monthDayKey(end.month, end.day);
  // A reversed range whose bounds share a month (`06-20` → `06-10`) runs through
  // December and back into that same month, so it spans the whole year rather
  // than the single shared month.
  const wholeYear = wraps && start.month === end.month;
  const months = [];
  let month = start.month;
  for (;;) {
    months.push(month);
    if (!wholeYear && month === end.month) break;
    month = month === 12 ? 1 : month + 1;
    if (wholeYear && month === start.month) break;
  }
  return months;
}

// The leap-ring slot of a month-day.
function monthDayIndex(month, day) {
  return MONTH_START[month - 1] + day - 1;
}

function indexMonthDay(index) {
  for (let month = 12; month >= 1; month -= 1) {
    if (index >= MONTH_START[month - 1]) {
      return { month, day: index - MONTH_START[month - 1] + 1 };
    }
  }
  return { month: 1, day: 1 };
}

// Shared annual-calendar helpers for the settings projections: one source for
// the 366-slot leap ring keeps coverage labels and matching on the same dates.
export const ANNUAL_DAYS = RING_DAYS;

export function annualDayIndex(month, day) {
  return monthDayIndex(month, day);
}

export function annualMonthDay(index) {
  return indexMonthDay(index);
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

// The stored row shape is fixed: {id, rate, days, start, end, months, from, to}.
// Values are carried through as they are (invalid ones included) so validation
// can flag them instead of silently repairing a document. A blank date bound is
// absent, not an invalid date.
function dateBound(value) {
  return value == null || value === '' ? null : value;
}

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
    from: dateBound(source.from),
    to: dateBound(source.to),
  };
}

// A season base is the all-day, every-day row. The shape is the whole marker:
// no new stored field. A day-restricted all-day row is an override, not a base.
export function isBaseWindow(row) {
  if (!row || row.start !== row.end) return false;
  const days = Array.isArray(row.days) ? row.days : [];
  if (days.length !== 7) return false;
  return [0, 1, 2, 3, 4, 5, 6].every((day) => days.includes(day));
}

// One date bound's message. The field key names which bound; the text states the
// contract so a hand-edited value is recognisable.
function dateError(value) {
  if (value == null) return 'Set a date like 06-15.';
  return 'Use a real date like 06-15.';
}

export function validateWindow(window) {
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
    errors.days = 'Days must be whole numbers from 0 (Monday) to 6 (Sunday).';
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

  // Date mode is active only when both bounds are valid, so a row with one
  // bound (or an unusable one) is invalid regardless of its months: the dates
  // were meant to outrank the hint, and guessing would hide a typo.
  const from = dateBound(window && window.from);
  const to = dateBound(window && window.to);
  if (from != null || to != null) {
    if (parseMonthDay(from) == null) errors.from = dateError(from);
    if (parseMonthDay(to) == null) errors.to = dateError(to);
  } else {
    const months = window && window.months;
    if (months !== null && months !== undefined) {
      if (!Array.isArray(months) || months.length === 0) {
        errors.months = 'Pick at least one month, or choose All year.';
      } else if (months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
        errors.months = 'Months must be whole numbers from 1 to 12.';
      } else if (new Set(months).size !== months.length) {
        errors.months = 'Each month can only appear once.';
      }
    }
  }

  return errors;
}

function windowIsValid(window) {
  return Object.keys(validateWindow(window)).length === 0;
}

// ---------- matching ----------

// A window's month list reduced to what it can match. `null` (all year) is
// every month; a malformed value the caller did not validate is no month, so
// matching fails closed. Entries outside 1–12 are dropped here (validation
// keeps them in the row and reports them).
function monthScope(months) {
  if (months == null) return { kind: 'all', months: null };
  if (!Array.isArray(months)) return { kind: 'invalid', months: [] };
  const valid = [...new Set(months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort(
    (a, b) => a - b,
  );
  if (valid.length === 0) return { kind: 'invalid', months: [] };
  if (valid.length === 12) return { kind: 'all', months: null };
  return { kind: 'months', months: valid };
}

// The season a window belongs to, in the terms matching needs. Date mode is
// active only when both bounds are valid (`dates`); when one is present but
// unusable, the scope is `invalid` and matches nothing, so a typo fails closed
// instead of silently falling back to stale months. `fromKey`/`toKey` are
// integer MMDD comparison keys.
export function seasonScope(window) {
  const from = window && window.from;
  const to = window && window.to;
  const present = (value) => value != null && value !== '';
  const start = parseMonthDay(from);
  const end = parseMonthDay(to);
  if (start && end) {
    return {
      kind: 'dates',
      from: from,
      to: to,
      fromKey: monthDayKey(start.month, start.day),
      toKey: monthDayKey(end.month, end.day),
    };
  }
  if (present(from) || present(to)) return { kind: 'invalid', months: [] };
  return monthScope(window && window.months);
}

// Whether a scope covers one local calendar date. Only the month and day are
// read, so the answer recurs every year; a wrapped range compares as MMDD.
export function scopeMatches(scope, date) {
  if (!scope || !(date instanceof Date) || !Number.isFinite(date.getTime())) return false;
  if (scope.kind === 'all') return true;
  if (scope.kind === 'months') return scope.months.includes(date.getMonth() + 1);
  if (scope.kind === 'dates') {
    const key = monthDayKey(date.getMonth() + 1, date.getDate());
    return scope.fromKey <= scope.toKey
      ? key >= scope.fromKey && key <= scope.toKey
      : key >= scope.fromKey || key <= scope.toKey;
  }
  return false;
}

export function seasonMatches(window, date) {
  return scopeMatches(seasonScope(window), date);
}

// 0 = Monday … 6 = Sunday, from a local Date whose `getDay()` is 0 = Sunday.
function dayIndex(date) {
  return (date.getDay() + 6) % 7;
}

// A window as the calendar ranges it actually covers: one segment per weekday,
// each carrying the season of the day the window *started*. `end <= start`
// wraps midnight (`start === end` covers the whole day), and a wrapping window
// splits in two:
//
//   main  [start, 1440)  on the start day
//   tail  [0, end)       on the *next* day (`tail: true`)
//
// The tail is the next day's early hours, so its weekday is the instant's
// weekday, but its weekday *and* season are judged on the previous calendar day
// — the day the window started. A December-only window therefore covers
// 1 January 00:00–05:59 and nothing later in January; a 15 June–15 September
// season's tail on 16 September belongs to 15 September.
export function windowSegments(window) {
  const start = parseTime(window && window.start);
  const end = parseTime(window && window.end);
  if (start == null || end == null) return [];
  const days = Array.isArray(window.days)
    ? window.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [];
  const season = seasonScope(window);
  if (start === end) {
    return days.map((day) => ({ day, season, from: 0, to: MINUTES_PER_DAY }));
  }
  if (start < end) {
    return days.map((day) => ({ day, season, from: start, to: end }));
  }
  const segments = [];
  for (const day of days) {
    segments.push({ day, season, from: start, to: MINUTES_PER_DAY });
    segments.push({
      day: (day + 1) % 7,
      season,
      from: 0,
      to: end,
      tail: true,
    });
  }
  return segments;
}

// Noon of the local day before `date`. Anchoring at noon keeps the weekday and
// date boundaries read away from a missing or repeated DST hour.
function previousDayNoon(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 12, 0);
}

export function windowMatches(window, date) {
  if (!window || !(date instanceof Date) || !Number.isFinite(date.getTime())) return false;
  const day = dayIndex(date);
  const minutes = date.getHours() * 60 + date.getMinutes();
  let previous = null;
  return windowSegments(window).some((segment) => {
    if (segment.day !== day) return false;
    if (minutes < segment.from || minutes >= segment.to) return false;
    // A tail belongs to the instant's previous calendar day, across a date edge
    // and across New Year.
    let seasonDate = date;
    if (segment.tail) {
      if (previous == null) previous = previousDayNoon(date);
      seasonDate = previous;
    }
    return scopeMatches(segment.season, seasonDate);
  });
}

// A stored document's optional row list. Invalid rows are dropped one at a time
// — a hand-edited or half-written document keeps its usable rows. If no usable
// row remains, the flat price is the only configuration left; once usable rows
// exist, an unmatched instant is 0. Order is preserved: it only matters as the
// tie-break within a tier for overlapping rows an older writer may have stored.
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

// The rate tier that wins one instant. A base applies only when no override
// matches; the last row within each tier is the deterministic tie-break for
// hand-edited overlaps.
function matchingEntry(schedule, date) {
  let base = null;
  let override = null;
  for (const window of schedule.rates) {
    if (!windowMatches(window, date)) continue;
    if (isBaseWindow(window)) base = window;
    else override = window;
  }
  if (override) return { window: override, source: 'window' };
  if (base) return { window: base, source: 'base' };
  return null;
}

const UNPRICED_RATE = 0;

function rateFor(schedule, date) {
  const hit = matchingEntry(schedule, date);
  if (hit) return hit.window.rate;
  // A flat configuration is the fallback. Once any row exists, settings.rate is
  // deliberately ignored; an unmatched instant has no price (0).
  return schedule.rates.length === 0 ? schedule.rate : UNPRICED_RATE;
}

// The rate for one local instant: override, season base, flat only when the
// schedule is empty, else 0.
export function rateAt(date, schedule) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return rateFor(normalizeRateSchedule(schedule), date);
}

// The same lookup with the winning row and why it won. With no match, the
// `uncoveredDate` / `unpricedHour` flags distinguish "no season covers this
// date" from "a season covers the date but has no base/window for this hour";
// both price 0.
export function rateEntryAt(date, schedule) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const normalized = normalizeRateSchedule(schedule);
  const hit = matchingEntry(normalized, date);
  if (hit) return { rate: hit.window.rate, window: hit.window, source: hit.source };
  if (normalized.rates.length === 0) {
    return {
      rate: normalized.rate,
      window: null,
      source: normalized.rate == null ? 'none' : 'flat',
    };
  }
  const scopeCoversDate = normalized.rates.some((window) => seasonMatches(window, date));
  return {
    rate: UNPRICED_RATE,
    window: null,
    source: 'uncovered',
    uncoveredDate: !scopeCoversDate,
    unpricedHour: scopeCoversDate,
  };
}

// Whether a schedule leaves any slice of an interval without a row. Flat
// schedules never do; a non-empty schedule does when no base or override matches
// a slice. Used for the live cost marker.
export function intervalUncovered(start, end, schedule) {
  const startMs = toMillis(start);
  const endMs = toMillis(end);
  if (startMs == null || endMs == null || endMs <= startMs) return false;
  const normalized = normalizeRateSchedule(schedule);
  if (normalized.rates.length === 0) return false;
  const boundaries = intervalBoundaries(startMs, endMs, normalized);
  for (let i = 1; i < boundaries.length; i += 1) {
    const from = boundaries[i - 1];
    const to = boundaries[i];
    if (to <= from) continue;
    if (!matchingEntry(normalized, new Date(from))) return true;
  }
  return false;
}

// One local day as a complete, contiguous partition: every minute from 00:00 to
// 24:00 belongs to exactly one segment, carrying the winning window (or null for
// the flat fallback). Boundaries are every window start/end plus midnight, and
// matching cannot change between two boundaries, so one probe per interval is
// exact for the wall clock. A wrapping window's tail lands at the start of the
// day and its main part at the end; both refer to the same stored row.
export function rateDayPartition(schedule, date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return [];
  const normalized = normalizeRateSchedule(schedule);
  const boundaries = new Set([0, MINUTES_PER_DAY]);
  for (const window of normalized.rates) {
    const start = parseTime(window.start);
    const end = parseTime(window.end);
    if (start != null) boundaries.add(start);
    if (end != null) boundaries.add(end);
  }
  const marks = [...boundaries].sort((a, b) => a - b);
  const segments = [];
  for (let i = 1; i < marks.length; i += 1) {
    const from = marks[i - 1];
    const to = marks[i];
    if (to <= from) continue;
    const at = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      Math.floor(from / 60),
      from % 60,
    );
    const hit = matchingEntry(normalized, at);
    const window = hit ? hit.window : null;
    const rate = hit
      ? hit.window.rate
      : normalized.rates.length === 0
        ? normalized.rate
        : UNPRICED_RATE;
    const source = hit
      ? hit.source
      : normalized.rates.length === 0
        ? normalized.rate == null
          ? 'none'
          : 'flat'
        : 'uncovered';
    const last = segments[segments.length - 1];
    // Merge only the same row at the same price and source: two rows with an
    // equal rate stay separate so the partition can still name their scopes.
    if (last && last.window === window && last.rate === rate && last.source === source)
      last.to = to;
    else segments.push({ from, to, rate, window, source });
  }
  return segments;
}

// ---------- overlap validation ----------

// The annual date model is not a calendar scan: one reference year would pin
// each month-day to one weekday (and miss overlaps), 400 years is too slow per
// render. Instead each season is a set of slots on the 366-day leap ring, so a
// month-day means the same date in every year and 29 February exists exactly
// once.

function markDateRange(flags, start, end) {
  if (start <= end) {
    flags.fill(true, start, end + 1);
    return;
  }
  flags.fill(true, start, RING_DAYS);
  flags.fill(true, 0, end + 1);
}

function dateFlagsToSet(flags) {
  const ranges = [];
  let start = -1;
  for (let day = 0; day < RING_DAYS; day += 1) {
    if (flags[day] && start < 0) start = day;
    else if (!flags[day] && start >= 0) {
      ranges.push([start, day - 1]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, RING_DAYS - 1]);
  return ranges;
}

function dateSetContains(set, day) {
  return (Array.isArray(set) ? set : []).some(([start, end]) => day >= start && day <= end);
}

// The dates a season scope covers, as sorted inclusive leap-ring intervals.
// Months become whole months (February includes 29 February), a date range is
// `[from..to]` or the wrapped pair, all-year is the whole ring, and an unusable
// scope covers nothing (fail closed).
export function seasonDateSet(scope) {
  const flags = new Array(RING_DAYS).fill(false);
  if (!scope || scope.kind === 'invalid') return [];
  if (scope.kind === 'all') return [[0, RING_DAYS - 1]];
  if (scope.kind === 'dates') {
    const start = indexOfMonthDay(scope.fromKey);
    const end = indexOfMonthDay(scope.toKey);
    markDateRange(flags, start, end);
    return dateFlagsToSet(flags);
  }
  for (const month of scope.months) {
    markDateRange(
      flags,
      MONTH_START[month - 1],
      MONTH_START[month - 1] + DAYS_IN_MONTH[month - 1] - 1,
    );
  }
  return dateFlagsToSet(flags);
}

function indexOfMonthDay(key) {
  return monthDayIndex(Math.floor(key / 100), key % 100);
}

// The dates whose *previous* day is in `set` — the set shifted one day forward,
// i.e. the successor of every date in `set`. That is the direction the main/tail
// table needs: a tail on date X covers the instant on X's previous date, so A's
// dates are intersected with `shift(S_B)`. The 28 February slot shifts to
// 29 February in a leap year *and* to 1 March in a common year, so both possible
// successors are included; overlap only needs a year type where the two windows
// meet.
export function shiftDateSet(set) {
  const flags = new Array(RING_DAYS).fill(false);
  for (const [start, end] of Array.isArray(set) ? set : []) {
    for (let day = start; day <= end; day += 1) flags[(day + 1) % RING_DAYS] = true;
  }
  if (dateSetContains(set, FEB_28)) flags[MAR_1] = true;
  return dateFlagsToSet(flags);
}

// Whether two sorted interval lists share any day.
export function intersectDateSets(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i][1] < b[j][0]) i += 1;
    else if (b[j][1] < a[i][0]) j += 1;
    else return true;
  }
  return false;
}

// Two windows collide when they can both match one instant: two segments on the
// same weekday, on intersecting season dates, with overlapping time-of-day
// ranges. Comparing segments (rather than day/date sets alone) is what catches
// a Tuesday-early window against a Monday night.
//
// A tail is judged on the previous calendar date, so the season sets combine as
// the four-case table:
//
//   main/main   S_A ∩ S_B
//   main/tail   S_A ∩ shift(S_B)
//   tail/main   shift(S_A) ∩ S_B
//   tail/tail   S_A ∩ S_B        (both starts are the same previous day)
//
// Tail/tail is why instant-date sets alone are wrong: A(29 Feb) and B(28 Feb)
// tails both touch 1 March, but in different year types, so they never meet.
// Touching endpoints do not overlap (one window ends exactly where the other
// starts).
export function windowsOverlap(left, right) {
  if (!left || !right) return false;
  const segmentsA = windowSegments(left);
  const segmentsB = windowSegments(right);
  const cache = new Map();
  const seasonSets = (scope) => {
    if (!cache.has(scope)) {
      const dates = seasonDateSet(scope);
      cache.set(scope, { dates, shifted: shiftDateSet(dates) });
    }
    return cache.get(scope);
  };
  for (const a of segmentsA) {
    for (const b of segmentsB) {
      if (a.day !== b.day) continue;
      if (a.from >= b.to || b.from >= a.to) continue;
      const setA = seasonSets(a.season);
      const setB = seasonSets(b.season);
      let collides;
      if (!a.tail && !b.tail) collides = intersectDateSets(setA.dates, setB.dates);
      else if (!a.tail) collides = intersectDateSets(setA.dates, setB.shifted);
      else if (!b.tail) collides = intersectDateSets(setA.shifted, setB.dates);
      else collides = intersectDateSets(setA.dates, setB.dates);
      if (collides) return true;
    }
  }
  return false;
}

function overlapPairs(values, rowErrors) {
  const pairs = [];
  for (let i = 0; i < values.length; i += 1) {
    if (Object.keys(rowErrors[i]).length > 0) continue;
    for (let j = i + 1; j < values.length; j += 1) {
      if (Object.keys(rowErrors[j]).length > 0) continue;
      // Bases and overrides are different tiers; only same-tier collisions are
      // ambiguous. A base plus a window is the supported base/override model.
      if (
        isBaseWindow(values[i]) === isBaseWindow(values[j]) &&
        windowsOverlap(values[i], values[j])
      ) {
        pairs.push([i, j]);
      }
    }
  }
  return pairs;
}

// Positions of the rows that collide, aligned with the input list. The editor
// names rows by position ("Rate 2") instead of their stored id, while
// validateRateWindows keeps the ids in its document-level copy.
export function overlappingWindowPairs(rows) {
  const values = (Array.isArray(rows) ? rows : []).map(normalizeWindow);
  return overlapPairs(values, values.map(validateWindow));
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
  for (const [i, j] of overlapPairs(values, rowErrors)) {
    const left = values[i].id || `#${i + 1}`;
    const right = values[j].id || `#${j + 1}`;
    if (isBaseWindow(values[i]) && isBaseWindow(values[j])) {
      general.push(
        `Base rates “${left}” and “${right}” cover some of the same dates. Keep one base per date.`,
      );
    } else {
      general.push(`Window “${left}” overlaps window “${right}”.`);
    }
  }

  return {
    valid: general.length === 0 && rowErrors.every((errors) => Object.keys(errors).length === 0),
    errors: { general, rows: rowErrors },
    values,
  };
}

// Stable comparison for drafts against stored settings. Day and month order is
// not meaningful; text that parses to the same number is the same value. In date
// mode the `months` value is only a coarse hint, so the key compares the dates
// and ignores the hint: a stale hint is not an unsaved change.
export function rateWindowsKey(rows) {
  const list = Array.isArray(rows) ? rows.map(normalizeWindow) : [];
  const sorted = (values) =>
    Array.isArray(values) ? [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : [];
  return JSON.stringify(
    list.map((window) => {
      const scope = seasonScope(window);
      const dated = scope.kind === 'dates';
      return {
        id: window.id,
        rate: Number.isFinite(window.rate) ? window.rate : String(window.rate),
        days: sorted(window.days),
        start: window.start,
        end: window.end,
        months: dated ? null : Array.isArray(window.months) ? sorted(window.months) : window.months,
        from: dated ? scope.from : window.from,
        to: dated ? scope.to : window.to,
      };
    }),
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
    // Flat with no rate is unknown; a schedule with no matching row prices the
    // slice at 0 instead of inventing a fallback.
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
