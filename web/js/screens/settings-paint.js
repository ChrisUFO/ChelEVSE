// The Config rate-plan paint pipeline: the period/window card builders and
// every paint pass over them. A view-only sibling of the settings screen — the
// screen owns the mutable state (the draft, the periods, the save flags) and
// hands it in as an explicit `state` object (live getters/setters plus the
// screen verbs the wiring calls back into), so this module never caches plan
// state of its own. Imported only by screens/settings.js.

import { $, buildDayPicker, el, setText } from '../ui.js';
import { fmtRate } from '../format.js';
import {
  DAY_PRESETS,
  MONTH_NAMES,
  boundFromDateInput,
  canDuplicatePeriod,
  complementScope,
  dateInputForBound,
  dateRangeHint,
  dateSetText,
  dayPresetFor,
  isAllDayWindow,
  mergeDateRanges,
  minutesToClock,
  monthEditorIsLegacy,
  periodBandCopy,
  periodBaseRate,
  periodCoverage,
  periodDateBounds,
  periodDateSeed,
  periodEffectiveRange,
  periodHasBaseOverlap,
  periodHasDates,
  planHasUnpriced,
  rateIsUsable,
  rateMonthsText,
  ratePlanRange,
  rateScopeText,
  rateSegmentLabel,
  rateTierFor,
  rateWindowSummary,
  scopesOverlap,
  segmentNote,
  siblingNote,
  timeFieldsVisible,
  toggledMonthScope,
  uncoveredDateRanges,
  uncoveredGapScopes,
  windowLabel,
} from '../settings/plan.js';
import { RATE_CAP_REMEDY, planProblemText, validationProblemCount } from '../settings/state.js';
import { MAX_RATE_WINDOWS, isBaseWindow, parseMonthDay, parseRateValue } from '../rates.js';

// ---------- small helpers ----------

function currency() {
  return $('setting-currency').value.trim();
}

function windowRates(state) {
  return state.draftRates.map((row) => row && row.rate);
}

export function tierClass(tier) {
  if (tier === 'Base') return 'base';
  if (tier === 'Uncovered') return 'uncovered';
  if (tier === 'Off-peak') return 'off';
  if (tier === 'Peak') return 'peak';
  if (tier === 'Shoulder') return 'shoulder';
  // A priced window in a season with no base has no relative tier, but it is
  // still a priced band of its own, not the "Same price" grey.
  if (tier === 'Window') return 'window';
  return 'same';
}

// The legend's order: base first, then the relative override tiers, then the
// uncovered 0.00 slice.
const LEGEND_ORDER = ['base', 'window', 'off', 'shoulder', 'peak', 'same', 'uncovered'];

function segmentClass(segment, state) {
  if (!segment || !segment.window) return 'uncovered';
  const owner = state.planPeriods.find((period) =>
    period.rows.some((entry) => entry.row && entry.row.id === segment.window.id),
  );
  const base = owner ? periodBaseRate(owner) : null;
  const rates = owner ? owner.rows.map((entry) => entry.row.rate) : windowRates(state);
  return tierClass(rateSegmentLabel(segment, rates, base));
}

function windowName(row, period = null, state) {
  const tier = bandName(row, period, state);
  return `${tier ? `${tier} ` : ''}${rateWindowSummary(row)}`;
}

// A daily window's visible band, relative to its season's base. A base row is
// handled by the Base rate block and the coverage label, not this tier name.
//
// The ranking uses the season's own rows, which is what the coverage table and
// the legend rank against, so a card can never say "Peak" where its row says
// "Window". A season with no base has no reference price at all: its windows are
// "Window" everywhere instead of being ranked against another season's base.
function bandName(row, period = null, state) {
  if (isBaseWindow(row)) return 'Base';
  const base = period ? periodBaseRate(period) : null;
  if (period && base == null) return 'Window';
  const rates = period ? period.rows.map((entry) => entry.row.rate) : windowRates(state);
  return rateTierFor(row && row.rate, rates, period ? base : state.readFields().rate);
}

