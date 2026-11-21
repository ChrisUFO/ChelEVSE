import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHART_VIEW_W,
  DEFAULT_PERIOD,
  PERIODS,
  SESSIONS_LOOKBACK_DAYS,
  chartIndexAt,
  dayId,
  dayIdsInRange,
  dayLabel,
  dayStartFromId,
  historyReadState,
  historySeries,
  hourId,
  hourRange,
  hourReadFailure,
  hourReadState,
  hourSeries,
  maxSeries,
  monthId,
  monthIdsInRange,
  monthLabel,
  periodAnchor,
  periodBounds,
  periodById,
  periodSeries,
  periodSpan,
  sectionView,
  sessionsRange,
  sumSeries,
} from '../../web/js/history.js';
import {
  coverageDisclosure,
  pointCostSummary,
  seriesCostSummary,
  seriesWindowUncovered,
  showPlanBanner,
} from '../../web/js/screens/history.js';
import { sessionCostLabel, sessionIntervalsValid } from '../../web/js/cost.js';

test('dayId uses local calendar components', () => {
  assert.equal(dayId(new Date(2026, 0, 5, 12)), '2026-01-05');
  assert.equal(dayId(new Date(2026, 11, 31, 23)), '2026-12-31');
  // The id is the parser's format at every year: four digits, so a deep-paged
  // year round-trips through dayStartFromId and the window's lexicographic
  // comparisons still order it instead of reading '826-01-01' as a bad id.
  assert.equal(dayId(new Date(826, 0, 1, 12)), '0826-01-01');
  assert.deepEqual(dayStartFromId(dayId(new Date(826, 0, 1, 12))), new Date(826, 0, 1));
  assert.equal(monthId(new Date(826, 0, 1, 12)), '0826-01');
  assert.equal(monthLabel(monthId(new Date(826, 0, 1, 12))), 'Jan 0826');
});

test('dayIdsInRange walks the inclusive calendar between two day ids', () => {
  const ids = dayIdsInRange('2026-09-19', '2026-10-18');
  assert.equal(ids.length, 30);
  assert.equal(ids[0], '2026-09-19');
  assert.equal(ids[29], '2026-10-18');
  assert.deepEqual(dayIdsInRange('2026-10-16', '2026-10-18'), [
    '2026-10-16',
    '2026-10-17',
    '2026-10-18',
  ]);
  assert.equal(new Set(ids).size, 30);
  // One day is one id; a reversed range is no days; a malformed id is no range
  // rather than an unparsable walk.
  assert.deepEqual(dayIdsInRange('2026-10-18', '2026-10-18'), ['2026-10-18']);
  assert.deepEqual(dayIdsInRange('2026-10-18', '2026-10-17'), []);
  assert.deepEqual(dayIdsInRange('nope', '2026-10-18'), []);
  assert.deepEqual(dayIdsInRange('2026-02-31', '2026-03-02'), []);
  // A month bucket range is the months the days touch, oldest first.
  assert.deepEqual(monthIdsInRange('2026-01-01', '2026-03-31'), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(monthIdsInRange('2026-10-01', '2026-10-18'), ['2026-10']);
  assert.deepEqual(monthIdsInRange('2025-12-31', '2026-01-01'), ['2025-12', '2026-01']);
  assert.deepEqual(monthIdsInRange('2026-10-18', '2026-10-17'), []);
  assert.deepEqual(monthIdsInRange('nope', '2026-10-18'), []);
});

test('calendar ranges stay on local calendar days across a DST change (fixed America/Denver)', () => {
  // Run in a child with a fixed TZ so both 2026 shifts are exercised on every
  // host (a UTC runner would otherwise pass without a DST transition): Denver
  // springs forward at 02:00 on Sunday 8 March (420 → 360) and falls back at
  // 02:00 on Sunday 1 November (360 → 420).
  const moduleUrl = new URL('../../web/js/history.js', import.meta.url).href;
  const script = `
    import { dayIdsInRange, hourSeries, periodBounds, periodSeries, sumSeries } from ${JSON.stringify(moduleUrl)};
    const fail = (what, got) => {
      console.error(what, JSON.stringify(got));
      process.exit(1);
    };
    // Guard against a host whose tzdata lacks America/Denver.
    for (const [month, day, offset] of [[3, 7, 420], [3, 8, 360], [10, 31, 360], [11, 1, 420]]) {
      const got = new Date(2026, month - 1, day, 12).getTimezoneOffset();
      if (got !== offset) fail('unexpected offset ' + month + '/' + day, got);
    }
    // A midnight fixture also catches millisecond arithmetic across the shift.
    const now = new Date(2026, 2, 9, 0, 30);
    const week = periodBounds('week', now, now);
    if (JSON.stringify(week) !== JSON.stringify({ startId: '2026-03-09', endId: '2026-03-09' })) {
      fail('week bounds', week);
    }
    // The ISO week containing each shift is seven consecutive local dates — one
    // per local day: an epoch or millisecond step would repeat 1 November (the
    // 25-hour day) or drop 8 March (the 23-hour one).
    const spring = dayIdsInRange('2026-03-02', '2026-03-08');
    const springExpected = [
      '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05',
      '2026-03-06', '2026-03-07', '2026-03-08',
    ];
    if (JSON.stringify(spring) !== JSON.stringify(springExpected)) fail('spring week', spring);
    const fall = dayIdsInRange('2026-10-26', '2026-11-01');
    const fallExpected = [
      '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29',
      '2026-10-30', '2026-10-31', '2026-11-01',
    ];
    if (JSON.stringify(fall) !== JSON.stringify(fallExpected)) fail('fall week', fall);
    // The same walk drives the Week chart's bars: the 25-hour day is one bar, and
    // it carries its own document rather than a neighbour's.
    const anchor = new Date(2026, 10, 1, 12);
    const bars = periodSeries('week', [{ id: '2026-10-26', kwh: 1 }, { id: '2026-11-01', kwh: 2 }], anchor, new Date(2026, 10, 1, 23));
    if (JSON.stringify(bars.map((point) => point.id)) !== JSON.stringify(fallExpected)) {
      fail('fall week bars', bars.map((point) => point.id));
    }
    if (JSON.stringify(bars.map((point) => point.kwh)) !== JSON.stringify([1, 0, 0, 0, 0, 0, 2])) {
      fail('fall week kwh', bars.map((point) => point.kwh));
    }
    // Hour buckets are keyed by the local hour, so the repeated 01:00 of a
    // fall-back day lands in the same '01' bucket (it collapses rather than
    // adding a 25th bar) and the missing 02:00 of a spring-forward day is still
    // one bucket (nothing is dropped). Either way the Day chart is 24 bars and
    // no energy is counted twice.
    for (const [what, day] of [['fall back', new Date(2026, 10, 1, 12)], ['spring forward', new Date(2026, 2, 8, 12)]]) {
      const hours = hourSeries({ '01': 1, '02': 2 }, day, day);
      const ids = hours.map((point) => point.id);
      if (ids.length !== 24 || new Set(ids).size !== 24 || ids[0] !== '00' || ids[23] !== '23') {
        fail('hour buckets ' + what, ids);
      }
      if (sumSeries(hours) !== 3) fail('hour bucket total ' + what, sumSeries(hours));
    }
    // A month range is its own calendar length, whichever side of the shift.
    const month = periodBounds('month', new Date(2026, 2, 1, 12), new Date(2026, 3, 2, 12));
    if (JSON.stringify(month) !== JSON.stringify({ startId: '2026-03-01', endId: '2026-03-31' })) {
      fail('month bounds', month);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, TZ: 'America/Denver' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('dayId uses local calendar components under UTC+14', () => {
  // Kiritimati's local 00:30 on 1 Jan is still 31 Dec in UTC; a getUTC*-based
  // implementation would return the previous day.
  const moduleUrl = new URL('../../web/js/history.js', import.meta.url).href;
  const script = `
    import { dayId } from ${JSON.stringify(moduleUrl)};
    if (new Date(2026, 0, 1, 0, 30).getTimezoneOffset() !== -840) {
      console.error('unexpected offset', new Date(2026, 0, 1, 0, 30).getTimezoneOffset());
      process.exit(1);
    }
    if (dayId(new Date(2026, 0, 1, 0, 30)) !== '2026-01-01') {
      console.error(dayId(new Date(2026, 0, 1, 0, 30)));
      process.exit(1);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, TZ: 'Pacific/Kiritimati' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PERIODS describes every chart range as data', () => {
  // The contract #61 extends and #155 re-baselines: one descriptor per range, and
  // the chart reads the series length rather than any period-specific slots.
  assert.deepEqual(
    PERIODS.map((period) => period.id),
    ['day', 'week', 'month', 'year'],
  );
  assert.equal(DEFAULT_PERIOD, 'month');
  // `unit` is the calendar unit the window covers and pages by. A window's length
  // is not data: it comes from the calendar (28–31 days in a month, January..this
  // month in the current year), so a descriptor that carried a slot count would
  // be the rolling window coming back.
  assert.deepEqual(Object.fromEntries(PERIODS.map((period) => [period.id, period.unit])), {
    day: 'day',
    week: 'week',
    month: 'month',
    year: 'year',
  });
  // `source` decides the read (one day document or a day-id range) and `bucket`
  // the series derivation; both are data, so the screen has no period-id branch.
  assert.deepEqual(Object.fromEntries(PERIODS.map((period) => [period.id, period.source])), {
    day: 'day',
    week: 'range',
    month: 'range',
    year: 'range',
  });
  assert.deepEqual(Object.fromEntries(PERIODS.map((period) => [period.id, period.bucket])), {
    day: 'hour',
    week: 'day',
    month: 'day',
    year: 'month',
  });
  for (const period of PERIODS) {
    // The key set is the contract: every field has a consumer and a field that
    // has none — a descriptor `slots`, `span` or `step` — would be a second
    // naming or arithmetic source the suite could not see being re-added.
    assert.deepEqual(
      Object.keys(period).sort(),
      ['bucket', 'copy', 'id', 'noun', 'source', 'unit'],
      period.id,
    );
    assert.equal(typeof period.noun, 'string', `${period.id}.noun`);
    assert.ok(period.noun.length > 0, `${period.id}.noun`);
    // One copy(span) per period is the single source of every string that names
    // the window — the descriptors hold no second copy table.
    assert.equal(typeof period.copy, 'function', `${period.id}.copy`);
    const copy = period.copy(periodSpan(period.id));
    for (const key of ['chartLabel', 'emptyTitle', 'emptyLine', 'loadingLine', 'offlineLine']) {
      assert.equal(typeof copy[key], 'string', `${period.id}.${key}`);
      assert.ok(copy[key].length > 0, `${period.id}.${key}`);
      // A template that forgot the span would leak this into the UI.
      assert.doesNotMatch(copy[key], /undefined|\[object Object\]/, `${period.id}.${key}`);
    }
  }
  // Only a day without hourly buckets uses the "no intraday detail" copy.
  const day = periodById('day');
  for (const key of ['noIntradayTitle', 'noIntradayLine']) {
    assert.equal(typeof day.copy(periodSpan('day'))[key], 'string', `day.${key}`);
    assert.ok(day.copy(periodSpan('day'))[key].length > 0, `day.${key}`);
  }
  for (const period of PERIODS.filter((candidate) => candidate.source !== 'day')) {
    assert.equal(period.copy(periodSpan(period.id)).noIntradayTitle, undefined, period.id);
  }
  assert.equal(periodById('year'), PERIODS[3]);
  // Unknown ids fall back to today's default, never to an unrelated range.
  assert.equal(periodById('nope').id, DEFAULT_PERIOD);
});

// The current calendar unit's wording, byte for byte, with the clock frozen on
// Sunday 18 October 2026. One register per period: offset 0 is named as the unit
// it is, so these strings are pinned as literals here rather than compared with
// the implementation.
// Date spans glue their runs with hard spaces; compare painted copy as text.
const plain = (text) => text.replace(/\u00a0/g, ' ');

const DEFAULT_COPY = {
  day: {
    label: 'Sun 18 Oct 2026',
    phrase: 'Sunday 18 October 2026',
    chartLabel:
      'Hourly energy for Sunday 18 October 2026. Use the left and right arrow keys to move between hours.',
    emptyTitle: 'No energy recorded on Sunday 18 October 2026.',
    emptyLine: 'Hours appear as charging is recorded.',
    noIntradayTitle: 'No hourly detail for Sunday 18 October 2026.',
    noIntradayLine:
      'Hourly capture began recently, so Sunday 18 October 2026 has a total but no hours behind it.',
    loadingLine: 'Reading Sunday 18 October 2026.',
    offlineLine: 'Reconnect, then tap Refresh to load the hours for Sunday 18 October 2026.',
  },
  week: {
    label: 'Mon 12 – Sun 18 Oct 2026',
    phrase: 'the week of Monday 12 – Sunday 18 October 2026',
    chartLabel:
      'Daily energy for the week of Monday 12 – Sunday 18 October 2026. Use the left and right arrow keys to move between days.',
    emptyTitle: 'No energy recorded in the week of Monday 12 – Sunday 18 October 2026.',
    emptyLine: 'Days without charging count as zero.',
    loadingLine: 'Reading the week of Monday 12 – Sunday 18 October 2026.',
    offlineLine:
      'Reconnect, then tap Refresh to load the energy for the week of Monday 12 – Sunday 18 October 2026.',
  },
  month: {
    label: 'October 2026',
    phrase: 'October 2026',
    chartLabel:
      'Daily energy for October 2026. Use the left and right arrow keys to move between days.',
    emptyTitle: 'No energy recorded in October 2026.',
    emptyLine: 'Days without charging count as zero.',
    loadingLine: 'Reading October 2026.',
    offlineLine: 'Reconnect, then tap Refresh to load the energy for October 2026.',
  },
  year: {
    label: '2026',
    phrase: '2026',
    chartLabel:
      'Monthly energy for 2026. Use the left and right arrow keys to move between months.',
    emptyTitle: 'No energy recorded in 2026.',
    emptyLine: 'Months without charging count as zero.',
    loadingLine: 'Reading 2026.',
    offlineLine: 'Reconnect, then tap Refresh to load the energy for 2026.',
  },
};

test('the current calendar unit is the only copy register', () => {
  const now = new Date(2026, 9, 18, 12);
  for (const period of PERIODS) {
    const want = DEFAULT_COPY[period.id];
    const span = periodSpan(period.id, periodAnchor(period.id, 0, now), now);
    // No `isDefault`: the default view is named as the calendar unit it is. The
    // key set is the contract on this side too — a second register flag would be
    // a second naming source the screen could read.
    assert.deepEqual(Object.keys(span).sort(), ['label', 'phrase'], period.id);
    assert.deepEqual(
      { label: plain(span.label), phrase: plain(span.phrase) },
      { label: want.label, phrase: want.phrase },
      period.id,
    );
    const { chartLabel, emptyTitle, emptyLine, loadingLine, offlineLine, ...rest } =
      period.copy(span);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries({ chartLabel, emptyTitle, emptyLine, loadingLine, offlineLine }).map(
          ([key, text]) => [key, plain(text)],
        ),
      ),
      {
        chartLabel: want.chartLabel,
        emptyTitle: want.emptyTitle,
        emptyLine: want.emptyLine,
        loadingLine: want.loadingLine,
        offlineLine: want.offlineLine,
      },
      period.id,
    );
    if (period.source === 'day') {
      assert.deepEqual(
        Object.fromEntries(Object.entries(rest).map(([key, text]) => [key, plain(text)])),
        {
          noIntradayTitle: want.noIntradayTitle,
          noIntradayLine: want.noIntradayLine,
        },
      );
    } else {
      assert.deepEqual(rest, {}, period.id);
    }
  }
  // A unit's name is a function of the unit alone: any hour of the clock's own
  // date names the same month, and yesterday's month is a different unit.
  assert.equal(plain(periodSpan('month', new Date(2026, 9, 18, 0, 5), now).label), 'October 2026');
  assert.equal(
    plain(periodSpan('month', new Date(2026, 9, 18, 23, 55), now).label),
    'October 2026',
  );
  assert.equal(
    plain(periodSpan('month', new Date(2026, 8, 17, 23, 55), now).label),
    'September 2026',
  );
  // The same for a whole year: a date inside it names it, whatever the month.
  assert.equal(periodSpan('year', new Date(2026, 0, 5, 12), now).label, '2026');
});

