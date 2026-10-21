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
  CHECK_RATE_MESSAGE,
  applyPeriodDates,
  applyPeriodDatesInPlace,
  applyPeriodMonths,
  baseRateRow,
  canDuplicatePeriod,
  complementMonths,
  complementScope,
  copyPeriodRows,
  dateInputValue,
  dateRangeHint,
  dateRangeText,
  dateSetText,
  dayPresetFor,
  dayTypeLabel,
  dayTypesForWeek,
  daysForPreset,
  defaultRateRow,
  flatToScheduleRow,
  formatPreviewWhen,
  isAllDayWindow,
  isLeapYear,
  largestDateScope,
  mergeDateRanges,
  minutesToClock,
  monthEditorIsLegacy,
  monthScopeBounds,
  nextWindowPreset,
  normalizeSettings,
  parseLocalDateTime,
  periodCoverage,
  periodDateBounds,
  periodDateSeed,
  periodEffectiveRange,
  periodHasDates,
  periodBaseRate,
  periodHasBaseOverlap,
  periodRowScope,
  planHasUnpriced,
  previewBlocker,
  planProblemText,
  previewRate,
  rateIsUsable,
  rateMonthsText,
  rateMonthScope,
  ratePlanRange,
  rateEditorMode,
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
  scheduleToFlatRate,
  sameSettingsInput,
  saveButtonState,
  scopesOverlap,
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
  uncoveredGapScopes,
  validateRateEditorRows,
  validateSettings,
  validationProblemCount,
  windowLabel,
} from '../../web/js/settings.js';
import {
  applySubmitFocus,
  boundFromDateInput,
  dateInputForBound,
  referenceStartYear,
} from '../../web/js/screens/settings.js';
import {
  isBaseWindow,
  normalizeRateSchedule,
  rateWindowsKey,
  validateRateWindows,
} from '../../web/js/rates.js';

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

test('a rate with more than three decimals is a valid 0–5 price end to end', () => {
  // Owner report: 0.11270 (11.27p/kWh) was rejected with the empty-field
  // message. The contract is only "a number from 0 to 5", so five decimals are
  // a price, not a typo, and the field must not narrow precision to a step.
  const flat = validateSettings({ rate: '0.11270', currency: 'USD' });
  assert.equal(flat.valid, true);
  assert.deepEqual(flat.errors, {});
  assert.equal(flat.values.rate, 0.1127);

  const row = {
    id: 'night',
    rate: '0.11270',
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
  };
  const windows = validateRateWindows([row]);
  assert.equal(windows.valid, true);
  assert.equal(windows.values[0].rate, 0.1127);
  assert.equal(validateRateEditorRows([row], '0.1127').valid, true);

  // The saved document carries the parsed number, never the typed string.
  const values = validateSettings({ rate: '0.11270', currency: 'USD', rates: [row] }).values;
  const payload = settingsPayload(values);
  assert.equal(payload.rate, 0.1127);
  assert.equal(typeof payload.rate, 'number');
  assert.equal(payload.rates[0].rate, 0.1127);
  assert.equal(typeof payload.rates[0].rate, 'number');

  // The single 0–5 rule still bounds the value, whatever the precision.
  assert.equal(
    validateSettings({ rate: '5.11270', currency: 'USD' }).errors.rate,
    'Rate must be between 0 and 5.',
  );
  assert.equal(
    validateSettings({ rate: '-0.00001', currency: 'USD' }).errors.rate,
    'Rate must be between 0 and 5.',
  );
  // Empty and non-numeric input keep the existing message.
  for (const rate of ['', '   ', 'abc', '0.11270e']) {
    assert.equal(
      validateSettings({ rate, currency: 'USD' }).errors.rate,
      'Enter a rate between 0 and 5.',
      rate,
    );
  }
  assert.equal(
    validateRateWindows([{ ...row, rate: 'abc' }]).errors.rows[0].rate,
    'Enter a rate between 0 and 5.',
  );
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
    bases: [],
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
  const summer = periods.find((period) => period.rows.some((entry) => entry.row.id === 'summer'));
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
const winterBase = {
  id: 'winter-base',
  rate: 0.31,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '00:00',
  end: '00:00',
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
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak), rateRowFields(winterBase)];
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
  assert.equal(rateSegmentLabel(week[3].segments[0], [0.1, 0.31, 0.32], 0.31), 'Off-peak');
  assert.equal(rateSegmentLabel(week[3].segments[1], [0.1, 0.31, 0.32], 0.31), 'Base');

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
  const rows = [
    rateRowFields(nightEveryDay),
    rateRowFields(winterPeak),
    rateRowFields(winterBase),
    rateRowFields(summerFlat),
  ];
  const periods = ratePeriods(rows);
  const allYear = periods.find((period) => period.kind === 'all');
  const winter = periods.find((period) => period.title === 'Winter');
  const summer = periods.find((period) => period.rows.some((entry) => entry.row.id === 'summer'));

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
  assert.equal(
    siblingNote({ kind: 'dates', title: 'Season', monthText: 'Jun 15–Sep 15' }),
    'Season Jun 15–Sep 15 also applies here.',
  );
  // The title is scope-derived now, so a stray stored title cannot invent a
  // second name for a date season.
  assert.equal(
    siblingNote({ kind: 'dates', title: 'Season rate', monthText: 'Jun 15–Sep 15' }),
    'Season Jun 15–Sep 15 also applies here.',
  );

  const summerCoverage = periodCoverage(rows, 0.31, summer, periods, 2026);
  assert.equal(summerCoverage.month, 3);
  assert.equal(summerCoverage.monthName, 'March');
  // The all-year night window still overrides the summer base at night.
  assert.deepEqual(
    summerCoverage.types.map((type) => type.segments.map((segment) => segment.rate)),
    [[0.1, 0.2, 0.1]],
  );
  assert.deepEqual(
    summerCoverage.siblings.map((period) => period.title),
    ['All year'],
  );
});

test('the header range is effective for the representative month, not just the own rows', () => {
  const rows = [
    rateRowFields(nightEveryDay),
    rateRowFields(winterPeak),
    rateRowFields(winterBase),
    rateRowFields(summerFlat),
  ];
  const periods = ratePeriods(rows);
  const allYear = periods.find((period) => period.kind === 'all');
  const winter = periods.find((period) => period.title === 'Winter');
  const summer = periods.find((period) => period.rows.some((entry) => entry.row.id === 'summer'));

  // Overnight .10 (own) + winter peak .32 (sibling) + fallback .31.
  assert.deepEqual(periodEffectiveRange(rows, 0.31, allYear), { min: 0.1, max: 0.32, month: 1 });
  assert.deepEqual(periodEffectiveRange(rows, 0.31, winter), { min: 0.1, max: 0.32, month: 1 });
  // The summer base .20 covers the day; the all-year night window .10 still
  // overrides its early hours.
  assert.deepEqual(periodEffectiveRange(rows, 0.31, summer), { min: 0.1, max: 0.2, month: 3 });

  // A malformed row never widens an "effective" range.
  const broken = [rateRowFields(nightEveryDay), rateRowFields({ ...winterPeak, rate: 9 })];
  assert.deepEqual(periodEffectiveRange(broken, 0.31, ratePeriods(broken)[0]), {
    min: 0,
    max: 0.1,
    month: 1,
  });
  // No base means the uncovered hours are 0, but they are not in this window's
  // own slices; the usable window rates still set the range.
  assert.deepEqual(
    periodEffectiveRange(
      [rateRowFields(nightEveryDay)],
      '',
      ratePeriods([rateRowFields(nightEveryDay)])[0],
    ),
    {
      min: 0,
      max: 0.1,
      month: 1,
    },
  );
});

