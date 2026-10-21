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
  complementMonths,
  copyPeriodRows,
  dateInputValue,
  dayPresetFor,
  defaultRateRow,
  formatPreviewWhen,
  largestMonthRun,
  minutesToClock,
  normalizeSettings,
  parseLocalDateTime,
  periodCoverage,
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
  timeInputValue,
  validateRateEditorRows,
  validateSettings,
  windowLabel,
} from '../settings.js';
import { MAX_RATE_WINDOWS } from '../rates.js';
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
// Month choices are held here until Apply (or Save), so a period cannot split
// or merge while the owner is still picking months.
let pendingMonths = new Map();
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
  card.startInput = startInput;
  card.endInput = endInput;

  const errorEl = el('p', 'rule-error rate-error');
  errorEl.id = errorId;
  errorEl.hidden = true;
  card.errorEl = errorEl;

  node.append(head, rateField, dayControl, times, errorEl);
  paintWindowCard(card);
  return card;
}

// ---------- period cards ----------

function appliedMonths(card) {
  const period = card.period;
  if (period.kind === 'all') return { all: true, months: null };
  if (period.kind === 'invalid') return { all: false, months: [] };
  return { all: false, months: [...period.months] };
}

function pendingFor(card) {
  const stored = pendingMonths.get(card.key);
  if (!stored) return appliedMonths(card);
  return { all: stored.all, months: stored.months ? [...stored.months] : null };
}

function samePending(left, right) {
  if (left.all !== right.all) return false;
  if (left.all) return true;
  return (
    left.months.length === right.months.length &&
    left.months.every((month, index) => month === right.months[index])
  );
}

function pendingDiffers(card) {
  return pendingMonths.has(card.key);
}

function setPending(card, next) {
  if (samePending(next, appliedMonths(card))) pendingMonths.delete(card.key);
  else
    pendingMonths.set(card.key, {
      all: next.all,
      months: next.all ? null : [...next.months].sort((a, b) => a - b),
    });
}

function paintMonthEditor(card) {
  if (!card.monthEditor) return;
  const pending = pendingFor(card);
  card.allYear.checked = pending.all;
  for (const chip of card.monthChips.querySelectorAll('[data-month]')) {
    chip.setAttribute(
      'aria-pressed',
      String(pending.all || pending.months.includes(Number(chip.dataset.month))),
    );
  }
  const differs = pendingDiffers(card);
  const empty = !pending.all && pending.months.length === 0;
  const count = card.period.rows.length;
  card.applyButton.disabled = settingsSaving || !differs || empty;
  card.cancelButton.hidden = !differs;
  const note = differs
    ? `Changes ${count} ${count === 1 ? 'window' : 'windows'} — apply to update the tables`
    : `Changes ${count} ${count === 1 ? 'window' : 'windows'}`;
  setText(card.monthNote, note);
  card.monthNote.classList.toggle('pending', differs);
  card.monthError.hidden = !empty;
  setText(card.monthError, empty ? 'Pick at least one month, or choose All year.' : '');
  card.allYear.setAttribute('aria-invalid', String(empty));
  card.monthEditor.classList.toggle('pending', differs);
}

function periodName(period) {
  return period.title === 'Custom months' ? period.monthText : period.title;
}

function paintPeriodHeader(card) {
  const period = card.period;
  const pending = pendingFor(card);
  const differs = pendingDiffers(card);
  const months = differs ? rateMonthsText(pending.months) : period.monthText;
  const showMonths = months !== period.title;
  setText(card.band, showMonths ? (differs ? `${months} (not applied)` : months) : '');
  card.band.hidden = !showMonths;
  card.band.classList.toggle('pending', differs);

  const range = period.rateRange;
  const count = period.rows.length;
  const price =
    period.kind === 'rest'
      ? `other times ${priceText(readFields().rate)}`
      : range
        ? priceRangeText(range)
        : 'rate not set';
  setText(card.meta, `${count} ${count === 1 ? 'window' : 'windows'} · ${nowrap(price)}`);
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
  // A duplicate with nowhere to go (all year, or an invalid scope) is not
  // offered at all: a permanently disabled button reads as a broken action.
  // The derived rest-of-year period owns no rows, so it has neither action.
  const derived = card.period.kind === 'rest';
  const canDuplicate =
    card.period.kind !== 'invalid' && count > 0 && complement.length > 0 && !settingsSaving;
  card.duplicateButton.hidden = !canDuplicate || confirming || derived;
  card.removeButton.hidden = confirming || derived;
  card.confirm.hidden = !confirming;
  setText(
    card.confirmText,
    `Remove the season and ${count} ${count === 1 ? 'window' : 'windows'}?`,
  );
  card.duplicateButton.disabled = !canDuplicate;
  card.duplicateButton.title = 'Copy this season into the months it does not cover.';
}

