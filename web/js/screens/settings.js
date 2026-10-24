// App-settings card: one rate, or a plan of date/month seasons each with a base
// rate and optional daily windows, plus a checker that reads the draft.
//
// The stored document keeps one flat `rates` list; periods are a presentation
// over each row's shared scope (`months`, or `from`/`to`), so grouping never
// changes the payload or the matching order. A period owns its scope; the rows
// inside it inherit it and have no scope control of their own. All edits flow
// through the same draft/dirty/saved/waiting/error machine, and a failed write
// still reconciles back to the last confirmed server state.

import { $, el, setText } from '../ui.js';
import {
  LOAD_FAILED_MESSAGE,
  OFFLINE_MESSAGE,
  RATE_CAP_REMEDY,
  applyPeriodDatesInPlace,
  applyPeriodMonths,
  baseRateRow,
  canDuplicatePeriod,
  complementScope,
  copyPeriodRows,
  dateInputValue,
  defaultRateRow,
  flatToScheduleRow,
  formatPreviewWhen,
  firstLoadFields,
  largestDateScope,
  nextWindowPreset,
  normalizeSettings,
  parseLocalDateTime,
  periodHasBaseOverlap,
  periodHasDates,
  periodRowScope,
  previewBlocker,
  previewRate,
  rateEditorMode,
  rateIsUsable,
  ratePeriods,
  rateRowFields,
  reconcileSettingsSave,
  saveButtonState,
  scheduleToFlatRate,
  scopesOverlap,
  settingsDraftMatches,
  settingsFields,
  settingsSaveState,
  settingsSnapshotIsBaseline,
  submitSettingsPlan,
  timeInputValue,
  uncoveredDateRanges,
  uncoveredGapScopes,
  validateRateEditorRows,
  validateSettings,
  validationProblemCount,
} from '../settings.js';
import { MAX_RATE_WINDOWS, monthsCovering } from '../rates.js';
import { saveSettings as persistSettings } from '../store.js';
import { settleWrite } from '../write.js';
import {
  createPeriodCard,
  nowrapEl,
  paintPeriodActions,
  paintPlan,
  paintRateValidation,
  priceText,
  tierClass,
} from './settings-paint.js';

// The pure season-date helpers now live in js/settings/plan.js; re-exported
// here so the screen's tests keep this import path.
export {
  boundFromDateInput,
  dateInputForBound,
  periodBandCopy,
  referenceStartYear,
} from '../settings.js';

// Last server-confirmed settings and the form state built from them. The flat
// fields live in their inputs; the rate rows live in `draftRates`, with the
// rendered controls in `windowCards`. Saving disables editing so there is no
// mid-write drift.
let confirmedSettings = null;
// Whether the first settings snapshot has arrived — including the snapshot that
// says the document is absent. Until it has there is no baseline, so the form is
// blank for reasons the owner cannot see and Save is held.
let settingsLoaded = false;
// The settings listener failed outright. While no baseline has been read, the
// hold on Save then has no natural end (a failed subscription does not retry),
// so the card must say why instead of showing "Loading…" forever.
let settingsLoadFailed = false;
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
// The period key of the season the mode switch seeded, while the plan note that
// explains the seed still applies. Empty when there is nothing to explain.
let seedNoticeKey = '';
// Whether the draft leaves any instant with no price. Recomputed once per paint
// so every card's base block can describe the same plan without re-walking it.
let planUnpriced = false;
let rateValidation = validateRateEditorRows([]);

function readFields() {
  return {
    rate: $('setting-rate').value,
    currency: $('setting-currency').value,
    chargerHost: $('setting-charger-host').value,
    showTemperature: $('setting-show-temperature').checked,
    rates: draftRates,
  };
}

// The browser's own connection claim. It is only a hint — a dead uplink still
// reports online — so it never decides whether a save may run; it shapes the
// copy and stops obviously-doomed writes before they queue.
function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function currentRateMode() {
  return rateEditorMode(draftRates);
}

