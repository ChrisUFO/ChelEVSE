import { test } from 'node:test';
import assert from 'node:assert/strict';

// The status screen renders into the live DOM. Give it the smallest document it
// needs — one stub element per id, with the class list the badge toggles — and
// import the module afterwards; every lookup is deferred to render time.
function stubElement() {
  const classes = new Set();
  const attrs = new Map();
  const listeners = new Map();
  // Style properties the screen writes (the slider's --fill), and the disabled
  // state the focus assertions depend on.
  const props = new Map();
  let disabled = false;
  const el = {
    classes,
    attrs,
    props,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    style: {
      setProperty(name, value) {
        props.set(name, String(value));
      },
    },
    textContent: '',
    title: '',
    hidden: false,
    value: '',
    children: [],
    focusCalls: 0,
    get disabled() {
      return disabled;
    },
    // A browser refuses to focus a disabled control, and drops focus from one
    // the moment it becomes unfocusable (down to <body>). The screen's focus
    // choices are exactly about surviving that, so the stub models both.
    set disabled(next) {
      disabled = Boolean(next);
      if (disabled && document.activeElement === el) document.activeElement = document.body;
    },
    replaceChildren(...nodes) {
      this.children = nodes;
      this.textContent = nodes.map((node) => node.textContent || '').join('');
    },
    append(...nodes) {
      this.children.push(...nodes);
      this.textContent += nodes.map((node) => node.textContent || '').join('');
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    dispatch(type) {
      for (const fn of listeners.get(type) || []) fn({ type });
    },
    focus() {
      this.focusCalls += 1;
      document.activeElement = this.disabled ? document.body : this;
    },
  };
  return el;
}

const elements = new Map();

function element(id) {
  let el = elements.get(id);
  if (!el) {
    el = stubElement();
    elements.set(id, el);
  }
  return el;
}

globalThis.document = {
  documentElement: { style: { setProperty() {} } },
  body: {},
  activeElement: null,
  getElementById: (id) => element(id),
  createElement: () => stubElement(),
  createTextNode: (text) => ({ textContent: text }),
};

// The held-window math prices local wall-clock hours; pin the zone so the
// fixtures mean the same thing here as in cost.test.js.
process.env.TZ = 'America/Denver';

const { showStatus, showSettings, showConfig, leaveStatus, initStatus } =
  await import('../../web/js/screens/status.js');

// The one init the page runs: it wires the click handlers and paints the
// controls' pre-snapshot state. Run it before any test, so the first test can
// assert that paint and the later click fixtures dispatch the real wiring.
initStatus();

function at(year, month, day, hours, minutes) {
  const ms = new Date(year, month - 1, day, hours, minutes).getTime();
  return { toMillis: () => ms };
}

function snapshot(overrides) {
  return {
    exists: () => true,
    data: () => ({
      state: 3,
      state_label: 'charging',
      charger_online: true,
      updated_at: at(2026, 1, 5, 3, 0),
      elapsed: 600,
      session_energy: 2000,
      amp: 16,
      pilot: 16,
      ...overrides,
    }),
  };
}

// The same fixtures cost.test.js prices: an off-peak 00:00–06:00 window over an
// all-day base, a base-less 16:00–19:00 window, and a flat config.
const NIGHTLY = {
  rate: 0.3,
  currency: 'GBP',
  rates: [
    {
      id: 'base',
      rate: 0.3,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '00:00',
      months: null,
    },
    {
      id: 'night',
      rate: 0.1,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '06:00',
      months: null,
    },
  ],
};
const WINDOW_ONLY = {
  rate: 0.3,
  currency: 'GBP',
  rates: [
    {
      id: 'peak',
      rate: 0.32,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '16:00',
      end: '19:00',
      months: null,
    },
  ],
};
const FLAT = { rate: 0.245, currency: 'GBP' };

const HOUR = 60 * 60 * 1000;
const cost = () => element('fig-cost').textContent;
const sub = () => element('cost-sub');

// Nothing may look usable before the capability is known: `current` stays null
// until showConfig applies a status/config snapshot, and the same path enables
// the controls once that snapshot verifies the limits.
test('current controls start disabled until a config snapshot is applied', () => {
  assert.equal(element('hold').disabled, true);
  assert.equal(element('amps').disabled, true);
  assert.equal(element('apply').disabled, true);
  // Stop and Auto need no limits, so first paint leaves them usable.
  assert.equal(element('pause').disabled, false);
  assert.equal(element('resume').disabled, false);

  showConfig({ hostname: 'x', max_current_soft: 16, max_current_hard: 24 });
  assert.equal(element('hold').disabled, false);
  assert.equal(element('amps').disabled, false);
  assert.equal(element('apply').disabled, false);
  assert.equal(element('pause').disabled, false);
  assert.equal(element('resume').disabled, false);
});

test('current controls fail closed while stop and auto remain available', () => {
  showConfig(null);
  assert.equal(element('hold').disabled, true);
  assert.equal(element('amps').disabled, true);
  assert.equal(element('apply').disabled, true);
  assert.equal(element('pause').disabled, false);
  assert.equal(element('resume').disabled, false);
});

// A dimmed control explains itself only through `title`, which the keyboard and
// most AT never reach. The visible note carries the reason instead, and the
// ordinary description returns with the capability.
test('the controls note says why the current controls are unavailable', () => {
  showConfig(null);
  assert.equal(element('controls-note').textContent, 'Hold needs the charger’s limits.');
  assert.equal(
    element('hold').title,
    'Current setting is unavailable until charger limits are verified.',
  );

  showConfig({ max_current_soft: 16, max_current_hard: 24 });
  assert.equal(
    element('controls-note').textContent,
    'Stop pauses charging · Auto returns to the schedule · Hold sets a current limit.',
  );
  assert.equal(element('hold').title, '');
});

test('verified config caps current and status pilot seeds the slider', () => {
  showStatus(snapshot({ pilot: 12 }));
  showConfig({ hostname: 'driveway', max_current_soft: 16, max_current_hard: 80 });
  assert.equal(element('hold').disabled, false);
  assert.equal(element('amps').min, '6');
  assert.equal(element('amps').max, '16');
  assert.equal(element('amps').value, 12);

  showStatus(snapshot({ pilot: 0 }));
  assert.equal(element('amps').value, 16, 'idle pilot falls back to the soft limit');

  showConfig({ max_current_soft: 25, max_current_hard: 24 });
  assert.equal(element('hold').disabled, true);
});

// A range whose ends meet has one value and no partial state: the track must
// read as fixed (full), not as 0% — "empty" — which is what a soft limit of
// 6 A used to paint.
test('a single-value slider reads as fixed instead of empty', () => {
  leaveStatus();
  showStatus(snapshot({ pilot: 6 }));
  showConfig({ max_current_soft: 6, max_current_hard: 6 });
  assert.equal(element('amps').min, '6');
  assert.equal(element('amps').max, '6');
  assert.equal(element('amps').props.get('--fill'), '100%', 'the only value fills the track');

  // Every other range keeps the plain ratio: 12 A across 6–16 A is 60%.
  showStatus(snapshot({ pilot: 12 }));
  showConfig({ max_current_soft: 16, max_current_hard: 16 });
  assert.equal(element('amps').props.get('--fill'), '60%');
});

test('the cost tile shows the live window while charging', () => {
  showSettings(NIGHTLY);
  // 1 kWh over the off-peak hour ending 03:00.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 3, 0), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.10');
  // The hour ending 06:30 straddles the boundary: half at each rate.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 6, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.20');
});

test('the figure freezes at the charging-stop anchor, never sliding', () => {
  showSettings(NIGHTLY);
  // Charging ended 06:30 (elapsed 3600): the figure on screen is GBP 0.20.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 6, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.20');
  // Charge complete, still plugged in: a newer write with pause time counted
  // into elapsed must neither re-price at the later clock (GBP 0.30) nor
  // stretch the frozen window with the newer elapsed (GBP 0.13).
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 8, 30),
      elapsed: 3 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
  // Hours of later polls keep the same figure and rate window.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 14, 30),
      elapsed: 8 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
});

