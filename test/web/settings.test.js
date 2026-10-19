import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings, settingsFields, validateSettings } from '../../web/js/settings.js';

test('validateSettings mirrors the rules shape', () => {
  assert.deepEqual(validateSettings({ rate: '0.31', currency: 'USD' }), {
    valid: true,
    errors: {},
    values: { rate: 0.31, currency: 'USD' },
  });
  assert.equal(validateSettings({ rate: 0, currency: '$' }).valid, true);
  assert.equal(validateSettings({ rate: 5, currency: 'abcdefgh' }).valid, true);
  // The form trims the currency; the saved value is the trimmed string.
  assert.deepEqual(validateSettings({ rate: '0.2', currency: '  €  ' }).values, {
    rate: 0.2,
    currency: '€',
  });

  for (const rate of [-0.01, 5.01, '', '  ', 'abc', null, undefined, Number.NaN, Infinity]) {
    const result = validateSettings({ rate, currency: 'USD' });
    assert.equal(result.valid, false, String(rate));
    assert.ok(result.errors.rate, String(rate));
  }
  for (const currency of ['', '   ', null, undefined, 'abcdefghi']) {
    const result = validateSettings({ rate: 0.3, currency });
    assert.equal(result.valid, false, String(currency));
    assert.ok(result.errors.currency, String(currency));
  }

  const empty = validateSettings({});
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.rate);
  assert.ok(empty.errors.currency);
});

test('normalizeSettings and settingsFields only adopt the documented shape', () => {
  assert.deepEqual(normalizeSettings({ rate: 0.31, currency: 'USD' }), {
    rate: 0.31,
    currency: 'USD',
  });
  assert.equal(normalizeSettings(null), null);
  assert.equal(normalizeSettings({ rate: '0.31', currency: 'USD' }), null);
  assert.equal(normalizeSettings({ rate: 0.31 }), null);
  assert.equal(normalizeSettings({ rate: 0.31, currency: 5 }), null);
  assert.deepEqual(settingsFields({ rate: 0.31, currency: 'USD' }), {
    rate: '0.31',
    currency: 'USD',
  });
  assert.deepEqual(settingsFields(null), { rate: '', currency: '' });
});
