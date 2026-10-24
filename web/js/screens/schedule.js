// Schedule editor: a draft separate from the last confirmed snapshot, a pure
// validator, and an optimistic save that rolls back on failure. Incoming
// snapshots never replace unsaved edits. Offline, the save is handed to
// Firestore's persistent queue and labelled "Queued" instead of being refused
// or held on an unbounded "Saving…". The flag that identifies such a write after
// a reload travels as `schedule/current` snapshot metadata (`hasPendingWrites`,
// forwarded by store.js and app.js): the promise from the earlier page is gone,
// so the acknowledged snapshot is what clears the queued label.
//
// The schedule watch requests metadata changes, so one snapshot can repeat the
// same data for a different write state (queued → acknowledged) or cache state.
// Those repeats are guarded by transition, never applied as new data, and they
// never erase a notice that explains the last real change.

import { $, el, setText } from '../ui.js';
import { readScheduleBaseline, saveSchedule } from '../store.js';
import {
  DAY_NAMES,
  MAX_AMPS,
  MAX_RULES,
  MIN_AMPS,
  defaultRule,
  defaultSchedule,
  discardBaselineReadApplies,
  discardBaselineStart,
  discardRetry,
  discardTarget,
  normalizeSchedule,
  queuedSaveState,
  reconcileAfterSave,
  reloadDiscardBaseline,
  routeScheduleSnapshot,
  scheduleKey,
  scheduleSaveValid,
  toggleNote,
  validateSchedule,
} from '../schedule.js';
import { settleWrite } from '../write.js';

// Keep focus/scroll from jumping when a snapshot arrives for an untouched form.
let active = false;
let initialized = false;
let loadError = false;
let confirmed = defaultSchedule();
let draft = defaultSchedule();
let dirty = false;
let saving = false;
// The write is durable in Firestore's local queue but not acknowledged. The
// editor stays unlocked; a later save queues a newer payload behind it.
let queued = false;
// True when `queued` was rediscovered from snapshot metadata after a reload:
// the write came from an earlier page, so no promise in this session settles
// it. The watch owns the transition until the backend acknowledges or replaces
// the write; a local save takes over from here.
let queuedFromSnapshot = false;
// The UI stopped waiting at the deadline while the browser still reports
// online: the write may or may not reach the backend, and its settle is late.
let savingUnconfirmed = false;
// Key of the payload the outstanding write carries. While queued it is also the
// draft's comparison baseline: a draft equal to it has nothing new to save.
let savingPayloadKey = null;
// Latest snapshot received while the form is dirty or a save is in flight.
// It never clobbers the draft; save settle decides whether to adopt it.
let pendingRemote = null;
// '' when hidden, otherwise the notice copy: a remote change the draft would
// overwrite, or a queued change the server never accepted.
const REMOTE_NOTICE = 'Remote schedule changed — saving will overwrite it.';
const REVERTED_NOTICE = 'The queued change was not saved — showing the charger’s schedule.';
// A dirty draft is kept, so the reverted notice must not claim to show the
// charger's copy.
const REVERTED_DIRTY_NOTICE = 'The queued change was not saved — your edits are still here.';
let remoteNotice = '';
// The server's `schedule/current` fetched for a reload-queued write. The cached
// document carries the queued payload, so this is the only honest Discard
// baseline; it never replaces what the form shows.
let discardBaseline = null;
// Key of the queued payload `discardBaseline` was fetched for. A copy read for
// an earlier payload cannot compensate the current one, and a read still in
// flight for it is abandoned.
let discardBaselineKey = null;
let discardBaselineStatus = 'idle'; // idle | loading | ready | failed
let discardToken = 0;
// Bounded retry of a failed baseline read while the browser reports online.
let discardRetries = 0;
let discardRetryTimer = null;
let validation = validateSchedule(defaultSchedule());
let feedbackMode = 'derived'; // derived | saved | discarded | load-error
// A failed save stays visible through the SDK's revert snapshot (and any later
// remote adoption) until the next edit or save clears it.
let saveError = '';
// Identifies the active save so a late settle from an abandoned write is ignored.
let saveToken = 0;
// Counts user edits. A save captures it so its settle can tell an untouched
// draft from one the user changed (including editing back to the pre-save
// baseline, which scheduleKey alone cannot distinguish).
let editGeneration = 0;
let live = { inWindow: false, activeRuleId: null };
let cards = [];
let generation = 0;

function clone(schedule) {
  return normalizeSchedule(schedule);
}

