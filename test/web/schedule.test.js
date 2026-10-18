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
  scheduleKey,
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

test('normalizeSchedule repairs the editable shape without inventing values', () => {
  assert.deepEqual(normalizeSchedule(null), { enabled: false, rules: [] });
  assert.deepEqual(normalizeSchedule({ enabled: 'true', rules: [] }), {
    enabled: false,
    rules: [],
  });
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
    rules: [{ id: 'r', days: [2, 0], start: '22:00', end: '06:00', amps: 32 }],
  });
  assert.equal(validateSchedule(normalized).valid, true);
});

test('scheduleKey ignores day order but notices any real change', () => {
  const a = schedule();
  const b = schedule({ rules: [rule({ days: [2, 0] })] });
  assert.equal(scheduleKey(a), scheduleKey(b));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ enabled: false })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ start: '23:00' })] })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ amps: 16 })] })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ id: 'other' })] })));
});
