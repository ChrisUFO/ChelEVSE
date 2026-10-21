import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_PRESETS,
  OFFLINE_MESSAGE,
  SAVE_FAILED_FIRST_MESSAGE,
  SAVE_FAILED_MESSAGE,
  WAITING_MESSAGE,
  applyPeriodMonths,
  complementMonths,
  copyPeriodRows,
  dateInputValue,
  dayPresetFor,
  dayTypeLabel,
  dayTypesForWeek,
  daysForPreset,
  defaultRateRow,
  formatPreviewWhen,
  minutesToClock,
  normalizeSettings,
  parseLocalDateTime,
  periodCoverage,
  previewRate,
  largestMonthRun,
  rateMonthsText,
  rateMonthScope,
  ratePlanRange,
  rateOverlapMessage,
  ratePeriodTitle,
  ratePeriods,
  rateRowFields,
  rateSegmentLabel,
  rateTierFor,
  rateWeek,
  rateWindowSummary,
  reconcileSettingsSave,
  sameSettingsInput,
  segmentNote,
  settingsDraftMatches,
  settingsFields,
  settingsPayload,
  settingsSaveState,
  timeInputValue,
  validateRateEditorRows,
  validateSettings,
  windowLabel,
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

test('a fresh rate row is an everyday overnight window waiting for a price', () => {
  const row = defaultRateRow('row-1');
  assert.deepEqual(row, {
    id: 'row-1',
    rate: '',
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '07:00',
    months: null,
  });
  // Each call owns its arrays.
  row.days.pop();
  assert.deepEqual(defaultRateRow('row-2').days, [0, 1, 2, 3, 4, 5, 6]);
  // A period's months are inherited at creation and copied.
  const months = [11, 12, 1, 2];
  const winter = defaultRateRow('row-3', months);
  months.push(3);
  assert.deepEqual(winter.months, [11, 12, 1, 2]);
});

test('the editor accepts every valid stored month set, including non-contiguous ones', () => {
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

  // The month chips can show January + June, so the old "one range" editor rule
  // is gone: the stored rules are the whole rulebook again.
  const loose = { ...night, id: 'loose', months: [1, 6] };
  assert.equal(validateRateWindows([loose]).valid, true);
  assert.equal(validateRateEditorRows([rateRowFields(loose)]).valid, true);

  const overlap = validateRateEditorRows([
    rateRowFields(night),
    rateRowFields({ ...night, id: 'dawn', start: '05:00', end: '07:00' }),
  ]);
  assert.equal(overlap.valid, false);
  assert.deepEqual(overlap.overlaps, [[0, 1]]);
  assert.deepEqual(overlap.rows, [{}, {}]);
  // Both rows are named by their price band and times, not by a storage index.
  // Both rows share "All year", so the months are left to the period header.
  assert.match(overlap.general[0], /“Off-peak 0.12 · Weekdays · 22:00–06:00 next day”/);
  assert.match(overlap.general[0], /“Off-peak 0.12 · Weekdays · 05:00–07:00”/);
  assert.match(overlap.general[0], /no moment has two rates/);
  assert.equal(
    rateOverlapMessage([[0, 1]], [night, { ...night, start: '05:00', end: '07:00' }]),
    overlap.general[0],
  );
  assert.match(
    rateOverlapMessage(
      [
        [0, 1],
        [0, 2],
      ],
      [
        night,
        { ...night, id: 'b', start: '05:00', end: '07:00' },
        { ...night, id: 'c', start: '06:00', end: '08:00' },
      ],
    ),
    /overlaps .*; “.*” overlaps /,
  );

  // Per-row errors stay on their row, and the overlap copy does not fall back
  // to stored ids when a row cannot be named.
  const broken = validateRateEditorRows([
    rateRowFields({ ...night, id: '', rate: 9 }),
    rateRowFields(night),
  ]);
  assert.equal(broken.valid, false);
  assert.match(broken.rows[0].id, /id/);
  assert.match(broken.rows[0].rate, /rate/i);
  assert.match(
    rateOverlapMessage([[0, 1]], [{ days: [], start: '', end: '', months: null }, night]),
    /“No days · Times not set”/,
  );
  // Two genuinely identical rows get an ordinal so the sentence names two
  // rows, not the same name twice.
  const duplicate = rateOverlapMessage([[0, 1]], [night, { ...night, id: 'copy' }]);
  assert.match(
    duplicate,
    /Two windows are identical: “Off-peak 0.12 · Weekdays · 22:00–06:00 next day”/,
  );
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
  assert.equal(rateWindowSummary(row), 'Weekdays · 22:00–06:00 next day');
  assert.equal(
    rateWindowSummary({ ...row, days: [0, 1, 2, 3, 4, 5, 6] }),
    'Every day · 22:00–06:00 next day',
  );
  assert.equal(rateWindowSummary({ ...row, days: [5, 6] }), 'Weekends · 22:00–06:00 next day');
  assert.equal(
    rateWindowSummary({
      ...row,
      days: [1, 3],
      start: '09:00',
      end: '12:00',
      months: [11, 12, 1, 2],
    }),
    'Tue, Thu · 09:00–12:00',
  );
  assert.equal(
    rateWindowSummary({ ...row, days: [6], start: '00:00', end: '00:00', months: [7] }),
    'Sun · All day',
  );
  assert.equal(
    rateWindowSummary({ days: [], start: '', end: '', months: null }),
    'No days · Times not set',
  );
  assert.equal(rateWindowSummary({ ...row, months: [1, 6] }), 'Weekdays · 22:00–06:00 next day');
  assert.equal(rateWindowSummary({ ...row, days: [0, 9] }), 'Invalid days · 22:00–06:00 next day');
});

