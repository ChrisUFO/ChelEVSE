import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFLINE_MESSAGE,
  SAVE_FAILED_FIRST_MESSAGE,
  SAVE_FAILED_MESSAGE,
  WAITING_MESSAGE,
  defaultRateRow,
  normalizeSettings,
  rateOverlapMessage,
  rateRowFields,
  rateWindowSummary,
  reconcileSettingsSave,
  sameSettingsInput,
  settingsDraftMatches,
  settingsFields,
  settingsPayload,
  settingsSaveState,
  validateRateEditorRows,
  validateSettings,
} from '../../web/js/settings.js';
import { normalizeRateSchedule, validateRateWindows } from '../../web/js/rates.js';

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

  // A malformed row blocks the save. The rate editor owns the row- and
  // document-level messages, so this validator reports no error of its own: the
  // invalid window list only makes the document unsaveable.
  const broken = validateSettings({
    rate: '0.31',
    currency: 'USD',
    rates: [{ ...night, start: '25:00' }],
  });
  assert.equal(broken.valid, false);
  assert.deepEqual(broken.errors, {});
  assert.deepEqual(
    broken.values.rates.map((row) => row.start),
    ['25:00'],
  );

  const overlap = validateSettings({
    rate: '0.31',
    currency: 'USD',
    rates: [night, { ...night, id: 'dawn', start: '05:00', end: '07:00' }],
  });
  assert.equal(overlap.valid, false);
  assert.deepEqual(overlap.errors, {});

  const notAList = validateSettings({ rate: '0.31', currency: 'USD', rates: { night } });
  assert.equal(notAList.valid, false);
  assert.deepEqual(notAList.errors, {});
  assert.deepEqual(notAList.values.rates, []);
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
  assert.deepEqual(settingsFields(stored).rates, [night]);
});

test('the editor keeps a malformed stored row that the costing layer drops', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  const broken = {
    id: 'broken',
    rate: 9,
    days: [],
    start: '25:00',
    end: '06:00',
    months: [1, 6],
  };
  const stored = { rate: 0.31, currency: 'USD', rates: [night, broken] };
  // The form must show what is stored, not silently delete a row the owner may
  // still want to fix; costing uses only the usable row.
  assert.deepEqual(
    normalizeSettings(stored).rates.map((row) => row.id),
    ['night', 'broken'],
  );
  assert.deepEqual(
    normalizeRateSchedule(stored).rates.map((row) => row.id),
    ['night'],
  );
  assert.deepEqual(
    settingsFields(stored).rates.map((row) => row.id),
    ['night', 'broken'],
  );
  // The kept row validates as broken, so it blocks a save until it is fixed or
  // removed — it is never quietly rewritten by an unrelated rate edit.
  const result = validateSettings(settingsFields(stored));
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, {});
  // Showing the broken row is not an unsaved change: the draft built from the
  // document matches it exactly.
  assert.equal(settingsDraftMatches(settingsFields(stored), stored), true);
});

test('rateRowFields makes stored rows editable without repairing their values', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  assert.deepEqual(rateRowFields(night), { ...night, rate: '0.12' });
  assert.deepEqual(
    rateRowFields({
      id: 'broken',
      rate: 'abc',
      days: 'Mon',
      start: 25,
      end: null,
      months: 3,
    }),
    { id: 'broken', rate: '', days: [], start: '', end: '', months: 3 },
  );
  // Month lists are copied so editing one form cannot mutate a snapshot.
  const months = [11, 12, 1];
  const editable = rateRowFields({ ...night, months });
  months.push(2);
  assert.deepEqual(editable.months, [11, 12, 1]);
});

test('a fresh rate row is an overnight window waiting for a price', () => {
  const row = defaultRateRow('row-1');
  assert.deepEqual(row, {
    id: 'row-1',
    rate: '',
    days: [0, 1, 2, 3, 4],
    start: '00:00',
    end: '07:00',
    months: null,
  });
  // Each call owns its arrays.
  row.days.push(6);
  assert.deepEqual(defaultRateRow('row-2').days, [0, 1, 2, 3, 4]);
});

