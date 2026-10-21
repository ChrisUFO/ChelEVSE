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
  MONTH_NAMES,
  OFFLINE_MESSAGE,
  RATE_CAP_REMEDY,
  applyPeriodDates,
  applyPeriodMonths,
  baseRateRow,
  canDuplicatePeriod,
  complementScope,
  copyPeriodRows,
  dateInputValue,
  dateRangeHint,
  dateRangeText,
  dateSetText,
  dayPresetFor,
  defaultRateRow,
  flatToScheduleRow,
  formatPreviewWhen,
  isAllDayWindow,
  largestDateScope,
  mergeDateRanges,
  minutesToClock,
  nextWindowPreset,
  normalizeSettings,
  parseLocalDateTime,
  periodBaseRate,
  periodCoverage,
  periodDateBounds,
  periodDateSeed,
  periodEffectiveRange,
  periodHasBaseOverlap,
  periodHasDates,
  periodRowScope,
  planProblemText,
  previewBlocker,
  previewRate,
  rateEditorMode,
  rateIsUsable,
  rateMonthsText,
  ratePeriods,
  ratePlanRange,
  rateRowFields,
  rateScopeText,
  rateSegmentLabel,
  rateTierFor,
  rateWindowSummary,
  reconcileSettingsSave,
  saveButtonState,
  scheduleToFlatRate,
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
  uncoveredGapScopes,
  validateRateEditorRows,
  validateSettings,
  validationProblemCount,
  windowLabel,
} from '../settings.js';
import { MAX_RATE_WINDOWS, monthsCovering, parseMonthDay, parseRateValue } from '../rates.js';
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

function currentRateMode() {
  return rateEditorMode(draftRates);
}

// The mode is derived from the draft rows, never stored. One rate is the flat
// pair; Seasons hides the unused fallback rate (the shared currency remains).
function paintRateMode() {
  const mode = currentRateMode();
  const seasons = mode === 'seasons';
  const flatUsable = rateIsUsable($('setting-rate').value);
  const flatButton = $('rate-mode-flat');
  const seasonsButton = $('rate-mode-seasons');
  flatButton.setAttribute('aria-checked', String(!seasons));
  seasonsButton.setAttribute('aria-checked', String(seasons));
  flatButton.tabIndex = seasons ? -1 : 0;
  seasonsButton.tabIndex = seasons ? 0 : -1;
  flatButton.disabled = settingsSaving;
  seasonsButton.disabled = settingsSaving || (!seasons && !flatUsable);
  seasonsButton.title =
    !seasons && !flatUsable ? 'Enter the one rate before switching to seasons.' : '';
  $('fallback-card').classList.toggle('is-season', seasons);
  $('fallback-head').hidden = seasons;
  $('fallback-rate-field').hidden = seasons;
  $('rates-plan').hidden = !seasons;
  if (!seasons) $('rate-mode-confirm').hidden = true;
}

function focusBaseRate() {
  const period = periodCards[0];
  if (period && period.baseInput) {
    period.baseInput.focus({ preventScroll: true });
    scrollToNode(period.node);
  }
}

function switchToSeasons() {
  if (settingsSaving || currentRateMode() === 'seasons') return;
  const flat = $('setting-rate').value;
  if (!rateIsUsable(flat)) {
    $('setting-rate').focus({ preventScroll: true });
    return;
  }
  $('rate-mode-confirm').hidden = true;
  draftRates = [flatToScheduleRow(crypto.randomUUID(), flat)];
  planPeriods = ratePeriodsForDraft();
  expandedPeriods = new Set(planPeriods.map((period) => period.key));
  markEdited();
  renderPlan();
  focusBaseRate();
}

function requestOneRate() {
  if (settingsSaving || currentRateMode() === 'flat') return;
  const confirm = $('rate-mode-confirm');
  confirm.hidden = false;
  $('cancel-one-rate').focus({ preventScroll: true });
}

function cancelOneRate() {
  $('rate-mode-confirm').hidden = true;
  $('rate-mode-seasons').focus({ preventScroll: true });
}

function confirmOneRate() {
  if (settingsSaving || currentRateMode() === 'flat') return;
  const flat = scheduleToFlatRate(draftRates, $('setting-rate').value);
  if (typeof flat === 'number') $('setting-rate').value = String(flat);
  draftRates = [];
  planPeriods = [];
  expandedPeriods.clear();
  removeConfirmKey = null;
  $('rate-mode-confirm').hidden = true;
  markEdited();
  renderPlan();
  $('setting-rate').focus({ preventScroll: true });
}

function paintModeKeyboard(event) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const next = event.currentTarget.dataset.mode === 'flat' ? 'seasons' : 'flat';
  const button = next === 'seasons' ? $('rate-mode-seasons') : $('rate-mode-flat');
  if (button.disabled) return;
  button.focus({ preventScroll: true });
  if (next === 'seasons') switchToSeasons();
  else requestOneRate();
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
  if (tier === 'Base') return 'base';
  if (tier === 'Uncovered') return 'uncovered';
  if (tier === 'Season rate') return 'base';
  if (tier === 'Off-peak') return 'off';
  if (tier === 'Peak') return 'peak';
  if (tier === 'Shoulder') return 'shoulder';
  return 'same';
}

// The legend's order: base first, then the relative override tiers, then the
// uncovered 0.00 slice.
const LEGEND_ORDER = ['base', 'off', 'shoulder', 'peak', 'same', 'uncovered'];

function segmentClass(segment) {
  if (!segment || !segment.window) return 'uncovered';
  const owner = planPeriods.find((period) =>
    period.rows.some((entry) => entry.row && entry.row.id === segment.window.id),
  );
  const base = owner ? periodBaseRate(owner) : null;
  const rates = owner ? owner.rows.map((entry) => entry.row.rate) : windowRates();
  return tierClass(rateSegmentLabel(segment, rates, base));
}

