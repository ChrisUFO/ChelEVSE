// Status screen: live charger figures, command feedback, and the command-
// oriented pause/resume/set-current controls. All rendering and status-specific
// state lives here so the screen survives tab switches intact.

import { $, el, focusAfterRetry, focusFellAway, setText } from '../ui.js';
import {
  elapsedClock,
  fmtK,
  fmtRate,
  formatElapsed,
  freezeClock,
  freshnessState,
  holdAfterSnapshot,
  liveCharging,
  numOrDash,
  relTime,
  stateFor,
  toNumber,
} from '../format.js';
import {
  adoptedAnchor,
  costSettings,
  heldAnchorAfter,
  heldCostFallback,
  heldCostLabel,
  heldCostUncovered,
  statusCostFallback,
  statusCostLabel,
  statusCostUncovered,
} from '../cost.js';
import { retryStore, ackNotification, sendCommand as postCommand } from '../store.js';
import { currentCapability } from '../current.js';
import { ackControlState, createAckTracker, dismissControlState, healthState } from '../health.js';
import { createDismissalStore } from '../health-dismissals.js';
import { claimsState } from '../claims.js';
import { auth } from '../firebase.js';

const CMD_TEXT = {
  pause: { busy: () => 'Sending stop…', done: () => 'Stop command applied.' },
  resume: { busy: () => 'Sending auto…', done: () => 'Auto command applied.' },
  set_current: {
    busy: (a) => `Setting ${a} A…`,
    done: (a) => `Current set to ${a} A.`,
  },
};
// RAPI entries in the shared command feed must not disable these controls or
// replace their feedback with a generic "Done." Pending commands arrive from
// their own subscription, so RAPI volume cannot evict them from this view.
const CONTROL_TYPES = new Set(Object.keys(CMD_TEXT));

let status = null;
// The status listener failed. Kept apart from `status` because "no data yet"
// and "the read failed" must not render the same: the figures stay blank in
// both, but only this one owes the owner an error and a way back. Cleared by
// any snapshot, so recovery needs no other bookkeeping.
let statusError = false;
// status/notifications — the charger-health projection, kept apart from the
// listener's failure for the same reason: an absent document ("health unknown")
// and a failed read are different facts, and only the second owes a Retry.
let health = null;
let healthError = false;
let healthRetryRequested = false;
// status/claims — the one authoritative reason the charger is not charging
// (#159). Kept like `health`: the raw document, projected at render time by
// claimsState, never interpreted here. Null is a real answer (no confident
// reason), not a missing one.
let claims = null;
// What the advisory list currently shows, so a snapshot that only moves the
// document's write stamp does not rebuild the rows under a text selection.
let healthSignature = null;
// The last projection the card painted: the control repaint reads the same rows
// the list was built from.
let healthView = null;
// The acknowledgement controls themselves (`id → {button, message}`), so a
// busy row repaints in place instead of rebuilding the list under the pointer.
let ackNodes = new Map();
// The Dismiss controls (`id → button`, #205). They have no states to repaint,
// so the map exists for one thing: a rebuild destroys every row, and a control
// that still holds the owner's focus is owed the same hand-off an ack control
// is (`renderHealth`).
let dismissNodes = new Map();
// The row whose Dismiss control the owner just activated (#205). Its click
// handler re-renders synchronously, and that render is the only one that reads
// the flag — the control is about to be destroyed with its row — so unlike
// `ackFocusId` it can never outlive the attempt it describes.
let dismissFocusId = null;
// Until when a further pointer activation of a Dismiss control is taken for
// the second half of a double-click and ignored (#205). A dismissal rebuilds
// the list synchronously, so the next row's Dismiss slides under the pointer
// inside the same gesture: without this a double-click hides two advisories,
// the second by accident, with no way back but the manual reset. Only pointer
// activations are guarded. A keyboard or assistive one carries no click
// count, and the hand-off above has already taken focus to the card title, so
// it cannot land on the row that slid up.
const DISMISS_DOUBLE_CLICK_MS = 500;
let dismissGuardUntil = 0;
// The row whose control held the owner's focus when it was disabled. The browser
// blurs a control the instant it becomes unfocusable (HTML's focus fix-up rule,
// down to <body> here), so by the time the success rebuild runs
// `document.activeElement` no longer names it — this records the displacement
// where it happens. Whichever comes first then spends it and clears it: the
// rebuild (`renderHealth`, the row flipped) or the row's own repaint when the
// attempt ends there instead (a failure — `paintAckRow`). Only a live attempt
// may leave it set, so no later rebuild can read a finished attempt's flag as
// "my control was destroyed" and pull focus off whatever the owner is on.
let ackFocusId = null;
// The acknowledgement state machine (health.js, unit-tested): one click writes
// one command, the snapshot settles it, and every completion repaints only the
// row it belongs to.
const acks = createAckTracker({
  write: (id) => ackNotification(id),
  onChange: (id) => {
    if (!healthView) return;
    const row = healthView.advisories.find((candidate) => candidate.id === id);
    if (row) paintAckRow(row);
  },
});
// The account the Health card's dismissals are scoped to (#205): the same
// accessor screens/notifications.js reads, so the two cards cannot disagree
// about who is signed in. Empty signed out — and then nothing is read or
// written, because a record under no account would be every visitor's.
function currentUid() {
  return auth && auth.currentUser && typeof auth.currentUser.uid === 'string'
    ? auth.currentUser.uid
    : '';
}
// The reader the card asks; `initStatus` is where a different one can be handed
// in.
let accountUid = currentUid;
// Dismissal records: durable per-account state (localStorage, kept by the
// DOM-free store). Sign-out does not clear them — the next session of that
// account expects to find its rows still hidden.
const dismissals = createDismissalStore();
// Set when the owner activates Retry. The render that clears the failure hides
// the control that had their focus, so that render — and only a render a retry
// preceded — has to put focus somewhere useful. Any snapshot moves nothing.
let retryRequested = false;
let schedule = null;
// Full cost settings ({rate, currency, rates}); the schedule prices a session
// over its elapsed interval, and an instant no row matches costs the stored
// flat rate (#188) — 0.00 only when no finite flat rate is stored.
let settings = null;
let active = false;
let ampsTouched = false;
let holdOpen = false;
let holdAmps = 32;
let current = null;
let commandsBusy = false;
let ticker = null;
let resultTimer = null;
let shownResultId = null;
// Local receipt anchor for the session clock (see elapsedClock).
let clock = null;
// Value frozen when a stop command is sent, with the status write it belongs
// to; released only by a new status write or an explicit command failure.
let clockHold = null;
// The session cost's frozen anchor (see heldAnchorAfter): the last live
// charging write's `updated_at` and `elapsed`, captured on every charging
// write, held from the moment charging stops with session energy still on the
// meter, and cleared when the session resets or a new charge re-anchors. On a
// cold open — no charging write witnessed — the bridge's `charging_stopped_at`
// stamp reconstructs it (see adoptedAnchor, issue #122), so the completed
// session's $ survives a reload; a captured anchor always wins, and the
// adopted one is held exactly like a captured one, so later polls carrying the
// same stamp cannot move the figure.
let costAnchor = null;

