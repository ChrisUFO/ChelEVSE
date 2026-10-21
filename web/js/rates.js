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
// A window's post-midnight hours belong to the day the window *started*
// (matching the bridge's schedule model): a Monday 22:00–06:00 window also
// covers Tuesday 00:00–05:59, and a December-only 22:00–06:00 window covers
// 1 January 00:00–05:59. See `windowSegments`.

export const RATE_MIN = 0;
export const RATE_MAX = 5;
export const MAX_RATE_WINDOWS = 24;

// ASCII digits only, exactly HH:MM — the same contract as schedule.js.
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ALL_MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const ALL_MONTHS_SET = new Set(ALL_MONTHS);

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

// ---------- month ranges ----------

// The editor's From/To pair is an inclusive range that may wrap the year
// (November → February is [11, 12, 1, 2]). The stored shape stays a list, so
// these two helpers are the only place the range is translated.
export function rangeToMonths(from, to) {
  const valid = (month) => Number.isInteger(month) && month >= 1 && month <= 12;
  if (!valid(from) || !valid(to)) return [];
  const months = [];
  let month = from;
  for (let i = 0; i < 12; i += 1) {
    months.push(month);
    if (month === to) break;
    month = month === 12 ? 1 : month + 1;
  }
  return months;
}

// A month list as the editor's {from, to}, or null when it is not one
// contiguous range (a hand-edited list such as January + June).
export function monthsToRange(months) {
  if (!Array.isArray(months) || months.length === 0) return null;
  const unique = new Set(months);
  if (unique.size !== months.length) return null;
  if ([...unique].some((month) => !Number.isInteger(month) || month < 1 || month > 12)) return null;
  if (unique.size === 12) {
    // Every month is one range from any start. Keep the stored anchor (the
    // editor writes the list in range order) so a chosen November → October
    // does not jump back to January → December; a shuffled list gets the
    // canonical pair.
    const from = months[0];
    const to = months[months.length - 1];
    const ordered = rangeToMonths(from, to);
    const anchored = ordered.length === 12 && ordered.every((month, i) => month === months[i]);
    return anchored ? { from, to } : { from: 1, to: 12 };
  }
  // The run starts at the month whose predecessor is not in the set; walking
  // forward from there must cover the whole set.
  let from = null;
  for (const month of unique) {
    const previous = month === 1 ? 12 : month - 1;
    if (!unique.has(previous)) {
      from = month;
      break;
    }
  }
  if (from == null) return null;
  let to = from;
  let seen = 1;
  let next = from === 12 ? 1 : from + 1;
  while (unique.has(next)) {
    to = next;
    seen += 1;
    next = next === 12 ? 1 : next + 1;
  }
  return seen === unique.size ? { from, to } : null;
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

  return errors;
}

function windowIsValid(window) {
  return Object.keys(validateWindow(window)).length === 0;
}

// ---------- matching ----------

// A window's month set: `null` (all year) is every month; a malformed value the
// caller did not validate is no month, so matching fails closed.
// `ALL_MONTHS_SET` is shared read-only.
function monthSet(window) {
  const months = window.months;
  if (months == null) return ALL_MONTHS_SET;
  return new Set(Array.isArray(months) ? months : []);
}

// 0 = Monday … 6 = Sunday, from a local Date whose `getDay()` is 0 = Sunday.
function dayIndex(date) {
  return (date.getDay() + 6) % 7;
}

// A window as the calendar ranges it actually covers: one segment per weekday,
// each carrying the month set of the day the window *started*. `end <= start`
// wraps midnight (`start === end` covers the whole day), and a wrapping window
// splits in two:
//
//   main  [start, 1440)  on the start day
//   tail  [0, end)       on the *next* day (`tail: true`)
//
// The tail is the next day's early hours, so its weekday is the instant's
// weekday, but its weekday *and* month are judged on the previous calendar day
// — the day the window started. A December-only window therefore covers 1
// January 00:00–05:59 and nothing later in January.
function windowSegments(window) {
  const start = parseTime(window.start);
  const end = parseTime(window.end);
  if (start == null || end == null) return [];
  const days = Array.isArray(window.days)
    ? window.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [];
  const months = monthSet(window);
  if (start === end) {
    return days.map((day) => ({ day, months, from: 0, to: MINUTES_PER_DAY }));
  }
  if (start < end) {
    return days.map((day) => ({ day, months, from: start, to: end }));
  }
  const segments = [];
  for (const day of days) {
    segments.push({ day, months, from: start, to: MINUTES_PER_DAY });
    segments.push({
      day: (day + 1) % 7,
      months,
      from: 0,
      to: end,
      tail: true,
    });
  }
  return segments;
}

