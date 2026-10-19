import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_LIMIT, historyBounds, sessionsQueryOptions } from '../../web/js/store.js';

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