// The mode is derived from the draft rows, never stored. One rate is the flat
// pair; Seasons hides the unused fallback rate (the shared currency remains).
function paintRateMode() {
  const mode = currentRateMode();
  const seasons = mode === 'seasons';
  // While the switch-to-One-rate panel is open the owner is being asked to
  // accept a price: the RATE field it would apply stays visible, so the decision
  // is made on the number, not on the season's summary.
  const confirming = !$('rate-mode-confirm').hidden;
  const hiddenOnSeasons = seasons && !confirming;
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
  $('fallback-card').classList.toggle('is-season', hiddenOnSeasons);
  $('fallback-head').hidden = hiddenOnSeasons;
  $('fallback-rate-field').hidden = hiddenOnSeasons;
  $('rates-plan').hidden = !seasons;
  if (!seasons) $('rate-mode-confirm').hidden = true;
  // The panel names the price it would apply, and RATE/CURRENCY stay editable
  // while it is open, so the sentence is rewritten from the current draft on
  // every repaint: the price the owner reads is the price confirm applies.
  if (!$('rate-mode-confirm').hidden) {
    setText($('rate-mode-confirm-text'), oneRateConfirmText());
  }
}

function focusBaseRate() {
  const period = periodCards[0];
  if (period && period.baseInput) {
    period.baseInput.focus({ preventScroll: true });
    scrollToNode(period.node);
  }
}

// Flat -> Seasons seeds the current month at the flat rate, not an All-year
// base: an All-year base covers every date, so the next "Add a season" has
// nowhere non-overlapping to go and is disabled the moment the mode switch
// finishes. The rest of the year stays an uncovered gap (the plan says so and
// offers Fill gaps) and Add a season stays live.
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
  seedNoticeKey = planPeriods.length === 1 ? planPeriods[0].key : '';
  markEdited();
  renderPlan();
  paintRateMode();
  focusBaseRate();
}

// The confirmation has to name the price it would apply: Seasons mode hides the
// RATE field and the plan summary quotes the season's range, so without the
// number the owner consents to a price they cannot see. `paintRateMode` rewrites
// it while the panel is open, so an edit made during the confirmation cannot
// leave a stale number on screen.
function oneRateConfirmText() {
  const flat = scheduleToFlatRate(draftRates, $('setting-rate').value);
  const price = rateIsUsable(flat) ? priceText(flat) : '';
  return price
    ? `One rate of ${price} will apply everywhere. Seasons and daily windows will be removed.`
    : 'One rate will apply everywhere. Seasons and daily windows will be removed.';
}

function requestOneRate() {
  if (settingsSaving || currentRateMode() === 'flat') return;
  const confirm = $('rate-mode-confirm');
  confirm.hidden = false;
  paintRateMode();
  $('cancel-one-rate').focus({ preventScroll: true });
}

