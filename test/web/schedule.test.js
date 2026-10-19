import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_NAMES,
  MAX_AMPS,
  MAX_RULES,
  MIN_AMPS,
  defaultRule,
  defaultSchedule,
  normalizeSchedule,
  reconcileAfterSave,
  reconcileDirtyRemote,
  scheduleKey,
  scheduleSaveValid,
  toggleNote,
  validateSchedule,
} from '../../web/js/schedule.js';

const rule = (overrides = {}) => ({
  id: 'rule-1',
  days: [0, 2],
  start: '22:00',
  end: '06:00',
  amps: 32,
  ...overrides,
});

const schedule = (overrides = {}) => ({
  enabled: true,
  rules: [rule()],
  ...overrides,
});

test('defaults are an empty disabled schedule and a weekday window', () => {
  assert.deepEqual(defaultSchedule(), { enabled: false, rules: [] });
  assert.deepEqual(defaultRule('abc'), {
    id: 'abc',
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    amps: 32,
  });
  assert.deepEqual(DAY_NAMES, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(MIN_AMPS, 6);
  assert.equal(MAX_AMPS, 48);
  assert.equal(MAX_RULES, 20);
});

test('validateSchedule accepts the documented shape and empty rules', () => {
  assert.equal(validateSchedule(schedule()).valid, true);
  assert.equal(validateSchedule({ enabled: false, rules: [] }).valid, true);
  assert.equal(validateSchedule(schedule({ enabled: false })).valid, true);
});

test('validateSchedule enforces the 20-rule container limit', () => {
  const atLimit = {
    enabled: true,
    rules: Array.from({ length: 20 }, (_, i) => rule({ id: `r${i}` })),
  };
  assert.equal(validateSchedule(atLimit).valid, true);
  const over = {
    enabled: true,
    rules: Array.from({ length: 21 }, (_, i) => rule({ id: `r${i}` })),
  };
  const result = validateSchedule(over);
  assert.equal(result.valid, false);
  assert.match(result.errors.rules, /at most 20/);
});

test('validateSchedule rejects malformed days', () => {
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: [] })] })).ruleErrors[0].days,
    /at least one/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: null })] })).ruleErrors[0].days,
    /at least one/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: [0, 0] })] })).ruleErrors[0].days,
    /once/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: [7] })] })).ruleErrors[0].days,
    /0 to 6/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: [1.5] })] })).ruleErrors[0].days,
    /0 to 6/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: ['1'] })] })).ruleErrors[0].days,
    /0 to 6/,
  );
});

test('validateSchedule rejects non-HH:MM times and equal ends', () => {
  for (const start of ['', '7:00', '24:00', '12:60', '22:00\n', '٢٢:٠٠', '2200', null]) {
    const result = validateSchedule(schedule({ rules: [rule({ start })] }));
    assert.equal(result.valid, false, String(start));
    assert.ok(result.ruleErrors[0].start, String(start));
  }
  const equal = validateSchedule(schedule({ rules: [rule({ start: '22:00', end: '22:00' })] }));
  assert.equal(equal.valid, false);
  assert.match(equal.ruleErrors[0].start, /different/);
  assert.match(equal.ruleErrors[0].end, /different/);
});

test('validateSchedule enforces integer amps from 6 to 48', () => {
  for (const amps of [6, 32, 48]) {
    assert.equal(validateSchedule(schedule({ rules: [rule({ amps })] })).valid, true, String(amps));
  }
  for (const amps of [5, 49, 32.5, '32', null, Number.NaN]) {
    const result = validateSchedule(schedule({ rules: [rule({ amps })] }));
    assert.equal(result.valid, false, String(amps));
    assert.match(result.ruleErrors[0].amps, /whole number from 6 to 48/);
  }
});

test('validateSchedule rejects empty ids, non-boolean enabled, and non-list rules', () => {
  assert.match(validateSchedule(schedule({ rules: [rule({ id: '' })] })).ruleErrors[0].id, /id/);
  assert.match(validateSchedule(schedule({ rules: [rule({ id: 5 })] })).ruleErrors[0].id, /id/);
  assert.match(validateSchedule(schedule({ enabled: 'yes' })).errors.enabled, /true or false/);
  const badRules = validateSchedule({ enabled: false, rules: 'nope' });
  assert.equal(badRules.valid, false);
  assert.match(badRules.errors.rules, /list/);
  assert.equal(validateSchedule(null).valid, false);
});