function ageMs() {
  const ts = status && status.updated_at;
  return ts && typeof ts.toMillis === 'function' ? Date.now() - ts.toMillis() : Infinity;
}

function renderFreshness() {
  if (!status) {
    // A failed listener has nothing left to wait for: the error line speaks for
    // the screen, so the caption stands down instead of promising a snapshot
    // that is not coming. The pre-data screen is unchanged.
    setText($('updated'), statusError ? '' : 'waiting for data');
    $('banner').hidden = true;
    return;
  }
  const age = ageMs();
  setText($('updated'), Number.isFinite(age) ? `updated ${relTime(age)}` : 'updated unknown');
  const state = freshnessState({
    chargerOnline: status.charger_online,
    stateLabel: status.state_label,
    ageMs: age,
  });
  const banner = $('banner');
  banner.hidden = !state;
  // A bridge verdict on a charging snapshot is a missed 60 s heartbeat away
  // from fresh, so it says "not updating" rather than claiming the whole
  // bridge is down. A missing timestamp (non-finite age) keeps the plain
  // bridge banner: there is no age to soften the verdict with.
  const chargingStale =
    state === 'bridge' && status.state_label === 'charging' && Number.isFinite(age);
  setText(
    banner,
    state === 'charger'
      ? 'Charger offline — showing last known values'
      : chargingStale
        ? 'Not updating — showing last known values'
        : 'Bridge offline — showing last known values',
  );
}

// The listener's failure gets a line of its own rather than the freshness
// caption's slot: the caption is a claim about data that arrived, and this is
// the state where none did. One flag drives all three nodes on every render —
// the error and its Retry appear, the caption stands down — so a snapshot that
// arrives afterwards puts the screen back with no further bookkeeping.
const STATUS_FAILED = 'Couldn’t load the charger status.';

function renderStatusError() {
  const failed = statusError;
  const error = $('status-error');
  // Reveal, then write: a live region announces content inserted into a node it
  // can already expose, not a static line that was merely un-hidden — the order
  // #notify-error keeps.
  error.hidden = !failed;
  // Written on every render, '' included: a copy left in the hidden node would
  // come back on the next failure as a bare un-hide, which is the case this
  // order exists to avoid — #notify-error clears its line the same way.
  setText(error, failed ? STATUS_FAILED : '');
  const retry = $('status-retry');
  retry.hidden = !failed;
  $('updated').hidden = failed;
  // Recovery lands where the user was, not at the top of the page.
  if (!failed && retryRequested) {
    retryRequested = false;
    focusAfterRetry(retry, 'panel-status');
  }
}

// The snapshot carries elapsed seconds. The clock is anchored to the local
// receipt of the status write it belongs to, so it keeps ticking when this
// device's clock is behind Firestore and cannot rewind on schedule-only merges.
// A stop command freezes the displayed value until the charger reports a new
// status write, so the clock cannot overshoot and then snap back.
function renderElapsed() {
  const step = elapsedClock(clock, status, Date.now());
  clock = step.clock;
  const held = clockHold == null ? null : clockHold.value;
  setText($('elapsed'), formatElapsed(held == null ? step.seconds : held));
}

