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
  normalizeRateSchedule,
  rateAt,
  validateRateWindows,
  windowMatches,
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

function close(actual, expected, message) {
  assert.ok(Number.isFinite(actual), `${message}: expected a number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}

test('the test process runs in a DST-observing local timezone', () => {
  assert.equal(date(2026, 1, 1).getTimezoneOffset(), 420); // MST, UTC-7
  assert.equal(date(2026, 7, 1).getTimezoneOffset(), 360); // MDT, UTC-6
});

// ---------- normalization ----------

test('normalizeRateSchedule keeps the flat fallback and drops invalid rows only', () => {
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

test('rateAt falls back to the flat rate and documents last-match precedence', () => {
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
  assert.equal(rateAt(date(2026, 10, 19, 20, 0), rate), 0.3);

  // A weekday window's post-midnight tail is priced on the next day.
  const mondayNight = schedule(
    [windowRow({ id: 'monday', rate: 0.1, days: [0], start: '22:00', end: '06:00' })],
    0.3,
  );
  assert.equal(rateAt(date(2026, 10, 20, 1, 0), mondayNight), 0.1);
  assert.equal(rateAt(date(2026, 10, 19, 1, 0), mondayNight), 0.3);
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
  const s = schedule([windowRow({ rate: 0.1, start: '22:00', end: '23:00' })], 0.3);
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
  const s = schedule([windowRow({ rate: 0.1, start: '22:00', end: '06:00' })], 0.3);
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
  const s = schedule([windowRow({ rate: 0.1, days: [0], start: '22:00', end: '06:00' })], 0.3);
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
  const s = schedule([windowRow({ rate: 0.1, months: [12], start: '22:00', end: '06:00' })], 0.3);
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
  const s = schedule([windowRow({ rate: 0.1, months: [12], start: '00:00', end: '00:00' })], 0.3);
  close(
    costForInterval(2000, date(2026, 12, 31, 23, 0), date(2027, 1, 1, 1, 0), s),
    0.4,
    'December to January',
  );
});

test('costForInterval splits at a weekday boundary', () => {
  // A Monday window (0 = Monday), 00:00–12:00.
  const s = schedule([windowRow({ rate: 0.1, days: [0], start: '00:00', end: '12:00' })], 0.3);
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

  const s = schedule([windowRow({ rate: 0.1, start: '00:00', end: '02:00' })], 0.3);
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

  const s = schedule([windowRow({ rate: 0.1, start: '01:00', end: '02:00' })], 0.3);
  // 4 kWh over four hours: 1 h fallback + 2 h window + 1 h fallback.
  close(costForInterval(4000, start, end, s), 0.8, 'fall back');
});

test('costForInterval returns null for unusable inputs', () => {
  const s = schedule([windowRow()], 0.3);
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
  assert.equal(
    costForInterval(1000, start, date(2026, 10, 19, 13, 0), {
      rates: [windowRow({ start: '22:00', end: '23:00' })],
    }),
    null,
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
  const s = schedule([windowRow({ rate: 0.1, start: '22:00', end: '23:00' })], 0.3);
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