export function priceText(rate) {
  return fmtRate(rate, currency());
}

// A price cell breaks between the currency code and the amount rather than
// running under the band column: the code can be CURRENCY_MAX (8) characters
// and the 30% price column at 320 px cannot hold "US cents" and "0.15303" on
// one line. Each half stays unbreakable, so a number never splits.
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

// Keep "USD 0.10–0.32" and the plan's other price runs together when a summary
// wraps; breaking inside a price reads as two different numbers. A class, not an
// NBSP substitution, so a break after the en dash is prevented too.
export function nowrapEl(text) {
  return el('span', 'nowrap', text);
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

function paintWindowCard(card, state) {
  const row = card.row;
  const period = card.periodCard ? card.periodCard.period : null;
  const name = windowName(row, period, state);
  const band = bandName(row, period, state);
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

function createDayControl(card, state) {
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
        state.commitRowShape(card);
        return;
      }
      // Custom only reveals the chips; it never changes the days by itself.
      card.customDays = true;
      paintDayControl(card);
    });
    card.presetEls.push(button);
    presets.append(button);
  });

  const days = buildDayPicker({
    className: 'plan-days',
    chipClass: 'plan-day',
    describeId: card.errorId,
    getDays: () => card.row.days,
    dataDay: true,
    onToggle: (day, nextDays) => {
      card.row.days = nextDays;
      card.customDays = true;
      state.commitRowShape(card);
    },
  });
  wrap.append(presets, days);
  card.presetsEl = presets;
  card.daysEl = days;
  return wrap;
}