// Freeze the clock at the value currently on screen.
function freezeElapsed() {
  const step = elapsedClock(clock, status, Date.now());
  clock = step.clock;
  clockHold = freezeClock(step.seconds, status);
}

function renderCost() {
  // The session's cost owns its tile for the whole plug-in. While charging it
  // is the live interval, [updated_at - elapsed, updated_at]; once charging
  // stops with session energy still on the meter it freezes at the anchor
  // captured from the last charging write — or, on a cold open, the one
  // reconstructed from the bridge's charging_stopped_at stamp — so fresh
  // polls, and the bridge's offline markers, can never slide the rate window
  // over hours that drew no energy. A session reset hides it again (no
  // anchor). With no schedule this stays exactly the flat fmtCost path, which
  // ignores the anchor entirely.
  let cost = null;
  let uncovered = false;
  let fallback = false;
  if (status) {
    cost = statusCostLabel(status, settings);
    if (cost != null) {
      uncovered = statusCostUncovered(status, settings);
      fallback = !uncovered && statusCostFallback(status, settings);
    } else if (costAnchor) {
      cost = heldCostLabel(status.session_energy, costAnchor.elapsed, costAnchor.ms, settings);
      uncovered = cost != null && heldCostUncovered(costAnchor.elapsed, costAnchor.ms, settings);
      fallback =
        cost != null && !uncovered && heldCostFallback(costAnchor.elapsed, costAnchor.ms, settings);
    }
  }
  setText($('fig-cost'), cost ?? '—');
  const sub = $('cost-sub');
  sub.replaceChildren();
  if (uncovered) {
    // Under the figure, in the warning colour: "Understates cost" says what
    // the caveat does to the number, and the tooltip explains the 0.00 slices.
    const marker = document.createElement('span');
    marker.className = 'cost-unpriced';
    marker.textContent = 'understates cost';
    marker.title =
      'Some hours in this session have no price and count as 0.00, so this cost is lower than the real one.';
    sub.append(marker);
  }
  if (fallback) {
    // The informational line (#193), subdued — never the warning colour: the
    // uncovered slice is priced, at the stored flat rate rather than a row, so
    // the figure is honest and only the fallback deserves naming. Mutually
    // exclusive with the warning by the rate it reads, and gated the same way
    // (it never stands alone without the figure).
    const marker = document.createElement('span');
    marker.className = 'cost-fallback';
    marker.textContent = `part at your flat rate ${fmtRate(settings.rate, settings.currency)}`;
    marker.title = `Part of this session falls outside every rate row and prices at your flat rate ${fmtRate(settings.rate, settings.currency)}.`;
    sub.append(marker);
  }
}

function renderScheduleBadge() {
  const el = $('schedule-badge');
  const info = status && status.schedule;
  const inWindow = Boolean(info && info.in_window === true);
  el.hidden = !inWindow;
  if (!inWindow) return;
  const id = typeof info.active_rule_id === 'string' ? info.active_rule_id : '';
  const rules = schedule && Array.isArray(schedule.rules) ? schedule.rules : [];
  const rule = id ? rules.find((r) => r && r.id === id) : null;
  // Only name the window once the id resolves against the live schedule doc and
  // the boundary values are strings; otherwise report just what the charger said.
  const named = Boolean(rule) && typeof rule.start === 'string' && typeof rule.end === 'string';
  setText(
    $('schedule-badge-text'),
    named ? `Scheduled ${rule.start}–${rule.end}` : 'Scheduled window',
  );
  el.title = named
    ? `Active rule ${rule.id} (${rule.start}–${rule.end})`
    : 'A schedule window is active';
}

// The claims reason line (#159): a deliberately dumb paint of claimsState's
// projection, the renderHealth split — the whole decision lives in
// js/claims.js, unit-tested without a DOM. The freshness facts are the same
// ones renderFreshness feeds freshnessState, so the line and the banner can
// never disagree about what they were asked. No staleness machinery of its
// own: with no status document there is no freshness fact at all, and the
// line stands down with the rest of the hero (the pre-data and error screens
// show no derived state).
function renderClaims() {
  const node = $('claims-line');
  const state = status
    ? claimsState({
        doc: claims,
        stateLabel: status.state_label,
        chargerOnline: status.charger_online,
      })
    : null;
  node.hidden = !state;
  // Written on every render, '' included: a copy left in the hidden node
  // must not come back as a bare un-hide (the #status-error order).
  setText(node, state ? state.line : '');
  if (state) node.setAttribute('data-tone', state.tone);
}

function currentSeed() {
  const pilot = status && status.pilot;
  return Number.isInteger(pilot) && pilot > 0 ? pilot : current.max;
}

