import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFLINE_MESSAGE,
  SAVE_FAILED_FIRST_MESSAGE,
  SAVE_FAILED_MESSAGE,
  WAITING_MESSAGE,
  normalizeSettings,
  reconcileSettingsSave,
  sameSettingsInput,
  settingsDraftMatches,
  settingsFields,
  settingsPayload,
  settingsSaveState,
  validateSettings,
} from '../../web/js/settings.js';

test('validateSettings mirrors the rules shape', () => {
  assert.deepEqual(validateSettings({ rate: '0.31', currency: 'USD' }), {
    valid: true,
    errors: {},
    values: { rate: 0.31, currency: 'USD', rates: [] },
  });
  assert.equal(validateSettings({ rate: 0, currency: '$' }).valid, true);
  assert.equal(validateSettings({ rate: 5, currency: 'abcdefgh' }).valid, true);
  // The form trims the currency; the saved value is the trimmed string.
  assert.deepEqual(validateSettings({ rate: '0.2', currency: '  €  ' }).values, {
    rate: 0.2,
    currency: '€',
    rates: [],
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

test('validateSettings carries and validates the optional rate windows', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  const scheduled = validateSettings({ rate: '0.31', currency: 'USD', rates: [night] });
  assert.equal(scheduled.valid, true);
  assert.deepEqual(scheduled.values.rates, [night]);

  // A malformed row blocks the save and reports at document level for now.
  const broken = validateSettings({
    rate: '0.31',
    currency: 'USD',
    rates: [{ ...night, start: '25:00' }],
  });
  assert.equal(broken.valid, false);
  assert.ok(broken.errors.rates);

  const overlap = validateSettings({
    rate: '0.31',
    currency: 'USD',
    rates: [night, { ...night, id: 'dawn', start: '05:00', end: '07:00' }],
  });
  assert.equal(overlap.valid, false);
  assert.match(overlap.errors.rates, /overlaps/);

  const notAList = validateSettings({ rate: '0.31', currency: 'USD', rates: { night } });
  assert.equal(notAList.valid, false);
  assert.match(notAList.errors.rates, /list/);
});

test('normalizeSettings and settingsFields only adopt the documented shape', () => {
  assert.deepEqual(normalizeSettings({ rate: 0.31, currency: 'USD' }), {
    rate: 0.31,
    currency: 'USD',
    rates: [],
  });
  assert.equal(normalizeSettings(null), null);
  assert.equal(normalizeSettings({ rate: '0.31', currency: 'USD' }), null);
  assert.equal(normalizeSettings({ rate: 0.31 }), null);
  assert.equal(normalizeSettings({ rate: 0.31, currency: 5 }), null);
  assert.deepEqual(settingsFields({ rate: 0.31, currency: 'USD' }), {
    rate: '0.31',
    currency: 'USD',
    rates: [],
  });
  assert.deepEqual(settingsFields(null), { rate: '', currency: '', rates: [] });
});

test('the stored rate schedule survives normalization and reaches the form fields', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  const stored = { rate: 0.31, currency: 'USD', rates: [night] };
  assert.deepEqual(normalizeSettings(stored), stored);
  // The form has no rate table yet, but the rows must not be dropped on a save.
  assert.deepEqual(settingsFields(stored).rates, [night]);
});

test('settingsPayload omits an empty schedule so flat writes stay byte-identical', () => {
  assert.deepEqual(settingsPayload({ rate: 0.31, currency: 'USD', rates: [] }), {
    rate: 0.31,
    currency: 'USD',
  });
  assert.deepEqual(settingsPayload({ rate: 0.31, currency: 'USD' }), {
    rate: 0.31,
    currency: 'USD',
  });
  assert.equal('rates' in settingsPayload({ rate: 0.31, currency: 'USD' }), false);

  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  assert.deepEqual(settingsPayload({ rate: 0.31, currency: 'USD', rates: [night] }), {
    rate: 0.31,
    currency: 'USD',
    rates: [night],
  });
});

test('the draft comparison uses parsed values, not raw text', () => {
  // The input's own placeholder invites three decimals; " USD " is trimmed by
  // the validator. Neither may read as a change.
  assert.equal(
    settingsDraftMatches({ rate: '0.250', currency: ' USD ' }, { rate: 0.25, currency: 'USD' }),
    true,
  );
  assert.equal(
    settingsDraftMatches({ rate: '.5', currency: 'USD' }, { rate: 0.5, currency: 'USD' }),
    true,
  );
  assert.equal(
    settingsDraftMatches({ rate: ' 0.25 ', currency: 'USD' }, { rate: 0.25, currency: 'USD' }),
    true,
  );
  // Different values and different currencies stay different.
  assert.equal(
    settingsDraftMatches({ rate: '0.2501', currency: 'USD' }, { rate: 0.25, currency: 'USD' }),
    false,
  );
  assert.equal(
    settingsDraftMatches({ rate: '0.25', currency: 'usd' }, { rate: 0.25, currency: 'USD' }),
    false,
  );
  // The empty form matches "no settings yet", and two identical invalid drafts
  // only match each other textually.
  assert.equal(settingsDraftMatches({ rate: '', currency: '' }, null), true);
  assert.equal(settingsDraftMatches({ rate: 'abc', currency: 'USD' }, null), false);
  assert.equal(
    sameSettingsInput({ rate: 'abc', currency: 'USD' }, { rate: 'abc', currency: 'USD' }),
    true,
  );
});

test('the draft comparison includes the rate schedule', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  const stored = { rate: 0.25, currency: 'USD', rates: [night] };

  assert.equal(
    settingsDraftMatches({ rate: '0.25', currency: 'USD', rates: [night] }, stored),
    true,
  );
  // Day and month order are not a change; a different rate is.
  assert.equal(
    settingsDraftMatches(
      {
        rate: '0.25',
        currency: 'USD',
        rates: [{ ...night, days: [4, 3, 2, 1, 0], months: [1] }],
      },
      { ...stored, rates: [{ ...night, months: [1] }] },
    ),
    true,
  );
  assert.equal(
    settingsDraftMatches(
      { rate: '0.25', currency: 'USD', rates: [{ ...night, rate: 0.13 }] },
      stored,
    ),
    false,
  );
  // Losing the schedule is a change (the editor must never save it away).
  assert.equal(settingsDraftMatches({ rate: '0.25', currency: 'USD', rates: [] }, stored), false);
  // A flat document still matches a draft that carries no rows.
  assert.equal(
    settingsDraftMatches({ rate: '0.25', currency: 'USD' }, { rate: 0.25, currency: 'USD' }),
    true,
  );
});

test('a successful save of non-canonical input settles clean and shows Saved.', () => {
  const draft = { rate: '0.250', currency: ' USD ' };
  const previous = null;
  const values = validateSettings(draft).values;
  const settled = reconcileSettingsSave({ ok: true, values, previous, draft });

  // Fields are canonicalised, so the form no longer looks dirty.
  assert.deepEqual(settled.fields, { rate: '0.25', currency: 'USD', rates: [] });
  assert.deepEqual(settled.confirmed, { rate: 0.25, currency: 'USD', rates: [] });
  assert.equal(settled.dirty, false);
  assert.equal(settled.saved, true);
  assert.equal(settled.error, '');

  const view = settingsSaveState({
    draft: settled.fields,
    confirmed: settled.confirmed,
    saved: settled.saved,
  });
  assert.equal(view.dirty, false);
  assert.equal(view.text, 'Saved.');
  assert.equal(view.kind, 'ok');
  assert.equal(view.canSave, false);

  // The server echo of the same values keeps the confirmation in place.
  const echo = settingsSaveState({
    draft: settled.fields,
    confirmed: settled.confirmed,
    saved: settled.saved,
  });
  assert.equal(echo.text, 'Saved.');
});

test('a save and its rollback carry the rate schedule', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  const draft = { rate: '0.310', currency: ' USD ', rates: [night] };
  const values = validateSettings(draft).values;

  const settled = reconcileSettingsSave({ ok: true, values, previous: null, draft });
  assert.deepEqual(settled.confirmed.rates, [night]);
  assert.deepEqual(settled.fields.rates, [night]);
  assert.equal(settled.saved, true);
  assert.equal(settled.dirty, false);

  const failed = reconcileSettingsSave({
    ok: false,
    values,
    previous: { rate: 0.2, currency: 'EUR', rates: [] },
    draft,
  });
  assert.deepEqual(failed.confirmed, { rate: 0.2, currency: 'EUR', rates: [] });
  assert.deepEqual(failed.fields, { rate: '0.2', currency: 'EUR', rates: [] });
  assert.equal(failed.dirty, false);
});