function createWindowCard(entry, periodCard, state) {
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
  const title = el('h5', 'rate-title');
  const summary = el('p', 'rate-summary');
  heading.append(title, summary);
  const remove = el('button', 'rate-remove', 'Remove');
  remove.type = 'button';
  remove.addEventListener('click', () => state.removeWindow(card));
  head.append(heading, remove);
  card.title = title;
  card.summary = summary;
  card.removeButton = remove;

  const rateWrap = el('div', 'input-wrap');
  const rateInput = el('input', 'text-input rate-input');
  rateInput.type = 'number';
  rateInput.min = '0';
  rateInput.max = '5';
  // `step = 'any'`: the price contract is only "a number from 0 to 5", so the
  // field must not narrow precision to three decimals. With `0.001` a real
  // tariff such as 0.11270 (11.27p/kWh) made the field constraint-invalid
  // (`validity.stepMismatch`), and the handler below stores `input.value`
  // verbatim: a number input reports an empty value whenever the browser
  // cannot keep the typed text, which then reads as the confusing "Enter a rate
  // between 0 and 5." The 0–5 rule stays the only bound.
  rateInput.step = 'any';
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
    state.markEdited();
    state.refresh();
  });
  card.rateInput = rateInput;

  const dayControl = createDayControl(card, state);
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
    state.commitRowShape(card);
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
      paintWindowCard(card, state);
    });
  };
  timeBlock.addEventListener('focusout', onTimeExit);

  const allDayRow = el('div', 'all-day-row');
  allDayRow.append(el('span', 'all-day-text', 'All day'));
  const setTimes = el('button', 'link-btn', 'Set times');
  setTimes.type = 'button';
  setTimes.setAttribute('aria-label', `Set start and end times for ${rateWindowSummary(row)}`);
  setTimes.addEventListener('click', () => {
    if (state.settingsSaving) return;
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
  paintWindowCard(card, state);
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
function paintScopeEditor(card, state) {
  const period = card.period;
  const seasonState = seasonDateState(period);
  const values = seasonState.values;
  card.allYear.checked = seasonState.allYear;

  // Normalize the visible year back to the reference year. A native picker may
  // have produced any year at all; only the month and day are kept. The field
  // opens on the current local year and has no `min`/`max`, so any year can be
  // typed or picked, while a stored 29 February renders in the next leap year
  // rather than blanking.
  const now = new Date();
  const fromValue = dateInputForBound(values.from, now);
  const toValue = dateInputForBound(values.to, now);
  if (card.fromDate.value !== fromValue) card.fromDate.value = fromValue;
  if (card.toDate.value !== toValue) card.toDate.value = toValue;

  const dateDisabled = state.settingsSaving || !seasonState.canPick;
  card.fromDate.disabled = dateDisabled;
  card.toDate.disabled = dateDisabled;
  // The year reference (and its leap-day sentence) says nothing while the whole
  // year is the scope: there is no date to pick. It costs four lines on the most
  // common season shape.
  card.dateReference.hidden = seasonState.allYear;

  // Do not leave two empty pickers looking like required fields when the scope
  // has no single start/end (All year or separate month ranges). A read-only
  // value takes their place and the real control is the checkbox or the month
  // editor below.
  const showFallback = seasonState.allYear || !seasonState.canPick;
  card.dateFields.hidden = showFallback;
  card.dateFallback.hidden = !showFallback;
  card.dateFallback.classList.toggle('unavailable', !seasonState.allYear);
  if (seasonState.allYear) {
    setText(card.dateFallback, 'All year — every day of the year.');
  } else if (!seasonState.canPick) {
    setText(card.dateFallback, 'No single start and end for this month range.');
  }

  const rowErrors = period.rows.map((entry) => state.rateValidation.rows[entry.index] || {});
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
    ['Starts', seasonState.raw.from],
    ['Ends', seasonState.raw.to],
  ]) {
    if (rawValue != null && rawValue !== '' && rawValue !== '00-00' && !parseMonthDay(rawValue)) {
      stored.push(`${label} ${rawValue}`);
    }
  }
  card.dateStored.hidden = stored.length === 0;
  setText(card.dateStored, stored.length ? `Stored: ${stored.join(' · ')}.` : '');

  let status = '';
  if (seasonState.allYear) {
    status = 'Uncheck All year to choose a start and end.';
  } else if (seasonState.dateMode) {
    status = dateErrors
      ? 'Choose real start and end dates to keep this season day-precise.'
      : 'Starts and ends are inclusive.';
  } else if (seasonState.seed) {
    // Owner language, not storage language: the month range is what is priced,
    // and the dates above are how to make it exact.
    status = `Month range · ${rateMonthsText(period.months)}. Edit the dates to make this exact.`;
  } else if (period.kind === 'invalid') {
    status = 'Fix this season with the month ranges below.';
  } else {
    status = 'This season is stored as separate months. Pick the months it covers.';
  }
  const wrapHint =
    !seasonState.allYear && !dateDisabled ? dateRangeHint(values.from, values.to) : '';
  setText(card.dateStatus, wrapHint ? `${status} ${wrapHint}` : status);

  // Dates are the only normal scope editor. The month chips are the
  // compatibility path: offered only for a legacy non-contiguous month list or a
  // month scope that has to be repaired, never for a date-precise season.
  const hideAdvanced = !monthEditorIsLegacy(period);
  card.advancedMonths.hidden = hideAdvanced;
  let monthSummary = '';
  if (!hideAdvanced) {
    monthSummary =
      period.kind === 'invalid' ? 'needs attention' : rateMonthsText(period.months, period.kind);
  }
  setText(card.advancedSummary, monthSummary ? ` · ${monthSummary}` : '');
  setText(
    card.advancedHint,
    period.kind === 'invalid'
      ? 'Pick the months this season covers; dates need one continuous range.'
      : 'Editing a month chip keeps this season on month precision.',
  );
  paintMonthEditor(card);
}

function paintPeriodMode(card, state) {
  const windows = card.period.windows ? card.period.windows.length : 0;
  card.addButton.disabled = state.settingsSaving || state.draftRates.length >= MAX_RATE_WINDOWS;
  card.addButton.hidden = false;
  if (card.windowsEmpty) {
    card.windowsEmpty.hidden = !card.period.base || windows > 0;
  }
}