function cancelOneRate() {
  $('rate-mode-confirm').hidden = true;
  paintRateMode();
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
  seedNoticeKey = '';
  $('rate-mode-confirm').hidden = true;
  markEdited();
  renderPlan();
  paintRateMode();
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

// The API field keys and their DOM ids differ for the charger address: the
// validator reports `chargerHost`, the card's input is `setting-charger-host` and
// its error slot `charger-host-error`. One mapping, used by every paint/focus
// path, so no caller has to know the spelling.
const FIELD_IDS = { chargerHost: 'charger-host' };

function fieldId(field) {
  return FIELD_IDS[field] || field;
}

function paintFieldError(field, message) {
  const input = $(`setting-${fieldId(field)}`);
  const node = $(`${fieldId(field)}-error`);
  input.setAttribute('aria-invalid', String(Boolean(message)));
  node.hidden = !message;
  setText(node, message);
}

function renderErrors(errors = {}) {
  for (const field of ['rate', 'currency', 'chargerHost']) {
    paintFieldError(field, errors[field] || '');
  }
}

// ---------- small DOM helpers ----------

function scrollToNode(node) {
  node.scrollIntoView({
    block: 'center',
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
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
function paintState() {
  return {
    // Live reads of the screen's mutable plan state — the vars stay here as
    // the single source of truth; the paint layer never caches them.
    get draftRates() {
      return draftRates;
    },
    get planPeriods() {
      return planPeriods;
    },
    set planPeriods(value) {
      planPeriods = value;
    },
    get rateValidation() {
      return rateValidation;
    },
    get settingsSaving() {
      return settingsSaving;
    },
    get expandedPeriods() {
      return expandedPeriods;
    },
    get removeConfirmKey() {
      return removeConfirmKey;
    },
    set removeConfirmKey(value) {
      removeConfirmKey = value;
    },
    get planUnpriced() {
      return planUnpriced;
    },
    set planUnpriced(value) {
      planUnpriced = value;
    },
    get seedNoticeKey() {
      return seedNoticeKey;
    },
    set seedNoticeKey(value) {
      seedNoticeKey = value;
    },
    get periodCards() {
      return periodCards;
    },
    get windowCards() {
      return windowCards;
    },
    // The screen verbs the paint layer's wiring calls back into.
    currentRateMode,
    paintRateMode,
    ratePeriodsForDraft,
    readFields,
    markEdited,
    refresh,
    commitRowShape,
    applyMonths,
    applyDates,
    setExpanded,
    scrollToNode,
    addWindow,
    addBaseRate,
    removeBaseRate,
    removeWindow,
    duplicatePeriod,
    requestRemovePeriod,
    removePeriod,
  };
}

function refresh() {
  rateValidation = validateRateEditorRows(draftRates, $('setting-rate').value);
  paintPlan(paintState());
  paintRateValidation(paintState());
  paintPreview();
  paintFeedback();
}

// ---------- window rows ----------

// Which row each season's Base rate block presents. A time or day edit can turn
// a window into the base (start === end and every day) or repair a malformed base
// back into a window; the base block, the window list and the coverage table all
// describe a different plan afterwards, so that edit is structural. Everything
// else about a row edit is painted in place, which keeps the focused input alive
// mid-typing.
function baseShapeKey(periods) {
  return (Array.isArray(periods) ? periods : [])
    .map((period) => `${period.key}:${period.base ? period.base.index : '-'}`)
    .join('|');
}

// Commit a time/day edit: repaint in place unless the edit changed which row is
// the base.
function commitRowShape(card) {
  const before = baseShapeKey(planPeriods);
  markEdited();
  if (baseShapeKey(ratePeriodsForDraft()) === before) {
    refresh();
    return;
  }
  deferShapeRebuild(card.index, card.row.id);
}

// Rebuild after the interaction that changed the shape has been delivered, then
// land focus on the control that now represents the edited row: its Base rate
// field when it became the base, otherwise its own window again. A rebuild
// during `input` would swallow the keystroke that caused it.
function deferShapeRebuild(anchorIndex, rowId) {
  cancelPlanRebuild();
  const token = planRenderToken;
  planRenderTimer = setTimeout(() => {
    if (token !== planRenderToken) return;
    planRenderTimer = 0;
    const active = document.activeElement;
    renderPlan();
    // Focus already moved somewhere the rebuild left alone (a button outside the
    // plan): that is where the owner is, so it is not stolen back.
    if (document.contains(active) && active !== document.body) return;
    const card = periodCards.find((entry) =>
      entry.period.rows.some((row) => row.index === anchorIndex),
    );
    if (!card) return;
    const isBase = Boolean(card.period.base && card.period.base.row.id === rowId);
    const windowCard = windowCards[anchorIndex];
    const control = isBase
      ? card.baseInput
      : windowCard && (windowCard.startInput || windowCard.rateInput);
    if (control) control.focus({ preventScroll: true });
    else if (card.addButton) card.addButton.focus({ preventScroll: true });
    scrollToNode(card.node);
  }, 0);
}

// ---------- period cards ----------

function setExpanded(card, expanded) {
  if (expanded) expandedPeriods.add(card.key);
  else expandedPeriods.delete(card.key);
  card.toggle.setAttribute('aria-expanded', String(expanded));
  if (card.editDates) card.editDates.setAttribute('aria-expanded', String(expanded));
  card.body.hidden = !expanded;
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
    // The chips live in the advanced disclosure, which this edit can hide: a
    // removal that leaves one contiguous run hands the scope to the date fields.
    // Focus what is on screen — a hidden chip would leave focus on <body> and
    // restart the next Tab at the top of the page.
    if (next.advancedMonths.hidden) {
      (next.dateFocus || next.editDates).focus({ preventScroll: true });
    } else {
      next.advancedMonths.open = true;
      const chip = next.monthChips.querySelector(`[data-month="${focusMonth}"]`);
      (chip || next.toggle).focus({ preventScroll: true });
    }
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
  // In place: the shape-preserving branch below repaints the existing cards, and
  // their rate/time/day controls hold these row objects. Replacing them with
  // copies left every control in the period writing to a row the draft no longer
  // contained, so a typed rate never reached validation (the field showed the
  // new price while the card kept saying "Enter a rate between 0 and 5.").
  draftRates = applyPeriodDatesInPlace(draftRates, indices, from, to);
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
    const control = edited && edited.node.querySelector(`[data-field="${field || 'from-date'}"]`);
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
    paintPeriodActions(card, paintState());
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
    // Never claim a price while a window is incomplete or two windows collide:
    // the invalid row is omitted from the lookup, so the answer could be wrong.
    // The checker resumes as soon as the plan is fixable.
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
    loaded: settingsLoaded,
    saving: settingsSaving,
    waiting: settingsWaiting,
    saved: settingsSaved,
    error: settingsError || (!settingsLoaded && settingsLoadFailed ? LOAD_FAILED_MESSAGE : ''),
    offline: isOffline(),
  });
  // The value comparison is the only dirty rule; keep the flag in step.
  settingsDirty = view.dirty;
  // The unsaved-changes guard rides the same flag: the native beforeunload
  // hook exists only for the dirty window, and an open leave dialog whose
  // premise just disappeared (the save settled, or a matching snapshot
  // landed) settles as "leave" — the navigation the owner already asked for
  // is safe now, so it completes instead of waiting for an answer.
  syncLeaveGuard();
  if (!settingsDirty && leaveAnswer) settleLeave(true);
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
  $('setting-charger-host').disabled = settingsSaving;
  $('setting-show-temperature').disabled = settingsSaving;
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
    const card = createPeriodCard(period, index, paintState());
    list.append(card.node);
    periodCards.push(card);
  });
  refresh();
}