test('a save typed over while in flight is not canonicalised or called saved', () => {
  const settled = reconcileSettingsSave({
    ok: true,
    values: { rate: 0.25, currency: 'USD' },
    previous: null,
    draft: { rate: '0.25', currency: 'EUR' },
  });
  assert.deepEqual(settled.fields, { rate: '0.25', currency: 'EUR', rates: [] });
  assert.equal(settled.dirty, true);
  assert.equal(settled.saved, false);
  assert.equal(
    settingsSaveState({
      draft: settled.fields,
      confirmed: settled.confirmed,
      saved: settled.saved,
    }).text,
    'Unsaved changes.',
  );
});

test('a failed save rolls an untouched form back to the confirmed values', () => {
  const settled = reconcileSettingsSave({
    ok: false,
    values: { rate: 0.25, currency: 'USD' },
    previous: { rate: 0.31, currency: 'EUR' },
    draft: { rate: '0.250', currency: ' USD ' },
  });
  assert.deepEqual(settled.confirmed, { rate: 0.31, currency: 'EUR', rates: [] });
  assert.deepEqual(settled.fields, { rate: '0.31', currency: 'EUR', rates: [] });
  assert.equal(settled.dirty, false);
  assert.equal(settled.saved, false);
  assert.equal(settled.error, SAVE_FAILED_MESSAGE);
  assert.equal(
    settingsSaveState({
      draft: settled.fields,
      confirmed: settled.confirmed,
      error: settled.error,
    }).text,
    SAVE_FAILED_MESSAGE,
  );
});