test('periodAnchor steps back one calendar unit per period', () => {
  const now = new Date(2026, 9, 18, 12);
  assert.equal(dayId(periodAnchor('day', 0, now)), '2026-10-18');
  assert.equal(dayId(periodAnchor('day', 1, now)), '2026-10-17');
  assert.equal(dayId(periodAnchor('day', 3, now)), '2026-10-15');
  // Week steps a whole ISO week and lands on its Monday, so paging cannot skip a
  // day: offset 1 is the Monday before this week's.
  assert.equal(dayId(periodAnchor('week', 1, now)), '2026-10-05');
  assert.equal(dayId(periodAnchor('week', 2, now)), '2026-09-28');
  // Month steps one calendar month and lands on its 1st, so a 31st anchor can
  // never be carried into a shorter month.
  assert.equal(dayId(periodAnchor('month', 1, now)), '2026-09-01');
  assert.equal(dayId(periodAnchor('month', 2, now)), '2026-08-01');
  assert.equal(dayId(periodAnchor('month', 1, new Date(2026, 2, 31, 12))), '2026-02-01');
  // January's previous month is the December before it, not a clamped January:
  // the step crosses the year boundary in one unit.
  assert.equal(dayId(periodAnchor('month', 1, new Date(2026, 0, 15, 12))), '2025-12-01');
  // Year steps one calendar year and lands on 1 January — a leap day included.
  assert.equal(dayId(periodAnchor('year', 1, now)), '2025-01-01');
  assert.equal(dayId(periodAnchor('year', 3, now)), '2023-01-01');
  assert.equal(dayId(periodAnchor('year', 1, new Date(2028, 1, 29, 12))), '2027-01-01');
  // Offset 0 is a copy of the clock, never the caller's Date object.
  const zero = periodAnchor('month', 0, now);
  assert.equal(zero.getTime(), now.getTime());
  assert.notEqual(zero, now);
  // A negative or garbage offset is the present, never a future window.
  assert.equal(dayId(periodAnchor('month', -1, now)), '2026-10-18');
  assert.equal(dayId(periodAnchor('month', Number.NaN, now)), '2026-10-18');
  // A descriptor works as well as an id — the screen passes the descriptor.
  assert.equal(
    periodAnchor(periodById('week'), 1, now).getTime(),
    periodAnchor('week', 1, now).getTime(),
  );
});

test('a completed month is its own calendar length, whatever the clock', () => {
  // Every case below is behind this clock, so each is a completed month.
  const now = new Date(2029, 0, 15, 12);
  // 28, 29, 30 and 31: a February in a common and in a leap year, an April and a
  // past October. The series length *is* the calendar length — that is what
  // "one bar per day 1..end" means, and no slot constant decides it.
  const cases = [
    [2026, 1, 28, 'February 2026'],
    [2028, 1, 29, 'February 2028'],
    [2026, 3, 30, 'April 2026'],
    [2025, 9, 31, 'October 2025'],
    // December is its own calendar month, the far side of January's step.
    [2025, 11, 31, 'December 2025'],
  ];
  for (const [year, month, days, label] of cases) {
    const anchor = new Date(year, month, 1, 12);
    const pad = (value) => String(value).padStart(2, '0');
    const firstId = `${year}-${pad(month + 1)}-01`;
    const lastId = `${year}-${pad(month + 1)}-${pad(days)}`;
    assert.deepEqual(
      periodBounds('month', anchor, now),
      { startId: firstId, endId: lastId },
      label,
    );
    assert.equal(dayIdsInRange(firstId, lastId).length, days, label);
    const points = periodSeries('month', [], anchor, now);
    assert.equal(points.length, days, label);
    assert.equal(points[0].id, firstId, label);
    assert.equal(points[days - 1].id, lastId, label);
    assert.equal(
      points.some((point) => point.isCurrent),
      false,
      label,
    );
    assert.equal(plain(periodSpan('month', anchor, now).label), label);
  }
  // The month that holds the clock is clipped at today instead: 1..18 here.
  const today = new Date(2026, 9, 18, 12);
  assert.deepEqual(periodBounds('month', today, today), {
    startId: '2026-10-01',
    endId: '2026-10-18',
  });
  assert.equal(periodSeries('month', [], today, today).length, 18);
});

test('periodAnchor keeps the local calendar across month ends and leap years', () => {
  // A month step lands on the 1st of the month it names, so a 31st can never be
  // carried into a shorter month: 31 March back one month is 1 February, and the
  // window that follows is February's own 28 days.
  const march31 = new Date(2026, 2, 31, 12);
  assert.equal(dayId(periodAnchor('month', 1, march31)), '2026-02-01');
  assert.deepEqual(periodBounds('month', periodAnchor('month', 1, march31), march31), {
    startId: '2026-02-01',
    endId: '2026-02-28',
  });
  // …and in a leap year that window is 29 days.
  const leap = new Date(2028, 1, 29, 12);
  assert.deepEqual(periodBounds('month', periodAnchor('month', 1, leap), leap), {
    startId: '2028-01-01',
    endId: '2028-01-31',
  });
  // A year step off 29 February is the previous calendar year, whole — 29
  // February can never orphan a day between two year windows.
  assert.deepEqual(periodBounds('year', periodAnchor('year', 1, leap), leap), {
    startId: '2027-01-01',
    endId: '2027-12-31',
  });
  // Consecutive year windows share no day and skip none: 2026 ends 31 December
  // and 2027 begins 1 January.
  assert.deepEqual(
    periodBounds(
      'year',
      periodAnchor('year', 1, new Date(2027, 5, 4, 12)),
      new Date(2027, 5, 4, 12),
    ),
    {
      startId: '2026-01-01',
      endId: '2026-12-31',
    },
  );
});