function windowName(row) {
  const tier = bandName(row);
  return `${tier ? `${tier} ` : ''}${rateWindowSummary(row)}`;
}

// A daily window's visible band, relative to its season's base. A base row is
// handled by the Base rate block and the coverage label, not this tier name.
function bandName(row, period = null) {
  const base = period ? periodBaseRate(period) : readFields().rate;
  return rateTierFor(row && row.rate, windowRates(), base);
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

// The date inputs are real date pickers, but only a month and day are stored.
// 2024 is a leap reference year so 29 February is representable; any year the
// owner picks is discarded, and the visible hint says the year is a reference.
const DATE_REFERENCE_YEAR = 2024;

function dateInputForBound(value) {
  const parsed = parseMonthDay(value);
  if (!parsed) return '';
  return `${DATE_REFERENCE_YEAR}-${String(parsed.month).padStart(2, '0')}-${String(
    parsed.day,
  ).padStart(2, '0')}`;
}

// A native date value is YYYY-MM-DD. The year is deliberately discarded: the
// season repeats annually. A blank value becomes the 00-00 sentinel so date
// mode survives until validation explains the missing half, instead of the
// period silently falling back to an old month scope.
function boundFromDateInput(value) {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) return '00-00';
  const monthDay = `${match[1]}-${match[2]}`;
  return parseMonthDay(monthDay) ? monthDay : '00-00';
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
  const band = bandName(row, card.periodCard && card.periodCard.period);
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
  const months =
    (card.period.kind === 'months' || card.period.kind === 'dates') &&
    Array.isArray(card.period.months)
      ? card.period.months
      : [];
  for (const chip of card.monthChips.querySelectorAll('[data-month]')) {
    chip.setAttribute('aria-pressed', String(all || months.includes(Number(chip.dataset.month))));
  }
}

// The scope in the terms the date block needs: the canonical All-year state,
// raw date bounds, and the derived first/last date a legacy month range can
// show. A non-contiguous or invalid month scope has no single date range.
function seasonDateState(period) {
  const allYear = period.kind === 'all';
  const dateMode = periodHasDates(period);
  const raw = periodDateBounds(period);
  const seed = !allYear && !dateMode ? periodDateSeed(period) : null;
  const values = allYear
    ? { from: null, to: null }
    : dateMode
      ? raw
      : seed || { from: null, to: null };
  return {
    allYear,
    dateMode,
    raw,
    seed,
    values,
    canPick: !allYear && (dateMode || Boolean(seed)),
    monthStored: !allYear && !dateMode,
  };
}

// The visible season dates. Dates are the first decision; the month chips are a
// secondary, advanced route for the legacy month-only scopes. The mode is
// derived from the rows, never stored.
function paintScopeEditor(card) {
  const period = card.period;
  const state = seasonDateState(period);
  const values = state.values;
  card.allYear.checked = state.allYear;

  // Always normalize the visible year back to the reference year. A native
  // picker may have produced 2025; only its month and day are kept.
  const fromValue = dateInputForBound(values.from);
  const toValue = dateInputForBound(values.to);
  if (card.fromDate.value !== fromValue) card.fromDate.value = fromValue;
  if (card.toDate.value !== toValue) card.toDate.value = toValue;

  const dateDisabled = settingsSaving || !state.canPick;
  card.fromDate.disabled = dateDisabled;
  card.toDate.disabled = dateDisabled;

  // Do not leave two empty pickers looking like required fields when the scope
  // has no single start/end (All year or separate month ranges). A read-only
  // value takes their place and the real control is the checkbox or the month
  // editor below.
  const showFallback = state.allYear || !state.canPick;
  card.dateFields.hidden = showFallback;
  card.dateFallback.hidden = !showFallback;
  card.dateFallback.classList.toggle('unavailable', !state.allYear);
  if (state.allYear) {
    setText(card.dateFallback, 'All year — every day of the year.');
  } else if (!state.canPick) {
    setText(card.dateFallback, 'No single start and end for this month range.');
  }

  const rowErrors = period.rows.map((entry) => rateValidation.rows[entry.index] || {});
  const fromError = rowErrors.map((errors) => errors.from).find(Boolean) || '';
  const toError = rowErrors.map((errors) => errors.to).find(Boolean) || '';
  const dateErrors = Boolean(fromError || toError);
  card.fromDate.setAttribute('aria-invalid', String(Boolean(fromError)));
  card.toDate.setAttribute('aria-invalid', String(Boolean(toError)));
  const messages = [
    fromError ? `Starts: ${fromError}` : '',
    toError ? `Ends: ${toError}` : '',
  ].filter(Boolean);
  card.dateError.hidden = messages.length === 0;
  setText(card.dateError, messages.join(' '));
  card.dateFocus = fromError ? card.fromDate : toError ? card.toDate : card.fromDate;

  // A native date input cannot show 30 February. Keep the stored spelling
  // visible in words, so a malformed row is still diagnosable rather than just
  // a blank picker.
  const stored = [];
  for (const [label, rawValue] of [
    ['Starts', state.raw.from],
    ['Ends', state.raw.to],
  ]) {
    if (rawValue != null && rawValue !== '' && rawValue !== '00-00' && !parseMonthDay(rawValue)) {
      stored.push(`${label} ${rawValue}`);
    }
  }
  card.dateStored.hidden = stored.length === 0;
  setText(card.dateStored, stored.length ? `Stored: ${stored.join(' · ')}.` : '');

  let status = '';
  if (state.allYear) {
    status = 'Uncheck All year to choose a start and end.';
  } else if (state.dateMode) {
    status = dateErrors
      ? 'Choose real start and end dates to keep this season day-precise.'
      : 'Starts and ends are inclusive.';
  } else if (state.seed) {
    status = `Stored as a month range (${rateMonthsText(period.months)}). Editing a start or end date makes this season day-precise.`;
  } else if (period.kind === 'invalid') {
    status = 'Use Advanced: month ranges to fix this season.';
  } else {
    status = 'Use Advanced: month ranges to edit this season.';
  }
  const wrapHint = !state.allYear && !dateDisabled ? dateRangeHint(values.from, values.to) : '';
  setText(card.dateStatus, wrapHint ? `${status} ${wrapHint}` : status);

  // Months are advanced: visible for date seasons (a rounding route) and legacy
  // month scopes, but not for All year or a malformed date scope. A
  // non-contiguous month scope opens the disclosure so it remains editable.
  const hideAdvanced = state.allYear || (state.dateMode && period.kind === 'invalid');
  card.advancedMonths.hidden = hideAdvanced;
  let monthSummary = '';
  if (!state.allYear && !hideAdvanced) {
    monthSummary =
      period.kind === 'invalid' ? 'needs attention' : rateMonthsText(period.months, period.kind);
  }
  setText(card.advancedSummary, monthSummary ? ` · ${monthSummary}` : '');
  setText(
    card.advancedHint,
    state.dateMode
      ? 'Editing a month chip rounds this season to whole months.'
      : period.kind === 'invalid'
        ? 'Pick the months this season covers; dates need one continuous range.'
        : 'Editing a month chip keeps this season on month precision.',
  );
  paintMonthEditor(card);
}

