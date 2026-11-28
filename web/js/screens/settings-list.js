// The Settings list's card states (#228): the copy is derived in
// js/settings-list.js from the snapshots app.js fans out; this only writes it
// into the list's four state lines. A later snapshot replaces an earlier
// failure's line, so no clear call is needed.

import { $, setText } from '../ui.js';
import {
  LIST_LOADING,
  chargerListState,
  notificationsListState,
  pricesListState,
  scheduleListState,
} from '../settings-list.js';

const CARDS = ['schedule', 'prices', 'notifications', 'charger'];

function paint(route, view) {
  const node = $(`settings-state-${route}`);
  setText(node, view.text);
  // An empty tone removes the attribute: a card that asked for attention and
  // recovered must not keep its warning colour.
  if (view.tone) node.dataset.tone = view.tone;
  else delete node.dataset.tone;
}

export function showListSchedule(data, meta) {
  paint('schedule', scheduleListState({ data, meta }));
}

export function showListScheduleError() {
  paint('schedule', scheduleListState({ error: true }));
}

export function showListSettings(settings, meta) {
  paint('prices', pricesListState({ data: settings, meta }));
}

export function showListSettingsError() {
  paint('prices', pricesListState({ error: true }));
}

// `state` is what the notification card's own render derived: `{ kind,
// tokenPhase }`. Nothing arrives here from a document — the card is this
// browser's permission and registration — so app.js hands it the card's.
export function showListNotifications(state) {
  paint('notifications', notificationsListState(state));
}

export function showListConfig(config) {
  paint('charger', chargerListState({ data: config }));
}

export function showListConfigError() {
  paint('charger', chargerListState({ error: true }));
}

// Sign-out: no account is signed in, so there is no saved data to show.
export function resetSettingsList() {
  for (const route of CARDS) paint(route, { text: LIST_LOADING, tone: '' });
}
