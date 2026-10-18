import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtK, relTime, stateFor } from '../../web/js/format.js';

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
