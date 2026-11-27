import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Settings list (#228): the one-line state under each of its four cards.
//
// The copy is derived in web/js/settings-list.js, pure over the snapshots
// app.js already fans out to the screen each card opens — so these cases need
// no DOM. What they pin: every card reads saved data only (the module has no
// way to reach an editor's draft), a queued write is not claimed as saved, a
// failed read is named, and every state is `{ text, tone }`.
//
// The paint (web/js/screens/settings-list.js) is pinned on the repo's stub
// harness: one stub element per id, the real module. The wiring in app.js
// runs only as a browser module, so it is pinned from source (the
// config-lifetime convention).

import {
  LIST_LOADING,
  chargerListState,
  notificationsListState,
  pricesListState,
  scheduleListState,
} from '../../web/js/settings-list.js';
import { notificationState } from '../../web/js/notifications.js';
import { syncedLabel } from '../../web/js/config.js';

// ---------- pure derivation ----------

const TONES = ['', 'on', 'warn', 'err'];
const COULDNT_LOAD = 'Couldn’t load';

// Every state any case sees, for the shape invariant at the end of the block.
const seen = [];
function expectState(actual, text, tone = '') {
  assert.deepEqual(actual, { text, tone });
  seen.push(actual);
  return actual;
}

const rule = { id: 'rule-1', days: [0, 1, 2, 3, 4], start: '22:00', end: '06:00' };
const base = {
  id: 'base',
  rate: 0.28,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '00:00',
  end: '00:00',
  months: null,
};
const peak = { id: 'peak', rate: 0.42, days: [0, 1, 2, 3, 4], start: '16:00', end: '19:00' };
const night = { id: 'night', rate: 0.12, days: [0, 1, 2, 3, 4], start: '22:00', end: '06:00' };

test('before any snapshot, and after a failed read, every card says so', () => {
  for (const derive of [scheduleListState, pricesListState, chargerListState]) {
    expectState(derive(), LIST_LOADING);
    expectState(derive({}), LIST_LOADING);
    expectState(derive({ error: true }), COULDNT_LOAD, 'err');
  }
  // The notification card has no listener: before its first render it is
  // checking, which is what the screen's card says too.
  expectState(notificationsListState(), 'Checking…');
});

test('the schedule card reads the saved schedule: off says off, on counts windows', () => {
  // No document, and a document with the schedule off, are both off.
  expectState(scheduleListState({ data: null }), 'Off');
  expectState(scheduleListState({ data: { enabled: false, rules: [rule] } }), 'Off');
  expectState(scheduleListState({ data: { enabled: true, rules: [rule] } }), 'On · 1 window', 'on');
  expectState(
    scheduleListState({ data: { enabled: true, rules: [rule, { ...rule, id: 'rule-2' }] } }),
    'On · 2 windows',
    'on',
  );
  expectState(scheduleListState({ data: { enabled: true, rules: [] } }), 'On · 0 windows', 'on');
  // Legacy amps/feature fields are readable and change nothing.
  expectState(
    scheduleListState({ data: { enabled: true, rules: [{ ...rule, amps: 32, feature: 1 }] } }),
    'On · 1 window',
    'on',
  );
});

test('a malformed stored schedule is not off: the card asks for attention', () => {
  // The bridge skips a container it cannot read and leaves the charger's own
  // firmware schedule running, so the card must not say charging is
  // unrestricted — the editor's toggle note's own rule.
  expectState(
    scheduleListState({ data: { enabled: 'yes', rules: [] } }),
    'Needs attention',
    'warn',
  );
  expectState(
    scheduleListState({ data: { enabled: false, rules: 'none' } }),
    'Needs attention',
    'warn',
  );
});

test('a queued schedule write is not claimed as saved', () => {
  // A write still in the local cache (offline, or in flight) arrives as the
  // document with hasPendingWrites. It is not server truth yet.
  expectState(
    scheduleListState({
      data: { enabled: true, rules: [rule] },
      meta: { pendingWrites: true },
    }),
    'On · 1 window · waiting to save',
    'warn',
  );
  expectState(
    scheduleListState({ data: { enabled: false, rules: [] }, meta: { pendingWrites: true } }),
    'Off · waiting to save',
    'warn',
  );
  // The acknowledgment is the same data without the flag: saved, and plain.
  expectState(
    scheduleListState({
      data: { enabled: true, rules: [rule] },
      meta: { pendingWrites: false },
    }),
    'On · 1 window',
    'on',
  );
});

test('the prices card reads the stored document, one line for each mode', () => {
  // One rate: the flat price in the owner's currency.
  expectState(
    pricesListState({ data: { rate: 0.31, currency: 'USD', charger_host: '192.168.1.50' } }),
    'One rate · USD 0.31 per kWh',
  );
  // The charger address is the card's other half, not its state line.
  assert.equal(
    pricesListState({
      data: { rate: 0.31, currency: 'USD', charger_host: '192.168.1.50' },
    }).text.includes('192.168.1.50'),
    false,
  );
  expectState(pricesListState({ data: { rate: 0.31, currency: '$' } }), 'One rate · $0.31 per kWh');
  // A per-kWh price keeps the five decimals a utility bill quotes.
  expectState(
    pricesListState({ data: { rate: 0.15303, currency: 'USD' } }),
    'One rate · USD 0.15303 per kWh',
  );

  // Seasons & time-of-use: the plan summary's count and range, one currency.
  expectState(
    pricesListState({ data: { rate: 0.31, currency: 'USD', rates: [base, peak] } }),
    '1 season · USD 0.28–0.42 per kWh',
  );
  // A base-less legacy window prices its uncovered hours at the stored flat
  // rate, so that price is in the range — the summary's own rule (#188).
  expectState(
    pricesListState({ data: { rate: 0.31, currency: 'USD', rates: [night] } }),
    '1 season · USD 0.12–0.31 per kWh',
  );
  // Every price the same: one price, not a range.
  expectState(
    pricesListState({
      data: { rate: 0.31, currency: 'USD', rates: [base, { ...peak, rate: 0.28 }] },
    }),
    '1 season · USD 0.28 per kWh',
  );
});

test('a stored plan the editor would flag reads as needing attention, not as a price', () => {
  const stored = (rates) => ({ rate: 0.31, currency: 'USD', rates });
  // No finite flat rate and currency is nothing the form could re-send.
  expectState(pricesListState({ data: { currency: 'USD' } }), 'Needs attention', 'warn');
  expectState(pricesListState({ data: {} }), 'Needs attention', 'warn');
  expectState(pricesListState({ data: 'nope' }), 'Needs attention', 'warn');
  // An incomplete row, alone or beside a valid base.
  const incomplete = { id: 'x', rate: '', days: [], start: '', end: '' };
  expectState(pricesListState({ data: stored([incomplete]) }), 'Needs attention', 'warn');
  expectState(
    pricesListState({
      data: stored([base, { ...incomplete, days: [0], start: '01:00', end: '02:00' }]),
    }),
    'Needs attention',
    'warn',
  );
  // Two colliding windows: each row is fine on its own.
  expectState(
    pricesListState({ data: stored([night, { ...night, id: 'night-2' }]) }),
    'Needs attention',
    'warn',
  );
});

test('the prices card calls an account empty only once the server has', () => {
  // The form holds its save until the server answers settings/current, because
  // a cached "no document" is the local cache answering first. The card reads
  // that the same way, so it cannot say "no prices" while the form is loading.
  expectState(pricesListState({ data: null, meta: { fromCache: true } }), LIST_LOADING);
  expectState(pricesListState({ data: null, meta: { fromCache: false } }), 'No prices saved yet');
  expectState(pricesListState({ data: null }), 'No prices saved yet');
  // A cached snapshot that carries the document does hold the stored values.
  expectState(
    pricesListState({ data: { rate: 1, currency: 'USD' }, meta: { fromCache: true } }),
    'One rate · USD 1.00 per kWh',
  );
});

test('the notifications card follows the notification card own state machine', () => {
  // `kind` is notificationState's, so the list cannot invent a verdict the
  // screen's card does not show. The card keeps the sentences; the list keeps
  // the verdict, and the warning colour rides with it.
  const cases = [
    [{}, 'Checking…', ''],
    [{ supported: false }, 'Not available', 'warn'],
    [{ supported: true, vapid: false }, 'Not configured', 'warn'],
    [{ supported: true, permission: 'denied' }, 'Blocked', 'warn'],
    // Permission granted but the token save failed: not on.
    [{ supported: true, permission: 'granted', tokenPhase: 'failed' }, 'Needs attention', 'warn'],
    [{ supported: true, permission: 'granted', tokenPhase: 'saved' }, 'On', 'on'],
    // Still registering this device: on its way, not yet on.
    [{ supported: true, permission: 'granted', tokenPhase: 'registering' }, 'Turning on…', ''],
    [{ supported: true, permission: 'granted', tokenPhase: 'idle' }, 'Turning on…', ''],
    [{ supported: true }, 'Off', ''],
  ];
  for (const [input, text, tone] of cases) {
    const kind = notificationState(input).kind;
    expectState(notificationsListState({ kind, tokenPhase: input.tokenPhase }), text, tone);
    // An unknown kind is nothing the card can show: it reads as off, never on.
    expectState(notificationsListState({ kind: 'something-else' }), 'Off');
  }
});

test('the charger card shows the Charger screen heading note, from one label', () => {
  const when = new Date('2026-11-27T13:26:00');
  const snapshot = { hostname: 'openevse-garage', updated_at: { toDate: () => when } };
  const heading = syncedLabel(snapshot);
  assert.match(heading, /^Synced \d\d:\d\d$/);
  expectState(chargerListState({ data: snapshot }), heading);
  // No usable timestamp: no line, as on the screen — never a dead value.
  expectState(chargerListState({ data: { hostname: 'openevse-garage' } }), '');
  expectState(chargerListState({ data: { updated_at: 'yesterday' } }), '');
  // No document is an answer; anything that is not a document is too.
  expectState(chargerListState({ data: null }), 'Not reported yet');
  expectState(chargerListState({ data: 'nope' }), 'Not reported yet');
  expectState(chargerListState({ data: ['nope'] }), 'Not reported yet');
});

test('every state is a text and one of the four tones', () => {
  assert.ok(seen.length > 60, `the cases above produced ${seen.length} states`);
  for (const view of seen) {
    assert.deepEqual(Object.keys(view).sort(), ['text', 'tone']);
    assert.equal(typeof view.text, 'string');
    assert.ok(TONES.includes(view.tone), `tone ${JSON.stringify(view.tone)} on ${view.text}`);
  }
  // A line that carries a tone always says something: attention is never a
  // bare colour. Only a charger snapshot without a usable timestamp shows no
  // line at all (pinned above, both ways it can happen).
  for (const view of seen) {
    assert.ok(view.text !== '' || view.tone === '', `a toned state with no text: ${view.tone}`);
  }
});

test('the pure module imports nothing that holds a draft or touches the DOM', () => {
  // "Saved data only, never a draft" is a property of the wiring, not a check:
  // the copy is derived from snapshots and the module can import no screen
  // (where the drafts live), no DOM helper and no Firebase.
  const source = readFileSync(new URL('../../web/js/settings-list.js', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.doesNotMatch(specifier, /screens\/|\/ui\.js|firebase|store/, specifier);
  }
});

// ---------- paint ----------

// The repo's module-mock-free stub: one element per id, every lookup deferred
// to render time, then a plain `await import` of the real screen.
function stubElement() {
  return {
    textContent: '',
    dataset: {},
  };
}

const elements = new Map();
function element(id) {
  let node = elements.get(id);
  if (!node) {
    node = stubElement();
    elements.set(id, node);
  }
  return node;
}

globalThis.document = { getElementById: (id) => element(id) };

const {
  resetSettingsList,
  showListConfig,
  showListConfigError,
  showListNotifications,
  showListSchedule,
  showListScheduleError,
  showListSettings,
  showListSettingsError,
} = await import('../../web/js/screens/settings-list.js');

const card = (route) => element(`settings-state-${route}`);
const view = (route) => ({ text: card(route).textContent, tone: card(route).dataset.tone || '' });
const CARDS = ['schedule', 'prices', 'notifications', 'charger'];

test('each snapshot paints its own card and no other', () => {
  resetSettingsList();
  showListSchedule({ enabled: true, rules: [rule] }, { pendingWrites: false });
  assert.deepEqual(view('schedule'), { text: 'On · 1 window', tone: 'on' });
  showListSettings({ rate: 0.31, currency: 'USD' }, { fromCache: false });
  assert.deepEqual(view('prices'), { text: 'One rate · USD 0.31 per kWh', tone: '' });
  showListConfig({
    hostname: 'garage',
    updated_at: { toDate: () => new Date('2026-11-27T13:26:00') },
  });
  assert.match(view('charger').text, /^Synced \d\d:\d\d$/);
  showListNotifications({ kind: 'granted', tokenPhase: 'saved' });
  assert.deepEqual(view('notifications'), { text: 'On', tone: 'on' });
  // Exactly the four state lines exist, and nothing else was written.
  assert.deepEqual(
    [...elements.keys()].sort(),
    CARDS.map((route) => `settings-state-${route}`).sort(),
  );
});

test('a failed read names its card, and the next snapshot replaces it', () => {
  showListSchedule({ enabled: false, rules: [] });
  showListScheduleError();
  assert.deepEqual(view('schedule'), { text: COULDNT_LOAD, tone: 'err' });
  showListSettingsError();
  assert.deepEqual(view('prices'), { text: COULDNT_LOAD, tone: 'err' });
  showListConfigError();
  assert.deepEqual(view('charger'), { text: COULDNT_LOAD, tone: 'err' });

  // Recovery: the copy returns and the error tone goes with it — the
  // attribute is removed, not left at its last value.
  showListSchedule({ enabled: false, rules: [] });
  assert.deepEqual(view('schedule'), { text: 'Off', tone: '' });
  assert.equal('tone' in card('schedule').dataset, false);
  showListSettings(null, { fromCache: false });
  assert.deepEqual(view('prices'), { text: 'No prices saved yet', tone: '' });
  showListConfig(null);
  assert.deepEqual(view('charger'), { text: 'Not reported yet', tone: '' });
  showListNotifications({ kind: 'denied' });
  assert.deepEqual(view('notifications'), { text: 'Blocked', tone: 'warn' });
  showListNotifications({ kind: 'default' });
  assert.deepEqual(view('notifications'), { text: 'Off', tone: '' });
});

test('a sign-out reset returns every card to its resting state', () => {
  showListScheduleError();
  showListNotifications({ kind: 'granted', tokenPhase: 'saved' });
  resetSettingsList();
  for (const route of CARDS) {
    assert.deepEqual(view(route), { text: LIST_LOADING, tone: '' }, route);
  }
});

// ---------- wiring (app.js runs only as a browser module) ----------

const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
const web = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

function block(source, start) {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `${start} is missing`);
  const end = source.indexOf('\n}\n', at);
  assert.ok(end > at, `${start} closes`);
  return source.slice(at, end).replace(/\s+/g, ' ');
}

test('app.js fans the four snapshots out to the list, with their errors', () => {
  // Same snapshot, same metadata as the screen each card opens: the list adds
  // no subscription. Pinned from source (the status-claims convention).
  const fanOut = block(app, 'startStore({');
  assert.match(
    fanOut,
    /onSettings: \(settings, meta\) => \{[^}]*showListSettings\(settings, meta\);/,
  );
  assert.match(
    fanOut,
    /onSettingsError: \(err\) => \{ showSettingsError\(err\); showListSettingsError\(\); \}/,
  );
  assert.match(fanOut, /onConfig: \(data\) => \{[^}]*showListConfig\(data\);/);
  assert.match(fanOut, /onConfigError: \(err\) => \{[^}]*showListConfigError\(\);/);
  assert.match(fanOut, /onSchedule: \(data, meta\) => \{[^}]*showListSchedule\(data, meta\);/);
  assert.match(
    fanOut,
    /onScheduleError: \(err\) => \{ showScheduleError\(err\); showListScheduleError\(\); \}/,
  );
});

test('app.js hands the notification card the list painter and resets the list on sign-out', () => {
  assert.match(app, /initNotifications\(\{ onState: showListNotifications \}\);/);
  const closeApp = block(app, 'function closeApp()');
  const list = closeApp.indexOf('resetSettingsList();');
  const notifications = closeApp.indexOf('resetNotifications();');
  assert.ok(list >= 0 && notifications >= 0, 'closeApp resets the list and the notification card');
  // The notification card's reset ends in a render that reports its signed-out
  // state to the list, so the list's own reset must come first.
  assert.ok(list < notifications, 'the list resets before the notification card');
});

test('the list painter reaches no screen, so it has no path to a draft', () => {
  // The painter takes a derived state or a snapshot and writes one line. It
  // imports no screen module — where every draft lives — and no store.
  const source = web('js/screens/settings-list.js');
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(specifiers, ['../ui.js', '../settings-list.js']);
});

test('the notification card reports its own derived state to the list on every render', () => {
  // The list's one state with no document comes from the card's render: the
  // same `kind` the card paints, with the token phase, through the callback
  // app.js wires. Without the callback (the DOM harnesses) nothing changes.
  const source = web('js/screens/notifications.js');
  const render = block(source, 'function render() {');
  assert.match(render, /setText\(\$\('notify-status'\), state\.title\);/);
  assert.ok(
    render.indexOf('dataset.state = state.kind') < render.indexOf('if (onState) onState('),
    'the list is told the state the card was just painted in',
  );
  assert.match(render, /if \(onState\) onState\(\{ kind: state\.kind, tokenPhase: phase \}\);/);
  assert.match(source, /export function initNotifications\(\{ onState: report \} = \{\}\) \{/);
});

// ---------- markup ----------
//
// The stub above answers any id on demand, so the list's structure is pinned
// from source (the config-lifetime convention): what the harness cannot see —
// which tab a screen lives under, what sits inside which region, the order of
// the cards and of the bar, and where the form went.

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');

// The opening tag that carries an id, on one line.
function openTag(id) {
  const match = new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
  assert.ok(match, `#${id} is in web/index.html`);
  return match[0].replace(/\s+/g, ' ');
}
const at = (marker) => {
  const position = html.indexOf(marker);
  assert.ok(position >= 0, `${marker} is in web/index.html`);
  return position;
};

const SCREENS = [
  // route, the heading that names the region, its Back control, what else lives inside
  [
    'schedule',
    'schedule-heading',
    '<a class="back-link" href="#config">',
    ['schedule-editor', 'save-schedule'],
  ],
  ['prices', 'prices-heading', '<button id="prices-back" class="back-link" type="button">', []],
  [
    'notifications',
    'notify-heading',
    '<a class="back-link" href="#config">',
    ['notify-card', 'notify-enable', 'notify-retry'],
  ],
  [
    'charger',
    'charger-heading',
    '<a class="back-link" href="#config">',
    [
      'config-goto-advanced',
      'config-sections',
      'config-raw-details',
      'config-retry',
      'lifetime-note',
    ],
  ],
];

test('the bar holds four tabs in order, and Schedule is no longer one of them', () => {
  const tabs = [...html.matchAll(/<button\b[^>]*\bclass="tab"[^>]*>[\s\S]*?<\/button>/g)].map(
    (m) => m[0],
  );
  assert.deepEqual(
    tabs.map((tab) => /\bid="tab-([^"]+)"/.exec(tab)[1]),
    ['status', 'history', 'config', 'advanced'],
  );
  assert.deepEqual(
    tabs.map((tab) => /\bdata-route="([^"]+)"/.exec(tab)[1]),
    ['status', 'history', 'config', 'advanced'],
    'the router selects by these; a Settings screen is a route, not a tab',
  );
  assert.deepEqual(
    tabs.map((tab) => /<span>([^<]+)<\/span>/.exec(tab)[1].trim()),
    ['Status', 'History', 'Settings', 'Advanced'],
  );
  // The Settings tab keeps the id the guard's Stay refocuses and names the
  // one tabpanel the four screens are views inside.
  assert.match(openTag('tab-config'), / aria-controls="panel-config"/);
  assert.doesNotMatch(html, /id="tab-schedule"/);
  assert.doesNotMatch(html, /<span>(Config|Schedule)<\/span>/);
});