test('an offline marker keeps the frozen figure without re-pricing it', () => {
  showSettings(NIGHTLY);
  // This test's own anchor: the charging write that freezes at GBP 0.20.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 6, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.20');
  // The bridge's offline marker refreshes updated_at while keeping the frozen
  // state/elapsed: the held figure must survive it unchanged.
  showStatus(
    snapshot({
      charger_online: false,
      updated_at: at(2026, 1, 5, 14, 30),
      elapsed: 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
});

test('a session reset clears the anchor and a new charge re-anchors', () => {
  showSettings(NIGHTLY);
  // This test's own anchor: without one, the reset below would assert nothing.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 14, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.30');
  // Energy zeroed: fresh idle state, the tile hides.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 15, 0),
      elapsed: 0,
      session_energy: 0,
    }),
  );
  assert.equal(cost(), '—');
  // A later paused-with-energy write finds no anchor (the screen saw no
  // charging write for it) and hides rather than guessing a window.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 15, 30),
      elapsed: 3600,
      session_energy: 2000,
    }),
  );
  assert.equal(cost(), '—');
  // A new charge prices its own live window from its own write.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 16, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.30');
  // And its stop freezes there.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 18, 0),
      elapsed: 2 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.30');
});

test('flat configs price the session energy with no anchor at all', () => {
  // This test's own session: a reset clears any anchor, and the cold-opened
  // paused write below is the session the flat path has to price.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 18, 30),
      elapsed: 0,
      session_energy: 0,
    }),
  );
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 19, 0),
      elapsed: 3 * 3600,
      session_energy: 1000,
    }),
  );
  // The flat path is energy x rate, byte-identical, shown for the whole
  // session without ever needing a write.
  showSettings(FLAT);
  assert.equal(cost(), 'GBP 0.25');
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 19, 30),
      elapsed: 3 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.25');
});

