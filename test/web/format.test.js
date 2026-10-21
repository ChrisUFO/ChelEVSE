import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  displayElapsed,
  elapsedClock,
  fmtCost,
  fmtK,
  fmtMoney,
  fmtRate,
  formatDuration,
  formatElapsed,
  freezeClock,
  freshnessState,
  holdAfterSnapshot,
  numOrDash,
  relTime,
  stateFor,
  statusWriteKey,
  toNumber,
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
  assert.equal(fmtK('12.5'), '12.5');
  assert.equal(fmtK(''), '—');
  assert.equal(fmtK(false), '—');
  assert.equal(fmtK('garbage'), '—');
});

test('toNumber and numOrDash reject non-numeric display fields', () => {
  assert.equal(toNumber('16.4'), 16.4);
  assert.equal(toNumber(null), Number.NaN);
  assert.equal(toNumber(''), Number.NaN);
  assert.equal(toNumber(false), Number.NaN);
  assert.equal(numOrDash(16.4), '16');
  assert.equal(numOrDash('16.4'), '16');
  assert.equal(numOrDash(24.5, 1), '24.5');
  // Whitespace-only strings are malformed, not zero: Number('   ') is 0.
  for (const value of [' ', '   ', '\t', '\n', ' \t\n ']) {
    assert.equal(toNumber(value), Number.NaN, JSON.stringify(value));
    assert.equal(numOrDash(value), '—', JSON.stringify(value));
    assert.equal(fmtK(value), '—', JSON.stringify(value));
  }
  for (const value of [null, undefined, '', false, 'nope', Number.NaN]) {
    assert.equal(numOrDash(value), '—', String(value));
  }
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
  assert.equal(relTime(Number.POSITIVE_INFINITY), '—');
  assert.equal(relTime(Number.NaN), '—');
});

test('stateFor falls back to the unknown state', () => {
  assert.equal(stateFor('charging').label, 'Charging');
  assert.equal(stateFor('charging').color, '#38d996');
  assert.equal(stateFor('disabled').label, 'Disabled');
  assert.equal(stateFor('nonsense').label, 'Unknown');
  assert.equal(stateFor(undefined).label, 'Unknown');
});

test('formatElapsed renders a stable HH:MM:SS clock', () => {
  assert.equal(formatElapsed(null), '—');
  assert.equal(formatElapsed(Number.NaN), '—');
  assert.equal(formatElapsed(Number.POSITIVE_INFINITY), '—');
  assert.equal(formatElapsed(0), '00:00:00');
  assert.equal(formatElapsed(59), '00:00:59');
  assert.equal(formatElapsed(60), '00:01:00');
  assert.equal(formatElapsed(3725), '01:02:05');
  assert.equal(formatElapsed(360_000), '100:00:00');
  assert.equal(formatElapsed(-5), '00:00:00');
});

test('displayElapsed interpolates from the document write time', () => {
  const writtenAt = 1_000_000;
  const stamp = (ms) => ({ toMillis: () => ms });
  const charging = (elapsed, updated, extra = {}) => ({
    elapsed,
    updated_at: stamp(updated),
    state_label: 'charging',
    charger_online: true,
    ...extra,
  });

  // A later snapshot that carries the same elapsed (e.g. the bridge's
  // schedule-boundary merge, which leaves updated_at alone) keeps ticking.
  const before = displayElapsed(charging(100, writtenAt), writtenAt + 6000);
  const merged = displayElapsed(charging(100, writtenAt), writtenAt + 9000);
  assert.equal(before, 106);
  assert.equal(merged, 109);
  assert.ok(merged > before);

  // A snapshot whose elapsed advanced follows the new value.
  assert.equal(displayElapsed(charging(130, writtenAt + 10_000), writtenAt + 10_000), 130);
  assert.equal(displayElapsed(charging(130, writtenAt + 10_000), writtenAt + 12_000), 132);

  // A genuine new session still resets to zero.
  assert.equal(displayElapsed(charging(0, writtenAt + 20_000), writtenAt + 20_000), 0);

  // Stale or non-charging documents show the stored value without ticking.
  assert.equal(displayElapsed(charging(100, writtenAt), writtenAt + 61_000), 100);
  assert.equal(displayElapsed(charging(100, writtenAt, { state_label: 'ready' }), writtenAt), 100);
  assert.equal(displayElapsed(charging(100, writtenAt, { charger_online: false }), writtenAt), 100);
});

test('freezeClock holds the clock until a newer status write arrives', () => {
  const writtenAt = 1_000_000;
  const data = {
    elapsed: 3725,
    updated_at: { toMillis: () => writtenAt },
    state_label: 'charging',
    charger_online: true,
  };
  // Stop pressed at writtenAt + 5 s: the last snapshot still claims charging,
  // so the frozen value must win over the growing interpolation.
  const clock = elapsedClock(null, data, writtenAt + 5000);
  assert.equal(clock.seconds, 3730);
  const hold = freezeClock(clock.seconds, data);
  assert.deepEqual(hold, { value: 3730, key: statusWriteKey(data) });
  assert.equal(holdAfterSnapshot(hold, data).value, 3730);
  // Nothing held and no valid status still renders the em dash.
  assert.equal(freezeClock(null, data), null);
  assert.equal(displayElapsed(null, writtenAt), null);
});

