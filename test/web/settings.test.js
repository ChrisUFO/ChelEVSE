import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_PRESETS,
  BLOCKED_SAVE_MESSAGE,
  OFFLINE_MESSAGE,
  RATE_CAP_MESSAGE,
  RATE_CAP_REMEDY,
  SAVE_FAILED_FIRST_MESSAGE,
  SAVE_FAILED_MESSAGE,
  WAITING_MESSAGE,
  CHECK_BLOCKED_MESSAGE,
  CHECK_CAP_MESSAGE,
  CHECK_CONFLICT_MESSAGE,
  applyPeriodDates,
  applyPeriodMonths,
  canDuplicatePeriod,
  complementMonths,
  complementScope,
  copyPeriodRows,
  dateInputValue,
  dateRangeText,
  dateSetText,
  dayPresetFor,
  dayTypeLabel,
  dayTypesForWeek,
  daysForPreset,
  defaultRateRow,
  formatPreviewWhen,
  isAllDayWindow,
  isSeasonRatePeriod,
  isSeasonRateRow,
  mergeDateRanges,
  minutesToClock,
  normalizeSettings,
  parseLocalDateTime,
  periodCoverage,
  periodEffectiveRange,
  previewBlocker,
  planProblemText,
  previewRate,
  largestMonthRun,
  rateMonthsText,
  rateMonthScope,
  ratePlanRange,
  rateOverlapMessage,
  ratePeriodTitle,
  ratePeriods,
  rateRowFields,
  rateScope,
  rateSegmentLabel,
  rateTierFor,
  rateWeek,
  rateWindowSummary,
  representativeDates,
  representativeMonth,
  reconcileSettingsSave,
  sameSettingsInput,
  saveButtonState,
  segmentNote,
  settingsDraftMatches,
  settingsFields,
  settingsPayload,
  settingsSaveState,
  siblingNote,
  submitFocusTarget,
  submitSettingsPlan,
  timeFieldsVisible,
  timeInputValue,
  toggledMonthScope,
  uncoveredDateRanges,
  uncoveredMonths,
  validateRateEditorRows,
  validateSettings,
  validationProblemCount,
  windowLabel,
} from '../../web/js/settings.js';
import { applySubmitFocus } from '../../web/js/screens/settings.js';
import { normalizeRateSchedule, rateWindowsKey, validateRateWindows } from '../../web/js/rates.js';

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
  assert.deepEqual(scheduled.values.rates, [{ ...night, from: null, to: null }]);

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
  const normalized = { ...night, from: null, to: null };
  assert.deepEqual(normalizeSettings(stored), { ...stored, rates: [normalized] });
  assert.deepEqual(settingsFields(stored).rates, [normalized]);
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
  assert.deepEqual(rateRowFields(night), { ...night, rate: '0.12', from: null, to: null });
  assert.deepEqual(
    rateRowFields({
      id: 'broken',
      rate: 'abc',
      days: 'Mon',
      start: 25,
      end: null,
      months: 3,
    }),
    { id: 'broken', rate: '', days: [], start: '', end: '', months: 3, from: null, to: null },
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
    from: null,
    to: null,
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
    capped: false,
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
  assert.deepEqual(values.rates, [{ ...night, from: null, to: null }]);
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

test('the payload preserves the draft row order, grouped or not', () => {
  // Row order is the last-match tie-break for legacy/overlapping documents, so
  // the editor must never reorder the stored list while it groups it.
  const rows = [rateRowFields(summerFlat), rateRowFields(nightEveryDay), rateRowFields(winterPeak)];
  const ids = (list) =>
    settingsPayload({ rate: 0.31, currency: 'USD', rates: list }).rates.map((row) => row.id);
  assert.deepEqual(ids([rows[2], rows[0]]), ['winter-peak', 'summer']);

  // Grouping by month scope is presentation only: a month edit keeps every
  // untouched row in place (and by identity) and the payload order with it.
  const periods = ratePeriods(rows);
  const summer = periods.find((period) => period.title === 'Summer');
  const edited = applyPeriodMonths(
    rows,
    summer.rows.map((entry) => entry.index),
    [3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(ids(edited), ['summer', 'night', 'winter-peak']);

  // A duplicated season appends its rows after the existing plan.
  const copied = copyPeriodRows(
    edited,
    [2],
    complementMonths(winterPeak.months),
    (() => {
      let next = 0;
      return () => `copy-${(next += 1)}`;
    })(),
  );
  assert.deepEqual(ids(copied), ['summer', 'night', 'winter-peak', 'copy-1']);

  // A non-contiguous stored list keeps its own month order and its position.
  const loose = rateRowFields({ ...nightEveryDay, id: 'loose', months: [6, 1] });
  assert.deepEqual(
    settingsPayload({ rate: 0.31, currency: 'USD', rates: [loose, rows[0]] }).rates.map((row) => [
      row.id,
      row.months,
    ]),
    [
      ['loose', [6, 1]],
      ['summer', [3, 4, 5, 6, 7, 8, 9, 10]],
    ],
  );
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
  assert.deepEqual(settled.confirmed.rates, [{ ...night, from: null, to: null }]);
  assert.deepEqual(settled.fields.rates, [{ ...night, from: null, to: null }]);
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
  // There is no synthetic season for the months a window does not cover; the
  // uncovered remainder is a non-season line elsewhere.
  assert.equal(
    periods.some((period) => period.kind === 'rest'),
    false,
  );

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

test('a month chip toggles the pressed state it announces, in both directions', () => {
  // On an all-year scope every chip is pressed; a click removes that month and
  // leaves the other eleven instead of discarding them.
  const eleven = toggledMonthScope({ kind: 'all', months: null }, 7);
  assert.deepEqual(eleven, [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
  assert.equal(rateMonthScope({ months: eleven }).kind, 'months');
  // Re-adding the last missing month is the inverse: back to All year.
  const twelve = toggledMonthScope({ kind: 'months', months: eleven }, 7);
  assert.deepEqual(twelve, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(rateMonthScope({ months: twelve }).kind, 'all');
  // A custom scope adds a missing month and removes a pressed one.
  assert.deepEqual(toggledMonthScope({ kind: 'months', months: [1, 6] }, 3), [1, 3, 6]);
  assert.deepEqual(toggledMonthScope({ kind: 'months', months: [1, 6] }, 1), [6]);
  // The final month is kept: an empty scope is not a useful edit.
  assert.equal(toggledMonthScope({ kind: 'months', months: [3] }, 3), null);
  // A malformed scope starts from the clicked month; a non-month changes nothing.
  assert.deepEqual(toggledMonthScope({ kind: 'invalid', months: null }, 4), [4]);
  assert.equal(toggledMonthScope({ kind: 'months', months: [1] }, 13), null);
  assert.equal(toggledMonthScope(null, 1), null);
});

test('duplicating a season respects the 24-window cap', () => {
  assert.equal(canDuplicatePeriod(0, 2), true);
  assert.equal(canDuplicatePeriod(22, 2), true);
  assert.equal(canDuplicatePeriod(23, 2), false);
  assert.equal(canDuplicatePeriod(24, 1), false);
  // A period with no windows has nothing to copy.
  assert.equal(canDuplicatePeriod(3, 0), false);

  // A plan the editor refuses to grow past the cap reports the cap, and the
  // checker names the cap rather than pretending there is an overlap.
  const rows = Array.from({ length: 25 }, (_, index) =>
    rateRowFields({ ...nightEveryDay, id: `w${index}` }),
  );
  const validation = validateRateEditorRows(rows);
  assert.equal(validation.capped, true);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.general, [RATE_CAP_MESSAGE, RATE_CAP_REMEDY]);
  assert.equal(previewBlocker(validation), CHECK_CAP_MESSAGE);
  assert.equal(RATE_CAP_MESSAGE, 'A rate schedule can hold at most 24 windows.');
  assert.equal(RATE_CAP_REMEDY, 'Remove a window to get back to 24.');
});

test('an over-cap stored document reports the cap only, not an overlap remedy', () => {
  // A hand-edited 25-window document whose extra window also collides: the
  // overlap remedy ("change one of them") would leave the plan over the cap, so
  // the document message is the cap and its own remedy.
  const extra = rateRowFields({ ...nightEveryDay, id: 'extra' });
  const rows = [
    ...Array.from({ length: 24 }, (_, index) =>
      rateRowFields({ ...nightEveryDay, id: `w${index}`, start: '22:00', end: '06:00' }),
    ),
    extra,
  ];
  const validation = validateRateEditorRows(rows);
  assert.equal(validation.capped, true);
  assert.deepEqual(validation.general, [RATE_CAP_MESSAGE, RATE_CAP_REMEDY]);
  assert.ok(validation.overlaps.length > 0);
  // The colliding rows keep their own notes, so nothing is hidden.
  assert.ok(validation.rows.every((errors) => errors && Object.keys(errors).length === 0));
  assert.equal(validation.valid, false);

  // Under the cap the overlap clause is the whole document message.
  const under = validateRateEditorRows([
    rateRowFields(nightEveryDay),
    rateRowFields({ ...nightEveryDay, id: 'copy' }),
  ]);
  assert.equal(under.capped, false);
  assert.equal(under.general.length, 1);
  assert.match(under.general[0], /no moment has two rates/);
});

test('an all-day row keeps its time fields while focus moves inside it', () => {
  // Closed until asked for.
  assert.equal(timeFieldsVisible({ allDay: true, timesOpen: false, focusWithin: false }), false);
  // "Set times" opened them.
  assert.equal(timeFieldsVisible({ allDay: true, timesOpen: true, focusWithin: false }), true);
  // Start blurred but End now has focus: the row must still be open.
  assert.equal(timeFieldsVisible({ allDay: true, timesOpen: false, focusWithin: true }), true);
  // A real start/end pair is always shown, whatever the flags say.
  assert.equal(timeFieldsVisible({ allDay: false, timesOpen: false, focusWithin: false }), true);
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

test('coverage is the effective week for a month, with owners and named siblings', () => {
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak), rateRowFields(summerFlat)];
  const periods = ratePeriods(rows);
  const allYear = periods.find((period) => period.kind === 'all');
  const winter = periods.find((period) => period.title === 'Winter');
  const summer = periods.find((period) => period.title === 'Summer');

  // Both periods use January for a January-inclusive scope, so the header and
  // the table caption cannot describe different months.
  assert.equal(representativeMonth(allYear), 1);
  assert.equal(representativeMonth(winter), 1);
  assert.equal(representativeMonth(summer), 3);

  const allCoverage = periodCoverage(rows, 0.31, allYear, periods, 2026);
  assert.equal(allCoverage.month, 1);
  assert.equal(allCoverage.monthName, 'January');
  // The week is the effective January: the all-year night, the fallback and
  // the Winter peak. The own ids let the view style the all-year rows and name
  // the Winter row as a sibling rather than mislabelling it as the fallback.
  const allWeekday = allCoverage.types.find((type) => type.label === 'Weekdays');
  assert.deepEqual(
    allWeekday.segments.map((segment) => segment.rate),
    [0.1, 0.31, 0.32, 0.31, 0.1],
  );
  assert.equal(allCoverage.ownIds.has('night'), true);
  assert.equal(allCoverage.ownIds.has('winter-peak'), false);
  assert.deepEqual(
    allCoverage.siblings.map((period) => period.title),
    ['Winter'],
  );
  assert.equal(siblingNote(allCoverage.siblings[0]), 'Winter also applies in Nov–Feb.');

  const winterCoverage = periodCoverage(rows, 0.31, winter, periods, 2026);
  assert.equal(winterCoverage.month, 1);
  assert.equal(winterCoverage.monthName, 'January');
  // The Winter week is the same effective January; its own id is the peak, and
  // the all-year night rows are attributed to the sibling.
  const winterWeekday = winterCoverage.types.find((type) => type.label === 'Weekdays');
  assert.deepEqual(
    winterWeekday.segments.map((segment) => segment.rate),
    [0.1, 0.31, 0.32, 0.31, 0.1],
  );
  assert.equal(winterCoverage.ownIds.has('winter-peak'), true);
  assert.equal(winterCoverage.ownIds.has('night'), false);
  assert.deepEqual(
    winterCoverage.siblings.map((period) => period.title),
    ['All year'],
  );
  assert.equal(siblingNote(winterCoverage.siblings[0]), 'All year windows also apply here.');
  assert.equal(
    siblingNote({ kind: 'months', title: 'Custom months', monthText: 'Jan, Jun' }),
    'Jan, Jun windows also apply here.',
  );

  const summerCoverage = periodCoverage(rows, 0.31, summer, periods, 2026);
  assert.equal(summerCoverage.month, 3);
  assert.equal(summerCoverage.monthName, 'March');
  assert.deepEqual(
    summerCoverage.types.map((type) => type.segments.map((segment) => segment.rate)),
    [[0.2]],
  );
  assert.deepEqual(
    summerCoverage.siblings.map((period) => period.title),
    ['All year'],
  );
});

test('the header range is effective for the representative month, not just the own rows', () => {
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak), rateRowFields(summerFlat)];
  const periods = ratePeriods(rows);
  const allYear = periods.find((period) => period.kind === 'all');
  const winter = periods.find((period) => period.title === 'Winter');
  const summer = periods.find((period) => period.title === 'Summer');

  // Overnight .10 (own) + winter peak .32 (sibling) + fallback .31.
  assert.deepEqual(periodEffectiveRange(rows, 0.31, allYear), { min: 0.1, max: 0.32, month: 1 });
  assert.deepEqual(periodEffectiveRange(rows, 0.31, winter), { min: 0.1, max: 0.32, month: 1 });
  // The summer all-day .20 wins the whole of March; the fallback never applies,
  // so it must not widen the effective range.
  assert.deepEqual(periodEffectiveRange(rows, 0.31, summer), { min: 0.2, max: 0.2, month: 3 });

  // A malformed row never widens an "effective" range.
  const broken = [rateRowFields(nightEveryDay), rateRowFields({ ...winterPeak, rate: 9 })];
  assert.deepEqual(periodEffectiveRange(broken, 0.31, ratePeriods(broken)[0]), {
    min: 0.1,
    max: 0.31,
    month: 1,
  });
  // A missing fallback leaves only the usable window rates.
  assert.deepEqual(
    periodEffectiveRange(
      [rateRowFields(nightEveryDay)],
      '',
      ratePeriods([rateRowFields(nightEveryDay)])[0],
    ),
    {
      min: 0.1,
      max: 0.1,
      month: 1,
    },
  );
});

test('uncovered months are a fallback line, not a season', () => {
  const winterOnly = [rateRowFields(winterPeak)];
  const periods = ratePeriods(winterOnly);
  assert.deepEqual(
    periods.map((period) => [period.title, period.monthText, period.rows.length]),
    [['Winter', 'Nov–Feb', 1]],
  );
  assert.deepEqual(uncoveredMonths(winterOnly), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(rateMonthsText(uncoveredMonths(winterOnly)), 'Mar–Oct');

  // An all-year row covers everything: no fallback line.
  assert.deepEqual(uncoveredMonths([rateRowFields(nightEveryDay)]), []);
  // Non-contiguous scopes leave the other months uncovered.
  assert.deepEqual(uncoveredMonths([rateRowFields(nightEveryDay), rateRowFields(winterPeak)]), []);
  const loose = [
    rateRowFields({ ...nightEveryDay, months: [1, 6] }),
    rateRowFields({ ...winterPeak, months: [11, 12] }),
  ];
  assert.deepEqual(uncoveredMonths(loose), [2, 3, 4, 5, 7, 8, 9, 10]);
  assert.equal(rateMonthsText(uncoveredMonths(loose)), 'Feb–May, Jul–Oct');
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

test('the save row and plan summary count affected rows, not collisions', () => {
  assert.equal(validationProblemCount(validateRateEditorRows([]), 0), 0);
  const oneBad = validateRateEditorRows([{ ...rateRowFields(nightEveryDay), rate: '' }]);
  assert.equal(validationProblemCount(oneBad, 1), 1);
  const overlap = validateRateEditorRows([
    rateRowFields(nightEveryDay),
    rateRowFields({ ...nightEveryDay, id: 'copy' }),
  ]);
  assert.equal(overlap.valid, false);
  assert.equal(validationProblemCount(overlap, 2), 2);
  // The cap counts once when it is the only blocker: no period badge exists to
  // carry it, so the plan row owns the one problem.
  const capped = {
    valid: false,
    rows: Array.from({ length: 25 }, () => ({})),
    overlaps: [],
    general: ['cap'],
  };
  assert.equal(validationProblemCount(capped, 25), 1);
  // With rows already flagged, the cap is not counted again: those same edits
  // bring the plan back under 24, and a second number would disagree with the
  // period badges.
  assert.equal(validationProblemCount({ ...capped, overlaps: [[0, 1]] }, 25), 2);
});

test('the plan row labels the cap instead of adding an unexplained number', () => {
  assert.equal(planProblemText({ problems: 0 }), '');
  assert.equal(planProblemText({ problems: 2 }), '2 to fix');
  assert.equal(planProblemText({ problems: 1, capped: true }), '1 to fix · cap');
  assert.equal(planProblemText({ problems: 2, capped: true }), '2 to fix · cap');
});

test('Save stays submit-capable while a plan is blocked', () => {
  // Clean and dirty: the normal solid Save.
  assert.deepEqual(saveButtonState({ canSave: true }), {
    disabled: false,
    blocked: false,
    label: 'Save settings',
    describedBy: '',
  });
  // Blocked but dirty: relabelled and marked blocked, still submit-capable so
  // Enter in a field reaches submit() and the focus-the-first-problem path.
  assert.deepEqual(saveButtonState({ canSave: true, problems: 2 }), {
    disabled: false,
    blocked: true,
    label: 'Fix 2 to save',
    describedBy: 'save-blockers',
  });
  // Nothing to save: genuinely disabled, as before.
  assert.equal(saveButtonState({ canSave: false }).disabled, true);
  // A save in flight wins the label and disables the button.
  const saving = saveButtonState({ canSave: false, saving: true, problems: 0 });
  assert.equal(saving.disabled, true);
  assert.equal(saving.label, 'Saving…');
  assert.equal(saving.blocked, false);
});

// Stand-ins for the rendered window cards the focus adapter touches. The screen's
// cards carry the same fields, so the adapter is exercised as the production
// path rather than through a parallel fake.
function cardStub() {
  const calls = [];
  const focus = (name) => () => calls.push(name);
  return {
    calls,
    node: { scrollIntoView: () => calls.push('reveal-row') },
    periodCard: {
      allYear: { focus: focus('months') },
      node: { scrollIntoView: () => calls.push('reveal-period') },
    },
    rateInput: { focus: focus('rate') },
    startInput: { focus: focus('start') },
    endInput: { focus: focus('end') },
    daysEl: {
      querySelector: (selector) =>
        selector === '[aria-pressed="true"]' ? { focus: focus('days') } : null,
    },
    presetEls: [{ focus: focus('preset') }],
  };
}

function viewStub(cards) {
  const calls = [];
  return {
    calls,
    card: (index) => cards[index],
    firstCard: () => cards.find(Boolean),
    expand: () => calls.push('expand'),
    reveal: (node) => node.scrollIntoView(),
    focusField: (field) => calls.push(`field:${field}`),
    revealDocumentError: () => calls.push('doc-error'),
  };
}

const blockedFields = (rates) => ({ rate: '0.31', currency: 'USD', rates });

test('a blocked submit writes nothing and moves focus to the first bad row', () => {
  const fields = blockedFields([
    rateRowFields(nightEveryDay),
    rateRowFields({ ...nightEveryDay, id: 'empty', rate: '' }),
  ]);
  const commits = [];
  const attempt = submitSettingsPlan({ fields, onCommit: (values) => commits.push(values) });

  // The Enter/submit path stops here: the screen's only route to persistence is
  // `onCommit`, which a blocked plan never reaches.
  assert.equal(attempt.blocked, true);
  assert.equal(attempt.message, BLOCKED_SAVE_MESSAGE);
  assert.deepEqual(commits, []);
  assert.deepEqual(attempt.target, { kind: 'row', index: 1, focus: 'rate' });

  const cards = [cardStub(), cardStub()];
  const view = viewStub(cards);
  applySubmitFocus(attempt.target, view);
  assert.deepEqual(view.calls, ['expand']);
  assert.deepEqual(cards[1].calls, ['rate', 'reveal-row']);
  assert.deepEqual(cards[0].calls, [], 'the first clean row is not touched');
});

test('a blocked submit lands on the first row an overlap names', () => {
  const fields = blockedFields([
    rateRowFields(nightEveryDay),
    rateRowFields(winterPeak),
    rateRowFields({ ...winterPeak, id: 'winter-copy' }),
  ]);
  const commits = [];
  const attempt = submitSettingsPlan({ fields, onCommit: (values) => commits.push(values) });

  assert.equal(attempt.blocked, true);
  assert.deepEqual(commits, []);
  assert.deepEqual(attempt.rateValidation.overlaps, [[1, 2]]);
  assert.deepEqual(attempt.target, { kind: 'row', index: 1, focus: 'rate' });

  const cards = [cardStub(), cardStub(), cardStub()];
  const view = viewStub(cards);
  applySubmitFocus(attempt.target, view);
  assert.deepEqual(cards[1].calls, ['rate', 'reveal-row']);
  assert.deepEqual(cards[0].calls, []);
  assert.deepEqual(cards[2].calls, []);
});

test('a field error outranks a row error and focuses its own input', () => {
  const fields = { ...blockedFields([rateRowFields({ ...nightEveryDay, rate: '' })]), rate: '' };
  const commits = [];
  const attempt = submitSettingsPlan({ fields, onCommit: (values) => commits.push(values) });

  assert.equal(attempt.blocked, true);
  assert.deepEqual(commits, []);
  assert.deepEqual(attempt.target, { kind: 'field', field: 'rate' });

  const view = viewStub([]);
  applySubmitFocus(attempt.target, view);
  assert.deepEqual(view.calls, ['field:rate']);
});

test('a saveable plan commits once and focuses nothing', () => {
  const fields = blockedFields([rateRowFields(nightEveryDay)]);
  const commits = [];
  const attempt = submitSettingsPlan({ fields, onCommit: (values) => commits.push(values) });

  assert.equal(attempt.blocked, false);
  assert.equal(attempt.message, '');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].rates.length, 1);

  const view = viewStub([]);
  applySubmitFocus(attempt.target, view);
  assert.deepEqual(view.calls, []);
});

test('a document blocker with no accused row falls back to the table sentence', () => {
  const view = viewStub([]);
  applySubmitFocus({ kind: 'doc' }, view);
  assert.deepEqual(view.calls, ['doc-error']);
  // With a card to land in, the first row is the target instead.
  const cards = [cardStub()];
  const withCard = viewStub(cards);
  applySubmitFocus({ kind: 'doc' }, withCard);
  assert.deepEqual(withCard.calls, ['expand']);
  assert.deepEqual(cards[0].calls, ['rate', 'reveal-row']);
});

test('a month problem focuses the season control, not a window field', () => {
  const fields = blockedFields([{ ...rateRowFields(nightEveryDay), months: 3 }]);
  const attempt = submitSettingsPlan({
    fields,
    onCommit: () => assert.fail('wrote a blocked plan'),
  });
  assert.deepEqual(attempt.target, { kind: 'row', index: 0, focus: 'months' });

  const cards = [cardStub()];
  const view = viewStub(cards);
  applySubmitFocus(attempt.target, view);
  assert.deepEqual(view.calls, ['expand']);
  assert.deepEqual(cards[0].calls, ['reveal-period', 'months']);
});

test('the checker withholds a definitive answer while the plan is incomplete', () => {
  assert.equal(previewBlocker(validateRateEditorRows([])), '');
  const bad = validateRateEditorRows([{ ...rateRowFields(nightEveryDay), rate: '' }]);
  assert.equal(previewBlocker(bad), CHECK_BLOCKED_MESSAGE);
  assert.equal(CHECK_BLOCKED_MESSAGE, 'Fix the incomplete windows to check this moment.');
  const overlap = validateRateEditorRows([
    rateRowFields(nightEveryDay),
    rateRowFields({ ...nightEveryDay, id: 'copy' }),
  ]);
  assert.equal(previewBlocker(overlap), CHECK_CONFLICT_MESSAGE);
});

test('an all-day window is recognised from its stored start and end', () => {
  assert.equal(isAllDayWindow({ start: '00:00', end: '00:00' }), true);
  assert.equal(isAllDayWindow({ start: '07:30', end: '07:30' }), true);
  assert.equal(isAllDayWindow({ start: '00:00', end: '07:00' }), false);
  assert.equal(isAllDayWindow({ start: '', end: '' }), false);
  assert.equal(isAllDayWindow({ start: '25:00', end: '25:00' }), false);
  assert.equal(isAllDayWindow(null), false);
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

// ---------- date-precision seasons ----------

const summerDates = {
  id: 'summer-dates',
  rate: 0.2,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '00:00',
  end: '00:00',
  months: [6, 7, 8, 9],
  from: '06-15',
  to: '09-15',
};
const winterDates = {
  id: 'winter-dates',
  rate: 0.32,
  days: [0, 1, 2, 3, 4],
  start: '16:00',
  end: '19:00',
  months: [9, 10, 11, 12, 1, 2, 3, 4, 5, 6],
  from: '09-16',
  to: '06-14',
};

test('a stored season resolves to a date scope that outranks its months hint', () => {
  assert.deepEqual(rateScope({ months: null }), { kind: 'all', months: null });
  assert.deepEqual(rateScope({ months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }), {
    kind: 'all',
    months: null,
  });
  assert.deepEqual(rateScope({ months: [11, 12, 1, 2] }), {
    kind: 'months',
    months: [1, 2, 11, 12],
  });
  // Blank bounds are absent, so the months stay authoritative.
  assert.deepEqual(rateScope({ months: [6], from: '', to: '' }), {
    kind: 'months',
    months: [6],
  });
  // The dates win, and the months become the derived hint.
  assert.deepEqual(rateScope({ months: 3, from: '06-15', to: '09-15' }), {
    kind: 'dates',
    from: '06-15',
    to: '09-15',
    fromKey: 615,
    toKey: 915,
    months: [6, 7, 8, 9],
  });
  assert.deepEqual(rateScope({ months: null, from: '02-29', to: '02-29' }).months, [2]);
  // A half-written or unreal pair is unusable, never a silent fallback.
  assert.deepEqual(rateScope({ months: [6], from: '06-15' }), { kind: 'invalid', months: [] });
  assert.deepEqual(rateScope({ months: [6], from: '02-30', to: '03-01' }), {
    kind: 'invalid',
    months: [],
  });
});

test('date seasons group by their dates, not by a stale months hint', () => {
  const stale = { ...summerDates, id: 'stale', months: [1, 2] };
  const periods = ratePeriods([
    rateRowFields(summerDates),
    rateRowFields(stale),
    rateRowFields(winterDates),
  ]);
  assert.deepEqual(
    periods.map((period) => [
      period.key,
      period.kind,
      period.title,
      period.dateText,
      period.monthText,
      period.seasonRate,
      period.rows.map((entry) => entry.index),
    ]),
    [
      ['dates:06-15-09-15', 'dates', 'Season rate', 'Jun 15–Sep 15', 'Jun 15–Sep 15', true, [0, 1]],
      ['dates:09-16-06-14', 'dates', 'Season', 'Sep 16–Jun 14', 'Sep 16–Jun 14', false, [2]],
    ],
  );
  // The derived months stay available for the old month controls.
  assert.deepEqual(periods[0].months, [6, 7, 8, 9]);

  // Identical dates with different hints merge; the same hint with different
  // dates does not.
  const sameHint = ratePeriods([
    rateRowFields(summerDates),
    rateRowFields({ ...winterDates, from: '06-01', to: '06-30', months: [6, 7, 8, 9] }),
  ]);
  assert.equal(sameHint.length, 2);
  // Stale hints are not reported as a month error: the dates are authoritative.
  assert.equal(validateRateEditorRows([rateRowFields(stale)]).valid, true);
});

test('month and date edits convert explicitly, and a month edit clears dates', () => {
  const rows = [rateRowFields(summerDates), rateRowFields(winterDates)];
  const dated = applyPeriodDates(rows, [1], '10-15', '04-15');
  assert.equal(dated[0], rows[0]);
  assert.equal(dated[1].from, '10-15');
  assert.equal(dated[1].to, '04-15');
  assert.deepEqual(dated[1].months, [10, 11, 12, 1, 2, 3, 4]);

  // An invalid value stays visible and blocks a save instead of being repaired.
  const broken = applyPeriodDates(rows, [0], '02-30', '03-01');
  assert.equal(broken[0].from, '02-30');
  assert.deepEqual(broken[0].months, summerDates.months);
  const invalid = validateRateEditorRows(broken);
  assert.ok(invalid.rows[0].from);
  assert.equal(invalid.valid, false);

  // Switching back to months drops the bounds, so the chosen months are what
  // matching will use.
  const monthly = applyPeriodMonths(rows, [0], [11, 12]);
  assert.equal(monthly[0].from, null);
  assert.equal(monthly[0].to, null);
  assert.deepEqual(monthly[0].months, [11, 12]);
  assert.equal(monthly[1], rows[1]);
});

test('a date row saves its derived months and appends from/to after them', () => {
  const draft = rateRowFields({ ...summerDates, months: [1, 2] });
  const payload = settingsPayload({ rate: 0.31, currency: 'USD', rates: [draft] });
  const [row] = payload.rates;
  assert.deepEqual(Object.keys(row), [
    'id',
    'rate',
    'days',
    'start',
    'end',
    'months',
    'from',
    'to',
  ]);
  assert.deepEqual(row.months, [6, 7, 8, 9]);
  assert.equal(row.from, '06-15');
  assert.equal(row.to, '09-15');

  // A month row keeps the old key order and carries no date keys at all.
  const monthRow = settingsPayload({
    rate: 0.31,
    currency: 'USD',
    rates: [rateRowFields(nightEveryDay)],
  }).rates[0];
  assert.deepEqual(Object.keys(monthRow), ['id', 'rate', 'days', 'start', 'end', 'months']);
  assert.equal('from' in monthRow, false);
  assert.equal('to' in monthRow, false);

  // A flat save is still exactly two fields.
  assert.deepEqual(settingsPayload({ rate: 0.31, currency: 'USD', rates: [] }), {
    rate: 0.31,
    currency: 'USD',
  });
  // Row order survives grouping, date rows included.
  const ordered = settingsPayload({
    rate: 0.31,
    currency: 'USD',
    rates: [rateRowFields(winterDates), rateRowFields(summerDates)],
  });
  assert.deepEqual(
    ordered.rates.map((row) => row.id),
    ['winter-dates', 'summer-dates'],
  );
});

test('the dirty comparison ignores a stale date hint but not the dates', () => {
  const stored = { rate: 0.25, currency: 'USD', rates: [summerDates] };
  const draft = {
    rate: '0.25',
    currency: 'USD',
    rates: [rateRowFields({ ...summerDates, months: [1, 2] })],
  };
  assert.equal(settingsDraftMatches(draft, stored), true);
  assert.equal(rateWindowsKey([{ ...summerDates, months: [1, 2] }]), rateWindowsKey([summerDates]));
  assert.equal(
    settingsDraftMatches(
      { ...draft, rates: [rateRowFields({ ...summerDates, from: '06-16' })] },
      stored,
    ),
    false,
  );
  // The derived hint written by the payload is the same draft, not a change.
  assert.equal(
    settingsDraftMatches(
      { ...draft, rates: [rateRowFields({ ...summerDates, months: [6, 7, 8, 9] })] },
      stored,
    ),
    true,
  );
});

test('a date season duplicates into its wrapping complement in one call', () => {
  assert.deepEqual(complementScope({ kind: 'dates', from: '06-15', to: '09-15' }), {
    kind: 'dates',
    from: '09-16',
    to: '06-14',
    months: [9, 10, 11, 12, 1, 2, 3, 4, 5, 6],
  });
  // A period object works too.
  const periods = ratePeriods([rateRowFields(winterDates)]);
  assert.deepEqual(complementScope(periods[0]), {
    kind: 'dates',
    from: '06-15',
    to: '09-15',
    months: [6, 7, 8, 9],
  });
  // Month scopes keep their month complement; an all-year or unusable scope has
  // nowhere to duplicate into.
  assert.deepEqual(complementScope({ kind: 'months', months: [11, 12, 1, 2] }), {
    kind: 'months',
    months: [3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.equal(complementScope({ kind: 'all', months: null }), null);
  assert.equal(complementScope({ kind: 'invalid', months: [] }), null);
  assert.equal(complementScope({ months: null }), null);

  const complement = complementScope({ kind: 'dates', from: '06-15', to: '09-15' });
  let nextId = 0;
  const copied = copyPeriodRows(
    [rateRowFields(summerDates)],
    [0],
    complement.months,
    () => `copy-${++nextId}`,
    complement,
  );
  assert.equal(copied[1].from, '09-16');
  assert.equal(copied[1].to, '06-14');
  // The copy stores its month hint sorted; the payload derives it from the dates.
  assert.deepEqual(copied[1].months, [1, 2, 3, 4, 5, 6, 9, 10, 11, 12]);
  // A month copy never inherits stale dates that would outrank it.
  const monthCopy = copyPeriodRows([rateRowFields(summerDates)], [0], [1, 2], () => 'copy-month');
  assert.equal(monthCopy[1].from, null);
  assert.equal(monthCopy[1].to, null);
  assert.deepEqual(monthCopy[1].months, [1, 2]);
});

test('a date season is sampled at its own dates, not at a month', () => {
  const summer = ratePeriods([rateRowFields(summerDates)])[0];
  const dates = representativeDates(summer);
  assert.equal(dates.length, 7);
  // Centred in Jun 15 – Sep 15: 28 July – 3 August.
  assert.deepEqual(dates, [
    { month: 7, day: 28 },
    { month: 7, day: 29 },
    { month: 7, day: 30 },
    { month: 7, day: 31 },
    { month: 8, day: 1 },
    { month: 8, day: 2 },
    { month: 8, day: 3 },
  ]);
  // A week or less is shown whole; one day is one sample.
  const short = ratePeriods([rateRowFields({ ...summerDates, from: '06-15', to: '06-20' })])[0];
  assert.deepEqual(
    representativeDates(short).map((entry) => entry.day),
    [15, 16, 17, 18, 19, 20],
  );
  const oneDay = ratePeriods([rateRowFields({ ...summerDates, from: '06-15', to: '06-15' })])[0];
  assert.deepEqual(representativeDates(oneDay), [{ month: 6, day: 15 }]);
  // A month period still answers by month.
  assert.deepEqual(representativeDates(ratePeriods([rateRowFields(winterPeak)])[0]), []);
  assert.equal(representativeMonth(ratePeriods([rateRowFields(winterPeak)])[0]), 1);
  // A wrapping range's sample stays inside the season.
  const wrap = ratePeriods([rateRowFields({ ...summerDates, from: '12-20', to: '01-10' })])[0];
  const wrapDates = representativeDates(wrap);
  assert.equal(wrapDates.length, 7);
  assert.ok(wrapDates.some((entry) => entry.month === 12 || entry.month === 1));
});

test('date coverage reads as its dates, with one all-day row for a season rate', () => {
  const rows = [
    rateRowFields(nightEveryDay),
    rateRowFields(summerDates),
    rateRowFields(winterDates),
  ];
  const periods = ratePeriods(rows);
  const summer = periods.find((period) => period.from === '06-15');
  const coverage = periodCoverage(rows, 0.31, summer, periods, 2026);
  assert.equal(coverage.monthName, 'Jun 15–Sep 15');
  assert.equal(coverage.dateText, 'Jun 15–Sep 15');
  assert.equal(coverage.month, 7);
  assert.deepEqual(
    coverage.siblings.map((period) => period.title),
    ['All year'],
  );
  // The summer period is one all-day, every-day price: one Every day row for the
  // whole day, never a weekday/time grid.
  assert.deepEqual(
    coverage.types.map((type) => [type.label, type.segments.map((segment) => segment.rate)]),
    [['Every day', [0.2]]],
  );
  // That price covers the whole day, so the fallback never widens the range.
  assert.deepEqual(periodEffectiveRange(rows, 0.31, summer, 2026), {
    min: 0.2,
    max: 0.2,
    month: 7,
  });
  // A season rate is one Every day type and one 00:00–24:00 row even when the
  // sample is short.
  const shortSeason = ratePeriods([rateRowFields({ ...summerDates, from: '06-15', to: '06-16' })]);
  const shortCoverage = periodCoverage(
    [rateRowFields({ ...summerDates, from: '06-15', to: '06-16' })],
    0.31,
    shortSeason[0],
    shortSeason,
    2026,
  );
  assert.deepEqual(
    shortCoverage.types.map((type) => [type.label, type.days]),
    [['Every day', [0, 1, 2, 3, 4, 5, 6]]],
  );
  assert.deepEqual(
    shortCoverage.types[0].segments.map((segment) => [segment.from, segment.to, segment.rate]),
    [[0, 1440, 0.2]],
  );

  // A TOU date season keeps its hours and names its sibling seasons.
  const touSeason = ratePeriods([rateRowFields({ ...winterDates, from: '09-16', to: '06-14' })]);
  const touCoverage = periodCoverage(
    [rateRowFields(nightEveryDay), rateRowFields(winterDates)],
    0.31,
    touSeason[0],
    [ratePeriods([rateRowFields(nightEveryDay)])[0], touSeason[0]],
    2026,
  );
  assert.equal(
    touCoverage.types.some((type) => type.label === 'Weekdays'),
    true,
  );
  const peak = touCoverage.types
    .flatMap((type) => type.segments)
    .find((segment) => segment.window && segment.window.id === 'winter-dates');
  assert.equal(peak.rate, 0.32);
  assert.equal(
    touCoverage.siblings.some((period) => period.title === 'All year'),
    true,
  );
});

test('uncovered dates are a day-level line that collapses whole months', () => {
  // A full partition hides the line.
  assert.deepEqual(
    uncoveredDateRanges([rateRowFields(summerDates), rateRowFields(winterDates)]),
    [],
  );
  assert.equal(dateSetText([]), '');
  // Winter leaves the rest of the year; 29 February is a real uncovered day.
  const winterOnly = ratePeriods([rateRowFields({ ...winterDates, from: '11-01', to: '02-28' })]);
  const uncovered = uncoveredDateRanges([
    rateRowFields({ ...winterDates, from: '11-01', to: '02-28' }),
  ]);
  assert.equal(dateSetText(uncovered), 'Feb 29–Oct 31');
  assert.equal(complementScope(winterOnly[0]).from, '02-29');
  // A gap between two seasons.
  const gap = [
    rateRowFields({ ...summerDates, id: 'spring', from: '03-01', to: '05-31', months: [3, 4, 5] }),
    rateRowFields({ ...summerDates, id: 'autumn', from: '08-01', to: '10-31', months: [8, 9, 10] }),
  ];
  assert.equal(dateSetText(uncoveredDateRanges(gap)), 'Nov–Feb, Jun–Jul');
  // A single season's complement reads as one wrapping range.
  assert.equal(dateSetText(uncoveredDateRanges([rateRowFields(summerDates)])), 'Sep 16–Jun 14');
  // Month scopes use the same ring: whole months collapse.
  assert.equal(
    dateSetText(uncoveredDateRanges([rateRowFields({ ...winterPeak, months: [11, 12, 1, 2] })])),
    'Mar–Oct',
  );
  // The label vocabulary itself.
  assert.equal(dateSetText([[0, 365]]), 'All year');
  assert.equal(dateSetText([[91, 181]]), 'Apr–Jun');
  assert.equal(dateSetText([[91, 165]]), 'Apr 1–Jun 14');
  assert.equal(dateSetText([[166, 166]]), 'Jun 15');
  assert.deepEqual(
    mergeDateRanges([
      [0, 59],
      [305, 365],
      [100, 120],
    ]),
    [
      [305, 59],
      [100, 120],
    ],
  );
});

test('the checker names a date season and recognises a season rate', () => {
  const seasonRateRow = rateRowFields(summerDates);
  const inside = previewRate([seasonRateRow], '0.31', new Date(2026, 7, 1, 12, 0));
  assert.equal(inside.rate, 0.2);
  assert.equal(inside.fallback, false);
  assert.equal(inside.seasonRate, true);
  assert.equal(inside.scopeText, 'Jun 15–Sep 15');
  assert.equal(inside.dateText, 'Jun 15–Sep 15');
  assert.equal(inside.summary, 'Every day · All day');
  // Outside the season the fallback applies and there is no scope to name.
  const outside = previewRate([seasonRateRow], '0.31', new Date(2026, 5, 14, 12, 0));
  assert.equal(outside.fallback, true);
  assert.equal(outside.rate, 0.31);
  assert.equal(outside.seasonRate, false);
  assert.equal(outside.scopeText, '');

  // A date-season TOU tail is still attributed to the start day.
  const tou = rateRowFields({ ...summerDates, rate: 0.1, start: '22:00', end: '06:00' });
  const tail = previewRate([tou], '0.31', new Date(2026, 8, 16, 1, 0));
  assert.equal(tail.rate, 0.1);
  assert.equal(tail.seasonRate, false);
  assert.equal(tail.scopeText, 'Jun 15–Sep 15');
});

test('a date problem focuses the season dates; the old month focus is unchanged', () => {
  const dateErrors = validateRateEditorRows([{ ...rateRowFields(summerDates), from: '02-30' }]);
  assert.ok(dateErrors.rows[0].from);
  assert.deepEqual(submitFocusTarget({ rateValidation: dateErrors }), {
    kind: 'row',
    index: 0,
    focus: 'dates',
  });
  const monthErrors = validateRateEditorRows([{ ...rateRowFields(nightEveryDay), months: 3 }]);
  assert.deepEqual(submitFocusTarget({ rateValidation: monthErrors }), {
    kind: 'row',
    index: 0,
    focus: 'months',
  });

  const commits = [];
  const attempt = submitSettingsPlan({
    fields: { rate: '0.31', currency: 'USD', rates: [{ ...rateRowFields(summerDates), to: '' }] },
    onCommit: (values) => commits.push(values),
  });
  assert.equal(attempt.blocked, true);
  assert.deepEqual(commits, []);
  assert.deepEqual(attempt.target, { kind: 'row', index: 0, focus: 'dates' });
});

test('a season rate mixed with TOU windows is rejected; different seasons may coexist', () => {
  const seasonRate = rateRowFields(summerDates);
  const julyPeak = rateRowFields({
    ...summerDates,
    id: 'july-peak',
    rate: 0.32,
    months: [7],
    from: '07-01',
    to: '07-31',
    start: '16:00',
    end: '19:00',
  });
  const mix = validateRateEditorRows([seasonRate, julyPeak]);
  assert.equal(mix.valid, false);
  assert.deepEqual(mix.overlaps, [[0, 1]]);
  assert.match(mix.general.join(' '), /Jun 15–Sep 15/);
  // The same mix in disjoint seasons is a plain seasonal plan.
  const winterPeak = rateRowFields({ ...winterDates, id: 'winter-peak' });
  assert.equal(validateRateEditorRows([seasonRate, winterPeak]).valid, true);
  assert.equal(isSeasonRateRow(seasonRate), true);
  assert.equal(isSeasonRateRow(julyPeak), false);
  assert.equal(
    isSeasonRateRow({ ...seasonRate, days: [0, 1, 2, 3, 4, 5, 6], start: '07:00', end: '07:00' }),
    true,
  );
  assert.equal(isSeasonRateRow({ ...seasonRate, start: '06:00', end: '07:00' }), false);
  assert.equal(isSeasonRatePeriod({ rows: [{ row: seasonRate }] }), true);
  assert.equal(isSeasonRatePeriod({ rows: [{ row: seasonRate }, { row: julyPeak }] }), false);
  assert.equal(isSeasonRatePeriod(null), false);
});

test('date rows obey the editor cap and the helper text names both seasons', () => {
  const rows = Array.from({ length: 25 }, (_, index) =>
    rateRowFields({
      ...summerDates,
      id: `d${index}`,
      from: `01-${String(index + 1).padStart(2, '0')}`,
      to: `01-${String(index + 1).padStart(2, '0')}`,
    }),
  );
  const capped = validateRateEditorRows(rows);
  assert.equal(capped.capped, true);
  assert.deepEqual(capped.general, [RATE_CAP_MESSAGE, RATE_CAP_REMEDY]);

  // Date rows are named by their dates in an overlap sentence.
  const label = windowLabel(summerDates, [0.2, 0.32], 0.31);
  assert.equal(label, 'Off-peak 0.2 · Every day · All day · Jun 15–Sep 15');
  assert.equal(dateRangeText('06-15', '09-15'), 'Jun 15–Sep 15');
  assert.equal(dateRangeText('02-29', '02-29'), 'Feb 29');
  assert.equal(dateRangeText('10-15', '04-15'), 'Oct 15–Apr 15');
  assert.equal(dateRangeText('02-30', '03-01'), '');
});
