// Rate-editor validation and the settings save lifecycle: submit gating, the
// Firestore payload, draft comparison and save-state messages. Pure helpers —
// no DOM, no Firebase. Covered by test/web.

import {
  MAX_RATE_WINDOWS,
  isBaseWindow,
  monthsCovering,
  normalizeWindow,
  overlappingWindowPairs,
  parseRateValue,
  rateWindowsKey,
  seasonScope,
  validateRateWindows,
} from '../rates.js';
import { rateScopeText, windowLabel } from './plan.js';
import {
  normalizeSettings,
  settingsFields,
  validateChargerHost,
  validateSettings,
} from './validate.js';

// The rate table's validation. The old editor could only express one month
// range, so a valid non-contiguous list was flagged; the month chips can now
// show any set, so the shared window rules are the whole rulebook again.
export const RATE_CAP_MESSAGE = `A rate schedule can hold at most ${MAX_RATE_WINDOWS} windows.`;
// The remedy belongs to the cap alone: an over-cap plan is fixed by removing
// windows, and telling the owner to separate a pair of colliding windows would
// leave the count over the limit.
export const RATE_CAP_REMEDY = `Remove a window to get back to ${MAX_RATE_WINDOWS}.`;

export function validateRateEditorRows(rows, fallbackRate) {
  const base = validateRateWindows(rows);
  const list = Array.isArray(rows) ? rows : [];
  const rowErrors = base.errors.rows.map((errors) => ({ ...errors }));
  const overlaps = overlappingWindowPairs(list);
  const bases = list.map((row) => isBaseWindow(row));
  const capped = list.length > MAX_RATE_WINDOWS;
  const general = [];
  // A plan over the cap gets one cap-only message and the cap remedy. The
  // overlap clauses are withheld here because their remedy ("change one of
  // them") would not bring the plan back under the cap; the rows still carry
  // their own overlap notes, so nothing is hidden.
  if (capped) general.push(RATE_CAP_MESSAGE, RATE_CAP_REMEDY);
  else if (overlaps.length > 0) general.push(rateOverlapMessage(overlaps, list, fallbackRate));
  const valid = rowErrors.every((errors) => Object.keys(errors).length === 0);
  return {
    valid: valid && general.length === 0,
    general,
    rows: rowErrors,
    overlaps,
    bases,
    capped,
  };
}

// One document-level sentence naming both rows in every collision. Months are
// omitted when both rows share them (the period header already says so), and
// genuinely identical rows collapse to a single clause instead of repeating the
// same long name with an ordinal.
export function rateOverlapMessage(pairs, rows, fallbackRate) {
  const list = Array.isArray(rows) ? rows : [];
  const rates = list.map((row) => row && row.rate);
  const scopeText = list.map((row) => rateScopeText(row));
  const clauses = [];
  for (const [a, b] of Array.isArray(pairs) ? pairs : []) {
    const sameScope = scopeText[a] === scopeText[b];
    const label = (index) =>
      list[index]
        ? windowLabel(list[index], rates, fallbackRate, { months: !sameScope })
        : `Window ${index + 1}`;
    const left = label(a);
    const right = label(b);
    if (isBaseWindow(list[a]) && isBaseWindow(list[b])) {
      clauses.push(
        `“${left}” and “${right}” are both base rates and cover some of the same dates. Keep one base per date`,
      );
    } else {
      clauses.push(
        left === right ? `Two windows are identical: “${left}”` : `“${left}” overlaps “${right}”`,
      );
    }
  }
  const baseOnly = (Array.isArray(pairs) ? pairs : []).every(
    ([a, b]) => isBaseWindow(list[a]) && isBaseWindow(list[b]),
  );
  return baseOnly
    ? `${clauses.join('; ')}.`
    : `${clauses.join('; ')}. Change one of them so no moment has two rates.`;
}