function writeFields(fields) {
  $('setting-rate').value = fields.rate;
  $('setting-currency').value = fields.currency;
  $('setting-charger-host').value = fields.chargerHost || '';
  $('setting-show-temperature').checked = fields.showTemperature !== false;
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
  if ($(`${fieldId(field)}-error`).hidden === false) {
    const result = validateSettings(readFields());
    paintFieldError(field, result.errors[field] || '');
  }
}

// ---------- save-state machine ----------

// settings/current — null means the owner has not saved a rate yet. A remote
// snapshot never overwrites a draft; it only becomes the new confirmed baseline.
export function showSettingsData(data, meta) {
  // A cached "no document" snapshot is the local cache answering before the
  // server: it is not evidence that the owner has no stored plan, so it neither
  // becomes the baseline nor opens the save gate. A cached snapshot that does
  // carry the document holds the stored values a whole-document write must
  // re-send, so it opens the gate like a server snapshot.
  if (!settingsSnapshotIsBaseline(data, meta)) return;
  const next = normalizeSettings(data);
  settingsLoadFailed = false;
  // The first snapshot is the document's truth even when it reports no document
  // (`data === null`). Before it lands the screen has no baseline, so Save is
  // held (settingsSaveState) — see the `first` branch below for the draft that
  // was typed into the not-yet-loaded form.
  const first = !settingsLoaded;
  settingsLoaded = true;
  if (settingsSaving || settingsWaiting) {
    // A save can only be in flight after the first snapshot (Save is held until
    // then), so `first` is never true here.
    pendingSettings = { settings: next };
    return;
  }
  // "Typed" is the value comparison against the baseline we are replacing.
  const typed = !settingsDraftMatches(readFields(), confirmedSettings);
  confirmedSettings = next;
  if (first) {
    // A draft typed before the document was known lacks the stored values a
    // whole-document save has to re-send, so it is completed from the snapshot
    // instead of being adopted or repainted wholesale.
    settingsSaved = false;
    renderErrors({});
    writeFields(firstLoadFields(readFields(), next));
  } else if (!typed && !settingsDraftMatches(readFields(), next)) {
    setFields(next);
    // A failed-save message stays until the user acts: a snapshot echoing the
    // server truth does not undo the attempt the message describes.
    settingsSaved = false;
    renderErrors({});
  }
  paintFeedback();
}

