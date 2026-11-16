import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  CHART_VIEW_W,
  DEFAULT_PERIOD,
  PERIODS,
  SESSIONS_LOOKBACK_DAYS,
  chartIndexAt,
  dayId,
  dayLabel,
  historyReadState,
  historySeries,
  hourId,
  hourRange,
  hourReadFailure,
  hourReadState,
  hourSeries,
  lastDayIds,
  maxSeries,
  monthId,
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
  pointCostSummary,
  seriesCostSummary,
  showPlanBanner,
} from '../../web/js/screens/history.js';
import { sessionCostLabel } from '../../web/js/cost.js';

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
  // Paging's arithmetic is data too: one step in the period's own unit, so the
  // screen never decides what a period means.
  assert.deepEqual(Object.fromEntries(PERIODS.map((period) => [period.id, period.step])), {
    day: { unit: 'day', size: 1 },
    week: { unit: 'day', size: 7 },
    month: { unit: 'day', size: 30 },
    year: { unit: 'month', size: 12 },
  });
  for (const period of PERIODS) {
    // The key set is the contract: every field has a consumer and a field that
    // has none — a descriptor `label`, say — would be a second naming source the
    // suite could not see being re-added.
    assert.deepEqual(
      Object.keys(period).sort(),
      ['bucket', 'copy', 'id', 'noun', 'prefixToday', 'slots', 'source', 'span', 'step'],
      period.id,
    );
    assert.ok(['hour', 'day', 'month'].includes(period.bucket), period.id);
    assert.equal(typeof period.noun, 'string', `${period.id}.noun`);
    assert.ok(period.noun.length > 0, `${period.id}.noun`);
    assert.equal(typeof period.span.label, 'string', `${period.id}.span.label`);
    assert.equal(typeof period.span.phrase, 'string', `${period.id}.span.phrase`);
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

// The default view's wording, byte for byte. #154 keeps offset 0 identical to
// the shipped screen, so every string is pinned as a literal here rather than
// compared with the implementation.
// Date spans glue their runs with hard spaces; compare painted copy as text.
const plain = (text) => text.replace(/\u00a0/g, ' ');

const DEFAULT_COPY = {
  day: {
    label: 'Today',
    phrase: 'today',
    chartLabel: 'Hourly energy for today. Use the left and right arrow keys to move between hours.',
    emptyTitle: 'No energy recorded today.',
    emptyLine: 'Hours appear as charging is recorded.',
    noIntradayTitle: 'No hourly detail for today.',
    noIntradayLine: 'Hourly capture began recently, so today has a total but no hours behind it.',
    loadingLine: 'Reading today.',
    offlineLine: "Reconnect, then tap Refresh to load today's hours.",
  },
  week: {
    label: 'Last 7 days',
    phrase: 'the last 7 days',
    chartLabel:
      'Daily energy for the last 7 days. Use the left and right arrow keys to move between days.',
    emptyTitle: 'No energy recorded in the last 7 days.',
    emptyLine: 'Days without charging count as zero.',
    loadingLine: 'Reading the last 7 days.',
    offlineLine: 'Reconnect, then tap Refresh to load the last 7 days.',
  },
  month: {
    label: 'Last 30 days',
    phrase: 'the last 30 days',
    chartLabel:
      'Daily energy for the last 30 days. Use the left and right arrow keys to move between days.',
    emptyTitle: 'No energy recorded in the last 30 days.',
    emptyLine: 'Days without charging count as zero.',
    loadingLine: 'Reading the last 30 days.',
    offlineLine: 'Reconnect, then tap Refresh to load the last 30 days.',
  },
  year: {
    label: 'Last 12 months',
    phrase: 'the last 12 months',
    chartLabel:
      'Monthly energy for the last 12 months. Use the left and right arrow keys to move between months.',
    emptyTitle: 'No energy recorded in the last 12 months.',
    emptyLine: 'Months without charging count as zero.',
    loadingLine: 'Reading the last 12 months.',
    offlineLine: 'Reconnect, then tap Refresh to load the last 12 months.',
  },
};

test('offset 0 keeps the default view byte for byte', () => {
  const now = new Date(2026, 9, 18, 12);
  for (const period of PERIODS) {
    const want = DEFAULT_COPY[period.id];
    const span = periodSpan(period.id, periodAnchor(period.id, 0, now), now);
    assert.deepEqual(span, { label: want.label, phrase: want.phrase, isDefault: true }, period.id);
    const { chartLabel, emptyTitle, emptyLine, loadingLine, offlineLine, ...rest } =
      period.copy(span);
    assert.deepEqual(
      { chartLabel, emptyTitle, emptyLine, loadingLine, offlineLine },
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
      assert.deepEqual(rest, {
        noIntradayTitle: want.noIntradayTitle,
        noIntradayLine: want.noIntradayLine,
      });
    } else {
      assert.deepEqual(rest, {}, period.id);
    }
  }
  // The default span is a function of the clock alone: any anchor on today's
  // local date is the default register, whatever the hour.
  assert.equal(periodSpan('month', new Date(2026, 9, 18, 0, 5), now).isDefault, true);
  assert.equal(periodSpan('month', new Date(2026, 9, 18, 23, 55), now).isDefault, true);
  assert.equal(periodSpan('month', new Date(2026, 9, 17, 23, 55), now).isDefault, false);
});

test('periodAnchor steps back one period in that period own unit', () => {
  const now = new Date(2026, 9, 18, 12);
  assert.equal(dayId(periodAnchor('day', 0, now)), '2026-10-18');
  assert.equal(dayId(periodAnchor('day', 1, now)), '2026-10-17');
  assert.equal(dayId(periodAnchor('day', 3, now)), '2026-10-15');
  assert.equal(dayId(periodAnchor('week', 1, now)), '2026-10-11');
  assert.equal(dayId(periodAnchor('week', 2, now)), '2026-10-04');
  assert.equal(dayId(periodAnchor('month', 1, now)), '2026-09-18');
  assert.equal(dayId(periodAnchor('month', 2, now)), '2026-08-19');
  // A year steps twelve calendar months, not 365 days: the date is preserved.
  assert.equal(dayId(periodAnchor('year', 1, now)), '2025-10-18');
  assert.equal(dayId(periodAnchor('year', 3, now)), '2023-10-18');
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

test('periodAnchor keeps the local calendar across month ends and leap years', () => {
  // A year step off 29 February lands on 28 February of the common year.
  assert.equal(dayId(periodAnchor('year', 1, new Date(2028, 1, 29, 12))), '2027-02-28');
  // …and back into a leap year keeps 28 February, not a rolled-over 1 March.
  assert.equal(dayId(periodAnchor('year', 1, new Date(2027, 1, 28, 12))), '2026-02-28');
  assert.equal(dayId(periodAnchor('year', 1, new Date(2026, 2, 31, 12))), '2025-03-31');
  // A 30-day month step is day arithmetic, so it crosses months and years.
  assert.equal(dayId(periodAnchor('month', 1, new Date(2026, 0, 5, 12))), '2025-12-06');
  assert.equal(dayId(periodAnchor('month', 1, new Date(2026, 2, 1, 12))), '2026-01-30');
  // The window a paged anchor draws is the period's own range around it, read
  // whole-month at a past anchor. 28 February 2027 is that month's last day, so
  // this probe alone cannot tell the whole-month range from one that stops on the
  // anchor — the leap-year probe below is the one that separates them.
  const leap = new Date(2028, 1, 29, 12);
  assert.deepEqual(periodBounds('year', periodAnchor('year', 1, leap), leap), {
    startId: '2026-03-01',
    endId: '2027-02-28',
  });
  // 28 February 2028 is *not* that month's last day: a range that stopped on the
  // anchor would orphan 29 February between two windows, so the paged range runs
  // to the month's real end.
  const short = new Date(2029, 1, 28, 12);
  assert.deepEqual(periodBounds('year', periodAnchor('year', 1, short), short), {
    startId: '2027-03-01',
    endId: '2028-02-29',
  });
});

test('periodAnchor stays on local calendar days across a DST change (fixed America/Denver)', () => {
  // Same child-process pattern as lastDayIds: a UTC runner must still exercise
  // the spring-forward boundary, and a 00:30 fixture catches midnight arithmetic.
  const moduleUrl = new URL('../../web/js/history.js', import.meta.url).href;
  const script = `
    import { dayId, periodAnchor, periodBounds } from ${JSON.stringify(moduleUrl)};
    if (new Date(2026, 2, 9, 12).getTimezoneOffset() !== 360) {
      console.error('unexpected offset', new Date(2026, 2, 9, 12).getTimezoneOffset());
      process.exit(1);
    }
    const now = new Date(2026, 2, 9, 0, 30);
    const week = periodAnchor('week', 1, now);
    if (dayId(week) !== '2026-03-02') {
      console.error('week anchor', dayId(week));
      process.exit(1);
    }
    const bounds = periodBounds('week', week);
    if (JSON.stringify(bounds) !== JSON.stringify({ startId: '2026-02-24', endId: '2026-03-02' })) {
      console.error('week bounds', JSON.stringify(bounds));
      process.exit(1);
    }
    if (dayId(periodAnchor('day', 1, now)) !== '2026-03-08') {
      console.error('day anchor', dayId(periodAnchor('day', 1, now)));
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
  // Every period is a contiguous day-id range, Year included: the earlier
  // window's last day is the day before the later window's first day. Year is
  // the one month-bucketed period, so this is the assertion that its paged
  // window covers whole months instead of stopping on the anchor's day.
  for (const period of ['day', 'week', 'month', 'year']) {
    for (const offset of [0, 1, 2, 3]) {
      const later = periodBounds(period, periodAnchor(period, offset, now), now);
      const earlier = periodBounds(period, periodAnchor(period, offset + 1, now), now);
      assert.equal(
        earlier.endId,
        before(later),
        `${period} offset ${offset + 1} ends where offset ${offset} begins`,
      );
      // The full slot count, and no id is drawn twice: a paged window that lost
      // its newest slot would still pass adjacency, so the length is pinned here.
      const ids = periodSeries(period, [], periodAnchor(period, offset, now), now).map(
        (point) => point.id,
      );
      assert.equal(ids.length, periodById(period).slots, `${period} offset ${offset}`);
      assert.equal(new Set(ids).size, ids.length, `${period} offset ${offset}`);
    }
  }
});

test('a paged Year window reads whole months', () => {
  const now = new Date(2026, 10, 16, 12);
  // Offset 1 is the 12 months before the newest month drawn, so its last day is
  // 30 November — not the anchor's 16 November, which left 17–30 November owned
  // by no window and the Nov 2025 bar reading 16 kWh instead of 30.
  const anchor = periodAnchor('year', 1, now);
  assert.deepEqual(periodBounds('year', anchor, now), {
    startId: '2024-12-01',
    endId: '2025-11-30',
  });
  // The label names exactly the months that range reads.
  assert.equal(plain(periodSpan('year', anchor, now).label), 'Dec 2024 – Nov 2025');
  // The default window is unchanged: its newest month is in progress, so it
  // still stops at today's date.
  assert.deepEqual(periodBounds('year', periodAnchor('year', 0, now), now), {
    startId: '2025-12-01',
    endId: '2026-11-16',
  });
  // A fully recorded year sums every day of its months: the partial-month hole
  // would have made the newest bar 16 and the total 351.
  const docs = [];
  for (const day = new Date(2024, 11, 1, 12); day <= new Date(2025, 11, 30, 12);) {
    docs.push({ id: dayId(day), kwh: 1 });
    day.setDate(day.getDate() + 1);
  }
  const series = periodSeries('year', docs, anchor, now);
  assert.equal(series.length, 12);
  assert.equal(series[11].kwh, 30);
  assert.equal(sumSeries(series), 365);
});

test('periodSpan names a past window by the dates it draws', () => {
  const now = new Date(2026, 9, 18, 12);
  // The title register the summary label paints: short months — the vocabulary
  // the chart's own bar labels use — with the year kept.
  const title = (span) => plain(span.label);
  // Every date run is glued, so a range has exactly one break opportunity —
  // the space after the dash — and a single date has none. A year never lands
  // on a line of its own.
  const breakable = (span) => span.label.split(' ').length - 1;
  const day = periodSpan('day', periodAnchor('day', 1, now), now);
  assert.equal(title(day), '17 Oct 2026');
  assert.equal(breakable(day), 0);
  // The prose register the sentences use spells the months out.
  assert.equal(plain(day.phrase), '17 October 2026');
  assert.equal(day.isDefault, false);
  // Week/Month: a day range, collapsing the month when both ends share it.
  const week = periodSpan('week', periodAnchor('week', 1, now), now);
  assert.equal(title(week), '5 – 11 Oct 2026');
  assert.equal(plain(week.phrase), '5 – 11 October 2026');
  assert.equal(breakable(week), 1);
  assert.equal(title(periodSpan('week', periodAnchor('week', 2, now), now)), '28 Sep – 4 Oct 2026');
  const month = periodSpan('month', periodAnchor('month', 1, now), now);
  assert.equal(title(month), '20 Aug – 18 Sep 2026');
  assert.equal(plain(month.phrase), '20 August – 18 September 2026');
  // A range that crosses a year boundary names both years.
  assert.equal(
    title(periodSpan('week', new Date(2026, 0, 2, 12), now)),
    '27 Dec 2025 – 2 Jan 2026',
  );
  // Year: the whole months its bars draw, not the partial day its read ends on.
  const year = periodSpan('year', periodAnchor('year', 1, now), now);
  assert.equal(title(year), 'Nov 2024 – Oct 2025');
  assert.equal(plain(year.phrase), 'November 2024 – October 2025');
  assert.equal(breakable(year), 1);
});

test('paged copy names its span and never claims the window is now', () => {
  const now = new Date(2026, 9, 18, 12);
  // Every word that names the default window, and must not describe another —
  // including the partial-bucket wording the Year bars would otherwise borrow
  // from the current month.
  const banned = [
    /today/i,
    /last 7 days/i,
    /last 30 days/i,
    /last 12 months/i,
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
    'No energy recorded on 17 October 2026.',
  );
  // The Month window's offline copy names its dates too.
  const monthSpan = periodSpan('month', periodAnchor('month', 1, now), now);
  assert.equal(
    plain(periodById('month').copy(monthSpan).offlineLine),
    'Reconnect, then tap Refresh to load the energy for 20 August – 18 September 2026.',
  );
  assert.equal(
    plain(periodById('month').copy(monthSpan).emptyTitle),
    'No energy recorded for 20 August – 18 September 2026.',
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
  // A month boundary: the 30-day window still reads as one day-id range, and
  // the day period never leaves its own calendar day.
  assert.deepEqual(periodBounds('day', new Date(2026, 2, 1, 12)), {
    startId: '2026-03-01',
    endId: '2026-03-01',
  });
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
  // The day period is the leap day itself when it is today.
  assert.deepEqual(periodBounds('day', new Date(2028, 1, 29, 8)), {
    startId: '2028-02-29',
    endId: '2028-02-29',
  });
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

test('sessionsRange bounds the period sessions read half-open with a plug-in lookback', () => {
  // #123's pricing read: sessions may start up to a week before the range
  // (a plug-in still charging into it) and until the midnight after its last
  // day — a session starting on the last day must be included.
  const week = sessionsRange(periodBounds('week', new Date(2026, 9, 18, 12)));
  assert.equal(week.start.getTime(), new Date(2026, 9, 5).getTime());
  assert.equal(week.end.getTime(), new Date(2026, 9, 19).getTime());
  const year = sessionsRange(periodBounds('year', new Date(2026, 9, 18, 12)));
  assert.equal(year.start.getTime(), new Date(2025, 9, 25).getTime());
  assert.equal(year.end.getTime(), new Date(2026, 9, 19).getTime());
  assert.equal(SESSIONS_LOOKBACK_DAYS, 7);
  // Malformed bounds read nothing rather than querying garbage.
  assert.equal(sessionsRange({ startId: 'nope', endId: '2026-10-18' }), null);
  assert.equal(sessionsRange(null), null);
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
      day: { startId: '2026-03-09', endId: '2026-03-09' },
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
  // be flagged current (a past Day's same clock hour). Nothing in the readout
  // says "Today" for Day (prefixToday is false), so the damage was concrete
  // elsewhere: the live-pricing gate opened over a past bucket, the bar's
  // accessible name gained "(this hour so far)", and the selection jumped to that
  // bucket instead of the newest one.
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
  // nothing in it is current.
  const lastYear = new Date(2025, 9, 18, 12, 40);
  assert.equal(periodSeries('week', [], lastYear, now).filter((p) => p.isCurrent).length, 0);
  assert.equal(periodSeries('week', [], lastYear, now).at(-1).id, '2025-10-18');
  assert.equal(periodSeries('month', [], lastYear, now).filter((p) => p.isCurrent).length, 0);
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
  // the summary — the acceptance scenario verbatim.
  const oct19 = pointCostSummary(points[3], 'day', OCTOBER, sessions);
  assert.ok(Math.abs(oct19.cost - ((11461 * 20520) / 22380 / 1000) * 0.15303) < 1e-9);
  assert.equal(oct19.pricedEnergy, true);
  assert.equal(oct19.unpricedEnergy, false);
  // And the day whose session spans midnight keeps its other half on the
  // next day, exactly once.
  const oct20 = pointCostSummary(points[4], 'day', OCTOBER, sessions);
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
  // An hour bucket is priced, or it is 0.00.
  assert.deepEqual(pointCostSummary(points[2], 'hour', NIGHTLY, sessions), {
    cost: 0.2,
    pricedEnergy: true,
    unpricedEnergy: false,
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
    assert.equal(record.bounds.endId, '2026-09-18');
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