// How many rows the edit has to fix. Counts affected rows (not collision
// pairs), so the plan summary, a period badge and the save row all agree.
// A plan over the cap has no row to blame: the cap counts once, and only when
// no row is already flagged. Counting it alongside flagged rows would put a
// number on the plan row that no period badge carries, and those same row
// edits are what brings the plan back under the cap.
export function validationProblemCount(validation, rowCount = 0) {
  if (!validation) return 0;
  const affected = new Set();
  (validation.rows || []).forEach((errors, index) => {
    if (errors && Object.keys(errors).length > 0) affected.add(index);
  });
  for (const [a, b] of validation.overlaps || []) {
    affected.add(a);
    affected.add(b);
  }
  const capped = rowCount > MAX_RATE_WINDOWS;
  return affected.size + (capped && affected.size === 0 ? 1 : 0);
}

// The plan row and the save row share this text. `cap` labels the one count
// that has no period badge of its own, so the numbers on screen never disagree
// about what is left to fix.
export function planProblemText({ problems = 0, capped = false } = {}) {
  if (problems <= 0) return '';
  return capped ? `${problems} to fix · cap` : `${problems} to fix`;
}

// Save's visible and accessible state. A plan with blockers keeps the button
// submit-capable: it is the form's only submit button, so disabling it would
// swallow Enter and with it the jump to the first problem. `blocked` styles it
// and marks it aria-disabled while the submit path stays live.
export function saveButtonState({ canSave = false, saving = false, problems = 0 } = {}) {
  const blocked = problems > 0;
  const label = (saving && 'Saving…') || (blocked && `Fix ${problems} to save`) || 'Save settings';
  return {
    disabled: !canSave,
    blocked,
    label,
    describedBy: blocked ? 'save-blockers' : '',
  };
}

// What a blocked submit leaves in the save row. Short on purpose: the row shares
// its width with the count chip and Save, so a full sentence stacks into a list
// of fragments at 320 px.
export const BLOCKED_SAVE_MESSAGE = 'Fix the highlighted fields.';

// The first problem a blocked submit must reveal. Field errors come first (they
// sit above the plan and carry their own message), then the first row with a
// field error, then the first row an overlap names. `doc` is a blocker with no
// row of its own — the window cap — and lands on the first row so the user is
// in the table that fixes it. `save` means nothing blocks the write.
export function submitFocusTarget({ errors = {}, rateValidation } = {}) {
  if (errors.rate) return { kind: 'field', field: 'rate' };
  if (errors.currency) return { kind: 'field', field: 'currency' };
  if (errors.chargerHost) return { kind: 'field', field: 'chargerHost' };
  const rows = (rateValidation && rateValidation.rows) || [];
  const index = rows.findIndex((row) => row && Object.keys(row).length > 0);
  if (index >= 0) {
    const row = rows[index];
    const isBase = Boolean(rateValidation && rateValidation.bases && rateValidation.bases[index]);
    const focus =
      row.from || row.to
        ? 'dates'
        : row.months
          ? 'months'
          : row.rate
            ? isBase
              ? 'base-rate'
              : 'rate'
            : row.days
              ? 'days'
              : row.start
                ? 'start'
                : row.end
                  ? 'end'
                  : isBase
                    ? 'base-rate'
                    : 'rate';
    return { kind: 'row', index, focus };
  }
  const overlaps = (rateValidation && rateValidation.overlaps) || [];
  if (overlaps.length > 0) return { kind: 'row', index: overlaps[0][0], focus: 'rate' };
  if (rateValidation && rateValidation.valid === false) return { kind: 'doc' };
  return { kind: 'save' };
}

// The form's submit gate, extracted from the screen so the keyboard recovery
// path is testable without a DOM. A blocked plan never reaches `onCommit` — the
// screen's only route to the persistence layer — and the returned target is what
// it reveals and focuses.
export function submitSettingsPlan({ fields, onCommit = () => {} } = {}) {
  const result = validateSettings(fields);
  const rateValidation = validateRateEditorRows(fields.rates, fields.rate);
  const blocked = !result.valid || !rateValidation.valid;
  const target = blocked
    ? submitFocusTarget({ errors: result.errors, rateValidation })
    : { kind: 'save' };
  if (!blocked) onCommit(result.values);
  return {
    blocked,
    errors: result.errors,
    values: result.values,
    rateValidation,
    message: blocked ? BLOCKED_SAVE_MESSAGE : '',
    target,
  };
}