test('the understates-cost marker sits under the figure, live and held', () => {
  showSettings(WINDOW_ONLY);
  // The live hour ending 16:30 is half uncovered: the figure prices at 0.16
  // and carries the marker with its tooltip.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 16, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.16');
  assert.equal(sub().textContent, 'understates cost');
  assert.ok(sub().children[0].title.includes('no price'));
  // The stop keeps the frozen window, so it keeps the marker too.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 17, 30),
      elapsed: 2 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), 'GBP 0.16');
  assert.equal(sub().textContent, 'understates cost');
  // A fully covered live window drops the marker.
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 17, 0), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.32');
  assert.equal(sub().textContent, '');
  // A schedule with a base never marks.
  showSettings(NIGHTLY);
  showStatus(snapshot({ updated_at: at(2026, 1, 5, 12, 0), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.30');
  assert.equal(sub().textContent, '');
});

// ---------- cold-open adoption (the bridge's charging_stopped_at, #122) ----------

// A plugged-in-complete stop write as the bridge issues it: charging ended,
// the vehicle connected, `charging_stopped_at` frozen at the stop instant.
function stoppedSnapshot(overrides = {}) {
  return snapshot({
    state: 2,
    state_label: 'ready',
    updated_at: at(2026, 1, 5, 6, 30),
    elapsed: 3600,
    session_energy: 1000,
    charging_stopped_at: at(2026, 1, 5, 6, 30),
    ...overrides,
  });
}

// Each cold-open test starts from a left screen: no settings, no anchor —
// exactly the reload/sign-in the stamp exists for.
test('a cold open shows the frozen figure from the bridge stamp', () => {
  leaveStatus();
  showSettings(NIGHTLY);
  showStatus(stoppedSnapshot());
  // [05:30, 06:30] straddles the off-peak end: the figure a page open at
  // the stop would have frozen.
  assert.equal(cost(), 'GBP 0.20');
  // Later polls with the same stamp — idle heartbeats whose elapsed grew
  // with the pause — must not re-adopt: the stretched window would
  // re-price the same energy to GBP 0.13.
  showStatus(
    stoppedSnapshot({
      updated_at: at(2026, 1, 5, 14, 30),
      elapsed: 8 * 3600,
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
  // The offline marker keeps the adopted figure, never re-pricing it.
  showStatus(
    stoppedSnapshot({
      charger_online: false,
      updated_at: at(2026, 1, 5, 15, 0),
      elapsed: 8.5 * 3600,
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
});

test('a cold open without the stamp keeps today’s hide', () => {
  leaveStatus();
  showSettings(NIGHTLY);
  // An older or pre-deploy bridge: no field, no figure — exactly the
  // pre-#122 behaviour for a paused session the page never saw charging.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 8, 30),
      elapsed: 3 * 3600,
      session_energy: 1000,
    }),
  );
  assert.equal(cost(), '—');
  // A malformed stamp is as good as none.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 5, 8, 45),
      elapsed: 3 * 3600,
      session_energy: 1000,
      charging_stopped_at: null,
    }),
  );
  assert.equal(cost(), '—');
});

test('a captured anchor outranks the stamp across a witnessed stop', () => {
  leaveStatus();
  showSettings(NIGHTLY);
  // The page is open for this one: the charging write captures its own
  // anchor (05:30, elapsed 3600 → GBP 0.10 live).
  showStatus(snapshot({ updated_at: at(2026, 1, 6, 5, 30), elapsed: 3600, session_energy: 1000 }));
  assert.equal(cost(), 'GBP 0.10');
  // The stop write carries the stamp AND a pause-grown elapsed; the
  // captured anchor wins, so the figure stays 0.10 where adopting the
  // stamped pair would re-price to GBP 0.13.
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 6, 8, 30),
      elapsed: 3 * 3600,
      session_energy: 1000,
      charging_stopped_at: at(2026, 1, 6, 6, 30),
    }),
  );
  assert.equal(cost(), 'GBP 0.10');
});