test('a first-ever failed save keeps the draft and the retry available', () => {
  const draft = { rate: '0.25', currency: 'USD' };
  const settled = reconcileSettingsSave({
    ok: false,
    values: { rate: 0.25, currency: 'USD' },
    previous: null,
    draft,
  });
  // No settings/current exists yet, so there is no previous state to restore:
  // every field the user typed stays, the form stays dirty, and Save stays on.
  assert.equal(settled.confirmed, null);
  assert.deepEqual(settled.fields, { ...draft, rates: [] });
  assert.equal(settled.dirty, true);
  assert.equal(settled.saved, false);
  assert.equal(settled.error, SAVE_FAILED_FIRST_MESSAGE);
  assert.doesNotMatch(settled.error, /previous/);

  const view = settingsSaveState({
    draft: settled.fields,
    confirmed: settled.confirmed,
    error: settled.error,
  });
  assert.equal(view.text, SAVE_FAILED_FIRST_MESSAGE);
  assert.equal(view.kind, 'err');
  assert.equal(view.canSave, true);

  // A draft typed during that first save still wins over the attempted values.
  const typed = reconcileSettingsSave({
    ok: false,
    values: { rate: 0.25, currency: 'USD' },
    previous: null,
    draft: { rate: '0.4', currency: 'EUR' },
  });
  assert.deepEqual(typed.fields, { rate: '0.4', currency: 'EUR', rates: [] });
  assert.equal(typed.dirty, true);
});

test('a failed save keeps a draft typed during the save', () => {
  const settled = reconcileSettingsSave({
    ok: false,
    values: { rate: 0.25, currency: 'USD' },
    previous: { rate: 0.31, currency: 'EUR' },
    draft: { rate: '0.4', currency: 'USD' },
  });
  assert.deepEqual(settled.fields, { rate: '0.4', currency: 'USD', rates: [] });
  assert.equal(settled.dirty, true);
  assert.equal(settled.saved, false);
  const view = settingsSaveState({
    draft: settled.fields,
    confirmed: settled.confirmed,
    error: settled.error,
  });
  // The error copy outranks the dirty flag, and Save stays available.
  assert.equal(view.text, SAVE_FAILED_MESSAGE);
  assert.equal(view.kind, 'err');
  assert.equal(view.canSave, true);
});

test('a failed save adopts a concurrent remote snapshot instead of the stale baseline', () => {
  const settled = reconcileSettingsSave({
    ok: false,
    values: { rate: 0.25, currency: 'USD' },
    previous: { rate: 0.31, currency: 'EUR' },
    draft: { rate: '0.25', currency: 'USD' },
    remote: { rate: 0.4, currency: 'GBP' },
    remoteSeen: true,
  });
  // Another device wrote while our write was failing: that snapshot is the
  // newest server state.
  assert.deepEqual(settled.confirmed, { rate: 0.4, currency: 'GBP', rates: [] });
  assert.deepEqual(settled.fields, { rate: '0.4', currency: 'GBP', rates: [] });
  assert.equal(settled.dirty, false);
  assert.equal(settled.error, SAVE_FAILED_MESSAGE);
});