test('periodAnchor stays on local calendar days across a DST change (fixed America/Denver)', () => {
  // Same child-process pattern as the range test: a UTC runner must still
  // exercise the spring-forward boundary, and a 00:30 fixture catches midnight
  // arithmetic.
  const moduleUrl = new URL('../../web/js/history.js', import.meta.url).href;
  const script = `
    import { dayId, periodAnchor, periodBounds } from ${JSON.stringify(moduleUrl)};
    if (new Date(2026, 2, 9, 12).getTimezoneOffset() !== 360) {
      console.error('unexpected offset', new Date(2026, 2, 9, 12).getTimezoneOffset());
      process.exit(1);
    }
    const now = new Date(2026, 2, 9, 0, 30);
    // The clock is on the Monday after the shift; one week back is the whole
    // Monday–Sunday week that contains the transition.
    const week = periodAnchor('week', 1, now);
    if (dayId(week) !== '2026-03-02') {
      console.error('week anchor', dayId(week));
      process.exit(1);
    }
    const bounds = periodBounds('week', week, now);
    if (JSON.stringify(bounds) !== JSON.stringify({ startId: '2026-03-02', endId: '2026-03-08' })) {
      console.error('week bounds', JSON.stringify(bounds));
      process.exit(1);
    }
    // A day step off the clock is the local date before it, 23 hours long.
    if (dayId(periodAnchor('day', 1, now)) !== '2026-03-08') {
      console.error('day anchor', dayId(periodAnchor('day', 1, now)));
      process.exit(1);
    }
    // A month step is the calendar month, whose 31 days include the 23-hour day.
    if (dayId(periodAnchor('month', 1, now)) !== '2026-02-01') {
      console.error('month anchor', dayId(periodAnchor('month', 1, now)));
      process.exit(1);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, TZ: 'America/Denver' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('consecutive windows neither overlap nor leave a gap', () => {
  const now = new Date(2026, 9, 18, 12);
  const before = (window) => {
    const date = new Date(`${window.startId}T12:00:00`);
    date.setDate(date.getDate() - 1);
    return dayId(date);
  };
  // Every period is a contiguous day-id range: the earlier window's last day is
  // the day before the later window's first day. That is the whole calendar
  // claim — October is followed by 1 September, 2026 by 2025, this week by the
  // Monday before it.
  for (const period of ['day', 'week', 'month', 'year']) {
    for (const offset of [0, 1, 2, 3]) {
      const later = periodBounds(period, periodAnchor(period, offset, now), now);
      const earlier = periodBounds(period, periodAnchor(period, offset + 1, now), now);
      assert.equal(
        earlier.endId,
        before(later),
        `${period} offset ${offset + 1} ends where offset ${offset} begins`,
      );
      // No id is drawn twice, and a window that lost its newest bucket would
      // still pass adjacency, so the last bucket is pinned against the bounds.
      const ids = periodSeries(period, [], periodAnchor(period, offset, now), now).map(
        (point) => point.id,
      );
      const descriptor = periodById(period);
      assert.equal(new Set(ids).size, ids.length, `${period} offset ${offset}`);
      assert.ok(ids.length > 0, `${period} offset ${offset}`);
      if (descriptor.bucket === 'month') {
        assert.equal(ids.at(-1), later.endId.slice(0, 7), `${period} offset ${offset}`);
      } else if (descriptor.bucket === 'day') {
        assert.equal(ids.at(-1), later.endId, `${period} offset ${offset}`);
      } else {
        // The Day period's slots are hours: 00–23 for its one date.
        assert.equal(ids.length, 24, `${period} offset ${offset}`);
      }
    }
  }
});

test('the current year runs January to this month and a completed year all twelve', () => {
  const now = new Date(2026, 10, 16, 12); // November 2026
  // Current year: no December, no zero-padded tail — the window ends where the
  // present is.
  assert.deepEqual(periodBounds('year', now, now), {
    startId: '2026-01-01',
    endId: '2026-11-16',
  });
  const current = periodSeries('year', [], now, now);
  assert.deepEqual(
    current.map((point) => point.id),
    [
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ],
  );
  assert.equal(
    current.some((point) => point.id === '2026-12'),
    false,
  );
  // The newest bucket is the partial current month, marked as it always was.
  assert.deepEqual(
    current.filter((point) => point.isCurrent).map((point) => point.id),
    ['2026-11'],
  );
  assert.equal(periodSpan('year', now, now).label, '2026');

  // A completed year is all twelve months, whatever month the clock is in.
  const past = new Date(2025, 0, 1, 12);
  assert.deepEqual(periodBounds('year', past, now), {
    startId: '2025-01-01',
    endId: '2025-12-31',
  });
  const completed = periodSeries('year', [], past, now);
  assert.equal(completed.length, 12);
  assert.equal(completed[0].id, '2025-01');
  assert.equal(completed[11].id, '2025-12');
  assert.equal(
    completed.some((point) => point.isCurrent),
    false,
  );
  // A fully recorded completed year sums every day of its months: 365 daily
  // documents across twelve bars, each bar its own month's length.
  const docs = [];
  const day = new Date(2025, 0, 1, 12);
  while (day.getFullYear() === 2025) {
    docs.push({ id: dayId(day), kwh: 1 });
    day.setDate(day.getDate() + 1);
  }
  const summed = periodSeries('year', docs, past, now);
  assert.equal(sumSeries(summed), 365);
  assert.equal(summed[1].kwh, 28); // February 2025
  assert.equal(summed[0].kwh, 31); // January
});

test('a completed leap year is 366 days across twelve months', () => {
  const now = new Date(2029, 0, 5, 12);
  const leap = new Date(2028, 0, 1, 12);
  assert.deepEqual(periodBounds('year', leap, now), {
    startId: '2028-01-01',
    endId: '2028-12-31',
  });
  const docs = [];
  const day = new Date(2028, 0, 1, 12);
  while (day.getFullYear() === 2028) {
    docs.push({ id: dayId(day), kwh: 1 });
    day.setDate(day.getDate() + 1);
  }
  assert.equal(docs.length, 366);
  const series = periodSeries('year', docs, leap, now);
  assert.equal(series.length, 12);
  assert.equal(sumSeries(series), 366);
  assert.equal(series[1].kwh, 29); // February 2028
  assert.equal(series[2].kwh, 31); // March proves 29 February did not shift a bar
});

test('periodSpan names the calendar unit each period stands for', () => {
  const now = new Date(2026, 9, 18, 12);
  // The title register the summary label paints: short months — the vocabulary
  // the chart's own bar labels use — with the year kept.
  const title = (span) => plain(span.label);
  // Every date run is glued, so only a week has one break opportunity — the
  // space after the dash — and a single date has none. A year never lands on a
  // line of its own.
  const breakable = (span) => span.label.split(' ').length - 1;
  // Day: one calendar date, named like the bar it draws.
  const day = periodSpan('day', periodAnchor('day', 1, now), now);
  assert.equal(title(day), 'Sat 17 Oct 2026');
  assert.equal(breakable(day), 0);
  // The prose register the sentences use spells the weekday and month out.
  assert.equal(plain(day.phrase), 'Saturday 17 October 2026');
  // Week: both ends of the ISO week, with the month collapsed when they share it.
  const week = periodSpan('week', periodAnchor('week', 1, now), now);
  assert.equal(title(week), 'Mon 5 – Sun 11 Oct 2026');
  assert.equal(plain(week.phrase), 'the week of Monday 5 – Sunday 11 October 2026');
  assert.equal(breakable(week), 1);
  // A week that crosses a month end names both months…
  assert.equal(
    title(periodSpan('week', new Date(2026, 8, 28, 12), now)),
    'Mon 28 Sep – Sun 4 Oct 2026',
  );
  // …and one that crosses a year end names both years, still as one week.
  assert.equal(
    title(periodSpan('week', new Date(2026, 0, 2, 12), now)),
    'Mon 29 Dec 2025 – Sun 4 Jan 2026',
  );
  // Month: the month itself, spelled out — the issue's "October 2026".
  const month = periodSpan('month', periodAnchor('month', 1, now), now);
  assert.equal(title(month), 'September 2026');
  assert.equal(plain(month.phrase), 'September 2026');
  assert.equal(breakable(month), 0);
  // Paged past January, the month is the December before it — named by its own
  // year, so a step across the year end cannot be mistaken for a January window.
  assert.equal(title(periodSpan('month', new Date(2025, 11, 5, 12), now)), 'December 2025');
  // Year: the year itself.
  const year = periodSpan('year', periodAnchor('year', 1, now), now);
  assert.equal(title(year), '2025');
  assert.equal(plain(year.phrase), '2025');
  assert.equal(breakable(year), 0);
  // The unit holding the clock is named as the current unit, not by a second
  // register.
  assert.equal(title(periodSpan('month', now, now)), 'October 2026');
  assert.equal(title(periodSpan('year', now, now)), '2026');
  // A clipped current week is named by the days it actually draws.
  assert.equal(title(periodSpan('week', now, now)), 'Mon 12 – Sun 18 Oct 2026');
  const wednesday = new Date(2026, 9, 14, 12);
  assert.equal(title(periodSpan('week', wednesday, wednesday)), 'Mon 12 – Wed 14 Oct 2026');
  // On its Monday the clipped week is one day, so it is named once: both ends
  // would otherwise say the same date twice ("Mon 12 – Mon 12 Oct 2026").
  const monday = new Date(2026, 9, 12, 12);
  const oneDay = periodSpan('week', monday, monday);
  assert.equal(title(oneDay), 'Mon 12 Oct 2026');
  assert.equal(plain(oneDay.phrase), 'the week of Monday 12 October 2026');
  assert.equal(breakable(oneDay), 0);
  // A completed week is always seven days, so only the clipped one can collapse.
  assert.equal(
    title(periodSpan('week', periodAnchor('week', 1, monday), monday)),
    'Mon 5 – Sun 11 Oct 2026',
  );
});

test('paged copy names its span and never claims the window is now', () => {
  const now = new Date(2026, 9, 18, 12);
  // Every rolling-window word #155 removes — including the phrase itself, which
  // this guard is named for — plus the words that would claim a paged window is
  // the present one. A calendar unit's own name is the only way to describe it.
  const banned = [
    /today/i,
    /last 7 days/i,
    /last 30 days/i,
    /last 12 months/i,
    /\brolling\b/i,
    /(this|current) month/i,
    /\byesterday\b/i,
  ];
  // `emptyLine` names no window at all ("Days without charging count as zero"),
  // so it is held to the banned-word rule only; every other string describes
  // the window and must name this one.
  const describesWindow = ['chartLabel', 'emptyTitle', 'loadingLine', 'offlineLine'];
  for (const period of PERIODS) {
    for (const offset of [1, 2, 3]) {
      const span = periodSpan(period.id, periodAnchor(period.id, offset, now), now);
      const copy = period.copy(span);
      for (const [key, text] of Object.entries(copy)) {
        for (const pattern of banned) {
          assert.doesNotMatch(text, pattern, `${period.id} offset ${offset} ${key}`);
        }
      }
      for (const key of [
        ...describesWindow,
        ...(period.source === 'day' ? ['noIntradayTitle', 'noIntradayLine'] : []),
      ]) {
        assert.ok(
          copy[key].includes(span.phrase),
          `${period.id} offset ${offset} ${key} names the span: ${copy[key]}`,
        );
      }
    }
  }
  // A past Day says which date it is empty for.
  const daySpan = periodSpan('day', periodAnchor('day', 1, now), now);
  assert.equal(
    plain(periodById('day').copy(daySpan).emptyTitle),
    'No energy recorded on Saturday 17 October 2026.',
  );
  // A past month names the month and reuses none of the rolling-window copy.
  const monthSpan = periodSpan('month', periodAnchor('month', 1, now), now);
  assert.equal(
    plain(periodById('month').copy(monthSpan).offlineLine),
    'Reconnect, then tap Refresh to load the energy for September 2026.',
  );
  assert.equal(
    plain(periodById('month').copy(monthSpan).emptyTitle),
    'No energy recorded in September 2026.',
  );
  // A past year names the year; an empty one reports zero in its own words.
  const yearSpan = periodSpan('year', periodAnchor('year', 1, now), now);
  assert.equal(plain(periodById('year').copy(yearSpan).emptyTitle), 'No energy recorded in 2025.');
  assert.equal(
    plain(periodById('year').copy(yearSpan).offlineLine),
    'Reconnect, then tap Refresh to load the energy for 2025.',
  );
  // A past week names both of its ends, one week — not seven days.
  const weekSpan = periodSpan('week', periodAnchor('week', 1, now), now);
  assert.equal(
    plain(periodById('week').copy(weekSpan).emptyTitle),
    'No energy recorded in the week of Monday 5 – Sunday 11 October 2026.',
  );
});

test('periodBounds returns one contiguous local range for each period', () => {
  const today = new Date(2026, 9, 18, 12);
  // The Day period has no range: its window is exactly today, which is also the
  // document its single read targets and the day the midnight guard compares.
  assert.deepEqual(periodBounds('day', today), {
    startId: '2026-10-18',
    endId: '2026-10-18',
  });
  // Week is the ISO Monday–Sunday week, Month the calendar month, Year the
  // calendar year — each clipped at today, which is Sunday 18 October here.
  assert.deepEqual(periodBounds('week', today), {
    startId: '2026-10-12',
    endId: '2026-10-18',
  });
  assert.deepEqual(periodBounds('month', today), {
    startId: '2026-10-01',
    endId: '2026-10-18',
  });
  assert.deepEqual(periodBounds('year', today), {
    startId: '2026-01-01',
    endId: '2026-10-18',
  });
  // A descriptor works as well as an id — the screen passes the descriptor.
  assert.deepEqual(periodBounds(periodById('week'), today), periodBounds('week', today));
});

test('periodBounds crosses month and year boundaries', () => {
  // 1 March 2026 is a Sunday: its ISO week began on 23 February, and the month
  // it belongs to is March alone.
  assert.deepEqual(periodBounds('day', new Date(2026, 2, 1, 12)), {
    startId: '2026-03-01',
    endId: '2026-03-01',
  });
  assert.deepEqual(periodBounds('month', new Date(2026, 2, 1, 12)), {
    startId: '2026-03-01',
    endId: '2026-03-01',
  });
  assert.deepEqual(periodBounds('week', new Date(2026, 2, 1, 12)), {
    startId: '2026-02-23',
    endId: '2026-03-01',
  });
  // A week that spans a month end is still one week, and so is one that spans a
  // year end: five daily bars in each month, no split, no gap.
  assert.deepEqual(periodBounds('week', new Date(2025, 11, 31, 12)), {
    startId: '2025-12-29',
    endId: '2025-12-31',
  });
  const spanned = dayIdsInRange('2025-12-29', '2026-01-04');
  assert.equal(spanned.length, 7);
  assert.deepEqual(spanned.slice(0, 3), ['2025-12-29', '2025-12-30', '2025-12-31']);
  // A year rollover: the year window is that year, never twelve months back.
  assert.deepEqual(periodBounds('year', new Date(2026, 0, 3, 12)), {
    startId: '2026-01-01',
    endId: '2026-01-03',
  });
});

test('periodBounds keeps 29 February inside a leap-year range', () => {
  const today = new Date(2028, 2, 1, 12);
  // The day period is the leap day itself when it is that day.
  assert.deepEqual(periodBounds('day', new Date(2028, 1, 29, 8)), {
    startId: '2028-02-29',
    endId: '2028-02-29',
  });
  // The February that holds the leap day is 29 days long, and its ISO week
  // starts on Monday 28 February.
  assert.deepEqual(periodBounds('month', new Date(2028, 1, 1, 12), today), {
    startId: '2028-02-01',
    endId: '2028-02-29',
  });
  assert.deepEqual(periodBounds('week', new Date(2028, 1, 29, 12), new Date(2028, 1, 29, 12)), {
    startId: '2028-02-28',
    endId: '2028-02-29',
  });
  // The current year starts in January and stops at today; the leap day is
  // inside it.
  assert.deepEqual(periodBounds('year', today), {
    startId: '2028-01-01',
    endId: '2028-03-01',
  });
});

test('sessionsRange bounds the period sessions read half-open with a plug-in lookback', () => {
  // #123's pricing read: sessions may start up to a week before the range
  // (a plug-in still charging into it) and until the midnight after its last
  // day — a session starting on the last day must be included.
  const week = sessionsRange(periodBounds('week', new Date(2026, 9, 18, 12)));
  assert.equal(week.start.getTime(), new Date(2026, 9, 5).getTime());
  assert.equal(week.end.getTime(), new Date(2026, 9, 19).getTime());
  // The year's range starts a lookback before 1 January, not before a rolling
  // twelve-month window.
  const year = sessionsRange(periodBounds('year', new Date(2026, 9, 18, 12)));
  assert.equal(year.start.getTime(), new Date(2025, 11, 25).getTime());
  assert.equal(year.end.getTime(), new Date(2026, 9, 19).getTime());
  assert.equal(SESSIONS_LOOKBACK_DAYS, 7);
  // Malformed bounds read nothing rather than querying garbage.
  assert.equal(sessionsRange({ startId: 'nope', endId: '2026-10-18' }), null);
  assert.equal(sessionsRange(null), null);
});

test('periodBounds stays on local calendar days across a DST change (fixed America/Denver)', () => {
  // Same child-process pattern as the range test: a UTC runner must still
  // exercise the spring-forward boundary, and a 00:30 fixture catches midnight
  // arithmetic.
  const moduleUrl = new URL('../../web/js/history.js', import.meta.url).href;
  const script = `
    import { periodBounds } from ${JSON.stringify(moduleUrl)};
    if (new Date(2026, 2, 9, 12).getTimezoneOffset() !== 360) {
      console.error('unexpected offset', new Date(2026, 2, 9, 12).getTimezoneOffset());
      process.exit(1);
    }
    const today = new Date(2026, 2, 9, 0, 30);
    // 9 March 2026 is the Monday after the spring-forward day, so the current
    // week is that one date and March is a whole calendar month so far.
    const expected = {
      day: { startId: '2026-03-09', endId: '2026-03-09' },
      week: { startId: '2026-03-09', endId: '2026-03-09' },
      month: { startId: '2026-03-01', endId: '2026-03-09' },
      year: { startId: '2026-01-01', endId: '2026-03-09' },
    };
    for (const [period, want] of Object.entries(expected)) {
      const got = periodBounds(period, today);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.error(period, JSON.stringify(got));
        process.exit(1);
      }
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, TZ: 'America/Denver' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('monthId and monthLabel use the local calendar month', () => {
  assert.equal(monthId(new Date(2026, 0, 1, 0, 30)), '2026-01');
  assert.equal(monthId(new Date(2026, 11, 31, 23)), '2026-12');
  assert.equal(monthLabel('2026-10'), 'Oct 2026');
  assert.equal(monthLabel('2025-01'), 'Jan 2025');
  assert.equal(monthLabel('2026-13'), '2026-13');
  assert.equal(monthLabel('nope'), 'nope');
});

test('periodSeries renders one point per day of the ISO week, with gaps as zero bars', () => {
  const today = new Date(2026, 9, 18, 12);
  const points = periodSeries(
    'week',
    [
      { id: '2026-10-12', kwh: 3 },
      { id: '2026-10-15', kwh: '2.5' },
      { id: '2026-10-18', kwh: 1.25 },
      { id: '2026-10-11', kwh: 99 },
      { id: '2026-10-16', kwh: -4 },
    ],
    today,
  );
  assert.deepEqual(
    points.map((point) => point.id),
    [
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ],
  );
  assert.deepEqual(
    points.map((point) => point.kwh),
    [3, 0, 0, 2.5, 0, 0, 1.25],
  );
  assert.equal(points[0].label, 'Mon 12 Oct');
  assert.deepEqual(
    points.map((point) => point.isCurrent),
    [false, false, false, false, false, false, true],
  );
});

test('periodSeries draws the current calendar month and marks today', () => {
  const today = new Date(2026, 9, 18, 12);
  const points = periodSeries(
    'month',
    [
      { id: '2026-09-30', kwh: 9 }, // the month before: outside the window
      { id: '2026-10-01', kwh: 2 },
      { id: '2026-10-18', kwh: 4 },
    ],
    today,
  );
  // 1..today: the month holding the clock is clipped, so October is 18 bars on
  // the 18th — never a future bucket padded to 31.
  assert.equal(points.length, 18);
  assert.equal(points[0].id, '2026-10-01');
  assert.equal(points[0].label, 'Thu 1 Oct');
  assert.equal(points[0].kwh, 2);
  assert.equal(points[17].id, '2026-10-18');
  assert.equal(points[17].kwh, 4);
  assert.deepEqual(
    points.filter((point) => point.isCurrent).map((point) => point.id),
    ['2026-10-18'],
  );
  // No recorded document is a zero bar inside the month, not a shorter chart.
  assert.equal(points.filter((point) => point.kwh === 0).length, 16);
  assert.equal(sumSeries(points), 6);
});

test('periodSeries sums the current year into January..this month', () => {
  const today = new Date(2026, 9, 18, 12);
  const points = periodSeries(
    'year',
    [
      { id: '2025-10-31', kwh: 99 }, // the year before: outside the window
      { id: '2026-01-01', kwh: 1 },
      { id: '2026-02-28', kwh: 3 },
      { id: '2026-02-01', kwh: 4 },
      { id: '2026-10-02', kwh: 5 },
      { id: '2026-10-18', kwh: 6 },
    ],
    today,
  );
  // Ten buckets: January to October. No November, no December, no zero tail.
  assert.equal(points.length, 10);
  assert.equal(points[0].id, '2026-01');
  assert.equal(points[0].label, 'Jan 2026');
  assert.equal(points[0].kwh, 1);
  assert.equal(points[9].id, '2026-10');
  assert.equal(points[9].label, 'Oct 2026');
  assert.equal(points.find((point) => point.id === '2026-02').kwh, 7);
  // The current month is the partial sum of the days recorded so far; the
  // series stops with it.
  assert.equal(points[9].kwh, 11);
  assert.deepEqual(
    points.filter((point) => point.isCurrent).map((point) => point.id),
    ['2026-10'],
  );
  // Twelve months is no longer the window: only the months the year has.
  assert.equal(sumSeries(points), 19);
});

test('periodSeries folds 29 February into its month', () => {
  const today = new Date(2028, 2, 15, 12);
  const points = periodSeries(
    'year',
    [
      { id: '2028-02-01', kwh: 1 },
      { id: '2028-02-29', kwh: 2.5 },
    ],
    today,
  );
  const february = points.find((point) => point.id === '2028-02');
  assert.equal(february.kwh, 3.5);
  assert.equal(february.label, 'Feb 2028');
  assert.equal(february.isCurrent, false);
});

test('periodSeries without documents is a full run of zero points, not an empty list', () => {
  const today = new Date(2026, 9, 18, 12);
  // The counts are the calendar's: this week's seven days, October's eighteen
  // days so far, and the ten months the year has reached.
  for (const [period, count] of [
    ['week', 7],
    ['month', 18],
    ['year', 10],
  ]) {
    const points = periodSeries(period, [], today);
    assert.equal(points.length, count, period);
    assert.equal(sumSeries(points), 0, period);
    assert.equal(points[count - 1].isCurrent, true, period);
  }
  // Malformed documents are ignored rather than throwing.
  const points = periodSeries(
    'year',
    [null, { kwh: 5 }, { id: 42, kwh: 5 }, { id: '2026-10', kwh: 'nope' }],
    today,
  );
  assert.equal(sumSeries(points), 0);
});

test('chartIndexAt maps a pointer to exactly the visible slots', () => {
  const rect = { left: 20, width: CHART_VIEW_W };
  // 30 slots: today's mapping is unchanged.
  assert.equal(chartIndexAt(20, rect, 30), 0);
  assert.equal(chartIndexAt(25, rect, 30), 0);
  assert.equal(chartIndexAt(35, rect, 30), 1);
  assert.equal(chartIndexAt(319.9, rect, 30), 29);
  // Every visible point owns an equal share of the same viewBox, so 7 and 12
  // bars have no dead slots — and a 24-point Day period needs no new mapping.
  assert.equal(chartIndexAt(20, rect, 7), 0);
  assert.equal(chartIndexAt(63, rect, 7), 1);
  assert.equal(chartIndexAt(319.9, rect, 7), 6);
  assert.equal(chartIndexAt(20, rect, 12), 0);
  assert.equal(chartIndexAt(45, rect, 12), 1);
  assert.equal(chartIndexAt(319.9, rect, 12), 11);
  assert.equal(chartIndexAt(20, rect, 24), 0);
  assert.equal(chartIndexAt(319.9, rect, 24), 23);
  // The hit test scales with the rendered width.
  assert.equal(chartIndexAt(75, { left: 0, width: 150 }, 30), 15);
  // Outside the plot or invalid geometry.
  assert.equal(chartIndexAt(19, rect, 30), null);
  assert.equal(chartIndexAt(321, rect, 30), null);
  assert.equal(chartIndexAt(320, rect, 7), null);
  assert.equal(chartIndexAt(20, { left: 0, width: 0 }, 30), null);
  assert.equal(chartIndexAt(Number.NaN, rect, 30), null);
  assert.equal(chartIndexAt(20, rect, 0), null);
});

test('chartIndexAt maps 24 hourly bars to exactly their own slots', () => {
  const rect = { left: 20, width: CHART_VIEW_W };
  // 24 slots across VIEW_W are 12.5 view units each, and every edge belongs to
  // the slot it starts: no dead gaps, no shared boundaries.
  assert.equal(chartIndexAt(20, rect, 24), 0);
  assert.equal(chartIndexAt(32.4, rect, 24), 0);
  assert.equal(chartIndexAt(32.5, rect, 24), 1);
  assert.equal(chartIndexAt(157.5, rect, 24), 11);
  assert.equal(chartIndexAt(170, rect, 24), 12);
  assert.equal(chartIndexAt(182.5, rect, 24), 13);
  assert.equal(chartIndexAt(319.9, rect, 24), 23);
  assert.equal(chartIndexAt(19.9, rect, 24), null);
  assert.equal(chartIndexAt(320, rect, 24), null);
  // The same mapping scales with the rendered width.
  assert.equal(chartIndexAt(160, { left: 0, width: 600 }, 24), 6);
});

test('hourId and hourRange use the stored zero-padded hour keys', () => {
  assert.equal(hourId(0), '00');
  assert.equal(hourId(9), '09');
  assert.equal(hourId(23), '23');
  assert.equal(hourRange('00'), '00:00–01:00');
  assert.equal(hourRange('09'), '09:00–10:00');
  assert.equal(hourRange('21'), '21:00–22:00');
  // The last hour closes at midnight rather than wrapping to a new day.
  assert.equal(hourRange('23'), '23:00–24:00');
  assert.equal(hourRange('nope'), 'nope');
});

test('hourSeries renders 24 buckets in order with only what was recorded', () => {
  const today = new Date(2026, 9, 18, 21, 30);
  const points = hourSeries(
    {
      '00': 2.4,
      '05': '1.25',
      '06': 0,
      '07': -2,
      '08': 'nope',
      9: 4,
      21: 0.35,
    },
    today,
  );
  assert.equal(points.length, 24);
  assert.deepEqual(
    points.map((point) => point.id),
    Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')),
  );
  assert.equal(points[0].label, '00:00');
  assert.equal(points[23].label, '23:00');
  assert.equal(points[0].kwh, 2.4);
  assert.equal(points[5].kwh, 1.25);
  // Zero, negative, non-numeric and unpadded keys are not recorded hours.
  assert.equal(points[6].kwh, 0);
  assert.equal(points[7].kwh, 0);
  assert.equal(points[8].kwh, 0);
  assert.equal(points[9].kwh, 0);
  // The hour in progress is what has been recorded so far, unchanged.
  assert.equal(points[21].kwh, 0.35);
  assert.equal(sumSeries(points), 4);
  // Only the hour in progress is marked current; the day itself is not a slot.
  assert.deepEqual(
    points.filter((point) => point.isCurrent).map((point) => point.id),
    ['21'],
  );
});

test('hourSeries turns an absent or malformed map into zero points', () => {
  // The read state, not this function, decides whether zero points may be
  // painted; the series itself must stay total and never throw.
  const midnight = new Date(2026, 9, 18, 0, 5);
  for (const value of [undefined, null, {}, 'nope', [], 42]) {
    const points = hourSeries(value, midnight);
    assert.equal(points.length, 24, String(value));
    assert.equal(sumSeries(points), 0, String(value));
    assert.equal(maxSeries(points), 0, String(value));
    assert.equal(points.filter((point) => point.isCurrent).length, 1, String(value));
    assert.equal(points[0].isCurrent, true, String(value));
  }
});

test('hour points carry the day their buckets price', () => {
  // The Day period reads one document for one captured day; every hourly point
  // carries that day so a schedule can price the bucket's wall-clock span.
  const points = hourSeries({ '05': 1 }, new Date(2026, 9, 18, 21, 30));
  assert.equal(points[5].dayId, '2026-10-18');
  assert.equal(points[0].dayId, '2026-10-18');
  assert.equal(points[23].dayId, '2026-10-18');
});

test('isCurrent is the clock, never the window anchor', () => {
  // #154's first latent defect: a paged window's newest bucket would otherwise
  // be flagged current (a past Day's same clock hour). The damage was concrete:
  // the live-pricing gate opened over a past bucket, the bar's accessible name
  // gained "(this hour so far)", and the selection jumped to that bucket instead
  // of the newest one.
  const now = new Date(2026, 9, 18, 12, 40);
  const pastDay = periodAnchor('day', 1, now);
  assert.equal(dayId(pastDay), '2026-10-17');

  // The same hour id exists on both days; only today's is in progress.
  const past = hourSeries({ 12: 1 }, pastDay, now);
  assert.equal(past.filter((point) => point.isCurrent).length, 0);
  assert.deepEqual(past[12].dayId, '2026-10-17');
  assert.deepEqual(
    hourSeries({ 12: 1 }, now, now)
      .filter((point) => point.isCurrent)
      .map((point) => point.id),
    ['12'],
  );
  // The Day period reaches them through periodSeries too.
  const pastDaySeries = periodSeries('day', { kwh: 1, hours: { 12: 1 } }, pastDay, now);
  assert.equal(
    pastDaySeries.some((point) => point.isCurrent),
    false,
  );
  assert.equal(periodSeries('day', { kwh: 1, hours: { 12: 1 } }, now, now)[12].isCurrent, true);

  // Every range period: a paged window marks nothing current, the default one
  // marks exactly its own bucket.
  for (const period of ['week', 'month', 'year']) {
    const paged = periodSeries(period, [], periodAnchor(period, 1, now), now);
    assert.equal(
      paged.some((point) => point.isCurrent),
      false,
      period,
    );
    const current = periodSeries(period, [], now, now).filter((point) => point.isCurrent);
    assert.equal(current.length, 1, period);
  }

  // `now` defaults to the anchor, so every pre-paging caller and test is
  // unchanged: the newest bucket of the window given is the current one.
  const legacy = periodSeries('week', [], pastDay);
  assert.equal(legacy[legacy.length - 1].isCurrent, true);
  assert.equal(hourSeries({}, pastDay)[12].isCurrent, true);

  // The year is part of the identity. Every other fixture sits within a year of
  // the clock, so a window a year back is the case that tells a date comparison
  // from a month-day one: 18 Oct 2025 holds the same month-day as `now`, and
  // nothing in its week or month is current.
  const lastYear = new Date(2025, 9, 18, 12, 40);
  assert.equal(periodSeries('week', [], lastYear, now).filter((p) => p.isCurrent).length, 0);
  assert.equal(periodSeries('week', [], lastYear, now).at(-1).id, '2025-10-19');
  assert.equal(periodSeries('month', [], lastYear, now).filter((p) => p.isCurrent).length, 0);
  // A whole calendar month a year back is 31 bars, all of them past.
  assert.equal(periodSeries('month', [], lastYear, now).length, 31);
  assert.equal(hourSeries({}, lastYear, now).filter((p) => p.isCurrent).length, 0);
});

test('periodSeries renders the day period from its single document', () => {
  const today = new Date(2026, 9, 18, 12, 40);
  const points = periodSeries('day', { kwh: 3.75, hours: { 11: 2, 12: 1.75 } }, today);
  assert.equal(points.length, 24);
  assert.equal(sumSeries(points), 3.75);
  assert.equal(points[12].kwh, 1.75);
  assert.deepEqual(
    points.filter((point) => point.isCurrent).map((point) => point.id),
    ['12'],
  );
  // A document with no hours is still 24 points; hourReadState is what stops the
  // Day path from drawing them.
  assert.equal(sumSeries(periodSeries('day', { kwh: 4.2 }, today)), 0);
});

test('hourReadState never reads missing hours as zero energy', () => {
  // Hours recorded before hourly capture existed are absent, not zero.
  assert.equal(hourReadState({ exists: true, kwh: 4.2, hours: null }), 'no-intraday');
  assert.equal(hourReadState({ exists: true, kwh: 4.2, hours: {} }), 'no-intraday');
  assert.equal(hourReadState({ exists: true, kwh: 4.2, hours: { '00': 0 } }), 'no-intraday');
  // A cached copy of such a day is still a day without hours.
  assert.equal(
    hourReadState({ exists: true, kwh: 4.2, hours: null, fromCache: true }),
    'no-intraday',
  );
  // Buckets with energy are the only data the Day chart may draw.
  assert.equal(hourReadState({ exists: true, kwh: 1, hours: { '01': 1 } }), 'fresh');
  assert.equal(
    hourReadState({ exists: true, kwh: 1, hours: { '01': 0.35 }, fromCache: true }),
    'cached',
  );
  // A zero-kWh day is empty whether the map is absent or present.
  assert.equal(hourReadState({ exists: true, kwh: 0, hours: null }), 'empty');
  assert.equal(hourReadState({ exists: true, kwh: 0, hours: {} }), 'empty');
  // A missing document is 'empty' only when the read reached the server.
  assert.equal(hourReadState({ exists: false, kwh: 0, hours: null }), 'empty');
  assert.equal(hourReadState({ exists: false, kwh: 0, hours: null, fromCache: true }), 'offline');
  // A cached zero day is a cache miss, not evidence that nothing was recorded.
  assert.equal(hourReadState({ exists: true, kwh: 0, hours: null, fromCache: true }), 'offline');
  assert.equal(hourReadState(null), 'empty');
});

test('hourReadFailure separates a transport failure from a real error', () => {
  // getDoc rejects instead of resolving an empty snapshot when the device is
  // offline and the day is not cached; only that becomes the offline copy.
  assert.equal(hourReadFailure({ code: 'unavailable' }), 'offline');
  assert.equal(hourReadFailure({ code: 'deadline-exceeded' }), 'offline');
  assert.equal(hourReadFailure({ code: 'permission-denied' }), 'error');
  assert.equal(hourReadFailure(new Error('boom')), 'error');
  assert.equal(hourReadFailure(null), 'error');
});

test('dayLabel is stable and rejects malformed ids', () => {
  assert.equal(dayLabel('2026-10-18'), 'Sun 18 Oct');
  assert.equal(dayLabel('2026-01-01'), 'Thu 1 Jan');
  assert.equal(dayLabel('not-a-day'), 'not-a-day');
});

test('historySeries aligns docs to days and treats gaps as zero', () => {
  const ids = ['2026-10-16', '2026-10-17', '2026-10-18'];
  const series = historySeries(ids, [
    { id: '2026-10-16', kwh: 4.5 },
    { id: '2026-10-18', kwh: '7.25' },
    { id: '2026-10-19', kwh: 99 },
    { id: '2026-10-17', kwh: -2 },
  ]);
  assert.deepEqual(
    series.map((point) => point.kwh),
    [4.5, 0, 7.25],
  );
  assert.equal(series[1].label, 'Sat 17 Oct');
  assert.deepEqual(historySeries(ids, []), [
    { id: '2026-10-16', kwh: 0, label: 'Fri 16 Oct' },
    { id: '2026-10-17', kwh: 0, label: 'Sat 17 Oct' },
    { id: '2026-10-18', kwh: 0, label: 'Sun 18 Oct' },
  ]);
});

test('day points carry no pricing payload — their $ comes from the sessions', () => {
  const series = historySeries(
    ['2026-10-16', '2026-10-17', '2026-10-18'],
    [
      { id: '2026-10-16', kwh: 4.5, hours: { '03': 4.5 } },
      // Recorded before hourly capture: a real total, no buckets behind it.
      { id: '2026-10-18', kwh: 7.25 },
    ],
  );
  // #123 made every range period session-priced: the buckets a day document
  // carries price nothing here (only the Day period's own read uses hours), so
  // `hours` rides on no point — a bucketed day, a pre-hourly-capture day and a
  // gap day all land in the same shape, and a genuine zero stays a priced 0.00
  // rather than an unpriceable gap.
  assert.equal('hours' in series[0], false);
  assert.equal('hours' in series[2], false);
  assert.deepEqual(series[1], { id: '2026-10-17', kwh: 0, label: 'Sat 17 Oct' });
  assert.deepEqual(series[0], { id: '2026-10-16', kwh: 4.5, label: 'Fri 16 Oct' });
});

test('week and month points carry their kWh alone', () => {
  const today = new Date(2026, 9, 18, 12);
  const docs = [
    { id: '2026-10-12', kwh: 3, hours: { 22: 3 } },
    { id: '2026-10-15', kwh: 2.5 },
  ];
  const week = periodSeries('week', docs, today);
  const month = periodSeries('month', docs, today);
  // The same shape a Year month point has had since #123: a range bar's $
  // comes from the period's overlapping sessions, so `hours` — like `days`
  // before it — would claim a pricing input no consumer reads.
  assert.equal('hours' in week[0], false);
  assert.deepEqual(week[0], { id: '2026-10-12', kwh: 3, label: 'Mon 12 Oct', isCurrent: false });
  assert.equal('hours' in month.find((point) => point.id === '2026-10-12'), false);
});

test('year month points sum their daily documents into kWh alone', () => {
  const today = new Date(2026, 9, 18, 12);
  const points = periodSeries(
    'year',
    [
      { id: '2026-10-02', kwh: 5, hours: { 22: 5 } },
      // Energy with no buckets still counts toward the month's kWh — its $
      // comes from the period's sessions either way.
      { id: '2026-10-18', kwh: 6 },
      // Outside the 12-month window (2025-11 .. 2026-10), and a no-energy day
      // inside it.
      { id: '2025-10-31', kwh: 99 },
      { id: '2026-10-03', kwh: -4 },
    ],
    today,
  );
  const october = points.find((point) => point.id === '2026-10');
  assert.equal(october.kwh, 11);
  // No day-document payload rides on the point (#125): a Year bar prices from
  // the period's overlapping sessions, so the summed kWh is all it needs —
  // `days` once claimed to feed a pricing split that no longer exists.
  assert.equal('days' in october, false);
  // A month with no recorded energy is a genuine zero point, not a gap.
  assert.deepEqual(
    points.find((point) => point.id === '2026-05'),
    {
      id: '2026-05',
      kwh: 0,
      label: 'May 2026',
      isCurrent: false,
    },
  );
});

test('sumSeries and maxSeries ignore malformed points', () => {
  assert.equal(sumSeries([]), 0);
  assert.equal(sumSeries([{ kwh: 1.5 }, { kwh: 2.5 }]), 4);
  assert.equal(sumSeries([{ kwh: 1.5 }, { kwh: Number.NaN }]), 1.5);
  assert.equal(maxSeries([]), 0);
  assert.equal(maxSeries([{ kwh: 1.5 }, { kwh: 9 }, { kwh: null }]), 9);
});

test('historyReadState separates an offline cache miss from an empty range', () => {
  // Offline one-shot reads resolve from the cache: empty + fromCache is not
  // "no energy recorded", it is "the server was never reached".
  assert.equal(historyReadState({ docs: [], fromCache: true }), 'offline');
  assert.equal(historyReadState({ docs: [], fromCache: false }), 'empty');
  assert.equal(
    historyReadState({ docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: true }),
    'cached',
  );
  assert.equal(
    historyReadState({ docs: [{ id: '2026-10-18', kwh: 1 }], fromCache: false }),
    'fresh',
  );
  assert.equal(historyReadState(null), 'empty');
  assert.equal(historyReadState({}), 'empty');
});

test('sectionView never presents an unreached read as current data', () => {
  // Server answers are the only states allowed to be presented as current, and
  // only 'empty' may claim that nothing was recorded.
  assert.deepEqual(sectionView('fresh', true), {
    showData: true,
    stale: false,
    claimEmpty: false,
  });
  assert.deepEqual(sectionView('empty', false), {
    showData: true,
    stale: false,
    claimEmpty: true,
  });
  // A cached read with rows keeps them visible but marks them stale.
  assert.deepEqual(sectionView('cached', false), {
    showData: true,
    stale: true,
    claimEmpty: false,
  });
  // A cache miss after a successful empty read: 30 zero points are on screen but
  // they are not evidence, so the section shows its offline message instead.
  assert.equal(sectionView('offline', false).showData, false);
  assert.equal(sectionView('offline', false).claimEmpty, false);
  assert.equal(sectionView('error', false).showData, false);
  // A previously loaded payload stays visible as stale rather than disappearing.
  assert.deepEqual(sectionView('offline', true), {
    showData: true,
    stale: true,
    claimEmpty: false,
  });
  assert.deepEqual(sectionView('error', true), {
    showData: true,
    stale: true,
    claimEmpty: false,
  });
  // A day with a total but no hourly buckets is a message, not data: the Day
  // path must draw neither 24 zero bars nor a claim that nothing was recorded.
  assert.deepEqual(sectionView('no-intraday', false), {
    showData: false,
    stale: false,
    claimEmpty: false,
  });
  assert.equal(sectionView('no-intraday', true).showData, false);
  // Nothing is shown for a section that has neither data nor a result yet.
  for (const state of ['idle', 'loading', 'nonsense']) {
    assert.equal(sectionView(state, true).showData, false, state);
    assert.equal(sectionView(state, true).claimEmpty, false, state);
  }
});

test('the plan banner appears exactly when a saved plan has an unpriced instant', () => {
  // Gap 3: the banner is the only signal that a stored plan has instants no
  // rate row covers before the owner opens settings — each costs the stored
  // flat rate (#188), 0.00 only when no finite flat rate is stored. Its
  // condition is a pure predicate so it is covered without a DOM.
  const base = { id: 'b', rate: 0.3, days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' };
  const summer = {
    ...base,
    id: 'summer',
    months: [6, 7, 8, 9],
    from: '06-15',
    to: '09-15',
  };
  const peak = {
    ...base,
    id: 'peak',
    rate: 0.4,
    months: [6, 7, 8, 9],
    from: '06-15',
    to: '09-15',
    start: '16:00',
    end: '19:00',
  };
  const settings = (rates) => ({ rate: 0.3, currency: 'USD', rates });

  // No schedule: the flat rate prices every hour, so there is nothing to warn
  // about.
  assert.equal(showPlanBanner(settings([])), false);
  assert.equal(showPlanBanner(null), false);
  // A plan that covers the year with a base is priced everywhere.
  assert.equal(showPlanBanner(settings([base])), false);
  // A base-less season leaves hours no row covers even though its dates are
  // covered: they cost the stored 0.3 flat rate (#188), not 0.00 — the banner
  // fires on the gap itself.
  assert.equal(showPlanBanner(settings([peak])), true);
  // A date season leaves the rest of the year uncovered.
  assert.equal(showPlanBanner(settings([summer])), true);
});

// The #188 report, priced end to end at the History layer the sessions list
// and the summary read (#123's pricing rules): season rows scoped through
// 31 October expired, and a November session priced ≈80% low because the
// engine zeroed every unmatched instant. PR #191's engine prices those
// instants at the stored flat rate; these fixtures pin the money the screen
// shows for exactly that stored document.
test('the reported #188 session prices at the flat rate, and a half-covered one splits (#188)', () => {
  const summerBase = {
    id: 'summer',
    rate: 0.2,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '00:00',
    months: [5, 6, 7, 8, 9, 10],
    from: '06-01',
    to: '10-31',
  };
  const summerPeak = {
    ...summerBase,
    id: 'peak',
    rate: 0.32,
    start: '16:00',
    end: '19:00',
  };
  const reported = { rate: 0.12, currency: 'USD', rates: [summerBase, summerPeak] };

  // The reported session: 19.6 kWh on Wed 18 Nov 2026, every instant
  // off-season. 0.12 × 19.6 = 2.352 — USD 2.35, not the USD 0.00 (≈80% low)
  // the old policy priced.
  const session = {
    wh: 19600,
    started_at: new Date(2026, 10, 18, 19, 0),
    ended_at: new Date(2026, 10, 18, 21, 0),
  };
  assert.equal(sessionCostLabel(session, reported), 'USD 2.35');
  // The banner still appears — the gap is real even though priced — and its
  // fallback-aware copy is pinned on the screen harness.
  assert.equal(showPlanBanner(reported), true);

  // A partially covered session: one interval inside the season's last
  // weekday peak (1 kWh at 0.32) and one off-season at the flat fallback
  // (1 kWh at 0.12) — USD 0.44, each part at its own price.
  const halfCovered = {
    wh: 2000,
    started_at: new Date(2026, 9, 28, 17, 0),
    ended_at: new Date(2026, 10, 18, 20, 0),
    intervals: [
      {
        started_at: new Date(2026, 9, 28, 17, 0),
        ended_at: new Date(2026, 9, 28, 18, 0),
        wh: 1000,
      },
      {
        started_at: new Date(2026, 10, 18, 19, 0),
        ended_at: new Date(2026, 10, 18, 20, 0),
        wh: 1000,
      },
    ],
  };
  assert.equal(sessionCostLabel(halfCovered, reported), 'USD 0.44');

  // Without a finite flat rate the same rows are genuinely unpriced again:
  // the reported session reads USD 0.00 (the console-edited edge, kept loud).
  const { rate: _rate, ...noFallback } = reported;
  assert.equal(sessionCostLabel(session, noFallback), 'USD 0.00');
  assert.equal(showPlanBanner(noFallback), true);
});

// ---------- schedule-priced summaries ----------
//
// The screen's pricing rules, exercised without a DOM against real series
// shapes (showPlanBanner's precedent): the flat branch is aggregateCostLabel's
// byte-identical path and is covered by cost.test.js; these tests pin what the
// schedule branch shows, hides and discloses.

// cost.test.js's nightly(): a visible all-day base at 0.30 plus a 00:00–06:00
// night window at 0.10. Winter dates only, so the fixtures hold in any local
// timezone (no DST transition inside the priced days).
const NIGHTLY = {
  rate: 0.3,
  currency: 'GBP',
  rates: [
    {
      id: 'base',
      rate: 0.3,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '00:00',
      months: null,
    },
    {
      id: 'night',
      rate: 0.1,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '06:00',
      months: null,
    },
  ],
};

test('a week covered by its sessions prices their sum, not its buckets', () => {
  // Session-primary (#123): the $ comes from the sessions overlapping the
  // range, attributed to their days — the hours maps price only the Day
  // period's bars now, so a day whose buckets disagree with its sessions
  // (energy the map puts at noon, the session drew off-peak) prices by the
  // session. Re-introducing bucket pricing for periods fails here.
  const today = new Date(2026, 9, 18, 12);
  const sessions = [
    { wh: 3000, started_at: new Date(2026, 9, 12, 2, 0), ended_at: new Date(2026, 9, 12, 3, 0) },
    { wh: 1000, started_at: new Date(2026, 9, 18, 3, 0), ended_at: new Date(2026, 9, 18, 4, 0) },
  ];
  const points = periodSeries(
    'week',
    [
      // Buckets claim noon; the sessions drew 00:00–06:00.
      { id: '2026-10-12', kwh: 3, hours: { 12: 3 } },
      { id: '2026-10-18', kwh: 1, hours: { 12: 1 } },
    ],
    today,
  );
  const summary = seriesCostSummary(points, 'day', NIGHTLY, sessions);
  // 3 kWh + 1 kWh in the 0.10 window — not the 0.30 the noon buckets would pay.
  assert.ok(Math.abs(summary.cost - 0.4) < 1e-9);
  // Each day's bar carries its session-attributed figure.
  const monday = pointCostSummary(points[0], 'day', NIGHTLY, sessions);
  assert.ok(Math.abs(monday.cost - 0.3) < 1e-9);
  assert.equal(monday.pricedEnergy, true);
  assert.equal(monday.unpricedEnergy, false);
});

test('a day whose energy has no covering session is disclosed, never priced free', () => {
  const today = new Date(2026, 9, 18, 12);
  const sessions = [
    { wh: 3000, started_at: new Date(2026, 9, 12, 2, 0), ended_at: new Date(2026, 9, 12, 3, 0) },
  ];
  const points = periodSeries(
    'week',
    [
      { id: '2026-10-12', kwh: 3, hours: { '02': 3 } },
      // A lost session (bridge crash): recorded energy, nothing behind it.
      { id: '2026-10-15', kwh: 4.2, hours: { '02': 4.2 } },
    ],
    today,
  );
  const summary = seriesCostSummary(points, 'day', NIGHTLY, sessions);
  // The priced-only total; buckets cannot stand in.
  assert.ok(Math.abs(summary.cost - 0.3) < 1e-9);
  // The covered day shows its figure; the uncovered day hides its own.
  const covered = pointCostSummary(points[0], 'day', NIGHTLY, sessions);
  assert.ok(Math.abs(covered.cost - 0.3) < 1e-9);
  assert.equal(covered.unpricedEnergy, false);
  const lost = pointCostSummary(points[3], 'day', NIGHTLY, sessions);
  assert.equal(lost.cost, 0);
  assert.equal(lost.pricedEnergy, false);
  assert.equal(lost.unpricedEnergy, true);
});

// The live archive (issue #123's evidence, 2026-10-22): four sessions against
// the October season rate $0.15303, in the local wall-clock spans the owner's
// UTC evidence lands on (MDT, UTC-6). Hourly capture began 2026-10-21, so the
// first two days carry a real total and `hours: null` — exactly the days #120's
// bucket rule could not price, which is the under-count #123 fixes.
const OCTOBER = {
  rate: 0.15303,
  currency: 'USD',
  rates: [
    {
      id: 'october',
      rate: 0.15303,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '00:00',
      months: [10],
    },
  ],
};

function liveArchiveSessions() {
  return [
    {
      id: '1792455533',
      wh: 11461,
      started_at: new Date(2026, 9, 19, 18, 18),
      ended_at: new Date(2026, 9, 20, 0, 31),
    },
    {
      id: '1792543109',
      wh: 6841,
      started_at: new Date(2026, 9, 20, 18, 38),
      ended_at: new Date(2026, 9, 21, 1, 0),
    },
    {
      id: '1792613313',
      wh: 10833,
      started_at: new Date(2026, 9, 21, 14, 8),
      ended_at: new Date(2026, 9, 22, 1, 0),
      intervals: [
        {
          started_at: new Date(2026, 9, 21, 14, 8),
          ended_at: new Date(2026, 9, 22, 1, 0),
          wh: 10833,
        },
      ],
    },
    {
      id: '1792698073',
      wh: 1796,
      started_at: new Date(2026, 9, 22, 13, 41),
      ended_at: new Date(2026, 9, 22, 14, 39),
      intervals: [
        {
          started_at: new Date(2026, 9, 22, 13, 41),
          ended_at: new Date(2026, 9, 22, 14, 39),
          wh: 1796,
        },
      ],
    },
  ];
}

test('the live archive week prices every day, including its pre-hourly days', () => {
  const sessions = liveArchiveSessions();
  // The day documents' own totals, set to the archive's attribution (the
  // bridge accumulates both from the same counter). Post-capture days carry
  // hour maps too — irrelevant for the week, kept to prove they do not price it.
  const points = periodSeries(
    'week',
    [
      { id: '2026-10-19', kwh: (11461 * 20520) / 22380 / 1000, hours: null },
      {
        id: '2026-10-20',
        kwh: ((11461 * 1860) / 22380 + (6841 * 19320) / 22920) / 1000,
        hours: null,
      },
      {
        id: '2026-10-21',
        kwh: ((6841 * 3600) / 22920 + (10833 * 35520) / 39120) / 1000,
        hours: { 12: 10 },
      },
      { id: '2026-10-22', kwh: ((10833 * 3600) / 39120 + 1796) / 1000, hours: { 12: 2.5 } },
    ],
    new Date(2026, 9, 22, 12),
  );
  const summary = seriesCostSummary(points, 'day', OCTOBER, sessions);
  // The sessions list's own figures, added up: Σ sessionCostLabel over the
  // four sessions = 30.931 kWh × $0.15303 = $4.7334 — not the $1.45 the
  // hours-only rule showed. The list renders each at display precision, so
  // its figures add to $4.73 beside the summary's exact 4.7334.
  const list = sessions.reduce(
    (sum, item) => sum + Number(sessionCostLabel(item, OCTOBER).slice(4)),
    0,
  );
  assert.ok(Math.abs(list - 4.73) < 1e-9);
  assert.ok(Math.abs(summary.cost - 4.73337093) < 1e-6);
  // An old bar shows its span-attributed day $, matching its contribution to
  // the summary — the acceptance scenario verbatim. The window is the ISO week
  // clipped at Thursday 22 October, so its bars are 19–22 and index 0 is the
  // 19th; under a rolling window the same bar sat at index 3.
  const oct19 = pointCostSummary(points[0], 'day', OCTOBER, sessions);
  assert.ok(Math.abs(oct19.cost - ((11461 * 20520) / 22380 / 1000) * 0.15303) < 1e-9);
  assert.equal(oct19.pricedEnergy, true);
  assert.equal(oct19.unpricedEnergy, false);
  // And the day whose session spans midnight keeps its other half on the
  // next day, exactly once.
  const oct20 = pointCostSummary(points[1], 'day', OCTOBER, sessions);
  assert.ok(
    Math.abs(oct20.cost - (((11461 * 1860) / 22380 + (6841 * 19320) / 22920) / 1000) * 0.15303) <
      1e-9,
  );
});

test('a range whose energy is all unpriceable hides the cost instead of pricing it free', () => {
  const points = periodSeries(
    'week',
    [
      { id: '2026-10-12', kwh: 3 },
      { id: '2026-10-15', kwh: 4.2 },
    ],
    new Date(2026, 9, 18, 12),
  );
  const summary = seriesCostSummary(points, 'day', NIGHTLY);
  assert.equal(summary.cost, null);
});

test('zero-energy days price fully at 0.00 and uncovered ranges hide', () => {
  const empty = seriesCostSummary(
    periodSeries('week', [], new Date(2026, 9, 18, 12)),
    'day',
    NIGHTLY,
  );
  assert.equal(empty.cost, 0);
  // Even beside one unpriceable day, a range with no priced energy hides: a
  // $0.00 would claim the unknown energy was free.
  const hidden = seriesCostSummary(
    periodSeries('week', [{ id: '2026-10-15', kwh: 4.2 }], new Date(2026, 9, 18, 12)),
    'day',
    NIGHTLY,
  );
  assert.equal(hidden.cost, null);
});

test('day-period hours price from their captured day, sessions aside', () => {
  const points = hourSeries({ '02': 2, 12: 1 }, new Date(2026, 9, 18, 12, 40));
  // A session overlapping today must not leak into the hour bars' pricing:
  // the Day period is the one bucket path left (#123), byte-identical.
  const sessions = [
    { wh: 3000, started_at: new Date(2026, 9, 18, 12, 0), ended_at: new Date(2026, 9, 18, 13, 0) },
  ];
  const summary = seriesCostSummary(points, 'hour', NIGHTLY, sessions);
  assert.ok(Math.abs(summary.cost - 0.5) < 1e-9);
  // An hour bucket is priced, or it is 0.00; its coverage is definitional, so
  // the Day summary never carries a coverage disclosure.
  assert.deepEqual(pointCostSummary(points[2], 'hour', NIGHTLY, sessions), {
    cost: 0.2,
    pricedEnergy: true,
    unpricedEnergy: false,
    coveredWh: 2000,
  });
});

test('year month points price from the sessions attributed into them', () => {
  const today = new Date(2026, 9, 18, 12);
  const sessions = [
    // 1 kWh off-peak in October 2026; May's recorded day has no session.
    { wh: 1000, started_at: new Date(2026, 9, 2, 3, 0), ended_at: new Date(2026, 9, 2, 4, 0) },
  ];
  const points = periodSeries(
    'year',
    [
      { id: '2026-10-02', kwh: 1, hours: { 12: 1 } },
      { id: '2026-05-06', kwh: 2 }, // no covering session inside May
    ],
    today,
  );
  const summary = seriesCostSummary(points, 'month', NIGHTLY, sessions);
  // The priced-only total: October's session, not its buckets.
  assert.ok(Math.abs(summary.cost - 0.1) < 1e-9);
  const october = pointCostSummary(
    points.find((point) => point.id === '2026-10'),
    'month',
    NIGHTLY,
    sessions,
  );
  assert.ok(Math.abs(october.cost - 0.1) < 1e-9);
  assert.equal(october.pricedEnergy, true);
  assert.equal(october.unpricedEnergy, false);
  // A month whose energy is entirely without a session hides its figure.
  const may = pointCostSummary(
    points.find((point) => point.id === '2026-05'),
    'month',
    NIGHTLY,
    sessions,
  );
  assert.equal(may.cost, 0);
  assert.equal(may.pricedEnergy, false);
  assert.equal(may.unpricedEnergy, true);
});

test('flat settings keep the schedule summary hidden', () => {
  // The schedule-only summary never invents a flat price; the screen's flat
  // branch stays aggregateCostLabel's (byte-identity covered in cost.test.js).
  // Sessions ride along and are ignored: the flat path reads neither buckets
  // nor sessions.
  const points = periodSeries(
    'week',
    [{ id: '2026-10-15', kwh: 4.2, hours: { '03': 4 } }],
    new Date(2026, 9, 18, 12),
  );
  const sessions = [
    { wh: 4200, started_at: new Date(2026, 9, 15, 3, 0), ended_at: new Date(2026, 9, 15, 4, 0) },
  ];
  assert.deepEqual(seriesCostSummary(points, 'day', { rate: 0.245, currency: 'GBP' }, sessions), {
    cost: null,
  });
});

test('an all-unpriceable bar hides its figure instead of pricing it free', () => {
  // The summary-level twin of this rule is covered above; `seriesCost` is the
  // per-bar label and stays unexported, so its hide clause is pinned from
  // source (the sw-shell pattern). Without it an all-unpriceable Year month
  // bar would render $0.00 as if the energy were free.
  const source = readFileSync(new URL('../../web/js/screens/history.js', import.meta.url), 'utf8');
  const start = source.indexOf('function seriesCost(');
  assert.ok(start >= 0, 'screens/history.js declares seriesCost');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'screens/history.js closes seriesCost');
  const body = source.slice(start, end + 2);
  assert.match(body, /unpricedEnergy && !summary\.pricedEnergy\)\) return null/);
});