function renderStatus() {
  const theState = stateFor(status && status.state_label);
  document.documentElement.style.setProperty('--state', theState.color);
  setText($('state-label'), theState.label);
  // Same liveness gate as the session clock and the live cost: an offline marker
  // keeps the last known `charging` label, so pulsing there would advertise a
  // live charge whose clock has already frozen.
  $('state-badge').classList.toggle('pulse', liveCharging(status));

  setText($('power'), status && status.power != null ? fmtK(toNumber(status.power) / 1000) : '—');
  setText($('fig-amp'), status ? numOrDash(status.amp) : '—');
  const volts = status ? toNumber(status.voltage) : Number.NaN;
  setText($('fig-volt'), Number.isFinite(volts) && volts ? `at ${Math.round(volts)} V` : '');
  setText(
    $('fig-session'),
    status && status.session_energy != null ? fmtK(toNumber(status.session_energy) / 1000) : '—',
  );
  setText($('fig-setpoint'), status ? numOrDash(status.pilot) : '—');

  if (!ampsTouched && current) {
    // `/status` pilot is the configured setpoint. An idle charger legitimately
    // reports zero, so fall back to the verified soft limit in that case.
    setAmps(currentSeed());
  }
  renderElapsed();
  renderCost();
  renderScheduleBadge();
  renderClaims();
  renderFreshness();
  renderStatusError();
  renderHealth();
}

// ---------- charger health (#158) ----------
//
// The projection, the ordering, the severity pass-through and every string the
// card shows come from health.js; this paint is deliberately dumb, so the whole
// state machine is unit-tested without a DOM. The card adds no staleness verdict
// of its own — the doc is written only on change, and #banner above already owns
// bridge liveness (D8).
//
// The acknowledgement control is the one write this card makes, and it is never
// optimistic: the click sets a busy state on that row, and the row keeps reading
// Recorded/Active until the health snapshot lists the advisory as acknowledged
// (`acks[<id>]`, written by the bridge only after the charger's 2xx — D5 — or
// the gateway's own `acked` flag at the next 300 s poll). Four things end the
// wait, and only the first is success: the snapshot, the command settling
// `failed`, a rejected write, or the bounded wait. A failure paints a short
// reason and leaves the row exactly as it was.
//
// Dismissal (#205) is the card's other control and the opposite kind: a local
// hide for this account in this browser. It writes no command — nothing here
// reaches the bridge or Firestore — so there is nothing to wait for: the click
// records the dismissal and the rebuild it triggers removes the row at once.
// health.js decides what a record hides and when it is retired; the store
// keeps them; this file only hands one the other.

// One row: the three facts, the Dismiss control every row carries, and — while
// the advisory is not acknowledged — the control that mutes it. The ack button
// is built once per row and repainted in place (`paintAckRow`), so a click
// never loses the control it started on while the acknowledgement is in
// flight. Both controls share the row's one action line.
function healthRow(row) {
  const item = el('li', 'health-item');
  item.setAttribute('data-presentation', row.presentation);
  if (row.severity) item.setAttribute('data-severity', row.severity);
  const head = el('div', 'health-item-head');
  head.append(el('span', 'health-name', row.name));
  head.append(el('span', 'health-chip health-state', row.presentationLabel));
  if (row.severityLabel) {
    const severity = el('span', 'health-chip health-severity', row.severityLabel);
    severity.setAttribute('data-severity', row.severity);
    head.append(severity);
  }
  item.append(head);
  // The raw id rides the meta line: the owner cross-references it in the
  // Advanced console and the firmware's own docs, where the friendly name
  // does not exist.
  const meta = el('p', 'health-meta');
  meta.textContent = [row.id, row.seen].filter(Boolean).join(' · ');
  item.append(meta);
  const actions = el('div', 'health-actions');
  const dismiss = dismissControlState(row);
  if (dismiss.show) {
    const button = el('button', 'btn small ghost', dismiss.label);
    button.type = 'button';
    button.setAttribute('aria-label', dismiss.ariaLabel);
    // `detail` is the click count: 0 for a keyboard or programmatic
    // activation, 1 or more from a pointer.
    button.addEventListener('click', (event) => dismissRow(row, event.detail > 0));
    actions.append(button);
    dismissNodes.set(row.id, button);
  }
  const control = ackControlState(row);
  if (control.show) {
    const button = el('button', 'btn small', control.label);
    button.type = 'button';
    button.setAttribute('aria-label', control.ariaLabel);
    button.disabled = control.disabled;
    button.addEventListener('click', () => acks.start(row));
    // The failure line is its own polite region: it appears while the row stays
    // exactly where it was — still unacknowledged — so it has to be announced.
    const message = el('p', 'health-ack-message');
    message.setAttribute('role', 'status');
    message.hidden = !control.message;
    message.textContent = control.message;
    actions.append(button, message);
    ackNodes.set(row.id, { button, message });
  }
  if (actions.children.length) item.append(actions);
  return item;
}

// Dismiss one advisory for the signed-in account (#205). The record is written
// through the store and the rebuild the render below performs is what removes
// the row — the same paint path a snapshot uses, so nothing can drift between
// a dismissed row and a listed one. `pointer` says the activation came from a
// pointer.
function dismissRow(row, pointer) {
  // The second click of a double-click, landing on the Dismiss that slid
  // under the pointer when the first click's rebuild removed its row: not a
  // decision the owner made, so it is ignored. The window is anchored to the
  // last activation taken and never extended by one ignored.
  const now = Date.now();
  if (pointer) {
    if (now < dismissGuardUntil) return;
    dismissGuardUntil = now + DISMISS_DOUBLE_CLICK_MS;
  }
  // The control this click leaves focus on is destroyed by that rebuild, along
  // with its row, and the browser's focus fix-up has already dropped focus to
  // <body> by the time the row is gone. Record the hand-off where it happens,
  // exactly as `paintAckRow` does for a control it disables.
  dismissFocusId = row.id;
  // Signed out there is no account to scope the dismissal to, so nothing is
  // recorded — and nothing is applied on the next render either.
  const uid = accountUid();
  if (uid) dismissals.dismiss(uid, row);
  renderHealth();
}

