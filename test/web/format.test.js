import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtCost,
  fmtK,
  fmtMoney,
  formatDuration,
  formatElapsed,
  relTime,
  stateFor,
} from '../../web/js/format.js';

test('fmtK compacts kWh and kW figures', () => {
  assert.equal(fmtK(null), '—');
  assert.equal(fmtK(undefined), '—');
  assert.equal(fmtK(Number.NaN), '—');
  assert.equal(fmtK(0), '0.00');
  assert.equal(fmtK(3.926), '3.93');
  assert.equal(fmtK(12.34), '12.3');
  assert.equal(fmtK(4521.7), '4522');
  assert.equal(fmtK(100), '100');
});

test('relTime switches units at the boundaries', () => {
  assert.equal(relTime(0), '0 s ago');
  assert.equal(relTime(59_400), '59 s ago');
  assert.equal(relTime(59_500), '1 min ago');
  assert.equal(relTime(60_000), '1 min ago');
  assert.equal(relTime(3_599_000), '59 min ago');
  assert.equal(relTime(3_600_000), '1 h ago');
  assert.equal(relTime(86_399_000), '23 h ago');
  assert.equal(relTime(86_400_000), '1 d ago');
  assert.equal(relTime(-5000), '0 s ago');
});

test('stateFor falls back to the unknown state', () => {
  assert.equal(stateFor('charging').label, 'Charging');
  assert.equal(stateFor('charging').color, '#38d996');
  assert.equal(stateFor('disabled').label, 'Disabled');
  assert.equal(stateFor('nonsense').label, 'Unknown');
  assert.equal(stateFor(undefined).label, 'Unknown');
});

test('formatElapsed renders a stable HH:MM:SS clock', () => {
  assert.equal(formatElapsed(null), '—');
  assert.equal(formatElapsed(Number.NaN), '—');
  assert.equal(formatElapsed(Number.POSITIVE_INFINITY), '—');
  assert.equal(formatElapsed(0), '00:00:00');
  assert.equal(formatElapsed(59), '00:00:59');
  assert.equal(formatElapsed(60), '00:01:00');
  assert.equal(formatElapsed(3725), '01:02:05');
  assert.equal(formatElapsed(360_000), '100:00:00');
  assert.equal(formatElapsed(-5), '00:00:00');
});

test('formatDuration renders sessions in h:mm', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '—');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(59), '0:00');
  assert.equal(formatDuration(60), '0:01');
  assert.equal(formatDuration(3725), '1:02');
  assert.equal(formatDuration(7265), '2:01');
});

test('fmtMoney respects symbols vs currency codes', () => {
  assert.equal(fmtMoney(null), '—');
  assert.equal(fmtMoney(Number.NaN), '—');
  assert.equal(fmtMoney(Number.POSITIVE_INFINITY), '—');
  assert.equal(fmtMoney(1.2), '1.20');
  assert.equal(fmtMoney(1.2, ''), '1.20');
  assert.equal(fmtMoney(1.2, '$'), '$1.20');
  assert.equal(fmtMoney(1.2, '€'), '€1.20');
  assert.equal(fmtMoney(1.2, 'USD'), 'USD 1.20');
  assert.equal(fmtMoney(0, 'USD'), 'USD 0.00');
  assert.equal(fmtMoney(1.234, 'USD'), 'USD 1.23');
  assert.equal(fmtMoney(1.235, 'USD'), 'USD 1.24');
  assert.equal(fmtMoney(1234.5, '$'), '$1,234.50');
});

test('fmtCost is null until both energy and rate exist', () => {
  assert.equal(fmtCost(12.34, 0.31, 'USD'), 'USD 3.83');
  assert.equal(fmtCost(10, 0, 'USD'), 'USD 0.00');
  assert.equal(fmtCost(0, 0.5, '$'), '$0.00');
  assert.equal(fmtCost(null, 0.31, 'USD'), null);
  assert.equal(fmtCost(12.34, null, 'USD'), null);
  assert.equal(fmtCost(Number.NaN, 0.31, 'USD'), null);
  assert.equal(fmtCost(12.34, Number.NaN, 'USD'), null);
});