test('normalizeSchedule keeps malformed server values visible for validation', () => {
  assert.deepEqual(normalizeSchedule(null), { enabled: false, rules: [] });
  // The bridge requires a boolean `enabled` and a list `rules`; anything else
  // is a malformed document it leaves untouched, so flag it instead of
  // presenting a silently repaired, saveable schedule.
  assert.deepEqual(normalizeSchedule({ enabled: 'true', rules: [] }), {
    enabled: false,
    rules: [],
    malformed: true,
  });
  // The bridge drops a whole rule for these values; repairing them here would
  // let a later save silently activate a window the charger is ignoring.
  const normalized = normalizeSchedule({
    enabled: true,
    rules: [
      {
        id: 'r',
        days: [2, 0, 2, 7, 1.5],
        start: '22:00',
        end: '06:00',
        amps: '32',
      },
    ],
  });
  assert.deepEqual(normalized, {
    enabled: true,
    rules: [{ id: 'r', days: [2, 0, 2, 7, 1.5], start: '22:00', end: '06:00', amps: '32' }],
  });
  const result = validateSchedule(normalized);
  assert.equal(result.valid, false);
  assert.match(result.ruleErrors[0].days, /0 to 6/);
  assert.match(result.ruleErrors[0].amps, /whole number/);
  // Non-object rules keep the editable shape without inventing values.
  assert.deepEqual(normalizeSchedule({ enabled: true, rules: [null, 5] }).rules, [
    { id: '', days: [], start: '', end: '', amps: 0 },
    { id: '', days: [], start: '', end: '', amps: 0 },
  ]);
});

test('normalizeSchedule flags malformed containers instead of repairing them', () => {
  for (const data of [
    { enabled: true, rules: {} },
    { enabled: true, rules: 'nope' },
    { enabled: false },
    { enabled: 'yes', rules: [] },
    { rules: [] },
  ]) {
    const normalized = normalizeSchedule(data);
    assert.equal(normalized.malformed, true, JSON.stringify(data));
    assert.deepEqual(normalized.rules, []);
    // Validation and save eligibility surface the unsupported shape.
    const result = validateSchedule(normalized);
    assert.equal(result.valid, false);
    assert.match(result.errors.rules, /unsupported shape/);
    assert.equal(scheduleSaveValid(normalized, result), false);
  }
  // The flag survives a re-normalization (clone) so the screen keeps showing it.
  const flagged = normalizeSchedule({ enabled: true, rules: {} });
  assert.equal(normalizeSchedule(flagged).malformed, true);
  // A well-formed document carries no flag.
  assert.deepEqual(normalizeSchedule(schedule()), schedule());
});

test('scheduleSaveValid lets a disable through invalid rules but not container errors', () => {
  assert.equal(scheduleSaveValid(schedule()), true);
  const invalidDisabled = schedule({ enabled: false, rules: [rule({ days: [] })] });
  assert.equal(validateSchedule(invalidDisabled).valid, false);
  assert.equal(scheduleSaveValid(invalidDisabled), true);
  // Enabled schedules still need every rule to pass.
  assert.equal(scheduleSaveValid(schedule({ rules: [rule({ days: [] })] })), false);
  assert.equal(scheduleSaveValid(schedule({ rules: [rule({ amps: 10.5 })] })), false);
  // Container errors block every save, including a disable.
  const tooMany = {
    enabled: false,
    rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => rule({ id: `r${i}` })),
  };
  assert.equal(scheduleSaveValid(tooMany), false);
  assert.equal(scheduleSaveValid({ enabled: false, rules: 'nope' }), false);
});

const payload = schedule({ rules: [rule({ amps: 40 })] });