test('holdAfterSnapshot survives schedule-only merges and follows a new write', () => {
  const writtenAt = 1_000_000;
  const data = {
    elapsed: 3725,
    updated_at: { toMillis: () => writtenAt },
    state_label: 'charging',
    charger_online: true,
    schedule: { in_window: false, active_rule_id: null },
  };
  const hold = freezeClock(3730, data);
  // The bridge merges only `schedule` into status/current: same elapsed, same
  // write time, same state, so the hold must not be released.
  const merged = { ...data, schedule: { in_window: true, active_rule_id: 'night' } };
  assert.equal(statusWriteKey(merged), statusWriteKey(data));
  assert.equal(holdAfterSnapshot(hold, merged), hold);
  // A genuinely new status write releases it.
  assert.equal(holdAfterSnapshot(hold, { ...data, elapsed: 3726 }), null);
  assert.equal(holdAfterSnapshot(hold, { ...data, state_label: 'ready' }), null);
  assert.equal(
    holdAfterSnapshot(hold, { ...data, updated_at: { toMillis: () => writtenAt + 10_000 } }),
    null,
  );
  assert.equal(holdAfterSnapshot(hold, null), null);
  assert.equal(holdAfterSnapshot(null, data), null);
});

test('elapsedClock ticks when the device clock is behind Firestore', () => {
  // Firestore stamps updated_at with a server timestamp: a device that is two
  // minutes behind must still interpolate instead of falling back to raw.
  const receipt = 1_000_000;
  const serverAhead = {
    elapsed: 100,
    updated_at: { toMillis: () => receipt + 120_000 },
    state_label: 'charging',
    charger_online: true,
  };
  let step = elapsedClock(null, serverAhead, receipt);
  assert.equal(step.seconds, 100);
  step = elapsedClock(step.clock, serverAhead, receipt + 3000);
  assert.equal(step.seconds, 103);
  // The anchor never sits ahead of the local clock, so the age stays positive.
  assert.ok(step.clock.anchorMs <= receipt + 3000);
});

test('elapsedClock keeps the same offset when the device clock is ahead', () => {
  const receipt = 1_000_000;
  const serverBehind = {
    elapsed: 100,
    updated_at: { toMillis: () => receipt - 5000 },
    state_label: 'charging',
    charger_online: true,
  };
  // The 5 s skew is a constant offset, and the clock still advances 1:1.
  let step = elapsedClock(null, serverBehind, receipt);
  assert.equal(step.seconds, 105);
  step = elapsedClock(step.clock, serverBehind, receipt + 2000);
  assert.equal(step.seconds, 107);
  // Far enough behind to look stale, it stops interpolating.
  const stale = { ...serverBehind, updated_at: { toMillis: () => receipt - 120_000 } };
  assert.equal(elapsedClock(null, stale, receipt).seconds, 100);
});

test('elapsedClock keeps its anchor across an unchanged updated_at', () => {
  const writtenAt = 1_000_000;
  const data = {
    elapsed: 100,
    updated_at: { toMillis: () => writtenAt },
    state_label: 'charging',
    charger_online: true,
  };
  const first = elapsedClock(null, data, writtenAt + 6000);
  assert.equal(first.seconds, 106);
  // A schedule-only merge (identical write fields) must not rewind.
  const merged = elapsedClock(first.clock, { ...data, schedule: {} }, writtenAt + 9000);
  assert.equal(merged.seconds, 109);
  assert.equal(merged.clock.anchorMs, first.clock.anchorMs);
  // Same write time but more elapsed seconds: continuous, not double counted.
  const advanced = elapsedClock(merged.clock, { ...data, elapsed: 108 }, writtenAt + 9000);
  assert.equal(advanced.seconds, 109);
  assert.equal(
    elapsedClock(advanced.clock, { ...data, elapsed: 108 }, writtenAt + 12_000).seconds,
    112,
  );
  // A genuine new session (new write, elapsed back to zero) follows the reset.
  const reset = { ...data, elapsed: 0, updated_at: { toMillis: () => writtenAt + 20_000 } };
  assert.equal(elapsedClock(advanced.clock, reset, writtenAt + 20_000).seconds, 0);
});

