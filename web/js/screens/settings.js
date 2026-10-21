// App-settings card: the all-other-times rate first, then an optional plan of
// month or date seasons with daily windows, and a checker that reads the draft.
//
// The stored document keeps one flat `rates` list; periods are a presentation
// over each row's shared scope (`months`, or `from`/`to`), so grouping never
// changes the payload or the matching order. A period owns its scope; the rows
// inside it inherit it and have no scope control of their own. All edits flow
// through the same draft/dirty/saved/waiting/error machine, and a failed write
// still reconciles back to the last confirmed server state.

import { fmtRate } from '../format.js';
import { DAY_NAMES } from '../schedule.js';
import { $, setText } from '../ui.js';
import {
  DAY_PRESETS,
  MIX_COVERAGE_MESSAGE,
  MONTH_NAMES,
  OFFLINE_MESSAGE,
  RATE_CAP_REMEDY,
  SEASON_RATE_MIX_MESSAGE,
  applyPeriodDates,
  applyPeriodMonths,
  canDuplicatePeriod,
  complementScope,
  copyPeriodRows,
  dateInputValue,
  dateRangeHint,
  dateRangeText,
  dateSetText,
  dayPresetFor,
  defaultRateRow,
  formatPreviewWhen,
  isAllDayWindow,
  isSeasonRateRow,
  largestDateScope,
  largestMonthRun,
  minutesToClock,
  nextWindowPreset,
  normalizeSettings,
  parseLocalDateTime,
  periodCoverage,
  periodDateBounds,
  periodDateSeed,
  periodEffectiveRange,
  periodHasDates,
  periodRateMode,
  periodRowScope,
  planProblemText,
  previewBlocker,
  previewRate,
  rateIsUsable,
  ratePeriods,
  ratePlanRange,
  rateRowFields,
  rateScopeText,
  rateSegmentLabel,
  rateTierFor,
  rateWindowSummary,
  reconcileSettingsSave,
  saveButtonState,
  scopesOverlap,
  segmentNote,
  settingsDraftMatches,
  settingsFields,
  settingsSaveState,
  siblingNote,
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
} from '../settings.js';
import { MAX_RATE_WINDOWS, monthsCovering, parseRateValue } from '../rates.js';
import { saveSettings as persistSettings } from '../store.js';
import { settleWrite } from '../write.js';

// Last server-confirmed settings and the form state built from them. The flat
// fields live in their inputs; the rate rows live in `draftRates`, with the
// rendered controls in `windowCards`. Saving disables editing so there is no
// mid-write drift.
let confirmedSettings = null;
// A snapshot that arrived while a write was in flight. The wrapper keeps "no
// snapshot arrived" distinct from "the document is missing".
let pendingSettings = null;
let settingsDirty = false;
let settingsSaving = false;
let settingsWaiting = false;
let settingsSaved = false;
let settingsError = '';
let settingsGeneration = 0;
// The plan draft in the editable shape from rateRowFields().
let draftRates = [];
// The periods derived from the draft, in render order.
let planPeriods = [];
// Rendered cards. `windowCards` is indexed by the draft array position.
let periodCards = [];
let windowCards = [];
// Periods the owner opened. Collapsed is the default so a returning owner sees
// the whole plan at a glance; malformed periods open on load.
let expandedPeriods = new Set();
// The period whose destructive confirmation is showing.
let removeConfirmKey = null;
let rateValidation = validateRateEditorRows([]);

function readFields() {
  return {
    rate: $('setting-rate').value,
    currency: $('setting-currency').value,
    rates: draftRates,
  };
}

function currency() {
  return $('setting-currency').value.trim();
}

function paintFieldError(field, message) {
  const input = $(`setting-${field}`);
  const node = $(`${field}-error`);
  input.setAttribute('aria-invalid', String(Boolean(message)));
  node.hidden = !message;
  setText(node, message);
}

function renderErrors(errors = {}) {
  for (const field of ['rate', 'currency']) paintFieldError(field, errors[field] || '');
}

// ---------- small DOM helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function scrollToNode(node) {
  node.scrollIntoView({
    block: 'center',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function windowRates() {
  return draftRates.map((row) => row && row.rate);
}

function tierClass(tier) {
  // A season rate is its own band: it is not a relative tier, so it gets its own
  // name and dot wherever a band is drawn.
  if (tier === 'Season rate') return 'season';
  if (tier === 'Off-peak') return 'off';
  if (tier === 'Peak') return 'peak';
  if (tier === 'Shoulder') return 'shoulder';
  return 'same';
}

// The legend's order, cheap to expensive with the fallback last. The labels are
// never listed here: they come from the same resolved segments the table names,
// so a band cannot be "Off-peak" in the legend and "Season rate" in the row.
const LEGEND_ORDER = ['season', 'off', 'shoulder', 'peak', 'same', 'base'];

function segmentClass(segment) {
  if (!segment || !segment.window) return 'base';
  return tierClass(rateSegmentLabel(segment, windowRates(), readFields().rate));
}

function windowName(row) {
  const tier = bandName(row);
  return `${tier ? `${tier} ` : ''}${rateWindowSummary(row)}`;
}

// A row's visible band. A season rate is named for what it is: the price tier a
// relative comparison invents ("Off-peak", "Same price") would title a
// whole-season price with a band the owner never chose, contradicting the
// "one price for every hour" note on the same card.
function bandName(row) {
  if (isSeasonRateRow(row)) return 'Season rate';
  return rateTierFor(row && row.rate, windowRates(), readFields().rate);
}

// A new window is the everyday overnight preset for a first window, and the
// weekday evening peak once the period already has a window — the two shapes
// most tariffs start from. The price stays empty so it cannot be saved by
// accident. `dates` carries the period's day-precision bounds the same way
// `months` carries its month scope, so a window added inside a date season stays
// in that season instead of forming a second, month-wide one.
function newWindowRow(months, preset, dates = null) {
  const row = defaultRateRow(crypto.randomUUID(), months, dates);
  if (preset === 'peak') {
    row.days = [0, 1, 2, 3, 4];
    row.start = '16:00';
    row.end = '19:00';
  }
  return row;
}

// A season rate is the everyday all-day window: one price for every hour in the
// season. The empty price keeps it visibly incomplete until the owner sets it.
function seasonRateRow(months, dates = null) {
  const row = defaultRateRow(crypto.randomUUID(), months, dates);
  row.days = [0, 1, 2, 3, 4, 5, 6];
  row.start = '00:00';
  row.end = '00:00';
  return row;
}

// The stored date spelling split back into the two controls. Invalid values
// stay visible: a day of 30 in February must not silently become a blank field
// or a different day.
function splitMonthDay(value) {
  const text = typeof value === 'string' ? value : '';
  const [monthText = '', dayText = ''] = text.split('-');
  const month = /^\d{1,2}$/.test(monthText) ? Number(monthText) : 0;
  const day = /^\d{1,2}$/.test(dayText) ? Number(dayText) : 0;
  return {
    month: month >= 1 && month <= 12 ? month : 0,
    // Keep an out-of-range day visible (February 30, a hand-edited 32) rather
    // than blanking the value the owner needs to see and fix.
    day: Number.isInteger(day) && day > 0 ? day : 0,
  };
}

// Build the MM-DD spelling from the controls. A missing half becomes 00, which
// the engine rejects and the field error names; returning null instead would
// drop date mode and silently fall back to the old month scope.
function dateControlValue(monthValue, dayValue) {
  const month = Number(monthValue) || 0;
  const day = Number(dayValue) || 0;
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function priceText(rate) {
  return fmtRate(rate, currency());
}

// A price cell breaks between the currency code and the amount rather than
// running under the band column: the code can be CURRENCY_MAX (8) characters
// and the 30% price column at 320 px cannot hold "US cents" and "0.315" on one
// line. Each half stays unbreakable, so a number never splits.
function priceCell(rate) {
  const td = el('td', 'price');
  const text = priceText(rate);
  const code = currency();
  if (!code || !text.startsWith(code) || text.length <= code.length) {
    td.textContent = text;
    return td;
  }
  const rest = text.slice(code.length);
  const amount = rest.startsWith(' ') ? rest.slice(1) : rest;
  const cell = [el('span', 'price-code', code)];
  if (amount !== rest) cell.push(' ');
  cell.push(el('span', 'price-amount', amount));
  td.append(...cell);
  return td;
}

// A PRICE cell for a row whose own price is still missing. Words, not a money
// run: the plan summary, the card meta and the checker say the same.
function needsAttentionCell() {
  return el('td', 'price needs-attention', '— needs attention');
}

// "USD 0.20–0.32", not "USD 0.20–USD 0.32": one currency for a range.
function priceRangeText(range) {
  if (!range) return '';
  if (range.min === range.max) return priceText(range.min);
  return `${priceText(range.min)}–${fmtRate(range.max, '')}`;
}

// Keep "other times USD 0.31" and "USD 0.10–0.32" together when a summary
// wraps; breaking inside a price reads as two different numbers. A class, not an
// NBSP substitution, so a break after the en dash is prevented too.
function nowrapEl(text) {
  return el('span', 'nowrap', text);
}

function markEdited() {
  // Recompute before clearing: an edit that returns the row to the confirmed
  // schedule must not discard a save failure the form still describes.
  if (!settingsDraftMatches(readFields(), confirmedSettings)) {
    settingsSaved = false;
    settingsError = '';
  }
}

// The whole card's derived state. Structural changes call renderPlan(); typing
// only repaints the parts that are not focused, so an input never loses focus
// mid-edit.
function refresh() {
  rateValidation = validateRateEditorRows(draftRates, $('setting-rate').value);
  paintPlan();
  paintRateValidation();
  paintPreview();
  paintFeedback();
}

// ---------- window rows ----------

function paintDayControl(card) {
  const derived = dayPresetFor(card.row.days);
  if (derived === 'custom') card.customDays = true;
  const selected = card.customDays ? 'custom' : derived;
  card.presetEls.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.preset === selected));
  });
  card.daysEl.hidden = !card.customDays;
  for (const chip of card.daysEl.querySelectorAll('[data-day]')) {
    chip.setAttribute('aria-pressed', String(card.row.days.includes(Number(chip.dataset.day))));
  }
}

function paintTimeControl(card) {
  // A stored all-day window reads "All day". "Set times" only reveals the
  // fields (it never invents a start/end), and the fields stay visible while
  // focus is anywhere in the time row; once focus leaves an unchanged all-day
  // window, the compact line returns.
  const allDay = isAllDayWindow(card.row);
  const focusWithin = Boolean(card.timeRow && card.timeRow.contains(document.activeElement));
  const show = timeFieldsVisible({ allDay, timesOpen: card.timesOpen, focusWithin });
  card.timeRow.hidden = !show;
  card.allDayRow.hidden = show;
}