test('seven day values are only "Every day" when all seven are real weekdays', () => {
  // The shorthand labels must never mask bad data: a hand-edited set of seven
  // values that includes something outside 0–6 is not every day.
  const row = { days: [0, 1, 2, 3, 4, 5, 9], start: '22:00', end: '06:00', months: null };
  assert.equal(rateWindowSummary(row), 'Invalid days · 22:00–06:00 next day');
  assert.equal(
    rateWindowSummary({ ...row, days: [6, 5, 4, 3, 2, 1, 0] }),
    'Every day · 22:00–06:00 next day',
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

// ---------- month scopes, periods and the plan view ----------

const nightEveryDay = {
  id: 'night',
  rate: 0.1,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '22:00',
  end: '06:00',
  months: null,
};
const winterPeak = {
  id: 'winter-peak',
  rate: 0.32,
  days: [0, 1, 2, 3, 4],
  start: '16:00',
  end: '19:00',
  months: [11, 12, 1, 2],
};
const summerFlat = {
  id: 'summer',
  rate: 0.2,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '00:00',
  end: '00:00',
  months: [3, 4, 5, 6, 7, 8, 9, 10],
};

test('a stored month list is reduced to what it can match, without repair', () => {
  assert.deepEqual(rateMonthScope({ months: null }), { kind: 'all', months: null });
  assert.deepEqual(rateMonthScope({ months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }), {
    kind: 'all',
    months: null,
  });
  assert.deepEqual(rateMonthScope({ months: [11, 12, 1, 2] }), {
    kind: 'months',
    months: [1, 2, 11, 12],
  });
  // Duplicates and out-of-range values are kept in the row for validation, but
  // only the months that can actually match are grouped.
  assert.deepEqual(rateMonthScope({ months: [1, 1, 2] }), { kind: 'months', months: [1, 2] });
  assert.deepEqual(rateMonthScope({ months: [1, 13] }), { kind: 'months', months: [1] });
  assert.deepEqual(rateMonthScope({ months: [1, 6] }), { kind: 'months', months: [1, 6] });
  // Values that match nothing still need a home in the editor.
  assert.deepEqual(rateMonthScope({ months: [] }), { kind: 'invalid', months: [] });
  assert.deepEqual(rateMonthScope({ months: 3 }), { kind: 'invalid', months: [] });
  assert.deepEqual(rateMonthScope({ months: [0, 13] }), { kind: 'invalid', months: [] });
});

test('months read as ranges that may wrap, or as a custom list', () => {
  assert.equal(rateMonthsText(null), 'All year');
  assert.equal(rateMonthsText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'All year');
  assert.equal(rateMonthsText([11, 12, 1, 2]), 'Nov–Feb');
  assert.equal(rateMonthsText([1, 2, 11, 12]), 'Nov–Feb');
  assert.equal(rateMonthsText([1, 6]), 'Jan, Jun');
  assert.equal(rateMonthsText([1, 2, 3, 6, 7]), 'Jan–Mar, Jun–Jul');
  assert.equal(rateMonthsText([7]), 'Jul');
  assert.equal(rateMonthsText([]), 'No months');
  assert.equal(rateMonthsText(3), 'No months');
  assert.equal(rateMonthsText(null, 'invalid'), 'No months');
});

test('period titles use familiar seasons only when the months actually match', () => {
  assert.equal(ratePeriodTitle(null, 'all'), 'All year');
  assert.equal(ratePeriodTitle([11, 12, 1, 2], 'months'), 'Winter');
  assert.equal(ratePeriodTitle([3, 4, 5, 6, 7, 8, 9, 10], 'months'), 'Summer');
  // A non-canonical set keeps a stable title and shows its months in the band.
  assert.equal(ratePeriodTitle([1, 6], 'months'), 'Custom months');
  assert.equal(ratePeriodTitle([10, 11, 12, 1, 2, 3], 'months'), 'Custom months');
  assert.equal(rateMonthsText([1, 6]), 'Jan, Jun');
  assert.equal(ratePeriodTitle(null, 'invalid'), 'Needs attention');
});

test('the flat list groups into stable month periods without reordering rows', () => {
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak), rateRowFields(summerFlat)];
  const periods = ratePeriods(rows);
  assert.deepEqual(
    periods.map((period) => [
      period.title,
      period.kind,
      period.months,
      period.rows.map((r) => r.index),
    ]),
    [
      ['All year', 'all', null, [0]],
      ['Winter', 'months', [1, 2, 11, 12], [1]],
      ['Summer', 'months', [3, 4, 5, 6, 7, 8, 9, 10], [2]],
    ],
  );
  assert.deepEqual(periods[1].rateRange, { min: 0.32, max: 0.32 });
  // A number and its numeric text are the same rate; a 0–5 violation is not
  // allowed to widen the range the header advertises.
  const mixed = ratePeriods([
    { ...rateRowFields(nightEveryDay), rate: '0.120' },
    { ...rateRowFields(winterPeak), rate: 9 },
    { ...rateRowFields(summerFlat), rate: '' },
  ]);
  assert.deepEqual(mixed[0].rateRange, { min: 0.12, max: 0.12 });
  assert.deepEqual(mixed[1].rateRange, null);

  // A malformed month value has no period to belong to and is surfaced first.
  const broken = ratePeriods([rateRowFields({ ...nightEveryDay, months: 3 }), ...rows]);
  assert.equal(broken[0].kind, 'invalid');
  assert.equal(broken[0].title, 'Needs attention');
  assert.equal(broken[0].monthText, 'No months');
  assert.deepEqual(
    broken[0].rows.map((r) => r.index),
    [0],
  );
});

test('one period month edit rewrites every member and nothing else', () => {
  const loose = { ...rateRowFields(nightEveryDay), id: 'loose', months: [1, 6] };
  const rows = [rateRowFields(winterPeak), loose, rateRowFields(summerFlat)];
  const periods = ratePeriods(rows);
  const winter = periods.find((period) => period.title === 'Winter');
  const next = applyPeriodMonths(
    rows,
    winter.rows.map((row) => row.index),
    [10, 11, 12, 1, 2, 3],
  );
  assert.deepEqual(next[0].months, [1, 2, 3, 10, 11, 12]);
  // The untouched non-contiguous row keeps its exact stored list and identity.
  assert.equal(next[1], rows[1]);
  assert.deepEqual(next[1].months, [1, 6]);
  assert.deepEqual(next[2].months, summerFlat.months);
  // A whole-year choice stores null, not a 12-item list.
  const allYear = applyPeriodMonths(next, [2], null);
  assert.equal(allYear[2].months, null);
  // An empty choice stays empty and is caught by validation, not repaired.
  const empty = applyPeriodMonths(rows, [0], []);
  assert.deepEqual(empty[0].months, []);
});

test('a season can be duplicated into the months it does not cover', () => {
  assert.deepEqual(complementMonths([11, 12, 1, 2]), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(complementMonths([1]), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(complementMonths(null), []);
  assert.deepEqual(complementMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), []);

  const rows = [rateRowFields(winterPeak)];
  let nextId = 0;
  const copied = copyPeriodRows(
    rows,
    [0],
    complementMonths(winterPeak.months),
    () => `copy-${++nextId}`,
  );
  assert.equal(copied.length, 2);
  assert.equal(copied[1].id, 'copy-1');
  // The editor keeps the rate as the number input's text; the payload converts
  // it back to a number.
  assert.equal(copied[1].rate, '0.32');
  assert.deepEqual(copied[1].months, [3, 4, 5, 6, 7, 8, 9, 10]);
  // Arrays are independent copies and the source is untouched.
  copied[1].days.push(5);
  assert.deepEqual(rows[0].days, [0, 1, 2, 3, 4]);
  assert.deepEqual(copied[0].days, [0, 1, 2, 3, 4]);
});

test('day presets are shortcuts over the same days array', () => {
  assert.deepEqual(
    DAY_PRESETS.map((preset) => preset.id),
    ['every', 'weekdays', 'weekends', 'custom'],
  );
  assert.deepEqual(daysForPreset('every'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(daysForPreset('weekdays'), [0, 1, 2, 3, 4]);
  assert.deepEqual(daysForPreset('weekends'), [5, 6]);
  assert.equal(daysForPreset('custom'), null);
  assert.equal(dayPresetFor([0, 1, 2, 3, 4, 5, 6]), 'every');
  assert.equal(dayPresetFor([4, 3, 2, 1, 0]), 'weekdays');
  assert.equal(dayPresetFor([5, 6]), 'weekends');
  assert.equal(dayPresetFor([0, 1, 2, 3, 4, 5, 9]), 'custom');
  assert.equal(dayPresetFor([0, 0, 1]), 'custom');
  assert.equal(dayPresetFor([]), 'custom');
  assert.equal(dayTypeLabel([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(dayTypeLabel([0, 1, 2, 3, 4]), 'Weekdays');
  assert.equal(dayTypeLabel([5, 6]), 'Weekends');
  assert.equal(dayTypeLabel([1, 3]), 'Tue, Thu');
});

test('price bands come from relative price, never from a stored name', () => {
  assert.equal(rateTierFor(0.1, [0.1, 0.2, 0.3], 0.25), 'Off-peak');
  assert.equal(rateTierFor(0.2, [0.1, 0.2, 0.3], 0.25), 'Shoulder');
  assert.equal(rateTierFor(0.3, [0.1, 0.2, 0.3], 0.25), 'Peak');
  assert.equal(rateTierFor(0.1, [0.1, 0.3], 0.25), 'Off-peak');
  assert.equal(rateTierFor(0.3, [0.1, 0.3], 0.25), 'Peak');
  // A single window is described against the all-other-times price.
  assert.equal(rateTierFor(0.1, [0.1], 0.25), 'Off-peak');
  assert.equal(rateTierFor(0.4, [0.4], 0.25), 'Peak');
  assert.equal(rateTierFor(0.25, [0.25], 0.25), 'Same price');
  // Invalid prices are never labelled.
  assert.equal(rateTierFor('', [0.1], 0.25), '');
  assert.equal(rateTierFor(9, [9, 0.1, 0.2], 0.3), '');
  assert.equal(rateTierFor(0.2, [9, 0.1, 0.2], 0.3), 'Peak');
  assert.equal(
    windowLabel(winterPeak, [0.1, 0.32], 0.31),
    'Peak 0.32 · Weekdays · 16:00–19:00 · Nov–Feb',
  );
});

test('a typical week is a complete 24 h partition grouped into day types', () => {
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak)];
  const week = rateWeek(rows, 0.31, 1, 2026);
  assert.equal(week.length, 7);
  // Thursday is a winter weekday: night, fallback, peak, fallback.
  assert.deepEqual(
    week[3].segments.map((segment) => [
      minutesToClock(segment.from),
      minutesToClock(segment.to),
      segment.rate,
    ]),
    [
      ['00:00', '06:00', 0.1],
      ['06:00', '16:00', 0.31],
      ['16:00', '19:00', 0.32],
      ['19:00', '22:00', 0.31],
      ['22:00', '24:00', 0.1],
    ],
  );
  // Saturday has no peak window; the night is the same wrapped row.
  assert.deepEqual(
    week[5].segments.map((segment) => [
      minutesToClock(segment.from),
      minutesToClock(segment.to),
      segment.rate,
    ]),
    [
      ['00:00', '06:00', 0.1],
      ['06:00', '22:00', 0.31],
      ['22:00', '24:00', 0.1],
    ],
  );
  assert.equal(segmentNote(week[3].segments[0]), 'from 22:00 the day before');
  assert.equal(segmentNote(week[3].segments[4]), 'continues to 06:00 the next day');
  assert.equal(segmentNote(week[3].segments[1]), '');
  assert.equal(rateSegmentLabel(week[3].segments[0], [0.1, 0.32], 0.31), 'Off-peak');
  assert.equal(rateSegmentLabel(week[3].segments[1], [0.1, 0.32], 0.31), 'Other times');

  const types = dayTypesForWeek(week);
  assert.deepEqual(
    types.map((type) => [type.label, type.days]),
    [
      ['Weekdays', [0, 1, 2, 3, 4]],
      ['Weekends', [5, 6]],
    ],
  );

  // A summer-only row must not appear in January, and an all-day window covers
  // midnight to midnight as one segment.
  const summer = rateWeek([rateRowFields(summerFlat)], 0.31, 1, 2026);
  assert.deepEqual(
    summer[0].segments.map((segment) => [segment.from, segment.to]),
    [[0, 1440]],
  );
  assert.equal(dayTypesForWeek(summer).length, 1);
});

test('coverage uses a month the period sets on its own', () => {
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak)];
  const periods = ratePeriods(rows);
  const allYear = periods.find((period) => period.kind === 'all');
  const winter = periods.find((period) => period.title === 'Winter');

  const winterCoverage = periodCoverage(rows, 0.31, winter, periods, 2026);
  assert.equal(winterCoverage.month, 1);
  assert.equal(winterCoverage.monthText, 'Nov–Feb');
  assert.equal(winterCoverage.partial, false);
  assert.equal(winterCoverage.types.length, 2);

  // The all-year period's own months are all twelve, but Nov–Feb belong to the
  // winter period: its representative week is March, where only the night row
  // applies and the winter peak must not leak in.
  const allCoverage = periodCoverage(rows, 0.31, allYear, periods, 2026);
  assert.equal(allCoverage.month, 3);
  assert.equal(allCoverage.monthText, 'Mar–Oct');
  assert.equal(allCoverage.partial, true);
  assert.deepEqual(
    allCoverage.types[0].segments.map((segment) => segment.rate),
    [0.1, 0.31, 0.1],
  );
});

test('the exact-date checker names the winning window, fallback and boundaries', () => {
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak)];
  const at = (year, month, day, hours, minutes = 0) =>
    previewRate(rows, '0.31', new Date(year, month - 1, day, hours, minutes));

  const peak = at(2026, 1, 15, 17, 0);
  assert.equal(peak.rate, 0.32);
  assert.equal(peak.window.id, 'winter-peak');
  assert.equal(peak.tier, 'Peak');
  assert.equal(peak.fallback, false);
  assert.match(peak.summary, /Weekdays · 16:00–19:00/);
  assert.equal(peak.monthsText, 'Nov–Feb');

  assert.equal(at(2026, 1, 15, 12, 0).fallback, true);
  assert.equal(at(2026, 1, 15, 12, 0).rate, 0.31);
  assert.equal(at(2026, 1, 15, 18, 59).rate, 0.32);
  assert.equal(at(2026, 1, 15, 19, 0).fallback, true);
  // Month boundaries: 31 Dec is winter, 1 Mar is not.
  assert.equal(at(2026, 12, 31, 17, 0).rate, 0.32);
  assert.equal(at(2027, 3, 1, 17, 0).fallback, true);
  // Midnight wrap: 23:00 is the main part, 05:00 the tail of the previous day.
  assert.equal(at(2026, 6, 15, 23, 0).rate, 0.1);
  assert.equal(at(2026, 6, 16, 5, 0).rate, 0.1);
  assert.equal(at(2026, 6, 16, 6, 0).fallback, true);

  // A December-only wrap covers 1 January's early hours and nothing later.
  const decemberWrap = [rateRowFields({ ...nightEveryDay, id: 'dec', months: [12] })];
  assert.equal(previewRate(decemberWrap, 0.31, new Date(2027, 0, 1, 5, 0)).rate, 0.1);
  assert.equal(previewRate(decemberWrap, 0.31, new Date(2027, 0, 2, 5, 0)).fallback, true);

  // Incomplete rows are not invented into the preview; the fallback answers.
  const incomplete = previewRate(
    [{ ...rateRowFields(winterPeak), rate: '' }],
    0.31,
    new Date(2026, 0, 15, 17, 0),
  );
  assert.equal(incomplete.fallback, true);
  assert.equal(incomplete.rate, 0.31);
  assert.equal(previewRate(rows, '', new Date(2026, 0, 15, 12, 0)).rate, null);
});

test('the checker fields parse local dates by parts and format for people', () => {
  const date = parseLocalDateTime('2026-12-15', '18:30');
  assert.ok(date instanceof Date);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 11);
  assert.equal(date.getDate(), 15);
  assert.equal(date.getHours(), 18);
  assert.equal(date.getMinutes(), 30);
  assert.equal(parseLocalDateTime('2026-02-30', '10:00'), null);
  assert.equal(parseLocalDateTime('2026-13-01', '10:00'), null);
  assert.equal(parseLocalDateTime('15/12/2026', '10:00'), null);
  assert.equal(parseLocalDateTime('2026-12-15', '24:00'), null);
  assert.equal(parseLocalDateTime('', ''), null);
  assert.equal(dateInputValue(date), '2026-12-15');
  assert.equal(timeInputValue(date), '18:30');
  assert.equal(formatPreviewWhen(date, new Date(2026, 0, 1)), 'Tue 15 Dec, 18:30');
  assert.equal(formatPreviewWhen(date, new Date(2027, 0, 1)), 'Tue 15 Dec 2026, 18:30');
  assert.equal(minutesToClock(0), '00:00');
  assert.equal(minutesToClock(1440), '24:00');
  assert.equal(minutesToClock(425), '07:05');
  assert.equal(minutesToClock(-1), '');
});

