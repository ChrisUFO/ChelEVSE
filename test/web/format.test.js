import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  displayElapsed,
  fmtCost,
  fmtK,
  fmtMoney,
  formatDuration,
  formatElapsed,
  heldElapsed,
  numOrDash,
  relTime,
  stateFor,
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

test('heldElapsed freezes the clock until a snapshot releases it', () => {
  const writtenAt = 1_000_000;
  const data = {
    elapsed: 3725,
    updated_at: { toMillis: () => writtenAt },
    state_label: 'charging',
    charger_online: true,
  };
  // Stop pressed at writtenAt + 5 s: the last snapshot still claims charging,
  // so the frozen value must win over the growing interpolation.
  const held = heldElapsed(null, data, writtenAt + 5000);
  assert.equal(held, 3730);
  assert.equal(heldElapsed(held, data, writtenAt + 9000), 3730);
  // The next snapshot releases the hold; the clock follows its raw elapsed.
  const paused = { ...data, elapsed: 3732, state_label: 'ready' };
  assert.equal(heldElapsed(null, paused, writtenAt + 12_000), 3732);
  // Nothing held and no valid status still renders the em dash.
  assert.equal(heldElapsed(null, null, writtenAt), null);
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

test('fmtCost is null until both energy and rate exist', () => {
  assert.equal(fmtCost(12.34, 0.31, 'USD'), 'USD 3.83');
  assert.equal(fmtCost(10, 0, 'USD'), 'USD 0.00');
  assert.equal(fmtCost(0, 0.5, '$'), '$0.00');
  assert.equal(fmtCost(null, 0.31, 'USD'), null);
  assert.equal(fmtCost(12.34, null, 'USD'), null);
  assert.equal(fmtCost(Number.NaN, 0.31, 'USD'), null);
  assert.equal(fmtCost(12.34, Number.NaN, 'USD'), null);
});
