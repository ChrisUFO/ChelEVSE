import { test } from 'node:test';
import assert from 'node:assert/strict';

import { settleWrite } from '../../web/js/write.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((done) => setTimeout(done, 0));
}

test('settleWrite reports a write that settles before the deadline', async () => {
  let late = 0;
  const ok = await settleWrite(Promise.resolve(), { timeout: 50, onLate: () => late++ });
  assert.deepEqual(ok, { status: 'ok' });

  const failure = new Error('nope');
  failure.code = 'unavailable';
  const failed = await settleWrite(Promise.reject(failure), { timeout: 50, onLate: () => late++ });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, failure);
  // A write that settled inside the window is never reported twice.
  assert.equal(late, 0);
});

test('settleWrite frees the UI at the deadline and reconciles a late success', async () => {
  const write = deferred();
  const reports = [];
  const outcome = await settleWrite(write.promise, {
    timeout: 20,
    onLate: (late) => reports.push(late),
  });
  assert.deepEqual(outcome, { status: 'timeout' });
  assert.equal(reports.length, 0);

  write.resolve();
  await tick();
  assert.deepEqual(reports, [{ status: 'ok' }]);
});

test('settleWrite reconciles a late failure', async () => {
  const write = deferred();
  const reports = [];
  const outcome = await settleWrite(write.promise, {
    timeout: 20,
    onLate: (late) => reports.push(late),
  });
  assert.deepEqual(outcome, { status: 'timeout' });

  const failure = new Error('deadline');
  failure.code = 'deadline-exceeded';
  write.reject(failure);
  await tick();
  assert.deepEqual(reports, [{ status: 'error', error: failure }]);
});

test('settleWrite tolerates a missing or throwing reconciler', async () => {
  const silent = await settleWrite(new Promise(() => {}), { timeout: 10 });
  assert.deepEqual(silent, { status: 'timeout' });

  const write = deferred();
  const outcome = await settleWrite(write.promise, {
    timeout: 10,
    onLate: () => {
      throw new Error('reconciler');
    },
  });
  assert.deepEqual(outcome, { status: 'timeout' });
  // The late reconciler throws inside its own then-handler; settling must not
  // surface as an unhandled rejection or change the timeout outcome.
  write.resolve();
  await tick();
  assert.deepEqual(outcome, { status: 'timeout' });
});