// The period's name as a control needs it. A date season is always titled
// "Season", so the scope is appended: otherwise both seasons of a Summer/Winter
// split offer "Edit season dates for Season" to a screen-reader owner. The
// visible title is unchanged.
function periodName(period) {
  const base = period.title === 'Custom months' ? period.monthText : period.title;
  const scope = period.monthText || '';
  return period.kind === 'dates' && scope ? `${base} ${scope}` : base;
}

// The header tells the truth for the representative month: the price range
// includes the effective bases/windows and sibling rows that apply there, while
// the count stays the period's own rows. Unpriced hours show as 0.00.
function paintPeriodHeader(card, state) {
  const period = card.period;
  setText(card.title, period.title);
  card.list.setAttribute('aria-label', `Windows in ${periodName(period)}`);
  card.addButton.setAttribute('aria-label', `Add a window to ${periodName(period)}`);
  card.editDates.setAttribute('aria-label', `Edit season dates for ${periodName(period)}`);
  const { dateMode, dateText, text: bandText } = periodBandCopy(period);
  setText(card.band, bandText);
  card.band.hidden = !bandText;
  card.band.classList.toggle('date-range', dateMode && Boolean(dateText));

  const range = periodEffectiveRange(state.draftRates, state.readFields().rate, period);
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
      Number.isFinite(price) &&
      Object.keys(state.rateValidation.rows[entry.index] || {}).length === 0
    );
  });
  // Every part carries a `·` suffix bound to its own words with a no-break
  // space, so a wrapped line never starts with punctuation and the price is
  // never a bare run beside the count (the flex gap supplies the spacing).
  const meta = [el('span', null, `${countText}\u00a0·`)];
  if (example) meta.push(el('span', null, `${example}\u00a0·`));
  if (period.kind === 'invalid')
    meta.push(el('span', null, dateMode ? 'needs dates' : 'needs months'));
  else if (!ownPriced || !range) meta.push(nowrapEl('— needs attention'));
  else meta.push(nowrapEl(priceRangeText(range)));
  card.meta.replaceChildren(...meta);
  paintScopeEditor(card, state);
  paintBaseBlock(card, state);
  paintPeriodMode(card, state);
}

