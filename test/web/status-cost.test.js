import { test } from 'node:test';
import assert from 'node:assert/strict';

// The status screen renders into the live DOM. Give it the smallest document it
// needs — one stub element per id, with the class list the badge toggles — and
// import the module afterwards; every lookup is deferred to render time.
function stubElement() {
  const classes = new Set();
  return {
    classes,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    style: { setProperty() {} },
    textContent: '',
    title: '',
    hidden: false,
    value: '',
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes;
      this.textContent = nodes.map((node) => node.textContent || '').join('');
    },
    append(...nodes) {
      this.children.push(...nodes);
      this.textContent += nodes.map((node) => node.textContent || '').join('');
    },
    setAttribute() {},
    addEventListener() {},
    focus() {},
  };
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
  getElementById: (id) => element(id),
  createElement: () => stubElement(),
  createTextNode: (text) => ({ textContent: text }),
};

// The held-window math prices local wall-clock hours; pin the zone so the
// fixtures mean the same thing here as in cost.test.js.
process.env.TZ = 'America/Denver';

const { showStatus, showSettings, leaveStatus } = await import('../../web/js/screens/status.js');

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

// The Temperature stat's visibility follows settings/current.show_temperature
// (issue #117): absent = visible, only an explicit false hides the whole tile —
// average and T1–T3 — and the preference re-applies on every settings snapshot
// and every status render, so a toggle saved anywhere lands without a reload.
test('the temperature stat hides on show_temperature false and stays live', () => {
  const tempHidden = () => element('fig-temp-stat').hidden;

  // Visible by default: a document without the field renders today's page.
  showSettings(NIGHTLY);
  showStatus(snapshot({ temp_c: 21, temp1: 20, temp2: 22 }));
  assert.equal(tempHidden(), false);

  // A snapshot that hides it applies immediately, with no new status write.
  showSettings({ ...NIGHTLY, show_temperature: false });
  assert.equal(tempHidden(), true);

  // Every status render re-applies the preference: fresh telemetry must not
  // bring the tile back while it reads false.
  showStatus(snapshot({ temp_c: 23, temp1: 22, temp2: 24 }));
  assert.equal(tempHidden(), true);

  // An explicit true shows it; removing the key (the visible save omits it)
  // shows it too — both mean visible.
  showSettings({ ...NIGHTLY, show_temperature: true });
  assert.equal(tempHidden(), false);
  showSettings({ ...NIGHTLY, show_temperature: false });
  assert.equal(tempHidden(), true);
  showSettings(NIGHTLY);
  assert.equal(tempHidden(), false);

  // A corrupt value never hides the stat (normalizeSettings's absent = visible
  // contract, applied by the screen's own read of the raw document).
  showSettings({ ...NIGHTLY, show_temperature: 'false' });
  assert.equal(tempHidden(), false);
});

// leaveStatus resets the screen's own settings-derived state, so the next
// account's session starts from the visible default rather than carrying the
// previous one's hidden tile until its first settings snapshot lands.
test('leaving the status screen restores the temperature stat to visible', () => {
  const tempHidden = () => element('fig-temp-stat').hidden;

  showSettings({ ...NIGHTLY, show_temperature: false });
  assert.equal(tempHidden(), true);

  leaveStatus();
  assert.equal(tempHidden(), false);
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
  // write, stamp or no stamp.
  showStatus(snapshot({ updated_at: at(2026, 1, 6, 5, 30), elapsed: 600, session_energy: 1500 }));
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