// A definitive checker answer is withheld while the plan has anything blocking:
// the invalid row would otherwise be dropped and a price claimed for a moment
// it may actually price. The remedy names the cause: an unpriced row
// needs a price, not its windows repaired.
export const CHECK_BLOCKED_MESSAGE = 'Fix the incomplete windows to check this moment.';
export const CHECK_RATE_MESSAGE = 'Add a rate to check this moment.';
export const CHECK_CONFLICT_MESSAGE = 'Fix the overlapping windows to check this moment.';
export const CHECK_CAP_MESSAGE = `Reduce the plan to ${MAX_RATE_WINDOWS} windows to check this moment.`;

export function previewBlocker(validation) {
  if (!validation || validation.valid !== false) return '';
  const incomplete = (validation.rows || []).filter(
    (errors) => errors && Object.keys(errors).length > 0,
  );
  if (incomplete.length > 0) {
    // A row whose only problem is its price has no incomplete window to fix:
    // telling the owner to repair a window that is fine sends them to the wrong
    // field.
    const unpricedOnly = incomplete.every((errors) =>
      Object.keys(errors).every((field) => field === 'rate'),
    );
    return unpricedOnly ? CHECK_RATE_MESSAGE : CHECK_BLOCKED_MESSAGE;
  }
  // A plan over the cap has no overlap to fix: naming the cap keeps the
  // checker from accusing windows that are fine.
  if (validation.capped) return CHECK_CAP_MESSAGE;
  return CHECK_CONFLICT_MESSAGE;
}

// The exact Firestore payload for a validated settings save. `rates` is omitted
// when empty, so a flat configuration writes byte-for-byte the two fields it
// always has. `charger_host` is omitted the same way: absent means "use the
// bridge's bootstrap", so clearing the field removes the key. `show_temperature`
// is omitted when true — absent already means visible — so a visible toggle
// never adds a key, and only a stored `false` (which the form always carries)
// reaches the document. A month row keeps its stored key order; a date row
// appends `from`/`to` after `months`, whose value is the derived compatibility
// hint.
export function settingsPayload(values) {
  const source = values || {};
  const payload = { rate: source.rate, currency: source.currency };
  const rates = Array.isArray(source.rates) ? source.rates : [];
  if (rates.length > 0) {
    payload.rates = rates.map((row) => {
      const window = normalizeWindow(row);
      const scope = seasonScope(window);
      if (scope.kind === 'dates') {
        return {
          id: window.id,
          rate: window.rate,
          days: window.days,
          start: window.start,
          end: window.end,
          months: monthsCovering(scope.from, scope.to),
          from: scope.from,
          to: scope.to,
        };
      }
      return {
        id: window.id,
        rate: window.rate,
        days: window.days,
        start: window.start,
        end: window.end,
        months: window.months,
      };
    });
  }
  // Only a value the grammar accepts is ever written: the payload must not be
  // able to carry something `firestore.rules` would refuse.
  const host = validateChargerHost(source.chargerHost).value;
  if (host) payload.charger_host = host;
  if (source.showTemperature === false) payload.show_temperature = false;
  return payload;
}

// ---------- draft comparison ----------

function parseCurrencyValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The form compares parsed values, never raw strings: a rate typed as "0.250"
// and a currency typed as " USD " are the same settings as the canonical
// rendering, so they must not read as unsaved forever. Two non-numeric drafts
// only match each other when their text is identical. Window rows compare
// through rateWindowsKey so day/month order and numeric text do not matter. The
// charger address is compared trimmed (the only normalization it has), so
// " 192.168.1.50 " matches "192.168.1.50" but an invalid value never compares
// equal to a blank one. The temperature toggle compares by its visible/hidden
// meaning, so an absent field (the default) matches an explicit true.
export function sameSettingsInput(a, b) {
  const left = a || {};
  const right = b || {};
  const rateLeft = parseRateValue(left.rate);
  const rateRight = parseRateValue(right.rate);
  const ratesMatch =
    Number.isNaN(rateLeft) || Number.isNaN(rateRight)
      ? String(left.rate ?? '').trim() === String(right.rate ?? '').trim()
      : rateLeft === rateRight;
  return (
    ratesMatch &&
    parseCurrencyValue(left.currency) === parseCurrencyValue(right.currency) &&
    rateWindowsKey(left.rates) === rateWindowsKey(right.rates) &&
    String(left.chargerHost ?? '').trim() === String(right.chargerHost ?? '').trim() &&
    (left.showTemperature !== false) === (right.showTemperature !== false)
  );
}