// ---------- the summary's coverage disclosure (#194) ----------
//
// The live case the issue was filed on (19 Nov 2026): a week whose kWh comes
// from day documents while the sessions behind it price only a fraction — the
// counter-reset plug-in whose `wh` undercounts, so reconciliation fails and
// the aggregate prices 13.7 of the week's 48.1 kWh. The summary's $ must say
// what it prices instead of reading as a 3.2¢ tariff.

// The live plan shape: one all-day November season at 0.1127 with the same
// figure stored as the flat fallback, so every slice below prices at one rate
// and the figures are exact. November dates keep it clear of every DST edge.
const NOVEMBER = {
  rate: 0.1127,
  currency: 'USD',
  rates: [
    {
      id: 'november',
      rate: 0.1127,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '00:00',
      months: [11],
    },
  ],
};

// The 15–19 Nov counter-reset plug-in: seven usable intervals that kept
// counting through the reset, summing to 48.038 kWh against a record `wh` of
// 15.956 kWh — far outside the max(250 Wh, 2%) band, so the money guard
// prices the stored span's aggregate (cost.test.js's overshoot shape) and the
// rest hides. 80 h of the 93.2 h plug-in fall inside the week of the 16th.
function counterResetSession() {
  return {
    id: '1795142880',
    wh: 15956,
    started_at: new Date(2026, 10, 15, 10, 48),
    ended_at: new Date(2026, 10, 19, 8),
    intervals: [
      {
        started_at: new Date(2026, 10, 15, 10, 48),
        ended_at: new Date(2026, 10, 15, 22),
        wh: 11800,
      },
      { started_at: new Date(2026, 10, 16), ended_at: new Date(2026, 10, 16, 8), wh: 8600 },
      { started_at: new Date(2026, 10, 16, 20), ended_at: new Date(2026, 10, 17, 4), wh: 7800 },
      { started_at: new Date(2026, 10, 17, 21), ended_at: new Date(2026, 10, 18, 5), wh: 7200 },
      { started_at: new Date(2026, 10, 18, 10), ended_at: new Date(2026, 10, 18, 18), wh: 6238 },
      { started_at: new Date(2026, 10, 18, 22), ended_at: new Date(2026, 10, 19, 2), wh: 3200 },
      { started_at: new Date(2026, 10, 19, 5), ended_at: new Date(2026, 10, 19, 8), wh: 3200 },
    ],
  };
}

