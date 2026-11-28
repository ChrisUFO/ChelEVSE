// The Settings list's card states (#228): the one line under each card's
// title. Each is derived from a snapshot app.js already fans out to the screen
// the card opens, so the list needs no subscription of its own, and each reads
// saved data only — never a draft — so a card says what is stored, not what an
// open editor is about to save. Pure: no DOM, no Firebase; covered by
// test/web.
//
// Every state is `{ text, tone }`. `tone` is '' for a plain line, 'on' for an
// enabled switch, and 'warn' / 'err' when the card asks for attention.

import { fmtRate } from './format.js';
import { syncedLabel } from './config.js';
import { normalizeSchedule, scheduleSaveValid } from './schedule.js';
import { validateRateWindows } from './rates.js';
import {
  normalizeSettings,
  rateEditorMode,
  ratePeriods,
  ratePlanRange,
  settingsSnapshotIsBaseline,
} from './settings.js';

const state = (text, tone = '') => ({ text, tone });

// The resting state before anything has arrived for a card, and the one every
// failed read shares: the card's own title names what could not be loaded.
export const LIST_LOADING = 'Loading…';
const COULDNT_LOAD = 'Couldn’t load';

// schedule/current. `data` is the snapshot's data (null: no document) and
// `meta` its metadata. A write still queued in the local cache is not saved
// yet, so the line says so rather than claiming the queued payload as stored;
// the editor labels the same state "Queued — will save when online.".
export function scheduleListState({ data, meta, error = false } = {}) {
  if (error) return state(COULDNT_LOAD, 'err');
  if (data === undefined) return state(LIST_LOADING);
  const schedule = normalizeSchedule(data);
  // A malformed stored container is not "off": the bridge skips it and leaves
  // the charger's own firmware schedule untouched, exactly as the editor's
  // toggle note says.
  if (schedule.malformed) return state('Needs attention', 'warn');
  // An enabled schedule the editor would not save is not advertised as on.
  // The bridge drops every window it cannot use — applying the rest, or with
  // none usable leaving the charger's firmware schedule untouched, as for a
  // malformed container — so the stored windows are not what is in force,
  // and the editor shows what to fix. A disabled schedule stays "Off"
  // whatever its windows: the bridge applies the clear.
  if (schedule.enabled && !scheduleSaveValid(schedule)) {
    return state('Needs attention', 'warn');
  }
  const count = schedule.rules.length;
  const text = schedule.enabled ? `On · ${count} ${count === 1 ? 'window' : 'windows'}` : 'Off';
  return meta && meta.pendingWrites
    ? state(`${text} · waiting to save`, 'warn')
    : state(text, schedule.enabled ? 'on' : '');
}

// settings/current. `meta` is the snapshot's provenance: a cached snapshot
// that reports no document is the local cache answering before the server, not
// evidence of an empty account. The form's own save gate reads it the same way
// (settingsSnapshotIsBaseline), so the card cannot call an account empty while
// the form is still holding its save. A pending write is a payload the server
// has not acknowledged — the listener asks for metadata changes, so it arrives
// before the answer — and gets the schedule card's line.
export function pricesListState({ data, meta, error = false } = {}) {
  if (error) return state(COULDNT_LOAD, 'err');
  if (data === undefined || !settingsSnapshotIsBaseline(data, meta)) {
    return state(LIST_LOADING);
  }
  if (data === null) return state('No prices saved yet');
  const stored = normalizeSettings(data);
  // A document without a usable rate and currency is nothing the form could
  // re-send whole; the editor shows it with its errors.
  if (!stored) return state('Needs attention', 'warn');
  const saved =
    rateEditorMode(stored.rates) === 'flat'
      ? state(`One rate · ${fmtRate(stored.rate, stored.currency)} per kWh`)
      : planState(stored);
  // Attention outranks the queue, as on the schedule card: a plan the editor
  // would flag needs fixing whatever became of the write.
  if (!saved.tone && meta && meta.pendingWrites) {
    return state(`${saved.text} · waiting to save`, 'warn');
  }
  return saved;
}

// The plan summary's own range, so the card is a prefix of what the Prices
// screen says. A stored plan the editor would flag — an incomplete row, an
// overlap, the cap — is not advertised as a price range: the card says it
// needs attention and the screen shows what to fix.
function planState(stored) {
  if (!validateRateWindows(stored.rates).valid) return state('Needs attention', 'warn');
  // A valid plan has at least one row and every row's rate is inside the
  // bounds rateIsUsable accepts, so the range always exists here.
  const range = ratePlanRange(stored.rates, stored.rate);
  const count = ratePeriods(stored.rates).length;
  // One currency for a range ("USD 0.10–0.32"), the price range's own rule.
  const price =
    range.min === range.max
      ? fmtRate(range.min, stored.currency)
      : `${fmtRate(range.min, stored.currency)}–${fmtRate(range.max, '')}`;
  return state(`${count} ${count === 1 ? 'season' : 'seasons'} · ${price} per kWh`);
}

// The notification card's state, in the words `notificationState` gives it
// (`kind`, with the token phase telling a registered device from one still
// registering). The card on the Notifications screen keeps the sentences; the
// list keeps the verdict.
export function notificationsListState({ kind = 'checking', tokenPhase = 'idle' } = {}) {
  switch (kind) {
    case 'checking':
      return state('Checking…');
    case 'unsupported':
      return state('Not available', 'warn');
    case 'no-vapid':
      return state('Not configured', 'warn');
    case 'denied':
      return state('Blocked', 'warn');
    // Permission granted but this device is not registered: not "on", however
    // granted the permission is.
    case 'attention':
      return state('Needs attention', 'warn');
    case 'granted':
      return tokenPhase === 'saved' ? state('On', 'on') : state('Turning on…');
    default:
      return state('Off');
  }
}

// status/config. The line is the Charger screen's own heading note, from the
// one syncedLabel, so the two can never disagree; a snapshot without a usable
// timestamp shows no line.
export function chargerListState({ data, error = false } = {}) {
  if (error) return state(COULDNT_LOAD, 'err');
  if (data === undefined) return state(LIST_LOADING);
  const snapshot = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  if (!snapshot) return state('Not reported yet');
  return state(syncedLabel(snapshot));
}