export function paintPeriodActions(card, state) {
  const confirming = state.removeConfirmKey === card.key;
  const count = card.period.rows.length;
  const complement = complementScope(card.period);
  // A duplicate with nowhere to go (all year, invalid scope, a complement that
  // another season already covers, or a copy that would exceed the 24-window
  // cap) is not offered at all: a permanently disabled button reads as a broken
  // action.
  const occupied =
    complement != null &&
    state.planPeriods.some((other) => other.key !== card.key && scopesOverlap(complement, other));
  const canDuplicate =
    complement != null &&
    !occupied &&
    canDuplicatePeriod(state.draftRates.length, count) &&
    !state.settingsSaving;
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

// A period's visible name in another season's band column. It is the same name
// the card's own controls use, so a sibling row and the season it names can never
// disagree: a date season reads as "Season Jun 15–Sep 15", never two date runs.
function periodBandLabel(period) {
  return periodName(period);
}

// The 7-day strip is a quiet shape cue in the collapsed header; the tables and
// the hidden description carry the same information in words. Both describe the
// period's own layer for a representative month in its own scope; sibling
// periods that also price that month are named above the tables.
function paintCoverage(card, state) {
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
  // hours fall back to Uncovered and the table would quote a resolved price
  // the plan, the card meta and the checker all deny. Resolve a copy with a
  // stand-in price so the row keeps its place and its band, then put the real
  // (unusable) price back and let the table say the price is missing.
  const unpriced = new Set(
    period.rows.filter((entry) => !rateIsUsable(entry.row.rate)).map((entry) => entry.row.id),
  );
  const coverage = periodCoverage(
    state.draftRates.map((row) => (row && unpriced.has(row.id) ? { ...row, rate: '0' } : row)),
    state.readFields().rate,
    period,
    state.planPeriods,
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
    return state.planPeriods.find((entry) =>
      entry.rows.some((row) => row.row.id === segment.window.id),
    );
  };
  // A segment's band: Base for a base row, a relative tier for an override (only
  // when its season has a base), and Uncovered for an hour no row prices.
  const labelFor = (segment) => {
    const owner = ownerOf(segment);
    const base = owner ? periodBaseRate(owner) : null;
    const rates = owner ? owner.rows.map((entry) => entry.row.rate) : windowRates(state);
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
      const key = segmentClass(segment, state);
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
      // Own rows show a band; an inherited row names its season after the band,
      // but the column is a band column: "Season · band" made every row read as
      // jargon for the one thing it does not contain.
      ['Band', null],
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
function createBaseBlock(card, period, index, state) {
  const block = el('section', 'base-block');
  const head = el('div', 'base-head');
  const title = el('h5', 'base-title', 'Base rate');
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
    // Same contract as a window rate: any decimal precision the owner types is
    // accepted here and judged by the single 0–5 rule, never by an arbitrary
    // step (see the window rate field above).
    baseInput.step = 'any';
    baseInput.inputMode = 'decimal';
    // No placeholder: a `0.000` in an empty field reads as a planted price
    // beside the "Enter a rate between 0 and 5." rule, the same reason the
    // window field has none. The label, the `/ kWh` suffix and the error carry
    // the rule; the field stays visibly empty until the owner types a price.
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
      state.markEdited();
      state.refresh();
    });
    removeBaseButton = el('button', 'btn small danger', 'Remove base rate');
    removeBaseButton.type = 'button';
    removeBaseButton.dataset.action = 'remove-base-rate';
    removeBaseButton.addEventListener('click', () => state.removeBaseRate(card));
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
    state.windowCards[baseEntry.index] = baseCard;
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
    addBaseButton.addEventListener('click', () => state.addBaseRate(card));
    block.append(head, warning, addBaseButton);
    card.addBaseButton = addBaseButton;
  }
  card.baseBlock = block;
  return block;
}

// The add action follows the stored One-rate value, but never silently prices a
// season: the owner sees the number and can change it in the base field.
function paintBaseBlock(card, state) {
  const flat = $('setting-rate').value;
  const usable = rateIsUsable(flat);
  if (card.addBaseButton) {
    const covered = periodHasBaseOverlap(card.period, state.draftRates);
    card.addBaseButton.hidden = covered;
    if (card.baseWarning) {
      // The base-less warning is about a plan that leaves hours at 0.00. A plan
      // whose windows between them price the whole year has nothing to warn
      // about, so the sentence states that instead of promising a gap that the
      // strip, the table and History all deny.
      setText(
        card.baseWarning,
        covered
          ? 'No base rate in this season — another season’s base prices these hours.'
          : state.planUnpriced
            ? 'No base rate — hours outside the windows have no price unless another season’s base covers them.'
            : 'No base rate — every hour of these dates has a price.',
      );
    }
    // Short visible label: `Add base rate (CAD 0.31 from One rate)` wrapped
    // mid-phrase at 390 px. The accessible name keeps the provenance.
    setText(card.addBaseButton, usable ? `Add base rate · ${priceText(flat)}` : 'Add base rate');
    card.addBaseButton.setAttribute(
      'aria-label',
      usable ? `Add a base rate using ${priceText(flat)} from One rate` : 'Add a base rate',
    );
    card.addBaseButton.disabled =
      state.settingsSaving || state.draftRates.length >= MAX_RATE_WINDOWS;
  }
  if (card.removeBaseButton) {
    card.removeBaseButton.hidden = !card.period.base || card.period.windows.length === 0;
  }
  if (card.windowsEmpty) {
    card.windowsEmpty.hidden = !card.period.base || card.period.windows.length > 0;
  }
}