test('the live counter-reset week discloses the energy its $ prices', () => {
  const today = new Date(2026, 10, 19, 12); // Thursday 19 November 2026
  const session = counterResetSession();
  // The reconciliation failure that routes pricing to the stored span.
  assert.equal(sessionIntervalsValid(session.intervals, session.wh), false);
  // The week's day documents: Mon 16 – Thu 19 Nov, 48.1 kWh recorded.
  const points = periodSeries(
    'week',
    [
      { id: '2026-11-16', kwh: 12.4 },
      { id: '2026-11-17', kwh: 11.8 },
      { id: '2026-11-18', kwh: 11.9 },
      { id: '2026-11-19', kwh: 12.0 },
    ],
    today,
  );
  const summary = seriesCostSummary(points, 'day', NOVEMBER, [session]);
  // The aggregate's in-window share at the plan's one rate.
  const share = (15956 * 80) / 93.2;
  assert.ok(Math.abs(summary.coveredWh - share) < 1e-6);
  assert.ok(Math.abs(summary.recordedWh - 48100) < 1e-6);
  assert.ok(Math.abs(summary.cost - (share / 1000) * 0.1127) < 1e-9);
  assert.equal(coverageDisclosure(summary), 'priced 13.7 of 48.1 kWh');
  // The kWh the summary shows is exactly the day documents' total.
  assert.ok(Math.abs(sumSeries(points) - 48.1) < 1e-9);
  // Every day bar keeps #123's own verdict: recorded energy no session covers
  // never prices itself free.
  for (const point of points) {
    const bucket = pointCostSummary(point, 'day', NOVEMBER, [session]);
    assert.equal(bucket.unpricedEnergy, true);
  }
});