// Busy and failure, painted onto the control the row already has. Nothing here
// can change the row's presentation: only the health snapshot does that.
function paintAckRow(row) {
  const nodes = ackNodes.get(row.id);
  if (!nodes) return;
  const state = acks.state(row.id);
  const control = ackControlState(row, state);
  // The row offered the control when it was built, and one whose
  // `canAcknowledge` has moved is rebuilt rather than repainted, so `show` is
  // true whenever this runs — it still decides, so the paint has one shape.
  nodes.button.hidden = !control.show;
  nodes.button.textContent = control.label;
  // Disabling the control the owner just activated takes their focus with it
  // inside the same click dispatch: a focused element that becomes unfocusable
  // loses focus to the nearest focusable ancestor — <body> here. Record that here,
  // where it happens, because the rebuild that removes the control cannot see it
  // any more (`document.activeElement` is already <body>).
  if (control.disabled && nodes.button === document.activeElement) ackFocusId = row.id;
  nodes.button.disabled = control.disabled;
  nodes.button.setAttribute('aria-label', control.ariaLabel);
  nodes.message.hidden = !control.show || !control.message;
  setText(nodes.message, control.message);
  // The attempt ended without a rebuild (a failure): retire the flag here, so it
  // cannot outlive the attempt it describes.
  if (!state.pending && ackFocusId === row.id) settleAckFocus(control, nodes);
}

// The retry end of the hand-off above: an attempt that ends on the row itself —
// a rejected write, a command settled `failed`, the bounded wait — re-enables
// the control instead of removing it, so nothing rebuilds and nothing else would
// ever spend the flag. It is spent here, the moment the attempt is over, and
// focus settles at the same time: back on the control that came back enabled
// (the owner's retry target), or the card's title when the row no longer offers
// one. The shared fell-away test keeps a focus the owner moved somewhere live in
// the meantime exactly where they put it.
function settleAckFocus(control, nodes) {
  ackFocusId = null;
  if (!focusFellAway()) return;
  const target = control.show ? nodes.button : $('health-title');
  target.focus({ preventScroll: true });
}

function renderHealth() {
  // Spend the dismiss intent here, on every render: the click handler sets it
  // and re-renders at once, so a flag read at the top of this function always
  // describes this render. (A signed-out click records nothing and so rebuilds
  // nothing — clearing it here is what keeps that flag from sitting around for
  // an unrelated rebuild to spend.)
  const dismissed = dismissFocusId;
  dismissFocusId = null;
  const uid = accountUid();
  // Signed out, no record is read, so none is applied: the card lists what the
  // charger reports, for everyone.
  const stored = uid ? dismissals.read(uid) : {};
  const state = healthState({
    doc: health,
    error: healthError,
    nowMs: Date.now(),
    dismissals: stored,
  });
  // Persisting the projection's answer is the screen's whole write path — it
  // never edits storage itself. The map holds every record this report is no
  // evidence against: one still hiding a row, or one whose advisory a gate
  // that may still close keeps the report silent about. `null` (health
  // unknown) says leave them alone: that state is no evidence an advisory is
  // gone. An unchanged map writes nothing, so a steady report costs no storage
  // write.
  if (uid && state.dismissals) dismissals.replace(uid, state.dismissals);
  // The snapshot is the only success signal: an advisory it no longer lists as
  // acknowledgeable ends whatever acknowledgement was waiting on it, and the
  // row's own rebuild is what makes it read "Acknowledged".
  acks.snapshot(state.advisories);
  healthView = state;
  const card = $('health-card');
  card.setAttribute('data-state', state.state);
  card.setAttribute('data-tone', state.tone);
  setText($('health-meta'), state.meta);
  // The summary is a polite live region: written on every render, so a changed
  // state is a fresh mutation the region can announce, and an unchanged one is
  // a no-op (setText compares first).
  setText($('health-title'), state.title);
  setText($('health-detail'), state.detail);
  const caveat = $('health-caveat');
  caveat.hidden = !state.caveat;
  setText(caveat, state.caveat);
  // The signature carries everything the row renders — including whether it
  // offers the ack control: the bridge-capability fact can flip beneath an
  // otherwise identical advisory list (a bridge upgraded under this web), and
  // a rebuild is what makes the control appear or disappear (#159). It is
  // taken over the rows that are listed, after dismissals, so a dismissal is
  // itself a signature change: the row a Dismiss removed, and the one a
  // changed advisory brought back — a new severity, or the charger reporting
  // the condition as present or not — each rebuild the list (#205).
  const signature = state.advisories
    .map(
      (row) =>
        `${row.id}|${row.presentation}|${row.severity}|${row.name}|${row.seen}|${row.canAcknowledge}`,
    )
    .join(';');
  if (signature !== healthSignature) {
    healthSignature = signature;
    // A rebuild recreates every row, so a control the owner was on will not
    // survive it — this is the acknowledgement's own success path, where the
    // control disappears because the row now reads Acknowledged, and the
    // dismissal's, where the whole row goes. Three facts say a focus is about
    // to be destroyed: a control that still holds it (`heldControl` — a
    // remote ack, a Dismiss tabbed to, or a control pressed in a browser that
    // keeps its focus), the control whose disable displaced it (`ackFocusId`,
    // because the browser had already dropped focus to <body> by now — an
    // attempt that ends as a failure retires that flag in `paintAckRow`
    // instead, so one it left here really was in flight), and the Dismiss
    // control its own click just activated (`dismissed`). Any of them hands
    // focus to the card's title — the same fell-away policy the Retry screens
    // use, so focus that is still on a live element is never stolen.
    const heldControl =
      [...ackNodes.values()].some((nodes) => nodes.button === document.activeElement) ||
      [...dismissNodes.values()].includes(document.activeElement);
    const displaced = ackFocusId || dismissed;
    ackFocusId = null;
    ackNodes = new Map();
    dismissNodes = new Map();
    $('health-list').replaceChildren(...state.advisories.map(healthRow));
    if ((heldControl || displaced) && focusFellAway()) {
      $('health-title').focus({ preventScroll: true });
    }
  }
  $('health-list').hidden = state.advisories.length === 0;
  for (const row of state.advisories) paintAckRow(row);
  const retry = $('health-retry');
  retry.hidden = state.reason !== 'error';
  // Recovery lands on the card the retry refilled, not at the top of the page.
  if (retry.hidden && healthRetryRequested) {
    healthRetryRequested = false;
    focusAfterRetry(retry, 'health-title');
  }
}