test('elapsedClock ignores an older write and never rewinds the clock', () => {
  const writtenAt = 1_000_000;
  const data = {
    elapsed: 3725,
    updated_at: { toMillis: () => writtenAt },
    state_label: 'charging',
    charger_online: true,
  };
  let step = elapsedClock(null, data, writtenAt + 10_000);
  assert.equal(step.seconds, 3735);
  // A duplicate of the write we anchored to changes nothing.
  step = elapsedClock(step.clock, { ...data }, writtenAt + 40_000);
  assert.equal(step.seconds, 3765);
  // An older write observed late (a stale read or a replayed document) must not
  // move the anchor or its elapsed value backwards.
  const stale = {
    ...data,
    elapsed: 3700,
    updated_at: { toMillis: () => writtenAt - 30_000 },
  };
  const afterStale = elapsedClock(step.clock, stale, writtenAt + 50_000);
  assert.equal(afterStale.seconds, 3775);
  assert.equal(afterStale.clock.anchorMs, writtenAt);
  assert.equal(afterStale.clock.writeMs, writtenAt);
  // When the bridge stops writing past the freshness window the clock freezes
  // at the last rendered value instead of snapping back to the raw base.
  const frozen = elapsedClock(afterStale.clock, data, writtenAt + 61_000);
  assert.equal(frozen.seconds, 3775);
  const later = elapsedClock(frozen.clock, data, writtenAt + 120_000);
  assert.equal(later.seconds, 3775);
  // A genuinely new write still re-anchors and follows its own elapsed value.
  const next = { ...data, elapsed: 3800, updated_at: { toMillis: () => writtenAt + 121_000 } };
  assert.equal(elapsedClock(later.clock, next, writtenAt + 121_000).seconds, 3800);
});

test('displayElapsed rejects every non-numeric elapsed shape', () => {
  const stamp = { toMillis: () => 1_000_000 };
  const data = (elapsed) => ({
    elapsed,
    updated_at: stamp,
    state_label: 'charging',
    charger_online: true,
  });
  for (const raw of [null, undefined, '', false, '3725']) {
    assert.equal(displayElapsed(data(raw), 1_000_000), null, String(raw));
  }
  assert.equal(displayElapsed(data(0), 1_000_000), 0);
  assert.equal(displayElapsed(null, 1_000_000), null);
  // Without a write time there is nothing to interpolate from.
  assert.equal(
    displayElapsed({ elapsed: 42, state_label: 'charging', charger_online: true }, 5000),
    42,
  );
});

test('formatDuration renders sessions in h:mm', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '—');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(59), '0:00');
  assert.equal(formatDuration(60), '0:01');
  assert.equal(formatDuration(3725), '1:02');
  assert.equal(formatDuration(7265), '2:01');
});

test('fmtMoney respects symbols vs currency codes', () => {
  assert.equal(fmtMoney(null), '—');
  assert.equal(fmtMoney(Number.NaN), '—');
  assert.equal(fmtMoney(Number.POSITIVE_INFINITY), '—');
  assert.equal(fmtMoney(1.2), '1.20');
  assert.equal(fmtMoney(1.2, ''), '1.20');
  assert.equal(fmtMoney(1.2, '$'), '$1.20');
  assert.equal(fmtMoney(1.2, '€'), '€1.20');
  assert.equal(fmtMoney(1.2, 'USD'), 'USD 1.20');
  assert.equal(fmtMoney(0, 'USD'), 'USD 0.00');
  assert.equal(fmtMoney(1.234, 'USD'), 'USD 1.23');
  assert.equal(fmtMoney(1.235, 'USD'), 'USD 1.24');
  assert.equal(fmtMoney(1234.5, '$'), '$1,234.50');
});

test('fmtRate keeps the precision a per-kWh price allows', () => {
  assert.equal(fmtRate(null), '—');
  assert.equal(fmtRate(Number.NaN), '—');
  assert.equal(fmtRate(0.1), '0.10');
  assert.equal(fmtRate(0.245, '$'), '$0.245');
  assert.equal(fmtRate(0.31, 'USD'), 'USD 0.31');
  assert.equal(fmtRate(0, '€'), '€0.00');
  assert.equal(fmtRate(5, 'USD'), 'USD 5.00');
  assert.equal(fmtRate('0.1', '$'), '$0.10');
});

test('fmtCost is null until both energy and rate exist', () => {
  assert.equal(fmtCost(12.34, 0.31, 'USD'), 'USD 3.83');
  assert.equal(fmtCost(10, 0, 'USD'), 'USD 0.00');
  assert.equal(fmtCost(0, 0.5, '$'), '$0.00');
  assert.equal(fmtCost(null, 0.31, 'USD'), null);
  assert.equal(fmtCost(12.34, null, 'USD'), null);
  assert.equal(fmtCost(Number.NaN, 0.31, 'USD'), null);
  assert.equal(fmtCost(12.34, Number.NaN, 'USD'), null);
});

test('freshnessState separates a stale bridge from an offline charger', () => {
  assert.equal(freshnessState({ chargerOnline: true, ageMs: 5000 }), null);
  assert.equal(freshnessState({ chargerOnline: false, ageMs: 5000 }), 'charger');
  assert.equal(freshnessState({ chargerOnline: true, ageMs: 61000 }), 'bridge');
  assert.equal(freshnessState({ chargerOnline: false, ageMs: 61000 }), 'bridge');
  assert.equal(freshnessState({ chargerOnline: true, ageMs: Infinity }), 'bridge');
});
