import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  CHART_VIEW_W,
  DEFAULT_PERIOD,
  PERIODS,
  chartIndexAt,
  dayId,
  dayLabel,
  historyReadState,
  historySeries,
  lastDayIds,
  maxSeries,
  monthId,
  monthLabel,
  periodBounds,
  periodById,
  periodSeries,
  sectionView,
  sumSeries,
} from '../../web/js/history.js';
import { showPlanBanner } from '../../web/js/screens/history.js';

test('dayId uses local calendar components', () => {
  assert.equal(dayId(new Date(2026, 0, 5, 12)), '2026-01-05');
  assert.equal(dayId(new Date(2026, 11, 31, 23)), '2026-12-31');
});

test('lastDayIds returns the last 30 local days oldest first', () => {
  const ids = lastDayIds(30, new Date(2026, 9, 18, 12));
  assert.equal(ids.length, 30);
  assert.equal(ids[0], '2026-09-19');
  assert.equal(ids[29], '2026-10-18');
  assert.deepEqual(lastDayIds(3, new Date(2026, 9, 18, 12)), [
    '2026-10-16',
    '2026-10-17',
    '2026-10-18',
  ]);
  assert.equal(new Set(ids).size, 30);
});

test('lastDayIds stays contiguous across a DST change (fixed America/Denver)', () => {
  // Run in a child with a fixed TZ so the spring-forward boundary is exercised
  // on every host (a UTC runner would otherwise pass without a DST transition).
  const moduleUrl = new URL('../../web/js/history.js', import.meta.url).href;
  const script = `
    import { lastDayIds } from ${JSON.stringify(moduleUrl)};
    // Guard against a host whose tzdata lacks America/Denver.
    if (new Date(2026, 2, 8, 12).getTimezoneOffset() !== 360) {
      console.error('unexpected offset', new Date(2026, 2, 8, 12).getTimezoneOffset());
      process.exit(1);
    }
    // A midnight fixture also catches millisecond arithmetic across the shift.
    const ids = lastDayIds(7, new Date(2026, 2, 9, 0, 30));
    const expected = [
      '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
      '2026-03-07', '2026-03-08', '2026-03-09',
    ];
    if (JSON.stringify(ids) !== JSON.stringify(expected)) {
      console.error(JSON.stringify(ids));
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
  // The contract #61 extends: one descriptor per range, and the chart reads the
  // series length rather than any period-specific slot constant.
  assert.deepEqual(
    PERIODS.map((period) => period.id),
    ['day', 'week', 'month', 'year'],
  );
  assert.equal(DEFAULT_PERIOD, 'month');
  assert.deepEqual(Object.fromEntries(PERIODS.map((period) => [period.id, period.slots])), {
    day: 24,
    week: 7,
    month: 30,
    year: 12,
  });
  // `source` decides the read (one day document or a day-id range) and `bucket`
  // the series derivation; both are data, so the screen has no period-id branch.
  assert.deepEqual(Object.fromEntries(PERIODS.map((period) => [period.id, period.source])), {
    day: 'day',
    week: 'range',
    month: 'range',
    year: 'range',
  });
  for (const period of PERIODS) {
    assert.ok(['hour', 'day', 'month'].includes(period.bucket), period.id);
    for (const key of [
      'label',
      'summaryLabel',
      'noun',
      'chartLabel',
      'emptyTitle',
      'emptyLine',
      'loadingLine',
      'offlineLine',
    ]) {
      assert.equal(typeof period[key], 'string', `${period.id}.${key}`);
      assert.ok(period[key].length > 0, `${period.id}.${key}`);
    }
  }
  // Only a day without hourly buckets uses the "no intraday detail" copy.
  const day = periodById('day');
  for (const key of ['noIntradayTitle', 'noIntradayLine']) {
    assert.equal(typeof day[key], 'string', `day.${key}`);
    assert.ok(day[key].length > 0, `day.${key}`);
  }
  for (const period of PERIODS.filter((candidate) => candidate.source !== 'day')) {
    assert.equal(period.noIntradayTitle, undefined, period.id);
  }
  assert.equal(periodById('year'), PERIODS[3]);
  // Unknown ids fall back to today's default, never to an unrelated range.
  assert.equal(periodById('nope').id, DEFAULT_PERIOD);
});

test('periodBounds returns one contiguous local range for each period', () => {
  const today = new Date(2026, 9, 18, 12);
  assert.deepEqual(periodBounds('week', today), {
    startId: '2026-10-12',
    endId: '2026-10-18',
  });
  assert.deepEqual(periodBounds('month', today), {
    startId: '2026-09-19',
    endId: '2026-10-18',
  });
  assert.deepEqual(periodBounds('year', today), {
    startId: '2025-11-01',
    endId: '2026-10-18',
  });
  // A descriptor works as well as an id — the screen passes the descriptor.
  assert.deepEqual(periodBounds(periodById('week'), today), periodBounds('week', today));
});

test('periodBounds crosses month and year boundaries', () => {
  // A month boundary: the 30-day window still reads as one day-id range.
  assert.deepEqual(periodBounds('month', new Date(2026, 2, 1, 12)), {
    startId: '2026-01-31',
    endId: '2026-03-01',
  });
  assert.deepEqual(periodBounds('week', new Date(2026, 2, 1, 12)), {
    startId: '2026-02-23',
    endId: '2026-03-01',
  });
  // A year rollover: twelve months ending with January 2026 start in February.
  assert.deepEqual(periodBounds('year', new Date(2026, 0, 3, 12)), {
    startId: '2025-02-01',
    endId: '2026-01-03',
  });
});

test('periodBounds keeps 29 February inside a leap-year range', () => {
  const today = new Date(2028, 2, 1, 12);
  // The 30-day window that ends on 1 March covers all 29 February days.
  assert.deepEqual(periodBounds('month', today), {
    startId: '2028-02-01',
    endId: '2028-03-01',
  });
  assert.deepEqual(periodBounds('year', today), {
    startId: '2027-04-01',
    endId: '2028-03-01',
  });
});

test('periodBounds stays on local calendar days across a DST change (fixed America/Denver)', () => {
  // Same child-process pattern as lastDayIds: a UTC runner must still exercise
  // the spring-forward boundary, and a 00:30 fixture catches midnight arithmetic.
  const moduleUrl = new URL('../../web/js/history.js', import.meta.url).href;
  const script = `
    import { periodBounds } from ${JSON.stringify(moduleUrl)};
    if (new Date(2026, 2, 9, 12).getTimezoneOffset() !== 360) {
      console.error('unexpected offset', new Date(2026, 2, 9, 12).getTimezoneOffset());
      process.exit(1);
    }
    const today = new Date(2026, 2, 9, 0, 30);
    const expected = {
      week: { startId: '2026-03-03', endId: '2026-03-09' },
      month: { startId: '2026-02-08', endId: '2026-03-09' },
      year: { startId: '2025-04-01', endId: '2026-03-09' },
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

test('periodSeries renders one point per slot for a week, with gaps as zero bars', () => {
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

test('periodSeries keeps the 30-day month window and marks today', () => {
  const today = new Date(2026, 9, 18, 12);
  const points = periodSeries(
    'month',
    [
      { id: '2026-09-19', kwh: 2 },
      { id: '2026-10-18', kwh: 4 },
    ],
    today,
  );
  assert.equal(points.length, 30);
  assert.equal(points[0].id, '2026-09-19');
  assert.equal(points[0].label, 'Sat 19 Sep');
  assert.equal(points[0].kwh, 2);
  assert.equal(points[29].id, '2026-10-18');
  assert.equal(points[29].kwh, 4);
  assert.equal(points.filter((point) => point.isCurrent).length, 1);
  assert.equal(points[29].isCurrent, true);
  // Month is the default, so these are identically the old 30-day ids.
  assert.deepEqual(
    points.map((point) => point.id),
    lastDayIds(30, today),
  );
});

test('periodSeries sums a year into 12 monthly points ending with the current month', () => {
  const today = new Date(2026, 9, 18, 12);
  const points = periodSeries(
    'year',
    [
      { id: '2025-10-31', kwh: 99 },
      { id: '2025-11-01', kwh: 1 },
      { id: '2025-11-30', kwh: 2 },
      { id: '2026-02-28', kwh: 3 },
      { id: '2026-02-01', kwh: 4 },
      { id: '2026-10-02', kwh: 5 },
      { id: '2026-10-18', kwh: 6 },
    ],
    today,
  );
  assert.equal(points.length, 12);
  assert.equal(points[0].id, '2025-11');
  assert.equal(points[0].label, 'Nov 2025');
  assert.equal(points[11].id, '2026-10');
  assert.equal(points[0].kwh, 3);
  assert.equal(points.find((point) => point.id === '2026-02').kwh, 7);
  // The current month is the partial sum of the days recorded so far; the
  // series stops with it (no zero-padded next month).
  assert.equal(points[11].kwh, 11);
  assert.equal(points[11].label, 'Oct 2026');
  assert.deepEqual(points.map((point) => point.isCurrent).filter(Boolean), [true]);
  assert.equal(points[11].isCurrent, true);
  // Twelve months is the whole window, including the one before the range.
  assert.equal(sumSeries(points), 21);
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
  for (const [period, count] of [
    ['week', 7],
    ['month', 30],
    ['year', 12],
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
  // Nothing is shown for a section that has neither data nor a result yet.
  for (const state of ['idle', 'loading', 'nonsense']) {
    assert.equal(sectionView(state, true).showData, false, state);
    assert.equal(sectionView(state, true).claimEmpty, false, state);
  }
});

test('the plan banner appears exactly when a saved plan has an unpriced instant', () => {
  // Gap 3: the banner is the only signal that a stored plan prices some hours or
  // dates at 0.00 before the owner opens settings. Its condition is a pure
  // predicate so it is covered without a DOM.
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
  // A base-less season leaves hours at 0.00 even though its dates are covered.
  assert.equal(showPlanBanner(settings([peak])), true);
  // A date season leaves the rest of the year uncovered.
  assert.equal(showPlanBanner(settings([summer])), true);
});

// ---------- screen read paths ----------

test('a read that straddles local midnight leaves a stale window to re-check', () => {
  // The screen captures `today` once per read and stores its day as `todayId`,
  // so its midnight check is exactly `dayId(new Date()) !== bounds.endId`. Pin
  // the clock either side of midnight and assert what the guard must answer:
  // true once the day has moved (re-enter the read), false while it has not (so
  // the re-read cannot fire, or loop, without a day change).
  const before = new Date(2026, 9, 18, 23, 59, 30).getTime();
  mock.timers.enable({ apis: ['Date'], now: before });
  try {
    for (const period of PERIODS) {
      mock.timers.setTime(before);
      const bounds = periodBounds(period);
      const data = period.source === 'day' ? {} : [];
      const points = periodSeries(period, data);
      // The window and its current-slot flag come from the captured date: at
      // 23:59:30 on 18 Oct the last point is the current one, built for that day
      // (the year's last point is its month, Oct 2026; the day period's last
      // point is the hour in progress, 23).
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
      assert.equal(bounds.endId, dayId(new Date()), period.id);
      // Settled after midnight: the same window now ends yesterday, so the
      // guard must fire rather than leave yesterday's bars under a "Today" label.
      mock.timers.setTime(before + 60_000);
      assert.equal(dayId(new Date()), '2026-10-19', period.id);
      assert.notEqual(bounds.endId, dayId(new Date()), period.id);
      // A series rebuilt for the new day starts at its own current slot: the
      // hour period restarts at 00, every range period ends on the new day.
      const rebuilt = periodSeries(period, data);
      const current = rebuilt.findIndex((point) => point.isCurrent);
      assert.equal(current, period.bucket === 'hour' ? 0 : rebuilt.length - 1, period.id);
    }
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
  }
  // One mechanism for both: the shared guard owns the staleness check.
  assert.match(body('reloadIfWindowStale'), /windowStale\(\)/);
});
