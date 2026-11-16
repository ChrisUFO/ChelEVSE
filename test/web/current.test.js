import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentCapability } from '../../web/js/current.js';

test('currentCapability accepts the real config shape and high-capacity hardware', () => {
  assert.deepEqual(currentCapability({ max_current_soft: 32, max_current_hard: 80 }), {
    min: 6,
    max: 32,
    hard: 80,
  });
});

test('currentCapability fails closed for missing or contradictory limits', () => {
  for (const config of [
    null,
    {},
    { max_current_soft: 16 },
    { max_current_soft: 5, max_current_hard: 24 },
    { max_current_soft: 49, max_current_hard: 80 },
    { max_current_soft: 25, max_current_hard: 24 },
    { max_current_soft: '16', max_current_hard: 24 },
  ]) {
    assert.equal(currentCapability(config), null);
  }
});