const DISCARDED = 'Changes discarded — the original schedule will be saved.';

// The draft is measured against the last locally accepted payload: while a
// write is queued that is the payload, not the older confirmed snapshot, so an
// untouched draft is not offered as an "unsaved" save again. The confirmed
// snapshot remains the rollback and discard baseline.
function acceptedKey() {
  return (queued || savingUnconfirmed) && savingPayloadKey
    ? savingPayloadKey
    : scheduleKey(confirmed);
}

function markDirty() {
  editGeneration += 1;
  saveError = '';
  // The load already showed the unsupported-shape warning; the first edit is
  // the user explicitly replacing the stored document with a well-formed one.
  if (draft.malformed) delete draft.malformed;
  dirty = scheduleKey(draft) !== acceptedKey();
  const inFlight = saving || savingUnconfirmed || queued;
  if (!dirty) {
    // A remote change queued while we were editing becomes the truth once the
    // draft no longer differs from the last confirmed snapshot. While a save is
    // still in flight the queued snapshot may be our own echo, so its settle
    // decides: a user who reverted to the baseline keeps that revert on screen.
    if (pendingRemote && !inFlight) {
      adopt(pendingRemote);
      return;
    }
    if (!inFlight) remoteNotice = '';
  }
  feedbackMode = 'derived';
  validateAndPaint();
}

function renderRemoteNotice() {
  const notice = $('schedule-remote-notice');
  if (!notice) return;
  // A reload-queued write cannot be discarded without its server baseline; the
  // reason shares the inline notice slot so it is visible and announced, not
  // only a hover title. "Checking" is transient, so it stays a title only and
  // does not re-announce on every load.
  const decision = discardDecision();
  const hint =
    decision && decision.status !== 'ready' && decision.status !== 'checking'
      ? decision.reason
      : '';
  const text = remoteNotice || hint;
  notice.hidden = !text;
  if (text) setText(notice, text);
}

// The Discard decision for a write rediscovered after a reload. The pure helper
// owns the rules; the screen owns the fetched copy and the read's progress.
// In-session queued writes (from a save this page issued) keep using the
// confirmed snapshot, exactly as before.
function discardDecision() {
  if (!(queued && queuedFromSnapshot)) return null;
  return reloadDiscardBaseline({
    baseline: discardBaseline,
    baselineKey: discardBaselineKey,
    payloadKey: savingPayloadKey,
    online: online(),
    pending: discardBaselineStatus === 'loading',
    failed: discardBaselineStatus === 'failed',
  });
}

function clearDiscardBaseline() {
  clearDiscardRetry();
  discardRetries = 0;
  discardToken += 1;
  discardBaseline = null;
  discardBaselineKey = null;
  discardBaselineStatus = 'idle';
}

function clearDiscardRetry() {
  if (discardRetryTimer === null) return;
  clearTimeout(discardRetryTimer);
  discardRetryTimer = null;
}

// Retry a baseline read that failed while online: a transient 500 or timeout
// must not leave Discard disabled until a reconnect event that may never fire.
// The budget is bounded, and a reconnect or a new queued payload starts over.
function armDiscardRetry(gen, token) {
  clearDiscardRetry();
  const delay = discardRetry({
    status: discardBaselineStatus,
    online: online(),
    attempts: discardRetries,
  });
  if (delay === null) return;
  discardRetries += 1;
  discardRetryTimer = setTimeout(() => {
    discardRetryTimer = null;
    if (gen !== generation || token !== discardToken) return;
    if (discardBaselineStatus !== 'failed' || !(queued && queuedFromSnapshot)) return;
    startDiscardBaseline();
  }, delay);
}

function failDiscardBaseline(gen, token) {
  discardBaselineStatus = 'failed';
  armDiscardRetry(gen, token);
  validateAndPaint();
}