function paintPeriodMode(card) {
  const windows = card.period.windows ? card.period.windows.length : 0;
  card.addButton.disabled = settingsSaving || draftRates.length >= MAX_RATE_WINDOWS;
  card.addButton.hidden = false;
  if (card.windowsEmpty) {
    card.windowsEmpty.hidden = !card.period.base || windows > 0;
  }
}

function periodName(period) {
  return period.title === 'Custom months' ? period.monthText : period.title;
}

// The header tells the truth for the representative month: the price range
// includes the effective bases/windows and sibling rows that apply there, while
// the count stays the period's own rows. Unpriced hours show as 0.00.
function paintPeriodHeader(card) {
  const period = card.period;
  setText(card.title, period.title);
  card.list.setAttribute('aria-label', `Windows in ${periodName(period)}`);
  card.addButton.setAttribute('aria-label', `Add a window to ${periodName(period)}`);
  card.editDates.setAttribute('aria-label', `Edit season dates for ${periodName(period)}`);
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
  const noun = period.base ? (count === 1 ? 'rate' : 'rates') : count === 1 ? 'window' : 'windows';
  const countText = `${count} ${noun}`;
  // The range covers one representative month (January for an all-year scope,
  // otherwise the first month of the scope). Naming it keeps an All-year header
  // from advertising a range that a July sibling changes; the table caption
  // repeats the same month.
  const example = range && !dateMode ? `${MONTH_NAMES[range.month - 1].slice(0, 3)} example` : '';
  // A row with no usable price contributes nothing to the range. A range held up
  // only by uncovered hours must not advertise a price this season does not
  // charge; the plan summary and the checker say the same thing at the same
  // moment.
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
  paintBaseBlock(card);
  paintPeriodMode(card);
}

function setExpanded(card, expanded) {
  if (expanded) expandedPeriods.add(card.key);
  else expandedPeriods.delete(card.key);
  card.toggle.setAttribute('aria-expanded', String(expanded));
  if (card.editDates) card.editDates.setAttribute('aria-expanded', String(expanded));
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
    canDuplicatePeriod(draftRates.length, count) &&
    !settingsSaving;
  card.duplicateButton.hidden = !canDuplicate || confirming;
  card.removeButton.hidden = confirming;
  card.confirm.hidden = !confirming;
  setText(card.confirmText, `Remove the season and ${count} ${count === 1 ? 'rate' : 'rates'}?`);
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

  const ownerOf = (segment) => {
    if (!segment.window) return null;
    if (coverage.ownIds.has(segment.window.id)) return period;
    return planPeriods.find((entry) => entry.rows.some((row) => row.row.id === segment.window.id));
  };
  // A segment's band: Base for a base row, a relative tier for an override (only
  // when its season has a base), and Uncovered for an hour no row prices.
  const labelFor = (segment) => {
    const owner = ownerOf(segment);
    const base = owner ? periodBaseRate(owner) : null;
    const rates = owner ? owner.rows.map((entry) => entry.row.rate) : windowRates();
    return rateSegmentLabel(segment, rates, base);
  };

  // The legend is collected from the same resolved segments the strip and the
  // table draw, so every dot carries the name of the row it stands for.
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
        legend.set(key, labelFor(segment));
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
              ? 'Uncovered'
              : needsRate(segment)
                ? 'Needs a rate'
                : owner === period
                  ? labelFor(segment)
                  : `${periodBandLabel(owner)} ${labelFor(segment)}`;
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
    content.push(el('p', 'coverage-empty', 'No usable rates yet.'));
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
      const tr = el('tr', segment.window ? (own ? '' : 'sibling') : 'uncovered');
      const time = el('th', null, `${minutesToClock(segment.from)}–${minutesToClock(segment.to)}`);
      time.scope = 'row';
      const note = segmentNote(segment);
      if (note) time.append(el('span', 'segment-note', note));
      const band = el('td', 'band');
      if (own) {
        const tier = labelFor(segment);
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
        const tier = labelFor(segment);
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
        band.textContent = 'Uncovered';
      }
      // An own row with no usable price names the gap: quoting a price here
      // would assert something the rest of the screen denies.
      const price = needsRate(segment) ? needsAttentionCell() : priceCell(segment.rate);
      tr.append(time, band, price);
      tbody.append(tr);
    }
    table.append(caption, thead, tbody);
    content.push(table);
  }
  card.coverage.replaceChildren(...content);
}