test('the editor validator adds the one-range month rule on top of the stored rules', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  assert.deepEqual(validateRateEditorRows([]), {
    valid: true,
    general: [],
    rows: [],
    overlaps: [],
  });
  assert.equal(validateRateEditorRows([rateRowFields(night)]).valid, true);

  // A stored list such as January + June is valid data but not one range: the
  // editor cannot show it, so it says so instead of rewriting it on save.
  const loose = { ...night, id: 'loose', months: [1, 6] };
  assert.equal(validateRateWindows([loose]).valid, true);
  const looseResult = validateRateEditorRows([rateRowFields(loose)]);
  assert.equal(looseResult.valid, false);
  assert.match(looseResult.rows[0].months, /month range/);

  const overlap = validateRateEditorRows([
    rateRowFields(night),
    rateRowFields({ ...night, id: 'dawn', start: '05:00', end: '07:00' }),
  ]);
  assert.equal(overlap.valid, false);
  assert.deepEqual(overlap.overlaps, [[0, 1]]);
  assert.deepEqual(overlap.rows, [{}, {}]);
  assert.match(overlap.general.join(' '), /Rate windows 1 and 2 overlap/);
  assert.equal(rateOverlapMessage([[0, 1]]), overlap.general[0]);
  assert.match(
    rateOverlapMessage([
      [0, 1],
      [0, 2],
    ]),
    /1 and 2, 1 and 3/,
  );

  // Per-row errors stay on their row, and the position-based overlap copy does
  // not fall back to the stored ids.
  const broken = validateRateEditorRows([
    rateRowFields({ ...night, id: '', rate: 9 }),
    rateRowFields(night),
  ]);
  assert.equal(broken.valid, false);
  assert.match(broken.rows[0].id, /id/);
  assert.match(broken.rows[0].rate, /rate/i);
});

test('the rate table draft becomes dirty only when a row really changes', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  const stored = { rate: 0.25, currency: 'USD', rates: [night] };
  const base = { rate: '0.25', currency: 'USD', rates: [rateRowFields(night)] };
  assert.equal(settingsDraftMatches(base, stored), true);
  // Numeric text is not a change.
  assert.equal(
    settingsDraftMatches({ ...base, rates: [rateRowFields({ ...night, rate: '0.120' })] }, stored),
    true,
  );
  // Adding or removing a row is.
  assert.equal(
    settingsDraftMatches({ ...base, rates: [...base.rates, defaultRateRow('new')] }, stored),
    false,
  );
  assert.equal(settingsDraftMatches({ ...base, rates: [] }, stored), false);
  // Editing a row back to the stored value is clean again.
  assert.equal(
    settingsDraftMatches(
      { ...base, rates: [rateRowFields({ ...night, days: [0, 1, 2, 3, 4] })] },
      stored,
    ),
    true,
  );
});

test('a rate-table save writes numeric rows, and an empty table stays flat', () => {
  const night = {
    id: 'night',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  const editable = rateRowFields({ ...night, rate: '0.120' });
  const values = validateSettings({ rate: '0.31', currency: ' USD ', rates: [editable] }).values;
  assert.deepEqual(values.rates, [night]);
  assert.deepEqual(settingsPayload(values), { rate: 0.31, currency: 'USD', rates: [night] });

  const flat = validateSettings({ rate: '0.31', currency: 'USD', rates: [] }).values;
  assert.equal('rates' in settingsPayload(flat), false);
});

test('a rate window summary stays readable without hiding invalid values', () => {
  const row = {
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  assert.equal(rateWindowSummary(row), 'Weekdays · 22:00–06:00 next day · All year');
  assert.equal(
    rateWindowSummary({ ...row, days: [0, 1, 2, 3, 4, 5, 6] }),
    'Every day · 22:00–06:00 next day · All year',
  );
  assert.equal(
    rateWindowSummary({ ...row, days: [5, 6] }),
    'Weekends · 22:00–06:00 next day · All year',
  );
  assert.equal(
    rateWindowSummary({
      ...row,
      days: [1, 3],
      start: '09:00',
      end: '12:00',
      months: [11, 12, 1, 2],
    }),
    'Tue, Thu · 09:00–12:00 · Nov–Feb',
  );
  assert.equal(
    rateWindowSummary({ ...row, days: [6], start: '00:00', end: '00:00', months: [7] }),
    'Sun · All day · Jul',
  );
  assert.equal(
    rateWindowSummary({ days: [], start: '', end: '', months: null }),
    'No days · Times not set · All year',
  );
  assert.equal(
    rateWindowSummary({ ...row, months: [1, 6] }),
    'Weekdays · 22:00–06:00 next day · Custom months',
  );
  assert.equal(
    rateWindowSummary({ ...row, days: [0, 9] }),
    'Invalid days · 22:00–06:00 next day · All year',
  );
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