// Read the pre-write schedule from the server. The cached document already
// contains the queued payload, so this read is what lets Discard compensate
// against the last saved schedule. It never touches the displayed draft. A copy
// or read in flight is reused only for the queued payload it was started for: a
// different payload invalidates it and reads again, and Discard stays disabled
// ("checking") until the read for the current payload answers.
function startDiscardBaseline({ fresh = false } = {}) {
  const request = discardBaselineStart({
    status: discardBaselineStatus,
    baselineKey: discardBaselineKey,
    payloadKey: savingPayloadKey,
    fresh,
    online: online(),
  });
  // A reconnect or a different queued payload starts the bounded retry budget
  // over even when the read it interrupts was still in flight, so the reset
  // happens before any early return.
  if (request.resetRetries) discardRetries = 0;
  if (request.invalidate) {
    // The superseded read no longer owns the baseline: bumping the token makes
    // its response inert whatever it resolves with.
    clearDiscardRetry();
    discardToken += 1;
    discardBaseline = null;
    discardBaselineKey = null;
    discardBaselineStatus = 'idle';
  }
  if (request.reusable) return;
  const key = savingPayloadKey;
  if (!request.start) {
    // Offline (or no queued payload): no server copy is reachable. The `online`
    // event is the trigger that tries again.
    clearDiscardRetry();
    discardBaseline = null;
    discardBaselineKey = null;
    discardBaselineStatus = 'idle';
    return;
  }
  clearDiscardRetry();
  const gen = generation;
  const token = ++discardToken;
  discardBaseline = null;
  discardBaselineKey = null;
  discardBaselineStatus = 'loading';
  // A response may only land while this read still owns the baseline for the
  // queued payload it was issued for.
  const stillOwnsRead = () =>
    discardBaselineReadApplies({
      readGeneration: gen,
      generation,
      readToken: token,
      token: discardToken,
      readKey: key,
      payloadKey: savingPayloadKey,
    }) &&
    queued &&
    queuedFromSnapshot;
  readScheduleBaseline()
    .then(({ ok, data }) => {
      if (!stillOwnsRead()) return;
      if (!ok) {
        failDiscardBaseline(gen, token);
        return;
      }
      // An absent document is the same schedule the editor shows for it.
      discardBaseline = normalizeSchedule(data);
      discardBaselineKey = key;
      discardBaselineStatus = 'ready';
      discardRetries = 0;
      validateAndPaint();
    })
    .catch(() => {
      if (!stillOwnsRead()) return;
      failDiscardBaseline(gen, token);
    });
}

function saveState() {
  const state = queuedSaveState({
    online: online(),
    saving,
    queued,
    unconfirmed: savingUnconfirmed,
    dirty,
    saved: feedbackMode === 'saved',
    error: saveError,
  });
  const decision = discardDecision();
  if (decision) {
    state.canDiscard = decision.status === 'ready';
    state.discardReason = decision.reason;
  }
  // Only the server copy can compensate after a reload; the in-session path
  // keeps reverting to the confirmed snapshot.
  state.discardBaseline = discardTarget({ queuedFromSnapshot, decision, confirmed });
  return state;
}

function renderFeedback() {
  const fb = $('schedule-feedback');
  let text = '';
  let kind = '';
  let busy = false;
  if (feedbackMode === 'load-error' || loadError) {
    text = "Couldn't load the schedule. Reload the page to try again.";
    kind = 'err';
  } else {
    const state = saveState();
    text = state.label;
    kind = state.kind;
    busy = state.busy;
    // The discard is only offered with a write outstanding; the compensating
    // write explains itself until it settles or the user edits again.
    if (feedbackMode === 'discarded' && !saveError) {
      text = DISCARDED;
      kind = 'warn';
    } else if (
      !saveValid() &&
      !saveError &&
      !saving &&
      !savingUnconfirmed &&
      !queued &&
      feedbackMode !== 'saved'
    ) {
      // An invalid draft is the actionable state; every write state above wins.
      text = 'Fix the highlighted fields before saving.';
      kind = '';
    }
  }
  fb.className = `feedback${busy ? ' busy' : ''}${kind ? ` ${kind}` : ''}`;
  setText(fb, text);
}

// Rule errors are warnings while scheduling is off: the bridge's explicit
// disable ignores unusable rules, so they must not block turning it off.
function saveValid() {
  return scheduleSaveValid(draft, validation);
}

function syncControls() {
  const locked = !initialized || loadError || saving;
  const editor = $('schedule-editor');
  $('panel-schedule').setAttribute('aria-busy', String(saving));
  for (const node of editor.querySelectorAll('input, button')) node.disabled = locked;
  const discard = $('discard-schedule');
  if (locked) {
    discard.removeAttribute('title');
    return;
  }
  const state = saveState();
  $('add-rule').disabled = draft.rules.length >= MAX_RULES;
  $('save-schedule').disabled = !state.canSave || !saveValid();
  discard.disabled = !state.canDiscard;
  // A disabled button is not focusable, so the reason also rides on the title
  // (and the inline notice above) instead of the control alone.
  if (state.discardReason) discard.title = state.discardReason;
  else discard.removeAttribute('title');
}