function paintWindowCard(card) {
  const row = card.row;
  const name = windowName(row);
  const band = bandName(row);
  setText(card.title, band || (String(row.rate ?? '').trim() === '' ? 'New window' : 'Window'));
  setText(card.summary, rateWindowSummary(row));
  card.rateInput.setAttribute('aria-label', `Rate for ${rateWindowSummary(row)}`);
  card.removeButton.setAttribute('aria-label', `Remove the ${rateWindowSummary(row)} window`);
  card.startInput.setAttribute('aria-label', `Start time for ${rateWindowSummary(row)}`);
  card.endInput.setAttribute('aria-label', `End time for ${rateWindowSummary(row)}`);
  card.presetsEl.setAttribute('aria-label', `Days for ${rateWindowSummary(row)}`);
  card.daysEl.setAttribute('aria-label', `Custom days for ${rateWindowSummary(row)}`);
  card.title.title = name;
  paintDayControl(card);
  paintTimeControl(card);
  // A season rate has no day or time choice: the period's note explains the
  // single price, and the conversion button is the way back to daily windows.
  // A malformed all-day time (25:00–25:00) still counts as the all-day shape, so
  // keep its controls visible until the time error is fixed.
  const rowErrors = rateValidation.rows[card.index] || {};
  const seasonRate = Boolean(
    card.periodCard &&
    card.periodCard.period &&
    card.periodCard.period.seasonRate &&
    !rowErrors.start &&
    !rowErrors.end,
  );
  if (card.dayControl) card.dayControl.hidden = seasonRate;
  if (card.timeBlock) card.timeBlock.hidden = seasonRate;
}

function createDayControl(card) {
  const wrap = el('div', 'day-control');
  const presets = el('div', 'day-presets');
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-describedby', card.errorId);
  DAY_PRESETS.forEach((preset) => {
    const button = el('button', 'preset', preset.label);
    button.type = 'button';
    button.dataset.preset = preset.id;
    button.addEventListener('click', () => {
      if (preset.days) {
        card.row.days = [...preset.days];
        card.customDays = false;
        markEdited();
        refresh();
        return;
      }
      // Custom only reveals the chips; it never changes the days by itself.
      card.customDays = true;
      paintDayControl(card);
    });
    card.presetEls.push(button);
    presets.append(button);
  });

  const days = el('div', 'plan-days');
  days.setAttribute('role', 'group');
  days.setAttribute('aria-describedby', card.errorId);
  DAY_NAMES.forEach((name, day) => {
    const chip = el('button', 'plan-day', name);
    chip.type = 'button';
    chip.dataset.day = String(day);
    chip.addEventListener('click', () => {
      if (card.row.days.includes(day)) {
        card.row.days = card.row.days.filter((value) => value !== day);
      } else {
        card.row.days = [...card.row.days, day].sort((a, b) => a - b);
      }
      card.customDays = true;
      markEdited();
      refresh();
    });
    days.append(chip);
  });
  wrap.append(presets, days);
  card.presetsEl = presets;
  card.daysEl = days;
  return wrap;
}

function createWindowCard(entry, periodCard) {
  const row = entry.row;
  const index = entry.index;
  const node = el('article', 'rate-window');
  node.dataset.id = row.id;
  const errorId = `rate-window-error-${index}`;
  const card = {
    row,
    index,
    node,
    errorId,
    periodCard,
    title: null,
    summary: null,
    rateInput: null,
    dayControl: null,
    daysEl: null,
    presetsEl: null,
    presetEls: [],
    customDays: dayPresetFor(row.days) === 'custom',
    startInput: null,
    endInput: null,
    timeBlock: null,
    timeRow: null,
    allDayRow: null,
    timesOpen: false,
    errorEl: null,
    removeButton: null,
  };

  const head = el('div', 'rate-window-head');
  const heading = el('div', 'rate-window-title');
  const title = el('h6', 'rate-title');
  const summary = el('p', 'rate-summary');
  heading.append(title, summary);
  const remove = el('button', 'rate-remove', 'Remove');
  remove.type = 'button';
  remove.addEventListener('click', () => removeWindow(card));
  head.append(heading, remove);
  card.title = title;
  card.summary = summary;
  card.removeButton = remove;

  const rateWrap = el('div', 'input-wrap');
  const rateInput = el('input', 'text-input rate-input');
  rateInput.type = 'number';
  rateInput.min = '0';
  rateInput.max = '5';
  rateInput.step = '0.001';
  rateInput.inputMode = 'decimal';
  // No placeholder: a `0.000` in an empty field reads as a planted price beside
  // the "Enter a rate between 0 and 5." rule. The label, the `/ kWh` suffix and
  // that error carry the rule; the field itself stays visibly empty until the
  // owner types their price.
  rateInput.autocomplete = 'off';
  rateInput.value = row.rate;
  rateInput.setAttribute('aria-describedby', errorId);
  const suffix = el('span', 'input-suffix', '/ kWh');
  suffix.setAttribute('aria-hidden', 'true');
  rateWrap.append(rateInput, suffix);
  const rateField = el('label', 'field rate-amount');
  rateField.append(el('span', 'field-label', 'Rate'), rateWrap);
  rateInput.addEventListener('input', () => {
    row.rate = rateInput.value;
    markEdited();
    refresh();
  });
  card.rateInput = rateInput;

  const dayControl = createDayControl(card);
  card.dayControl = dayControl;

  const timeBlock = el('div', 'time-block');
  const times = el('div', 'time-row');
  const startInput = el('input');
  startInput.type = 'time';
  startInput.value = row.start;
  startInput.setAttribute('aria-describedby', errorId);
  const startField = el('label', 'field');
  startField.append(el('span', 'field-label', 'Start'), startInput);
  const endInput = el('input');
  endInput.type = 'time';
  endInput.value = row.end;
  endInput.setAttribute('aria-describedby', errorId);
  const endField = el('label', 'field');
  endField.append(el('span', 'field-label', 'End'), endInput);
  const sep = el('span', 'time-sep', '→');
  sep.setAttribute('aria-hidden', 'true');
  times.append(startField, sep, endField);
  const onTime = () => {
    row.start = startInput.value;
    row.end = endInput.value;
    markEdited();
    refresh();
  };
  startInput.addEventListener('input', onTime);
  endInput.addEventListener('input', onTime);
  // The compact line appears once focus leaves the whole time block, not on
  // Start's blur: blur fires before End receives focus, so collapsing there hid
  // the row mid-move and made an End-led edit unreachable. `relatedTarget` names
  // where focus is going; when it is missing, re-check after the move settles.
  const onTimeExit = (event) => {
    if (card.timeRow.contains(event.relatedTarget)) return;
    requestAnimationFrame(() => {
      if (card.timeRow.contains(document.activeElement)) return;
      if (isAllDayWindow(row)) card.timesOpen = false;
      paintWindowCard(card);
    });
  };
  timeBlock.addEventListener('focusout', onTimeExit);

  const allDayRow = el('div', 'all-day-row');
  allDayRow.append(el('span', 'all-day-text', 'All day'));
  const setTimes = el('button', 'link-btn', 'Set times');
  setTimes.type = 'button';
  setTimes.setAttribute('aria-label', `Set start and end times for ${rateWindowSummary(row)}`);
  setTimes.addEventListener('click', () => {
    if (settingsSaving) return;
    // Reveal the existing fields without rewriting the stored all-day window.
    card.timesOpen = true;
    paintTimeControl(card);
    startInput.focus({ preventScroll: true });
  });
  allDayRow.append(setTimes);
  timeBlock.append(times, allDayRow);
  card.startInput = startInput;
  card.endInput = endInput;
  card.timeBlock = timeBlock;
  card.timeRow = times;
  card.allDayRow = allDayRow;

  const errorEl = el('p', 'rule-error rate-error');
  errorEl.id = errorId;
  errorEl.hidden = true;
  card.errorEl = errorEl;

  node.append(head, rateField, dayControl, timeBlock, errorEl);
  paintWindowCard(card);
  return card;
}

// ---------- period cards ----------

function paintMonthEditor(card) {
  const all = card.period.kind === 'all';
  const months = card.period.kind === 'months' ? card.period.months : [];
  card.allYear.checked = all;
  for (const chip of card.monthChips.querySelectorAll('[data-month]')) {
    chip.setAttribute('aria-pressed', String(all || months.includes(Number(chip.dataset.month))));
  }
}

// A date commit can be repainted in place (see applyDates), which does not
// rebuild the date panel: sync the controls from the model so the bound the
// owner did not type still follows the commit. The focused control is left
// exactly as typed.
function syncDateControls(card, bounds) {
  const from = splitMonthDay(bounds.from);
  const to = splitMonthDay(bounds.to);
  const set = (control, value) => {
    if (!control || control === document.activeElement) return;
    if (control.value !== value) control.value = value;
  };
  set(card.fromMonth, from.month ? String(from.month) : '');
  set(card.fromDay, from.day ? String(from.day) : '');
  set(card.toMonth, to.month ? String(to.month) : '');
  set(card.toDay, to.day ? String(to.day) : '');
}

// The scope controls are derived from the rows, not a stored mode: dates when
// either bound is present (even a broken one, so it stays visible), months
// otherwise. The disabled reason is visible next to the segmented control, not
// only in a title.
function paintScopeEditor(card) {
  const period = card.period;
  const dateMode = periodHasDates(period);
  const bounds = periodDateBounds(period);
  const seed = dateMode ? null : periodDateSeed(period);
  const monthsFromDates = dateMode ? monthsCovering(bounds.from, bounds.to) : [];
  const canDates = dateMode || Boolean(seed);
  const canMonths = !dateMode || monthsFromDates.length > 0;
  const hint =
    !dateMode && !canDates
      ? period.kind === 'invalid'
        ? 'Fix the months to use specific dates.'
        : 'Specific dates need one continuous range.'
      : '';

  card.monthsMode.setAttribute('aria-pressed', String(!dateMode));
  card.datesMode.setAttribute('aria-pressed', String(dateMode));
  card.monthsMode.disabled = settingsSaving || (dateMode && !canMonths);
  card.datesMode.disabled = settingsSaving || (!dateMode && !canDates);
  card.monthsMode.title = dateMode && !canMonths ? 'Fix the From and To dates first.' : '';
  card.datesMode.title = hint;
  card.scopeHint.hidden = !hint;
  setText(card.scopeHint, hint);
  card.monthPanel.hidden = dateMode;
  card.datePanel.hidden = !dateMode;
  paintMonthEditor(card);

  if (!dateMode) {
    card.dateError.hidden = true;
    card.dateFocus = null;
    return;
  }

  syncDateControls(card, bounds);

  const rowErrors = period.rows.map((entry) => rateValidation.rows[entry.index] || {});
  const fromError = rowErrors.map((errors) => errors.from).find(Boolean) || '';
  const toError = rowErrors.map((errors) => errors.to).find(Boolean) || '';
  const messages = [fromError ? `From: ${fromError}` : '', toError ? `To: ${toError}` : ''].filter(
    Boolean,
  );
  card.dateError.hidden = messages.length === 0;
  setText(card.dateError, messages.join(' '));
  card.fromMonth.setAttribute('aria-invalid', String(Boolean(fromError)));
  card.fromDay.setAttribute('aria-invalid', String(Boolean(fromError)));
  card.toMonth.setAttribute('aria-invalid', String(Boolean(toError)));
  card.toDay.setAttribute('aria-invalid', String(Boolean(toError)));
  card.dateFocus = fromError ? card.fromDay : toError ? card.toDay : card.fromDay;

  const base = canMonths
    ? 'Dates are inclusive and repeat every year. Switching to Months rounds them to whole months.'
    : 'Fix the From and To dates before switching to Months.';
  const wrapHint = dateRangeHint(bounds.from, bounds.to);
  setText(card.dateHint, wrapHint ? `${base} ${wrapHint}` : base);
}