test('each Settings screen is a region named by its heading, with the way back above it', () => {
  const list = at('id="settings-list"');
  const config = at('id="panel-config"');
  assert.ok(config < list, 'the list is inside the Settings tabpanel');
  assert.match(openTag('panel-config'), /^<section /);
  assert.match(
    openTag('panel-config'),
    / role="tabpanel" aria-labelledby="tab-config" tabindex="0" hidden/,
  );

  let previous = list;
  for (const [route, heading, back, inside] of SCREENS) {
    const region = openTag(`panel-${route}`);
    assert.match(region, /^<section /, route);
    assert.match(region, / role="region"/, `${route} is a region`);
    assert.match(
      region,
      new RegExp(` aria-labelledby="${heading}"`),
      `${route} is named by its heading`,
    );
    assert.match(region, / tabindex="0" hidden/, `${route} can take focus and starts hidden`);
    const headingTag = openTag(heading);
    assert.match(headingTag, /^<h1 /, `${route}: one heading names the screen`);

    // Order inside the tabpanel: the list, then each screen in turn.
    const start = at(`id="panel-${route}"`);
    assert.ok(previous < start, `${route} follows the list or the screen before it`);
    previous = start;

    // The way back is the first control of the screen and sits above the heading.
    const first = html.slice(start).match(/<(a|button)\b[^>]*>/);
    assert.equal(first[0].replace(/\s+/g, ' '), back, `${route}: Back to Settings comes first`);
    const backAt = html.indexOf(back, start);
    const headingAt = html.indexOf(headingTag, start);
    assert.ok(
      start < backAt && backAt < headingAt,
      `${route}: the way back sits above the heading`,
    );
    const control = html.slice(backAt, headingAt);
    assert.match(control, /Back to Settings/, route);
    assert.doesNotMatch(
      control,
      /<(h[1-6]|input|form)\b/,
      `${route}: nothing between the way back and its heading`,
    );

    // The screen's own content moved with it.
    const next = SCREENS[(SCREENS.findIndex(([r]) => r === route) + 1) % SCREENS.length];
    const end = route === 'charger' ? at('id="panel-advanced"') : at(`id="panel-${next[0]}"`);
    for (const id of inside) {
      const position = at(`id="${id}"`);
      assert.ok(start < position && position < end, `${route}: #${id} is inside the screen`);
    }
  }
});

