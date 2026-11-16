import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentCapability } from '../../web/js/current.js';

test('currentCapability keeps soft, hard, and pilot as separate quantities', () => {
  assert.deepEqual(currentCapability({ max_current_soft: 16, max_current_hard: 24, pilot: 12 }), {
    min: 6,
    max: 16,
    hard: 24,
    pilot: 12,
  });
});

test('currentCapability fails closed for missing or contradictory limits', () => {
  for (const config of [
    null,
    {},
    { max_current_soft: 16, max_current_hard: 24 },
    { max_current_soft: 25, max_current_hard: 24, pilot: 16 },
    { max_current_soft: 16, max_current_hard: 24, pilot: 25 },
    { max_current_soft: '16', max_current_hard: 24, pilot: 16 },
  ]) {
    assert.equal(currentCapability(config), null);
  }
});