// The settings listener failed. No baseline was read, so the save gate stays
// closed; the card names the failure so the owner is not left watching a
// loading hold that cannot end. Only painted while the gate is closed: once a
// baseline exists a failed re-read leaves a usable (if stale) form, and its
// message must not displace the dirty/save feedback.
export function showSettingsError() {
  settingsLoadFailed = true;
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
  // Save is held, not merely reported blocked, until the first settings
  // snapshot lands: this blank form has none of the stored values, and the
  // write replaces the whole document (it would delete `rates` and
  // `charger_host`). The gate is here so no validation work runs either.
  if (!settingsLoaded) {
    paintFeedback();
    return;
  }
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
  paintRateValidation(paintState());
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
  if (isOffline()) {
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
    // The month chips are the legacy path, and they are hidden for a date or a
    // contiguous month season: reveal them only where they exist, otherwise the
    // scope is the date fields.
    const { advancedMonths, monthChips } = card.periodCard;
    if (advancedMonths && !advancedMonths.hidden) {
      advancedMonths.open = true;
      const chip =
        monthChips &&
        (monthChips.querySelector('[aria-pressed="true"]') || monthChips.querySelector('button'));
      if (chip) {
        chip.focus({ preventScroll: true });
        return;
      }
    }
    (card.periodCard.dateFocus || card.periodCard.fromDate).focus({ preventScroll: true });
    return;
  }
  // A base price error belongs to the Base rate block, not a window row.
  if (focus === 'base-rate') {
    view.expand(card.periodCard);
    view.reveal(card.periodCard.baseBlock);
    // The block is rebuilt whenever a row's base shape changes, so the field is
    // there for any base row; a malformed all-day row that never became the base
    // keeps its own window card, which is where its price lives.
    const control = card.periodCard.baseInput || card.rateInput;
    if (control) control.focus({ preventScroll: true });
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
  focusField: (field) => $(`setting-${fieldId(field)}`).focus(),
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

// ---------- unsaved-changes guard (#129) ----------

// The native half of the guard: while the draft is dirty, leaving the page
// (reload, close, an external link) must warn. Attached only for the dirty
// window — a clean form never intercepts the unload. The browser owns the
// dialog copy; this only decides whether it appears.
let beforeUnloadOn = false;

function beforeUnloadGuard(event) {
  event.preventDefault();
  event.returnValue = '';
}

function syncLeaveGuard() {
  if (settingsDirty) {
    if (!beforeUnloadOn) {
      addEventListener('beforeunload', beforeUnloadGuard);
      beforeUnloadOn = true;
    }
    return;
  }
  if (beforeUnloadOn) {
    removeEventListener('beforeunload', beforeUnloadGuard);
    beforeUnloadOn = false;
  }
}

// The dirty flag the router's gate reads — the same one the feedback pipeline
// maintains, so the guard can never disagree with the "Unsaved changes."
// status above the Save button.
export function isSettingsDirty() {
  return settingsDirty;
}

// The router's half of the guard: leaving the Config tab with a dirty form
// asks first. Same alertdialog pattern as the One-rate confirm — role,
// styling, Escape is the safe action, and focus returns to the tab pattern
// when the owner stays. Resolves true to leave (the edits stay unsaved, the
// navigation proceeds), false to stay.
let leaveAnswer = null; // { promise, resolve } while the dialog is open

export function confirmLeaveSettings() {
  if (!settingsDirty) return Promise.resolve(true);
  if (leaveAnswer) return leaveAnswer.promise;
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  leaveAnswer = { promise, resolve: settle };
  $('leave-settings-confirm').hidden = false;
  // The dialog is in-flow at the top of the form, but its trigger — the tab
  // bar — is fixed at the viewport bottom and works at any scroll offset, so
  // the form's top (and the dialog with it) can sit above view when it opens.
  // Unlike the One-rate confirm, whose trigger sits beside its dialog, focus
  // alone would not reveal it: reveal it first. Stay is the safe action, so
  // it takes focus and the louder button.
  revealNode($('leave-settings-confirm'));
  $('stay-settings').focus({ preventScroll: true });
  return promise;
}

// Resolve the open dialog and close it. `leave` is true to proceed with the
// pending navigation, false to stay.
function settleLeave(leave) {
  if (!leaveAnswer) return;
  const { resolve } = leaveAnswer;
  leaveAnswer = null;
  $('leave-settings-confirm').hidden = true;
  resolve(leave);
}

function stayOnSettings() {
  settleLeave(false);
  // The dialog interrupted a tabbar navigation, so focus rejoins the tab
  // pattern on the still-selected Config tab.
  $('tab-config').focus({ preventScroll: true });
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
  $('setting-charger-host').addEventListener('input', () => handleInput('chargerHost'));
  // The toggle is a boolean, so it has no field error to keep live; it only
  // marks the form dirty.
  $('setting-show-temperature').addEventListener('change', recomputeDirty);
  $('rate-mode-flat').addEventListener('click', requestOneRate);
  $('rate-mode-seasons').addEventListener('click', switchToSeasons);
  $('rate-mode-flat').addEventListener('keydown', paintModeKeyboard);
  $('rate-mode-seasons').addEventListener('keydown', paintModeKeyboard);
  $('confirm-one-rate').addEventListener('click', confirmOneRate);
  $('cancel-one-rate').addEventListener('click', cancelOneRate);
  $('rate-mode-confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancelOneRate();
  });
  // The unsaved-changes guard's dialog (#129): Escape is the safe action,
  // exactly like the One-rate confirm.
  $('stay-settings').addEventListener('click', stayOnSettings);
  $('discard-settings').addEventListener('click', () => settleLeave(true));
  $('leave-settings-confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') stayOnSettings();
  });
  $('fill-gaps').addEventListener('click', fillGaps);
  $('seed-cover').addEventListener('click', fillGaps);
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
    if (settingsError === OFFLINE_MESSAGE) settingsError = '';
    // The offline copy is not only an error: the not-yet-loaded hold shows it
    // too, so a reconnect has to repaint back to the loading message.
    paintFeedback();
  });
  // The reverse: going offline while the first snapshot is still outstanding
  // turns the hold into "reconnect", which is the reason it cannot finish.
  addEventListener('offline', () => {
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
  settingsLoaded = false;
  settingsLoadFailed = false;
  pendingSettings = null;
  settingsDirty = false;
  settingsSaving = false;
  settingsWaiting = false;
  settingsSaved = false;
  settingsError = '';
  // The guard must not outlive the session (closeApp teardown, sign-out):
  // drop the native beforeunload hook and close any open leave dialog —
  // teardown answers "stay", so no navigation fires while screens reset.
  settleLeave(false);
  syncLeaveGuard();
  expandedPeriods.clear();
  removeConfirmKey = null;
  if (!$('settings-form')) return;
  setPreviewNow();
  setFields(null);
  renderErrors({});
  $('settings-form').setAttribute('aria-busy', 'false');
  refresh();
}
