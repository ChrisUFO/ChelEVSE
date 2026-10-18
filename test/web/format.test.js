import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtK,
  formatCost,
  formatElapsed,
  formatMoney,
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

test('formatElapsed renders HH:MM:SS', () => {
  assert.equal(formatElapsed(0), '00:00:00');
  assert.equal(formatElapsed(59), '00:00:59');
  assert.equal(formatElapsed(61), '00:01:01');
  assert.equal(formatElapsed(3725), '01:02:05');
  assert.equal(formatElapsed(360_000), '100:00:00');
  assert.equal(formatElapsed(-12), '00:00:00');
  assert.equal(formatElapsed(null), '00:00:00');
});

test('stateFor falls back to the unknown state', () => {
  assert.equal(stateFor('charging').label, 'Charging');
  assert.equal(stateFor('charging').color, '#38d996');
  assert.equal(stateFor('disabled').label, 'Disabled');
  assert.equal(stateFor('nonsense').label, 'Unknown');
  assert.equal(stateFor(undefined).label, 'Unknown');
});

test('formatMoney uses the requested currency and locale', () => {
  assert.equal(formatMoney(1.5, 'USD', 'en-US'), '$1.50');
  assert.equal(formatMoney(1234.5, 'EUR', 'en-US'), '€1,234.50');
  assert.equal(formatMoney('2.25', 'usd', 'en-US'), '$2.25');
  assert.equal(formatMoney(Number.NaN, 'USD', 'en-US'), '—');
});

test('formatMoney falls back for a non-ISO currency string', () => {
  assert.equal(formatMoney(12, 'XX', 'en-US'), 'XX 12.00');
});

test('formatCost hides cost until a rate exists', () => {
  assert.equal(formatCost(10, null, 'USD', 'en-US'), null);
  assert.equal(formatCost(10, '', 'USD', 'en-US'), null);
  assert.equal(formatCost(null, 0.3, 'USD', 'en-US'), null);
  assert.equal(formatCost(10, 0.3, 'USD', 'en-US'), '$3.00');
  assert.equal(formatCost(10, 0, 'USD', 'en-US'), '$0.00');
  assert.equal(formatCost(10, 0.3, 'XX', 'en-US'), 'XX 3.00');
});