// Raw input fields against a stored settings document.
export function settingsDraftMatches(draft, settings) {
  return sameSettingsInput(draft, settingsFields(settings));
}

function settingsEqual(a, b) {
  const left = normalizeSettings(a);
  const right = normalizeSettings(b);
  if (!left || !right) return left === right;
  return (
    left.rate === right.rate &&
    left.currency === right.currency &&
    rateWindowsKey(left.rates) === rateWindowsKey(right.rates) &&
    left.charger_host === right.charger_host &&
    left.show_temperature === right.show_temperature
  );
}

// ---------- save-state machine ----------

export const OFFLINE_MESSAGE = 'You’re offline — reconnect to save.';
export const WAITING_MESSAGE = 'Waiting for the server — this change may not be saved yet.';
// No settings document has been read yet, so the blank form is not a baseline:
// the whole-document write would replace the stored plan with nothing.
export const LOADING_MESSAGE = 'Loading your settings…';
// The listener failed: the hold on Save has no natural end until the page is
// reloaded (a failed subscription does not retry), so the copy says so.
export const LOAD_FAILED_MESSAGE = 'Couldn’t read your settings. Reload the page to try again.';
export const SAVE_FAILED_MESSAGE =
  'Couldn’t save — the previous settings are back. Check your connection and try again.';
// A first-ever save has no previous document to restore, so the generic copy
// would describe a rollback that never happened.
export const SAVE_FAILED_FIRST_MESSAGE = 'Couldn’t save — try again.';

// Whether one settings snapshot can establish the save baseline. A snapshot that
// carries a document always can: it holds the stored values a whole-document
// write has to re-send. A snapshot that reports no document only can when the
// server answered — the local cache also answers "no document" before any read
// has reached the backend, and a save against that fiction would replace the
// stored rate plan and charger address with whatever this device typed.
export function settingsSnapshotIsBaseline(data, meta = {}) {
  if (data != null) return true;
  return !(meta && meta.fromCache === true);
}

// Whether a route change needs the unsaved-changes confirmation (#129). Only
// the settings form keeps unsaved state, so only leaving the Config tab
// with a dirty draft asks; every other route change applies immediately. The
// router owns the asking (it owns the hash); the screen owns the dialog.
export function settingsLeaveNeedsConfirm({ from = '', to = '', dirty = false } = {}) {
  return Boolean(dirty) && from === 'config' && to !== 'config';
}

// The card's whole visible state, derived from the draft and the flags the
// screen owns. `dirty` is computed and returned so the screen never has to keep
// a second, possibly divergent copy.
export function settingsSaveState({
  draft = { rate: '', currency: '', rates: [] },
  confirmed = null,
  loaded = true,
  saving = false,
  waiting = false,
  saved = false,
  error = '',
  offline = false,
} = {}) {
  const dirty = !settingsDraftMatches(draft, confirmed);
  let text = '';
  let kind = '';
  let busy = false;
  if (saving) {
    text = 'Saving…';
    busy = true;
  } else if (waiting) {
    // A refusal raised while an earlier write is still in flight explains more
    // than "waiting" and must stay visible: the offline copy says why this
    // retry did not start. The write itself is still running, so the retry
    // stays available and its late settlement still reconciles the form.
    text = error || WAITING_MESSAGE;
    kind = error ? 'err' : 'warn';
    busy = !error;
  } else if (error) {
    text = error;
    kind = 'err';
  } else if (saved && !dirty) {
    text = 'Saved.';
    kind = 'ok';
  } else if (!loaded) {
    // Hold the save path, don't just describe it: writing this form now would
    // replace the whole document with fields that only the owner's typing has
    // filled, deleting the stored rate plan and charger address.
    //
    // Offline with nothing read yet is not "still loading": the read cannot
    // finish until the connection returns, so name the cause instead of leaving
    // a loading hold that will never end on its own.
    text = offline ? OFFLINE_MESSAGE : LOADING_MESSAGE;
    kind = 'warn';
  } else if (dirty) {
    text = 'Unsaved changes.';
    kind = 'warn';
  }
  return {
    dirty,
    saved: saved && !dirty && !error,
    text,
    kind,
    busy,
    canSave: loaded && dirty && !saving,
  };
}

