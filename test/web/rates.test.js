// Rate-schedule helpers. The timezone is pinned before any Date is built: the
// DST and local-wall-clock cases only mean something in a zone that observes
// daylight saving.
process.env.TZ = 'America/Denver';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RATE_WINDOWS,
  costForInterval,
  costForSession,
  intervalUncovered,
  isBaseWindow,
  intersectDateSets,
  lastDayOfMonth,
  monthsCovering,
  normalizeRateSchedule,
  normalizeWindow,
  overlappingWindowPairs,
  parseMonthDay,
  rateAt,
  rateDayPartition,
  rateEntryAt,
  rateWindowsKey,
  scopeMatches,
  seasonDateSet,
  seasonMatches,
  seasonScope,
  shiftDateSet,
  validateRateWindows,
  validateWindow,
  windowMatches,
  windowSegments,
  windowsOverlap,
} from '../../web/js/rates.js';

const HOUR_MS = 60 * 60 * 1000;

// Month is 1-based here so the tests read like the stored documents.
function date(year, month, day, hours = 0, minutes = 0) {
  return new Date(year, month - 1, day, hours, minutes);
}

function schedule(rates, rate = 0.3) {
  return { rate, currency: 'USD', rates };
}

function windowRow(overrides = {}) {
  return {
    id: 'w1',
    rate: 0.1,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '06:00',
    months: null,
    ...overrides,
  };
}

// A season base: the all-day, every-day row. Cost tests that used to rely on
// settings.rate as an invisible fallback now add the visible base explicitly.
function baseRow(rate = 0.3, overrides = {}) {
  return windowRow({
    id: 'base',
    rate,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '00:00',
    months: null,
    ...overrides,
  });
}

function withBase(rates, rate = 0.3) {
  return schedule([baseRow(rate), ...rates], rate);
}