export function createPeriodCard(period, index, state) {
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

  const heading = el('h4', 'period-heading');
  const toggle = el('button', 'period-toggle');
  toggle.type = 'button';
  const bodyId = `period-body-${index}`;
  const descId = `period-coverage-${index}`;
  toggle.setAttribute('aria-controls', bodyId);
  toggle.setAttribute('aria-describedby', descId);
  const expanded = state.expandedPeriods.has(period.key);
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
  const datesTitle = el('h5', 'season-dates-title', 'Season dates');
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
    'Repeats every year. The year only picks a month and day — any year works, and 29 February renders in a leap year.',
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
  fromDate.dataset.field = 'from-date';
  fromDate.setAttribute('aria-label', 'Season start date');
  fromDate.setAttribute('aria-describedby', `${referenceId} ${statusId} ${storedId} ${errorId}`);
  const toDate = el('input', 'season-date-input');
  toDate.type = 'date';
  toDate.id = toDateId;
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
      if (state.settingsSaving) return;
      // The chip is a toggle: on an all-year scope every chip is pressed, so a
      // click removes that month instead of discarding the other eleven.
      const months = toggledMonthScope(period, month);
      if (!months) return;
      state.applyMonths(card, months, { focusMonth: month });
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
  advanced.open = monthEditorIsLegacy(period);

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
    if (state.settingsSaving) return;
    if (allYear.checked) {
      state.applyMonths(card, null, { focusCheckbox: true });
      return;
    }
    const seed = periodDateSeed({ kind: 'all' }, new Date());
    state.applyDates(card, seed.from, seed.to);
    card.fromDate.focus({ preventScroll: true });
  });

  const commitDates = () => {
    if (state.settingsSaving) return;
    const from = boundFromDateInput(fromDate.value);
    const to = boundFromDateInput(toDate.value);
    const current = periodDateBounds(card.period);
    if (from === (current.from ?? null) && to === (current.to ?? null)) return;
    state.applyDates(card, from, to);
  };
  fromDate.addEventListener('change', commitDates);
  toDate.addEventListener('change', commitDates);

  editDates.addEventListener('click', () => {
    if (state.settingsSaving) return;
    state.setExpanded(card, true);
    const seasonState = seasonDateState(card.period);
    if (seasonState.allYear) {
      card.allYear.focus({ preventScroll: true });
    } else if (seasonState.canPick) {
      (card.dateFocus || card.fromDate).focus({ preventScroll: true });
    } else {
      card.advancedMonths.open = true;
      const chip =
        card.monthChips.querySelector('[aria-pressed="true"]') ||
        card.monthChips.querySelector('button') ||
        card.advancedMonths.querySelector('summary');
      chip.focus({ preventScroll: true });
    }
    state.scrollToNode(card.seasonDates);
  });

  const baseBlock = createBaseBlock(card, period, index, state);

  const coverage = el('div', 'coverage');
  const list = el('div', 'rate-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', `Daily windows in ${periodName(period)}`);
  const addButton = el('button', 'btn add-rule');
  addButton.type = 'button';
  addButton.dataset.action = 'add-window';
  addButton.append(el('span', 'add-plus', '+'), el('span', null, 'Add window'));
  addButton.setAttribute('aria-label', `Add a daily window to ${periodName(period)}`);
  addButton.addEventListener('click', () => state.addWindow(card));

  const windowsSection = el('section', 'windows-section');
  const windowsTitle = el('h5', 'windows-title', 'Daily windows (optional)');
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
  duplicateButton.addEventListener('click', () => state.duplicatePeriod(card));
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
  removeButton.addEventListener('click', () => state.requestRemovePeriod(card));
  confirmButton.addEventListener('click', () => state.removePeriod(card));
  cancelRemove.addEventListener('click', () => {
    state.removeConfirmKey = null;
    paintPeriodActions(card, state);
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
    const windowCard = createWindowCard(entry, card, state);
    state.windowCards[entry.index] = windowCard;
    card.cards.push(windowCard);
    list.append(windowCard.node);
  });
  card.list = list;
  card.addButton = addButton;
  card.coverage = coverage;

  toggle.addEventListener('click', () => {
    const next = card.body.hidden;
    state.setExpanded(card, next);
  });

  paintPeriodHeader(card, state);
  paintPeriodActions(card, state);
  paintCoverage(card, state);
  return card;
}