test('months no window covers are shown as an other-months period', () => {
  const rows = [rateRowFields(winterPeak)];
  const periods = ratePeriods(rows);
  assert.deepEqual(
    periods.map((period) => [period.key, period.title, period.monthText, period.rows.length]),
    [
      ['months:1,2,11,12', 'Winter', 'Nov–Feb', 1],
      ['rest', 'Other months', 'Mar–Oct', 0],
    ],
  );
  const rest = periods[1];
  assert.equal(rest.rateRange, null);
  // The rest is the fallback made literal: one all-day segment, no window.
  const coverage = periodCoverage(rows, 0.31, rest, periods, 2026);
  assert.equal(coverage.monthText, 'Mar–Oct');
  assert.equal(coverage.types.length, 1);
  assert.deepEqual(
    coverage.types[0].segments.map((segment) => [
      segment.from,
      segment.to,
      segment.rate,
      segment.window,
    ]),
    [[0, 1440, 0.31, null]],
  );
  // A plan whose months are all covered has no rest period.
  assert.equal(
    ratePeriods([rateRowFields(nightEveryDay)]).some((period) => period.kind === 'rest'),
    false,
  );
});

test('the longest uncovered run seeds a new season, and the plan range ignores bad prices', () => {
  assert.deepEqual(largestMonthRun([3, 4, 5, 6, 7, 8, 9, 10]), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(largestMonthRun([1, 2, 11, 12]), [11, 12, 1, 2]);
  assert.deepEqual(largestMonthRun([1, 6, 7, 8]), [6, 7, 8]);
  assert.deepEqual(largestMonthRun([]), []);
  assert.deepEqual(ratePlanRange([{ rate: '0.1' }, { rate: 9 }, { rate: '' }, { rate: 0.32 }]), {
    min: 0.1,
    max: 0.32,
  });
  assert.equal(ratePlanRange([]), null);
});