test('a new charge after adoption goes live and its stop freezes fresh', () => {
  leaveStatus();
  showSettings(NIGHTLY);
  showStatus(stoppedSnapshot());
  assert.equal(cost(), 'GBP 0.20');
  // The next plug-in charges: the live window takes over from its own
  // write, stamp or no stamp. This snapshot still carries the previous
  // block's stamp — the bridge clears the field at interval open, up to
  // one observation cycle after the state edge — and neither the live
  // figure nor the later freeze may see it.
  showStatus(
    snapshot({
      updated_at: at(2026, 1, 6, 5, 30),
      elapsed: 600,
      session_energy: 1500,
      charging_stopped_at: at(2026, 1, 5, 6, 30),
    }),
  );
  assert.equal(cost(), 'GBP 0.15');
  // Its stop re-stamps: the frozen figure is this session's, not the old
  // adopted one (GBP 0.20) nor a stretched re-adoption (GBP 0.20).
  showStatus(
    snapshot({
      state: 2,
      state_label: 'ready',
      updated_at: at(2026, 1, 6, 8, 30),
      elapsed: 3 * 3600,
      session_energy: 1500,
      charging_stopped_at: at(2026, 1, 6, 6, 30),
    }),
  );
  assert.equal(cost(), 'GBP 0.15');
});

test('a session reset hides the adopted figure', () => {
  leaveStatus();
  showSettings(NIGHTLY);
  showStatus(stoppedSnapshot());
  assert.equal(cost(), 'GBP 0.20');
  // Counters zeroed (the vehicle left): the energy gate beats the stamp —
  // even one that has not been cleared yet — and the tile hides.
  showStatus(
    stoppedSnapshot({
      updated_at: at(2026, 1, 5, 9, 0),
      elapsed: 0,
      session_energy: 0,
    }),
  );
  assert.equal(cost(), '—');
  // A later stamped snapshot of a *fresh* session adopts its own stamp.
  showStatus(
    stoppedSnapshot({
      updated_at: at(2026, 1, 6, 6, 35),
      charging_stopped_at: at(2026, 1, 6, 6, 30),
    }),
  );
  assert.equal(cost(), 'GBP 0.20');
});

test('flat pricing is unaffected by the stop stamp', () => {
  leaveStatus();
  showSettings(FLAT);
  showStatus(stoppedSnapshot());
  // A cold-open stopped snapshot under a flat config still shows the flat
  // figure. This pins that the adoption machinery leaves the flat render
  // intact — not a renderCost branch reorder, which a schedule-free
  // config cannot detect (every pricing path returns the same energy x
  // rate figure; the schedule cold-open tests above are the load-bearing
  // reorder guards).
  assert.equal(cost(), 'GBP 0.25');
  // Later polls with the same stamp and a pause-grown elapsed stay flat.
  showStatus(
    stoppedSnapshot({
      updated_at: at(2026, 1, 5, 14, 30),
      elapsed: 8 * 3600,
    }),
  );
  assert.equal(cost(), 'GBP 0.25');
});

// ---------- Hold closes when Auto/Stop takes the mode ----------

// The click handlers live in initStatus, which already ran at the top of the
// file; the stub records them so a test can dispatch the same click the screen
// wires.

// A real click focuses its button before the handler runs, so the stub models
// that — the closing panel must not move focus off the button just pressed.
function click(id) {
  const el = element(id);
  el.focus();
  el.dispatch('click');
}

