import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dayId,
  dayLabel,
  historySeries,
  lastDayIds,
  maxSeries,
  sumSeries,
} from '../../web/js/history.js';

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

test('lastDayIds stays contiguous across a DST change', () => {
  const ids = lastDayIds(7, new Date(2026, 2, 9, 12));
  assert.deepEqual(ids, [
    '2026-03-03',
    '2026-03-04',
    '2026-03-05',
    '2026-03-06',
    '2026-03-07',
    '2026-03-08',
    '2026-03-09',
  ]);
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
