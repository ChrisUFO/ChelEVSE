import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  CHART_SLOTS,
  CHART_VIEW_W,
  chartIndexAt,
  dayId,
  dayLabel,
  historyReadState,
  historySeries,
  lastDayIds,
  maxSeries,
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

test('chartIndexAt maps a pointer to the nearest chart slot', () => {
  const rect = { left: 20, width: CHART_VIEW_W };
  assert.equal(CHART_SLOTS, 30);
  assert.equal(chartIndexAt(20, rect, 30), 0);
  assert.equal(chartIndexAt(25, rect, 30), 0);
  assert.equal(chartIndexAt(35, rect, 30), 1);
  assert.equal(chartIndexAt(319.9, rect, 30), 29);
  // The hit test scales with the rendered width.
  assert.equal(chartIndexAt(75, { left: 0, width: 150 }, 30), 15);
  // Outside the plot, missing geometry, or fewer points than slots.
  assert.equal(chartIndexAt(19, rect, 30), null);
  assert.equal(chartIndexAt(321, rect, 30), null);
  assert.equal(chartIndexAt(20, { left: 0, width: 0 }, 30), null);
  assert.equal(chartIndexAt(Number.NaN, rect, 30), null);
  assert.equal(chartIndexAt(220, rect, 10), null);
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