// The controls note under the buttons. Its standing line describes the three
// controls; when they lose their capability that line cannot explain a dimmed
// Hold, and a `title` on a disabled control is skipped by the keyboard and most
// AT — so the one reachable place says why instead. The title stays as the
// mouse affordance.
const NOTE_DEFAULT =
  'Stop pauses charging · Auto returns to the schedule · Hold sets a current limit.';
const NOTE_UNAVAILABLE = 'Hold needs the charger’s limits.';

// `current` is the capability view the current controls need: null until a
// status/config snapshot yields a usable pair of limits, so the same test makes
// them disabled before that first snapshot and after one that fails closed.
// Stop and Auto need no limits, so they only follow a command in flight.
function setBusy(busy) {
  commandsBusy = busy;
  $('pause').disabled = busy;
  $('resume').disabled = busy;
  const unavailable = !current;
  for (const el of [$('hold'), $('amps'), $('apply')]) el.disabled = busy || unavailable;
  $('hold').title = unavailable
    ? 'Current setting is unavailable until charger limits are verified.'
    : '';
  setText($('controls-note'), unavailable ? NOTE_UNAVAILABLE : NOTE_DEFAULT);
}

function renderCommands(cmds) {
  const fb = $('feedback');
  const controls = (Array.isArray(cmds) ? cmds : []).filter(
    (command) => command && CONTROL_TYPES.has(command.type),
  );
  const pending = controls.find((c) => c.status === 'pending');
  setBusy(Boolean(pending));
  if (pending) {
    const t = CMD_TEXT[pending.type] || CMD_TEXT.resume;
    fb.className = 'feedback busy';
    setText(fb, t.busy(pending.amps));
    return;
  }
  const latest = controls[0];
  const created =
    latest && latest.created_at && typeof latest.created_at.toMillis === 'function'
      ? latest.created_at.toMillis()
      : 0;
  if (!latest || !created || Date.now() - created > 5 * 60000) {
    fb.className = 'feedback';
    setText(fb, '');
    return;
  }
  const t = CMD_TEXT[latest.type] || { busy: () => 'Working…', done: () => 'Done.' };
  if (latest.status === 'acked') {
    if (shownResultId === latest.id) return;
    shownResultId = latest.id;
    fb.className = 'feedback ok';
    setText(fb, t.done(latest.amps));
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      if (shownResultId === latest.id) {
        fb.className = 'feedback';
        setText(fb, '');
      }
    }, 6000);
  } else if (latest.status === 'failed') {
    shownResultId = latest.id;
    fb.className = 'feedback err';
    setText(fb, `Failed: ${latest.error || 'command was not applied'}`);
  } else {
    fb.className = 'feedback';
    setText(fb, '');
  }
}

async function send(payload) {
  // Auto and Stop replace the mode the panel belongs to, so the panel goes with
  // them — without moving focus off the button just pressed. The slider re-seeds
  // from the next status write rather than the drag left behind.
  if (payload.type === 'pause' || payload.type === 'resume') {
    setHoldOpen(false, { focus: false });
    ampsTouched = false;
  }
  setBusy(true); // optimistic; the commands listener keeps this set until the bridge acks
  try {
    await postCommand(payload);
  } catch {
    setBusy(false);
    // The stop never left this device, so let the clock follow the next write.
    clockHold = null;
    renderElapsed();
    const fb = $('feedback');
    fb.className = 'feedback err';
    setText(fb, 'Could not send — check your connection and try again.');
  }
}

