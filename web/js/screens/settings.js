// App-settings card: the all-other-times rate first, then an optional plan of
// month periods with daily windows, and a checker that reads the draft.
//
// The stored document keeps one flat `rates` list; periods are a presentation
// over the shared `months` value, so grouping never changes the payload or the
// matching order. A period owns its months; the rows inside it inherit them and
// have no month control of their own. All edits flow through the same
// draft/dirty/saved/waiting/error machine, and a failed write still reconciles
// back to the last confirmed server state.

import { fmtRate } from '../format.js';
import { DAY_NAMES } from '../schedule.js';
import { $, setText } from '../ui.js';
import {
  DAY_PRESETS,
  MONTH_NAMES,
  OFFLINE_MESSAGE,
  applyPeriodMonths,
  canDuplicatePeriod,
  complementMonths,
  copyPeriodRows,
  dateInputValue,
  dayPresetFor,
  defaultRateRow,
  formatPreviewWhen,
  isAllDayWindow,
  largestMonthRun,
  minutesToClock,
  normalizeSettings,
  parseLocalDateTime,
  periodCoverage,
  periodEffectiveRange,
  previewBlocker,
  previewRate,
  rateMonthsText,
  ratePeriods,
  ratePlanRange,
  rateRowFields,
  rateSegmentLabel,
  rateTierFor,
  rateWindowSummary,
  reconcileSettingsSave,
  segmentNote,
  settingsDraftMatches,
  settingsFields,
  settingsSaveState,
  siblingNote,
  timeFieldsVisible,
  timeInputValue,
  toggledMonthScope,
  uncoveredMonths,
  validateRateEditorRows,
  validateSettings,
  validationProblemCount,
  windowLabel,
} from '../settings.js';
import { MAX_RATE_WINDOWS, parseRateValue } from '../rates.js';
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
  if (tier === 'Off-peak') return 'off';
  if (tier === 'Peak') return 'peak';
  if (tier === 'Shoulder') return 'shoulder';
  return 'same';
}

function segmentClass(segment) {
  if (!segment || !segment.window) return 'base';
  return tierClass(rateTierFor(segment.rate, windowRates(), readFields().rate));
}

function windowName(row) {
  const tier = rateTierFor(row && row.rate, windowRates(), readFields().rate);
  return `${tier ? `${tier} ` : ''}${rateWindowSummary(row)}`;
}

// A new window is the everyday overnight preset for a first window, and the
// weekday evening peak once the period already has a window — the two shapes
// most tariffs start from. The price stays empty so it cannot be saved by
// accident.
function newWindowRow(months, preset) {
  const row = defaultRateRow(crypto.randomUUID(), months);
  if (preset === 'peak') {
    row.days = [0, 1, 2, 3, 4];
    row.start = '16:00';
    row.end = '19:00';
  }
  return row;
}

function priceText(rate) {
  return fmtRate(rate, currency());
}

// "USD 0.20–0.32", not "USD 0.20–USD 0.32": one currency for a range.
function priceRangeText(range) {
  if (!range) return '';
  if (range.min === range.max) return priceText(range.min);
  return `${priceText(range.min)}–${fmtRate(range.max, '')}`;
}