function paintPeriodMode(card) {
  const mode = periodRateMode(card.period);
  const oneRow = card.period.rows.length === 1;
  const usable = card.period.kind !== 'invalid';
  card.addButton.hidden = mode !== 'tou' || !usable;
  card.seasonNote.hidden = mode !== 'season';
  card.mixNote.hidden = mode !== 'mixed';
  card.useTou.hidden = mode !== 'season' || !oneRow || !usable;
  card.useSeason.hidden = mode !== 'tou' || !oneRow || !usable;
  card.useTou.disabled = settingsSaving;
  card.useSeason.disabled = settingsSaving;
}

function periodName(period) {
  return period.title === 'Custom months' ? period.monthText : period.title;
}

// The header tells the truth for the representative month: the price range
// includes the fallback and any sibling windows that apply there, while the
// count stays the period's own windows.
function paintPeriodHeader(card) {
  const period = card.period;
  const dateMode = periodHasDates(period);
  const dateBounds = periodDateBounds(period);
  const dateText =
    dateMode && dateBounds.from && dateBounds.to
      ? dateRangeText(dateBounds.from, dateBounds.to)
      : '';
  const showMonths = dateMode || period.monthText !== period.title;
  setText(
    card.band,
    dateMode ? dateText || 'Dates need fixing' : showMonths ? period.monthText : '',
  );
  card.band.hidden = !showMonths;
  card.band.classList.toggle('date-range', dateMode && Boolean(dateText));

  const range = periodEffectiveRange(draftRates, readFields().rate, period);
  const count = period.rows.length;
  // A season rate is one price, not a window: naming it a window contradicts the
  // row title and the plan summary.
  const noun = period.seasonRate
    ? count === 1
      ? 'rate'
      : 'rates'
    : count === 1
      ? 'window'
      : 'windows';
  const countText = `${count} ${noun}`;
  // The range covers one representative month (January for an all-year scope,
  // otherwise the first month of the scope). Naming it keeps an All-year header
  // from advertising a range that a July sibling changes; the table caption
  // repeats the same month.
  const example = range && !dateMode ? `${MONTH_NAMES[range.month - 1].slice(0, 3)} example` : '';
  // A row with no usable price contributes nothing to the range, so a range that
  // only the fallback fills would advertise a price this season does not charge.
  // The plan summary and the checker say the same thing at the same moment.
  const ownPriced = period.rows.some((entry) => {
    const price = parseRateValue(entry.row.rate);
    return (
      Number.isFinite(price) && Object.keys(rateValidation.rows[entry.index] || {}).length === 0
    );
  });
  const meta = [el('span', null, `${countText} · ${example ? `${example} ` : ''}`)];
  if (period.kind === 'invalid')
    meta.push(el('span', null, dateMode ? 'needs dates' : 'needs months'));
  else if (!ownPriced || !range) meta.push(nowrapEl('— needs attention'));
  else meta.push(nowrapEl(priceRangeText(range)));
  card.meta.replaceChildren(...meta);
  paintScopeEditor(card);
  paintPeriodMode(card);
}

function setExpanded(card, expanded) {
  if (expanded) expandedPeriods.add(card.key);
  else expandedPeriods.delete(card.key);
  card.toggle.setAttribute('aria-expanded', String(expanded));
  card.body.hidden = !expanded;
}

function paintPeriodActions(card) {
  const confirming = removeConfirmKey === card.key;
  const count = card.period.rows.length;
  const complement = complementScope(card.period);
  // A duplicate with nowhere to go (all year, invalid scope, a complement that
  // another season already covers, or a copy that would exceed the 24-window
  // cap) is not offered at all: a permanently disabled button reads as a broken
  // action.
  const occupied =
    complement != null &&
    planPeriods.some((other) => other.key !== card.key && scopesOverlap(complement, other));
  const canDuplicate =
    complement != null &&
    !occupied &&
    periodRateMode(card.period) !== 'mixed' &&
    canDuplicatePeriod(draftRates.length, count) &&
    !settingsSaving;
  card.duplicateButton.hidden = !canDuplicate || confirming;
  card.removeButton.hidden = confirming;
  card.confirm.hidden = !confirming;
  setText(
    card.confirmText,
    `Remove the season and ${count} ${count === 1 ? 'window' : 'windows'}?`,
  );
  card.duplicateButton.disabled = !canDuplicate;
  card.duplicateButton.title =
    complement && complement.kind === 'dates'
      ? 'Copy this season into the dates it does not cover.'
      : 'Copy this season into the months it does not cover.';
}

// A period's visible name. A month scope reads as its months; a date season adds
// its dates, so two overlapping date seasons are never both just "Season" in the
// band column of a sibling row.
function periodBandLabel(period) {
  const name = periodName(period);
  if (!period || period.kind !== 'dates') return name;
  const dates = period.monthText || '';
  return dates ? `${name} ${dates}` : name;
}