// Decide the post-settlement form state for one save. `draft` is what is in the
// inputs right now (a late settlement can land after the user typed again),
// `remote` is the snapshot observed while the write was in flight (`remoteSeen`
// distinguishes "none arrived" from "the document is missing").
export function reconcileSettingsSave({
  ok,
  values,
  previous = null,
  draft = { rate: '', currency: '', rates: [] },
  remote = null,
  remoteSeen = false,
} = {}) {
  const rates = Array.isArray(values.rates) ? values.rates : [];
  // The confirmed/attempted document is in stored shape (`charger_host`, absent
  // when the field was cleared; `show_temperature`, absent when the stat is
  // visible), exactly like a snapshot: every comparison below runs it through
  // settingsFields/normalizeSettings.
  const attempted = { rate: values.rate, currency: values.currency, rates };
  if (values.chargerHost) attempted.charger_host = values.chargerHost;
  if (values.showTemperature === false) attempted.show_temperature = false;
  const untouched = settingsDraftMatches(draft, attempted);
  const draftFields = {
    rate: String(draft.rate ?? ''),
    currency: String(draft.currency ?? ''),
    rates: Array.isArray(draft.rates) ? draft.rates : [],
    chargerHost: String(draft.chargerHost ?? ''),
    showTemperature: draft.showTemperature !== false,
  };

  if (ok) {
    // The write is confirmed; canonicalise the fields when only formatting
    // differs so the form is not left looking dirty after a successful save.
    let confirmed = attempted;
    let saved = untouched;
    let fields = untouched ? settingsFields(attempted) : draftFields;
    let dirty = !untouched;
    const snapshot = normalizeSettings(remote);
    if (snapshot && !settingsEqual(snapshot, confirmed)) {
      // A genuinely different snapshot arrived while the write was in flight;
      // adopt it rather than leave the form on our optimistic values.
      confirmed = snapshot;
      saved = false;
      // Only an untouched form is hydrated: a draft typed during the save wins.
      if (untouched) {
        fields = settingsFields(snapshot);
        dirty = false;
      }
    }
    return { confirmed, fields, dirty, saved, error: '' };
  }

  // Failure: roll back to the newest known server state — a snapshot that
  // arrived during the write outranks the baseline captured before it.
  const baseline = remoteSeen ? normalizeSettings(remote) : normalizeSettings(previous);
  if (!baseline) {
    // Nothing was ever confirmed (the account has no settings document): there
    // is no previous state to restore. Keep exactly what the user typed, stay
    // dirty, and leave Save available so the attempt can be repeated without
    // retyping both fields.
    return {
      confirmed: null,
      fields: draftFields,
      dirty: !settingsDraftMatches(draftFields, null),
      saved: false,
      error: SAVE_FAILED_FIRST_MESSAGE,
    };
  }
  const dirty = untouched ? false : !settingsDraftMatches(draft, baseline);
  return {
    confirmed: baseline,
    // Only an untouched form (or one whose draft already matches the baseline)
    // is hydrated; a typed draft is never overwritten.
    fields: untouched || !dirty ? settingsFields(baseline) : draftFields,
    dirty,
    saved: false,
    error: SAVE_FAILED_MESSAGE,
  };
}
