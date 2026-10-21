import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBootGuard } from '../../web/js/boot.js';

// Minimal scheduler standing in for the platform timers, so the watchdog is
// driven deterministically instead of through real waits.
function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

const TIMEOUT_MS = 12000;

function newGuard({ booting = true, scheduler } = {}) {
  const calls = [];
  const state = { booting };
  const guard = createBootGuard({
    timeoutMs: TIMEOUT_MS,
    isBooting: () => state.booting,
    onTimeout: () => calls.push('timeout'),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
  return { guard, calls, state };
}

test('fires once the boot timeout expires while booting', () => {
  const scheduler = fakeScheduler();
  const { guard, calls } = newGuard({ scheduler });

  guard.arm();
  assert.equal(scheduler.pending, 1);

  scheduler.advance(TIMEOUT_MS - 1);
  assert.deepEqual(calls, []);

  scheduler.advance(1);
  assert.deepEqual(calls, ['timeout']);
  assert.equal(scheduler.pending, 0);
});

test('does not fire after the screen left boot', () => {
  const scheduler = fakeScheduler();
  const { guard, calls, state } = newGuard({ scheduler });

  guard.arm();
  state.booting = false;
  scheduler.advance(TIMEOUT_MS);

  assert.deepEqual(calls, []);
  assert.equal(scheduler.pending, 0);
});

test('arming outside boot schedules nothing', () => {
  const scheduler = fakeScheduler();
  const { guard, calls } = newGuard({ booting: false, scheduler });

  guard.arm();
  assert.equal(scheduler.pending, 0);

  scheduler.advance(TIMEOUT_MS * 2);
  assert.deepEqual(calls, []);
});

test('clear cancels the pending timeout and is idempotent', () => {
  const scheduler = fakeScheduler();
  const { guard, calls } = newGuard({ scheduler });

  guard.arm();
  guard.clear();
  assert.equal(scheduler.pending, 0);

  assert.doesNotThrow(() => guard.clear());
  scheduler.advance(TIMEOUT_MS * 2);
  assert.deepEqual(calls, []);
});

test('re-arming replaces the pending timeout', () => {
  const scheduler = fakeScheduler();
  const { guard, calls } = newGuard({ scheduler });

  guard.arm();
  scheduler.advance(TIMEOUT_MS - 1);
  guard.arm();
  assert.equal(scheduler.pending, 1, 'the earlier timer was cancelled');

  // The first timer's deadline passed relative to arming; only the replacement
  // may fire, one full timeout after it was armed.
  scheduler.advance(1);
  assert.deepEqual(calls, []);

  scheduler.advance(TIMEOUT_MS - 1);
  assert.deepEqual(calls, ['timeout']);
});

test('onTimeout runs at most once per arm, however time advances', () => {
  const scheduler = fakeScheduler();
  const { guard, calls } = newGuard({ scheduler });

  guard.arm();
  scheduler.advance(TIMEOUT_MS);
  scheduler.advance(TIMEOUT_MS * 3);

  assert.deepEqual(calls, ['timeout']);
});

test('clear after a fired timeout is a no-op and re-arming works again', () => {
  const scheduler = fakeScheduler();
  const { guard, calls } = newGuard({ scheduler });

  guard.arm();
  scheduler.advance(TIMEOUT_MS);
  assert.deepEqual(calls, ['timeout']);

  assert.doesNotThrow(() => guard.clear());
  guard.arm();
  scheduler.advance(TIMEOUT_MS);
  assert.deepEqual(calls, ['timeout', 'timeout']);
});

test('arm is idempotent: repeated arming keeps one timer and one fire', () => {
  const scheduler = fakeScheduler();
  const { guard, calls } = newGuard({ scheduler });

  guard.arm();
  guard.arm();
  guard.arm();
  assert.equal(scheduler.pending, 1);

  scheduler.advance(TIMEOUT_MS);
  assert.deepEqual(calls, ['timeout']);
  assert.equal(scheduler.pending, 0);
});