test('a covered period discloses nothing; one missing Wh discloses (#211)', () => {
  // The week's sessions account for its days: no suffix, exactly as before —
  // an exactly covered period stays silent at any size.
  const today = new Date(2026, 9, 18, 12);
  const points = periodSeries('week', [{ id: '2026-10-14', kwh: 2 }], today);
  const sessions = [
    { wh: 2000, started_at: new Date(2026, 9, 14, 1), ended_at: new Date(2026, 9, 14, 3) },
  ];
  const covered = seriesCostSummary(points, 'day', NIGHTLY, sessions);
  assert.ok(Math.abs(covered.cost - 0.2) < 1e-9);
  assert.equal(coverageDisclosure(covered), null);
  // #211: the tolerance band is gone. A single missing Wh fires the line —
  // even when both figures read alike at the caption's 0.01 kWh precision,
  // the line itself is the disclosure.
  const day = periodSeries('week', [{ id: '2026-10-14', kwh: 3 }], today);
  const oneWh = seriesCostSummary(day, 'day', NIGHTLY, [
    { wh: 2999, started_at: new Date(2026, 9, 14, 1), ended_at: new Date(2026, 9, 14, 2) },
  ]);
  assert.equal(coverageDisclosure(oneWh), 'priced 3.00 of 3.00 kWh');
  // The compare happens at whole-Wh resolution — the charger counter's own
  // 0.001 kWh quantum — so quantization and attribution float noise cannot
  // flicker the caption. Exactly zero at Wh resolution is the only silent
  // gap: 0.4 Wh of noise under the quantum rounds away…
  const noise = seriesCostSummary(day, 'day', NIGHTLY, [
    { wh: 2999.6, started_at: new Date(2026, 9, 14, 1), ended_at: new Date(2026, 9, 14, 2) },
  ]);
  assert.equal(coverageDisclosure(noise), null);
  // …and a whole covered reading stays quiet outright.
  const exact = seriesCostSummary(day, 'day', NIGHTLY, [
    { wh: 3000, started_at: new Date(2026, 9, 14, 1), ended_at: new Date(2026, 9, 14, 2) },
  ]);
  assert.equal(coverageDisclosure(exact), null);
});