test('the Prices screen asks before its way back moves: the control is a button, not a link', () => {
  // A link would push #config before the guard could ask, and a Stay after a
  // pushed link strands a dead Back entry.
  const back = openTag('prices-back');
  assert.match(back, /^<button /);
  assert.match(back, / type="button"/);
  assert.doesNotMatch(back, /href=/);
  // The other three have no dirty state to guard and are ordinary links.
  assert.equal((html.match(/<a class="back-link" href="#config">/g) || []).length, 3);
  // Exactly one Back control per screen.
  assert.equal((html.match(/class="back-link"/g) || []).length, 4);
});

test('the form moved whole into the Prices screen, with the leave dialog inside it', () => {
  const prices = at('id="panel-prices"');
  const form = at('<form id="settings-form"');
  const dialog = at('id="leave-settings-confirm"');
  const formEnd = html.indexOf('</form>', form);
  const notifications = at('id="panel-notifications"');
  assert.ok(prices < form && form < dialog && dialog < formEnd && formEnd < notifications);
  const dialogTag = openTag('leave-settings-confirm');
  assert.match(dialogTag, / role="alertdialog"/);
  assert.match(dialogTag, / hidden/);
  // The sentence names the screen the form now lives on.
  assert.match(
    html,
    /You have unsaved changes\. Leaving Prices and charger address leaves them unsaved\./,
  );
  assert.doesNotMatch(html, /Leaving Config/);
  // The two cards share the one form and its one save.
  const body = html.slice(form, formEnd);
  for (const marker of [
    'class="card-block connection-card"',
    'id="setting-charger-host"',
    'class="card-block settings-card"',
    'id="setting-rate"',
    'id="setting-currency"',
    'id="rate-mode-confirm"',
    'id="save-settings"',
  ]) {
    assert.ok(body.includes(marker), `${marker} is inside the form`);
  }
  assert.equal((html.match(/id="save-settings"/g) || []).length, 1);
});