// The base rate block: one price for every hour not covered by a daily window.
// A malformed all-day row is kept in the daily-window list instead, where its
// time controls can repair it.
function createBaseBlock(card, period, index) {
  const block = el('section', 'base-block');
  const head = el('div', 'base-head');
  const title = el('h6', 'base-title', 'Base rate');
  head.append(title);
  const baseEntry = period.base;
  const baseErrorId = `period-${index}-base-error`;
  const noteId = `period-${index}-base-note`;
  let baseInput = null;
  let baseError = null;
  let addBaseButton = null;
  let removeBaseButton = null;
  let baseCard = null;

  if (baseEntry) {
    const note = el('p', 'base-note', 'One price for every hour not covered by a window.');
    note.id = noteId;
    const field = el('div', 'field base-field');
    const label = el('label', 'field-label', 'Rate');
    label.htmlFor = `period-${index}-base-rate`;
    const wrap = el('div', 'input-wrap');
    baseInput = el('input', 'text-input base-rate-input rate-input');
    baseInput.type = 'number';
    baseInput.min = '0';
    baseInput.max = '5';
    baseInput.step = '0.001';
    baseInput.inputMode = 'decimal';
    baseInput.placeholder = '0.000';
    baseInput.autocomplete = 'off';
    baseInput.id = `period-${index}-base-rate`;
    baseInput.value = baseEntry.row.rate;
    baseInput.dataset.field = 'base-rate';
    baseInput.setAttribute('aria-label', 'Base rate');
    baseInput.setAttribute('aria-describedby', `${noteId} ${baseErrorId}`);
    const suffix = el('span', 'input-suffix', '/ kWh');
    suffix.setAttribute('aria-hidden', 'true');
    wrap.append(baseInput, suffix);
    field.append(label, wrap);
    baseError = el('p', 'rule-error base-error');
    baseError.id = baseErrorId;
    baseError.hidden = true;
    baseInput.addEventListener('input', () => {
      baseEntry.row.rate = baseInput.value;
      markEdited();
      refresh();
    });
    removeBaseButton = el('button', 'btn small danger', 'Remove base rate');
    removeBaseButton.type = 'button';
    removeBaseButton.dataset.action = 'remove-base-rate';
    removeBaseButton.addEventListener('click', () => removeBaseRate(card));
    head.append(removeBaseButton);
    block.append(head, note, field, baseError);
    baseCard = {
      row: baseEntry.row,
      index: baseEntry.index,
      node: block,
      periodCard: card,
      isBase: true,
      errorId: baseErrorId,
      errorEl: baseError,
      rateInput: baseInput,
    };
    windowCards[baseEntry.index] = baseCard;
    card.baseCard = baseCard;
    card.baseInput = baseInput;
    card.baseError = baseError;
    card.removeBaseButton = removeBaseButton;
  } else {
    const warning = el(
      'p',
      'base-warning',
      'No base rate — hours outside the windows have no price unless another season’s base covers them.',
    );
    card.baseWarning = warning;
    addBaseButton = el('button', 'btn small', 'Add base rate');
    addBaseButton.type = 'button';
    addBaseButton.dataset.action = 'add-base-rate';
    addBaseButton.addEventListener('click', () => addBaseRate(card));
    block.append(head, warning, addBaseButton);
    card.addBaseButton = addBaseButton;
  }
  card.baseBlock = block;
  return block;
}

// The add action follows the stored One-rate value, but never silently prices a
// season: the owner sees the number and can change it in the base field.
function paintBaseBlock(card) {
  const flat = $('setting-rate').value;
  const usable = rateIsUsable(flat);
  if (card.addBaseButton) {
    const covered = periodHasBaseOverlap(card.period, draftRates);
    card.addBaseButton.hidden = covered;
    if (card.baseWarning) {
      setText(
        card.baseWarning,
        covered
          ? 'No base rate in this season — another season’s base prices these hours.'
          : 'No base rate — hours outside the windows have no price unless another season’s base covers them.',
      );
    }
    setText(
      card.addBaseButton,
      usable ? `Add base rate (${priceText(flat)} from One rate)` : 'Add base rate',
    );
    card.addBaseButton.setAttribute(
      'aria-label',
      usable ? `Add a base rate using ${priceText(flat)} from One rate` : 'Add a base rate',
    );
    card.addBaseButton.disabled = settingsSaving || draftRates.length >= MAX_RATE_WINDOWS;
  }
  if (card.removeBaseButton) {
    card.removeBaseButton.hidden = !card.period.base || card.period.windows.length === 0;
  }
  if (card.windowsEmpty) {
    card.windowsEmpty.hidden = !card.period.base || card.period.windows.length > 0;
  }
}