test('the same gap discloses on a week and a month alike (#211)', () => {
  // The shape the issue was filed on: a 4 kWh shortfall showed on a ~90 kWh
  // week while the same 4 kWh vanished inside a ~330 kWh month — the retired
  // max(250 Wh, 2%) band scaled with the window (6.6 kWh at month scale) and
  // absorbed it. The verdict no longer scales with the period: both fire.
  const weekToday = new Date(2026, 9, 18, 12); // Sun 18 October: week of 12–18
  const weekDays = [
    '2026-10-12',
    '2026-10-13',
    '2026-10-14',
    '2026-10-15',
    '2026-10-16',
    '2026-10-17',
    '2026-10-18',
  ];
  const week = seriesCostSummary(
    periodSeries(
      'week',
      weekDays.map((id) => ({
        id,
        // Six covered days at 12.9 kWh plus Sunday's 13.1: 90.5 kWh recorded.
        kwh: id === '2026-10-18' ? 13.1 : 12.9,
      })),
      weekToday,
    ),
    'day',
    NIGHTLY,
    // One plug-in through the first six days: 86.5 kWh attributed, so 4 kWh
    // of the week has no covering session.
    [{ wh: 86500, started_at: new Date(2026, 9, 12), ended_at: new Date(2026, 9, 18) }],
  );
  assert.equal(coverageDisclosure(week), 'priced 86.5 of 90.5 kWh');
  const monthToday = new Date(2026, 9, 31, 12); // October: 31 days
  const month = seriesCostSummary(
    periodSeries(
      'month',
      Array.from({ length: 30 }, (_, i) => ({
        id: `2026-10-${String(i + 1).padStart(2, '0')}`,
        kwh: 11.02, // 330.6 kWh recorded across the covered days
      })),
      monthToday,
    ),
    'day',
    NIGHTLY,
    // The same 4 kWh short, spread thin enough the old 2% band hid it:
    // 326.6 kWh attributed of the month's 330.6.
    [{ wh: 326600, started_at: new Date(2026, 9, 1), ended_at: new Date(2026, 9, 31) }],
  );
  assert.equal(coverageDisclosure(month), 'priced 327 of 331 kWh');
});

test('a period with nothing covered keeps the $ hidden and discloses nothing', () => {
  const points = periodSeries('week', [{ id: '2026-10-15', kwh: 4.2 }], new Date(2026, 9, 18, 12));
  const summary = seriesCostSummary(points, 'day', NIGHTLY);
  assert.equal(summary.cost, null);
  assert.equal(coverageDisclosure(summary), null);
});

test("the Day period's hour summary never carries a coverage disclosure", () => {
  // Hour buckets price the day document's own energy — coverage is
  // definitional on this path, whatever the sessions list holds.
  const points = hourSeries({ '02': 2, 12: 1 }, new Date(2026, 9, 18, 12, 40));
  const summary = seriesCostSummary(points, 'hour', NIGHTLY, []);
  assert.ok(Math.abs(summary.cost - 0.5) < 1e-9);
  assert.ok(Math.abs(summary.coveredWh - 3000) < 1e-9);
  assert.ok(Math.abs(summary.recordedWh - 3000) < 1e-9);
  assert.equal(coverageDisclosure(summary), null);
});

// ---------- the per-window rate-scope flag (#193) ----------
//
// The plan banner is plan-wide (it fires on any gap anywhere); this flag is
// per viewed window — the union of the series' own bucket windows, exactly the
// spans the period's figures price. A season that expires mid-window is the
// #188 shape: the totals are correct, but the window's time is partly flat-
// priced, and the summary says so.

// The #188 plan shape: one all-day season base 15 June – 15 September, with
// the stored flat rate 0.12 as the fallback for every instant outside it.
function expiredSeason(rate = 0.12) {
  return {
    rate,
    currency: 'USD',
    rates: [
      {
        id: 'summer',
        rate: 0.2,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '00:00',
        months: [6, 7, 8, 9],
        from: '06-15',
        to: '09-15',
      },
    ],
  };
}

test('the flag follows the viewed window, not the plan (#193)', () => {
  const plan = expiredSeason();
  // A November week — the #188 report's shape, every instant outside the
  // season — flags.
  const november = periodSeries(
    'week',
    [{ id: '2026-11-16', kwh: 12.4 }],
    new Date(2026, 10, 19, 12),
  );
  assert.equal(seriesWindowUncovered(november, 'day', plan), true);
  // A week the season expires inside: Mon 14 – Thu 19 September 2026, covered
  // through the 15th only.
  const september = periodSeries('week', [{ id: '2026-09-14', kwh: 1 }], new Date(2026, 8, 18, 12));
  assert.equal(seriesWindowUncovered(september, 'day', plan), true);
  // The same plan, a July week fully inside: no per-window flag, while the
  // plan-wide banner still fires — the gap outside the window is the banner's
  // business, not the window's.
  const july = periodSeries('week', [{ id: '2026-07-20', kwh: 1 }], new Date(2026, 6, 22, 12));
  assert.equal(seriesWindowUncovered(july, 'day', plan), false);
  assert.equal(showPlanBanner(plan), true);
  // Flat-only: the flat rate prices every instant by definition.
  assert.equal(seriesWindowUncovered(july, 'day', { rate: 0.12, currency: 'USD' }), false);
  // No finite fallback: the flag still fires — the predicate names scope; the
  // 0.00 wording is the screen's copy path.
  const { rate: _rate, ...noFallback } = plan;
  assert.equal(seriesWindowUncovered(november, 'day', noFallback), true);
});

test('month and hour buckets carry the same per-window flag', () => {
  const plan = expiredSeason();
  // The Year period's month buckets: a year whose months sit mostly outside
  // the season flags; an all-year base covers every month.
  const year = periodSeries('year', [{ id: '2026-07-20', kwh: 5 }], new Date(2026, 11, 30, 12));
  assert.equal(year[0].id, '2026-01');
  assert.equal(seriesWindowUncovered(year, 'month', plan), true);
  const allYear = {
    rate: 0.3,
    currency: 'USD',
    rates: [
      {
        id: 'base',
        rate: 0.3,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '00:00',
        months: null,
      },
    ],
  };
  assert.equal(seriesWindowUncovered(year, 'month', allYear), false);
  // The Day period's hour buckets: a base-less 16:00–19:00 window leaves the
  // other 21 hours uncovered, so the day flags; the all-day base does not.
  const day = hourSeries({ 17: 1 }, new Date(2026, 10, 18, 12));
  const windowOnly = {
    rate: 0.3,
    currency: 'USD',
    rates: [
      {
        id: 'peak',
        rate: 0.32,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '16:00',
        end: '19:00',
        months: null,
      },
    ],
  };
  assert.equal(seriesWindowUncovered(day, 'hour', windowOnly), true);
  assert.equal(seriesWindowUncovered(day, 'hour', allYear), false);
});

// ---------- screen read paths ----------
//
// Decision (issue #85a): the read-path wiring stays a source-text pin; the
// behaviour it guards is covered at the pure layer instead.
//
// Exercising `readHistory`/`loadAll` end-to-end would need `fetchHistory` and
// `fetchHistoryDay` replaced (ESM module mocking, i.e. Node's
// `--experimental-test-module-mocks`) plus a chart DOM to paint into. This repo
// has no DOM harness and no module-mocking setup, and `npm test` must not depend
// on an experimental Node flag, so neither was added. What stays uncovered is
// the screen's read lifecycle: which read runs, what it stores as the captured
// window, and whether the guard fires once a read settles. The fixed-clock
// invariants below pin the decisions that read makes (bounds, points, the
// current slot, the midnight comparison) for every period; the pin at the end of
// this section is the tripwire on the wiring itself, read from source the way
// test/web/sw-shell.test.js reads web/sw.js.
//
// A future DOM + module-mocking harness would buy the lifecycle: an actual stale
// read re-fired after midnight, a response that settles across midnight
// discarded rather than painted, and sign-out/reset clearing the captured
// window mid-flight — none of which source text or the pure layer can prove.