function validateAndPaint() {
  validation = validateSchedule(draft);
  cards.forEach((card, index) => {
    const errors = validation.ruleErrors[index] || {};
    const messages = [...new Set(Object.values(errors))];
    card.errorEl.hidden = messages.length === 0;
    setText(card.errorEl, messages.join(' '));
    card.startInput.setAttribute('aria-invalid', String(Boolean(errors.start)));
    card.endInput.setAttribute('aria-invalid', String(Boolean(errors.end)));
    card.ampsInput.setAttribute('aria-invalid', String(Boolean(errors.amps)));
    card.stepper.classList.toggle('invalid', Boolean(errors.amps));
    card.daysEl.setAttribute('aria-invalid', String(Boolean(errors.days)));
    card.daysEl.classList.toggle('invalid', Boolean(errors.days));
    card.node.classList.toggle('invalid', messages.length > 0);
  });
  const docError = validation.errors.rules || validation.errors.enabled || '';
  $('schedule-doc-error').hidden = !docError;
  setText($('schedule-doc-error'), docError);
  $('schedule-count').textContent = `${draft.rules.length} of ${MAX_RULES}`;
  setText($('save-schedule'), saving ? 'Saving…' : 'Save schedule');
  syncControls();
  renderFeedback();
  renderRemoteNotice();
  renderLive();
}

function dayChip(rule, day, index) {
  const button = el('button', 'day', DAY_NAMES[day]);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(rule.days.includes(day)));
  button.setAttribute('aria-label', `${DAY_NAMES[day]} for window ${index + 1}`);
  button.addEventListener('click', () => {
    if (rule.days.includes(day)) rule.days = rule.days.filter((d) => d !== day);
    else rule.days = [...rule.days, day].sort((a, b) => a - b);
    button.setAttribute('aria-pressed', String(rule.days.includes(day)));
    markDirty();
  });
  return button;
}