function setAmps(v) {
  const min = current ? current.min : 6;
  const max = current ? current.max : 48;
  holdAmps = Math.min(max, Math.max(min, Math.round(v)));
  $('amps').min = String(min);
  $('amps').max = String(max);
  $('amps').value = holdAmps;
  paintSlider();
}

function paintSlider() {
  const v = Number($('amps').value);
  setText($('amps-out'), `${v} A`);
  const min = current ? current.min : 6;
  const max = current ? current.max : 48;
  // A range whose ends meet has no partial state: min == max means the one
  // value is the whole track, and a 0% fill would read as "empty" instead of
  // "fixed at the only value". Every other range keeps the plain ratio.
  const span = Math.max(1, max - min);
  const fill = max === min ? 100 : ((v - min) * 100) / span;
  $('amps').style.setProperty('--fill', `${fill}%`);
}

// Hold reveals the set-current editor; it does not claim a mode is active.
// Stop and Auto send their commands immediately.
function setHoldOpen(open, { focus = true } = {}) {
  holdOpen = open;
  $('hold-panel').hidden = !open;
  $('hold').setAttribute('aria-expanded', String(open));
  // A close triggered by another control leaves focus on that control.
  if (!focus) return;
  if (open) $('amps').focus({ preventScroll: true });
  else $('hold').focus({ preventScroll: true });
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    renderFreshness();
    renderElapsed();
  }, 1000);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

// ---------- screen lifecycle ----------

// `uid` reads the signed-in account the Health card's dismissals are scoped
// to. The app passes nothing: the card reads Firebase Auth's current user, the
// way the notification card does. The option exists because that reader is the
// one dependency the DOM harness cannot supply any other way — `firebase.js`
// keeps `auth` unbound until `initFirebase()` runs, and a live binding cannot
// be handed a value from outside the module.
export function initStatus({ uid = currentUid } = {}) {
  accountUid = uid;
  // First paint: no status/config snapshot has been applied yet, so the
  // current controls start disabled rather than looking usable for the round
  // trip that fills them. `current` is null here, which is the same
  // fail-closed test an unusable snapshot hits; Stop and Auto stay live.
  setBusy(false);
  $('pause').addEventListener('click', () => {
    // Hold the clock where it is on screen: the last snapshot still says
    // "charging" until the bridge reports the new state, and extrapolating past
    // it would overshoot before snapping back.
    freezeElapsed();
    renderElapsed();
    send({ type: 'pause' });
  });
  $('resume').addEventListener('click', () => send({ type: 'resume' }));
  $('hold').addEventListener('click', () => setHoldOpen(!holdOpen));
  $('apply').addEventListener('click', () =>
    send({ type: 'set_current', amps: Number($('amps').value) }),
  );
  $('amps').addEventListener('input', () => {
    ampsTouched = true;
    holdAmps = Number($('amps').value);
    paintSlider();
  });
  // Retry re-subscribes through the one startStore path (which stops first), so
  // repeated taps cannot stack listeners. Deliberately no busy state, no
  // backoff and no budget: the control stays usable and idempotent.
  $('status-retry').addEventListener('click', () => {
    // Remembered for the render that clears the failure: it hides the control
    // the click left focus on, so it owes the user a new focus target.
    retryRequested = true;
    // The copy goes with the click: a retry that fails again must re-write the
    // line, and an unchanged line is no mutation, so nothing would be announced.
    setText($('status-error'), '');
    retryStore();
  });
  // Health's listener shares the one re-subscribe path, and its failure line is
  // the card's own state — so the click clears the detail for the same reason.
  $('health-retry').addEventListener('click', () => {
    healthRetryRequested = true;
    setText($('health-detail'), '');
    retryStore();
  });
}

export function enterStatus() {
  active = true;
  if (!$('panel-status').hidden) startTicker();
}

export function focusStatus() {
  if (!active) return;
  startTicker();
  renderElapsed();
  renderFreshness();
}

export function blurStatus() {
  stopTicker();
}

export function leaveStatus() {
  active = false;
  stopTicker();
  clearTimeout(resultTimer);
  ticker = resultTimer = null;
  status = null;
  // Sign-out teardown: the next session starts from the pre-data screen, not
  // from a failure that belonged to the session that just ended.
  statusError = false;
  retryRequested = false;
  health = null;
  healthError = false;
  healthRetryRequested = false;
  healthSignature = null;
  claims = null;
  // Sign-out teardown: no acknowledgement may outlive the session that started
  // it — its timers are cancelled and the generation bump drops any settlement
  // still in flight.
  acks.reset();
  ackNodes = new Map();
  ackFocusId = null;
  // The next session's first click is no one's double-click.
  dismissGuardUntil = 0;
  healthView = null;
  schedule = null;
  settings = null;
  ampsTouched = false;
  holdOpen = false;
  holdAmps = 32;
  current = null;
  commandsBusy = false;
  shownResultId = null;
  clock = null;
  clockHold = null;
  costAnchor = null;
  setBusy(false);
  const fb = $('feedback');
  fb.className = 'feedback';
  setText(fb, '');
  $('banner').hidden = true;
  $('hold-panel').hidden = true;
  $('hold').setAttribute('aria-expanded', 'false');
  setText($('elapsed'), '—');
  setText($('fig-cost'), '—');
  $('cost-sub').replaceChildren();
  $('schedule-badge').hidden = true;
  $('claims-line').hidden = true;
  setText($('claims-line'), '');
  setAmps(32);
  showConfig(null);
  renderStatus();
}