test('a read that straddles local midnight leaves a stale window to re-check', () => {
  // The window record stores the day it was anchored to — `anchorDay`,
  // captured from `now` — and the guard compares that with dayId(new Date()),
  // never with the window's end. Pin the clock either side of midnight and
  // assert what the guard must answer: stale once the day has moved (re-enter
  // the read), fresh while it has not (so the re-read cannot fire, or loop,
  // without a day change).
  const before = new Date(2026, 9, 18, 23, 59, 30).getTime();
  mock.timers.enable({ apis: ['Date'], now: before });
  try {
    for (const period of PERIODS) {
      mock.timers.setTime(before);
      const now = new Date();
      const anchor = periodAnchor(period, 0, now);
      const bounds = periodBounds(period, anchor, now);
      const anchorDay = dayId(now);
      const data = period.source === 'day' ? {} : [];
      const points = periodSeries(period, data, anchor, now);
      // The window and its current-slot flag come from the captured date: at
      // 23:59:30 on 18 Oct the last point is the current one, built for that day
      // (the year's last point is its month, Oct 2026; the day period's last
      // point is the hour in progress, 23).
      assert.equal(anchorDay, '2026-10-18', period.id);
      assert.equal(bounds.endId, '2026-10-18', period.id);
      const last = points[points.length - 1];
      assert.equal(last.isCurrent, true, period.id);
      assert.equal(
        last.id,
        period.bucket === 'month' ? '2026-10' : period.bucket === 'hour' ? '23' : '2026-10-18',
        period.id,
      );
      // Settled 20 s later, still on 18 Oct: the window is current, no re-read.
      mock.timers.setTime(before + 20_000);
      assert.equal(anchorDay, dayId(new Date()), period.id);
      // Settled after midnight: the anchored day is yesterday, so the guard
      // must fire rather than leave yesterday's bars under a "Today" label.
      mock.timers.setTime(before + 60_000);
      assert.equal(dayId(new Date()), '2026-10-19', period.id);
      assert.notEqual(anchorDay, dayId(new Date()), period.id);
      // A series rebuilt for the new day starts at its own current slot: the
      // hour period restarts at 00, every range period ends on the new day.
      const rebuilt = periodSeries(period, data, periodAnchor(period, 0, new Date()), new Date());
      const current = rebuilt.findIndex((point) => point.isCurrent);
      assert.equal(current, period.bucket === 'hour' ? 0 : rebuilt.length - 1, period.id);
    }
  } finally {
    mock.timers.reset();
  }
});

test('a paged window is guarded on the day it was anchored to, not its end', () => {
  const captured = new Date(2026, 9, 18, 23, 59, 30).getTime();
  mock.timers.enable({ apis: ['Date'], now: captured });
  try {
    // The window record buildWindow hands to windowStale(), built the way the
    // screen builds it: the anchor and its bounds belong to the paged offset,
    // the guard's day to `now`.
    const now = new Date();
    const anchor = periodAnchor('month', 1, now);
    const record = {
      anchor,
      bounds: periodBounds('month', anchor, now),
      anchorDay: dayId(now),
    };
    assert.equal(record.bounds.endId, '2026-09-30');
    // The paged end is a past date: comparing it with today would make every
    // read of this window stale and re-enter it forever.
    assert.notEqual(record.bounds.endId, dayId(new Date()));
    assert.equal(record.anchorDay, dayId(new Date()));
    // Same day, later clock: still fresh, so no re-read.
    mock.timers.setTime(captured + 20_000);
    assert.equal(record.anchorDay, dayId(new Date()));
    // Past local midnight the paged window is stale exactly once — the re-read
    // captures a fresh record, so this cannot fire again until the next day.
    mock.timers.setTime(captured + 60_000);
    assert.equal(dayId(new Date()), '2026-10-19');
    assert.notEqual(record.anchorDay, dayId(new Date()));
  } finally {
    mock.timers.reset();
  }
});

test('the day period keeps its captured day until local midnight', () => {
  // Day is the one period read from a single document rather than a day-id
  // range, so its captured window is both the query and the guard's input: the
  // screen stores `anchorDay = dayId(now)` beside the window and compares it
  // with dayId(new Date()). Exercise that for Day explicitly (the loop above
  // covers all four periods generically): the window and the current hour slot
  // survive a clock advance within the captured day, and the window is stale
  // once local midnight passes.
  const captured = new Date(2026, 9, 18, 23, 59, 30).getTime();
  mock.timers.enable({ apis: ['Date'], now: captured });
  try {
    const now = new Date();
    const anchor = periodAnchor('day', 0, now);
    const bounds = periodBounds('day', anchor, now);
    const anchorDay = dayId(now);
    // The captured day is the whole window, and it is the document the read
    // targets: startId and endId are the same day — and the guard stores that
    // day as `anchorDay`, captured from the same clock.
    assert.deepEqual(bounds, { startId: '2026-10-18', endId: '2026-10-18' });
    assert.equal(bounds.startId, bounds.endId);
    assert.equal(anchorDay, bounds.startId);
    // The painted series belongs to that day: hour 23 is in progress.
    const points = periodSeries('day', {}, anchor, now);
    assert.equal(points.length, 24);
    assert.equal(points[23].id, '23');
    assert.equal(points[23].isCurrent, true);
    assert.deepEqual(
      points.filter((point) => point.isCurrent).map((point) => point.id),
      ['23'],
    );

    // Settled 20 s later, still 18 Oct: the captured day is current, so the
    // guard must not fire and the painted slot stays today's.
    mock.timers.setTime(captured + 20_000);
    assert.equal(anchorDay, dayId(new Date()));
    assert.equal(dayId(new Date()), bounds.startId);
    assert.equal(points[23].isCurrent, true);

    // Settled after local midnight: the anchored day is yesterday, so the guard
    // must fire instead of leaving yesterday's hours under "Today".
    mock.timers.setTime(captured + 60_000);
    assert.equal(dayId(new Date()), '2026-10-19');
    assert.notEqual(anchorDay, dayId(new Date()));
    // A re-read captures the new day, and a series built for it starts at hour 0.
    assert.deepEqual(periodBounds('day'), { startId: '2026-10-19', endId: '2026-10-19' });
    const rebuilt = periodSeries('day', {});
    assert.equal(
      rebuilt.findIndex((point) => point.isCurrent),
      0,
    );
  } finally {
    mock.timers.reset();
  }
});

test('both history read paths end with the midnight re-check', () => {
  // A period switch reads through readHistory; Refresh and activation read
  // through loadAll. Both must end with the same guard, but the guard needs a
  // DOM and a Firebase read, so the wiring is held statically (the sw-shell
  // pattern) rather than through a browser harness this repo does not have.
  const source = readFileSync(new URL('../../web/js/screens/history.js', import.meta.url), 'utf8');
  const body = (name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `screens/history.js declares ${name}`);
    const end = source.indexOf('\n}\n', start);
    assert.ok(end > start, `screens/history.js closes ${name}`);
    return source.slice(start, end + 2);
  };
  for (const name of ['readHistory', 'loadAll']) {
    // The guard is the last statement of the read, not a conditional aside.
    assert.match(body(name), /\n\s*reloadIfWindowStale\(\);\n}$/, name);
    // The Day period is read inside these same two functions, so its read gets
    // the guard too; a forked Day read would fail this pin.
    assert.match(body(name), /fetchPeriod\(descriptor/, name);
    // #123: whichever reader paints the range also fetches its overlapping
    // sessions — dropping the pricing read from either path fails here.
    assert.match(body(name), /fetchPeriodSessions\(descriptor, bounds\)/, name);
  }
  // One read chooser, branching on the descriptor's source rather than a period
  // id: the Day document read cannot acquire a tail of its own. The arguments are
  // pinned to the window's bounds, not just the call: the Day period's whole claim
  // is that it reads the day its window names, and `dayId(new Date())` there would
  // read today's document for every paged day with nothing else failing.
  assert.match(body('fetchPeriod'), /descriptor\.source === 'day'/);
  assert.match(body('fetchPeriod'), /periodReads\.day\(bounds\.endId\)/);
  assert.match(body('fetchPeriod'), /periodReads\.range\(bounds\.startId, bounds\.endId\)/);
  // The read it chooses between is indirected (the harness substitutes it to drive
  // a read it controls), so the object must hold both of the store's reads: an
  // indirected read that stopped being the store's would fail no other test.
  assert.match(
    source,
    /export const periodReads = \{\s*day: \(day\) => fetchHistoryDay\(day\),\s*range: \(startId, endId\) => fetchHistory\(startId, endId\),\s*\};/,
  );
  // The sessions read is the $ counterpart: Day resolves empty, a range pages
  // the widened started_at window (sessionsRange), and only Firestore can
  // reject it — the unwrap of the paged read's envelope into its docs is
  // executed by the history-screen harness, not pinned here.
  assert.match(body('fetchPeriodSessions'), /descriptor\.source === 'day'/);
  assert.match(body('fetchPeriodSessions'), /readRange\(range\)\.then\(\(read\) => read\.docs\)/);
  // `now` is the clock the window was captured at, passed as applyHistory's 6th
  // argument: dropping it makes the series mark a past bucket current again.
  // The pure tests prove periodSeries honours `now`; only this pin proves the
  // read paths pass it.
  for (const name of ['readHistory', 'loadAll']) {
    assert.match(
      body(name),
      /applyHistory\(\s*descriptor,[\s\S]*?readWindow\.anchor,[\s\S]*?\bnow,\s*\)/,
      name,
    );
  }
  // Only the newest read repaints the chart or spends the focus reservation, so
  // each path holds its paint and release behind its own sequence guard: the
  // paged read returns at the guard, the reload wraps them in `if (seq ===
  // historySeq)`. Deleting either guard re-opens the superseded-read repaint the
  // history-screen harness drives from both sides (a read vs a reload, and a
  // paged read vs a paged read).
  assert.match(
    body('readHistory'),
    /if \(gen !== generation \|\| seq !== historySeq\) return;[\s\S]*?renderHistory\(\);[\s\S]*?releaseChartFocus\(\);/,
  );
  assert.match(
    body('loadAll'),
    /if \(seq === historySeq\) \{\n\s+applyHistory\([\s\S]*?\n\s+renderHistory\(\);\n\s+releaseChartFocus\(\);\n {2}\}/,
  );
  // The window build takes `now` for the bounds as well as the span: a paged
  // Year window is whole months only while the third argument is passed.
  assert.match(body('buildWindow'), /periodBounds\(descriptor, anchor, now\)/);
  assert.match(body('buildWindow'), /anchorDay: dayId\(now\)/);
  // The payload is applied with the points it prices — never painted beside
  // another range's sessions.
  assert.match(body('applyHistory'), /periodSessions = Array\.isArray\(sessions\)/);
  // One mechanism for both: the shared guard owns the staleness check.
  assert.match(body('reloadIfWindowStale'), /windowStale\(\)/);
});

test('the span and its bounds default their clock alike', () => {
  // `periodSpan`'s two clock-ish arguments must default to one moment, as
  // `periodBounds`'s and the series builders' already do: two independent
  // `new Date()` defaults let a default-argument call describe a window that
  // straddles midnight, which the screen's own `currentSpan()` exists to avoid.
  // Neither live caller leans on it (both pass `now`), so only the shape pins it.
  const source = readFileSync(new URL('../../web/js/history.js', import.meta.url), 'utf8');
  for (const name of ['periodBounds', 'periodSpan']) {
    assert.match(
      source,
      new RegExp(`export function ${name}\\(period, anchor = new Date\\(\\), now = anchor\\)`),
      name,
    );
  }
});

test('no web source or README still calls a chart period a rolling window', () => {
  // #155's copy guard, pinned where the repo's other source pins live. A calendar
  // unit is named as the unit it is, so no shipped string may call the period a
  // "rolling window" or describe it as "the last 7 days", "the last 30 days" or
  // "the last 12 months". Scanning the files (rather than asserting on
  // copy(span)) also catches a static markup default, a second copy table, or a
  // comment-shaped string that would reach the UI without the pure tests seeing
  // it; the phrase is banned rather than the bare word, which a comment about
  // any other rolling construct may still use. docs/VALIDATION.md is
  // deliberately outside the sweep: its checks quote these words as things the
  // screen must not say.
  const webRoot = new URL('../../web/', import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(js|html|css)$/.test(entry.name)) files.push(path);
    }
  };
  // `pathname` keeps the leading slash of a file URL, which Windows treats as
  // a drive-relative path: readdirSync('C:\C:\...') fails with ENOENT.
  walk(fileURLToPath(webRoot));
  assert.ok(files.length > 0, 'the sweep found the web sources');
  const shipped = [
    ['README.md', readFileSync(new URL('../../README.md', import.meta.url), 'utf8')],
    ...files.map((path) => [path, readFileSync(path, 'utf8')]),
  ];
  for (const [path, text] of shipped) {
    for (const banned of [
      /rolling[ -]window/i,
      /last 7 days/i,
      /last 30 days/i,
      /last 12 months/i,
    ]) {
      assert.doesNotMatch(text, banned, path);
    }
  }
});