// ---------- the plan pipeline ----------

export function paintPlan(state) {
  const mode = state.currentRateMode();
  state.paintRateMode();
  if (mode === 'flat') {
    state.planPeriods = [];
    state.seedNoticeKey = '';
    state.planUnpriced = false;
    $('rates-plan').hidden = true;
    $('uncovered-line').hidden = true;
    $('plan-seed').hidden = true;
    return;
  }

  state.planPeriods = state.ratePeriodsForDraft();
  // One walk of the draft per paint: the plan summary's 0.00 minimum and each
  // base block's warning both ask whether any instant is unpriced.
  state.planUnpriced = planHasUnpriced(state.draftRates);
  // Only rows that can match and pass validation set a meaningful range; an
  // invalid row is shown and fixed but its price never applies. A base-less
  // season and a date gap both put 0 in the range, so the plan cannot advertise
  // a minimum it does not actually charge.
  const rateRows = state.planPeriods
    .filter((period) => period.kind !== 'invalid')
    .flatMap((period) => period.rows)
    .filter((entry) => Object.keys(state.rateValidation.rows[entry.index] || {}).length === 0)
    .map((entry) => entry.row);
  const range = ratePlanRange(rateRows);
  const problems = validationProblemCount(state.rateValidation, state.draftRates.length);
  const capped = state.draftRates.length > MAX_RATE_WINDOWS;
  const gaps = mergeDateRanges(uncoveredDateRanges(state.draftRates));
  const counts = `${state.planPeriods.length} ${state.planPeriods.length === 1 ? 'season' : 'seasons'} · ${
    state.draftRates.length
  } ${state.draftRates.length === 1 ? 'rate' : 'rates'}`;
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

  // The seed note explains the workable season the mode switch created, and
  // retires itself as soon as that seed stops being the whole plan (dates
  // edited, a window or another season added, or the plan emptied).
  const seeded = state.seedNoticeKey
    ? state.planPeriods.find((period) => period.key === state.seedNoticeKey && period.base)
    : null;
  if (!seeded || state.planPeriods.length !== 1 || seeded.rows.length !== 1)
    state.seedNoticeKey = '';
  const seedNote = $('plan-seed');
  seedNote.hidden = !state.seedNoticeKey;
  setText(
    $('plan-seed-note'),
    state.seedNoticeKey && seeded
      ? `Seeded ${seeded.monthText} at your flat rate. Dates outside it cost 0.00 until you cover them.`
      : '',
  );

  const uncoveredLine = $('uncovered-line');
  const gapText = dateSetText(gaps);
  uncoveredLine.hidden = gaps.length === 0;
  if (gaps.length > 0) {
    const dateNode = $('uncovered-dates');
    dateNode.replaceChildren();
    // The copy above already separates the range from the sentence; a leading
    // `·` here started a wrapped line with punctuation.
    gapText.split(', ').forEach((run, index) => {
      if (index > 0) dateNode.append(', ');
      dateNode.append(nowrapEl(run));
    });
    const fill = $('fill-gaps');
    setText(fill, `Fill ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'}`);
    fill.setAttribute(
      'aria-label',
      `Fill ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'}: ${gapText}`,
    );
  }

  for (const card of state.periodCards) {
    const period = state.planPeriods.find((entry) => entry.key === card.key);
    if (!period) continue;
    card.period = period;
    paintPeriodHeader(card, state);
    paintPeriodActions(card, state);
    paintCoverage(card, state);
    for (const windowCard of card.cards) {
      windowCard.periodCard = card;
      paintWindowCard(windowCard, state);
    }
  }
}