// The 7-day strip is a quiet shape cue in the collapsed header; the tables and
// the hidden description carry the same information in words.
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
  // The tables describe the applied draft. A pending month choice is staged
  // until Apply, and the month editor says so rather than letting the chips and
  // the tables describe two different scopes without explanation.
  const coverage = periodCoverage(
    draftRates,
    readFields().rate,
    period,
    planPeriods,
    new Date().getFullYear(),
  );

  const present = new Set();
  const strip = [];
  // A season with no windows of its own has nothing to draw: the meta line and
  // the table say the all-other-times price covers every hour.
  const drawStrip = period.rows.length > 0;
  card.axis.hidden = !drawStrip;
  if (drawStrip) {
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
  }
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

  const described = coverage.types
    .map(
      (type) =>
        `${type.label}: ${type.segments
          .map(
            (segment) =>
              `${minutesToClock(segment.from)}–${minutesToClock(segment.to)} ${rateSegmentLabel(
                segment,
                windowRates(),
                readFields().rate,
              )}`,
          )
          .join(', ')}`,
    )
    .join('. ');
  setText(
    card.desc,
    `Typical week in ${coverage.monthText}. ${described}. ${
      coverage.partial ? 'The other months are shown under their own season.' : ''
    }`.replace(/\s+/g, ' '),
  );

  const content = [];
  if (coverage.partial) {
    content.push(
      el(
        'p',
        'coverage-note',
        `Typical week in ${coverage.monthText}. The other months are shown under their own season.`,
      ),
    );
  }
  if (coverage.types.length === 0) {
    content.push(el('p', 'coverage-empty', 'No usable windows yet.'));
  }
  for (const type of coverage.types) {
    const table = el('table', 'coverage-table');
    const caption = el('caption', null, `${type.label} · ${coverage.monthText}`);
    const thead = el('thead');
    const headRow = el('tr');
    for (const [label, className] of [
      ['Time', null],
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
      const tr = el('tr', segment.window ? '' : 'other-times');
      const time = el('th', null, `${minutesToClock(segment.from)}–${minutesToClock(segment.to)}`);
      time.scope = 'row';
      const note = segmentNote(segment);
      if (note) time.append(el('span', 'segment-note', note));
      const band = el('td', 'band');
      if (segment.window) {
        const tier = rateTierFor(segment.rate, windowRates(), readFields().rate);
        band.append(el('span', `tier ${tierClass(tier)}`, tier || 'Window'));
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
    applyButton: null,
    cancelButton: null,
    monthNote: null,
    monthError: null,
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

  if (period.kind === 'rest') {
    const restNote = el(
      'p',
      'period-note',
      'These months have no windows of their own — the all-other-times rate applies. Add a window to give them one.',
    );
    body.append(restNote);
  }
  const monthEditor = period.kind === 'rest' ? null : el('div', 'month-editor');
  const monthHead = el('div', 'month-editor-head');
  if (monthEditor) monthHead.append(el('span', 'field-label', 'Months'));
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
      const current = pendingFor(card);
      let next;
      if (current.all) next = { all: false, months: [month] };
      else {
        const set = new Set(current.months);
        if (set.has(month)) set.delete(month);
        else set.add(month);
        next = { all: false, months: [...set].sort((a, b) => a - b) };
      }
      setPending(card, next);
      paintPeriodHeader(card);
    });
    monthChips.append(chip);
  });
  const actions = el('div', 'month-actions');
  const applyButton = el('button', 'btn small', 'Apply months');
  applyButton.type = 'button';
  applyButton.dataset.action = 'apply-months';
  const cancelButton = el('button', 'btn small', 'Cancel');
  cancelButton.type = 'button';
  cancelButton.dataset.action = 'cancel-months';
  cancelButton.hidden = true;
  const monthNote = el('span', 'month-note');
  cancelButton.addEventListener('click', () => {
    pendingMonths.delete(card.key);
    paintPeriodHeader(card);
    card.allYear.focus({ preventScroll: true });
  });
  applyButton.addEventListener('click', () => applyPendingMonths(card));
  actions.append(applyButton, cancelButton, monthNote);
  const monthError = el('p', 'rule-error');
  monthError.hidden = true;
  if (monthEditor) monthEditor.append(monthHead, monthChips, actions, monthError);
  card.monthEditor = monthEditor;
  card.allYear = allYear;
  card.monthChips = monthChips;
  card.applyButton = applyButton;
  card.cancelButton = cancelButton;
  card.monthNote = monthNote;
  card.monthError = monthError;
  allYear.addEventListener('change', () => {
    if (settingsSaving) return;
    if (allYear.checked) {
      setPending(card, { all: true, months: null });
    } else {
      const current = pendingFor(card);
      const months = current.all ? [new Date().getMonth() + 1] : current.months;
      setPending(card, { all: false, months });
    }
    paintPeriodHeader(card);
    if (!allYear.checked) {
      const first = monthChips.querySelector('[data-month]');
      if (first) first.focus({ preventScroll: true });
    }
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

  if (monthEditor) body.append(monthEditor);
  body.append(coverage, list, addButton, periodActions);
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

function applyPendingMonths(card) {
  const pending = pendingFor(card);
  if (!pending.all && pending.months.length === 0) {
    paintMonthEditor(card);
    card.allYear.focus({ preventScroll: true });
    return;
  }
  const indices = card.period.rows.map((entry) => entry.index);
  const first = indices[0];
  draftRates = applyPeriodMonths(draftRates, indices, pending.all ? null : pending.months);
  pendingMonths.delete(card.key);
  planPeriods = ratePeriodsForDraft();
  const target = planPeriods.find((period) => period.rows.some((entry) => entry.index === first));
  if (target) expandedPeriods.add(target.key);
  markEdited();
  renderPlan();
  const next = target ? periodCards.find((entry) => entry.key === target.key) : null;
  if (next) {
    next.toggle.focus({ preventScroll: true });
    scrollToNode(next.node);
  }
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
  const covered = new Set();
  for (const period of ratePeriodsForDraft()) {
    if (period.kind === 'rest') continue;
    if (period.kind === 'all') for (let month = 1; month <= 12; month += 1) covered.add(month);
    else for (const month of period.months || []) covered.add(month);
  }
  const uncovered = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((month) => !covered.has(month));
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
  pendingMonths.delete(card.key);
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
  prunePending();
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

// A pending month choice belongs to a period that still exists. Anything else
// (a removed period, a months edit that moved the rows) is dropped so it cannot
// apply to a different set of rows later.
function prunePending() {
  const keys = new Set(planPeriods.map((period) => period.key));
  for (const key of [...pendingMonths.keys()]) if (!keys.has(key)) pendingMonths.delete(key);
}

function problemCount() {
  // Count affected rows, not collisions: a period badge and the plan summary
  // must agree when both rows of a collision live in the same period.
  const affected = new Set();
  rateValidation.rows.forEach((errors, index) => {
    if (Object.keys(errors).length > 0) affected.add(index);
  });
  for (const [a, b] of rateValidation.overlaps) {
    affected.add(a);
    affected.add(b);
  }
  return affected.size + (draftRates.length > MAX_RATE_WINDOWS ? 1 : 0);
}

function paintPlan() {
  const flat = draftRates.length === 0;
  $('rates-flat').hidden = !flat;
  $('rates-plan').hidden = flat;
  if (flat) return;

  planPeriods = ratePeriodsForDraft();
  // Only rows that can actually match a month set a meaningful range: a row
  // with unusable months is shown and fixed, but its price never applies.
  const rateRows = planPeriods
    .filter((period) => period.kind !== 'invalid')
    .flatMap((period) => period.rows.map((entry) => entry.row));
  const range = ratePlanRange(rateRows);
  const problems = problemCount();
  const parts = [
    `${planPeriods.length} ${planPeriods.length === 1 ? 'season' : 'seasons'}`,
    `${draftRates.length} ${draftRates.length === 1 ? 'window' : 'windows'}`,
  ];
  if (range) parts.push(nowrap(priceRangeText(range)));
  parts.push(nowrap(`other times ${priceText(readFields().rate)}`));
  setText($('plan-summary-text'), parts.join(' · '));
  const problem = $('plan-problem');
  problem.hidden = problems === 0;
  setText(problem, `${problems} to fix`);

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
  const { date, result } = previewResult();
  const table = $('preview-table');
  const empty = $('preview-empty');
  const note = $('preview-note');
  if (!date || !result) {
    table.hidden = true;
    empty.hidden = false;
    note.hidden = true;
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
  const incomplete = !rateValidation.valid;
  note.hidden = !incomplete;
  setText(note, incomplete ? 'Some windows are incomplete and are left out of this check.' : '');
  note.classList.toggle('warn', incomplete);
}

// Announce the checker only when the owner commits a value, never on every
// keystroke (the visible result still updates live).
function announcePreview() {
  if (draftRates.length === 0) return;
  const { date, result } = previewResult();
  const live = $('preview-live');
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

  const save = $('save-settings');
  save.disabled = !view.canSave;
  setText(save, settingsSaving ? 'Saving…' : 'Save settings');
  $('settings-form').setAttribute('aria-busy', String(settingsSaving));
  $('setting-rate').disabled = settingsSaving;
  $('setting-currency').disabled = settingsSaving;
}

// ---------- rendering ----------

function renderPlan() {
  planPeriods = ratePeriodsForDraft();
  prunePending();
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
  pendingMonths.clear();
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

// Apply every pending month choice so the visible chips are what a save
// carries. An empty choice is the one state the editor refuses, and it takes
// focus to the checkbox that explains it.
function commitPendingMonths() {
  if (pendingMonths.size === 0) return true;
  for (const [key, pending] of pendingMonths) {
    if (pending.all || (Array.isArray(pending.months) && pending.months.length > 0)) continue;
    const card = periodCards.find((entry) => entry.key === key);
    if (card) {
      expandedPeriods.add(card.key);
      setExpanded(card, true);
      paintMonthEditor(card);
      card.allYear.focus({ preventScroll: true });
      scrollToNode(card.monthEditor);
    }
    return false;
  }
  for (const [key, pending] of pendingMonths) {
    const card = periodCards.find((entry) => entry.key === key);
    if (!card) continue;
    const result = applyPeriodMonths(
      draftRates,
      card.period.rows.map((entry) => entry.index),
      pending.all ? null : pending.months,
    );
    const first = card.period.rows[0] ? card.period.rows[0].index : null;
    draftRates = result;
    if (first != null) {
      planPeriods = ratePeriodsForDraft();
      const target = planPeriods.find((period) =>
        period.rows.some((entry) => entry.index === first),
      );
      if (target) expandedPeriods.add(target.key);
    }
  }
  pendingMonths.clear();
  renderPlan();
  return true;
}

async function submit(event) {
  event.preventDefault();
  if (settingsSaving) return;
  // A month choice that is still pending is part of what the owner sees; save
  // it with the rest instead of silently discarding it.
  if (!commitPendingMonths()) {
    settingsSaved = false;
    settingsError = 'Pick at least one month, or choose All year.';
    paintFeedback();
    return;
  }
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
  pendingMonths.clear();
  expandedPeriods.clear();
  removeConfirmKey = null;
  if (!$('settings-form')) return;
  setPreviewNow();
  setFields(null);
  renderErrors({});
  $('settings-form').setAttribute('aria-busy', 'false');
  refresh();
}