// The 7-day strip is a quiet shape cue in the collapsed header; the tables and
// the hidden description carry the same information in words. Both describe the
// period's own layer for a representative month in its own scope; sibling
// periods that also price that month are named above the tables.
function paintCoverage(card) {
  const period = card.period;
  if (period.kind === 'invalid') {
    const dateMode = periodHasDates(period);
    card.strip.replaceChildren();
    card.axis.hidden = true;
    card.legend.replaceChildren();
    card.coverage.replaceChildren(
      el(
        'p',
        'coverage-empty',
        dateMode
          ? 'No coverage until the dates are valid.'
          : 'Choose months to include these windows.',
      ),
    );
    setText(
      card.desc,
      dateMode
        ? 'This period has unusable dates. Fix the From and To dates to include its windows.'
        : 'This period has no usable months. Choose months to include its windows.',
    );
    return;
  }
  // A hand-edited mix of a season rate and daily windows is rejected by the
  // validator. Drawing the resolver's schedule here would show a base plus
  // override result the editor refuses to save, so the tables are withheld.
  if (periodRateMode(period) === 'mixed') {
    card.strip.replaceChildren();
    card.axis.hidden = true;
    card.legend.replaceChildren();
    card.coverage.replaceChildren(el('p', 'coverage-empty', MIX_COVERAGE_MESSAGE));
    setText(
      card.desc,
      'This season mixes a season rate with daily windows. Fix the mix to see coverage.',
    );
    return;
  }
  // A row whose price is not usable (empty, or finite but outside the accepted
  // range) is rejected by the validator, so the resolved week drops it: its
  // hours fall back to "Other times" and the table would quote a resolved price
  // the plan, the card meta and the checker all deny. Resolve a copy with a
  // stand-in price so the row keeps its place and its band, then put the real
  // (unusable) price back and let the table say the price is missing.
  const unpriced = new Set(
    period.rows.filter((entry) => !rateIsUsable(entry.row.rate)).map((entry) => entry.row.id),
  );
  const coverage = periodCoverage(
    draftRates.map((row) => (row && unpriced.has(row.id) ? { ...row, rate: '0' } : row)),
    readFields().rate,
    period,
    planPeriods,
    new Date().getFullYear(),
  );
  for (const type of coverage.types) {
    for (const segment of type.segments) {
      if (segment.window && unpriced.has(segment.window.id)) {
        segment.window = { ...segment.window, rate: '' };
      }
    }
  }

  // The legend is collected from the same resolved segments the strip and the
  // table draw, so every dot carries the name of the row it stands for. A
  // season rate is "Season rate" here, as in its card title, its table band and
  // the plan — never the relative tier its single price happens to sit at.
  const legend = new Map();
  const strip = [];
  for (const type of coverage.types) {
    const row = el('span', 'strip-row');
    // The strip column is narrow; a long custom day list is summarised here
    // and spelled out in the table caption below.
    const label = type.label.length <= 11 ? type.label : `${type.days.length} days`;
    row.append(el('span', 'strip-day', label));
    const track = el('span', 'strip-track');
    for (const segment of type.segments) {
      const key = segmentClass(segment);
      const piece = el('span', `strip-seg ${key}`);
      piece.style.flexGrow = String(segment.to - segment.from);
      if (!legend.has(key)) {
        legend.set(key, rateSegmentLabel(segment, windowRates(), readFields().rate));
      }
      track.append(piece);
    }
    row.append(track);
    strip.push(row);
  }
  card.axis.hidden = false;
  card.strip.replaceChildren(...strip);

  const items = LEGEND_ORDER.filter((key) => legend.has(key)).map((key) => {
    const item = el('span', 'legend-item');
    item.append(el('span', `legend-dot ${key}`), el('span', null, legend.get(key)));
    return item;
  });
  card.legend.replaceChildren(...items);

  const siblingLines = coverage.siblings.map((sibling) => siblingNote(sibling)).filter(Boolean);
  const ownerOf = (segment) => {
    if (!segment.window) return null;
    if (coverage.ownIds.has(segment.window.id)) return period;
    return planPeriods.find((entry) => entry.rows.some((row) => row.row.id === segment.window.id));
  };
  // A resolved row whose own price is still unusable. Its band stays the row's
  // (or the season's) name; only the price and the hidden description change.
  // The id set is read rather than the segment's rate, which the stand-in pass
  // above has already replaced with a placeholder.
  const needsRate = (segment) => Boolean(segment.window) && unpriced.has(segment.window.id);
  const described = coverage.types
    .map(
      (type) =>
        `${type.label}: ${type.segments
          .map((segment) => {
            const owner = ownerOf(segment);
            const label = !segment.window
              ? 'Other times'
              : needsRate(segment)
                ? 'Needs a rate'
                : owner === period
                  ? rateSegmentLabel(segment, windowRates(), readFields().rate)
                  : `${periodBandLabel(owner)} ${rateSegmentLabel(
                      segment,
                      windowRates(),
                      readFields().rate,
                    )}`;
            return `${minutesToClock(segment.from)}–${minutesToClock(segment.to)} ${label}`;
          })
          .join(', ')}`,
    )
    .join('. ');
  setText(
    card.desc,
    `Effective ${period.kind === 'dates' ? 'dates' : 'week'} for ${coverage.monthName}. ${described}. ${siblingLines.join(' ')}`.replace(
      /\s+/g,
      ' ',
    ),
  );

  const content = [];
  if (siblingLines.length > 0) {
    content.push(
      el(
        'p',
        'coverage-siblings',
        `${siblingLines.join(' ')} The checker shows the combined price.`,
      ),
    );
  }
  if (coverage.types.length === 0) {
    content.push(el('p', 'coverage-empty', 'No usable windows yet.'));
  }
  for (const type of coverage.types) {
    const table = el('table', 'coverage-table');
    const caption = el('caption');
    caption.append(el('span', null, `${type.label} · `));
    if (period.kind === 'dates') caption.append(nowrapEl(coverage.captionText));
    else caption.append(coverage.captionText);
    const thead = el('thead');
    const headRow = el('tr');
    for (const [label, className] of [
      ['Time', null],
      // Own rows show a band; inherited rows name their season as well, so the
      // heading has to cover both.
      ['Season · band', null],
      ['Price', 'price'],
    ]) {
      const th = el('th', className, label);
      th.scope = 'col';
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = el('tbody');
    for (const segment of type.segments) {
      const owner = ownerOf(segment);
      const own = Boolean(segment.window) && owner === period;
      const tr = el('tr', segment.window ? (own ? '' : 'sibling') : 'other-times');
      const time = el('th', null, `${minutesToClock(segment.from)}–${minutesToClock(segment.to)}`);
      time.scope = 'row';
      const note = segmentNote(segment);
      if (note) time.append(el('span', 'segment-note', note));
      const band = el('td', 'band');
      if (own) {
        const tier = bandName(segment.window);
        band.append(el('span', `tier ${tierClass(tier)}`, tier || 'Window'));
      } else if (segment.window) {
        // An inherited row keeps the band dot (so the legend still matches the
        // row) and names the season it came from; the column heading covers
        // "Season · band". The band leads so the dot always sits on the first
        // line. There is no separator glyph between the band and the months: a
        // `·` left at the end of the band's line dangles when the months wrap at
        // 320 px, so the two are only separated by a break opportunity. Each
        // month or date range is its own nowrap run — `Jan–Feb` must not split at
        // the en dash when the cell is narrow.
        const tier = bandName(segment.window);
        const label = el('span', 'sibling-band');
        label.append(el('span', `tier ${tierClass(tier)}`, tier || 'Window'), ' ');
        const ownerLabel = el('span', 'sibling-owner');
        const runs = (owner ? periodBandLabel(owner) : 'Other season').split(', ');
        runs.forEach((run, index) => {
          if (index > 0) ownerLabel.append(', ');
          ownerLabel.append(nowrapEl(run));
        });
        label.append(ownerLabel);
        band.append(label);
      } else {
        band.textContent = 'Other times';
      }
      // An own row with no usable price names the gap: quoting the resolver's
      // fallback here would assert a price the rest of the screen denies.
      const price = needsRate(segment) ? needsAttentionCell() : priceCell(segment.rate);
      tr.append(time, band, price);
      tbody.append(tr);
    }
    table.append(caption, thead, tbody);
    content.push(table);
  }
  card.coverage.replaceChildren(...content);
}

function createPeriodCard(period, index) {
  const node = el('article', 'rate-period');
  node.dataset.key = period.key;
  const card = {
    key: period.key,
    period,
    node,
    toggle: null,
    band: null,
    meta: null,
    flag: null,
    strip: null,
    axis: null,
    legend: null,
    desc: null,
    body: null,
    monthEditor: null,
    scopeEditor: null,
    scopeModes: null,
    monthsMode: null,
    datesMode: null,
    scopeHint: null,
    monthPanel: null,
    datePanel: null,
    fromMonth: null,
    fromDay: null,
    toMonth: null,
    toDay: null,
    dateHint: null,
    dateError: null,
    dateFocus: null,
    seasonNote: null,
    mixNote: null,
    useTou: null,
    useSeason: null,
    allYear: null,
    monthChips: null,
    coverage: null,
    list: null,
    addButton: null,
    duplicateButton: null,
    removeButton: null,
    confirm: null,
    confirmText: null,
    confirmButton: null,
    cancelRemove: null,
    cards: [],
  };

  const heading = el('h5', 'period-heading');
  const toggle = el('button', 'period-toggle');
  toggle.type = 'button';
  const bodyId = `period-body-${index}`;
  const descId = `period-coverage-${index}`;
  toggle.setAttribute('aria-controls', bodyId);
  toggle.setAttribute('aria-describedby', descId);
  const expanded = expandedPeriods.has(period.key);
  toggle.setAttribute('aria-expanded', String(expanded));
  const titleRow = el('span', 'period-title-row');
  const title = el('span', 'period-title', period.title);
  const band = el('span', 'period-band');
  const flag = el('span', 'period-flag');
  flag.hidden = true;
  const caret = el('span', 'period-caret');
  caret.setAttribute('aria-hidden', 'true');
  titleRow.append(title, band, flag, caret);
  const meta = el('span', 'period-meta');
  const strip = el('span', 'period-strip');
  strip.setAttribute('aria-hidden', 'true');
  const axis = el('span', 'strip-axis');
  axis.setAttribute('aria-hidden', 'true');
  for (const tick of ['00', '06', '12', '18', '24']) axis.append(el('span', null, tick));
  card.axis = axis;
  const legend = el('span', 'strip-legend');
  legend.setAttribute('aria-hidden', 'true');
  toggle.append(titleRow, meta, strip, axis, legend);
  heading.append(toggle);
  node.append(heading);
  card.toggle = toggle;
  card.band = band;
  card.meta = meta;
  card.flag = flag;
  card.strip = strip;
  card.legend = legend;

  const desc = el('p', 'sr-only');
  desc.id = descId;
  node.append(desc);
  card.desc = desc;

  const body = el('div', 'period-body');
  body.id = bodyId;
  body.hidden = !expanded;
  card.body = body;

  const scopeEditor = el('div', 'scope-editor');
  const modeRow = el('div', 'scope-modes');
  modeRow.setAttribute('role', 'group');
  modeRow.setAttribute('aria-label', `Season scope for ${periodName(period)}`);
  const monthsMode = el('button', 'scope-mode', 'Months');
  monthsMode.type = 'button';
  monthsMode.dataset.scope = 'months';
  const datesMode = el('button', 'scope-mode', 'Specific dates');
  datesMode.type = 'button';
  datesMode.dataset.scope = 'dates';
  modeRow.append(monthsMode, datesMode);
  const scopeHint = el('p', 'scope-hint');
  scopeHint.id = `period-${index}-scope-hint`;
  scopeHint.hidden = true;
  datesMode.setAttribute('aria-describedby', scopeHint.id);

  const monthPanel = el('div', 'month-panel scope-panel');
  const monthHead = el('div', 'month-editor-head');
  // The segmented control names the mode; this label names what the chips are
  // and keeps All year from reading as a stray checkbox above the grid.
  monthHead.append(el('span', 'field-label', 'Pick months'));
  const toggleLabel = el('label', 'months-toggle');
  const allYear = el('input');
  allYear.type = 'checkbox';
  allYear.id = `period-${index}-all-year`;
  toggleLabel.append(allYear, el('span', null, 'All year'));
  monthHead.append(toggleLabel);
  const monthChips = el('div', 'month-chips');
  monthChips.setAttribute('role', 'group');
  monthChips.setAttribute('aria-label', `Months for ${periodName(period)}`);
  MONTH_NAMES.forEach((name, monthIndex) => {
    const month = monthIndex + 1;
    const chip = el('button', 'month-chip', name.slice(0, 3));
    chip.type = 'button';
    chip.dataset.month = String(month);
    chip.setAttribute('aria-label', name);
    chip.addEventListener('click', () => {
      if (settingsSaving) return;
      // The chip is a toggle: on an all-year scope every chip is pressed, so a
      // click removes that month instead of discarding the other eleven.
      const months = toggledMonthScope(period, month);
      if (!months) return;
      applyMonths(card, months, { focusMonth: month });
    });
    monthChips.append(chip);
  });
  monthPanel.append(monthHead, monthChips);

  const datePanel = el('div', 'date-panel scope-panel');
  const dateBounds = periodDateBounds(period);
  const fromParts = splitMonthDay(dateBounds.from);
  const toParts = splitMonthDay(dateBounds.to);
  const dateHintId = `period-${index}-date-hint`;
  const dateErrorId = `period-${index}-date-error`;
  const monthOptions = (select, selected, label) => {
    const placeholder = el('option', null, 'Month');
    placeholder.value = '';
    select.append(placeholder);
    MONTH_NAMES.forEach((name, monthIndex) => {
      // The two bounds share a row at 390 px; a full month name clips inside
      // the native select, so the option uses the same three-letter form as the
      // month chips and the date band.
      const option = el('option', null, name.slice(0, 3));
      option.value = String(monthIndex + 1);
      if (monthIndex + 1 === selected) option.selected = true;
      select.append(option);
    });
    select.setAttribute('aria-label', label);
    return select;
  };
  const fromMonth = monthOptions(el('select', 'date-select'), fromParts.month, 'From month');
  fromMonth.dataset.field = 'from-month';
  const fromDay = el('input', 'date-day');
  fromDay.dataset.field = 'from-day';
  fromDay.type = 'number';
  fromDay.min = '1';
  fromDay.max = '31';
  fromDay.step = '1';
  fromDay.inputMode = 'numeric';
  fromDay.placeholder = 'Day';
  fromDay.value = fromParts.day ? String(fromParts.day) : '';
  fromDay.setAttribute('aria-label', 'From day');
  const toMonth = monthOptions(el('select', 'date-select'), toParts.month, 'To month');
  toMonth.dataset.field = 'to-month';
  const toDay = el('input', 'date-day');
  toDay.dataset.field = 'to-day';
  toDay.type = 'number';
  toDay.min = '1';
  toDay.max = '31';
  toDay.step = '1';
  toDay.inputMode = 'numeric';
  toDay.placeholder = 'Day';
  toDay.value = toParts.day ? String(toParts.day) : '';
  toDay.setAttribute('aria-label', 'To day');

  const dateBound = (labelText, monthSelect, dayInput) => {
    const group = el('div', 'date-bound');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', labelText);
    const label = el('span', 'field-label', labelText);
    group.append(label);
    const controls = el('div', 'date-controls');
    controls.append(monthSelect, dayInput);
    group.append(controls);
    return group;
  };
  const dateRow = el('div', 'date-row');
  dateRow.append(
    dateBound('From', fromMonth, fromDay),
    (() => {
      const arrow = el('span', 'date-arrow', '→');
      arrow.setAttribute('aria-hidden', 'true');
      return arrow;
    })(),
    dateBound('To', toMonth, toDay),
  );
  const dateHint = el('p', 'scope-date-hint');
  dateHint.id = dateHintId;
  const dateError = el('p', 'rule-error date-error');
  dateError.id = dateErrorId;
  dateError.hidden = true;
  // A direct route from day precision to All year: it clears both bounds and
  // sets months:null without first rounding through the month editor.
  const allYearAction = el('button', 'link-btn date-all-year', 'Use all year');
  allYearAction.type = 'button';
  allYearAction.dataset.action = 'dates-all-year';
  allYearAction.addEventListener('click', () => {
    if (settingsSaving) return;
    applyMonths(card, null, { focusCheckbox: true });
  });
  datePanel.append(dateRow, dateHint, dateError, allYearAction);

  const commitDates = () => {
    if (settingsSaving) return;
    const from = dateControlValue(fromMonth.value, fromDay.value);
    const to = dateControlValue(toMonth.value, toDay.value);
    const current = periodDateBounds(card.period);
    if (from === (current.from ?? null) && to === (current.to ?? null)) return;
    applyDates(card, from, to);
  };
  fromMonth.addEventListener('change', commitDates);
  fromDay.addEventListener('change', commitDates);
  toMonth.addEventListener('change', commitDates);
  toDay.addEventListener('change', commitDates);

  for (const control of [fromMonth, fromDay, toMonth, toDay]) {
    control.setAttribute('aria-describedby', `${dateHintId} ${dateErrorId}`);
  }

  monthsMode.addEventListener('click', () => {
    if (settingsSaving || !periodHasDates(card.period)) return;
    const bounds = periodDateBounds(card.period);
    const months = monthsCovering(bounds.from, bounds.to);
    if (months.length === 0) {
      card.fromDay.focus({ preventScroll: true });
      return;
    }
    applyMonths(card, months, { focusScope: true });
  });
  datesMode.addEventListener('click', () => {
    if (settingsSaving || periodHasDates(card.period)) return;
    const seed = periodDateSeed(card.period);
    if (!seed) return;
    applyDates(card, seed.from, seed.to);
    card.fromDay.focus({ preventScroll: true });
  });

  scopeEditor.append(modeRow, scopeHint, monthPanel, datePanel);
  card.monthEditor = scopeEditor;
  card.scopeEditor = scopeEditor;
  card.scopeModes = modeRow;
  card.monthsMode = monthsMode;
  card.datesMode = datesMode;
  card.scopeHint = scopeHint;
  card.monthPanel = monthPanel;
  card.datePanel = datePanel;
  card.fromMonth = fromMonth;
  card.fromDay = fromDay;
  card.toMonth = toMonth;
  card.toDay = toDay;
  card.dateHint = dateHint;
  card.dateError = dateError;
  card.allYear = allYear;
  card.monthChips = monthChips;
  allYear.addEventListener('change', () => {
    if (settingsSaving) return;
    applyMonths(card, allYear.checked ? null : [new Date().getMonth() + 1], {
      focusCheckbox: true,
    });
  });

  const coverage = el('div', 'coverage');
  const list = el('div', 'rate-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', `Windows in ${periodName(period)}`);
  const addButton = el('button', 'btn add-rule');
  addButton.type = 'button';
  addButton.dataset.action = 'add-window';
  addButton.append(el('span', 'add-plus', '+'), el('span', null, 'Add window'));
  addButton.setAttribute('aria-label', `Add a window to ${periodName(period)}`);
  addButton.addEventListener('click', () => addWindow(card));

  const modeNotice = el('div', 'period-mode-notice');
  const seasonNote = el('p', 'period-mode-note', 'One price for every hour in this season.');
  const mixNote = el('p', 'rule-error period-mix', SEASON_RATE_MIX_MESSAGE);
  seasonNote.hidden = true;
  mixNote.hidden = true;
  modeNotice.append(seasonNote, mixNote);

  const modeActions = el('div', 'period-mode-actions');
  const useTou = el('button', 'btn small', 'Use time-of-use windows');
  useTou.type = 'button';
  useTou.dataset.action = 'use-tou';
  useTou.hidden = true;
  useTou.addEventListener('click', () => convertToTou(card));
  const useSeason = el('button', 'btn small', 'Convert to one season rate');
  useSeason.type = 'button';
  useSeason.dataset.action = 'use-season-rate';
  useSeason.hidden = true;
  useSeason.addEventListener('click', () => convertToSeasonRate(card));
  modeActions.append(useTou, useSeason);

  const periodActions = el('div', 'period-actions');
  const duplicateButton = el('button', 'btn small', 'Duplicate');
  duplicateButton.type = 'button';
  duplicateButton.dataset.action = 'duplicate';
  duplicateButton.addEventListener('click', () => duplicatePeriod(card));
  const confirm = el('div', 'confirm');
  confirm.hidden = true;
  const confirmText = el('span', null, '');
  const confirmButton = el('button', 'btn small danger', 'Remove');
  confirmButton.type = 'button';
  confirmButton.dataset.action = 'confirm-remove';
  const cancelRemove = el('button', 'btn small', 'Cancel');
  cancelRemove.type = 'button';
  cancelRemove.dataset.action = 'cancel-remove';
  confirm.append(confirmText, confirmButton, cancelRemove);
  const removeButton = el('button', 'btn small danger', 'Remove season');
  removeButton.type = 'button';
  removeButton.dataset.action = 'remove-period';
  removeButton.addEventListener('click', () => requestRemovePeriod(card));
  confirmButton.addEventListener('click', () => removePeriod(card));
  cancelRemove.addEventListener('click', () => {
    removeConfirmKey = null;
    paintPeriodActions(card);
    card.removeButton.focus({ preventScroll: true });
  });
  periodActions.append(duplicateButton, confirm, removeButton);
  card.duplicateButton = duplicateButton;
  card.confirm = confirm;
  card.confirmText = confirmText;
  card.confirmButton = confirmButton;
  card.cancelRemove = cancelRemove;
  card.removeButton = removeButton;

  body.append(scopeEditor, modeNotice, coverage, list, addButton, modeActions, periodActions);
  node.append(body);

  period.rows.forEach((entry) => {
    const windowCard = createWindowCard(entry, card);
    windowCards[entry.index] = windowCard;
    card.cards.push(windowCard);
    list.append(windowCard.node);
  });
  card.list = list;
  card.addButton = addButton;
  card.coverage = coverage;
  card.seasonNote = seasonNote;
  card.mixNote = mixNote;
  card.useTou = useTou;
  card.useSeason = useSeason;

  toggle.addEventListener('click', () => {
    const next = card.body.hidden;
    setExpanded(card, next);
  });

  paintPeriodHeader(card);
  paintPeriodActions(card);
  paintCoverage(card);
  return card;
}

// ---------- period actions ----------

// Apply a month-chip or All-year choice to every row in the period at once.
// The card is rebuilt because the period key can change (merge, split, or move
// to/from the malformed group); focus returns to the same control when the
// period survives and to the merged header when its rows join another period.
function applyMonths(
  card,
  months,
  { focusMonth = null, focusCheckbox = false, focusScope = false } = {},
) {
  if (settingsSaving) return;
  const indices = card.period.rows.map((entry) => entry.index);
  const first = indices[0];
  if (first == null) return;
  const ownCount = indices.length;
  draftRates = applyPeriodMonths(draftRates, indices, months);
  markEdited();
  planPeriods = ratePeriodsForDraft();
  const target = planPeriods.find((period) => period.rows.some((entry) => entry.index === first));
  if (target) expandedPeriods.add(target.key);
  renderPlan();
  const next = target ? periodCards.find((entry) => entry.key === target.key) : null;
  if (!next) {
    $('add-season').focus({ preventScroll: true });
    return;
  }
  const merged = target.rows.length > ownCount;
  if (merged) {
    next.toggle.focus({ preventScroll: true });
    scrollToNode(next.node);
    return;
  }
  if (focusCheckbox) {
    next.allYear.focus({ preventScroll: true });
  } else if (focusScope) {
    next.monthsMode.focus({ preventScroll: true });
  } else if (focusMonth != null) {
    const chip = next.monthChips.querySelector(`[data-month="${focusMonth}"]`);
    if (chip) chip.focus({ preventScroll: true });
    else next.toggle.focus({ preventScroll: true });
  } else {
    next.toggle.focus({ preventScroll: true });
  }
  scrollToNode(next.node);
}

// How the draft indices are grouped into periods, in render order. A date edit
// that leaves this unchanged only renames the scope: nothing merges, splits or
// moves, so the cards can be repainted in place.
function periodShape(periods) {
  return (Array.isArray(periods) ? periods : [])
    .map((period) => period.rows.map((entry) => entry.index).join(','))
    .join('|');
}

// A pending structural rebuild: see applyDates. The token cancels it when
// another action has already rendered the (already committed) draft.
let planRenderTimer = 0;
let planRenderToken = 0;

function cancelPlanRebuild() {
  planRenderToken += 1;
  if (planRenderTimer) clearTimeout(planRenderTimer);
  planRenderTimer = 0;
}

// Apply a From/To edit to every member row. Date rows can merge with another
// period carrying the same dates or split away from one, so a structural edit
// rebuilds the plan; a plain edit is repainted in place.
//
// The commit runs inside `change`, which a real pointer press fires on blur
// before the click that caused it is dispatched (and a Tab before the key
// moves focus). Replacing the focused control synchronously would therefore
// swallow the very next action — the conversion buttons included. So: repaint
// without touching the DOM for the common case, and defer a structural rebuild
// to the next task, which lets the click/Tab land first.
function applyDates(card, from, to) {
  if (settingsSaving) return;
  const indices = card.period.rows.map((entry) => entry.index);
  const first = indices[0];
  if (first == null) return;
  const before = periodShape(planPeriods);
  draftRates = applyPeriodDates(draftRates, indices, from, to);
  markEdited();
  planPeriods = ratePeriodsForDraft();
  const target = planPeriods.find((period) => period.rows.some((entry) => entry.index === first));
  if (target) expandedPeriods.add(target.key);
  if (!target) {
    $('add-season').focus({ preventScroll: true });
    return;
  }
  if (periodShape(planPeriods) === before) {
    renamePeriods();
    refresh();
    return;
  }
  deferPlanRebuild(first);
}

// Keep the rendered cards in step with the renamed period keys, so nothing is
// re-expanded or re-collapsed by a date commit. `periodCards` is index-aligned
// with `planPeriods` whenever the shape is unchanged.
function renamePeriods() {
  planPeriods.forEach((period, index) => {
    const card = periodCards[index];
    if (!card) return;
    const oldKey = card.key;
    if (oldKey === period.key) return;
    if (expandedPeriods.delete(oldKey)) expandedPeriods.add(period.key);
    if (removeConfirmKey === oldKey) removeConfirmKey = period.key;
    card.key = period.key;
    card.node.dataset.key = period.key;
  });
}

// Rebuild after the interaction that caused the commit has been delivered. A
// Tab may already have moved focus to the next date control; that control is
// remembered by `data-field` and refocused once its replacement exists, so the
// rebuild does not undo the move. `data-field` names a control in every season's
// scope editor, so the restore is scoped to the season the edit came from: the
// first match in the plan can belong to an earlier season, and the next typed
// edit would land in a season the owner never touched.
function deferPlanRebuild(anchorIndex) {
  cancelPlanRebuild();
  const token = planRenderToken;
  planRenderTimer = setTimeout(() => {
    if (token !== planRenderToken) return;
    planRenderTimer = 0;
    const active = document.activeElement;
    const field = active && active.dataset ? active.dataset.field || '' : '';
    renderPlan();
    // The rebuild detaches the focused control; if focus moved somewhere the
    // rebuild left alone (a button outside the list), it is already correct.
    if (document.contains(active) && active !== document.body) return;
    const edited = periodCards.find((card) =>
      card.period.rows.some((entry) => entry.index === anchorIndex),
    );
    const control = edited && edited.node.querySelector(`[data-field="${field || 'from-day'}"]`);
    if (control) control.focus({ preventScroll: true });
  }, 0);
}

function addWindow(card) {
  if (settingsSaving || draftRates.length >= MAX_RATE_WINDOWS) return;
  if (card.period.kind === 'invalid') {
    if (periodHasDates(card.period)) card.fromDay.focus({ preventScroll: true });
    else card.allYear.focus({ preventScroll: true });
    return;
  }
  if (periodRateMode(card.period) !== 'tou') return;
  // The new row inherits the period's whole scope — its months and, for a date
  // season, the raw day bounds — so it stays a window of that season. Passing
  // the months alone would create a second, month-wide season and silently widen
  // a day-precision season back to the months it touches. The preset is the one
  // the season does not already contain, so the first window cannot collide.
  const scope = periodRowScope(card.period);
  const row = newWindowRow(scope.months, nextWindowPreset(card.period), scope.dates);
  draftRates = [...draftRates, row];
  const index = draftRates.length - 1;
  planPeriods = ratePeriodsForDraft();
  // Expand the period that actually owns the new row; a date season keeps its
  // key (same dates), but a merge/split can move it.
  const target = planPeriods.find((period) => period.rows.some((entry) => entry.index === index));
  if (target) expandedPeriods.add(target.key);
  markEdited();
  renderPlan();
  const added = windowCards[index];
  if (added) {
    added.rateInput.focus({ preventScroll: true });
    scrollToNode(added.node);
  }
}

// The flat opt-in asks once what kind of plan to start, then builds exactly
// that shape. Season rate is an all-day, every-day row in an All-year season;
// time-of-use keeps the everyday overnight preset.
function addRatePlan(mode) {
  if (settingsSaving || draftRates.length > 0) return;
  draftRates = [mode === 'season' ? seasonRateRow(null) : newWindowRow(null, 'overnight')];
  expandedPeriods = new Set(['all']);
  markEdited();
  renderPlan();
  const added = windowCards[0];
  if (added) {
    added.rateInput.focus({ preventScroll: true });
    scrollToNode(added.node);
  }
}

function resetRatePlanChoices() {
  $('rate-plan-choices').hidden = true;
  $('add-rate-plan').hidden = false;
}

function revealRatePlanChoices() {
  if (settingsSaving) return;
  $('add-rate-plan').hidden = true;
  $('rate-plan-choices').hidden = false;
  $('add-season-rate').focus({ preventScroll: true });
}

function hideRatePlanChoices() {
  resetRatePlanChoices();
  $('add-rate-plan').focus({ preventScroll: true });
}

function convertToTou(card) {
  if (settingsSaving || card.period.rows.length !== 1) return;
  const entry = card.period.rows[0];
  draftRates = draftRates.map((row, index) =>
    index === entry.index
      ? { ...row, days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '07:00' }
      : row,
  );
  markEdited();
  renderPlan();
  const added = windowCards[entry.index];
  if (added) {
    added.startInput.focus({ preventScroll: true });
    scrollToNode(added.node);
  }
}

function convertToSeasonRate(card) {
  if (settingsSaving || card.period.rows.length !== 1) return;
  if (periodRateMode(card.period) !== 'tou') return;
  const entry = card.period.rows[0];
  draftRates = draftRates.map((row, index) =>
    index === entry.index
      ? { ...row, days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' }
      : row,
  );
  markEdited();
  renderPlan();
  const added = windowCards[entry.index];
  if (added) {
    added.rateInput.focus({ preventScroll: true });
    scrollToNode(added.node);
  }
}

function addSeason() {
  if (settingsSaving || draftRates.length >= MAX_RATE_WINDOWS) return;
  const allSeasonRates = planPeriods.length > 0 && planPeriods.every((period) => period.seasonRate);
  // Once the plan has a day-precision season, a new season is seeded from the
  // uncovered dates rather than from months: a date season's months are only a
  // compatibility hint, and a month seed can land on the days the date season
  // owns.
  const hasDates = planPeriods.some((period) => period.kind === 'dates');
  let row;
  if (allSeasonRates || hasDates) {
    // A plan made only of season rates grows into the largest uncovered date
    // range, so two seasons divide the year instead of overlapping.
    const scope = largestDateScope(uncoveredDateRanges(draftRates));
    if (!scope) return;
    const dates = scope.fullYear ? null : { from: scope.from, to: scope.to };
    row = allSeasonRates
      ? seasonRateRow(dates ? monthsCovering(dates.from, dates.to) : null, dates)
      : newWindowRow(
          dates ? monthsCovering(dates.from, dates.to) : null,
          draftRates.length === 0 ? 'overnight' : 'peak',
          dates,
        );
  } else {
    const uncovered = uncoveredMonths(draftRates);
    const months =
      uncovered.length === 12
        ? null
        : uncovered.length > 0
          ? largestMonthRun(uncovered)
          : [new Date().getMonth() + 1];
    row = newWindowRow(months, draftRates.length === 0 ? 'overnight' : 'peak');
  }
  draftRates = [...draftRates, row];
  const index = draftRates.length - 1;
  planPeriods = ratePeriodsForDraft();
  const target = planPeriods.find((period) => period.rows.some((entry) => entry.index === index));
  if (target) expandedPeriods.add(target.key);
  markEdited();
  renderPlan();
  const added = windowCards[index];
  if (added) {
    added.rateInput.focus({ preventScroll: true });
    scrollToNode(added.node);
  }
}

function duplicatePeriod(card) {
  if (settingsSaving) return;
  const complement = complementScope(card.period);
  if (!complement || card.period.rows.length === 0) return;
  const occupied = planPeriods.some(
    (other) => other.key !== card.key && scopesOverlap(complement, other),
  );
  if (occupied) return;
  const indices = card.period.rows.map((entry) => entry.index);
  // The copy appends one row per window; refuse before it can build a plan the
  // editor itself would reject. The button is not offered in this state, so the
  // guard is the backstop, not the only explanation: an over-cap plan still
  // reports the cap through validation and the checker.
  if (!canDuplicatePeriod(draftRates.length, indices.length)) return;
  const start = draftRates.length;
  const dates = complement.kind === 'dates' ? complement : null;
  draftRates = copyPeriodRows(
    draftRates,
    indices,
    complement.months,
    () => crypto.randomUUID(),
    dates,
  );
  planPeriods = ratePeriodsForDraft();
  for (const period of planPeriods) {
    if (period.rows.some((entry) => entry.index >= start)) expandedPeriods.add(period.key);
  }
  markEdited();
  renderPlan();
  const added = windowCards[start];
  if (added) {
    added.rateInput.focus({ preventScroll: true });
    scrollToNode(added.node);
  }
}

function requestRemovePeriod(card) {
  if (settingsSaving) return;
  if (card.period.rows.length > 1) {
    removeConfirmKey = card.key;
    paintPeriodActions(card);
    card.confirmButton.focus({ preventScroll: true });
    return;
  }
  removePeriod(card);
}

function removePeriod(card) {
  const indices = new Set(card.period.rows.map((entry) => entry.index));
  draftRates = draftRates.filter((_, index) => !indices.has(index));
  expandedPeriods.delete(card.key);
  removeConfirmKey = null;
  markEdited();
  renderPlan();
  focusAfterRemoval();
}

function removeWindow(card) {
  if (settingsSaving) return;
  const periodKey = card.periodCard.key;
  draftRates = draftRates.filter((_, index) => index !== card.index);
  // Indexes after the removed row shift down; every card is rebuilt.
  planPeriods = ratePeriodsForDraft();
  if (!planPeriods.some((period) => period.key === periodKey)) expandedPeriods.delete(periodKey);
  else expandedPeriods.add(periodKey);
  markEdited();
  renderPlan();
  const period = periodCards.find((entry) => entry.key === periodKey);
  if (period && period.addButton) period.addButton.focus({ preventScroll: true });
  else focusAfterRemoval();
}

function focusAfterRemoval() {
  if (draftRates.length > 0) {
    const add = $('add-season');
    if (!add.disabled) add.focus({ preventScroll: true });
    else periodCards[0]?.toggle.focus({ preventScroll: true });
    return;
  }
  // renderPlan resets the opt-in when the plan becomes flat; focus the restored
  // button rather than a hidden choice.
  $('add-rate-plan').focus({ preventScroll: true });
}

// ---------- painting ----------

function ratePeriodsForDraft() {
  return ratePeriods(draftRates);
}

function paintPlan() {
  const flat = draftRates.length === 0;
  $('rates-flat').hidden = !flat;
  $('rates-plan').hidden = flat;
  if (flat) {
    // The fallback line belongs to the plan view; a flat config has no plan.
    $('other-times-line').hidden = true;
    return;
  }

  planPeriods = ratePeriodsForDraft();
  // Only rows that can actually match and pass validation set a meaningful
  // range: a row with unusable months or an invalid time/price is shown and
  // fixed, but its price never applies. Letting it widen the advertised range
  // would quote a price no moment can ever be charged.
  const rateRows = planPeriods
    .filter((period) => period.kind !== 'invalid')
    .flatMap((period) => period.rows)
    .filter((entry) => Object.keys(rateValidation.rows[entry.index] || {}).length === 0)
    .map((entry) => entry.row);
  const range = ratePlanRange(rateRows);
  const problems = validationProblemCount(rateValidation, draftRates.length);
  const capped = draftRates.length > MAX_RATE_WINDOWS;
  // "3 windows · USD 0.10–0.32 · other times USD 0.31": the count already says
  // "windows", so the range does not repeat the word. Prices are unbreakable
  // runs so a range never splits after the en dash at 320. A season rate is one
  // price, not a window, and an all-season-rate plan is counted as rates.
  const allSeasonRates = planPeriods.length > 0 && planPeriods.every((period) => period.seasonRate);
  const rowNoun = allSeasonRates ? (draftRates.length === 1 ? 'rate' : 'rates') : null;
  const counts = `${planPeriods.length} ${planPeriods.length === 1 ? 'season' : 'seasons'} · ${
    draftRates.length
  } ${rowNoun || (draftRates.length === 1 ? 'window' : 'windows')}`;
  // Every separator is bound to the run it introduces with a no-break space, so
  // a plan line never ends on a lone `·` when it wraps at 320 px. The count is
  // one unbreakable run too: "2 seasons · 2" / "windows" split the noun from its
  // number.
  const summary = [nowrapEl(counts)];
  if (range) summary.push(nowrapEl(`\u00a0· ${priceRangeText(range)}`));
  // No row contributes a usable price: name the reason instead of omitting the
  // range, which read as "no price applies" rather than "a price needs fixing".
  // An untitled row is the same state as an invalid one to the owner — the price
  // is not there yet — so both read the same.
  else summary.push(nowrapEl('\u00a0· — needs attention'));
  summary.push(nowrapEl(`\u00a0· other times ${priceText(readFields().rate)}`));
  $('plan-summary-text').replaceChildren(...summary);
  const problem = $('plan-problem');
  const problemText = planProblemText({ problems, capped });
  problem.hidden = problems === 0;
  setText(problem, problemText);

  // The fallback is a line, not a season: name the days nothing covers. Date
  // ranges collapse back to whole months when that is what the gap is, so a
  // month-only plan reads exactly as before.
  const uncovered = dateSetText(uncoveredDateRanges(draftRates));
  const otherTimes = $('other-times-line');
  otherTimes.hidden = !uncovered;
  if (uncovered) {
    // The separator is bound to the text that follows it with a no-break space,
    // so a wrap at 320 px can never leave a line starting with a lone `·`. The
    // title itself is two runs split at the dash: at 320 it breaks into
    // "No season —" / "other times · …" instead of splitting "other times".
    const runs = uncovered.split(', ');
    const title = el('span', 'other-times-title');
    title.append(nowrapEl('No season —'), ' ', nowrapEl('other times'));
    const nodes = [title];
    nodes.push(nowrapEl(`\u00a0· ${runs[0]}`));
    for (const run of runs.slice(1)) nodes.push(nowrapEl(`, ${run}`));
    const fallback = readFields().rate;
    if (Number.isFinite(parseRateValue(fallback))) {
      nodes.push(el('span', 'other-times-price', `\u00a0· ${priceText(fallback)}`));
    }
    otherTimes.replaceChildren(...nodes);
  }

  for (const card of periodCards) {
    const period = planPeriods.find((entry) => entry.key === card.key);
    if (!period) continue;
    card.period = period;
    paintPeriodHeader(card);
    paintPeriodActions(card);
    paintCoverage(card);
    for (const windowCard of card.cards) {
      windowCard.periodCard = card;
      paintWindowCard(windowCard);
    }
  }
}

function paintRateValidation() {
  // A row that collides with another is named by the other row's price band and
  // times, so the inline note explains the conflict without referring to a
  // storage index.
  const rates = windowRates();
  const fallback = readFields().rate;
  // A mixed season's rows collide by construction: its all-day row overlaps
  // every time window of the same season. The structural banner already names
  // the one fix, and a row-level "Overlaps …" reads as a time tweak that cannot
  // work, so those pairs are withheld from the row notes. Cross-season overlaps
  // keep theirs, and the counts/flags below still use the full set.
  const mixedPeriodOf = new Map();
  for (const period of planPeriods) {
    if (periodRateMode(period) !== 'mixed') continue;
    for (const entry of period.rows) mixedPeriodOf.set(entry.index, period);
  }
  const addNote = (map, index, text) => {
    if (!map.has(index)) map.set(index, []);
    map.get(index).push(text);
  };
  const notes = new Map();
  const displayNotes = new Map();
  for (const [a, b] of rateValidation.overlaps) {
    const sameScope = rateScopeText(draftRates[a]) === rateScopeText(draftRates[b]);
    const left = windowLabel(draftRates[a], rates, fallback, { months: !sameScope });
    const right = windowLabel(draftRates[b], rates, fallback, { months: !sameScope });
    const leftNote = left === right ? 'Overlaps an identical window' : `Overlaps “${right}”`;
    const rightNote = left === right ? 'Overlaps an identical window' : `Overlaps “${left}”`;
    addNote(notes, a, leftNote);
    addNote(notes, b, rightNote);
    const sameMix = mixedPeriodOf.has(a) && mixedPeriodOf.get(a) === mixedPeriodOf.get(b);
    if (!sameMix) {
      addNote(displayNotes, a, leftNote);
      addNote(displayNotes, b, rightNote);
    }
  }

  for (const card of windowCards) {
    if (!card) continue;
    const errors = rateValidation.rows[card.index] || {};
    const rowNotes = displayNotes.get(card.index) || [];
    // Date errors belong to the season's From/To editor, which prefixes the
    // field name; repeating the bare sentence inside every member row is noise.
    const rowMessages = Object.entries(errors)
      .filter(([field]) => field !== 'from' && field !== 'to')
      .map(([, message]) => message);
    const messages = [...new Set([...rowMessages, ...rowNotes])];
    card.errorEl.hidden = messages.length === 0;
    setText(card.errorEl, messages.join(' '));
    card.rateInput.setAttribute('aria-invalid', String(Boolean(errors.rate)));
    card.presetsEl.setAttribute('aria-invalid', String(Boolean(errors.days)));
    card.daysEl.setAttribute('aria-invalid', String(Boolean(errors.days)));
    card.daysEl.classList.toggle('invalid', Boolean(errors.days));
    card.startInput.setAttribute('aria-invalid', String(Boolean(errors.start)));
    card.endInput.setAttribute('aria-invalid', String(Boolean(errors.end)));
    card.node.classList.toggle('invalid', messages.length > 0);
    card.node.setAttribute('aria-invalid', String(messages.length > 0));
    if (rowNotes.length > 0) {
      card.node.setAttribute('aria-describedby', 'rates-error');
      card.rateInput.setAttribute('aria-describedby', `${card.errorId} rates-error`);
    } else {
      card.node.removeAttribute('aria-describedby');
      card.rateInput.setAttribute('aria-describedby', card.errorId);
    }
  }

  for (const card of periodCards) {
    const bad = card.period.rows.filter((entry) => {
      const errors = rateValidation.rows[entry.index] || {};
      return Object.keys(errors).length > 0 || notes.has(entry.index);
    }).length;
    card.flag.hidden = bad === 0;
    setText(card.flag, bad === 1 ? '1 to fix' : `${bad} to fix`);
    card.node.classList.toggle('invalid', bad > 0);
    // Re-derive the date target from the validation that was just applied; the
    // submit path paints validation without rebuilding the period.
    if (periodHasDates(card.period)) {
      const first = card.period.rows
        .map((entry) => ({ entry, errors: rateValidation.rows[entry.index] || {} }))
        .find(({ errors }) => errors.from || errors.to);
      card.dateFocus = first ? (first.errors.from ? card.fromDay : card.toDay) : card.fromDay;
      const fromError = card.period.rows
        .map((entry) => (rateValidation.rows[entry.index] || {}).from)
        .find(Boolean);
      const toError = card.period.rows
        .map((entry) => (rateValidation.rows[entry.index] || {}).to)
        .find(Boolean);
      card.fromMonth.setAttribute('aria-invalid', String(Boolean(fromError)));
      card.fromDay.setAttribute('aria-invalid', String(Boolean(fromError)));
      card.toMonth.setAttribute('aria-invalid', String(Boolean(toError)));
      card.toDay.setAttribute('aria-invalid', String(Boolean(toError)));
      const messages = [
        fromError ? `From: ${fromError}` : '',
        toError ? `To: ${toError}` : '',
      ].filter(Boolean);
      card.dateError.hidden = messages.length === 0;
      setText(card.dateError, messages.join(' '));
    }
  }

  // A mixed season is one structural problem, and the season card already names
  // it. The generic overlap sentence is withheld for that case: its remedy
  // ("change one of them") cannot fix an all-day row colliding with every time
  // window, and two banners for one condition contradicted each other.
  const mixed = planHasMix();
  const general = mixed && !rateValidation.capped ? '' : rateValidation.general.join(' ');
  const docError = $('rates-error');
  docError.hidden = !general;
  setText(docError, general);

  // The save row carries the same count as the plan summary; Save itself stays
  // governed by the dirty/saving state machine.
  const problems = validationProblemCount(rateValidation, draftRates.length);
  const capped = draftRates.length > MAX_RATE_WINDOWS;
  const blockers = $('save-blockers');
  blockers.hidden = problems === 0;
  setText(blockers, planProblemText({ problems, capped }));

  // Saving locks the plan; the cap disables the two add paths.
  for (const node of $('rates-plan').querySelectorAll('input, button, select')) {
    node.disabled = settingsSaving;
  }
  for (const node of $('rates-flat').querySelectorAll('button')) node.disabled = settingsSaving;
  const atCap = draftRates.length >= MAX_RATE_WINDOWS;
  const allSeasonRates = planPeriods.length > 0 && planPeriods.every((period) => period.seasonRate);
  // A new season is seeded from the uncovered dates once the plan has any date
  // season, so a fully partitioned year leaves nowhere to add one.
  const datedPlan = allSeasonRates || planPeriods.some((period) => period.kind === 'dates');
  const noUncoveredDates = datedPlan && uncoveredDateRanges(draftRates).length === 0;
  $('add-season').disabled = settingsSaving || atCap || noUncoveredDates;
  $('add-season').title = noUncoveredDates ? 'Every date already has a season.' : '';
  for (const card of periodCards) {
    // The blanket lock above enables everything when not saving; restore the
    // feature-level disabled states (date/months modes, conversions) after it.
    paintScopeEditor(card);
    paintPeriodMode(card);
    card.addButton.disabled = settingsSaving || atCap;
    paintPeriodActions(card);
  }
}

function paintPreviewRow(label, cell) {
  const tr = el('tr');
  const th = el('th', null, label);
  th.scope = 'row';
  const td = el('td');
  if (typeof cell === 'string') td.textContent = cell;
  else td.append(cell);
  tr.append(th, td);
  return tr;
}

function previewResult() {
  const date = parseLocalDateTime($('preview-date').value, $('preview-time').value);
  if (!date) return { date: null, result: null };
  return { date, result: previewRate(draftRates, $('setting-rate').value, date) };
}

// A season that mixes a season rate with daily windows: the validator rejects it
// and the UI must not draw a resolved schedule for it.
function planHasMix() {
  return planPeriods.some((period) => periodRateMode(period) === 'mixed');
}

function paintPreview() {
  if (draftRates.length === 0) return;
  const table = $('preview-table');
  const empty = $('preview-empty');
  const note = $('preview-note');
  const mixed = planHasMix();
  const blocker = mixed ? MIX_COVERAGE_MESSAGE : previewBlocker(rateValidation);
  if (blocker) {
    // Never claim "Other times" while a window is incomplete or two windows
    // collide: the invalid row is omitted from the lookup, so the answer could
    // be wrong. The checker resumes as soon as the plan is fixable.
    table.hidden = true;
    empty.hidden = true;
    note.hidden = false;
    note.className = 'preview-note blocked';
    setText(note, blocker);
    $('preview-rows').replaceChildren();
    return;
  }
  const { date, result } = previewResult();
  if (!date || !result) {
    table.hidden = true;
    empty.hidden = false;
    note.hidden = true;
    note.className = 'preview-note';
    $('preview-rows').replaceChildren();
    return;
  }
  const rows = [];
  rows.push(paintPreviewRow('When', formatPreviewWhen(date)));
  const price = el('span', 'preview-price');
  if (result.rate == null) {
    price.textContent = 'No rate set';
  } else {
    // A season rate is named for what it is: a relative band ("Off-peak") beside
    // "Season rate · Jun 15–Sep 15" described a band the owner never chose.
    const band = result.seasonRate ? 'Season rate' : result.tier;
    if (band) price.append(el('span', `tier ${tierClass(result.tier)}`, band));
    const money = el('span', 'preview-money');
    money.append(el('strong', null, priceText(result.rate)), el('span', 'unit', '/ kWh'));
    price.append(money);
  }
  rows.push(paintPreviewRow('Price', price));
  // The fallback wins for two different reasons, and naming the wrong one sends
  // the owner to the wrong control: no season covers this day at all, or a
  // season covers it but no window covers this hour. The visible plan makes the
  // same day-level distinction on its own line.
  let applies = result.noSeason
    ? 'No season — no rate window covers this moment.'
    : 'Other times — no rate window covers this moment.';
  if (!result.fallback) {
    applies = el('span');
    if (result.seasonRate) applies.append('Season rate · ');
    else applies.append(`${result.summary} · `);
    applies.append(nowrapEl(result.scopeText));
  }
  rows.push(paintPreviewRow('Applies', applies));
  $('preview-rows').replaceChildren(...rows);
  table.hidden = false;
  empty.hidden = true;
  note.hidden = true;
  note.className = 'preview-note';
}

// Announce the checker only when the owner commits a value, never on every
// keystroke (the visible result still updates live).
function announcePreview() {
  if (draftRates.length === 0) return;
  const live = $('preview-live');
  // Same gate as the visible checker: a mixed season's remedy is structural, so
  // announcing the overlap remedy would describe a fix that cannot work.
  const blocker = planHasMix() ? MIX_COVERAGE_MESSAGE : previewBlocker(rateValidation);
  if (blocker) {
    setText(live, blocker);
    return;
  }
  const { date, result } = previewResult();
  if (!date || !result) {
    setText(live, 'Choose a date and time to check.');
    return;
  }
  if (result.rate == null) {
    setText(live, `${formatPreviewWhen(date)}: no rate set.`);
    return;
  }
  const band = result.seasonRate ? 'Season rate, ' : result.tier ? `${result.tier}, ` : '';
  // Announce what the visible Applies row says. Two windows in one season can be
  // equally priced, so the day/time summary is what tells them apart.
  const where = result.fallback
    ? 'other times'
    : result.seasonRate
      ? `season rate ${result.scopeText}`
      : `${result.summary} · ${result.scopeText}`;
  setText(live, `${formatPreviewWhen(date)}: ${band}${priceText(result.rate)} per kWh, ${where}.`);
}

function paintFeedback() {
  const feedback = $('settings-feedback');
  const view = settingsSaveState({
    draft: readFields(),
    confirmed: confirmedSettings,
    saving: settingsSaving,
    waiting: settingsWaiting,
    saved: settingsSaved,
    error: settingsError,
  });
  // The value comparison is the only dirty rule; keep the flag in step.
  settingsDirty = view.dirty;
  feedback.className = `feedback${view.busy ? ' busy' : ''}${view.kind ? ` ${view.kind}` : ''}`;
  // An over-cap plan has no field-error sentence, so the save row's left column
  // would sit empty while its chip says `· cap`. The cap's remedy belongs next
  // to the button the owner is trying to use.
  const capped = draftRates.length > MAX_RATE_WINDOWS;
  const problems = validationProblemCount(rateValidation, draftRates.length);
  setText(feedback, view.text || (capped && problems > 0 ? RATE_CAP_REMEDY : ''));

  // Save is not the brightest, most clickable thing on a plan that cannot be
  // saved: the same count as the save-row chip relabels the button and marks it
  // `blocked` (aria-disabled, muted surface). The button stays submit-capable on
  // purpose — it is the form's only submit button, so disabling it would also
  // swallow Enter in the rate fields and with it the jump to the first problem.
  // Pressing it validates, paints the errors and focuses that row.
  const save = $('save-settings');
  const saveState = saveButtonState({ canSave: view.canSave, saving: settingsSaving, problems });
  save.disabled = saveState.disabled;
  save.classList.toggle('blocked', saveState.blocked);
  if (saveState.blocked) save.setAttribute('aria-disabled', 'true');
  else save.removeAttribute('aria-disabled');
  setText(save, saveState.label);
  if (saveState.describedBy) save.setAttribute('aria-describedby', saveState.describedBy);
  else save.removeAttribute('aria-describedby');
  $('settings-form').setAttribute('aria-busy', String(settingsSaving));
  $('setting-rate').disabled = settingsSaving;
  $('setting-currency').disabled = settingsSaving;
}

// ---------- rendering ----------

function renderPlan() {
  // A full rebuild supersedes any deferred date rebuild: the draft it would
  // have rendered is the one being rendered now.
  cancelPlanRebuild();
  planPeriods = ratePeriodsForDraft();
  const flat = draftRates.length === 0;
  const wasFlat = !$('rates-flat').hidden;
  if (flat && !wasFlat) resetRatePlanChoices();
  $('rates-flat').hidden = !flat;
  $('rates-plan').hidden = flat;
  const list = $('rate-periods');
  list.replaceChildren();
  periodCards = [];
  windowCards = [];
  planPeriods.forEach((period, index) => {
    const card = createPeriodCard(period, index);
    list.append(card.node);
    periodCards.push(card);
  });
  refresh();
}

function writeFields(fields) {
  $('setting-rate').value = fields.rate;
  $('setting-currency').value = fields.currency;
  draftRates = (Array.isArray(fields.rates) ? fields.rates : []).map(rateRowFields);
  removeConfirmKey = null;
  planPeriods = ratePeriodsForDraft();
  const keys = new Set(planPeriods.map((period) => period.key));
  expandedPeriods = new Set([...expandedPeriods].filter((key) => keys.has(key)));
  for (const period of planPeriods) {
    if (period.kind === 'invalid') expandedPeriods.add(period.key);
  }
  renderPlan();
}

function setFields(settings) {
  writeFields(settingsFields(settings));
}

function recomputeDirty() {
  settingsDirty = !settingsDraftMatches(readFields(), confirmedSettings);
  if (settingsDirty) {
    settingsSaved = false;
    settingsError = '';
  }
  refresh();
}

function handleInput(field) {
  recomputeDirty();
  // Keep a shown error live: correcting the field clears it immediately, and a
  // still-invalid value keeps its explanation.
  if ($(`${field}-error`).hidden === false) {
    const result = validateSettings(readFields());
    paintFieldError(field, result.errors[field] || '');
  }
}

// ---------- save-state machine ----------

// settings/current — null means the owner has not saved a rate yet. A remote
// snapshot never overwrites a draft; it only becomes the new confirmed baseline.
export function showSettingsData(data) {
  const next = normalizeSettings(data);
  if (settingsSaving || settingsWaiting) {
    pendingSettings = { settings: next };
    return;
  }
  // "Typed" is the value comparison against the baseline we are replacing.
  const typed = !settingsDraftMatches(readFields(), confirmedSettings);
  confirmedSettings = next;
  if (!typed && !settingsDraftMatches(readFields(), next)) {
    setFields(next);
    // A failed-save message stays until the user acts: a snapshot echoing the
    // server truth does not undo the attempt the message describes.
    settingsSaved = false;
    renderErrors({});
  }
  paintFeedback();
}

// Reconcile a save that has actually settled: adopt on success, roll back to the
// last confirmed snapshot on failure. Runs from the normal path and again from
// the timeout's late callback; the generation guard makes the first one win.
function finishSave(generation, ok, values, previous) {
  if (generation !== settingsGeneration) return;
  settingsSaving = false;
  settingsWaiting = false;
  const pending = pendingSettings;
  pendingSettings = null;
  const next = reconcileSettingsSave({
    ok,
    values,
    previous,
    draft: readFields(),
    remote: pending ? pending.settings : null,
    remoteSeen: pending !== null,
  });
  confirmedSettings = next.confirmed;
  writeFields(next.fields);
  settingsDirty = next.dirty;
  settingsSaved = next.saved;
  settingsError = next.error;
  renderErrors({});
  refresh();
}

async function submit(event) {
  event.preventDefault();
  if (settingsSaving) return;
  // A valid save is the shared document validation plus the table's own rule,
  // both inside `submitSettingsPlan`; it calls back only for a saveable plan, so
  // a blocked Enter can never reach the write.
  let start = null;
  const attempt = submitSettingsPlan({
    fields: readFields(),
    onCommit: (values) => {
      start = beginSave(values);
    },
  });
  rateValidation = attempt.rateValidation;
  paintRateValidation();
  renderErrors(attempt.errors);
  if (attempt.blocked) {
    settingsSaved = false;
    settingsError = attempt.message;
    paintFeedback();
    applySubmitFocus(attempt.target, focusView);
    return;
  }
  await start;
}

// The write itself, after the gate has accepted the draft. Kept separate so the
// gate returns before a single Firestore call is made.
async function beginSave(values) {
  const previous = confirmedSettings;
  // Do not hand a write to Firestore while offline: it would queue until the
  // connection returns, leaving the form locked on "Saving…". Keep the draft
  // and ask the user to retry once they are back.
  //
  // This refusal happens before the generation bump on purpose: a write that
  // already timed out is still running, and a retry that starts no replacement
  // write must not revoke that write's ownership of its late settlement. The
  // form keeps saying why the retry did not start until the real outcome lands.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    settingsSaved = false;
    settingsError = OFFLINE_MESSAGE;
    paintFeedback();
    return;
  }
  const generation = ++settingsGeneration;
  settingsSaving = true;
  settingsWaiting = false;
  settingsSaved = false;
  settingsError = '';
  pendingSettings = null;
  renderErrors({});
  refresh();
  paintFeedback();

  const outcome = await settleWrite(persistSettings(values), {
    onLate: (late) => finishSave(generation, late.status === 'ok', values, previous),
  });
  if (generation !== settingsGeneration) return;
  if (outcome.status === 'timeout') {
    // The browser says online but the backend has not answered. Re-enable the
    // form with an explicit "may not be saved yet" state; the write keeps
    // running and its real outcome reconciles above.
    settingsSaving = false;
    settingsWaiting = true;
    settingsSaved = false;
    settingsError = '';
    // The value is still unconfirmed, so the form stays dirty and Save remains
    // available as a retry.
    settingsDirty = !settingsDraftMatches(readFields(), previous);
    refresh();
    return;
  }
  finishSave(generation, outcome.status === 'ok', values, previous);
}

// Turn the gate's target into the reveal/focus the keyboard path needs. The
// target decision lives in the shared module; this adapter is the only part
// that touches rendered cards. `view` is injected so the same function is used
// by the screen and by its tests.
export function applySubmitFocus(target, view) {
  if (!target || target.kind === 'save') return;
  if (target.kind === 'field') {
    view.focusField(target.field);
    return;
  }
  const card = target.kind === 'doc' ? view.firstCard() : view.card(target.index);
  if (!card) {
    // A blocker with no row to point at: the sentence is the only explanation.
    view.revealDocumentError();
    return;
  }
  const focus = target.kind === 'doc' ? 'rate' : target.focus;
  // A month problem belongs to the season, not the window: the chips live in
  // the season card and an inherited row has no month control.
  if (focus === 'months') {
    view.expand(card.periodCard);
    view.reveal(card.periodCard.node);
    card.periodCard.allYear.focus({ preventScroll: true });
    return;
  }
  // A date problem belongs to the season header too. Focus the From/To control
  // validation named, never the window's rate field.
  if (focus === 'dates') {
    view.expand(card.periodCard);
    view.reveal(card.periodCard.node);
    const control =
      card.periodCard.dateFocus || card.periodCard.fromDay || card.periodCard.fromMonth;
    if (control) control.focus({ preventScroll: true });
    return;
  }
  view.expand(card.periodCard);
  let control = card.rateInput;
  if (focus === 'start') control = card.startInput;
  else if (focus === 'end') control = card.endInput;
  else if (focus === 'days') {
    control =
      card.daysEl.querySelector('[aria-pressed="true"]') ||
      card.presetEls[0] ||
      card.daysEl.querySelector('button');
  }
  if (control) control.focus({ preventScroll: true });
  view.reveal(card.node);
}

const focusView = {
  card: (index) => windowCards[index],
  firstCard: () => windowCards.find(Boolean),
  expand: (periodCard) => setExpanded(periodCard, true),
  reveal: (node) => revealNode(node),
  focusField: (field) => $(`setting-${field}`).focus(),
  revealDocumentError: () => {
    const docError = $('rates-error');
    if (!docError.hidden) docError.scrollIntoView({ block: 'center', behavior: 'auto' });
  },
};

function revealNode(node) {
  node.scrollIntoView({
    block: 'center',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

// ---------- screen lifecycle ----------

function setPreviewNow() {
  const now = new Date();
  $('preview-date').value = dateInputValue(now);
  $('preview-time').value = timeInputValue(now);
}

export function initSettings() {
  $('settings-form').addEventListener('submit', submit);
  $('setting-rate').addEventListener('input', () => handleInput('rate'));
  $('setting-currency').addEventListener('input', () => handleInput('currency'));
  $('add-rate-plan').addEventListener('click', revealRatePlanChoices);
  $('add-season-rate').addEventListener('click', () => addRatePlan('season'));
  $('add-tou').addEventListener('click', () => addRatePlan('tou'));
  $('cancel-rate-plan').addEventListener('click', hideRatePlanChoices);
  $('add-season').addEventListener('click', addSeason);
  $('preview-date').addEventListener('input', paintPreview);
  $('preview-time').addEventListener('input', paintPreview);
  $('preview-date').addEventListener('change', () => {
    paintPreview();
    announcePreview();
  });
  $('preview-time').addEventListener('change', () => {
    paintPreview();
    announcePreview();
  });
  $('preview-now').addEventListener('click', () => {
    setPreviewNow();
    paintPreview();
    announcePreview();
  });
  addEventListener('online', () => {
    if (settingsError !== OFFLINE_MESSAGE) return;
    settingsError = '';
    paintFeedback();
  });
  setPreviewNow();
  setFields(null);
  renderErrors({});
  refresh();
}

export function resetSettings() {
  settingsGeneration += 1;
  confirmedSettings = null;
  pendingSettings = null;
  settingsDirty = false;
  settingsSaving = false;
  settingsWaiting = false;
  settingsSaved = false;
  settingsError = '';
  expandedPeriods.clear();
  removeConfirmKey = null;
  if (!$('settings-form')) return;
  setPreviewNow();
  setFields(null);
  renderErrors({});
  $('settings-form').setAttribute('aria-busy', 'false');
  refresh();
}