// ---------- data callbacks ----------

export function showStatus(snap) {
  const data = snap && snap.exists() ? snap.data() : null;
  // Any snapshot proves the listener is alive again — a cache-provenance one
  // included, since it is data the screen can show — so the failure line and
  // its Retry go away and the normal render takes over.
  statusError = false;
  // Only a new status write releases a stop-time hold. The bridge merges only
  // `schedule` into status/current, and releasing on that merge would let the
  // clock interpolate from the old write and jump before the stop lands.
  clockHold = holdAfterSnapshot(clockHold, data);
  // The cost anchor follows the same writes: re-anchored while charging, held
  // across schedule-only merges and stopped writes, cleared on a session
  // reset. A null after that machine is the cold-open case, and the bridge's
  // stop stamp fills it — never the other way round: the held machine's
  // non-null result (a captured or already-adopted anchor) always wins, which
  // is what keeps repeated polls from re-adopting and moving the figure.
  costAnchor = heldAnchorAfter(costAnchor, data) ?? adoptedAnchor(data);
  status = data;
  renderStatus();
}

export function showStatusError() {
  // No snapshot reached the screen, so nothing may be left claiming one did:
  // the failure state is the whole picture (blank figures, no caption).
  statusError = true;
  clock = null;
  clockHold = null;
  costAnchor = null;
  status = null;
  renderStatus();
}

export function showCommands(cmds) {
  renderCommands(cmds);
  acks.command(cmds);
}

// status/notifications — the health projection. A null document is a real
// answer ("health unknown"), never a reason to keep the previous card on screen:
// the bridge only writes this document when the advisory list changes, and an
// absent one means it has not reported health at all.
export function showHealth(data) {
  health = data && typeof data === 'object' ? data : null;
  healthError = false;
  renderHealth();
}

export function showHealthError() {
  // A failed listener has no projection left to show, and the card must not go
  // on presenting the last one as if it were current.
  health = null;
  healthError = true;
  renderHealth();
}

// status/claims — the one authoritative reason line. A null document (absent,
// or the listener failed and app.js passes the failure through here) is a real
// answer that leaves nothing to show: the bridge writes this document only on
// change, and the line never outlives the facts behind it. Re-rendered beside
// the status facts, because the projection also reads the banner's freshness
// inputs from status/current.
export function showClaims(data) {
  claims = data && typeof data === 'object' ? data : null;
  renderClaims();
}

// settings/current — null until an owner saves a rate. The whole document is
// kept so the live cost can use the optional schedule; an instant no row
// matches costs the stored flat rate (#188) — 0.00 only when no finite flat
// rate is stored.
export function showSettings(data) {
  settings = costSettings(data);
  renderCost();
}

// The nodes the fail-closed render takes away: the Hold trigger and anything
// focusable inside the panel it opens. A focus anywhere else was not displaced
// by this render.
function displacedByClose(node) {
  if (!node) return false;
  if (node === $('hold') || node === $('amps') || node === $('apply')) return true;
  const panel = $('hold-panel');
  return Boolean(panel && typeof panel.contains === 'function' && panel.contains(node));
}

// status/config — the device name is the header's first consumer.
export function showConfig(config) {
  // Focus this render may displace: the close hides the panel and `setBusy`
  // disables its controls, and the browser drops a focused control the moment
  // it becomes unfocusable — down to <body>. Recorded before either runs, the
  // same way `ackFocusId` records a disabled row's focus.
  const displaced = document.activeElement;
  const raw = config && typeof config.hostname === 'string' ? config.hostname.trim() : '';
  setText($('device-name'), raw || 'ChelEVSE');
  $('device-name').title = raw || 'ChelEVSE';
  current = currentCapability(config);
  if (current) {
    const next = ampsTouched ? holdAmps : currentSeed();
    setAmps(next);
  } else {
    // Fail closed: the panel loses its capability with `current`, so it closes
    // without handing focus to a control this same path disables. `setBusy`
    // below does the disabling; the redirect after it lands only a focus this
    // render actually displaced.
    setHoldOpen(false, { focus: false });
  }
  setBusy(commandsBusy);
  // "Any snapshot moves nothing" holds here too: a config event that fails
  // closed while focus rests on <body> — a listener error, an unreadable doc —
  // displaced nothing, so it must move nothing. Focus still on a live element
  // is where the owner put it and is left alone as well.
  //
  // Recovery lands on the panel, the shared Retry policy's target — never on a
  // command button: a stray Space/Enter on Stop would send a command the owner
  // never asked for.
  if (displacedByClose(displaced) && focusFellAway()) {
    $('panel-status').focus({ preventScroll: true });
  }
}

// schedule/current — used only to resolve the active rule's window.
export function showStatusSchedule(data) {
  schedule = data;
  renderScheduleBadge();
}
