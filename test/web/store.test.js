import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_LIMIT,
  RAPI_LIMIT,
  SESSION_LIMIT,
  historyBounds,
  sessionsQueryOptions,
} from '../../web/js/store.js';

test('historyBounds derives an inclusive document-id range', () => {
  const ids = ['2026-09-19', '2026-10-18'];
  assert.deepEqual(historyBounds(ids), { startId: '2026-09-19', endId: '2026-10-18' });
  // Zero-padded ids sort lexicographically in calendar order.
  const bounds = historyBounds(ids);
  assert.ok(bounds.startId < bounds.endId);
  assert.equal(historyBounds([]), null);
  assert.equal(historyBounds(null), null);
});

test('sessionsQueryOptions selects the 20 newest sessions', () => {
  assert.deepEqual(sessionsQueryOptions(), {
    field: 'started_at',
    direction: 'desc',
    limit: 20,
  });
  assert.equal(SESSION_LIMIT, 20);
});

test('the status command window cannot be evicted by a burst of RAPI sends', () => {
  // CONTROL_TYPES filters client-side after the limit, so the window must be
  // wider than the three control types; 20 matches the RAPI scrollback depth.
  assert.equal(COMMAND_LIMIT, 20);
  assert.equal(RAPI_LIMIT, 20);
  assert.ok(COMMAND_LIMIT > 3);
});