test('the list is four cards in the issue order, with nothing editable on it', () => {
  const list = openTag('settings-list');
  assert.match(list, / class="view settings-list"/);
  const start = at('id="settings-list"');
  const end = at('id="panel-schedule"');
  const body = html.slice(start, end);
  const cards = [...body.matchAll(/<a\b[^>]*class="card-block settings-item"[^>]*>[\s\S]*?<\/a>/g)];
  assert.equal(cards.length, 4);
  const expected = [
    ['schedule', 'Charge schedule'],
    ['prices', 'Prices and charger address'],
    ['notifications', 'Notifications'],
    ['charger', 'Charger'],
  ];
  cards.forEach((match, index) => {
    const card = match[0];
    const [route, title] = expected[index];
    assert.ok(card.includes(`id="settings-card-${route}"`), `${route}: card id`);
    assert.ok(card.includes(`href="#${route}"`), `${route}: the card opens its own screen`);
    assert.ok(
      card.includes(`<span class="settings-item-title">${title}</span>`),
      `${route}: title`,
    );
    assert.ok(card.includes(`id="settings-state-${route}"`), `${route}: state line`);
    // The router focuses the card by this id when the screen's way back is used.
    assert.ok(openTag(`settings-card-${route}`).includes(`href="#${route}"`), `${route}: one link`);
  });
  assert.match(body, /<h1>Settings<\/h1>/, "the list's heading (D5)");
  assert.doesNotMatch(
    body,
    /<(input|button|select|textarea|form)\b/,
    'nothing editable on the list',
  );
  assert.doesNotMatch(
    body,
    /id="(setting-|save-|notify-|config-)/,
    'no editor, form or snapshot on the list',
  );
});

test('History’s “Open settings” reaches the Prices screen', () => {
  assert.match(html, /<a href="#prices">Open settings<\/a>/);
  assert.doesNotMatch(html, /<a href="#config">/);
});

test('the screens keep the entry animation and every card tone has its colour', () => {
  // A Settings screen is a view inside the Settings tabpanel: without the
  // second selector its blocks would silently lose the rise every other
  // panel's have.
  const animation = css.slice(css.indexOf('.app-header,'), css.indexOf('@keyframes rise'));
  assert.match(animation, /\.panel:not\(\[hidden\]\) > :not\(\.view\),/);
  assert.match(animation, /\.panel:not\(\[hidden\]\) > \.view:not\(\[hidden\]\) > \* \{/);
  assert.match(animation, /animation-delay: calc\(var\(--i, 0\) \* 55ms\)/);
  // The tones js/settings-list.js returns are the ones the stylesheet knows.
  for (const tone of TONES.filter(Boolean)) {
    assert.match(css, new RegExp(`\\.settings-item-state\\[data-tone='${tone}'\\] \\{`), tone);
  }
  // The way back keeps a touch target.
  assert.match(css, /\.back-link \{[^}]*min-height: 44px;/);
});
