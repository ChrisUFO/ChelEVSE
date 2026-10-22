import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COMMAND_LIMIT,
  RAPI_LIMIT,
  SESSION_LIMIT,
  mergeCommandWindows,
  sessionsQueryOptions,
} from '../../web/js/store.js';

test('sessionsQueryOptions selects the 20 newest sessions', () => {
  assert.deepEqual(sessionsQueryOptions(), {
    field: 'started_at',
    direction: 'desc',
    limit: 20,
  });
  assert.equal(SESSION_LIMIT, 20);
});

test('sessionsQueryOptions carries the paging cursor and month range only when asked', () => {
  // The snapshot object is opaque to the options layer — it is passed through
  // untouched for startAfter to consume.
  const cursor = { id: '1760310600', data: () => ({}) };
  const start = new Date(2026, 9, 1);
  const end = new Date(2026, 10, 1);
  assert.deepEqual(sessionsQueryOptions({ after: cursor, start, end }), {
    field: 'started_at',
    direction: 'desc',
    limit: 20,
    after: cursor,
    start,
    end,
  });

  // A bare cursor keeps the range absent, and a bare range keeps the cursor
  // absent: the shape says exactly what the caller asked for.
  const paged = sessionsQueryOptions({ after: cursor });
  assert.equal(paged.after, cursor);
  assert.equal('start' in paged, false);
  assert.equal('end' in paged, false);
  const ranged = sessionsQueryOptions({ start, end });
  assert.equal(ranged.start, start);
  assert.equal(ranged.end, end);
  assert.equal('after' in ranged, false);
});

test('a pending control survives more than twenty newer RAPI docs', () => {
  // The newest mixed window is full of newer RAPI commands, so it does not
  // contain the pending pause at all.
  const recent = Array.from({ length: COMMAND_LIMIT }, (_, index) => ({
    id: `rapi-${index}`,
    type: 'rapi',
    status: 'acked',
    created_at: 1000 - index,
  }));
  const pendingControl = {
    id: 'pause-1',
    type: 'pause',
    status: 'pending',
    created_at: 1,
  };
  assert.equal(
    recent.some((command) => command.id === pendingControl.id),
    false,
  );

  // The independent pending subscription still supplies it, and it reaches the
  // status renderer's array with pending precedence intact.
  const merged = mergeCommandWindows(recent, [pendingControl]);
  assert.equal(merged.length, COMMAND_LIMIT + 1);
  const found = merged.find((command) => command.type === 'pause' && command.status === 'pending');
  assert.equal(found && found.id, 'pause-1');

  // A pending command already inside the window is not duplicated.
  assert.deepEqual(mergeCommandWindows([pendingControl], [pendingControl]), [pendingControl]);
  assert.deepEqual(mergeCommandWindows(null, null), []);
  assert.equal(COMMAND_LIMIT, 20);
  assert.equal(RAPI_LIMIT, 20);
});

test("the history range read keeps every day document's pricing inputs", () => {
  // fetchHistory needs a live Firestore `db`, so its document projection — the
  // seam #114's schedule-pricing tests bypassed by injecting day docs straight
  // into the pure series helpers — is pinned from source (the sw-shell
  // pattern). Dropping `hours` from the mapping is exactly #120: Week, Month
  // and Year points arrive with no pricing inputs, so the schedule-priced $
  // hides silently as an all-unpriceable range while Day (whose single-document
  // read carries hours) still shows it. Whitespace is flattened first so a
  // reformat cannot loosen the pin.
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function fetchHistory(');
  assert.ok(start >= 0, 'store.js declares fetchHistory');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes fetchHistory');
  const body = source.slice(start, end + 2).replace(/\s+/g, ' ');
  // The mapping's contract: the id, the kWh total, and the hourly buckets kept
  // only as a non-array object (fetchHistoryDay's normalization), never an
  // empty fabricated map — a pre-hourly-capture day stays unpriceable so a
  // mixed range keeps its partial-pricing disclosure.
  assert.match(body, /docs: snap\.docs\.map\(\(d\) => \{/);
  assert.match(body, /id: d\.id,/);
  assert.match(body, /kwh: data\.kwh,/);
  assert.match(
    body,
    /hours: hours && typeof hours === 'object' && !Array\.isArray\(hours\) \? hours : null,/,
  );
});