// Keep "other times USD 0.31" and "USD 0.10–0.32" together when a summary
// wraps; breaking inside a price reads as two different numbers.
function nowrap(text) {
  return String(text).replaceAll(' ', '\u00a0');
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
  const fallback = readFields().rate;
  const tier = rateTierFor(row.rate, windowRates(), fallback);
  setText(card.title, tier || (String(row.rate ?? '').trim() === '' ? 'New window' : 'Window'));
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
    daysEl: null,
    presetsEl: null,
    presetEls: [],
    customDays: dayPresetFor(row.days) === 'custom',
    startInput: null,
    endInput: null,
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
  rateInput.placeholder = '0.000';
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

function periodName(period) {
  return period.title === 'Custom months' ? period.monthText : period.title;
}

// The header tells the truth for the representative month: the price range
// includes the fallback and any sibling windows that apply there, while the
// count stays the period's own windows.
function paintPeriodHeader(card) {
  const period = card.period;
  const showMonths = period.monthText !== period.title;
  setText(card.band, showMonths ? period.monthText : '');
  card.band.hidden = !showMonths;

  const range = periodEffectiveRange(draftRates, readFields().rate, period);
  const count = period.rows.length;
  const countText = `${count} ${count === 1 ? 'window' : 'windows'}`;
  // The range covers one representative month (January for an all-year scope,
  // otherwise the first month of the scope). Naming it keeps an All-year header
  // from advertising a range that a July sibling changes; the table caption
  // repeats the same month.
  const example = range ? `${MONTH_NAMES[range.month - 1].slice(0, 3)} example ` : '';
  const price =
    period.kind === 'invalid'
      ? 'needs months'
      : range
        ? `${example}${nowrap(priceRangeText(range))} effective`
        : 'rate not set';
  setText(card.meta, `${countText} · ${price}`);
  paintMonthEditor(card);
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
  const complement = complementMonths(card.period.months);
  // A duplicate with nowhere to go (all year, invalid scope, or a copy that
  // would exceed the 24-window cap) is not offered at all: a permanently
  // disabled button reads as a broken action.
  const canDuplicate =
    card.period.kind !== 'invalid' &&
    complement.length > 0 &&
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
  card.duplicateButton.title = 'Copy this season into the months it does not cover.';
}

// The 7-day strip is a quiet shape cue in the collapsed header; the tables and
// the hidden description carry the same information in words. Both describe the
// period's own layer for a representative month in its own scope; sibling
// periods that also price that month are named above the tables.
function paintCoverage(card) {
  const period = card.period;
  if (period.kind === 'invalid') {
    card.strip.replaceChildren();
    card.axis.hidden = true;
    card.legend.replaceChildren();
    card.coverage.replaceChildren(
      el('p', 'coverage-empty', 'Choose months to include these windows.'),
    );
    setText(card.desc, 'This period has no usable months. Choose months to include its windows.');
    return;
  }
  const coverage = periodCoverage(
    draftRates,
    readFields().rate,
    period,
    planPeriods,
    new Date().getFullYear(),
  );

  const present = new Set();
  const strip = [];
  for (const type of coverage.types) {
    const row = el('span', 'strip-row');
    // The strip column is narrow; a long custom day list is summarised here
    // and spelled out in the table caption below.
    const label = type.label.length <= 11 ? type.label : `${type.days.length} days`;
    row.append(el('span', 'strip-day', label));
    const track = el('span', 'strip-track');
    for (const segment of type.segments) {
      const piece = el('span', `strip-seg ${segmentClass(segment)}`);
      piece.style.flexGrow = String(segment.to - segment.from);
      present.add(segmentClass(segment));
      track.append(piece);
    }
    row.append(track);
    strip.push(row);
  }
  card.axis.hidden = false;
  card.strip.replaceChildren(...strip);

  const labels = [
    ['off', 'Off-peak'],
    ['shoulder', 'Shoulder'],
    ['peak', 'Peak'],
    ['same', 'Same price'],
    ['base', 'Other times'],
  ];
  const legend = labels
    .filter(([key]) => present.has(key))
    .map(([key, label]) => {
      const item = el('span', 'legend-item');
      item.append(el('span', `legend-dot ${key}`), el('span', null, label));
      return item;
    });
  card.legend.replaceChildren(...legend);

  const siblingLines = coverage.siblings.map((sibling) => siblingNote(sibling)).filter(Boolean);
  const ownerOf = (segment) => {
    if (!segment.window) return null;
    if (coverage.ownIds.has(segment.window.id)) return period;
    return planPeriods.find((entry) => entry.rows.some((row) => row.row.id === segment.window.id));
  };
  const described = coverage.types
    .map(
      (type) =>
        `${type.label}: ${type.segments
          .map((segment) => {
            const owner = ownerOf(segment);
            const label = !segment.window
              ? 'Other times'
              : owner === period
                ? rateSegmentLabel(segment, windowRates(), readFields().rate)
                : `${periodName(owner)} ${rateSegmentLabel(
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
    `Effective week for ${coverage.monthName}. ${described}. ${siblingLines.join(' ')}`.replace(
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
    const caption = el('caption', null, `${type.label} · ${coverage.monthName}`);
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
        const tier = rateTierFor(segment.rate, windowRates(), readFields().rate);
        band.append(el('span', `tier ${tierClass(tier)}`, tier || 'Window'));
      } else if (segment.window) {
        // An inherited row keeps the band dot (so the legend still matches the
        // row) and names the season it came from; the column heading covers
        // "Season · band".
        const tier = rateTierFor(segment.rate, windowRates(), readFields().rate);
        const label = el('span', 'sibling-band');
        label.append(
          el('span', 'sibling-owner', owner ? periodName(owner) : 'Other season'),
          el('span', 'sibling-sep', ' · '),
          el('span', `tier ${tierClass(tier)}`, tier || 'Window'),
        );
        band.append(label);
      } else {
        band.textContent = 'Other times';
      }
      const price = el('td', 'price', priceText(segment.rate));
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

  const monthEditor = el('div', 'month-editor');
  const monthHead = el('div', 'month-editor-head');
  monthHead.append(el('span', 'field-label', 'Months'));
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
  monthEditor.append(monthHead, monthChips);
  card.monthEditor = monthEditor;
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

  body.append(monthEditor, coverage, list, addButton, periodActions);
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
    const chip = next.monthChips.querySelector(`[data-month="${focusMonth}"]`);
    if (chip) chip.focus({ preventScroll: true });
    else next.toggle.focus({ preventScroll: true });
  } else {
    next.toggle.focus({ preventScroll: true });
  }
  scrollToNode(next.node);
}

function addWindow(card) {
  if (settingsSaving || draftRates.length >= MAX_RATE_WINDOWS) return;
  if (card.period.kind === 'invalid') {
    card.allYear.focus({ preventScroll: true });
    return;
  }
  const row = newWindowRow(
    card.period.months,
    card.period.rows.length === 0 ? 'overnight' : 'peak',
  );
  draftRates = [...draftRates, row];
  const index = draftRates.length - 1;
  expandedPeriods.add(card.key);
  markEdited();
  renderPlan();
  const added = windowCards[index];
  if (added) {
    added.rateInput.focus({ preventScroll: true });
    scrollToNode(added.node);
  }
}

function addCheapHours() {
  if (settingsSaving || draftRates.length > 0) return;
  draftRates = [newWindowRow(null, 'overnight')];
  expandedPeriods = new Set(['all']);
  markEdited();
  renderPlan();
  const added = windowCards[0];
  if (added) {
    added.rateInput.focus({ preventScroll: true });
    scrollToNode(added.node);
  }
}

function addSeason() {
  if (settingsSaving || draftRates.length >= MAX_RATE_WINDOWS) return;
  const uncovered = uncoveredMonths(draftRates);
  const months =
    uncovered.length === 12
      ? null
      : uncovered.length > 0
        ? largestMonthRun(uncovered)
        : [new Date().getMonth() + 1];
  const row = newWindowRow(months, draftRates.length === 0 ? 'overnight' : 'peak');
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
  const months = complementMonths(card.period.months);
  if (months.length === 0 || card.period.rows.length === 0) return;
  const indices = card.period.rows.map((entry) => entry.index);
  // The copy appends one row per window; refuse before it can build a plan the
  // editor itself would reject. The button is not offered in this state, so the
  // guard is the backstop, not the only explanation: an over-cap plan still
  // reports the cap through validation and the checker.
  if (!canDuplicatePeriod(draftRates.length, indices.length)) return;
  const start = draftRates.length;
  draftRates = copyPeriodRows(draftRates, indices, months, () => crypto.randomUUID());
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
  if (draftRates.length > 0) $('add-season').focus({ preventScroll: true });
  else $('add-cheap-hours').focus({ preventScroll: true });
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
  // Only rows that can actually match a month set a meaningful range: a row
  // with unusable months is shown and fixed, but its price never applies.
  const rateRows = planPeriods
    .filter((period) => period.kind !== 'invalid')
    .flatMap((period) => period.rows.map((entry) => entry.row));
  const range = ratePlanRange(rateRows);
  const problems = validationProblemCount(rateValidation, draftRates.length);
  const parts = [
    `${planPeriods.length} ${planPeriods.length === 1 ? 'season' : 'seasons'}`,
    `${draftRates.length} ${draftRates.length === 1 ? 'window' : 'windows'}`,
  ];
  if (range) parts.push(nowrap(`windows ${priceRangeText(range)}`));
  parts.push(nowrap(`other times ${priceText(readFields().rate)}`));
  setText($('plan-summary-text'), parts.join(' · '));
  const problem = $('plan-problem');
  problem.hidden = problems === 0;
  setText(problem, `${problems} to fix`);

  // The fallback is a line, not a season: name the months nothing covers. With
  // no usable all-other-times rate there is no price to show, so the line omits
  // it rather than advertising USD 0.00; the summary and the table show "—".
  const uncovered = uncoveredMonths(draftRates);
  const otherTimes = $('other-times-line');
  otherTimes.hidden = uncovered.length === 0;
  if (uncovered.length > 0) {
    const nodes = [
      el('span', 'other-times-title', 'No window — other times'),
      el('span', 'other-times-months', ` · ${rateMonthsText(uncovered)}`),
    ];
    const fallback = readFields().rate;
    if (Number.isFinite(parseRateValue(fallback))) {
      nodes.push(el('span', 'other-times-price', ` · ${priceText(fallback)}`));
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
  const notes = new Map();
  for (const [a, b] of rateValidation.overlaps) {
    const sameMonths =
      rateMonthsText(draftRates[a] && draftRates[a].months) ===
      rateMonthsText(draftRates[b] && draftRates[b].months);
    const left = windowLabel(draftRates[a], rates, fallback, { months: !sameMonths });
    const right = windowLabel(draftRates[b], rates, fallback, { months: !sameMonths });
    if (!notes.has(a)) notes.set(a, []);
    if (!notes.has(b)) notes.set(b, []);
    notes.get(a).push(left === right ? 'Overlaps an identical window' : `Overlaps “${right}”`);
    notes.get(b).push(left === right ? 'Overlaps an identical window' : `Overlaps “${left}”`);
  }

  for (const card of windowCards) {
    if (!card) continue;
    const errors = rateValidation.rows[card.index] || {};
    const rowNotes = notes.get(card.index) || [];
    const messages = [...new Set([...Object.values(errors), ...rowNotes])];
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
  }

  const general = rateValidation.general.join(' ');
  const docError = $('rates-error');
  docError.hidden = !general;
  setText(docError, general);

  // The save row carries the same count as the plan summary; Save itself stays
  // governed by the existing dirty/saving state machine.
  const problems = validationProblemCount(rateValidation, draftRates.length);
  const blockers = $('save-blockers');
  blockers.hidden = problems === 0;
  setText(blockers, `${problems} to fix`);

  // Saving locks the plan; the cap disables the two add paths.
  for (const node of $('rates-plan').querySelectorAll('input, button, select')) {
    node.disabled = settingsSaving;
  }
  for (const node of $('rates-flat').querySelectorAll('button')) node.disabled = settingsSaving;
  const capped = draftRates.length >= MAX_RATE_WINDOWS;
  $('add-season').disabled = settingsSaving || capped;
  for (const card of periodCards) {
    card.addButton.disabled = settingsSaving || capped;
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
    if (result.tier) price.append(el('span', `tier ${tierClass(result.tier)}`, result.tier));
    const money = el('span', 'preview-money');
    money.append(el('strong', null, priceText(result.rate)), el('span', 'unit', '/ kWh'));
    price.append(money);
  }
  rows.push(paintPreviewRow('Price', price));
  rows.push(
    paintPreviewRow(
      'Applies',
      result.fallback
        ? 'Other times — no cheap window covers this moment.'
        : `${result.summary} · ${result.monthsText}`,
    ),
  );
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
  const where = result.fallback ? 'other times' : result.summary;
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
  setText(feedback, view.text);

  // Save is not the brightest, most clickable thing on a plan that cannot be
  // saved: the same count as the save-row chip relabels the button, and the
  // existing submit validation/state machine is untouched (Enter in a field
  // still explains what to fix).
  const problems = validationProblemCount(rateValidation, draftRates.length);
  const save = $('save-settings');
  save.disabled = !view.canSave || problems > 0;
  if (settingsSaving) setText(save, 'Saving…');
  else if (problems > 0) setText(save, `Fix ${problems} to save`);
  else setText(save, 'Save settings');
  if (problems > 0) save.setAttribute('aria-describedby', 'save-blockers');
  else save.removeAttribute('aria-describedby');
  $('settings-form').setAttribute('aria-busy', String(settingsSaving));
  $('setting-rate').disabled = settingsSaving;
  $('setting-currency').disabled = settingsSaving;
}

// ---------- rendering ----------

function renderPlan() {
  planPeriods = ratePeriodsForDraft();
  const flat = draftRates.length === 0;
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
  // A valid save is the shared document validation plus the table's own rule.
  // Both paint their errors, so nothing blocks the save without saying why.
  const result = validateSettings(readFields());
  rateValidation = validateRateEditorRows(draftRates, $('setting-rate').value);
  paintRateValidation();
  renderErrors(result.errors);
  if (!result.valid || !rateValidation.valid) {
    settingsSaved = false;
    settingsError = 'Fix the highlighted fields before saving.';
    paintFeedback();
    if (result.errors.rate) $('setting-rate').focus();
    else if (result.errors.currency) $('setting-currency').focus();
    else focusFirstRateError();
    return;
  }

  const previous = confirmedSettings;
  const values = result.values;
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

function firstRateError() {
  return windowCards.find(
    (card) => card && Object.keys(rateValidation.rows[card.index] || {}).length > 0,
  );
}

function revealCard(card) {
  card.node.scrollIntoView({
    block: 'center',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function focusFirstRateError() {
  const card = firstRateError();
  if (!card) {
    // A document-level problem (an overlap, or more rows than the cap) has no
    // field of its own. Expand the first accused row, focus it, and let the
    // row's own note plus its aria-describedby carry the explanation.
    const accused =
      rateValidation.overlaps.length > 0 ? windowCards[rateValidation.overlaps[0][0]] : null;
    const fallback = accused || windowCards.find(Boolean);
    if (fallback) {
      setExpanded(fallback.periodCard, true);
      revealCard(fallback);
      fallback.rateInput.focus({ preventScroll: true });
      return;
    }
    const docError = $('rates-error');
    if (!docError.hidden) docError.scrollIntoView({ block: 'center', behavior: 'auto' });
    return;
  }
  const periodCard = card.periodCard;
  if (periodCard) setExpanded(periodCard, true);
  const errors = rateValidation.rows[card.index] || {};
  if (errors.months && periodCard) {
    periodCard.allYear.focus({ preventScroll: true });
    revealCard(periodCard);
    return;
  }
  if (errors.rate) card.rateInput.focus({ preventScroll: true });
  else if (errors.days) {
    const pressed = card.daysEl.querySelector('[aria-pressed="true"]');
    const target = pressed || card.presetEls[0] || card.daysEl.querySelector('button');
    if (target) target.focus({ preventScroll: true });
  } else if (errors.start) card.startInput.focus({ preventScroll: true });
  else if (errors.end) card.endInput.focus({ preventScroll: true });
  else card.rateInput.focus({ preventScroll: true });
  revealCard(card);
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
  $('add-cheap-hours').addEventListener('click', addCheapHours);
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