function createCard(rule, index) {
  const node = el('article', 'rule-card');
  node.dataset.id = rule.id;
  const errorId = `rule-error-${index}`;

  const head = el('div', 'rule-head');
  head.append(el('h3', 'rule-title', `Window ${index + 1}`), el('span', 'rule-live', 'Active now'));
  const remove = el('button', 'rule-remove', 'Remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove window ${index + 1}`);
  remove.addEventListener('click', () => {
    draft.rules = draft.rules.filter((r) => r !== rule);
    markDirty();
    renderRules();
    $('add-rule').focus({ preventScroll: true });
  });
  head.append(remove);

  const days = el('div', 'days');
  days.setAttribute('role', 'group');
  days.setAttribute('aria-label', `Days for window ${index + 1}`);
  days.setAttribute('aria-describedby', errorId);
  DAY_NAMES.forEach((_, day) => days.append(dayChip(rule, day, index)));

  const times = el('div', 'time-row');
  const startInput = el('input');
  startInput.type = 'time';
  startInput.value = rule.start;
  startInput.setAttribute('aria-describedby', errorId);
  const startField = el('label', 'field');
  startField.append(el('span', 'field-label', 'Start'), startInput);
  const endInput = el('input');
  endInput.type = 'time';
  endInput.value = rule.end;
  endInput.setAttribute('aria-describedby', errorId);
  const endField = el('label', 'field');
  endField.append(el('span', 'field-label', 'End'), endInput);
  const sep = el('span', 'time-sep', '→');
  sep.setAttribute('aria-hidden', 'true');
  times.append(startField, sep, endField);
  const onTime = () => {
    rule.start = startInput.value;
    rule.end = endInput.value;
    markDirty();
  };
  startInput.addEventListener('input', onTime);
  endInput.addEventListener('input', onTime);

  const ampsRow = el('div', 'amps-row');
  const ampsInput = el('input', 'amps-input');
  ampsInput.type = 'number';
  ampsInput.min = String(MIN_AMPS);
  ampsInput.max = String(MAX_AMPS);
  ampsInput.step = '1';
  ampsInput.inputMode = 'numeric';
  ampsInput.value = Number.isFinite(rule.amps) ? String(rule.amps) : '';
  ampsInput.setAttribute('aria-label', `Current for window ${index + 1}`);
  ampsInput.setAttribute('aria-describedby', errorId);
  const step = (delta) => {
    const base = Number.isFinite(rule.amps) ? rule.amps : 32;
    rule.amps = Math.min(MAX_AMPS, Math.max(MIN_AMPS, Math.round(base) + delta));
    ampsInput.value = String(rule.amps);
    markDirty();
  };
  const minus = el('button', 'step', '−');
  minus.type = 'button';
  minus.setAttribute('aria-label', `Decrease current for window ${index + 1}`);
  minus.addEventListener('click', () => step(-1));
  const plus = el('button', 'step', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', `Increase current for window ${index + 1}`);
  plus.addEventListener('click', () => step(1));
  ampsInput.addEventListener('input', () => {
    rule.amps = ampsInput.value === '' ? Number.NaN : Number(ampsInput.value);
    markDirty();
  });
  const stepper = el('div', 'stepper');
  stepper.append(minus, ampsInput, el('span', 'stepper-unit', 'A'), plus);
  ampsRow.append(el('span', 'field-label', 'Current'), stepper);

  const errorEl = el('p', 'rule-error');
  errorEl.id = errorId;
  errorEl.hidden = true;

  node.append(head, days, times, ampsRow, errorEl);
  return { rule, node, daysEl: days, startInput, endInput, ampsInput, stepper, errorEl };
}

function renderRules() {
  const list = $('rule-list');
  list.replaceChildren();
  cards = draft.rules.map((rule, index) => {
    const card = createCard(rule, index);
    list.append(card.node);
    return card;
  });
  $('schedule-empty').hidden = draft.rules.length > 0;
  $('schedule-count').textContent = `${draft.rules.length} of ${MAX_RULES}`;
  validateAndPaint();
}

function renderLive() {
  const wrap = $('schedule-live');
  if (!wrap) return;
  wrap.hidden = !live.inWindow || !initialized;
  // Resolve the banner from the last server snapshot, never the draft: a
  // changed start time is not the charger's active window until Save lands.
  const rule = live.activeRuleId
    ? confirmed.rules.find((r) => r && r.id === live.activeRuleId)
    : null;
  setText(
    $('schedule-live-text'),
    rule ? `Window active now · ${rule.start}–${rule.end}` : 'Window active now',
  );
  for (const card of cards) {
    const isActive = Boolean(live.inWindow && live.activeRuleId === card.rule.id);
    card.node.classList.toggle('active', isActive);
    card.node.querySelector('.rule-live').hidden = !isActive;
  }
}

function renderToggle() {
  const toggle = $('schedule-enabled');
  toggle.checked = draft.enabled;
  setText($('schedule-enabled-sub'), toggleNote(draft));
}

function renderLoading() {
  $('schedule-loading').hidden = loadError;
  $('schedule-load-error').hidden = !loadError;
  $('schedule-editor').hidden = !initialized;
  $('schedule-live').hidden = true;
  renderRemoteNotice();
  if (loadError) {
    setText($('schedule-feedback'), "Couldn't load the schedule. Reload the page to try again.");
    $('schedule-feedback').className = 'feedback err';
  }
}

function renderAll() {
  $('schedule-loading').hidden = initialized || loadError;
  $('schedule-load-error').hidden = !loadError;
  $('schedule-editor').hidden = !initialized;
  if (!initialized) {
    setText($('schedule-feedback'), '');
    $('schedule-feedback').className = 'feedback';
    renderRemoteNotice();
    return;
  }
  renderToggle();
  renderRules();
  renderLive();
}

function adopt(schedule) {
  // clone() normalizes the editable shape and drops server metadata such as
  // timestamps, so snapshots and local payloads share one representation.
  confirmed = clone(schedule);
  draft = clone(confirmed);
  dirty = false;
  pendingRemote = null;
  remoteNotice = '';
  initialized = true;
  loadError = false;
  feedbackMode = 'derived';
  renderAll();
}

// The browser's view of connectivity. Offline is no longer a reason to refuse a
// save: Firestore's persistent queue holds the write, and the UI says so.
function online() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

// Snapshot the editable fields. A later edit must not change what an outstanding
// write compares against, so the payload is copied at issue time; store's
// saveSchedule still owns the exact document shape that reaches the rules.
function payloadFrom(schedule) {
  return {
    enabled: schedule.enabled,
    rules: schedule.rules.map((rule) => ({
      id: rule.id,
      days: rule.days,
      start: rule.start,
      end: rule.end,
      amps: rule.amps,
    })),
  };
}

function settleSave({ gen, token, payload, editGen, ok }) {
  if (gen !== generation || token !== saveToken) return;
  // A settle adopts the server snapshot only when the user has not touched the
  // form since the save was issued. Comparing payloads would treat an exact
  // revert to the pre-save baseline as "unchanged" and let the queued echo
  // overwrite the user's explicit revert.
  const editedSinceSave = editGen !== editGeneration;
  // A queued or unconfirmed write was released to the user; a failure must hand
  // their edits back rather than discard them, and its copy says so.
  const late = queued || savingUnconfirmed;
  saving = false;
  savingUnconfirmed = false;
  queued = false;
  queuedFromSnapshot = false;
  savingPayloadKey = null;
  // A snapshot that arrived while saving is at least as new as this write (the
  // client stream is ordered); otherwise our payload is the baseline.
  const result = reconcileAfterSave({ confirmed, payload, pendingRemote, ok });
  confirmed = result.baseline;
  pendingRemote = null;
  remoteNotice = '';
  // A late failure always keeps the draft, even untouched: the user was handed
  // the editor back, and a write that failed must not dismiss what they typed.
  if (editedSinceSave || (late && !ok)) {
    dirty = scheduleKey(draft) !== scheduleKey(confirmed);
    if (!ok) {
      saveError = late
        ? "Couldn't save — your changes are still here. Try saving again."
        : result.error;
    }
    // A successful settle with a newer draft must not claim "Saved." for edits
    // this write never carried; the helper reports the previous change instead.
    feedbackMode = ok ? 'saved' : 'derived';
    validateAndPaint();
    return;
  }
  draft = clone(confirmed);
  dirty = false;
  if (ok) {
    saveError = '';
    feedbackMode = 'saved';
  } else {
    saveError = result.error;
    feedbackMode = 'derived';
  }
  renderAll();
  if (!ok) $('schedule-feedback').focus({ preventScroll: true });
}

// Hand one payload to Firestore. While offline the SDK keeps it in its durable
// local queue, so the editor is released at once with the queued state instead
// of being held on a promise that only settles when the backend acknowledges.
// settleWrite bounds the online wait and still reports a late settle by calling
// settleSave, which reconciles against the latest server snapshot.
async function issueWrite(payload, { discarded = false } = {}) {
  const gen = generation;
  const token = ++saveToken;
  const editGen = editGeneration;
  const payloadKey = scheduleKey(payload);
  // A write issued here owns the state from now on: the reload baseline is only
  // meaningful for a write this page never issued.
  clearDiscardBaseline();
  saving = true;
  savingUnconfirmed = false;
  queued = false;
  queuedFromSnapshot = false;
  savingPayloadKey = payloadKey;
  saveError = '';
  feedbackMode = discarded ? 'discarded' : 'derived';
  if (!online()) {
    saving = false;
    queued = true;
  }
  dirty = scheduleKey(draft) !== acceptedKey();
  validateAndPaint();
  const outcome = await settleWrite(saveSchedule(payload), {
    onLate: (late) => settleSave({ gen, token, payload, editGen, ok: late.status === 'ok' }),
  });
  if (gen !== generation || token !== saveToken) return;
  if (outcome.status === 'timeout') {
    // The settle can land on the same tick the deadline fires; settleSave has
    // already cleared the payload key in that case.
    if (savingPayloadKey !== payloadKey) return;
    // Past the deadline the write is still unacknowledged: keep a write that was
    // already known to be queued labelled that way (the connection returning
    // does not mean it landed), and give a browser that claims to have been
    // online all along the explicit unconfirmed state. The onLate handler still
    // reconciles the real outcome.
    saving = false;
    queued = queued || !online();
    savingUnconfirmed = !queued;
    validateAndPaint();
    return;
  }
  settleSave({ gen, token, payload, editGen, ok: outcome.status === 'ok' });
}

function save() {
  if (saving || loadError || !saveValid() || !dirty || !initialized) return;
  return issueWrite(payloadFrom(draft));
}

// Discard reverts the draft to the schedule the next write should restore. With
// a write still queued, dropping the draft alone would let that change commit
// behind the UI, so the revert is queued too; Firestore replays it after the
// earlier write. After a reload the confirmed snapshot *is* the queued payload,
// so only the server baseline fetched for this state is a truthful revert.
function discard() {
  if (saving || loadError || !initialized) return;
  const state = saveState();
  if (!state.canDiscard || !state.discardBaseline) return;
  const outstanding = queued || savingUnconfirmed;
  const baseline = state.discardBaseline;
  draft = clone(baseline);
  dirty = false;
  saveError = '';
  // The draft no longer holds the edits the notice described: a reverted-queued
  // notice ("your edits are still here") or an overwrite warning would now
  // contradict the form. Discard's own feedback is the only message.
  remoteNotice = '';
  feedbackMode = 'derived';
  // The draft was replaced wholesale: rebuild the fields so they show the
  // reverted schedule (an edit-only repaint would leave the old values there).
  renderRules();
  if (!outstanding) return;
  return issueWrite(payloadFrom(baseline), { discarded: true });
}

// Connection lost while a write is in flight: the SDK has moved it to its
// queue, so release the editor and say it is queued.
function handleOffline() {
  if (!active || !initialized) return;
  if (saving || savingUnconfirmed) {
    saving = false;
    savingUnconfirmed = false;
    queued = true;
    queuedFromSnapshot = false;
    // The released write is now the draft's baseline: it is no longer "unsaved"
    // unless the user typed something newer after the editor unlocked.
    dirty = scheduleKey(draft) !== acceptedKey();
  }
  validateAndPaint();
}

function handleOnline() {
  if (!active || !initialized) return;
  // Stay queued until the write actually settles; this only refreshes copy that
  // depends on connectivity. A baseline read refused while offline gets its
  // chance here with a fresh retry budget, which is what re-enables Discard
  // after a reconnect.
  if (queued && queuedFromSnapshot) startDiscardBaseline({ fresh: true });
  validateAndPaint();
}

// ---------- screen lifecycle ----------

export function initSchedule() {
  $('schedule-enabled').addEventListener('change', () => {
    draft.enabled = $('schedule-enabled').checked;
    markDirty();
    setText($('schedule-enabled-sub'), toggleNote(draft));
  });
  $('add-rule').addEventListener('click', () => {
    if (draft.rules.length >= MAX_RULES) return;
    draft.rules.push(defaultRule(crypto.randomUUID()));
    markDirty();
    renderRules();
    const last = cards[cards.length - 1];
    if (last) {
      last.node.scrollIntoView({
        block: 'center',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      const firstDay = last.daysEl.querySelector('.day');
      if (firstDay) firstDay.focus({ preventScroll: true });
    }
  });
  $('save-schedule').addEventListener('click', save);
  $('discard-schedule').addEventListener('click', discard);
  addEventListener('offline', handleOffline);
  addEventListener('online', handleOnline);
  renderAll();
}

export function enterSchedule() {
  active = true;
}

export function activateSchedule() {
  if (!active) return;
  renderLive();
}

// Apply the queued-state transition decided by `reloadQueuedState`. Entering
// the queued state only relabels the save bar (the draft already matches the
// payload); leaving it never replaces the draft unless the helper allowed the
// reverted snapshot to be adopted.
function applyQueueTransition(transition, incoming) {
  if (transition.outcome === 'queued') {
    queued = true;
    queuedFromSnapshot = true;
    savingPayloadKey = transition.payloadKey;
    // The draft was built from the same cached snapshot, so it is not "unsaved"
    // against the queued payload unless the user typed something newer.
    dirty = scheduleKey(draft) !== acceptedKey();
    pendingRemote = null;
    // Discard needs the pre-write server copy; the read starts with the state
    // and never blocks the paint (it shows "checking" until it answers). A
    // changed payload is a new baseline: a copy read for the previous payload is
    // invalidated and the retry budget starts fresh.
    startDiscardBaseline({ fresh: true });
    validateAndPaint();
    return;
  }
  if (transition.outcome !== 'acked' && transition.outcome !== 'reverted') return;
  queued = false;
  queuedFromSnapshot = false;
  savingPayloadKey = null;
  pendingRemote = null;
  clearDiscardBaseline();
  if (transition.outcome === 'acked') {
    // The queued write landed: server truth is the payload the draft already
    // shows, so only the label changes. A newer draft is reported as such by
    // queuedSaveState instead of claiming it was saved.
    confirmed = incoming;
    dirty = scheduleKey(draft) !== scheduleKey(confirmed);
    feedbackMode = 'saved';
    validateAndPaint();
    return;
  }
  // The queued change did not land. Adopt the server's copy only for a clean
  // draft; a dirty draft is never clobbered, it just gains the notice.
  if (transition.adopt) {
    adopt(incoming);
    remoteNotice = REVERTED_NOTICE;
    renderRemoteNotice();
    return;
  }
  confirmed = incoming;
  dirty = scheduleKey(draft) !== scheduleKey(confirmed);
  remoteNotice = REVERTED_DIRTY_NOTICE;
  feedbackMode = 'derived';
  validateAndPaint();
}

// schedule/current — first snapshot adopts; later ones never clobber edits.
// `meta.pendingWrites` marks a write still queued in the persistent cache; after
// a reload it is the only evidence that the cached document is not server truth.
// `routeScheduleSnapshot` owns the branch order; this only applies its decision.
export function showSchedule(data, meta) {
  if (!active) return;
  const incoming = clone(data);
  const pendingWrites = meta ? meta.pendingWrites : undefined;
  const route = routeScheduleSnapshot({
    initialized,
    saving,
    savingUnconfirmed,
    queued,
    queuedFromSnapshot,
    dirty,
    confirmed,
    draft,
    incoming,
    pendingWrites,
    payloadKey: savingPayloadKey,
  });
  switch (route.kind) {
    case 'initial':
      adopt(incoming);
      // The cached document can itself be a still-queued write. adopt() builds
      // the form; this only relabels the save bar, so focus and scroll are
      // untouched.
      applyQueueTransition(route.transition, incoming);
      return;
    case 'in-flight':
      // Queue the latest snapshot (including the local write echo). Save settle
      // decides whether it becomes the confirmed baseline; the draft is
      // untouched, and a queued echo must not replace the confirmed rollback
      // baseline.
      pendingRemote = incoming;
      if (route.remoteChange !== null) {
        remoteNotice = route.remoteChange ? REMOTE_NOTICE : '';
      }
      validateAndPaint();
      return;
    case 'transition':
      applyQueueTransition(route.transition, incoming);
      return;
    case 'queued-still':
      // Still queued on the same payload (or metadata absent): nothing changed.
      return;
    case 'dirty': {
      const result = route.reconcile;
      confirmed = result.confirmed;
      dirty = result.dirty;
      // A metadata-only repeat (an ack, a fromCache flip) must not erase the
      // notice explaining the last real change.
      if (!result.metadataOnly) remoteNotice = result.remoteNotice ? REMOTE_NOTICE : '';
      pendingRemote = null;
      validateAndPaint();
      return;
    }
    case 'repeat':
      // Data-identical repeat (a metadata change or a redundant echo): refresh
      // the normalized baseline without rebuilding the form, and keep both
      // "Saved." and any notice about the last real change in place.
      confirmed = incoming;
      pendingRemote = null;
      return;
    default:
      // Clean form and a genuinely new server state: adopt it (and clear
      // "Saved.").
      adopt(incoming);
  }
}

export function showScheduleError() {
  if (!active) return;
  loadError = true;
  if (!initialized) {
    renderLoading();
  } else {
    feedbackMode = 'load-error';
    renderAll();
  }
}

// status/current — the charger's own live window report.
export function showLiveStatus(data) {
  if (!active) return;
  const info = data && data.schedule;
  live = {
    inWindow: Boolean(info && info.in_window === true),
    activeRuleId: info && typeof info.active_rule_id === 'string' ? info.active_rule_id : null,
  };
  renderLive();
}

export function resetSchedule() {
  generation += 1;
  active = false;
  initialized = false;
  loadError = false;
  confirmed = defaultSchedule();
  draft = defaultSchedule();
  dirty = false;
  saving = false;
  queued = false;
  queuedFromSnapshot = false;
  savingPayloadKey = null;
  pendingRemote = null;
  remoteNotice = '';
  clearDiscardBaseline();
  validation = validateSchedule(defaultSchedule());
  feedbackMode = 'derived';
  saveError = '';
  savingUnconfirmed = false;
  saveToken += 1;
  live = { inWindow: false, activeRuleId: null };
  cards = [];
  if ($('rule-list')) {
    $('panel-schedule').setAttribute('aria-busy', 'false');
    $('rule-list').replaceChildren();
    $('schedule-empty').hidden = false;
    $('schedule-count').textContent = `0 of ${MAX_RULES}`;
    $('schedule-doc-error').hidden = true;
    $('schedule-feedback').className = 'feedback';
    setText($('schedule-feedback'), '');
    $('schedule-live').hidden = true;
    $('schedule-editor').hidden = true;
    $('schedule-loading').hidden = false;
    $('schedule-load-error').hidden = true;
    renderRemoteNotice();
    setText($('schedule-enabled-sub'), toggleNote(defaultSchedule()));
    $('schedule-enabled').checked = false;
    $('discard-schedule').disabled = true;
    $('discard-schedule').removeAttribute('title');
    $('save-schedule').disabled = true;
  }
}