test('the exact-date checker names the winning row and the source of the price', () => {
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak), rateRowFields(winterBase)];
  const at = (year, month, day, hours, minutes = 0) =>
    previewRate(rows, '0.31', new Date(year, month - 1, day, hours, minutes));

  const peak = at(2026, 1, 15, 17, 0);
  assert.equal(peak.rate, 0.32);
  assert.equal(peak.window.id, 'winter-peak');
  assert.equal(peak.tier, 'Peak');
  assert.equal(peak.source, 'window');
  assert.match(peak.summary, /Weekdays · 16:00–19:00/);
  assert.equal(peak.monthsText, 'Nov–Feb');

  const noon = at(2026, 1, 15, 12, 0);
  assert.equal(noon.rate, 0.31);
  assert.equal(noon.source, 'base');
  assert.equal(noon.tier, 'Base');
  assert.equal(at(2026, 1, 15, 18, 59).rate, 0.32);
  assert.equal(at(2026, 1, 15, 19, 0).source, 'base');
  // Month boundaries: 31 Dec is winter, 1 Mar leaves the winter base behind.
  assert.equal(at(2026, 12, 31, 17, 0).rate, 0.32);
  const march = at(2027, 3, 1, 17, 0);
  assert.equal(march.rate, 0);
  assert.equal(march.source, 'uncovered');
  // The all-year night scope still covers the date, but not this hour.
  assert.equal(march.uncoveredDate, false);
  assert.equal(march.unpricedHour, true);
  // Midnight wrap: 23:00 is the main part, 05:00 the tail of the previous day.
  assert.equal(at(2026, 6, 15, 23, 0).rate, 0.1);
  assert.equal(at(2026, 6, 16, 5, 0).rate, 0.1);
  const hourGap = at(2026, 6, 16, 6, 0);
  assert.equal(hourGap.rate, 0);
  assert.equal(hourGap.unpricedHour, true);
  assert.equal(hourGap.source, 'uncovered');

  // A December-only wrap covers 1 January's early hours and nothing later.
  const decemberWrap = [rateRowFields({ ...nightEveryDay, id: 'dec', months: [12] })];
  assert.equal(previewRate(decemberWrap, 0.31, new Date(2027, 0, 1, 5, 0)).rate, 0.1);
  const laterJanuary = previewRate(decemberWrap, 0.31, new Date(2027, 0, 2, 5, 0));
  assert.equal(laterJanuary.rate, 0);
  assert.equal(laterJanuary.uncoveredDate, true);

  // An invalid row is dropped, leaving no schedule; the flat path remains for
  // that corrupt document (the editor blocks saving it).
  const incomplete = previewRate(
    [{ ...rateRowFields(winterPeak), rate: '' }],
    0.31,
    new Date(2026, 0, 15, 17, 0),
  );
  assert.equal(incomplete.rate, 0.31);
  assert.equal(incomplete.source, 'flat');
  assert.equal(previewRate(rows, '', new Date(2026, 0, 15, 12, 0)).rate, 0.31);
});