function createPeriodCard(period, index) {
  const node = el('article', 'rate-period');
  node.dataset.key = period.key;
  const card = {
    key: period.key,
    period,
    node,
    toggle: null,
    title: null,
    band: null,
    meta: null,
    flag: null,
    strip: null,
    axis: null,
    legend: null,
    desc: null,
    body: null,
    seasonDates: null,
    editDates: null,
    allYear: null,
    fromDate: null,
    dateFields: null,
    dateFallback: null,
    toDate: null,
    dateReference: null,
    dateStatus: null,
    dateStored: null,
    dateError: null,
    dateFocus: null,
    advancedMonths: null,
    advancedSummary: null,
    advancedHint: null,
    monthChips: null,
    baseBlock: null,
    baseInput: null,
    baseError: null,
    addBaseButton: null,
    removeBaseButton: null,
    baseCard: null,
    windowsSection: null,
    windowsEmpty: null,
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
  titleRow.append(title, band, caret, flag);
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
  const headRow = el('div', 'period-head-row');
  const editDates = el('button', 'period-edit-dates', 'Edit dates');
  editDates.type = 'button';
  editDates.dataset.action = 'edit-dates';
  editDates.setAttribute('aria-controls', bodyId);
  editDates.setAttribute('aria-expanded', String(expanded));
  editDates.setAttribute('aria-label', `Edit season dates for ${periodName(period)}`);
  headRow.append(toggle, editDates);
  heading.append(headRow);
  node.append(heading);
  card.toggle = toggle;
  card.editDates = editDates;
  card.title = title;
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

  const scopeEditor = el('section', 'season-dates');
  const seasonDatesTitleId = `period-${index}-season-dates`;
  scopeEditor.setAttribute('aria-labelledby', seasonDatesTitleId);

  const datesHead = el('div', 'season-dates-head');
  const datesTitle = el('h6', 'season-dates-title', 'Season dates');
  datesTitle.id = seasonDatesTitleId;
  const allYearLabel = el('label', 'months-toggle season-all-year');
  const allYear = el('input');
  allYear.type = 'checkbox';
  allYear.id = `period-${index}-all-year`;
  allYearLabel.append(allYear, el('span', null, 'All year'));
  datesHead.append(datesTitle, allYearLabel);

  const referenceId = `period-${index}-date-reference`;
  const reference = el(
    'p',
    'season-dates-reference',
    'Repeats every year. The year is only a reference — 2024 is a leap year, so 29 February is available.',
  );
  reference.id = referenceId;

  const dateField = (labelText, id, input) => {
    const field = el('div', 'season-date-field');
    const label = el('label', 'field-label', labelText);
    label.htmlFor = id;
    field.append(label, input);
    return field;
  };
  const fromDateId = `period-${index}-starts`;
  const toDateId = `period-${index}-ends`;
  const statusId = `period-${index}-date-status`;
  const storedId = `period-${index}-date-stored`;
  const errorId = `period-${index}-date-error`;
  const fromDate = el('input', 'season-date-input');
  fromDate.type = 'date';
  fromDate.id = fromDateId;
  fromDate.min = `${DATE_REFERENCE_YEAR}-01-01`;
  fromDate.max = `${DATE_REFERENCE_YEAR}-12-31`;
  fromDate.dataset.field = 'from-date';
  fromDate.setAttribute('aria-label', 'Season start date');
  fromDate.setAttribute('aria-describedby', `${referenceId} ${statusId} ${storedId} ${errorId}`);
  const toDate = el('input', 'season-date-input');
  toDate.type = 'date';
  toDate.id = toDateId;
  toDate.min = `${DATE_REFERENCE_YEAR}-01-01`;
  toDate.max = `${DATE_REFERENCE_YEAR}-12-31`;
  toDate.dataset.field = 'to-date';
  toDate.setAttribute('aria-label', 'Season end date');
  toDate.setAttribute('aria-describedby', `${referenceId} ${statusId} ${storedId} ${errorId}`);

  const dateFields = el('div', 'season-date-fields');
  const arrow = el('span', 'season-date-arrow', '→');
  arrow.setAttribute('aria-hidden', 'true');
  dateFields.append(
    dateField('Starts', fromDateId, fromDate),
    arrow,
    dateField('Ends', toDateId, toDate),
  );
  const dateFallback = el('p', 'season-dates-fallback');
  dateFallback.hidden = true;

  const status = el('p', 'season-dates-status');
  status.id = statusId;
  allYear.setAttribute('aria-describedby', `${referenceId} ${statusId}`);
  const stored = el('p', 'season-dates-stored');
  stored.id = storedId;
  stored.hidden = true;
  const dateError = el('p', 'rule-error season-dates-error');
  dateError.id = errorId;
  dateError.hidden = true;

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

  const advanced = el('details', 'advanced-months');
  const advancedSummaryRow = el('summary', 'advanced-summary-row');
  const advancedSummary = el('span', 'advanced-summary');
  advancedSummaryRow.append(el('span', null, 'Advanced: month ranges'), advancedSummary);
  const advancedHint = el('p', 'advanced-hint');
  advanced.append(advancedSummaryRow, advancedHint, monthChips);
  // A legacy non-contiguous or malformed month scope has no single date range;
  // open its month editor so it remains editable without making months the
  // first decision for normal seasons.
  advanced.open = period.kind !== 'all' && !periodHasDates(period) && !periodDateSeed(period);

  scopeEditor.append(
    datesHead,
    reference,
    dateFields,
    dateFallback,
    status,
    stored,
    dateError,
    advanced,
  );
  card.monthEditor = scopeEditor;
  card.seasonDates = scopeEditor;
  card.allYear = allYear;
  card.fromDate = fromDate;
  card.toDate = toDate;
  card.dateFields = dateFields;
  card.dateFallback = dateFallback;
  card.dateReference = reference;
  card.dateStatus = status;
  card.dateStored = stored;
  card.dateError = dateError;
  card.advancedMonths = advanced;
  card.advancedSummary = advancedSummary;
  card.advancedHint = advancedHint;
  card.monthChips = monthChips;

  allYear.addEventListener('change', () => {
    if (settingsSaving) return;
    if (allYear.checked) {
      applyMonths(card, null, { focusCheckbox: true });
      return;
    }
    const seed = periodDateSeed({ kind: 'all' }, new Date());
    applyDates(card, seed.from, seed.to);
    card.fromDate.focus({ preventScroll: true });
  });

  const commitDates = () => {
    if (settingsSaving) return;
    const from = boundFromDateInput(fromDate.value);
    const to = boundFromDateInput(toDate.value);
    const current = periodDateBounds(card.period);
    if (from === (current.from ?? null) && to === (current.to ?? null)) return;
    applyDates(card, from, to);
  };
  fromDate.addEventListener('change', commitDates);
  toDate.addEventListener('change', commitDates);

  editDates.addEventListener('click', () => {
    if (settingsSaving) return;
    setExpanded(card, true);
    const state = seasonDateState(card.period);
    if (state.allYear) {
      card.allYear.focus({ preventScroll: true });
    } else if (state.canPick) {
      (card.dateFocus || card.fromDate).focus({ preventScroll: true });
    } else {
      card.advancedMonths.open = true;
      const chip =
        card.monthChips.querySelector('[aria-pressed="true"]') ||
        card.monthChips.querySelector('button') ||
        card.advancedMonths.querySelector('summary');
      chip.focus({ preventScroll: true });
    }
    scrollToNode(card.seasonDates);
  });

  const baseBlock = createBaseBlock(card, period, index);

  const coverage = el('div', 'coverage');
  const list = el('div', 'rate-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', `Daily windows in ${periodName(period)}`);
  const addButton = el('button', 'btn add-rule');
  addButton.type = 'button';
  addButton.dataset.action = 'add-window';
  addButton.append(el('span', 'add-plus', '+'), el('span', null, 'Add window'));
  addButton.setAttribute('aria-label', `Add a daily window to ${periodName(period)}`);
  addButton.addEventListener('click', () => addWindow(card));

  const windowsSection = el('section', 'windows-section');
  const windowsTitle = el('h6', 'windows-title', 'Daily windows (optional)');
  const windowsHint = el(
    'p',
    'windows-hint',
    'A daily window overrides the base for its days and hours.',
  );
  const windowsEmpty = el('p', 'windows-empty', 'No daily windows — the base covers every hour.');
  windowsEmpty.hidden = true;
  windowsSection.append(windowsTitle, windowsHint, windowsEmpty, list, addButton);
  card.windowsSection = windowsSection;
  card.windowsEmpty = windowsEmpty;

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

  body.append(scopeEditor, baseBlock, windowsSection, coverage, periodActions);
  node.append(body);

  period.windows.forEach((entry) => {
    const windowCard = createWindowCard(entry, card);
    windowCards[entry.index] = windowCard;
    card.cards.push(windowCard);
    list.append(windowCard.node);
  });
  card.list = list;
  card.addButton = addButton;
  card.coverage = coverage;

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
function applyMonths(card, months, { focusMonth = null, focusCheckbox = false } = {}) {
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
  } else if (focusMonth != null) {
    // The chips live in the advanced disclosure; a target must reveal the chip
    // before trying to focus it.
    next.advancedMonths.open = true;
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
// swallow the very next action. So: repaint
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
    if (periodHasDates(card.period)) card.fromDate.focus({ preventScroll: true });
    else card.allYear.focus({ preventScroll: true });
    return;
  }
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

function addBaseRate(card) {
  if (settingsSaving || card.period.base) return;
  if (periodHasBaseOverlap(card.period, draftRates)) return;
  const flat = $('setting-rate').value;
  const scope = periodRowScope(card.period);
  const row = baseRateRow(
    crypto.randomUUID(),
    rateIsUsable(flat) ? flat : '',
    scope.months,
    scope.dates,
  );
  const first = card.period.rows[0] ? card.period.rows[0].index : draftRates.length;
  draftRates = [...draftRates.slice(0, first), row, ...draftRates.slice(first)];
  planPeriods = ratePeriodsForDraft();
  expandedPeriods.add(card.key);
  markEdited();
  renderPlan();
  const next = periodCards.find((entry) => entry.key === card.key);
  if (next && next.baseInput) {
    next.baseInput.focus({ preventScroll: true });
    scrollToNode(next.baseBlock);
  }
}

function removeBaseRate(card) {
  if (settingsSaving || !card.period.base) return;
  const index = card.period.base.index;
  const key = card.key;
  const previous = draftRates;
  draftRates = draftRates.filter((_, rowIndex) => rowIndex !== index);
  settleFlatRate(previous);
  planPeriods = ratePeriodsForDraft();
  if (!planPeriods.some((period) => period.key === key)) expandedPeriods.delete(key);
  else expandedPeriods.add(key);
  markEdited();
  renderPlan();
  const next = periodCards.find((entry) => entry.key === key);
  if (next && next.addBaseButton && !next.addBaseButton.hidden) {
    next.addBaseButton.focus({ preventScroll: true });
  } else if (next && next.addButton) {
    next.addButton.focus({ preventScroll: true });
  } else {
    focusAfterRemoval();
  }
}

function fillGaps() {
  if (settingsSaving) return;
  const scopes = uncoveredGapScopes(draftRates);
  if (scopes.length === 0) return;
  const rows = scopes.map((scope) =>
    baseRateRow(
      crypto.randomUUID(),
      '',
      scope.months,
      scope.from != null ? { from: scope.from, to: scope.to } : null,
    ),
  );
  draftRates = [...draftRates, ...rows];
  planPeriods = ratePeriodsForDraft();
  for (const period of planPeriods) {
    if (period.rows.some((entry) => rows.some((row) => row.id === entry.row.id))) {
      expandedPeriods.add(period.key);
    }
  }
  markEdited();
  renderPlan();
  const first = periodCards.find((card) =>
    card.period.rows.some((entry) => rows.some((row) => row.id === entry.row.id)),
  );
  if (first && first.baseInput) {
    first.baseInput.focus({ preventScroll: true });
    scrollToNode(first.baseBlock);
  }
}

function addSeason() {
  if (settingsSaving || draftRates.length >= MAX_RATE_WINDOWS) return;
  const scope = largestDateScope(uncoveredDateRanges(draftRates));
  const hasBase = planPeriods.some((period) => Boolean(period.base));
  // A new season is a base. Prefer the largest uncovered range; when the year is
  // already covered and no base exists, an All-year base can layer over existing
  // windows (a base plus overrides is valid). With a base already present there
  // is nowhere non-overlapping to put another, so the action is not offered.
  let dates = scope && !scope.fullYear ? { from: scope.from, to: scope.to } : null;
  if (!scope && hasBase) return;
  const months = dates ? monthsCovering(dates.from, dates.to) : null;
  const row = baseRateRow(crypto.randomUUID(), '', months, dates);
  const targetKey = dates ? `dates:${dates.from}-${dates.to}` : 'all';
  const existing = planPeriods.find((period) => period.key === targetKey);
  const insertAt =
    existing && existing.rows.length > 0 ? existing.rows[0].index : draftRates.length;
  draftRates = [...draftRates.slice(0, insertAt), row, ...draftRates.slice(insertAt)];
  planPeriods = ratePeriodsForDraft();
  const target = planPeriods.find((period) => period.rows.some((entry) => entry.row.id === row.id));
  if (target) expandedPeriods.add(target.key);
  markEdited();
  renderPlan();
  const added = periodCards.find((period) =>
    period.period.rows.some((entry) => entry.row.id === row.id),
  );
  if (added) {
    added.baseInput.focus({ preventScroll: true });
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

function settleFlatRate(previousRows) {
  if (draftRates.length > 0) return;
  const flat = scheduleToFlatRate(previousRows, $('setting-rate').value);
  if (typeof flat === 'number') $('setting-rate').value = String(flat);
}

function removePeriod(card) {
  const indices = new Set(card.period.rows.map((entry) => entry.index));
  const previous = draftRates;
  draftRates = draftRates.filter((_, index) => !indices.has(index));
  settleFlatRate(previous);
  expandedPeriods.delete(card.key);
  removeConfirmKey = null;
  markEdited();
  renderPlan();
  focusAfterRemoval();
}

function removeWindow(card) {
  if (settingsSaving) return;
  const periodKey = card.periodCard.key;
  const previous = draftRates;
  draftRates = draftRates.filter((_, index) => index !== card.index);
  settleFlatRate(previous);
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
  $('rate-mode-flat').focus({ preventScroll: true });
}

// ---------- painting ----------

function ratePeriodsForDraft() {
  return ratePeriods(draftRates);
}

function paintPlan() {
  const mode = currentRateMode();
  paintRateMode();
  if (mode === 'flat') {
    planPeriods = [];
    $('rates-plan').hidden = true;
    $('uncovered-line').hidden = true;
    return;
  }

  planPeriods = ratePeriodsForDraft();
  // Only rows that can match and pass validation set a meaningful range; an
  // invalid row is shown and fixed but its price never applies. A base-less
  // season and a date gap both put 0 in the range, so the plan cannot advertise
  // a minimum it does not actually charge.
  const rateRows = planPeriods
    .filter((period) => period.kind !== 'invalid')
    .flatMap((period) => period.rows)
    .filter((entry) => Object.keys(rateValidation.rows[entry.index] || {}).length === 0)
    .map((entry) => entry.row);
  const range = ratePlanRange(rateRows);
  const problems = validationProblemCount(rateValidation, draftRates.length);
  const capped = draftRates.length > MAX_RATE_WINDOWS;
  const gaps = mergeDateRanges(uncoveredDateRanges(draftRates));
  const counts = `${planPeriods.length} ${planPeriods.length === 1 ? 'season' : 'seasons'} · ${
    draftRates.length
  } ${draftRates.length === 1 ? 'rate' : 'rates'}`;
  const summary = [nowrapEl(counts)];
  if (range) summary.push(nowrapEl(`\u00a0· ${priceRangeText(range)}`));
  else summary.push(nowrapEl('\u00a0· — needs attention'));
  if (gaps.length > 0) {
    summary.push(nowrapEl(`\u00a0· ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'}`));
  }
  $('plan-summary-text').replaceChildren(...summary);
  const problem = $('plan-problem');
  const problemText = planProblemText({ problems, capped });
  problem.hidden = problems === 0;
  setText(problem, problemText);

  const uncoveredLine = $('uncovered-line');
  const gapText = dateSetText(gaps);
  uncoveredLine.hidden = gaps.length === 0;
  if (gaps.length > 0) {
    const dateNode = $('uncovered-dates');
    dateNode.replaceChildren();
    gapText.split(', ').forEach((run, index) => {
      if (index > 0) dateNode.append(', ');
      dateNode.append(nowrapEl(index === 0 ? `· ${run}` : run));
    });
    const fill = $('fill-gaps');
    setText(fill, `Fill ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'}`);
    fill.setAttribute(
      'aria-label',
      `Fill ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'}: ${gapText}`,
    );
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
  const addNote = (map, index, text) => {
    if (!map.has(index)) map.set(index, []);
    map.get(index).push(text);
  };
  const notes = new Map();
  for (const [a, b] of rateValidation.overlaps) {
    const sameScope = rateScopeText(draftRates[a]) === rateScopeText(draftRates[b]);
    const left = windowLabel(draftRates[a], rates, fallback, { months: !sameScope });
    const right = windowLabel(draftRates[b], rates, fallback, { months: !sameScope });
    addNote(notes, a, left === right ? 'Overlaps an identical window' : `Overlaps “${right}”`);
    addNote(notes, b, left === right ? 'Overlaps an identical window' : `Overlaps “${left}”`);
  }

  for (const card of windowCards) {
    if (!card) continue;
    const errors = rateValidation.rows[card.index] || {};
    const rowNotes = notes.get(card.index) || [];
    // Date errors belong to the season's Starts/Ends editor, which prefixes the
    // field name; repeating the bare sentence inside every member row is noise.
    const rowMessages = Object.entries(errors)
      .filter(([field]) => field !== 'from' && field !== 'to')
      .map(([, message]) => message);
    const messages = [...new Set([...rowMessages, ...rowNotes])];
    card.errorEl.hidden = messages.length === 0;
    setText(card.errorEl, messages.join(' '));
    card.rateInput.setAttribute('aria-invalid', String(Boolean(errors.rate)));
    if (!card.isBase) {
      card.presetsEl.setAttribute('aria-invalid', String(Boolean(errors.days)));
      card.daysEl.setAttribute('aria-invalid', String(Boolean(errors.days)));
      card.daysEl.classList.toggle('invalid', Boolean(errors.days));
      card.startInput.setAttribute('aria-invalid', String(Boolean(errors.start)));
      card.endInput.setAttribute('aria-invalid', String(Boolean(errors.end)));
    }
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
  }

  const general = rateValidation.general.join(' ');
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

  // Saving locks the plan; the cap disables the add paths.
  for (const node of $('rates-plan').querySelectorAll('input, button, select')) {
    node.disabled = settingsSaving;
  }
  const atCap = draftRates.length >= MAX_RATE_WINDOWS;
  const hasBase = planPeriods.some((period) => Boolean(period.base));
  const noUncoveredDates = uncoveredDateRanges(draftRates).length === 0;
  // A new base needs an uncovered range. With every date covered and a base
  // already present, another base would only collide.
  const addSeasonBlocked = noUncoveredDates && hasBase;
  $('add-season').disabled = settingsSaving || atCap || addSeasonBlocked;
  $('add-season').title = addSeasonBlocked ? 'A base season already covers every date.' : '';
  const fillCount = uncoveredGapScopes(draftRates).length;
  $('fill-gaps').disabled = settingsSaving || draftRates.length + fillCount > MAX_RATE_WINDOWS;
  $('fill-gaps').title = draftRates.length + fillCount > MAX_RATE_WINDOWS ? RATE_CAP_REMEDY : '';
  for (const card of periodCards) {
    // The blanket lock above enables everything when not saving; restore the
    // feature-level disabled states (date/month modes, row cap) after it.
    paintScopeEditor(card);
    paintBaseBlock(card);
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

function paintPreview() {
  if (draftRates.length === 0) return;
  const table = $('preview-table');
  const empty = $('preview-empty');
  const note = $('preview-note');
  const blocker = previewBlocker(rateValidation);
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
    const band =
      result.source === 'base'
        ? 'Base'
        : result.source === 'window'
          ? result.tier
          : result.source === 'uncovered'
            ? 'Uncovered'
            : '';
    if (band) price.append(el('span', `tier ${tierClass(band)}`, band));
    const money = el('span', 'preview-money');
    money.append(el('strong', null, priceText(result.rate)), el('span', 'unit', '/ kWh'));
    price.append(money);
  }
  rows.push(paintPreviewRow('Price', price));
  let applies = '';
  if (result.uncoveredDate) {
    applies = 'Uncovered date — no season covers this date — priced at 0.00.';
  } else if (result.unpricedHour) {
    applies = 'Uncovered hour — this season has no price for this hour — 0.00.';
  } else if (result.source === 'base') {
    applies = el('span');
    applies.append('Base · ', nowrapEl(result.scopeText));
  } else if (result.source === 'window') {
    applies = el('span');
    applies.append(`${result.summary} · `, nowrapEl(result.scopeText));
  } else {
    applies = 'One rate applies everywhere.';
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
  const blocker = previewBlocker(rateValidation);
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
  const band = result.tier ? `${result.tier}, ` : '';
  const where = result.uncoveredDate
    ? 'uncovered date, priced at 0.00'
    : result.unpricedHour
      ? 'uncovered hour, priced at 0.00'
      : result.source === 'base'
        ? `base ${result.scopeText}`
        : result.source === 'window'
          ? `${result.summary} · ${result.scopeText}`
          : 'one rate';
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
  $('confirm-one-rate').disabled = settingsSaving;
  $('cancel-one-rate').disabled = settingsSaving;
  paintRateMode();
}

// ---------- rendering ----------

function renderPlan() {
  // A full rebuild supersedes any deferred date rebuild: the draft it would
  // have rendered is the one being rendered now.
  cancelPlanRebuild();
  planPeriods = ratePeriodsForDraft();
  paintRateMode();
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
    // Month editing lives in the advanced disclosure now; reveal it and land on
    // a month chip instead of the All year option.
    if (card.periodCard.advancedMonths) card.periodCard.advancedMonths.open = true;
    const chip =
      card.periodCard.monthChips &&
      (card.periodCard.monthChips.querySelector('[aria-pressed="true"]') ||
        card.periodCard.monthChips.querySelector('button'));
    if (chip) chip.focus({ preventScroll: true });
    else card.periodCard.allYear.focus({ preventScroll: true });
    return;
  }
  // A base price error belongs to the Base rate block, not a window row.
  if (focus === 'base-rate') {
    view.expand(card.periodCard);
    view.reveal(card.periodCard.baseBlock);
    if (card.periodCard.baseInput) card.periodCard.baseInput.focus({ preventScroll: true });
    return;
  }
  // A date problem belongs to the season header too. Focus the From/To control
  // validation named, never the window's rate field.
  if (focus === 'dates') {
    view.expand(card.periodCard);
    view.reveal(card.periodCard.node);
    const control = card.periodCard.dateFocus || card.periodCard.fromDate;
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
  $('rate-mode-flat').addEventListener('click', requestOneRate);
  $('rate-mode-seasons').addEventListener('click', switchToSeasons);
  $('rate-mode-flat').addEventListener('keydown', paintModeKeyboard);
  $('rate-mode-seasons').addEventListener('keydown', paintModeKeyboard);
  $('confirm-one-rate').addEventListener('click', confirmOneRate);
  $('cancel-one-rate').addEventListener('click', cancelOneRate);
  $('rate-mode-confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancelOneRate();
  });
  $('fill-gaps').addEventListener('click', fillGaps);
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