export function paintRateValidation(state) {
  // A row that collides with another is named by the other row's price band and
  // times, so the inline note explains the conflict without referring to a
  // storage index.
  const rates = windowRates(state);
  const fallback = state.readFields().rate;
  const addNote = (map, index, text) => {
    if (!map.has(index)) map.set(index, []);
    map.get(index).push(text);
  };
  const notes = new Map();
  for (const [a, b] of state.rateValidation.overlaps) {
    const sameScope = rateScopeText(state.draftRates[a]) === rateScopeText(state.draftRates[b]);
    const left = windowLabel(state.draftRates[a], rates, fallback, { months: !sameScope });
    const right = windowLabel(state.draftRates[b], rates, fallback, { months: !sameScope });
    addNote(notes, a, left === right ? 'Overlaps an identical window' : `Overlaps “${right}”`);
    addNote(notes, b, left === right ? 'Overlaps an identical window' : `Overlaps “${left}”`);
  }

  for (const card of state.windowCards) {
    if (!card) continue;
    const errors = state.rateValidation.rows[card.index] || {};
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

  for (const card of state.periodCards) {
    const bad = card.period.rows.filter((entry) => {
      const errors = state.rateValidation.rows[entry.index] || {};
      return Object.keys(errors).length > 0 || notes.has(entry.index);
    }).length;
    card.flag.hidden = bad === 0;
    setText(card.flag, bad === 1 ? '1 to fix' : `${bad} to fix`);
    card.node.classList.toggle('invalid', bad > 0);
  }

  const general = state.rateValidation.general.join(' ');
  const docError = $('rates-error');
  docError.hidden = !general;
  setText(docError, general);

  // The save row carries the same count as the plan summary; Save itself stays
  // governed by the dirty/saving state machine.
  const problems = validationProblemCount(state.rateValidation, state.draftRates.length);
  const capped = state.draftRates.length > MAX_RATE_WINDOWS;
  const blockers = $('save-blockers');
  blockers.hidden = problems === 0;
  setText(blockers, planProblemText({ problems, capped }));

  // Saving locks the plan; the cap disables the add paths.
  for (const node of $('rates-plan').querySelectorAll('input, button, select')) {
    node.disabled = state.settingsSaving;
  }
  const atCap = state.draftRates.length >= MAX_RATE_WINDOWS;
  const hasBase = state.planPeriods.some((period) => Boolean(period.base));
  const noUncoveredDates = uncoveredDateRanges(state.draftRates).length === 0;
  // A new base needs an uncovered range. With every date covered and a base
  // already present, another base would only collide, so the action is refused —
  // with a visible, focusable explanation beside it, not just a tooltip on a
  // disabled button.
  const addSeasonBlocked = noUncoveredDates && hasBase;
  $('add-season').disabled = state.settingsSaving || atCap || addSeasonBlocked;
  $('add-season').title = addSeasonBlocked ? 'A base season already covers every date.' : '';
  const seasonNote = $('add-season-note');
  seasonNote.hidden = !addSeasonBlocked;
  setText(
    seasonNote,
    addSeasonBlocked
      ? 'Every date is covered by a season, so there is no room for another. Edit a season’s dates to make one.'
      : '',
  );
  const fillCount = uncoveredGapScopes(state.draftRates).length;
  $('fill-gaps').disabled =
    state.settingsSaving || state.draftRates.length + fillCount > MAX_RATE_WINDOWS;
  $('fill-gaps').title =
    state.draftRates.length + fillCount > MAX_RATE_WINDOWS ? RATE_CAP_REMEDY : '';
  for (const card of state.periodCards) {
    // The blanket lock above enables everything when not saving; restore the
    // feature-level disabled states (date/month modes, row cap) after it.
    paintScopeEditor(card, state);
    paintBaseBlock(card, state);
    paintPeriodMode(card, state);
    card.addButton.disabled = state.settingsSaving || atCap;
    paintPeriodActions(card, state);
  }
}