test('the checker tells a day with no season apart from an hour no window covers', () => {
  // No base is required to classify a miss: a date outside every scope is an
  // uncovered date; a date inside a scope with no hour price is an uncovered
  // hour. Both are 0.00.
  const rows = [rateRowFields(nightEveryDay)];
  const noSeason = previewRate(rows, '0.31', new Date(2026, 6, 15, 12, 0));
  assert.equal(noSeason.rate, 0);
  assert.equal(noSeason.source, 'uncovered');
  assert.equal(noSeason.uncoveredDate, false); // all-year night covers July
  assert.equal(noSeason.unpricedHour, true);
  const outsideYear = previewRate(
    [rateRowFields({ ...nightEveryDay, months: [12] })],
    '0.31',
    new Date(2026, 6, 15, 12, 0),
  );
  assert.equal(outsideYear.uncoveredDate, true);
  assert.equal(outsideYear.unpricedHour, false);
  // A winning base is reported as priced, not as a gap.
  const priced = previewRate([rateRowFields(winterBase)], '0.31', new Date(2026, 0, 15, 12, 0));
  assert.equal(priced.source, 'base');
  assert.equal(priced.uncoveredDate, false);
  assert.equal(priced.unpricedHour, false);
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

test('the season date picker opens on the current year and accepts any year', () => {
  const now = new Date(2026, 9, 21);
  assert.equal(referenceStartYear(now), 2026);
  // The default rendering year is the current local year: the picker opens in
  // the present and forward navigation has no ceiling.
  assert.equal(dateInputForBound('10-15', now), '2026-10-15');
  assert.equal(dateInputForBound('01-01', now), '2026-01-01');
  // Every year names the same month and day. A far-future and a past year both
  // round-trip through the picker to their MM-DD, with the year dropped.
  assert.equal(boundFromDateInput('2031-05-01'), '05-01');
  assert.equal(boundFromDateInput('2025-11-30'), '11-30');
  assert.equal(dateInputForBound(boundFromDateInput('2031-05-01'), now), '2026-05-01');
  assert.equal(dateInputForBound(boundFromDateInput('2025-11-30'), now), '2026-11-30');
  // Only a month-day can render; a blank or malformed stored value stays blank.
  assert.equal(dateInputForBound('', now), '');
  assert.equal(dateInputForBound('02-30', now), '');
  assert.equal(dateInputForBound('2026-10-15', now), '');
});

test('a stored 29 February renders in a leap year, not as a blank field', () => {
  const now = new Date(2026, 9, 21);
  assert.equal(dateInputForBound('02-29', now), '2028-02-29');
  assert.equal(dateInputForBound('02-29', new Date(2028, 0, 1)), '2028-02-29');
  assert.equal(dateInputForBound('02-29', new Date(2024, 0, 1)), '2024-02-29');
  // Every rendering year is a real leap year, including across the century
  // window 2097–2100, which has none: the field reaches to 2104.
  for (let year = 2024; year <= 2100; year += 1) {
    const value = dateInputForBound('02-29', new Date(year, 0, 1));
    assert.ok(isLeapYear(Number(value.slice(0, 4))), `renders for start ${year}`);
  }
  for (let year = 2097; year <= 2100; year += 1) {
    assert.equal(dateInputForBound('02-29', new Date(year, 0, 1)), '2104-02-29');
  }
  // Every other day renders in the current year: the year is a reference only.
  assert.equal(dateInputForBound('10-15', now), '2026-10-15');
  assert.equal(dateInputForBound('01-01', now), '2026-01-01');
  // A picked 29 February stores its month and day, whichever leap year renders.
  assert.equal(boundFromDateInput(dateInputForBound('02-29', now)), '02-29');
  assert.equal(boundFromDateInput(dateInputForBound('02-29', new Date(2101, 0, 1))), '02-29');
});

test('a picked date stores its month and day and round-trips through the picker', () => {
  const now = new Date(2026, 9, 21);
  assert.equal(boundFromDateInput('2026-10-15'), '10-15');
  assert.equal(boundFromDateInput('2028-02-29'), '02-29');
  assert.equal(boundFromDateInput('2029-12-31'), '12-31');
  assert.equal(boundFromDateInput(dateInputForBound('02-29', now)), '02-29');
  assert.equal(boundFromDateInput(dateInputForBound('10-15', now)), '10-15');
  // A blank or impossible pick keeps date mode with the sentinel so validation
  // can explain the missing half instead of dropping the bound.
  assert.equal(boundFromDateInput(''), '00-00');
  assert.equal(boundFromDateInput('2026-02-30'), '00-00');
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
function cardStub({ monthEditor = false, base = false } = {}) {
  const calls = [];
  const focus = (name) => () => calls.push(name);
  return {
    calls,
    node: { scrollIntoView: () => calls.push('reveal-row') },
    periodCard: {
      allYear: { focus: focus('months') },
      dateFocus: { focus: focus('dates') },
      node: { scrollIntoView: () => calls.push('reveal-period') },
      baseBlock: { scrollIntoView: () => calls.push('reveal-base') },
      // The month chips are the legacy path: absent or hidden unless the period
      // is a non-contiguous month scope.
      ...(monthEditor
        ? {
            advancedMonths: { hidden: false, open: false },
            monthChips: {
              querySelector: (selector) =>
                selector === '[aria-pressed="true"]' ? { focus: focus('month-chip') } : null,
            },
          }
        : { advancedMonths: { hidden: true, open: false } }),
      ...(base
        ? {
            baseInput: { focus: focus('base-rate') },
          }
        : {}),
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

test('a month problem lands on the chips only where they are offered', () => {
  const fields = blockedFields([{ ...rateRowFields(nightEveryDay), months: 3 }]);
  const attempt = submitSettingsPlan({
    fields,
    onCommit: () => assert.fail('wrote a blocked plan'),
  });
  assert.deepEqual(attempt.target, { kind: 'row', index: 0, focus: 'months' });

  // A legacy non-contiguous scope shows the chips, so the submit lands on one.
  const legacy = [cardStub({ monthEditor: true })];
  const legacyView = viewStub(legacy);
  applySubmitFocus(attempt.target, legacyView);
  assert.deepEqual(legacyView.calls, ['expand']);
  assert.deepEqual(legacy[0].calls, ['reveal-period', 'month-chip']);

  // A date or contiguous month season hides them: the scope is the date fields,
  // and focus must not be dropped into a hidden editor.
  const dates = [cardStub()];
  const dateView = viewStub(dates);
  applySubmitFocus(attempt.target, dateView);
  assert.deepEqual(dateView.calls, ['expand']);
  assert.deepEqual(dates[0].calls, ['reveal-period', 'dates']);
});

test('the checker withholds a definitive answer while the plan is incomplete', () => {
  assert.equal(previewBlocker(validateRateEditorRows([])), '');
  // An unpriced row has no window to repair: the remedy names its price.
  const unpriced = validateRateEditorRows([{ ...rateRowFields(nightEveryDay), rate: '' }]);
  assert.equal(previewBlocker(unpriced), CHECK_RATE_MESSAGE);
  assert.equal(CHECK_RATE_MESSAGE, 'Add a rate to check this moment.');
  // A malformed time is the window's problem, so the window remedy stays.
  const bad = validateRateEditorRows([{ ...rateRowFields(nightEveryDay), start: '25:00' }]);
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

test('the plan range ignores bad prices', () => {
  // Bare rows have no scope, so the plan reports the uncovered 0.00 minimum;
  // the malformed 9 and empty prices still do not widen the maximum.
  assert.deepEqual(ratePlanRange([{ rate: '0.1' }, { rate: 9 }, { rate: '' }, { rate: 0.32 }]), {
    min: 0,
    max: 0.32,
  });
  assert.equal(ratePlanRange([]), null);
});

test('a usable rate is finite and inside the accepted bounds', () => {
  // The coverage table asks this question to decide whether an own row keeps a
  // price or shows "needs attention", so it must agree with the validators.
  for (const value of ['0.2', '0', 0, 0.2, '5', 5]) assert.equal(rateIsUsable(value), true);
  for (const value of ['', '   ', 6, -1]) assert.equal(rateIsUsable(value), false);
  // Non-numeric input is unusable rather than a parse accident.
  for (const value of ['six', null, undefined, Number.NaN, Infinity]) {
    assert.equal(rateIsUsable(value), false);
  }
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
      period.mode,
      period.rows.map((entry) => entry.index),
    ]),
    [
      [
        'dates:06-15-09-15',
        'dates',
        'Season',
        'Jun 15–Sep 15',
        'Jun 15–Sep 15',
        'base+windows',
        [0, 1],
      ],
      [
        'dates:09-16-06-14',
        'dates',
        'Season',
        'Sep 16–Jun 14 (wraps)',
        'Sep 16–Jun 14 (wraps)',
        'windows',
        [2],
      ],
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

test('a date edit keeps the row objects the rate controls write to', () => {
  // A shape-preserving date edit repaints the season's cards in place, and the
  // Base rate and window controls hold the row objects themselves. Owner report:
  // add a season, adjust its dates, type 1 in Base rate — the field showed 1
  // while the card kept saying "Enter a rate between 0 and 5.". The typed rate
  // was written to a copy the draft no longer contained, so validation still saw
  // an empty rate. The in-place edit must preserve identity.
  const rows = [
    baseRateRow('oct', '0.3', [10], { from: '10-01', to: '10-31' }),
    baseRateRow('rest', '', [11], { from: '11-01', to: '09-30' }),
  ];
  const october = rows[0];
  const rest = rows[1];
  const result = applyPeriodDatesInPlace(rows, [1], '11-01', '09-29');

  // Same list, same objects: the controls' captured rows are still in the draft.
  assert.equal(result, rows);
  assert.equal(rows[0], october);
  assert.equal(rows[1], rest);
  assert.equal(rows[0].from, '10-01');
  assert.equal(rows[1].from, '11-01');
  assert.equal(rows[1].to, '09-29');
  assert.deepEqual(rows[1].months, [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // A rate typed after the edit lands on the row validation reads.
  rest.rate = '1';
  const validation = validateRateEditorRows(rows);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.rows[1], {});

  // An empty rate on its own row still reports the message the owner saw.
  rest.rate = '';
  assert.equal(validateRateEditorRows(rows).rows[1].rate, 'Enter a rate between 0 and 5.');

  // `applyPeriodDates` itself stays copy-on-write for callers that rebuild.
  assert.notEqual(applyPeriodDates(rows, [1], '11-01', '09-29')[1], rest);
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

test('date coverage reads as its dates, with the base under inherited windows', () => {
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
  // The summer base is one Every day row; the all-year night window still
  // overrides its early hours.
  assert.deepEqual(
    coverage.types.map((type) => [type.label, type.segments.map((segment) => segment.rate)]),
    [['Every day', [0.1, 0.2, 0.1]]],
  );
  assert.deepEqual(periodEffectiveRange(rows, 0.31, summer, 2026), {
    min: 0.1,
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
  assert.equal(
    dateSetText(uncoveredDateRanges([rateRowFields(summerDates)])),
    'Sep 16–Jun 14 (wraps)',
  );
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

test('the checker names a date season and the price source', () => {
  const seasonRateRow = rateRowFields(summerDates);
  const inside = previewRate([seasonRateRow], '0.31', new Date(2026, 7, 1, 12, 0));
  assert.equal(inside.rate, 0.2);
  assert.equal(inside.scopeText, 'Jun 15–Sep 15');
  assert.equal(inside.dateText, 'Jun 15–Sep 15');
  assert.equal(inside.summary, 'Every day · All day');
  // Outside the season the date is uncovered and costs 0; there is no scope.
  const outside = previewRate([seasonRateRow], '0.31', new Date(2026, 5, 14, 12, 0));
  assert.equal(outside.rate, 0);
  assert.equal(outside.source, 'uncovered');
  assert.equal(outside.uncoveredDate, true);
  assert.equal(outside.scopeText, '');
  const nightOnly = [rateRowFields(nightEveryDay)];
  const hourGap = previewRate(nightOnly, '0.31', new Date(2026, 0, 15, 12, 0));
  assert.equal(hourGap.unpricedHour, true);

  // A date-season TOU tail is still attributed to the start day.
  const tou = rateRowFields({ ...summerDates, rate: 0.1, start: '22:00', end: '06:00' });
  const tail = previewRate([tou], '0.31', new Date(2026, 8, 16, 1, 0));
  assert.equal(tail.rate, 0.1);
  assert.equal(tail.scopeText, 'Jun 15–Sep 15');
});

test('the date editor derives its mode, seed, and disabled reason from the rows', () => {
  const summer = ratePeriods([rateRowFields(summerDates)])[0];
  assert.equal(periodHasDates(summer), true);
  assert.deepEqual(periodDateBounds(summer), { from: '06-15', to: '09-15' });
  assert.deepEqual(periodDateSeed(summer), { from: '06-15', to: '09-15' });

  const allYear = ratePeriods([rateRowFields(nightEveryDay)])[0];
  assert.equal(periodHasDates(allYear), false);
  assert.deepEqual(periodDateSeed(allYear, new Date(2026, 9, 21)), {
    from: '10-01',
    to: '10-31',
  });
  assert.deepEqual(periodDateSeed(allYear, new Date(2026, 1, 2)), {
    from: '02-01',
    to: '02-29',
  });

  const winter = ratePeriods([rateRowFields({ ...nightEveryDay, months: [11, 12, 1, 2] })])[0];
  assert.equal(monthScopeBounds([11, 12, 1, 2]).fromMonth, 11);
  assert.deepEqual(periodDateSeed(winter), { from: '11-01', to: '02-29' });
  const february = ratePeriods([rateRowFields({ ...nightEveryDay, months: [2] })])[0];
  assert.deepEqual(periodDateSeed(february), { from: '02-01', to: '02-29' });

  const split = ratePeriods([rateRowFields({ ...nightEveryDay, months: [1, 6] })])[0];
  assert.equal(monthScopeBounds([1, 6]), null);
  assert.equal(periodDateSeed(split), null);
  const malformedMonths = ratePeriods([rateRowFields({ ...nightEveryDay, months: 3 })])[0];
  assert.equal(periodDateSeed(malformedMonths), null);

  const brokenDates = ratePeriods([
    rateRowFields({ ...summerDates, from: '02-30', to: '09-15' }),
  ])[0];
  assert.equal(periodHasDates(brokenDates), true);
  assert.deepEqual(periodDateBounds(brokenDates), { from: '02-30', to: '09-15' });
  assert.deepEqual(periodDateSeed(brokenDates), { from: '02-30', to: '09-15' });

  assert.equal(dateRangeHint('06-20', '06-10'), 'This range wraps the year.');
  assert.equal(dateRangeHint('11-01', '02-29'), 'This range wraps the year.');
  assert.equal(dateRangeHint('06-15', '09-15'), '');
  assert.equal(dateRangeHint('02-30', '09-15'), '');

  assert.equal(ratePeriods([rateRowFields(summerDates)])[0].mode, 'base');
  assert.equal(ratePeriods([rateRowFields(winterDates)])[0].mode, 'windows');
  const mixed = ratePeriods([
    rateRowFields(summerDates),
    rateRowFields({ ...summerDates, id: 'peak', start: '16:00', end: '19:00' }),
  ])[0];
  assert.equal(mixed.mode, 'base+windows');

  assert.deepEqual(largestDateScope([[0, 365]]), {
    from: '01-01',
    to: '12-31',
    fullYear: true,
  });
  assert.deepEqual(
    largestDateScope([
      [100, 120],
      [180, 200],
      [0, 10],
    ]),
    {
      from: '04-10',
      to: '04-30',
      fullYear: false,
    },
  );
  assert.equal(largestDateScope([]), null);
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

test('scope overlap decides whether a complement is still free to duplicate into', () => {
  assert.equal(
    scopesOverlap(
      { kind: 'dates', from: '09-16', to: '06-14' },
      { kind: 'dates', from: '06-15', to: '09-15' },
    ),
    false,
  );
  assert.equal(
    scopesOverlap(
      { kind: 'dates', from: '09-16', to: '06-14' },
      { kind: 'dates', from: '05-01', to: '05-31' },
    ),
    true,
  );
  assert.equal(
    scopesOverlap(
      { kind: 'months', months: [3, 4, 5, 6, 7, 8, 9, 10] },
      { kind: 'months', months: [11, 12, 1, 2] },
    ),
    false,
  );
  assert.equal(
    scopesOverlap(
      { kind: 'months', months: [3, 4, 5, 6, 7, 8, 9, 10] },
      { kind: 'months', months: [4] },
    ),
    true,
  );
  assert.equal(
    scopesOverlap({ kind: 'all', months: null }, { kind: 'dates', from: '06-15', to: '06-15' }),
    true,
  );
});

test('a season base with daily windows is valid; two bases on one date are not', () => {
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
  const baseWithWindows = validateRateEditorRows([seasonRate, julyPeak]);
  assert.equal(baseWithWindows.valid, true);
  assert.deepEqual(baseWithWindows.overlaps, []);
  assert.equal(baseWithWindows.bases[0], true);
  assert.equal(baseWithWindows.bases[1], false);
  // A second base covering the same dates is the ambiguous case.
  const secondBase = rateRowFields({
    ...summerDates,
    id: 'second-base',
    months: [6],
    from: '06-15',
    to: '09-15',
  });
  const twoBases = validateRateEditorRows([seasonRate, secondBase]);
  assert.equal(twoBases.valid, false);
  assert.deepEqual(twoBases.overlaps, [[0, 1]]);
  assert.match(twoBases.general.join(' '), /both base rates.*Keep one base per date/);
  // The same mix in disjoint seasons is a plain seasonal plan.
  const winterPeak = rateRowFields({ ...winterDates, id: 'winter-peak' });
  assert.equal(validateRateEditorRows([seasonRate, winterPeak]).valid, true);
  // A base is recognised by its shape, one name for it everywhere.
  assert.equal(isBaseWindow(seasonRate), true);
  assert.equal(isBaseWindow(julyPeak), false);
  assert.equal(
    isBaseWindow({ ...seasonRate, days: [0, 1, 2, 3, 4, 5, 6], start: '07:00', end: '07:00' }),
    true,
  );
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
  assert.equal(label, 'Base 0.2 · Every day · All day · Jun 15–Sep 15');
  assert.equal(dateRangeText('06-15', '09-15'), 'Jun 15–Sep 15');
  // A single annual date is not a weekday scope; a wrap must not read inverted.
  assert.equal(dateRangeText('02-29', '02-29'), 'Feb 29 (one day)');
  assert.equal(dateRangeText('10-15', '04-15'), 'Oct 15–Apr 15 (wraps)');
  assert.equal(dateRangeText('06-20', '06-10'), 'Jun 20–Jun 10 (wraps)');
  assert.equal(dateRangeText('02-30', '03-01'), '');
});

test('a dates target expands the season and focuses the date control', () => {
  const card = cardStub();
  const view = viewStub([card]);
  applySubmitFocus({ kind: 'row', index: 0, focus: 'dates' }, view);
  assert.deepEqual(card.calls, ['reveal-period', 'dates']);
});

test('a window added inside a season inherits its whole scope', () => {
  const dateSeason = ratePeriods([
    rateRowFields({ ...summerDates, id: 'a' }),
    rateRowFields({ ...summerDates, id: 'b', days: [0, 1, 2, 3, 4], start: '16:00', end: '19:00' }),
  ])[0];
  // Months alone would form a second, month-wide season: the raw day bounds are
  // what keep the new row inside the date season.
  assert.deepEqual(periodRowScope(dateSeason), {
    months: [6, 7, 8, 9],
    dates: { from: '06-15', to: '09-15' },
  });
  const monthSeason = ratePeriods([rateRowFields(winterPeak)])[0];
  assert.deepEqual(periodRowScope(monthSeason), { months: [1, 2, 11, 12], dates: null });
  assert.deepEqual(periodRowScope(null), { months: null, dates: null });

  const scope = periodRowScope(dateSeason);
  const row = defaultRateRow('added', scope.months, scope.dates);
  assert.equal(row.from, '06-15');
  assert.equal(row.to, '09-15');
  // The new row groups back into the season it was added to, not a new one.
  assert.equal(ratePeriods([row])[0].key, 'dates:06-15-09-15');
});

test('Add window picks a preset the season does not already contain', () => {
  const peakRow = {
    ...summerDates,
    id: 'peak',
    days: [0, 1, 2, 3, 4],
    start: '16:00',
    end: '19:00',
  };
  const nightRow = { ...summerDates, id: 'night', start: '00:00', end: '07:00' };
  const peakOnly = ratePeriods([rateRowFields(peakRow)])[0];
  const nightOnly = ratePeriods([rateRowFields(nightRow)])[0];
  // A first window and a season already holding the weekday-evening shape both
  // get the overnight preset, so the action cannot build an overlap by itself.
  assert.equal(nextWindowPreset(null), 'overnight');
  assert.equal(nextWindowPreset(ratePeriods([])[0]), 'overnight');
  assert.equal(nextWindowPreset(peakOnly), 'overnight');
  assert.equal(nextWindowPreset(nightOnly), 'peak');
  // A custom-days row is not the peak preset, so peak stays the default.
  assert.equal(
    nextWindowPreset(ratePeriods([rateRowFields({ ...summerDates, id: 'c', days: [0, 6] })])[0]),
    'peak',
  );
});

test('a date season covers its months even when the stored hint is missing or stale', () => {
  // Defect guard: the gaps a season is seeded into are read from the derived
  // scope, never the stored months hint. A null or stale hint used to report the
  // whole year (or eleven months) as free and seed over the date season.
  for (const months of [null, [1], [6, 7, 8, 9]]) {
    assert.equal(rateScope({ ...summerDates, months }).kind, 'dates');
    assert.deepEqual(
      dateSetText(uncoveredDateRanges([{ ...summerDates, months }])),
      'Sep 16–Jun 14 (wraps)',
    );
  }
});

test('the coverage caption names the scope, and a one-date season is not a weekday', () => {
  const allYearRows = [rateRowFields(nightEveryDay)];
  const allYearPeriods = ratePeriods(allYearRows);
  const allYear = periodCoverage(allYearRows, 0.31, allYearPeriods[0], allYearPeriods, 2026);
  // The week is sampled in January, but an all-year season is not January.
  assert.equal(allYear.monthName, 'January');
  assert.equal(allYear.captionText, 'All year');

  const wrapRow = rateRowFields({ ...summerDates, id: 'wrap', from: '06-20', to: '06-10' });
  const wrapPeriods = ratePeriods([wrapRow]);
  const wrap = periodCoverage([wrapRow], 0.31, wrapPeriods[0], wrapPeriods, 2026);
  assert.equal(wrap.captionText, 'Jun 20–Jun 10 (wraps)');

  const oneRow = rateRowFields({ ...summerDates, id: 'one', from: '06-15', to: '06-15' });
  const onePeriods = ratePeriods([oneRow]);
  const one = periodCoverage([oneRow], 0.31, onePeriods[0], onePeriods, 2026);
  // The row group already says "One day", so the caption tail is the bare date.
  assert.equal(one.captionText, 'Jun 15');
  // One sampled date is "One day", never the weekday it happens to fall on.
  assert.deepEqual(
    one.types.map((type) => type.label),
    ['One day'],
  );

  // A month season that spans several months is sampled in one of them, so the
  // caption marks that month as the example rather than reading as the scope.
  const customRows = [rateRowFields({ ...nightEveryDay, id: 'custom', months: [6, 7, 8, 9] })];
  const customPeriods = ratePeriods(customRows);
  const custom = periodCoverage(customRows, 0.31, customPeriods[0], customPeriods, 2026);
  assert.equal(custom.captionText, 'June · example');
  // A single-month season needs no marker: the month is the whole scope.
  const juneRows = [rateRowFields({ ...nightEveryDay, id: 'june', months: [6] })];
  const junePeriods = ratePeriods(juneRows);
  assert.equal(
    periodCoverage(juneRows, 0.31, junePeriods[0], junePeriods, 2026).captionText,
    'June',
  );
});

test('a base is banded by name, not by a relative price tier', () => {
  assert.equal(rateSegmentLabel({ window: summerDates, rate: 0.2 }, [0.2], 0.31), 'Base');
  // Base-less overrides have no base reference to compare against.
  assert.equal(
    rateSegmentLabel(
      { window: { ...summerDates, start: '16:00', end: '19:00' }, rate: 0.32 },
      [0.32],
      null,
    ),
    'Window',
  );
  assert.equal(rateSegmentLabel({ window: null, rate: 0 }, [], null), 'Uncovered');
});

test('a months target opens the advanced month panel and focuses a chip', () => {
  const card = cardStub();
  let focused = false;
  card.periodCard.advancedMonths = { open: false };
  card.periodCard.monthChips = {
    querySelector: (selector) =>
      selector === '[aria-pressed="true"]'
        ? {
            focus: () => {
              focused = true;
            },
          }
        : null,
  };
  const view = viewStub([card]);
  applySubmitFocus({ kind: 'row', index: 0, focus: 'months' }, view);
  assert.equal(card.periodCard.advancedMonths.open, true);
  assert.equal(focused, true);
});

test('a months target with the chips hidden lands on the date field', () => {
  // A contiguous or malformed scope repairs through the dates: the chips are not
  // on screen, so focus must not be sent to a display:none control.
  const card = cardStub();
  const view = viewStub([card]);
  applySubmitFocus({ kind: 'row', index: 0, focus: 'months' }, view);
  assert.deepEqual(view.calls, ['expand']);
  assert.deepEqual(card.calls, ['reveal-period', 'dates']);
});

test('a base-rate target reveals the Base rate block and focuses its field', () => {
  const card = cardStub({ base: true });
  const view = viewStub([card]);
  applySubmitFocus({ kind: 'row', index: 0, focus: 'base-rate' }, view);
  assert.deepEqual(view.calls, ['expand']);
  assert.deepEqual(card.calls, ['reveal-base', 'base-rate']);

  // A malformed all-day row that never became the base keeps its own window
  // card: its price lives in that row's rate field.
  const windowOnly = cardStub();
  applySubmitFocus({ kind: 'row', index: 0, focus: 'base-rate' }, viewStub([windowOnly]));
  assert.deepEqual(windowOnly.calls, ['reveal-base', 'rate']);
});

// ---------- unified base + daily-window model ----------

test('rateEditorMode is derived from rows, and the flat seed is a workable season', () => {
  assert.equal(rateEditorMode([]), 'flat');
  assert.equal(rateEditorMode({ rates: [] }), 'flat');
  assert.equal(rateEditorMode({ rates: [summerDates] }), 'seasons');
  assert.equal(rateEditorMode([nightEveryDay]), 'seasons');

  const base = baseRateRow('base', '0.4', [1, 2], { from: '01-01', to: '02-29' });
  assert.deepEqual(base, {
    id: 'base',
    rate: '0.4',
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '00:00',
    end: '00:00',
    months: [1, 2],
    from: '01-01',
    to: '02-29',
  });
  assert.equal(baseRateRow('empty', '', null, null).rate, '');
  // Gap guard: the flat -> Seasons seed is the current month at the flat rate,
  // never an All-year base. An All-year seed covers every date, so the first
  // "Add a season" a new Seasons owner sees is disabled.
  const seed = flatToScheduleRow('flat', '0.31', new Date(2026, 9, 21));
  assert.deepEqual(Object.keys(seed), [
    'id',
    'rate',
    'days',
    'start',
    'end',
    'months',
    'from',
    'to',
  ]);
  assert.equal(seed.from, '10-01');
  assert.equal(seed.to, '10-31');
  assert.deepEqual(seed.months, [10]);
  assert.equal(seed.rate, '0.31');
  assert.equal(isBaseWindow(seed), true);
  assert.equal(isAllDayWindow(seed), true);
  // The rest of the year is an uncovered gap: it is where the next season goes,
  // and the plan says the dates cost 0.00 until they are covered.
  // October is covered, so the uncovered rest of the year reads as one wrapping
  // run rather than two fragments.
  assert.equal(dateSetText(uncoveredDateRanges([seed])), 'Nov–Sep');
  assert.equal(planHasUnpriced([seed]), true);
  const periods = ratePeriods([seed]);
  assert.equal(periods.length, 1);
  assert.equal(periods[0].base.row.id, 'flat');
  assert.equal(periods[0].kind, 'dates');
  assert.equal(periods[0].monthText, 'Oct 1–Oct 31');
  // Seed shape is never a leap-day accident: February 2024 still ends on the 29th.
  const february = flatToScheduleRow('feb', '0.2', new Date(2026, 1, 2));
  assert.equal(february.from, '02-01');
  assert.equal(february.to, '02-29');

  // Round trip: flat rate -> seeded season -> back to One rate is not dirty
  // (Gap 3). The row is built and read back through the same helpers the screen
  // uses, so a lost scope or a drifted price shows up here.
  const flat = { rate: '0.31', currency: 'USD', rates: [] };
  const seeded = { ...flat, rates: [flatToScheduleRow('round-trip', flat.rate)] };
  assert.equal(settingsDraftMatches(seeded, flat), false);
  // A one-month season is not "the price everywhere", so the switch back keeps
  // the stored flat rate rather than widening a month's price to the year.
  const back = scheduleToFlatRate(seeded.rates, flat.rate);
  assert.equal(Number(back), 0.31);
  assert.equal(
    settingsDraftMatches(
      { rate: String(back), currency: 'USD', rates: [] },
      { rate: 0.31, currency: 'USD' },
    ),
    true,
  );
});

test('Seasons to One rate reuses only a single All-year base price', () => {
  assert.equal(scheduleToFlatRate([baseRateRow('base', '0.4', null, null)], '0.31'), 0.4);
  assert.equal(
    scheduleToFlatRate([baseRateRow('base', '0.4', [1], { from: '01-01', to: '01-31' })], '0.31'),
    '0.31',
  );
  assert.equal(
    scheduleToFlatRate([baseRateRow('base', '0.4', null, null), rateRowFields(winterPeak)], '0.31'),
    '0.31',
  );
  assert.equal(scheduleToFlatRate([], '0.31'), '0.31');
  // An unusable base price falls back to the stored flat value.
  assert.equal(scheduleToFlatRate([baseRateRow('base', '', null, null)], '0.31'), '0.31');
});

test('periods expose one base, its overrides and any extra repair rows', () => {
  const base = rateRowFields({ ...summerDates, rate: 0.2 });
  const peak = rateRowFields({
    ...summerDates,
    id: 'summer-peak',
    rate: 0.32,
    start: '16:00',
    end: '19:00',
  });
  const weekend = rateRowFields({
    ...summerDates,
    id: 'summer-weekend',
    rate: 0.1,
    start: '00:00',
    end: '00:00',
    days: [5, 6],
  });
  const period = ratePeriods([base, peak, weekend])[0];
  assert.equal(period.mode, 'base+windows');
  assert.equal(period.title, 'Season');
  assert.equal(period.base.row.id, 'summer-dates');
  assert.equal(periodBaseRate(period), 0.2);
  assert.deepEqual(
    period.overrides.map((entry) => entry.row.id),
    ['summer-peak', 'summer-weekend'],
  );
  assert.deepEqual(
    period.windows.map((entry) => entry.row.id),
    ['summer-peak', 'summer-weekend'],
  );

  // The title names the scope only, so one base and a base plus windows read
  // the same way for the same dates.
  const baseOnly = ratePeriods([base])[0];
  assert.equal(baseOnly.mode, 'base');
  assert.equal(baseOnly.title, 'Season');
  assert.equal(baseOnly.base.row.id, base.id);

  const windowsOnly = ratePeriods([peak])[0];
  assert.equal(windowsOnly.mode, 'windows');
  assert.equal(windowsOnly.base, null);
  assert.equal(periodBaseRate(windowsOnly), null);
  assert.equal(windowsOnly.title, 'Season');

  // An all-year base is "All year", not a second name for the same shape.
  const allYearBase = ratePeriods([rateRowFields(baseRateRow('all', '0.3', null, null))])[0];
  assert.equal(allYearBase.mode, 'base');
  assert.equal(allYearBase.title, 'All year');
  const allYearMixed = ratePeriods([
    rateRowFields(baseRateRow('all', '0.3', null, null)),
    rateRowFields({ ...nightEveryDay, id: 'all-peak', rate: 0.1, start: '22:00', end: '06:00' }),
  ])[0];
  assert.equal(allYearMixed.mode, 'base+windows');
  assert.equal(allYearMixed.title, 'All year');
});

test('plan warnings separate uncovered dates from a base-less season', () => {
  const allYearBase = rateRowFields(baseRateRow('base', '0.3', null, null));
  const dateBase = rateRowFields({ ...summerDates, rate: 0.2 });
  const dateWindow = rateRowFields({
    ...summerDates,
    id: 'peak',
    rate: 0.32,
    start: '16:00',
    end: '19:00',
  });
  assert.equal(planHasUnpriced([]), false);
  assert.equal(planHasUnpriced([allYearBase]), false);
  assert.equal(planHasUnpriced([allYearBase, dateWindow]), false);
  assert.equal(planHasUnpriced([dateBase]), true); // uncovered dates off-season
  assert.equal(planHasUnpriced([dateWindow]), true); // no base
  assert.equal(mergeDateRanges(uncoveredDateRanges([dateBase])).length, 1);
  assert.equal(mergeDateRanges(uncoveredDateRanges([allYearBase])).length, 0);
  assert.equal(mergeDateRanges(uncoveredDateRanges([])).length, 1);

  const gaps = uncoveredGapScopes([dateBase]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, '09-16');
  assert.equal(gaps[0].to, '06-14');
  assert.deepEqual(gaps[0].months, [9, 10, 11, 12, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(uncoveredGapScopes([]), [{ months: null, from: null, to: null }]);
});

test('a plan whose hours are all covered by overrides is priced everywhere', () => {
  // "Unpriced" is about the union of the matching segments, not about whether a
  // row happens to have the base shape. Both of these plans price every instant
  // of the year, so neither may advertise a 0.00 minimum or a History banner.
  const dayEvening = rateRowFields({
    id: 'day',
    rate: 0.3,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '06:00',
    end: '22:00',
    months: null,
  });
  const overnight = rateRowFields({
    id: 'overnight',
    rate: 0.12,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '22:00',
    end: '06:00',
    months: null,
  });
  assert.equal(planHasUnpriced([dayEvening, overnight]), false);
  assert.deepEqual(ratePlanRange([dayEvening, overnight]), { min: 0.12, max: 0.3 });

  // A weekday/weekend all-day pair covers the same 24 h with no base row at all.
  const weekdays = rateRowFields({
    ...baseRateRow('weekday', '0.3', null, null),
    days: [0, 1, 2, 3, 4],
  });
  const weekend = rateRowFields({ ...baseRateRow('weekend', '0.2', null, null), days: [5, 6] });
  assert.equal(planHasUnpriced([weekdays, weekend]), false);
  assert.deepEqual(ratePlanRange([weekdays, weekend]), { min: 0.2, max: 0.3 });

  // The hours a base-less window leaves open are still unpriced...
  assert.equal(planHasUnpriced([dayEvening]), true);
  assert.deepEqual(ratePlanRange([dayEvening]), { min: 0, max: 0.3 });
  // ...and a base makes the same window fully priced.
  const allYearBase = rateRowFields(baseRateRow('base', '0.25', null, null));
  assert.equal(planHasUnpriced([allYearBase, dayEvening]), false);
  // A row with no usable price prices nothing, however wide its shape.
  assert.equal(planHasUnpriced([rateRowFields(baseRateRow('empty', '', null, null))]), true);
});

test('the advertised plan range includes 0 exactly when some instant is unpriced', () => {
  const allYearBase = rateRowFields(baseRateRow('base', '0.3', null, null));
  const dateBase = rateRowFields({ ...summerDates, rate: 0.2 });
  const dateWindow = rateRowFields({
    ...summerDates,
    id: 'peak',
    rate: 0.32,
    start: '16:00',
    end: '19:00',
  });
  assert.deepEqual(ratePlanRange([allYearBase]), { min: 0.3, max: 0.3 });
  assert.deepEqual(ratePlanRange([allYearBase, rateRowFields(winterPeak)]), {
    min: 0.3,
    max: 0.32,
  });
  assert.deepEqual(ratePlanRange([dateBase]), { min: 0, max: 0.2 });
  assert.deepEqual(ratePlanRange([dateWindow]), { min: 0, max: 0.32 });
  assert.deepEqual(ratePlanRange([allYearBase, dateWindow]), { min: 0.3, max: 0.32 });
});

test('previewRate reports base, override, uncovered date and unpriced hour', () => {
  const base = rateRowFields({ ...summerDates, rate: 0.2 });
  const peak = rateRowFields({
    ...summerDates,
    id: 'summer-peak',
    rate: 0.32,
    start: '16:00',
    end: '19:00',
  });
  const at = (dateValue) => previewRate([base, peak], '0.31', dateValue);

  const baseHit = at(new Date(2026, 6, 15, 12, 0));
  assert.equal(baseHit.source, 'base');
  assert.equal(baseHit.rate, 0.2);
  assert.equal(baseHit.tier, 'Base');
  assert.equal(baseHit.baseRate, 0.2);
  assert.equal(baseHit.uncoveredDate, false);

  const peakHit = at(new Date(2026, 6, 15, 17, 0));
  assert.equal(peakHit.source, 'window');
  assert.equal(peakHit.rate, 0.32);
  assert.equal(peakHit.tier, 'Peak');
  assert.equal(peakHit.baseRate, 0.2);
  assert.match(peakHit.summary, /Every day · 16:00–19:00/);

  const offSeason = previewRate([base], '0.31', new Date(2026, 0, 15, 12, 0));
  assert.equal(offSeason.rate, 0);
  assert.equal(offSeason.source, 'uncovered');
  assert.equal(offSeason.uncoveredDate, true);
  assert.equal(offSeason.unpricedHour, false);

  const baseLess = previewRate(
    [rateRowFields({ ...nightEveryDay, months: null })],
    '0.31',
    new Date(2026, 0, 15, 12, 0),
  );
  assert.equal(baseLess.rate, 0);
  assert.equal(baseLess.source, 'uncovered');
  assert.equal(baseLess.uncoveredDate, false);
  assert.equal(baseLess.unpricedHour, true);
});

test('rateSegmentLabel names base, override, base-less window and uncovered time', () => {
  const base = { window: summerDates, source: 'base', rate: 0.2 };
  const override = {
    window: { ...summerDates, start: '16:00', end: '19:00' },
    source: 'window',
    rate: 0.32,
  };
  assert.equal(rateSegmentLabel(base, [0.2], 0.2), 'Base');
  assert.equal(rateSegmentLabel(override, [0.2, 0.32], 0.2), 'Peak');
  assert.equal(rateSegmentLabel(override, [0.32], null), 'Window');
  assert.equal(rateSegmentLabel({ window: null, rate: 0 }, [], null), 'Uncovered');
});

test('a base price error focuses the Base rate field, a window error its rate', () => {
  const base = validateRateEditorRows([baseRateRow('base', '', null, null)]);
  assert.deepEqual(submitFocusTarget({ rateValidation: base }), {
    kind: 'row',
    index: 0,
    focus: 'base-rate',
  });
  assert.equal(base.bases[0], true);
  const window = validateRateEditorRows([rateRowFields({ ...nightEveryDay, rate: '' })]);
  assert.deepEqual(submitFocusTarget({ rateValidation: window }), {
    kind: 'row',
    index: 0,
    focus: 'rate',
  });
});

test('base-less seasons and date gaps are warnings, not validation problems', () => {
  const base = rateRowFields({ ...summerDates, rate: 0.2 });
  const windowOnly = rateRowFields({ ...summerDates, start: '16:00', end: '19:00' });
  assert.equal(validationProblemCount(validateRateEditorRows([base])), 0);
  assert.equal(validationProblemCount(validateRateEditorRows([windowOnly])), 0);
  assert.equal(
    validationProblemCount(validateRateEditorRows([baseRateRow('empty', '', null, null)])),
    1,
  );
  assert.equal(
    validationProblemCount(
      validateRateEditorRows([
        rateRowFields(baseRateRow('base', '0.3', null, null)),
        rateRowFields({ ...baseRateRow('second', '0.4', null, null) }),
      ]),
    ),
    2,
  );
});

test('the payload keeps a base before its windows and the date fields in place', () => {
  const base = rateRowFields(baseRateRow('base', '0.3', null, null));
  const window = rateRowFields({
    ...nightEveryDay,
    id: 'night',
    rate: 0.1,
    start: '22:00',
    end: '06:00',
  });
  const payload = settingsPayload({ rate: 0.31, currency: 'USD', rates: [base, window] });
  assert.deepEqual(Object.keys(payload), ['rate', 'currency', 'rates']);
  assert.deepEqual(
    payload.rates.map((row) => row.id),
    ['base', 'night'],
  );
  assert.deepEqual(Object.keys(payload.rates[0]), ['id', 'rate', 'days', 'start', 'end', 'months']);
  const datePayload = settingsPayload({
    rate: 0.31,
    currency: 'USD',
    rates: [{ ...payload.rates[0], months: [6], from: '06-15', to: '09-15' }],
  });
  assert.deepEqual(Object.keys(datePayload.rates[0]), [
    'id',
    'rate',
    'days',
    'start',
    'end',
    'months',
    'from',
    'to',
  ]);
  assert.equal(datePayload.rates[0].from, '06-15');
  assert.equal(datePayload.rates[0].to, '09-15');
});

test('Add base is withheld when another base already overlaps the season', () => {
  const allYear = rateRowFields(baseRateRow('base', '0.3', null, null));
  const summerWindow = rateRowFields({
    ...summerDates,
    id: 'summer-peak',
    start: '16:00',
    end: '19:00',
  });
  const summer = ratePeriods([summerWindow])[0];
  assert.equal(periodHasBaseOverlap(summer, [summerWindow]), false);
  assert.equal(periodHasBaseOverlap(summer, [allYear, summerWindow]), true);
  const winter = ratePeriods([
    rateRowFields({ ...summerWindow, id: 'winter-peak', months: [11, 12, 1, 2] }),
  ])[0];
  assert.equal(periodHasBaseOverlap(winter, [allYear, summerWindow]), true);
  const disjoint = ratePeriods([summerWindow])[0];
  assert.equal(
    periodHasBaseOverlap(disjoint, [
      rateRowFields(baseRateRow('winter-base', '0.3', [11, 12])),
      summerWindow,
    ]),
    false,
  );
});

test('a row that became the season base is not "another season’s base"', () => {
  // Defect guard: editing a window into the all-day, every-day shape moves it out
  // of the window list and into the Base rate block. The overlap check asks
  // "would another season's base collide?", so it must not count the season's own
  // new base and tell the owner a sibling prices these hours.
  const allYear = rateRowFields(baseRateRow('other-base', '0.3', null, null));
  const becomingBase = rateRowFields({
    ...summerDates,
    id: 'becoming-base',
    start: '00:00',
    end: '00:00',
    days: [0, 1, 2, 3, 4, 5, 6],
  });
  const period = ratePeriods([becomingBase])[0];
  assert.equal(period.mode, 'base');
  assert.equal(period.base.index, 0);
  assert.equal(periodHasBaseOverlap(period, [becomingBase]), false);
  assert.equal(periodHasBaseOverlap(period, [allYear, becomingBase]), true);

  // A malformed all-day row repaired into the base shape keeps its own place.
  const malformed = rateRowFields({ ...summerDates, id: 'malformed', start: '00:00', end: '' });
  const beforeRepair = ratePeriods([malformed])[0];
  assert.equal(beforeRepair.mode, 'windows');
  assert.equal(periodHasBaseOverlap(beforeRepair, [malformed]), false);
});

test('month chips are the legacy path, not the normal scope editor', () => {
  // M4 guard: dates are the only normal path. The month disclosure is offered
  // only where dates cannot express the stored scope.
  const dateSeason = ratePeriods([rateRowFields(summerDates)])[0];
  assert.equal(monthEditorIsLegacy(dateSeason), false);

  const allYear = ratePeriods([rateRowFields(nightEveryDay)])[0];
  assert.equal(monthEditorIsLegacy(allYear), false);

  // A contiguous legacy month range reaches its scope through the date fields.
  const contiguous = ratePeriods([rateRowFields({ ...nightEveryDay, months: [11, 12, 1, 2] })])[0];
  assert.equal(contiguous.kind, 'months');
  assert.notEqual(periodDateSeed(contiguous), null);
  assert.equal(monthEditorIsLegacy(contiguous), false);

  // A non-contiguous list has no single date range: the chips are the only
  // editor that can show it.
  const split = ratePeriods([rateRowFields({ ...nightEveryDay, months: [1, 6] })])[0];
  assert.equal(periodDateSeed(split), null);
  assert.equal(monthEditorIsLegacy(split), true);

  // A malformed month value has to be repaired with the chips too.
  const malformed = ratePeriods([rateRowFields({ ...nightEveryDay, months: 3 })])[0];
  assert.equal(malformed.kind, 'invalid');
  assert.equal(monthEditorIsLegacy(malformed), true);

  // A malformed stored list whose valid entries are contiguous: the scope
  // sanitizes to one run (months [1, 13] reads as January), so the run-count test
  // alone would hide the only editor that can rewrite it.
  for (const months of [
    [1, 13],
    [1, 1],
    [0, 5],
    [5, 'x'],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1],
  ]) {
    const period = ratePeriods([rateRowFields({ ...nightEveryDay, months })])[0];
    assert.equal(monthEditorIsLegacy(period), true, JSON.stringify(months));
  }
  // The canonical all-year list and the stored All-year value are not malformed.
  const canonical = ratePeriods([
    rateRowFields({ ...nightEveryDay, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }),
  ])[0];
  assert.equal(canonical.kind, 'all');
  assert.equal(monthEditorIsLegacy(canonical), false);
});

test('plan edits never change the stored flat rate', () => {
  // Gap 3 guard: the flat `rate` is the One-rate price, and the season editors
  // only ever touch the rows. A scope edit therefore cannot reprice One rate.
  const rows = [rateRowFields(nightEveryDay), rateRowFields(winterPeak)];
  const reScoped = applyPeriodDates(applyPeriodMonths(rows, [0], [6, 7]), [0], '06-01', '08-31');
  const days = reScoped.map((row, index) =>
    index === 0 ? { ...row, days: [5, 6], start: '22:00', end: '06:00' } : row,
  );
  const payload = settingsPayload(
    validateSettings({ rate: '0.31', currency: 'USD', rates: days }).values,
  );
  assert.equal(payload.rate, 0.31);
  assert.equal(payload.currency, 'USD');
  assert.equal(payload.rates.length, 2);

  // A flat payload stays byte-identical: two fields, no empty `rates` key.
  assert.deepEqual(settingsPayload(validateSettings({ rate: '0.31', currency: 'USD' }).values), {
    rate: 0.31,
    currency: 'USD',
  });
});