// Noon of the local day before `date`. Anchoring at noon keeps the weekday and
// month read away from a missing or repeated DST hour.
function previousDayNoon(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 12, 0);
}

export function windowMatches(window, date) {
  if (!window || !(date instanceof Date) || !Number.isFinite(date.getTime())) return false;
  const day = dayIndex(date);
  const month = date.getMonth() + 1;
  const minutes = date.getHours() * 60 + date.getMinutes();
  let startMonth = null;
  return windowSegments(window).some((segment) => {
    if (segment.day !== day) return false;
    if (minutes < segment.from || minutes >= segment.to) return false;
    if (!segment.tail) return segment.months.has(month);
    // A tail belongs to the instant's previous calendar day: its weekday is
    // implied by `segment.day`, and its month is that day's month.
    if (startMonth == null) startMonth = previousDayNoon(date).getMonth() + 1;
    return segment.months.has(startMonth);
  });
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

// The window that prices one local instant, or null when the flat fallback does.
// Last matching window wins: validation rejects overlapping windows on a
// calendar-segment basis (a wrapping window's tail is compared against the next
// weekday, with the possible months its start day implies), so a schedule it
// accepts never matches one instant twice. This only decides between rows
// stored by an older or hand-edited writer, keeping the result deterministic
// instead of depending on the read order.
function matchingWindow(schedule, date) {
  let match = null;
  for (const window of schedule.rates) {
    if (windowMatches(window, date)) match = window;
  }
  return match;
}

function rateFor(schedule, date) {
  const window = matchingWindow(schedule, date);
  return window ? window.rate : schedule.rate;
}

// The rate for one local instant: the last matching window, else the flat rate.
// Returns null when the schedule has neither.
export function rateAt(date, schedule) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return rateFor(normalizeRateSchedule(schedule), date);
}

// The same lookup with the winning row attached, so a preview can name the
// window (or say the fallback applies) instead of showing an unexplained price.
// `window` is the normalized row, so it carries the stored months and times.
export function rateEntryAt(date, schedule) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const normalized = normalizeRateSchedule(schedule);
  const window = matchingWindow(normalized, date);
  return { rate: window ? window.rate : normalized.rate, window };
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
    const window = matchingWindow(normalized, at);
    const rate = window ? window.rate : normalized.rate;
    const last = segments[segments.length - 1];
    // Merge only the same row at the same price: two rows with an equal rate
    // stay separate so the partition can still name their different scopes.
    if (last && last.window === window && last.rate === rate) last.to = to;
    else segments.push({ from, to, rate, window });
  }
  return segments;
}

// ---------- overlap validation ----------

function setsIntersect(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

// The same month set, one month later (December rolls into January).
function rollMonths(months) {
  return new Set([...months].map((month) => (month === 12 ? 1 : month + 1)));
}

// The month sets two segments can meet in. A tail's instant can fall in a
// month that the start day is in (mid-month) or in the month after it (the
// start day was the last day of the month), so the tail contributes both.
function segmentMonths(segment) {
  if (!segment.tail) return segment.months;
  return new Set([...segment.months, ...rollMonths(segment.months)]);
}

// Two windows collide when they can both match one instant: two segments on the
// same weekday, with intersecting month sets and overlapping time-of-day
// ranges. Comparing segments (rather than day/month sets) is what catches a
// Tuesday-early window against a Monday night, and January's early hours against
// a December wrap. The tail's months are the possible months of its start day,
// so a calendar pair that can never meet is the only thing this over-rejects.
// Touching endpoints do not overlap (one window ends exactly where the other
// starts).
export function windowsOverlap(left, right) {
  if (!left || !right) return false;
  for (const a of windowSegments(left)) {
    for (const b of windowSegments(right)) {
      if (a.day !== b.day) continue;
      if (!setsIntersect(segmentMonths(a), segmentMonths(b))) continue;
      if (a.from < b.to && b.from < a.to) return true;
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
      if (windowsOverlap(values[i], values[j])) pairs.push([i, j]);
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
    general.push(`Window “${left}” overlaps window “${right}”.`);
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