function close(actual, expected, message) {
  assert.ok(Number.isFinite(actual), `${message}: expected a number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}

test('the test process runs in a DST-observing local timezone', () => {
  assert.equal(date(2026, 1, 1).getTimezoneOffset(), 420); // MST, UTC-7
  assert.equal(date(2026, 7, 1).getTimezoneOffset(), 360); // MDT, UTC-6
});

// ---------- normalization ----------

test('normalizeRateSchedule keeps the stored flat rate and drops invalid rows only', () => {
  assert.deepEqual(normalizeRateSchedule(null), { rate: null, currency: null, rates: [] });

  const flat = normalizeRateSchedule({ rate: 0.31, currency: 'USD' });
  assert.deepEqual(flat, { rate: 0.31, currency: 'USD', rates: [] });

  const stored = {
    rate: 0.31,
    currency: 'USD',
    rates: [
      windowRow({ id: 'night', rate: 0.12, start: '22:00', end: '06:00' }),
      windowRow({ id: 'bad-time', start: '24:00' }),
      windowRow({ id: 'bad-rate', rate: 9 }),
      windowRow({ id: 'no-days', days: [] }),
      windowRow({ id: '' }),
      windowRow({ id: 'bad-months', months: [0, 13] }),
      windowRow({
        id: 'day',
        rate: 0.2,
        days: [5, 6],
        start: '10:00',
        end: '16:00',
        months: [6, 7, 8],
      }),
    ],
  };
  const normalized = normalizeRateSchedule(stored);
  // Order is preserved; the two usable rows survive the five broken ones.
  assert.deepEqual(
    normalized.rates.map((row) => row.id),
    ['night', 'day'],
  );
  assert.deepEqual(normalized.rates[0], {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '22:00',
    end: '06:00',
    months: null,
    from: null,
    to: null,
  });
  assert.deepEqual(normalized.rates[1].months, [6, 7, 8]);
  // The flat fallback survives a corrupt list.
  assert.equal(normalized.rate, 0.31);

  // Numeric text in a stored row is the same rate, as it is on the form.
  assert.equal(
    normalizeRateSchedule({ ...stored, rates: [windowRow({ rate: '0.15' })] }).rates[0].rate,
    0.15,
  );

  // A non-list container is no schedule at all; the fallback still applies.
  assert.deepEqual(normalizeRateSchedule({ rate: 0.31, currency: 'USD', rates: {} }).rates, []);

  // Overlaps are a document-level problem, not a malformed row: normalization
  // keeps both (rateAt documents which one wins).
  const overlapping = normalizeRateSchedule({
    rate: 0.31,
    currency: 'USD',
    rates: [windowRow({ id: 'a' }), windowRow({ id: 'b' })],
  });
  assert.equal(overlapping.rates.length, 2);
});

// ---------- validation ----------

test('validateRateWindows accepts an absent or empty schedule', () => {
  for (const rows of [undefined, null, []]) {
    const result = validateRateWindows(rows);
    assert.equal(result.valid, true);
    assert.deepEqual(result.values, []);
    assert.deepEqual(result.errors, { general: [], rows: [] });
  }
});

test('validateRateWindows rejects a non-list container', () => {
  const result = validateRateWindows({ rate: 0.1 });
  assert.equal(result.valid, false);
  assert.equal(result.errors.general.length, 1);
  assert.match(result.errors.general[0], /list/);
});

test('validateRateWindows validates each row and its limit', () => {
  const good = windowRow();
  assert.equal(validateRateWindows([good]).valid, true);

  const rows = [
    windowRow({ id: '', rate: 0.1 }),
    windowRow({ id: 'rate-high', rate: 5.01 }),
    windowRow({ id: 'rate-text', rate: 'abc' }),
    windowRow({ id: 'days-empty', days: [] }),
    windowRow({ id: 'days-range', days: [0, 7] }),
    windowRow({ id: 'days-dup', days: [1, 1] }),
    windowRow({ id: 'time-text', start: '7:00' }),
    windowRow({ id: 'months-type', months: 3 }),
    windowRow({ id: 'months-empty', months: [] }),
    windowRow({ id: 'months-range', months: [0, 6] }),
    windowRow({ id: 'months-dup', months: [6, 6] }),
  ];
  const result = validateRateWindows(rows);
  assert.equal(result.valid, false);
  assert.ok(result.errors.rows[0].id);
  assert.ok(result.errors.rows[1].rate);
  assert.ok(result.errors.rows[2].rate);
  assert.ok(result.errors.rows[3].days);
  assert.ok(result.errors.rows[4].days);
  assert.ok(result.errors.rows[5].days);
  assert.ok(result.errors.rows[6].start);
  assert.ok(result.errors.rows[6].end);
  assert.ok(result.errors.rows[7].months);
  assert.ok(result.errors.rows[8].months);
  assert.ok(result.errors.rows[9].months);
  assert.ok(result.errors.rows[10].months);

  // One half-hour window per hour: the first 24 do not overlap each other.
  const hourRow = (i) =>
    windowRow({
      id: `w${i}`,
      start: `${String(i).padStart(2, '0')}:00`,
      end: `${String(i).padStart(2, '0')}:30`,
    });
  const tooMany = Array.from({ length: MAX_RATE_WINDOWS + 1 }, (_, i) => hourRow(i));
  const over = validateRateWindows(tooMany);
  assert.equal(over.valid, false);
  assert.match(over.errors.general[0], new RegExp(String(MAX_RATE_WINDOWS)));

  const atLimit = validateRateWindows(tooMany.slice(0, MAX_RATE_WINDOWS));
  assert.equal(atLimit.valid, true);
});

test('validateRateWindows rejects overlapping windows on shared days, months and times', () => {
  // Same day set and overlapping time ranges.
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'a', start: '22:00', end: '06:00' }),
      windowRow({ id: 'b', start: '05:00', end: '07:00' }),
    ),
    true,
  );
  // Midnight wrap on both sides of the range.
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'a', start: '23:00', end: '01:00' }),
      windowRow({ id: 'b', start: '00:30', end: '02:00' }),
    ),
    true,
  );
  // Different day sets, different month sets, and touching endpoints do not
  // overlap: precedence never has to decide.
  assert.equal(
    windowsOverlap(windowRow({ id: 'a', days: [1] }), windowRow({ id: 'b', days: [2] })),
    false,
  );
  assert.equal(
    windowsOverlap(windowRow({ id: 'a', months: [1] }), windowRow({ id: 'b', months: [2] })),
    false,
  );
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'a', start: '22:00', end: '06:00' }),
      windowRow({ id: 'b', start: '06:00', end: '07:00' }),
    ),
    false,
  );
  // `months: null` shares every month.
  assert.equal(
    windowsOverlap(windowRow({ id: 'a', months: null }), windowRow({ id: 'b', months: [3] })),
    true,
  );
  // start === end covers the whole day, so it collides with anything on a
  // shared weekday.
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'all-day', start: '00:00', end: '00:00' }),
      windowRow({ id: 'noon', start: '12:00', end: '13:00' }),
    ),
    true,
  );
  // A wrapping window's tail is compared against the next weekday, so a Monday
  // night (0 = Monday) and a Tuesday early window collide on Tuesday 00:00–06:00.
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'a', days: [0], start: '22:00', end: '06:00' }),
      windowRow({ id: 'b', days: [1], start: '00:00', end: '07:00' }),
    ),
    true,
  );
  // …and in the same month: a Wednesday tail is Wednesday's early hours.
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'a', days: [1], months: [3], start: '22:00', end: '06:00' }),
      windowRow({ id: 'b', days: [2], months: [3], start: '00:00', end: '07:00' }),
    ),
    true,
  );
  // …and against the next month, so a December wrap collides with January's
  // early hours.
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'a', months: [12], start: '22:00', end: '06:00' }),
      windowRow({ id: 'b', months: [1], start: '00:00', end: '06:00' }),
    ),
    true,
  );
  // Endpoints that touch across the boundary do not overlap.
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'a', months: [12], start: '22:00', end: '06:00' }),
      windowRow({ id: 'b', months: [1], start: '06:00', end: '07:00' }),
    ),
    false,
  );
  // The tail rolls exactly one month: February does not meet December's night.
  assert.equal(
    windowsOverlap(
      windowRow({ id: 'a', months: [12], start: '22:00', end: '06:00' }),
      windowRow({ id: 'b', months: [2], start: '00:00', end: '06:00' }),
    ),
    false,
  );

  const result = validateRateWindows([
    windowRow({ id: 'night', start: '22:00', end: '06:00' }),
    windowRow({ id: 'early', start: '05:00', end: '07:00' }),
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.errors.rows[0].start, undefined);
  assert.match(result.errors.general.join(' '), /night.*early/);

  // Adjacent windows are the normal way to describe a whole day.
  assert.equal(
    validateRateWindows([
      windowRow({ id: 'morning', start: '00:00', end: '06:00' }),
      windowRow({ id: 'day', start: '06:00', end: '12:00' }),
    ]).valid,
    true,
  );
});

// ---------- overlap pairs ----------

test('overlappingWindowPairs reports row positions and skips invalid rows', () => {
  assert.deepEqual(
    overlappingWindowPairs([
      windowRow({ id: 'night', start: '22:00', end: '06:00' }),
      windowRow({ id: 'early', start: '05:00', end: '07:00' }),
      windowRow({ id: 'broken', start: '25:00', end: '26:00' }),
    ]),
    [[0, 1]],
  );
  // The wrapping tail collides with the next weekday's early window.
  assert.deepEqual(
    overlappingWindowPairs([
      windowRow({ id: 'mon', days: [0], start: '22:00', end: '06:00' }),
      windowRow({ id: 'tue', days: [1], start: '00:00', end: '07:00' }),
    ]),
    [[0, 1]],
  );
  assert.deepEqual(overlappingWindowPairs([windowRow({ id: 'a' })]), []);
  assert.deepEqual(overlappingWindowPairs(null), []);
});

// ---------- matching ----------

test('windowMatches uses the local weekday, month and wall clock', () => {
  // `days` is 0 = Monday, so a Monday-only night tariff is days [0].
  const mondayNight = windowRow({ days: [0], start: '22:00', end: '06:00' });
  assert.equal(date(2026, 10, 19).getDay(), 1); // Monday, in Date#getDay terms
  assert.equal(windowMatches(mondayNight, date(2026, 10, 19, 23, 0)), true);
  // The post-midnight tail belongs to the day the window started: Monday 01:00
  // is Sunday night, and Tuesday 01:00 is Monday night.
  assert.equal(windowMatches(mondayNight, date(2026, 10, 19, 1, 0)), false);
  assert.equal(windowMatches(mondayNight, date(2026, 10, 19, 6, 0)), false);
  assert.equal(windowMatches(mondayNight, date(2026, 10, 19, 12, 0)), false);
  assert.equal(windowMatches(mondayNight, date(2026, 10, 20, 1, 0)), true); // Tuesday tail
  assert.equal(windowMatches(mondayNight, date(2026, 10, 20, 5, 59)), true);
  assert.equal(windowMatches(mondayNight, date(2026, 10, 20, 6, 0)), false);

  const summerOnly = windowRow({ months: [6, 7, 8] });
  assert.equal(windowMatches(summerOnly, date(2026, 7, 1, 3, 0)), true);
  assert.equal(windowMatches(summerOnly, date(2026, 10, 1, 3, 0)), false);

  const allDay = windowRow({ start: '00:00', end: '00:00' });
  assert.equal(windowMatches(allDay, date(2026, 10, 19, 0, 0)), true);
  assert.equal(windowMatches(allDay, date(2026, 10, 19, 23, 59)), true);
});

test('the month-limited tail of a wrapping window rolls into the next month', () => {
  const decemberNight = windowRow({ months: [12], start: '22:00', end: '06:00' });
  assert.equal(windowMatches(decemberNight, date(2026, 12, 31, 23, 0)), true);
  // New Year's early hours are December's window, not January's own night.
  assert.equal(windowMatches(decemberNight, date(2027, 1, 1, 1, 0)), true);
  assert.equal(windowMatches(decemberNight, date(2027, 1, 1, 5, 59)), true);
  assert.equal(windowMatches(decemberNight, date(2027, 1, 1, 6, 0)), false);
  assert.equal(windowMatches(decemberNight, date(2027, 1, 1, 22, 0)), false);
  // The start date's month governs: later January nights are not December's.
  assert.equal(windowMatches(decemberNight, date(2027, 1, 5, 1, 0)), false);
  // A December tail rolls exactly one month; February is not December's night.
  assert.equal(windowMatches(decemberNight, date(2027, 2, 1, 1, 0)), false);
});

test('window days use 0 = Monday, matching the schedule editor chips', () => {
  const monday = windowRow({ days: [0], start: '10:00', end: '11:00' });
  assert.equal(windowMatches(monday, date(2026, 10, 19, 10, 30)), true); // Monday
  assert.equal(windowMatches(monday, date(2026, 10, 18, 10, 30)), false); // Sunday
  const sunday = windowRow({ days: [6], start: '10:00', end: '11:00' });
  assert.equal(windowMatches(sunday, date(2026, 10, 18, 10, 30)), true);
  assert.equal(windowMatches(sunday, date(2026, 10, 19, 10, 30)), false);
});

test('rateAt keeps the flat price only for an empty schedule and documents precedence', () => {
  const flat = schedule([], 0.4);
  assert.equal(rateAt(date(2026, 10, 19, 12, 0), flat), 0.4);
  assert.equal(rateAt(new Date('nope'), flat), null);
  assert.equal(rateAt(date(2026, 10, 19, 12, 0), { rates: [] }), null);

  const rate = schedule(
    [
      windowRow({ id: 'day', rate: 0.1, start: '00:00', end: '12:00' }),
      windowRow({ id: 'evening', rate: 0.2, start: '06:00', end: '18:00' }),
    ],
    0.3,
  );
  assert.equal(rateAt(date(2026, 10, 19, 5, 0), rate), 0.1);
  // Both match at 07:00; the later row wins deterministically.
  assert.equal(rateAt(date(2026, 10, 19, 7, 0), rate), 0.2);
  // Once any row exists, settings.rate is ignored: the uncovered hour is 0.
  assert.equal(rateAt(date(2026, 10, 19, 20, 0), rate), 0);

  // A visible base covers the ordinary hours; an override wins over it.
  const visible = withBase(
    [windowRow({ id: 'peak', rate: 0.2, start: '16:00', end: '19:00' })],
    0.3,
  );
  assert.equal(rateAt(date(2026, 10, 19, 12, 0), visible), 0.3);
  assert.equal(rateAt(date(2026, 10, 19, 17, 0), visible), 0.2);

  // A weekday window's post-midnight tail is priced on the next day; the gap
  // before the tail is 0, not the stored flat rate.
  const mondayNight = schedule(
    [windowRow({ id: 'monday', rate: 0.1, days: [0], start: '22:00', end: '06:00' })],
    0.3,
  );
  assert.equal(rateAt(date(2026, 10, 20, 1, 0), mondayNight), 0.1);
  assert.equal(rateAt(date(2026, 10, 19, 1, 0), mondayNight), 0);
});

// ---------- costing ----------

test('costForInterval prices a flat configuration exactly as before', () => {
  // 10 kWh at 0.25.
  close(
    costForInterval(10000, date(2026, 10, 19, 12, 0), date(2026, 10, 19, 14, 0), { rate: 0.25 }),
    2.5,
    'flat cost',
  );
  // No schedule at all cannot produce a cost.
  assert.equal(costForInterval(10000, date(2026, 10, 19), date(2026, 10, 19, 1, 0), null), null);
});

test('costForInterval pro-rates a session that spans two windows', () => {
  const s = withBase([windowRow({ rate: 0.1, start: '22:00', end: '23:00' })], 0.3);
  // 2 kWh over two hours → 1 kWh in each hour.
  close(
    costForInterval(2000, date(2026, 10, 19, 21, 0), date(2026, 10, 19, 23, 0), s),
    0.4,
    'split cost',
  );
  // Entirely inside the cheap window.
  close(
    costForInterval(2000, date(2026, 10, 19, 22, 0), date(2026, 10, 19, 23, 0), s),
    0.2,
    'inside cost',
  );
});

test('costForInterval follows a window across midnight', () => {
  const s = withBase([windowRow({ rate: 0.1, start: '22:00', end: '06:00' })], 0.3);
  close(
    costForInterval(2000, date(2026, 10, 19, 23, 0), date(2026, 10, 20, 1, 0), s),
    0.2,
    'wrapped',
  );
  close(
    costForInterval(2000, date(2026, 10, 20, 5, 0), date(2026, 10, 20, 7, 0), s),
    0.4,
    'wrap exit',
  );
});

test('a weekday-limited wrap is costed on the night it started', () => {
  // `days` is 0 = Monday: a Monday-night window.
  const s = withBase([windowRow({ rate: 0.1, days: [0], start: '22:00', end: '06:00' })], 0.3);
  // Monday 22:00 → Tuesday 02:00 is one Monday-night window.
  close(
    costForInterval(2000, date(2026, 10, 19, 22, 0), date(2026, 10, 20, 2, 0), s),
    0.2,
    'Monday night',
  );
  // Tuesday 01:00 → 02:00 is that same window's tail.
  close(
    costForInterval(1000, date(2026, 10, 20, 1, 0), date(2026, 10, 20, 2, 0), s),
    0.1,
    'Monday tail',
  );
  // Sunday 22:00 → Monday 02:00 is not: Sunday night is outside the window.
  close(
    costForInterval(2000, date(2026, 10, 18, 22, 0), date(2026, 10, 19, 2, 0), s),
    0.6,
    'Sunday night',
  );
});

test('a month-limited wrap is costed into the next month', () => {
  const s = withBase([windowRow({ rate: 0.1, months: [12], start: '22:00', end: '06:00' })], 0.3);
  // 31 December 23:00 → 1 January 02:00: three hours of December's window.
  close(
    costForInterval(3000, date(2026, 12, 31, 23, 0), date(2027, 1, 1, 2, 0), s),
    0.3,
    'December into January',
  );
  // January's own night is not December's window.
  close(
    costForInterval(2000, date(2027, 1, 1, 22, 0), date(2027, 1, 2, 2, 0), s),
    0.6,
    'January night',
  );
});

test('costForInterval splits at a month boundary', () => {
  const s = withBase([windowRow({ rate: 0.1, months: [12], start: '00:00', end: '00:00' })], 0.3);
  close(
    costForInterval(2000, date(2026, 12, 31, 23, 0), date(2027, 1, 1, 1, 0), s),
    0.4,
    'December to January',
  );
});

test('costForInterval splits at a weekday boundary', () => {
  // A Monday window (0 = Monday), 00:00–12:00.
  const s = withBase([windowRow({ rate: 0.1, days: [0], start: '00:00', end: '12:00' })], 0.3);
  // Monday 11:00 → 13:00: one hour in the Monday window, one at the fallback.
  close(
    costForInterval(2000, date(2026, 10, 19, 11, 0), date(2026, 10, 19, 13, 0), s),
    0.4,
    'weekday',
  );
});

test('costForInterval handles the spring-forward gap with local boundaries', () => {
  // 2026-03-08 02:00 does not exist in Denver; 01:00 → 04:00 is two real hours.
  const start = date(2026, 3, 8, 1, 0);
  const end = date(2026, 3, 8, 4, 0);
  assert.equal(end - start, 2 * HOUR_MS);

  const s = withBase([windowRow({ rate: 0.1, start: '00:00', end: '02:00' })], 0.3);
  // The 02:00 boundary lands on the first instant that exists (03:00 MDT), so
  // the interval is one hour at 0.1 and one hour at 0.3.
  close(costForInterval(2000, start, end, s), 0.4, 'spring forward');
});

test('costForInterval handles the fall-back repeated hour with local boundaries', () => {
  // 2026-11-01: 02:00 MDT falls back to 01:00 MST, so 00:00 → 03:00 is four
  // real hours. The 01:00–02:00 window covers the repeated hour too, because
  // 02:00 local is unambiguous and after the repeat.
  const start = date(2026, 11, 1, 0, 0);
  const end = date(2026, 11, 1, 3, 0);
  assert.equal(end - start, 4 * HOUR_MS);

  const s = withBase([windowRow({ rate: 0.1, start: '01:00', end: '02:00' })], 0.3);
  // 4 kWh over four hours: 1 h fallback + 2 h window + 1 h fallback.
  close(costForInterval(4000, start, end, s), 0.8, 'fall back');
});

test('costForInterval returns null for unusable inputs', () => {
  const s = withBase([windowRow()], 0.3);
  const start = date(2026, 10, 19, 12, 0);
  assert.equal(costForInterval(null, start, date(2026, 10, 19, 13, 0), s), null);
  assert.equal(costForInterval(-1, start, date(2026, 10, 19, 13, 0), s), null);
  assert.equal(costForInterval('', start, date(2026, 10, 19, 13, 0), s), null);
  assert.equal(costForInterval(true, start, date(2026, 10, 19, 13, 0), s), null);
  assert.equal(costForInterval(1000, null, date(2026, 10, 19, 13, 0), s), null);
  assert.equal(costForInterval(1000, start, null, s), null);
  assert.equal(costForInterval(1000, start, start, s), null);
  assert.equal(costForInterval(1000, date(2026, 10, 19, 13, 0), start, s), null);
  // No flat rate and no window covering 12:00: the cost is unknown.
  assert.equal(costForInterval(1000, start, date(2026, 10, 19, 13, 0), { rates: [] }), null);
  // A non-empty schedule has no flat fallback: the unmatched hour costs 0,
  // while an empty list with no flat rate is still unknown.
  assert.equal(
    costForInterval(1000, start, date(2026, 10, 19, 13, 0), {
      rates: [windowRow({ start: '22:00', end: '23:00' })],
    }),
    0,
  );
});

test('costForInterval accepts session timestamp shapes', () => {
  const start = date(2026, 10, 19, 12, 0);
  const end = date(2026, 10, 19, 14, 0);
  const s = { rate: 0.25 };
  const expected = 2.5;
  close(costForInterval(10000, start, end, s), expected, 'Date');
  close(costForInterval(10000, start.getTime(), end.getTime(), s), expected, 'milliseconds');
  close(
    costForInterval(10000, { toMillis: () => start.getTime() }, { toDate: () => end }, s),
    expected,
    'Firestore timestamp',
  );
});

test('costForSession reads a sessions document', () => {
  const s = withBase([windowRow({ rate: 0.1, start: '22:00', end: '23:00' })], 0.3);
  const session = {
    id: 's1',
    wh: 2000,
    started_at: date(2026, 10, 19, 21, 0),
    ended_at: { toDate: () => date(2026, 10, 19, 23, 0) },
  };
  close(costForSession(session, s), 0.4, 'session');
  assert.equal(costForSession(null, s), null);
  assert.equal(costForSession({ wh: 2000, started_at: date(2026, 10, 19, 21, 0) }, s), null);
});

// ---------- base and override model ----------

test('isBaseWindow recognises only the all-day, every-day shape', () => {
  assert.equal(isBaseWindow(baseRow()), true);
  assert.equal(isBaseWindow(baseRow(0.2, { start: '07:00', end: '07:00' })), true);
  assert.equal(isBaseWindow(baseRow(0.2, { days: [0, 1, 2, 3, 4] })), false);
  assert.equal(isBaseWindow(windowRow({ start: '00:00', end: '06:00' })), false);
  assert.equal(isBaseWindow(windowRow({ start: '16:00', end: '19:00' })), false);
  assert.equal(isBaseWindow(null), false);
});

test('rateEntryAt names a base, an override, an uncovered date and an unpriced hour', () => {
  const rows = [
    baseRow(0.3),
    windowRow({ id: 'peak', rate: 0.2, start: '16:00', end: '19:00', months: [1] }),
  ];
  const peak = rateEntryAt(date(2026, 1, 15, 17, 0), schedule(rows, 0.9));
  assert.equal(peak.rate, 0.2);
  assert.equal(peak.source, 'window');
  assert.equal(peak.window.id, 'peak');
  assert.equal(peak.uncoveredDate, undefined);
  assert.equal(peak.unpricedHour, undefined);

  const base = rateEntryAt(date(2026, 1, 15, 12, 0), schedule(rows, 0.9));
  assert.equal(base.rate, 0.3);
  assert.equal(base.source, 'base');
  assert.equal(base.window.id, 'base');

  // A base-less window covers its hours, not the rest of the date.
  const baseLess = schedule([windowRow({ rate: 0.1, start: '22:00', end: '23:00' })], 0.9);
  const gap = rateEntryAt(date(2026, 1, 15, 12, 0), baseLess);
  assert.equal(gap.rate, 0);
  assert.equal(gap.source, 'uncovered');
  assert.equal(gap.uncoveredDate, false);
  assert.equal(gap.unpricedHour, true);

  const outside = rateEntryAt(
    date(2026, 7, 15, 12, 0),
    schedule([windowRow({ months: [1] })], 0.9),
  );
  assert.equal(outside.rate, 0);
  assert.equal(outside.uncoveredDate, true);
  assert.equal(outside.unpricedHour, false);

  const flat = rateEntryAt(date(2026, 1, 15, 12, 0), schedule([], 0.4));
  assert.equal(flat.rate, 0.4);
  assert.equal(flat.source, 'flat');
  assert.equal(rateEntryAt(new Date('nope'), flat), null);
});

test('a base and an override resolve by tier, not by list order', () => {
  const peak = windowRow({ id: 'peak', rate: 0.2, start: '16:00', end: '19:00' });
  const base = baseRow(0.3);
  for (const rows of [
    [peak, base],
    [base, peak],
  ]) {
    const s = schedule(rows, 0.9);
    assert.equal(rateAt(date(2026, 1, 15, 17, 0), s), 0.2);
    assert.equal(rateAt(date(2026, 1, 15, 12, 0), s), 0.3);
  }
  // Last match within a tier remains the deterministic tie-break for
  // hand-edited duplicates; overrides still win over bases.
  const overlap = schedule(
    [
      windowRow({ id: 'first', rate: 0.1, start: '16:00', end: '19:00' }),
      baseRow(0.3),
      windowRow({ id: 'last', rate: 0.4, start: '17:00', end: '18:00' }),
    ],
    0.9,
  );
  assert.equal(rateAt(date(2026, 1, 15, 17, 30), overlap), 0.4);
});

test('base plus override is valid; two bases or two overrides on one date are not', () => {
  const base = baseRow(0.3, { from: '01-01', to: '12-31' });
  const override = windowRow({ id: 'peak', rate: 0.2, start: '16:00', end: '19:00', months: [1] });
  assert.equal(validateRateWindows([base, override]).valid, true);
  assert.deepEqual(overlappingWindowPairs([base, override]), []);

  const secondBase = baseRow(0.4, { id: 'second-base', from: '06-01', to: '08-31' });
  const baseClash = validateRateWindows([base, secondBase]);
  assert.equal(baseClash.valid, false);
  assert.match(baseClash.errors.general.join(' '), /Base rates.*Keep one base per date/);

  const secondOverride = windowRow({
    id: 'second-peak',
    rate: 0.4,
    start: '18:00',
    end: '20:00',
    months: [1],
  });
  assert.equal(validateRateWindows([override, secondOverride]).valid, false);
  assert.deepEqual(overlappingWindowPairs([override, secondOverride]), [[0, 1]]);
});

test('rateDayPartition marks base, override and uncovered slices', () => {
  const rows = [baseRow(0.3), windowRow({ id: 'peak', rate: 0.2, start: '16:00', end: '19:00' })];
  const segments = rateDayPartition(schedule(rows, 0.9), date(2026, 1, 15, 12, 0));
  assert.deepEqual(
    segments.map((segment) => [segment.from, segment.to, segment.rate, segment.source]),
    [
      [0, 960, 0.3, 'base'],
      [960, 1140, 0.2, 'window'],
      [1140, 1440, 0.3, 'base'],
    ],
  );

  const baseLess = rateDayPartition(
    schedule([windowRow({ rate: 0.1, start: '00:00', end: '06:00' })], 0.9),
    date(2026, 1, 15, 12, 0),
  );
  assert.deepEqual(
    baseLess.map((segment) => [segment.from, segment.to, segment.rate, segment.source]),
    [
      [0, 360, 0.1, 'window'],
      [360, 1440, 0, 'uncovered'],
    ],
  );
});

test('intervalUncovered distinguishes flat, fully based and unpriced schedules', () => {
  const start = date(2026, 1, 15, 12, 0);
  const end = date(2026, 1, 15, 14, 0);
  assert.equal(intervalUncovered(start, end, schedule([], 0.3)), false);
  assert.equal(intervalUncovered(start, end, schedule([baseRow(0.3)], 0.9)), false);
  assert.equal(
    intervalUncovered(start, end, schedule([windowRow({ start: '00:00', end: '06:00' })], 0.9)),
    true,
  );
  assert.equal(
    intervalUncovered(
      date(2026, 1, 15, 5, 0),
      date(2026, 1, 15, 6, 0),
      schedule([windowRow({ start: '00:00', end: '06:00' })], 0.9),
    ),
    false,
  );
  assert.equal(intervalUncovered(start, end, null), false);
  assert.equal(intervalUncovered(start, start, schedule([baseRow()], 0.9)), false);
});

test('costing a base plus override and an uncovered date', () => {
  const s = withBase([windowRow({ id: 'peak', rate: 0.1, start: '12:00', end: '13:00' })], 0.3);
  close(
    costForInterval(2000, date(2026, 1, 15, 12, 0), date(2026, 1, 15, 14, 0), s),
    0.4,
    'base plus override',
  );
  const dateGap = schedule([baseRow(0.3, { from: '06-15', to: '09-15' })], 0.9);
  close(
    costForInterval(1000, date(2026, 1, 15, 12, 0), date(2026, 1, 15, 13, 0), dateGap),
    0,
    'uncovered date',
  );
  close(
    costForSession(
      { wh: 2000, started_at: date(2026, 1, 15, 12, 0), ended_at: date(2026, 1, 15, 14, 0) },
      s,
    ),
    0.4,
    'base plus override session',
  );
});

// ---------- date-mode seasons ----------

test('date bounds normalize both-or-neither, and the date grammar is strict', () => {
  const dated = normalizeWindow({ ...windowRow(), from: '06-15', to: '09-15' });
  assert.equal(dated.from, '06-15');
  assert.equal(dated.to, '09-15');
  // A blank bound is absent, not an invalid date.
  assert.equal(normalizeWindow({ ...windowRow(), from: '', to: '' }).from, null);
  assert.equal(normalizeWindow({ ...windowRow(), from: '', to: '' }).to, null);
  // Invalid values are carried through for validation to report.
  assert.equal(normalizeWindow({ ...windowRow(), from: '6-15' }).from, '6-15');
  assert.equal(normalizeWindow({ ...windowRow(), to: 42 }).to, 42);

  assert.deepEqual(parseMonthDay('06-15'), { month: 6, day: 15 });
  assert.deepEqual(parseMonthDay('02-29'), { month: 2, day: 29 });
  for (const value of [
    '6-15',
    '06-5',
    '02-30',
    '02-31',
    '04-31',
    '13-01',
    '00-10',
    '06/15',
    '',
    ' 06-15',
  ]) {
    assert.equal(parseMonthDay(value), null, JSON.stringify(value));
  }
  for (const value of [null, undefined, 615, { from: '06-15' }]) {
    assert.equal(parseMonthDay(value), null, String(value));
  }
});

test('the leap-shape last day of a month drives the date conversion', () => {
  assert.equal(lastDayOfMonth(1), 31);
  assert.equal(lastDayOfMonth(2), 29);
  assert.equal(lastDayOfMonth(4), 30);
  assert.equal(lastDayOfMonth(12), 31);
  for (const value of [0, 13, 1.5, '02', null]) {
    assert.equal(lastDayOfMonth(value), 0, String(value));
  }
});

test('the compatibility month hint covers a range chronologically, wrapping the year', () => {
  assert.deepEqual(monthsCovering('06-15', '09-15'), [6, 7, 8, 9]);
  assert.deepEqual(monthsCovering('10-15', '04-15'), [10, 11, 12, 1, 2, 3, 4]);
  assert.deepEqual(monthsCovering('02-29', '02-29'), [2]);
  assert.deepEqual(monthsCovering('12-31', '01-01'), [12, 1]);
  // A reversed range inside one month wraps the whole year, so every month is
  // covered; only the shared month is not the answer.
  assert.deepEqual(monthsCovering('06-20', '06-10'), [6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5]);
  assert.deepEqual(monthsCovering('12-31', '12-30'), [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(monthsCovering('02-29', '02-28'), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1]);
  assert.deepEqual(monthsCovering('02-30', '03-01'), []);
  assert.deepEqual(monthsCovering(null, '03-01'), []);
});

test('the compatibility month hint contains every month a date range matches', () => {
  const bounds = [
    '01-01',
    '01-31',
    '02-28',
    '02-29',
    '03-01',
    '04-15',
    '06-10',
    '06-15',
    '06-20',
    '07-04',
    '09-15',
    '10-15',
    '11-30',
    '12-30',
    '12-31',
  ];
  for (const from of bounds) {
    for (const to of bounds) {
      const scope = seasonScope(windowRow({ months: null, from, to }));
      const hint = monthsCovering(from, to);
      for (const year of [2024, 2025]) {
        for (let month = 1; month <= 12; month += 1) {
          const daysInMonth = new Date(year, month, 0).getDate();
          let matched = false;
          for (let day = 1; day <= daysInMonth && !matched; day += 1) {
            matched = scopeMatches(scope, date(year, month, day, 12));
          }
          if (matched) {
            assert.ok(
              hint.includes(month),
              `${from}→${to} matches ${year}-${String(month).padStart(2, '0')} but the hint is [${hint}]`,
            );
          }
        }
      }
    }
  }
});

test('date validation requires both real bounds and ignores the months hint', () => {
  const dated = windowRow({ months: null, from: '06-15', to: '09-15' });
  assert.deepEqual(validateWindow(dated), {});

  // Both absent is month mode.
  assert.deepEqual(validateWindow(windowRow({ months: [6, 7] })), {});
  // One-sided bounds are an error on the missing side, whatever months says.
  const fromOnly = validateWindow(windowRow({ months: [6, 7], from: '06-15' }));
  assert.ok(fromOnly.to);
  assert.equal(fromOnly.months, undefined);
  const toOnly = validateWindow(windowRow({ months: [6, 7], to: '09-15' }));
  assert.ok(toOnly.from);
  assert.equal(toOnly.months, undefined);
  // An unreal date is rejected and named on its own field.
  const unreal = validateWindow(windowRow({ months: null, from: '02-30', to: '03-15' }));
  assert.ok(unreal.from);
  assert.equal(unreal.to, undefined);
  // 29 February is real.
  assert.deepEqual(validateWindow(windowRow({ months: null, from: '02-29', to: '03-15' })), {});
  // Date mode outranks months: even a malformed months value is ignored, because
  // the dates are what matching uses.
  assert.deepEqual(validateWindow(windowRow({ months: 3, from: '06-15', to: '09-15' })), {});
  assert.deepEqual(validateWindow(windowRow({ months: [], from: '06-15', to: '09-15' })), {});

  // A row with a bad date is dropped from costing exactly like any invalid row.
  const schedule = normalizeRateSchedule({
    rate: 0.3,
    currency: 'USD',
    rates: [windowRow({ id: 'bad-date', months: null, from: '02-30', to: '03-15' })],
  });
  assert.deepEqual(schedule.rates, []);
});

test('scope matching is exact on the local calendar date, leap included', () => {
  const summer = seasonScope(windowRow({ months: [6, 7, 8, 9], from: '06-15', to: '09-15' }));
  assert.equal(summer.kind, 'dates');
  assert.equal(summer.fromKey, 615);
  assert.equal(summer.toKey, 915);
  for (const [month, day, expected] of [
    [6, 14, false],
    [6, 15, true],
    [9, 15, true],
    [9, 16, false],
    [12, 1, false],
  ]) {
    assert.equal(scopeMatches(summer, date(2026, month, day, 12)), expected, `${month}-${day}`);
  }
  // A wrapped range reads across New Year.
  const wrap = seasonScope(windowRow({ months: null, from: '10-15', to: '04-15' }));
  for (const [month, day, expected] of [
    [10, 14, false],
    [10, 15, true],
    [12, 31, true],
    [1, 1, true],
    [4, 15, true],
    [4, 16, false],
  ]) {
    assert.equal(scopeMatches(wrap, date(2027, month, day, 12)), expected, `${month}-${day}`);
  }
  // One day.
  const leapDay = seasonScope(windowRow({ months: null, from: '02-29', to: '02-29' }));
  assert.equal(scopeMatches(leapDay, date(2024, 2, 29, 12)), true);
  assert.equal(scopeMatches(leapDay, date(2025, 2, 28, 12)), false);
  assert.equal(scopeMatches(leapDay, date(2025, 3, 1, 12)), false);
  // An invalid pair matches nothing: fail closed, never the stale hint.
  const invalid = seasonScope(windowRow({ months: [6], from: '06-15' }));
  assert.equal(invalid.kind, 'invalid');
  assert.equal(scopeMatches(invalid, date(2026, 6, 20, 12)), false);
  assert.equal(
    seasonMatches(windowRow({ months: [6], from: '02-30', to: '03-01' }), date(2026, 2, 28, 12)),
    false,
  );
});

test('a date season prices the June and September edge days exactly', () => {
  const summer = windowRow({
    months: [6, 7, 8, 9],
    from: '06-15',
    to: '09-15',
    start: '22:00',
    end: '06:00',
  });
  for (const [day, expected] of [
    [14, false],
    [15, true],
    [16, true],
  ]) {
    assert.equal(windowMatches(summer, date(2026, 6, day, 23, 0)), expected, `June ${day}`);
  }
  for (const [day, expected] of [
    [14, true],
    [15, true],
    [16, false],
  ]) {
    assert.equal(windowMatches(summer, date(2026, 9, day, 23, 0)), expected, `September ${day}`);
  }
  // The post-midnight tail belongs to the day the window started: 16 September
  // 01:00 is 15 September's nightly window, 17 September's is not.
  assert.equal(windowMatches(summer, date(2026, 9, 16, 1, 0)), true);
  assert.equal(windowMatches(summer, date(2026, 9, 17, 1, 0)), false);
  // 15 June's early hours are 14 June's tail, and 14 June is outside the season.
  assert.equal(windowMatches(summer, date(2026, 6, 15, 5, 0)), false);
  assert.equal(windowMatches(summer, date(2026, 6, 15, 1, 0)), false);

  // An inclusive range: both edge days are whole days.
  const allDay = windowRow({
    months: null,
    from: '06-15',
    to: '09-15',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(windowMatches(allDay, date(2026, 6, 15, 0, 0)), true);
  assert.equal(windowMatches(allDay, date(2026, 9, 15, 23, 59)), true);
  assert.equal(windowMatches(allDay, date(2026, 6, 14, 23, 59)), false);
  assert.equal(windowMatches(allDay, date(2026, 9, 16, 0, 0)), false);
});

test('a wrapped date season, a single day and 29 February all behave annually', () => {
  const winter = windowRow({
    months: null,
    from: '10-15',
    to: '04-15',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(windowMatches(winter, date(2026, 10, 14, 12)), false);
  assert.equal(windowMatches(winter, date(2026, 10, 15, 0, 0)), true);
  assert.equal(windowMatches(winter, date(2027, 1, 15, 12)), true);
  assert.equal(windowMatches(winter, date(2027, 4, 15, 23, 59)), true);
  assert.equal(windowMatches(winter, date(2027, 4, 16, 0, 0)), false);

  const oneDay = windowRow({
    months: null,
    from: '06-15',
    to: '06-15',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(windowMatches(oneDay, date(2026, 6, 15, 12)), true);
  assert.equal(windowMatches(oneDay, date(2026, 6, 16, 0, 0)), false);

  // 29 February exists in 2024 and not in 2025.
  const leapDay = windowRow({
    months: null,
    from: '02-29',
    to: '02-29',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(windowMatches(leapDay, date(2024, 2, 29, 12)), true);
  assert.equal(windowMatches(leapDay, date(2025, 2, 28, 12)), false);
  assert.equal(windowMatches(leapDay, date(2025, 3, 1, 12)), false);

  // 28 February → 29 February includes the leap day only when it exists; in a
  // common year the range is just 28 February.
  const leapEdge = windowRow({
    months: null,
    from: '02-28',
    to: '02-29',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(windowMatches(leapEdge, date(2023, 2, 28, 12)), true);
  assert.equal(windowMatches(leapEdge, date(2023, 3, 1, 12)), false);
  assert.equal(windowMatches(leapEdge, date(2024, 2, 28, 12)), true);
  assert.equal(windowMatches(leapEdge, date(2024, 2, 29, 12)), true);
  assert.equal(windowMatches(leapEdge, date(2024, 3, 1, 12)), false);
});

test('a date-season tail crosses New Year on the day the window started', () => {
  const december = windowRow({
    months: [12],
    from: '12-01',
    to: '12-31',
    start: '22:00',
    end: '06:00',
  });
  // New Year's early hours belong to 31 December.
  assert.equal(windowMatches(december, date(2027, 1, 1, 1, 0)), true);
  assert.equal(windowMatches(december, date(2027, 1, 1, 5, 59)), true);
  assert.equal(windowMatches(december, date(2027, 1, 1, 6, 0)), false);
  // A later January night is not December's.
  assert.equal(windowMatches(december, date(2027, 1, 2, 1, 0)), false);

  // A season that itself wraps New Year still attributes the tail to its start
  // day: 11 January 01:00 is 10 January's window, which is in season.
  const wrapSeason = windowRow({
    months: null,
    from: '12-20',
    to: '01-10',
    start: '22:00',
    end: '06:00',
  });
  assert.equal(windowMatches(wrapSeason, date(2027, 1, 5, 22, 0)), true);
  assert.equal(windowMatches(wrapSeason, date(2027, 1, 11, 1, 0)), true);
  assert.equal(windowMatches(wrapSeason, date(2027, 1, 11, 22, 0)), false);
  assert.equal(windowMatches(wrapSeason, date(2027, 1, 12, 1, 0)), false);
});

// ---------- date-aware overlap ----------

test('the leap ring models whole months, date ranges and the day after 28 February', () => {
  const february = seasonDateSet(seasonScope({ months: [2] }));
  assert.deepEqual(february, [[31, 59]]); // 1 February … 29 February
  const juneDay = seasonDateSet(seasonScope({ from: '06-15', to: '06-15' }));
  assert.deepEqual(juneDay, [[166, 166]]);
  const summer = seasonDateSet(seasonScope({ from: '06-15', to: '09-15' }));
  assert.deepEqual(summer, [[166, 258]]);
  const wrapped = seasonDateSet(seasonScope({ from: '10-15', to: '04-15' }));
  assert.deepEqual(wrapped, [
    [0, 105],
    [288, 365],
  ]);
  assert.deepEqual(seasonDateSet(seasonScope({ months: null })), [[0, 365]]);
  assert.deepEqual(seasonDateSet(seasonScope({ from: '02-30', to: '03-01' })), []);

  // 28 February's next day is 29 February in a leap year and 1 March otherwise,
  // so both slots are possible.
  assert.deepEqual(shiftDateSet([[58, 58]]), [[59, 60]]);
  // 29 February's next day is only 1 March (no common-year instant exists).
  assert.deepEqual(shiftDateSet([[59, 59]]), [[60, 60]]);
  // 31 December wraps to 1 January.
  assert.deepEqual(shiftDateSet([[365, 365]]), [[0, 0]]);

  assert.equal(intersectDateSets([[0, 10]], [[10, 20]]), true);
  assert.equal(intersectDateSets([[0, 10]], [[11, 20]]), false);
  assert.equal(intersectDateSets([], [[0, 365]]), false);
});

test('adjacent date seasons pass and same-day or overlapping ones fail', () => {
  const summer = windowRow({ id: 'summer', months: null, from: '06-15', to: '09-15' });
  const winter = windowRow({ id: 'winter', months: null, from: '09-16', to: '06-14' });
  assert.equal(windowsOverlap(summer, winter), false);
  assert.equal(validateRateWindows([summer, winter]).valid, true);

  const sameDay = windowRow({ id: 'same-day', months: null, from: '09-15', to: '06-14' });
  assert.equal(windowsOverlap(summer, sameDay), true);
  const overlapping = windowRow({ id: 'overlap', months: null, from: '09-01', to: '10-01' });
  assert.equal(windowsOverlap(summer, overlapping), true);
  assert.equal(validateRateWindows([summer, overlapping]).valid, false);

  // The month hint on either row is irrelevant when both are date mode.
  const staleHint = windowRow({ id: 'stale', months: [1, 2], from: '09-16', to: '06-14' });
  assert.equal(windowsOverlap(summer, staleHint), false);
});

test('month and date scopes are compared on the same annual date sets', () => {
  const summer = windowRow({ id: 'summer', months: [6, 7, 8, 9], from: '06-15', to: '09-15' });
  assert.equal(windowsOverlap(summer, windowRow({ id: 'june', months: [6] })), true);
  assert.equal(windowsOverlap(summer, windowRow({ id: 'september', months: [9] })), true);
  assert.equal(windowsOverlap(summer, windowRow({ id: 'october', months: [10] })), false);
  // A date that the month set contains but the dates do not: no collision.
  const leapOnly = windowRow({ id: 'leap', months: null, from: '02-29', to: '02-29' });
  assert.equal(windowsOverlap(leapOnly, windowRow({ id: 'feb', months: [2] })), true);
  assert.equal(windowsOverlap(leapOnly, windowRow({ id: 'jan', months: [1] })), false);
  // Month adjacency is unchanged.
  assert.equal(
    windowsOverlap(
      windowRow({ months: [6, 7, 8, 9] }),
      windowRow({ months: [10, 11, 12, 1, 2, 3, 4, 5] }),
    ),
    false,
  );
});

test('the leap four-case table keeps tail/tail apart and main/tail together', () => {
  // Both are wrapping windows whose tails touch 1 March — in different year
  // types, so no instant has both.
  const leapTail = windowRow({
    id: 'leap-tail',
    months: null,
    from: '02-29',
    to: '02-29',
    start: '22:00',
    end: '06:00',
  });
  const commonTail = windowRow({
    id: 'common-tail',
    months: null,
    from: '02-28',
    to: '02-28',
    start: '22:00',
    end: '06:00',
  });
  assert.equal(windowsOverlap(leapTail, commonTail), false);
  assert.equal(validateRateWindows([leapTail, commonTail]).valid, true);

  // A 29 February main segment does meet the 28 February tail in a leap year.
  const leapMain = windowRow({
    id: 'leap-main',
    months: null,
    from: '02-29',
    to: '02-29',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(windowsOverlap(leapMain, commonTail), true);
  // A base plus an override may overlap: the override prices only its hours.
  assert.equal(validateRateWindows([leapMain, commonTail]).valid, true);
  assert.deepEqual(overlappingWindowPairs([leapMain, commonTail]), []);
  // Two bases covering the same date are still ambiguous.
  const secondBase = windowRow({
    id: 'second-base',
    months: null,
    from: '02-29',
    to: '02-29',
    start: '00:00',
    end: '00:00',
  });
  const baseClash = validateRateWindows([leapMain, secondBase]);
  assert.equal(baseClash.valid, false);
  assert.match(baseClash.errors.general.join(' '), /Base rates.*Keep one base per date/);

  // A 28 February main and a 29 February tail never meet: the tail's instant is
  // 1 March (leap) and the main is 28 February.
  assert.equal(windowsOverlap(commonTail, leapMain), true); // symmetric: commonTail's tail meets leapMain
  const feb28Main = windowRow({
    id: 'feb28-main',
    months: null,
    from: '02-28',
    to: '02-28',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(windowsOverlap(feb28Main, leapTail), false);
});

test('a season rate is an all-day row and overlaps every TOU window in its season', () => {
  const seasonRate = windowRow({
    id: 'season-rate',
    months: null,
    from: '06-15',
    to: '09-15',
    start: '00:00',
    end: '00:00',
  });
  const julyPeak = windowRow({
    id: 'july-peak',
    months: null,
    from: '07-01',
    to: '07-31',
    start: '16:00',
    end: '19:00',
  });
  const winterPeak = windowRow({
    id: 'winter-peak',
    months: null,
    from: '11-01',
    to: '12-31',
    start: '16:00',
    end: '19:00',
  });
  assert.equal(windowsOverlap(seasonRate, julyPeak), true);
  assert.equal(windowsOverlap(seasonRate, winterPeak), false);
  // A base plus an override is the supported model; the override wins for its
  // hours and the base covers the rest.
  const result = validateRateWindows([seasonRate, julyPeak]);
  assert.equal(result.valid, true);
  assert.deepEqual(overlappingWindowPairs([seasonRate, julyPeak]), []);
  // Two bases on the same date are rejected with a base-specific sentence.
  const secondBase = windowRow({
    id: 'second-base',
    months: null,
    from: '06-15',
    to: '09-15',
    start: '00:00',
    end: '00:00',
  });
  const baseClash = validateRateWindows([seasonRate, secondBase]);
  assert.equal(baseClash.valid, false);
  assert.match(baseClash.errors.general.join(' '), /Base rates.*Keep one base per date/);
  // Adjacent seasons with a season rate each pass.
  const winterRate = windowRow({
    id: 'winter-rate',
    months: null,
    from: '09-16',
    to: '06-14',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(validateRateWindows([seasonRate, winterRate]).valid, true);
});

test('two season-rate seasons partition the year with no fallback use', () => {
  const summer = windowRow({
    id: 'summer',
    rate: 0.2,
    months: null,
    from: '06-15',
    to: '09-15',
    start: '00:00',
    end: '00:00',
  });
  const winter = windowRow({
    id: 'winter',
    rate: 0.1,
    months: null,
    from: '09-16',
    to: '06-14',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(windowsOverlap(summer, winter), false);
  const schedule = { rate: 0.9, currency: 'USD', rates: [summer, winter] };
  let fallbackDays = 0;
  for (let index = 0; index < 366; index += 1) {
    if (rateAt(new Date(2024, 0, 1 + index, 12), schedule) === 0.9) fallbackDays += 1;
  }
  assert.equal(fallbackDays, 0);
  assert.equal(rateAt(date(2026, 6, 14, 23, 59), schedule), 0.1);
  assert.equal(rateAt(date(2026, 6, 15, 0, 0), schedule), 0.2);
  assert.equal(rateAt(date(2026, 9, 15, 23, 59), schedule), 0.2);
  assert.equal(rateAt(date(2026, 9, 16, 0, 0), schedule), 0.1);
});

test('date rows obey the 24-window cap and the last-match tie-break', () => {
  const dayRow = (index) =>
    windowRow({
      id: `day-${index}`,
      months: null,
      from: `01-${String(index + 1).padStart(2, '0')}`,
      to: `01-${String(index + 1).padStart(2, '0')}`,
    });
  const rows = Array.from({ length: MAX_RATE_WINDOWS + 1 }, (_, index) => dayRow(index));
  const result = validateRateWindows(rows);
  assert.equal(result.valid, false);
  assert.match(result.errors.general[0], new RegExp(String(MAX_RATE_WINDOWS)));
  // The first 24 are distinct single days, so only the cap is wrong.
  assert.equal(validateRateWindows(rows.slice(0, MAX_RATE_WINDOWS)).valid, true);

  // A hand-edited overlap is deterministic: the later date row wins.
  const monthRow = windowRow({ id: 'june', rate: 0.1, months: [6], start: '00:00', end: '00:00' });
  const dateRow = windowRow({
    id: 'june-late',
    rate: 0.2,
    months: null,
    from: '06-01',
    to: '06-30',
    start: '00:00',
    end: '00:00',
  });
  assert.equal(rateAt(date(2026, 6, 10, 12), { rate: 0.3, rates: [monthRow, dateRow] }), 0.2);
  assert.equal(rateAt(date(2026, 6, 10, 12), { rate: 0.3, rates: [dateRow, monthRow] }), 0.1);
});

test('windowSegments carries the season scope, including the tail', () => {
  const window = windowRow({
    months: null,
    from: '06-15',
    to: '09-15',
    days: [0],
    start: '22:00',
    end: '06:00',
  });
  const segments = windowSegments(window);
  assert.equal(segments.length, 2);
  const [main, tail] = segments;
  assert.equal(main.tail, undefined);
  assert.equal(tail.tail, true);
  assert.equal(tail.day, 1);
  assert.equal(main.season.kind, 'dates');
  assert.equal(main.season, tail.season);
  assert.equal(main.season.from, '06-15');
});

test('rateWindowsKey ignores the months hint in date mode but not the dates', () => {
  const summer = windowRow({ months: [6, 7, 8, 9], from: '06-15', to: '09-15' });
  const staleHint = windowRow({ months: [1, 2], from: '06-15', to: '09-15' });
  assert.equal(rateWindowsKey([summer]), rateWindowsKey([staleHint]));
  assert.notEqual(rateWindowsKey([summer]), rateWindowsKey([{ ...summer, from: '06-16' }]));
  // A month row still compares its months, and a blank date pair is absent.
  assert.notEqual(
    rateWindowsKey([windowRow({ months: [6] })]),
    rateWindowsKey([windowRow({ months: [7] })]),
  );
  assert.equal(
    rateWindowsKey([windowRow({ months: [6], from: '', to: '' })]),
    rateWindowsKey([windowRow({ months: [6], from: null, to: null })]),
  );
});

// ---------- date-mode costing ----------

test('costForInterval splits a session at a date-season edge', () => {
  const season = windowRow({
    id: 'summer',
    rate: 0.2,
    months: null,
    from: '06-15',
    to: '09-15',
    start: '00:00',
    end: '00:00',
  });
  const next = windowRow({
    id: 'winter',
    rate: 0.1,
    months: null,
    from: '09-16',
    to: '06-14',
    start: '00:00',
    end: '00:00',
  });
  const summerFirst = { rate: 0.9, rates: [season, next] };
  // 4 kWh over four hours across the edge: two hours at 0.2, two at 0.1.
  close(
    costForInterval(4000, date(2026, 9, 15, 22, 0), date(2026, 9, 16, 2, 0), summerFirst),
    0.4 + 0.2,
    'September edge',
  );
  close(
    costForInterval(4000, date(2026, 6, 14, 22, 0), date(2026, 6, 15, 2, 0), summerFirst),
    0.2 + 0.4,
    'June edge',
  );
});

test('costForInterval is leap-exact and follows a date-season tail over New Year', () => {
  // 29 February 2024 is one whole day of the 0.2 season.
  const leapOnly = windowRow({
    id: 'leap',
    rate: 0.2,
    months: null,
    from: '02-29',
    to: '02-29',
    start: '00:00',
    end: '00:00',
  });
  close(
    costForInterval(1000, date(2024, 2, 29, 0, 0), date(2024, 2, 29, 24, 0), {
      rate: 0.3,
      rates: [leapOnly],
    }),
    0.2,
    'leap day',
  );
  // The same day a year later does not exist; with no base the day is 0.
  close(
    costForInterval(1000, date(2025, 2, 28, 12, 0), date(2025, 2, 28, 13, 0), {
      rate: 0.3,
      rates: [leapOnly],
    }),
    0,
    'common year uncovered',
  );

  const december = windowRow({
    id: 'dec',
    rate: 0.1,
    months: [12],
    from: '12-01',
    to: '12-31',
    start: '22:00',
    end: '06:00',
  });
  // 31 December 23:00 → 1 January 02:00 is all 31 December's window.
  close(
    costForInterval(3000, date(2026, 12, 31, 23, 0), date(2027, 1, 1, 2, 0), {
      rate: 0.3,
      rates: [december],
    }),
    0.3,
    'New Year tail',
  );
});

test('a date-season window crosses the fall-back hour like a month window', () => {
  // 2026-11-01: 00:00 → 03:00 is four real hours. A season of Oct 15 – Apr 15
  // keeps its 01:00–02:00 window, which covers the repeated hour too.
  const winter = windowRow({
    months: null,
    from: '10-15',
    to: '04-15',
    start: '01:00',
    end: '02:00',
  });
  close(
    costForInterval(
      4000,
      date(2026, 11, 1, 0, 0),
      date(2026, 11, 1, 3, 0),
      withBase([winter], 0.3),
    ),
    0.8,
    'fall back inside a date season',
  );
});
