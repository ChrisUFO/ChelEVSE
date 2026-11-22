import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COMMAND_LIMIT,
  ackNotification,
  RANGE_SESSION_LIMIT,
  RAPI_LIMIT,
  SESSION_LIMIT,
  fetchSessionsInRange,
  mergeCommandWindows,
  reconMarker,
  retryStore,
  sessionsQueryOptions,
  stopStore,
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

test('sessionsQueryOptions widens a page only when a read asks for it', () => {
  // The sessions list keeps its 20-doc page; the period-$ range read is the
  // caller that exhausts the archive, so it is the one that asks for the
  // wider page. Anything else that asks still gets the exact shape it named.
  assert.deepEqual(sessionsQueryOptions({ pageSize: RANGE_SESSION_LIMIT }), {
    field: 'started_at',
    direction: 'desc',
    limit: RANGE_SESSION_LIMIT,
  });
  assert.equal(RANGE_SESSION_LIMIT, 200);
  // An absent page size is the list's own page, never a wider default.
  assert.equal(sessionsQueryOptions().limit, SESSION_LIMIT);
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

test("the history range read carries each day's kWh total and no pricing payload", () => {
  // fetchHistory needs a live Firestore `db`, so its document projection — the
  // seam #114's schedule-pricing tests bypassed by injecting day docs straight
  // into the pure series helpers — is pinned from source (the sw-shell
  // pattern). #123 made every range period session-priced, so the projection's
  // whole job is the day documents' kWh totals: `hours` on a range point is
  // dead carry (#125), the exact payload a maintainer could re-wire into the
  // double-counted bucket pricing the design removed. Whitespace is flattened
  // first so a reformat cannot loosen the pin.
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function fetchHistory(');
  assert.ok(start >= 0, 'store.js declares fetchHistory');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes fetchHistory');
  const body = source.slice(start, end + 2).replace(/\s+/g, ' ');
  // The mapping's contract: the id and the kWh total, and nothing else. The
  // no-`hours` guard scopes to the returned projection alone — the word names
  // the Day read's own payload, so a correct comment elsewhere in the read
  // must not trip it; a stray key would have to appear inside the return.
  assert.match(body, /docs: snap\.docs\.map\(\(d\) => \{/);
  assert.match(body, /id: d\.id,/);
  assert.match(body, /kwh: data\.kwh,/);
  const projectionStart = body.indexOf('return {');
  assert.ok(projectionStart >= 0, 'fetchHistory returns its projection');
  assert.doesNotMatch(body.slice(projectionStart), /hours/);
});

test("the Day period's single-document read keeps its hours normalization", () => {
  // #120's rule lives on exactly one read now: the Day period's day document,
  // whose `hours` map still prices its hour bars. The map rides along only
  // when the stored value is a non-array object — a day recorded before hourly
  // capture has `kwh` and no map and must stay without one rather than gain an
  // empty fabricated map (24 zero bars), so the pinned source shape is the
  // same sw-shell pattern as the range read's.
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function fetchHistoryDay(');
  assert.ok(start >= 0, 'store.js declares fetchHistoryDay');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes fetchHistoryDay');
  const body = source.slice(start, end + 2).replace(/\s+/g, ' ');
  assert.match(
    body,
    /hours: exists && hours && typeof hours === 'object' && !Array\.isArray\(hours\) \? hours : null,/,
  );
});

// ---------- the range read's paging loop, executed ----------
//
// fetchSessionsInRange's loop is the sole $ source for Week/Month/Year, and
// its body runs through no other test: the screen harness stubs the whole
// read. The page reader is injectable for exactly this — Node cannot bind
// Firestore — so these drive the real loop against scripted pages the way the
// screen harness drives fetchPeriodSessions.

test('fetchSessionsInRange pages the range read to exhaustion', async () => {
  const doc = (n) => ({ id: `s${n}`, wh: 1000 });
  const cursorFor = (page) => ({ id: `cursor-${page}` });
  const range = { start: new Date(2026, 9, 1), end: new Date(2026, 10, 1) };
  const calls = [];
  // Two full pages, then the archive's short tail. Each page hands back the
  // snapshot the next page must continue after.
  const readPage = async (options) => {
    const page = calls.push(options);
    const first = (page - 1) * RANGE_SESSION_LIMIT;
    const size = page === 3 ? 7 : RANGE_SESSION_LIMIT;
    const docs = Array.from({ length: size }, (_, i) => doc(first + i));
    return { docs, lastDoc: cursorFor(page), fromCache: page === 2 };
  };
  const read = await fetchSessionsInRange(range, readPage);

  // Fan-in: every page's rows, in order, exactly once.
  assert.equal(read.docs.length, RANGE_SESSION_LIMIT * 2 + 7);
  assert.deepEqual(read.docs[0], doc(0));
  assert.deepEqual(read.docs[RANGE_SESSION_LIMIT], doc(RANGE_SESSION_LIMIT));
  assert.deepEqual(read.docs[read.docs.length - 1], doc(RANGE_SESSION_LIMIT * 2 + 6));
  // Three pages: the first continues after nothing, every later one after the
  // cursor the page before returned, each against the same range and the
  // archive-wide page size.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { after: null, range, pageSize: RANGE_SESSION_LIMIT });
  assert.deepEqual(calls[1], { after: cursorFor(1), range, pageSize: RANGE_SESSION_LIMIT });
  assert.deepEqual(calls[2], { after: cursorFor(2), range, pageSize: RANGE_SESSION_LIMIT });
  // One cache-served page makes the whole read cache-served.
  assert.equal(read.fromCache, true);
});

test('a short page ends the range read even though it carries a cursor', async () => {
  const calls = [];
  const read = await fetchSessionsInRange({ start: 0, end: 1 }, async (options) => {
    calls.push(options);
    return {
      docs: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
      lastDoc: { id: 'cursor-1' },
      fromCache: false,
    };
  });
  // A short page is the range's end: a further page is never queried, so an
  // archive that shrank between pages cannot loop on a stale cursor.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    after: null,
    range: { start: 0, end: 1 },
    pageSize: RANGE_SESSION_LIMIT,
  });
  assert.deepEqual(read, { docs: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], fromCache: false });
});

test('an empty range read resolves empty after one page', async () => {
  const calls = [];
  const read = await fetchSessionsInRange({ start: 0, end: 1 }, async (options) => {
    calls.push(options);
    return { docs: [], lastDoc: null, fromCache: true };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(read, { docs: [], fromCache: true });
});

test("the range read's default page reader forwards its page size into the query", () => {
  // The loop above drives an injected reader, so its executed pins see the
  // page size it asks for — never whether the production reader honors it.
  // fetchSessions needs a live Firestore `db` (Node cannot bind it), so its
  // forwarding is pinned from source, the same sw-shell pattern as the
  // history reads above: the loop requests RANGE_SESSION_LIMIT-sized pages
  // and terminates on a page shorter than that request, so a lost `pageSize`
  // forwarding falls every range page back to the list's 20-doc default and
  // silently truncates the period $ (the newest 20 sessions read as a
  // "short" page) with no failing test and no note on screen.
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function fetchSessions(');
  assert.ok(start >= 0, 'store.js declares fetchSessions');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes fetchSessions');
  const body = source.slice(start, end + 2).replace(/\s+/g, ' ');
  // The size the caller asked for reaches the options, and the options'
  // limit reaches the query's constraints.
  assert.match(body, /sessionsQueryOptions\(\{[^}]*pageSize,/);
  assert.match(body, /constraints\.push\(limit\(max\)\)/);
});

// ---------- the in-place retry path (#153) ----------
//
// startStore/retryStore cannot be executed here (onSnapshot needs the SDK's
// live `db`), so the subscription order is pinned from source, the same
// sw-shell pattern as the reads above. What *can* run is the no-op contract:
// retryStore() before any store has started must do nothing at all.

function startStoreBody() {
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function startStore(');
  assert.ok(start >= 0, 'store.js declares startStore');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes startStore');
  return source.slice(start, end + 2).replace(/\s+/g, ' ');
}

test('startStore retains the options it is subscribing with, after stopping the old ones', () => {
  // The retry contract (R6/R8): one re-subscribe path, in this order. The
  // argument object is taken as given — a rebuilt literal would quietly drop a
  // callback added later, and a Retry would then re-subscribe half a store.
  // Holding it *after* stopStore() is what keeps a retained object from
  // outliving the listeners it belongs to when teardown and start overlap.
  const body = startStoreBody();
  assert.match(body, /^export function startStore\(options\) \{/);
  assert.match(body, /\} = options; stopStore\(\);/);
  const stopAt = body.indexOf('stopStore();');
  const retainAt = body.indexOf('lastOptions = options;');
  assert.ok(retainAt > stopAt, 'the options are retained only after the stop');
  // Nothing may subscribe before the old handles are stopped: that ordering is
  // the whole reason a repeated Retry cannot stack listeners.
  const firstSnapshotAt = body.indexOf('onSnapshot(');
  assert.ok(firstSnapshotAt > stopAt, 'no listener is created before stopStore()');
  assert.ok(retainAt < firstSnapshotAt, 'the retained object is the one about to subscribe');
});

test('retryStore replays the retained call, and is a plain no-op before the first start', () => {
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function retryStore(');
  assert.ok(start >= 0, 'store.js declares retryStore');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes retryStore');
  const body = source.slice(start, end + 2).replace(/\s+/g, ' ');
  // No arguments, no local bookkeeping: it hands the retained object back to
  // the one startStore path, which stops before it subscribes.
  assert.match(body, /if \(!lastOptions\) return false;/);
  assert.match(body, /startStore\(lastOptions\);/);
  assert.match(body, /return true;/);

  // Executed: this file never starts a store, so nothing is retained and the
  // two contract cases below are both real. A failed/no-op retry must not
  // throw — a Retry in the error state is wired straight to this.
  assert.equal(retryStore(), false, 'nothing retained, nothing to replay');
  assert.doesNotThrow(() => stopStore(), 'teardown with nothing retained is safe');
  assert.equal(retryStore(), false, 'stopStore() leaves nothing to replay');
});

test('stopStore drops the retained options with the listener handles', () => {
  // R8: sign-out runs through stopStore(); a retained object that survived it
  // would let a later Retry resurrect subscriptions for a session that ended.
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function stopStore(');
  assert.ok(start >= 0, 'store.js declares stopStore');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes stopStore');
  const body = source.slice(start, end + 2).replace(/\s+/g, ' ');
  assert.match(body, /lastOptions = null;/);
});

test('the health document is one subscription through the shared watch path', () => {
  // #158 adds `status/notifications`: a single document, so no query and no
  // index — and one `watch` call, which is also what keeps the denied() gate in
  // one place (it routes a revoked grant to onAccessDenied before any screen
  // sees the error).
  const body = startStoreBody();
  assert.match(
    body,
    /unsubNotifications = watch\( 'status\/notifications', \(data\) => onNotifications && onNotifications\(data\), \(err\) => onNotificationsError && onNotificationsError\(err\), \);/,
    'the health listener mirrors the status/config watch idiom',
  );

  // Sign-out teardown must drop it with the rest: a handle left behind would
  // keep a session's listener alive after stopStore.
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function stopStore(');
  assert.ok(start >= 0, 'store.js declares stopStore');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes stopStore');
  const stopBody = source.slice(start, end + 2).replace(/\s+/g, ' ');
  assert.match(
    stopBody,
    /unsubConfig, unsubNotifications, unsubClaims, unsubSchedule/,
    'torn down with its siblings',
  );
  assert.match(
    stopBody,
    /unsubNotifications = unsubClaims = unsubSchedule/,
    'the handle is cleared',
  );
});

test('every listener error path still asks denied() first', () => {
  // R7: `permission-denied` routes to onAccessDenied and offers no Retry. A
  // retry refactor is exactly the kind of change that could reorder this, so
  // the gate is pinned where it is: defined before any subscription, its
  // access-denied branch intact, and every error callback opening with it (the
  // two command windows hand `denied` itself to onSnapshot).
  const body = startStoreBody();
  const deniedAt = body.indexOf('const denied = (err) => {');
  assert.ok(deniedAt >= 0, 'startStore defines denied');
  assert.ok(deniedAt < body.indexOf('onSnapshot('), 'denied is defined before any listener');
  const deniedBody = body.slice(deniedAt, body.indexOf('return false;', deniedAt));
  assert.match(deniedBody, /err\.code === 'permission-denied'/);
  assert.match(deniedBody, /onAccessDenied\(\)/);
  assert.match(deniedBody, /return true;/);

  const gated = body.match(/\(err\) => \{ if \(!denied\(err\)/g) || [];
  assert.equal(gated.length, 4, 'the four inline error callbacks all gate on denied(err)');
  const handed = body.match(/denied,/g) || [];
  assert.equal(handed.length, 2, 'both command windows pass denied as the error handler');
});

test('an acknowledgement is one command doc carrying the validated advisory id', () => {
  // `ackNotification` routes through `sendCommand` (which stamps `status` and
  // `created_at`); the injected write is the seam the history range read already
  // uses, so the payload asserted here is the one the shipping call builds.
  const payloads = [];
  const created = { id: 'cmd-7' };
  const write = (payload) => {
    payloads.push(payload);
    return created;
  };
  assert.equal(
    ackNotification('fault.no_ground', write),
    created,
    'the write’s result passes through',
  );
  assert.deepEqual(payloads, [{ type: 'ack_notification', notification_id: 'fault.no_ground' }]);
  assert.deepEqual(Object.keys(payloads[0]).sort(), ['notification_id', 'type']);
});

test('an advisory id the bridge would refuse is never written', () => {
  // The bridge fails such a command with "invalid notification id" and the
  // rules refuse the document, so the client stops before either: a rejected
  // id must not reach Firestore at all.
  for (const id of [
    'Fault.No_Ground',
    'fault no_ground',
    'fault..no_ground',
    // Trailing line terminators the rules' end-of-text `$` refuses.
    'fault.no_ground\n',
    'fault.no_ground\r',
    'fault.no_ground\u2028',
    'fault.no_ground\u2029',
    '',
    'a'.repeat(65),
    null,
    undefined,
    42,
  ]) {
    let written = false;
    const write = () => {
      written = true;
    };
    assert.throws(() => ackNotification(id, write), /invalid notification id/, String(id));
    assert.equal(written, false, `nothing is written for ${String(id)}`);
  }
});

// ---------- the seam-B verdict marker (#212) ----------

test('reconMarker takes only a well-formed recon_from date', () => {
  // The marker is the verdict feature's switch: only a real calendar date
  // in the bridge's own format turns it on, so a corrupt or partial write
  // reads as "no marker" — the caption keeps today's behavior rather than
  // trusting a date it cannot parse. fetchReconMarker adds the two nulls
  // around this: a missing marker document and a failed read.
  assert.deepEqual(reconMarker({ recon_from: '2026-10-19' }), { reconFrom: '2026-10-19' });
  assert.equal(reconMarker({ recon_from: '2026-02-30' }), null); // rolls over
  assert.equal(reconMarker({ recon_from: '2026-10-9' }), null); // unpadded
  assert.equal(reconMarker({ recon_from: 20261019 }), null);
  assert.equal(reconMarker({}), null);
  assert.equal(reconMarker(null), null);
});