// A verified charger with the panel open, seeded from a 12 A pilot.
function openHold() {
  leaveStatus();
  showStatus(snapshot({ pilot: 12 }));
  showConfig({ hostname: 'x', max_current_soft: 16, max_current_hard: 24 });
  click('hold');
  assert.equal(element('hold-panel').hidden, false);
  assert.equal(element('hold').getAttribute('aria-expanded'), 'true');
}

// The fail-closed branch used to close the panel with focus on Hold, then
// disable Hold: the browser dropped focus to <body>. The close now leaves focus
// alone unless it displaced it, and then lands it on the panel the snapshot
// refilled — the shared Retry policy's target, never a command button a stray
// Space/Enter would fire.
test('an invalid config closes the panel and lands focus on the panel', () => {
  openHold();
  assert.equal(document.activeElement, element('amps'), 'the open panel owns focus');
  const holdFocus = element('hold').focusCalls;

  showConfig({ hostname: 'x', max_current_soft: 25, max_current_hard: 24 });
  assert.equal(element('hold-panel').hidden, true);
  assert.equal(element('hold').disabled, true);
  // The end-state check below cannot see this half: the browser's focus fix-up
  // and the redirect both end focus somewhere observable either way, so
  // reverting the no-focus close has to fail here.
  assert.equal(element('hold').focusCalls, holdFocus, 'the close must not focus Hold');
  assert.equal(document.activeElement, element('panel-status'), 'focus moves to the panel');
});

// The same rule every other snapshot follows: "Any snapshot moves nothing."
// A fail-closed config that displaces no focus — the owner resting on <body>,
// as after any click on non-focusable content — must not pull focus onto the
// command buttons.
test('a fail-closed config leaves focus where the owner left it', () => {
  leaveStatus();
  showConfig({ hostname: 'x', max_current_soft: 16, max_current_hard: 24 });
  document.activeElement = document.body;
  const pauseFocus = element('pause').focusCalls;
  const panelFocus = element('panel-status').focusCalls;
  showConfig(null);
  assert.equal(element('hold').disabled, true, 'the fail-closed render still ran');
  assert.equal(document.activeElement, document.body, 'focus stays where the owner left it');
  assert.equal(element('pause').focusCalls, pauseFocus, 'and Stop is never focused');
  assert.equal(element('panel-status').focusCalls, panelFocus, 'nor is the panel');

  // Same with the panel open and focus on the page rather than in the panel.
  openHold();
  document.activeElement = document.body;
  const pauseFocus2 = element('pause').focusCalls;
  const panelFocus2 = element('panel-status').focusCalls;
  showConfig({ hostname: 'x', max_current_soft: 25, max_current_hard: 24 });
  assert.equal(element('hold-panel').hidden, true, 'the panel still closes');
  assert.equal(document.activeElement, document.body, 'focus still stays put');
  assert.equal(element('pause').focusCalls, pauseFocus2, 'Stop is never focused');
  assert.equal(element('panel-status').focusCalls, panelFocus2, 'nor is the panel');
});

for (const [id, type] of [
  ['resume', 'auto'],
  ['pause', 'stop'],
]) {
  test(`${type} closes the hold panel, without stealing focus`, () => {
    openHold();
    const holdFocus = element('hold').focusCalls;
    const ampsFocus = element('amps').focusCalls;
    const pressFocus = element(id).focusCalls;
    click(id);
    assert.equal(element('hold-panel').hidden, true);
    assert.equal(element('hold').getAttribute('aria-expanded'), 'false');
    assert.equal(element('hold').focusCalls, holdFocus, 'the close must not focus Hold');
    assert.equal(element('amps').focusCalls, ampsFocus, 'the close must not focus the slider');
    assert.equal(element(id).focusCalls, pressFocus + 1, 'the pressed button keeps focus');
  });
}

test('set_current leaves the hold panel open', () => {
  openHold();
  click('apply');
  assert.equal(element('hold-panel').hidden, false);
  assert.equal(element('hold').getAttribute('aria-expanded'), 'true');
});

test('auto re-seeds the slider from the pilot on the next config render', () => {
  openHold();
  // The owner drags the panel's slider, then sends Auto: the drag must not be
  // the value the panel reopens with.
  element('amps').value = '20';
  element('amps').dispatch('input');
  click('resume');
  showConfig({ max_current_soft: 16, max_current_hard: 24, pilot: 12, hostname: 'x' });
  assert.equal(element('amps').value, 12, 'the pilot re-seeds, not the dragged value');
});