test('a failed save never clobbers a draft typed during a reflected snapshot', () => {
  const settled = reconcileSettingsSave({
    ok: false,
    values: { rate: 0.25, currency: 'USD' },
    previous: { rate: 0.31, currency: 'EUR' },
    draft: { rate: '0.4', currency: 'USD' },
    remote: { rate: 0.35, currency: 'GBP' },
    remoteSeen: true,
  });
  assert.deepEqual(settled.confirmed, { rate: 0.35, currency: 'GBP', rates: [] });
  assert.deepEqual(settled.fields, { rate: '0.4', currency: 'USD', rates: [] });
  assert.equal(settled.dirty, true);
});

test('a successful save adopts a newer snapshot but keeps the typed draft', () => {
  const settled = reconcileSettingsSave({
    ok: true,
    values: { rate: 0.25, currency: 'USD' },
    previous: null,
    draft: { rate: '0.25', currency: 'USD' },
    remote: { rate: 0.4, currency: 'GBP' },
    remoteSeen: true,
  });
  assert.deepEqual(settled.confirmed, { rate: 0.4, currency: 'GBP', rates: [] });
  assert.deepEqual(settled.fields, { rate: '0.4', currency: 'GBP', rates: [] });
  assert.equal(settled.dirty, false);
  assert.equal(settled.saved, false);
});

test('settingsSaveState orders feedback states and gates the save button', () => {
  const confirmed = { rate: 0.25, currency: 'USD' };
  const draft = { rate: '0.25', currency: 'USD' };

  const saving = settingsSaveState({ draft, confirmed, saving: true, error: 'old' });
  assert.equal(saving.text, 'Saving…');
  assert.equal(saving.busy, true);
  assert.equal(saving.canSave, false);

  const waiting = settingsSaveState({
    draft: { rate: '0.3', currency: 'USD' },
    confirmed,
    waiting: true,
  });
  assert.equal(waiting.text, WAITING_MESSAGE);
  assert.equal(waiting.kind, 'warn');
  assert.equal(waiting.dirty, true);

  const dirty = settingsSaveState({ draft: { rate: '0.3', currency: 'USD' }, confirmed });
  assert.equal(dirty.text, 'Unsaved changes.');
  assert.equal(dirty.canSave, true);

  const clean = settingsSaveState({ draft, confirmed });
  assert.equal(clean.text, '');
  assert.equal(clean.canSave, false);

  // "Saved." only describes a form that matches the confirmed values.
  assert.equal(settingsSaveState({ draft, confirmed, saved: false }).text, '');
  assert.equal(
    settingsSaveState({ draft: { rate: '0.3', currency: 'USD' }, confirmed, saved: true }).text,
    'Unsaved changes.',
  );
});

test('an offline retry says so while an earlier timed-out write is still pending', () => {
  const confirmed = { rate: 0.25, currency: 'USD' };
  const draft = { rate: '0.3', currency: 'USD' };
  // A save timed out ("waiting"), then the user retried offline: the retry
  // starts no write, so the earlier one still owns its late settlement. The
  // offline copy must outrank "Waiting for the server…" instead of being
  // masked by it, and Save stays available for the next retry.
  const view = settingsSaveState({
    draft,
    confirmed,
    waiting: true,
    error: OFFLINE_MESSAGE,
  });
  assert.equal(view.text, OFFLINE_MESSAGE);
  assert.equal(view.kind, 'err');
  assert.equal(view.busy, false);
  assert.equal(view.dirty, true);
  assert.equal(view.canSave, true);

  // Once the retry succeeds and clears the error, an unresolved earlier write
  // still reports the wait rather than pretending the form settled.
  const reconnected = settingsSaveState({ draft, confirmed, waiting: true, error: '' });
  assert.equal(reconnected.text, WAITING_MESSAGE);
  assert.equal(reconnected.kind, 'warn');
  assert.equal(reconnected.busy, true);

  // A late settlement clears waiting and reconciles to the normal outcomes.
  assert.equal(settingsSaveState({ draft: settingsFields(confirmed), confirmed }).text, '');
  assert.equal(
    settingsSaveState({ draft: settingsFields(confirmed), confirmed, saved: true }).text,
    'Saved.',
  );
});