test('reconcileAfterSave succeeds on the echo, a remote snapshot, or the payload', () => {
  const echo = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: payload,
    ok: true,
  });
  assert.equal(scheduleKey(echo.baseline), scheduleKey(payload));

  const remote = schedule({ enabled: false, rules: [] });
  const newer = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: remote,
    ok: true,
  });
  assert.equal(scheduleKey(newer.baseline), scheduleKey(remote));

  const alone = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: null,
    ok: true,
  });
  assert.equal(scheduleKey(alone.baseline), scheduleKey(payload));
});

test('reconcileAfterSave rolls a failed save back past the local echo', () => {
  // The SDK delivers the latency-compensated echo before it rejects the write,
  // so a queued snapshot equal to the payload is not remote truth.
  const result = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: payload,
    ok: false,
  });
  assert.equal(scheduleKey(result.baseline), scheduleKey(schedule()));
  assert.equal(result.remote, false);
  assert.match(result.error, /previous schedule was restored/);
});

test('reconcileAfterSave rolls back to a genuine external snapshot', () => {
  const remote = schedule({ enabled: false, rules: [] });
  const result = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: remote,
    ok: false,
  });
  assert.equal(scheduleKey(result.baseline), scheduleKey(remote));
  assert.equal(result.remote, true);
  assert.match(result.error, /latest server schedule was restored/);
});

test('reconcileAfterSave keeps the confirmed baseline when nothing was pending', () => {
  const baseline = schedule();
  const result = reconcileAfterSave({
    confirmed: baseline,
    payload,
    pendingRemote: null,
    ok: false,
  });
  assert.equal(scheduleKey(result.baseline), scheduleKey(baseline));
  assert.equal(result.remote, false);
});

test('scheduleKey ignores day order but notices any real change', () => {
  const a = schedule();
  const b = schedule({ rules: [rule({ days: [2, 0] })] });
  assert.equal(scheduleKey(a), scheduleKey(b));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ enabled: false })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ start: '23:00' })] })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ amps: 16 })] })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ id: 'other' })] })));
  // Clearing a malformed-container flag is a real change: it is the user
  // explicitly replacing the stored shape.
  assert.notEqual(scheduleKey(schedule()), scheduleKey({ ...schedule(), malformed: true }));
});

test('reconcileDirtyRemote tracks server truth without touching the draft', () => {
  const draft = schedule({ rules: [rule({ amps: 40 })] });
  const remote = schedule({ rules: [rule({ amps: 24 })] });
  const result = reconcileDirtyRemote({ confirmed: schedule(), draft, incoming: remote });
  assert.equal(scheduleKey(result.confirmed), scheduleKey(remote));
  assert.equal(result.dirty, true);
  assert.equal(result.remoteNotice, true);
  // The draft object itself is untouched (the editor owns it).
  assert.equal(draft.rules[0].amps, 40);

  // The server is still on the snapshot the draft was based on: no notice.
  const same = reconcileDirtyRemote({ confirmed: schedule(), draft, incoming: schedule() });
  assert.equal(same.dirty, true);
  assert.equal(same.remoteNotice, false);

  // The remote change matches the draft exactly: nothing is unsaved anymore.
  const matches = reconcileDirtyRemote({ confirmed: schedule(), draft, incoming: draft });
  assert.equal(matches.dirty, false);
  assert.equal(matches.remoteNotice, false);
});

test('toggleNote reports an unknown state for a malformed stored schedule', () => {
  assert.equal(toggleNote(schedule({ enabled: true })), 'Charging follows these windows.');
  assert.equal(
    toggleNote(schedule({ enabled: false })),
    'Charging is not restricted by a schedule.',
  );
  // The bridge skips a malformed container and leaves the charger's firmware
  // schedule alone, so the toggle must not assert "not restricted".
  const malformed = normalizeSchedule({ enabled: 'yes', rules: [] });
  assert.equal(malformed.malformed, true);
  assert.match(toggleNote(malformed), /Unsupported stored schedule/);
  assert.match(toggleNote(malformed), /firmware schedule/);
  assert.doesNotMatch(toggleNote(malformed), /not restricted/);
  // Empty and missing documents are well-formed "off", not unknown.
  assert.equal(toggleNote(defaultSchedule()), 'Charging is not restricted by a schedule.');
});
