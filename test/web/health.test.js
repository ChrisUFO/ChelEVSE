import { test } from 'node:test';
import assert from 'node:assert/strict';

// The health card's whole state machine is this projection (#158), so it is
// driven here with no DOM and no Firebase: unknown versus known, the firmware
// gates, the three-fact presentation and the copy that must never turn a record
// into an emergency or a gap into health.
import {
  ACK_CONFIRM_MS,
  ACK_ID_MAX,
  HEALTH_STALE_AFTER_MS,
  acknowledgeableId,
  ackControlState,
  advisoryName,
  createAckTracker,
  dismissControlState,
  healthState,
} from '../../web/js/health.js';

// Local timestamps, so a fixture reads the same in every timezone (the date
// labels are local, like the rest of the app).
const at = (year, month, day, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();
const NOW = at(2026, 11, 16, 9, 30);
const seconds = (ms) => Math.floor(ms / 1000);
// A complete, quiet report: both gates closed, nothing listed. The document
// a current bridge writes (#186): it carries the ack capability fact.
const report = (overrides = {}) => ({
  reachable: true,
  source: 'http',
  checked_at: seconds(at(2026, 11, 16, 9, 15)),
  gates: { settings_known: true, relay_health_known: true },
  counters: { nogndcount: 0, gfcicount: 0, stuckcount: 0 },
  advisories: [],
  alerted: {},
  acks: {},
  ack_command: true,
  ...overrides,
});
const visit = (doc, extra = {}) => healthState({ doc, nowMs: NOW, ...extra });
const NO_FAULT_WORDING = /no faults|all clear|is safe|\bhealthy\b/i;
// "Safety checks aren't reported" is a fact about the report; a verdict
// about the charger is what this guards against.
const NO_SAFETY_CLAIM = /is safe|all clear|\bhealthy\b|no faults/i;

// Every string the card can show, flattened for the copy guards.
function copyOf(state) {
  return [
    state.title,
    state.detail,
    state.meta,
    state.caveat,
    ...state.advisories.flatMap((row) => [
      row.name,
      row.seen,
      row.presentationLabel,
      row.severityLabel,
    ]),
  ]
    .filter(Boolean)
    .join(' ');
}

test('an absent document is health unknown, never "no faults"', () => {
  for (const state of [visit(null), healthState({ nowMs: NOW }), healthState()]) {
    assert.equal(state.state, 'unknown');
    assert.equal(state.reason, 'absent');
    assert.equal(state.title, 'Health unknown');
    assert.match(state.detail, /hasn’t reported its health yet/);
    assert.equal(state.meta, '');
    assert.deepEqual(state.advisories, []);
    assert.doesNotMatch(copyOf(state), NO_FAULT_WORDING);
  }
});

test('an unreachable, unsupported or unreadable report is health unknown', () => {
  const unreachable = visit(report({ reachable: false }));
  assert.equal(unreachable.reason, 'unreachable');
  assert.equal(unreachable.title, 'Health unknown');
  assert.match(unreachable.detail, /couldn’t reach the charger/);

  const unsupported = visit(report({ source: 'unsupported', reachable: false }));
  assert.equal(unsupported.reason, 'unsupported');
  assert.match(unsupported.detail, /firmware doesn’t report health/);

  // A document that cannot positively say the check succeeded is not health:
  // the absent flag is exactly the silence the card must not read as good news.
  const unusable = visit(report({ reachable: undefined }));
  assert.equal(unusable.reason, 'unusable');
  assert.match(unusable.detail, /couldn’t be read/);

  for (const state of [unreachable, unsupported, unusable]) {
    assert.equal(state.state, 'unknown');
    assert.equal(state.tone, 'muted');
    assert.deepEqual(state.advisories, []);
    assert.doesNotMatch(copyOf(state), NO_FAULT_WORDING);
  }
});

test('a listener error is its own unknown, not a stale report', () => {
  // The screen drops the last projection when the listener fails, so a document
  // cannot ride along here either: the card never presents data as current that
  // no live listener stands behind.
  const state = healthState({ doc: report(), error: true, nowMs: NOW });
  assert.equal(state.state, 'unknown');
  assert.equal(state.reason, 'error');
  assert.equal(state.detail, 'Couldn’t load charger health.');
  assert.equal(state.meta, '');
  assert.deepEqual(state.advisories, []);
});

test('the 24 h guard bounds an ever-change document, not a heartbeat', () => {
  // The document is written only when the advisory projection changes, so a
  // stable, healthy charger writes nothing for days: just inside the guard it is
  // still the current report.
  const fresh = report({ checked_at: seconds(NOW - (HEALTH_STALE_AFTER_MS - 60_000)) });
  const known = visit(fresh);
  assert.equal(known.state, 'none');

  // Exactly at the bound is not yet older than it.
  const edge = visit(report({ checked_at: seconds(NOW - HEALTH_STALE_AFTER_MS) }));
  assert.equal(edge.state, 'none');

  const stale = visit(report({ checked_at: seconds(NOW - HEALTH_STALE_AFTER_MS - 1000) }));
  assert.equal(stale.state, 'unknown');
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.detail, 'The last health report is over a day old.');
  // The stamp of the report we cannot use is still worth showing — it is why the
  // card is unknown.
  assert.match(stale.meta, /^Checked 15 Nov$/);
  assert.doesNotMatch(copyOf(stale), NO_FAULT_WORDING);
});

test('a report with no usable check time is unknown, not trusted', () => {
  for (const checked_at of [undefined, null, 0, 'yesterday', { toMillis: () => NOW }]) {
    const state = visit(report({ checked_at }));
    assert.equal(state.state, 'unknown');
    assert.equal(state.reason, 'stale');
    assert.equal(state.detail, 'The last health report has no usable check time.');
    assert.equal(state.meta, '');
  }
});

test('a complete quiet report is neutral "no advisories", never green', () => {
  const state = visit(report());
  assert.equal(state.state, 'none');
  assert.equal(state.title, 'No advisories');
  assert.equal(state.detail, 'The charger’s last health check listed none.');
  assert.equal(state.tone, 'muted', 'a quiet report earns no colour');
  assert.equal(state.incomplete, false);
  assert.equal(state.caveat, '');
  assert.equal(state.meta, 'Checked 09:15');
  assert.doesNotMatch(copyOf(state), NO_FAULT_WORDING);
});

test('an empty list under an open gate is incomplete health, not health', () => {
  // `relay_health_known: false` is this charger's permanent state (8.2.3 has no
  // `$GL` block): the gateway never evaluates the wear/relay rules, so silence
  // proves nothing about them.
  const relay = visit(report({ gates: { settings_known: true, relay_health_known: false } }));
  assert.equal(relay.state, 'incomplete');
  assert.equal(relay.incomplete, true);
  assert.equal(relay.title, 'Health incomplete');
  assert.equal(relay.tone, 'warn');
  assert.equal(
    relay.detail,
    'Relay health isn’t reported, so some advisory checks may be missing.',
  );
  assert.equal(relay.caveat, '', 'the headline sentence is not repeated as a caveat');
  assert.notEqual(relay.title, 'No advisories');
  assert.doesNotMatch(copyOf(relay), /listed none/);

  const settings = visit(report({ gates: { settings_known: false, relay_health_known: true } }));
  assert.equal(settings.state, 'incomplete');
  assert.equal(
    settings.detail,
    'Safety checks aren’t reported, so some advisory checks may be missing.',
  );

  const both = visit(report({ gates: { settings_known: false, relay_health_known: false } }));
  assert.equal(
    both.detail,
    'Safety and relay checks aren’t reported, so some advisory checks may be missing.',
  );

  // A document that carries no gates at all evaluated nothing it can vouch for.
  const missing = visit(report({ gates: undefined }));
  assert.equal(missing.state, 'incomplete');
  assert.equal(missing.incomplete, true);
});

test('an open gate beside a listed advisory rides the caveat line', () => {
  const state = visit(
    report({
      gates: { settings_known: true, relay_health_known: false },
      advisories: [
        {
          id: 'fault.no_ground',
          severity: 'critical',
          acked: false,
          first_seen: seconds(at(2026, 11, 8)),
          classification: 'historical',
          corroborated: false,
        },
      ],
    }),
  );
  assert.equal(state.state, 'advisories');
  assert.equal(state.incomplete, true);
  assert.equal(
    state.caveat,
    'Relay health isn’t reported, so some advisory checks may be missing.',
  );
  assert.notEqual(state.detail, state.caveat, 'the gate sentence appears once, in one place');
  assert.equal(state.tone, 'warn');
});

test('a firmware that never reports relay health is a neutral fact, not an amber gap', () => {
  // `relay_health_supported: false` is the bridge's capability fact (#181):
  // this generation's silence is permanent, so the card says so plainly
  // instead of waiting for it forever.
  const state = visit(
    report({
      gates: { settings_known: true, relay_health_known: false, relay_health_supported: false },
    }),
  );
  assert.equal(state.state, 'incomplete');
  assert.equal(state.incomplete, true);
  assert.equal(state.title, 'Health incomplete');
  assert.equal(state.tone, 'muted', 'a capability fact is not a warning');
  assert.equal(state.detail, 'Relay health isn’t reported by this firmware.');
  assert.equal(state.caveat, '', 'the headline sentence is not repeated as a caveat');
  assert.notEqual(state.title, 'No advisories');
  assert.doesNotMatch(copyOf(state), /listed none|may be missing/);

  // An explicit `true` is "may report": today's amber gap, unchanged — as is
  // the field's absence everywhere else in this file.
  const mayReport = visit(
    report({
      gates: { settings_known: true, relay_health_known: false, relay_health_supported: true },
    }),
  );
  assert.equal(mayReport.tone, 'warn');
  assert.equal(
    mayReport.detail,
    'Relay health isn’t reported, so some advisory checks may be missing.',
  );

  // Data beats the table: a relay block that arrived closes the gate, and the
  // capability fact neither re-opens it nor appends its sentence.
  const known = visit(
    report({
      gates: { settings_known: true, relay_health_known: true, relay_health_supported: false },
    }),
  );
  assert.equal(known.state, 'none');
  assert.equal(known.caveat, '');
  assert.equal(known.tone, 'muted');
});

test('an unknown safety gate beside an unsupported relay gate warns on safety alone', () => {
  const state = visit(
    report({
      gates: { settings_known: false, relay_health_known: false, relay_health_supported: false },
    }),
  );
  assert.equal(state.state, 'incomplete');
  assert.equal(state.tone, 'warn', 'the safety gate is still an open question');
  assert.equal(
    state.detail,
    'Safety checks aren’t reported, so some advisory checks may be missing. Relay health isn’t reported by this firmware.',
  );
});

test('an unsupported relay gate rides the caveat line neutrally beside advisories', () => {
  const entry = {
    id: 'fault.no_ground',
    severity: 'critical',
    acked: false,
    first_seen: seconds(at(2026, 11, 8)),
    classification: 'historical',
    corroborated: false,
  };
  const state = visit(
    report({
      gates: { settings_known: true, relay_health_known: false, relay_health_supported: false },
      advisories: [entry],
    }),
  );
  assert.equal(state.state, 'advisories');
  assert.equal(state.incomplete, true);
  assert.equal(state.caveat, 'Relay health isn’t reported by this firmware.');
  assert.equal(state.tone, 'muted');

  // The same composition with the safety gate open too: the amber sentence
  // first, the neutral one appended — never merged into one amber claim.
  const mixed = visit(
    report({
      gates: { settings_known: false, relay_health_known: false, relay_health_supported: false },
      advisories: [entry],
    }),
  );
  assert.equal(mixed.state, 'advisories');
  assert.equal(mixed.tone, 'warn');
  assert.equal(
    mixed.caveat,
    'Safety checks aren’t reported, so some advisory checks may be missing. Relay health isn’t reported by this firmware.',
  );

  // An active corroborated advisory beside the unsupported gate keeps its
  // severity's tone: liveness outranks the capability fact, so the card is
  // never muted below a live condition while the caveat stays neutral.
  const active = visit(
    report({
      gates: { settings_known: true, relay_health_known: false, relay_health_supported: false },
      advisories: [{ ...entry, classification: 'active', corroborated: true }],
    }),
  );
  assert.equal(active.state, 'advisories');
  assert.equal(active.tone, 'err');
  assert.equal(active.caveat, 'Relay health isn’t reported by this firmware.');
});

test('a counter-derived critical is recorded, and stays critical', () => {
  // The live shape on this charger: `fault.no_ground` from a real trip, its
  // counter at 7, acknowledged on the gateway. The card must present a record —
  // severity verbatim, no emergency wording, and no tie to charging at all.
  const state = visit(
    report({
      gates: { settings_known: true, relay_health_known: false },
      counters: { nogndcount: 7, gfcicount: 0, stuckcount: 0 },
      advisories: [
        {
          id: 'fault.no_ground',
          category: 'fault',
          severity: 'critical',
          firmware_sticky: false,
          acked: true,
          first_seen: seconds(at(2026, 11, 8, 17, 12)),
          last_seen: seconds(at(2026, 11, 16, 9, 15)),
          classification: 'acknowledged',
          corroborated: false,
          counter_token: 7,
          first_observed: seconds(at(2026, 11, 13)),
        },
      ],
      acks: { 'fault.no_ground': seconds(at(2026, 11, 14)) },
    }),
  );
  assert.equal(state.state, 'advisories');
  assert.equal(state.counts.acknowledged, 1);
  const [row] = state.advisories;
  assert.equal(row.presentation, 'acknowledged');
  assert.equal(row.presentationLabel, 'Acknowledged');
  assert.equal(row.severity, 'critical', 'severity passes through verbatim');
  assert.equal(row.severityLabel, 'Critical');
  assert.equal(row.name, 'No ground');
  assert.equal(row.seen, 'First seen 8 Nov');
  assert.equal(state.title, '1 acknowledged advisory');
  assert.match(state.detail, /Acknowledged on the charger, kept here for the record/);
  // Nothing ties health to whether power is flowing, and nothing calls it fine.
  assert.doesNotMatch(copyOf(state), /charging|is safe|all clear|healthy|emergency/i);
});

test('an unacknowledged historical advisory reads as recorded, not active', () => {
  const state = visit(
    report({
      advisories: [
        {
          id: 'fault.no_ground',
          severity: 'critical',
          acked: false,
          first_seen: seconds(at(2026, 11, 8)),
          classification: 'historical',
          corroborated: false,
        },
      ],
    }),
  );
  const [row] = state.advisories;
  assert.equal(row.presentation, 'recorded');
  assert.equal(row.presentationLabel, 'Recorded');
  assert.equal(state.title, '1 recorded advisory');
  assert.equal(
    state.detail,
    'Recorded by the charger, not reported as present now.',
    'the record says what it is: an event, not a present condition',
  );
  assert.equal(state.tone, 'muted');
});

test('acks[<id>] counts as acknowledged before the next poll reports it', () => {
  // The ack command writes `acks.<id>` immediately; the gateway's own `acked`
  // flag only reaches this document at the next 300 s health poll (D5). An
  // entry the owner just acknowledged must read as acknowledged, not active.
  const entry = {
    id: 'thermal.high_temp',
    severity: 'warning',
    acked: false,
    first_seen: seconds(at(2026, 11, 15)),
    classification: 'active',
    corroborated: true,
  };
  const active = visit(report({ advisories: [entry] }));
  assert.equal(active.advisories[0].presentation, 'active');
  assert.equal(active.title, '1 active advisory');

  const acked = visit(report({ advisories: [entry], acks: { 'thermal.high_temp': 1794875072 } }));
  assert.equal(acked.advisories[0].presentation, 'acknowledged');
  assert.equal(acked.counts.acknowledged, 1);
  // A differently-keyed ack leaves it alone.
  const other = visit(report({ advisories: [entry], acks: { 'fault.no_ground': 1794875072 } }));
  assert.equal(other.advisories[0].presentation, 'active');
});

test('rows order active first (worst severity), then records newest-first, acked last', () => {
  const row = (id, classification, firstSeen, extra = {}) => ({
    id,
    severity: 'info',
    acked: false,
    first_seen: seconds(firstSeen),
    classification,
    corroborated: classification === 'active',
    ...extra,
  });
  const state = visit(
    report({
      advisories: [
        row('wear.relay_life', 'historical', at(2026, 10, 1)),
        row('safety.vent_check', 'active', at(2026, 11, 10), { severity: 'warning' }),
        row('fault.no_ground', 'acknowledged', at(2026, 11, 2)),
        row('fault.stuck_relay', 'active', at(2026, 11, 12), { severity: 'critical' }),
        row('wear.relay_cold_open', 'historical', at(2026, 11, 14)),
      ],
    }),
  );
  assert.deepEqual(
    state.advisories.map((entry) => entry.id),
    [
      'fault.stuck_relay', // active, critical
      'safety.vent_check', // active, warning
      'wear.relay_cold_open', // record, newest first
      'wear.relay_life',
      'fault.no_ground', // acknowledged last
    ],
  );
  assert.deepEqual(state.counts, { active: 2, recorded: 2, acknowledged: 1 });
  assert.equal(state.state, 'advisories');
  // A live critical drives the card's marker; the records stay as they are.
  assert.equal(state.tone, 'err');
  assert.equal(state.severity, undefined);
});

test('a mixed list counts each class and names their totals', () => {
  const state = visit(
    report({
      advisories: [
        {
          id: 'safety.ground_check',
          severity: 'critical',
          acked: false,
          first_seen: seconds(at(2026, 11, 12)),
          classification: 'active',
          corroborated: true,
        },
        {
          id: 'wear.relay_life',
          severity: 'warning',
          acked: false,
          first_seen: seconds(at(2026, 10, 20)),
          classification: 'historical',
          corroborated: false,
        },
        {
          id: 'fault.stuck_relay',
          severity: 'critical',
          acked: true,
          first_seen: seconds(at(2026, 9, 2)),
          classification: 'acknowledged',
        },
      ],
    }),
  );
  assert.equal(state.title, '3 advisories');
  assert.equal(state.detail, '1 active, 1 recorded, 1 acknowledged.');
  assert.equal(state.tone, 'err');
});

test('an active advisory with no usable severity is present, at warning weight', () => {
  const state = visit(
    report({
      advisories: [
        {
          id: 'future.unknown_rule',
          severity: undefined,
          acked: false,
          classification: 'active',
          corroborated: true,
        },
      ],
    }),
  );
  const [row] = state.advisories;
  assert.equal(row.presentation, 'active');
  assert.equal(row.severityLabel, '', 'no invented rating');
  assert.equal(row.name, 'Unknown rule', 'an unknown id still gets a readable name');
  assert.equal(state.tone, 'warn');
});

test('a missing classification falls back to the corroboration fact', () => {
  const bare = visit(
    report({ advisories: [{ id: 'fault.no_ground', severity: 'critical', acked: false }] }),
  );
  assert.equal(bare.advisories[0].presentation, 'recorded');
  const corroborated = visit(
    report({
      advisories: [
        { id: 'fault.no_ground', severity: 'critical', acked: false, corroborated: true },
      ],
    }),
  );
  assert.equal(corroborated.advisories[0].presentation, 'active');
});

test('advisory names cover the firmware rules and fall back to the id', () => {
  assert.equal(advisoryName('fault.gfci_tripped'), 'GFCI tripped');
  assert.equal(advisoryName('wear.stuck_relay_recovery'), 'Stuck relay recovery');
  assert.equal(advisoryName('thermal.high_temp'), 'High temperature');
  assert.equal(advisoryName('notifications_list_full'), 'Notifications list full');
  assert.equal(advisoryName(''), 'Advisory');
  assert.equal(advisoryName(undefined), 'Advisory');
});

test('the check stamp is a clock time today and a date once ambiguous', () => {
  const today = visit(report({ checked_at: seconds(at(2026, 11, 16, 7, 5)) }));
  assert.equal(today.meta, 'Checked 07:05');
  const yesterday = visit(report({ checked_at: seconds(at(2026, 11, 15, 22, 40)) }));
  assert.equal(yesterday.meta, 'Checked 15 Nov');
  const lastYear = visit(report({ checked_at: seconds(at(2025, 12, 30, 8, 0)) }));
  assert.equal(lastYear.meta, 'Checked 30 Dec 2025');
});

test('every state exposes the same shape for the screen to paint', () => {
  const states = [
    visit(null),
    healthState({ error: true, nowMs: NOW }),
    visit(report()),
    visit(report({ gates: { settings_known: false, relay_health_known: false } })),
    visit(
      report({
        advisories: [
          {
            id: 'fault.no_ground',
            severity: 'critical',
            acked: false,
            classification: 'historical',
          },
        ],
      }),
    ),
  ];
  for (const state of states) {
    for (const key of ['state', 'tone', 'title', 'detail', 'meta', 'caveat']) {
      assert.equal(typeof state[key], 'string', `${key} is a string in ${state.state}`);
    }
    assert.ok(
      state.reason === null || typeof state.reason === 'string',
      'reason names the unknown case, or is null when the report is known',
    );
    assert.equal(typeof state.incomplete, 'boolean');
    assert.ok(Array.isArray(state.advisories));
    assert.deepEqual(Object.keys(state.counts).sort(), ['acknowledged', 'active', 'recorded']);
    // The records the screen keeps: a map on a usable report, `null` on an
    // unknown state — never a missing key, never an array (#205).
    assert.ok(
      state.dismissals === null ||
        (typeof state.dismissals === 'object' &&
          !Array.isArray(state.dismissals) &&
          Object.getPrototypeOf(state.dismissals) === Object.prototype),
      `${state.state} answers dismissals with a map or null`,
    );
    assert.ok(['unknown', 'incomplete', 'none', 'advisories'].includes(state.state));
    assert.ok(['muted', 'warn', 'err', 'accent'].includes(state.tone));
    assert.doesNotMatch(copyOf(state), NO_SAFETY_CLAIM, `${state.state} makes no safety claim`);
  }
});

// ---------- acknowledgement (#158, PR-6) ----------
//
// The control is a projection fact plus a small DOM-free state machine, so both
// halves are driven here: what a row offers, and what a click settles into. The
// successful click is proved by the snapshot alone — nothing in this module can
// mark an advisory acknowledged on its own.

// The live shape on this charger: one counter-derived critical, not muted.
const RECORDED = {
  id: 'fault.no_ground',
  severity: 'critical',
  acked: false,
  first_seen: seconds(at(2026, 11, 8)),
  classification: 'historical',
  corroborated: false,
};
const recordedRow = () => visit(report({ advisories: [RECORDED] })).advisories[0];

// A tracker bound to fake timers and a controllable write, so the bounded wait
// and the generation guard are exercised without a clock.
function trackerHarness({ write, ...rest } = {}) {
  const timers = [];
  const writes = [];
  const repaints = [];
  const tracker = createAckTracker({
    write: (id) => {
      writes.push(id);
      // The default write never settles: the attempt stays in flight.
      return write ? write(id) : new Promise(() => {});
    },
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer) timer.cancelled = true;
    },
    onChange: (id) => repaints.push(id),
    ...rest,
  });
  return { tracker, timers, writes, repaints };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the acknowledgement id grammar is the bridge’s own', () => {
  for (const id of [
    'a',
    'fault.no_ground',
    'safety.ground_check',
    'notifications_list_full',
    'a.b.c',
    'a'.repeat(ACK_ID_MAX),
  ]) {
    assert.equal(acknowledgeableId(id), true, id);
  }
  for (const id of [
    '',
    'Fault.no_ground',
    'fault..no_ground',
    '.fault',
    'fault.',
    'fault no_ground',
    '1fault',
    '_fault',
    'fault.no-ground',
    // Trailing line terminators: the bridge's `\Z`, the rules' RE2 `$` and
    // JavaScript's `$` are all end-of-input, so none of the four may pass
    // (PR #177 pinned the same set on the bridge/rules side).
    'fault.no_ground\n',
    'fault.no_ground\r',
    'fault.no_ground\u2028',
    'fault.no_ground\u2029',
    'a'.repeat(ACK_ID_MAX + 1),
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(acknowledgeableId(id), false, String(id));
  }
});

test('only an unacknowledged advisory with a usable id offers the control', () => {
  assert.equal(recordedRow().canAcknowledge, true);
  // Already muted: nothing left to do.
  assert.equal(
    visit(report({ advisories: [{ ...RECORDED, acked: true, classification: 'acknowledged' }] }))
      .advisories[0].canAcknowledge,
    false,
  );
  // The command's own record counts before the next poll reports it (D5).
  assert.equal(
    visit(report({ advisories: [RECORDED], acks: { 'fault.no_ground': 1794875072 } })).advisories[0]
      .canAcknowledge,
    false,
  );
  // An ack for another advisory does not mute this one.
  assert.equal(
    visit(report({ advisories: [RECORDED], acks: { 'thermal.high_temp': 1794875072 } }))
      .advisories[0].canAcknowledge,
    true,
  );
  // An id the bridge would refuse offers a control that could only fail.
  assert.equal(
    visit(report({ advisories: [{ ...RECORDED, id: 'Fault.No_Ground' }] })).advisories[0]
      .canAcknowledge,
    false,
  );
  // Unknown health lists no advisories, so it offers nothing at all.
  assert.deepEqual(visit(null).advisories, []);
  assert.deepEqual(visit(report({ reachable: false })).advisories, []);
  assert.deepEqual(visit(report({ advisories: [RECORDED] }), { error: true }).advisories, []);
});

test('the control is fail-closed on the bridge’s ack_command capability', () => {
  // Deploy skew (#159): a web deploy ahead of its bridge reads a document
  // with no `ack_command` — an older bridge cannot perform the command the
  // control writes, so every row hides it rather than offering a button
  // that could only fail. Only an explicit `true` shows it.
  const legacy = report({ advisories: [RECORDED] });
  delete legacy.ack_command; // the exact shape an older bridge leaves
  for (const state of [
    visit(legacy),
    visit(report({ advisories: [RECORDED], ack_command: undefined })),
    visit(report({ advisories: [RECORDED], ack_command: null })),
    visit(report({ advisories: [RECORDED], ack_command: false })),
    visit(report({ advisories: [RECORDED], ack_command: 'true' })),
  ]) {
    assert.equal(state.advisories[0].canAcknowledge, false);
    // The control shape the screen paints follows, and even a synthetic row
    // handed straight to the tracker can start no write.
    assert.equal(ackControlState(state.advisories[0]).show, false);
    const tracker = createAckTracker({ write: () => Promise.resolve({}) });
    assert.equal(tracker.start(state.advisories[0]), false);
  }

  assert.equal(visit(report({ advisories: [RECORDED] })).advisories[0].canAcknowledge, true);

  // The firmware-level gate stands regardless of the capability fact: an
  // unsupported source lists no advisories at all, so nothing offers a
  // control on firmware that cannot report health.
  assert.deepEqual(visit(report({ source: 'unsupported' })).advisories, []);
});

test('the control reads idle, busy, then the bridge’s reason — never “acknowledged”', () => {
  const row = recordedRow();
  assert.deepEqual(ackControlState(row), {
    show: true,
    busy: false,
    disabled: false,
    label: 'Acknowledge',
    ariaLabel: 'Acknowledge No ground',
    message: '',
  });

  // Busy: disabled, labelled, and no stale reason under a live attempt.
  const busy = ackControlState(row, { pending: true, failure: { kind: 'send' } });
  assert.equal(busy.busy, true);
  assert.equal(busy.disabled, true);
  assert.equal(busy.label, 'Acknowledging…');
  assert.equal(busy.ariaLabel, 'Acknowledging No ground');
  assert.equal(busy.message, '');

  // The bridge's own reason, in the owner's words where it has a plain one.
  const message = (failure) => ackControlState(row, { failure }).message;
  assert.equal(
    message({ kind: 'command', reason: 'no such active notification' }),
    'Not acknowledged — the charger no longer lists this advisory.',
  );
  assert.equal(
    message({ kind: 'command', reason: 'invalid notification id' }),
    'Not acknowledged — the charger wouldn’t accept this advisory’s id.',
  );
  // An unmapped reason is passed through: it is more specific than a generic line.
  assert.equal(
    message({ kind: 'command', reason: 'acknowledgement refused by the charger (HTTP 403)' }),
    'Not acknowledged — acknowledgement refused by the charger (HTTP 403).',
  );
  assert.equal(message({ kind: 'command' }), 'Not acknowledged — the charger didn’t say why.');
  assert.equal(message({ kind: 'send' }), 'Couldn’t send — check your connection and try again.');
  assert.equal(
    message({ kind: 'timeout' }),
    'The charger didn’t confirm the acknowledgement in time.',
  );
  assert.equal(
    message({ kind: 'late' }),
    'The charger acknowledged it; this screen hasn’t caught up yet.',
  );

  // A row that offers no control paints nothing, whatever the state says.
  const acked = visit(report({ advisories: [{ ...RECORDED, acked: true }] })).advisories[0];
  const none = ackControlState(acked, { pending: true });
  assert.equal(none.show, false);
  assert.equal(none.label, '');
  assert.equal(none.message, '');
});

test('a click writes one command, and a second click while it is in flight writes nothing', () => {
  const { tracker, writes, repaints } = trackerHarness();
  const row = recordedRow();

  assert.equal(tracker.start(row), true);
  assert.deepEqual(
    writes,
    ['fault.no_ground'],
    'the id is the only payload detail the tracker owns',
  );
  // The card is busy before the write leaves, so the row repaints disabled.
  assert.equal(tracker.state(row.id).pending, true);
  assert.equal(ackControlState(row, tracker.state(row.id)).disabled, true);

  assert.equal(tracker.start(row), false);
  assert.equal(writes.length, 1, 'the double click cannot write twice');
  assert.deepEqual(repaints, [row.id], 'one repaint, from the accepted click');

  // Nothing else can start an attempt.
  assert.equal(tracker.start({ ...row, canAcknowledge: false }), false);
  assert.equal(tracker.start({ ...row, id: 'Fault.No_Ground' }), false);
  assert.equal(tracker.start(null), false);
  assert.equal(tracker.start(undefined), false);
  assert.equal(writes.length, 1);
  tracker.reset();
});

test('the snapshot is the success signal: it ends the wait, and the row flips', () => {
  const { tracker, timers } = trackerHarness();
  const row = recordedRow();
  tracker.start(row);

  const acked = visit(
    report({ advisories: [{ ...RECORDED, acked: true, classification: 'acknowledged' }] }),
  );
  tracker.snapshot(acked.advisories);

  assert.equal(tracker.state(row.id).pending, false);
  assert.equal(tracker.state(row.id).failure, null);
  assert.equal(timers[0].cancelled, true, 'the bounded wait is over');
  assert.equal(acked.advisories[0].presentationLabel, 'Acknowledged');
  assert.equal(ackControlState(acked.advisories[0]).show, false);
  tracker.reset();
});

test('a snapshot that still reports the condition leaves the wait running', () => {
  // No optimistic flip in either direction: only an acknowledged listing ends it.
  const { tracker, timers } = trackerHarness();
  const row = recordedRow();
  tracker.start(row);
  tracker.snapshot(visit(report({ advisories: [RECORDED] })).advisories);
  assert.equal(tracker.state(row.id).pending, true);
  assert.equal(timers[0].cancelled, false);
  assert.equal(row.presentation, 'recorded');
  tracker.reset();
});

test('a failed command carries the bridge’s reason and never acknowledges the row', async () => {
  const { tracker } = trackerHarness({ write: () => Promise.resolve({ id: 'cmd-1' }) });
  const row = recordedRow();
  tracker.start(row);
  await flush();

  tracker.command([{ id: 'cmd-1', status: 'failed', error: 'no such active notification' }]);

  const state = tracker.state(row.id);
  assert.equal(state.pending, false);
  assert.deepEqual(state.failure, { kind: 'command', reason: 'no such active notification' });
  assert.equal(
    ackControlState(row, state).message,
    'Not acknowledged — the charger no longer lists this advisory.',
  );
  // The row itself is untouched: still recorded, still offering the control.
  assert.equal(row.presentation, 'recorded');
  assert.equal(row.canAcknowledge, true);
  tracker.reset();
});

test('a rejected write and a lapsed wait both fail without flipping the row', async () => {
  const rejected = trackerHarness({ write: () => Promise.reject(new Error('offline')) });
  const row = recordedRow();
  rejected.tracker.start(row);
  await flush();
  assert.deepEqual(rejected.tracker.state(row.id).failure, { kind: 'send' });
  assert.equal(row.presentation, 'recorded');
  rejected.tracker.reset();

  const timed = trackerHarness();
  timed.tracker.start(row);
  assert.equal(timed.timers[0].ms, ACK_CONFIRM_MS, 'the wait is the card’s own bound');
  timed.timers[0].fn();
  assert.deepEqual(timed.tracker.state(row.id).failure, { kind: 'timeout' });
  assert.equal(timed.timers[0].cancelled, true);
  assert.equal(row.presentation, 'recorded');
  timed.tracker.reset();
});

test('an acknowledgement the snapshot never shows is reported honestly', async () => {
  // The charger accepted it (the command is `acked`) but the health document has
  // not caught up: the wait lapses and says exactly that, rather than claiming
  // the charger refused it.
  const { tracker, timers } = trackerHarness({ write: () => Promise.resolve({ id: 'cmd-2' }) });
  const row = recordedRow();
  tracker.start(row);
  await flush();
  tracker.command([{ id: 'cmd-2', status: 'acked' }]);
  assert.equal(tracker.state(row.id).pending, true, 'the snapshot is still what flips the row');

  timers[0].fn();
  const state = tracker.state(row.id);
  assert.deepEqual(state.failure, { kind: 'late' });
  assert.match(
    ackControlState(row, state).message,
    /The charger acknowledged it; this screen hasn’t caught up yet\./,
  );
  tracker.reset();
});

test('a stale completion cannot repaint a newer attempt', async () => {
  // Attempt 1's write, held open so it can land after attempt 1 has timed out.
  const pendingWrites = [];
  const { tracker, timers } = trackerHarness({
    write: () =>
      new Promise((resolve) => {
        pendingWrites.push(resolve);
      }),
  });
  const row = recordedRow();

  tracker.start(row);
  timers[0].fn();
  assert.deepEqual(tracker.state(row.id).failure, { kind: 'timeout' });

  // A second click after the failure is a fresh attempt.
  assert.equal(tracker.start(row), true);
  assert.equal(tracker.state(row.id).pending, true);
  assert.equal(tracker.state(row.id).failure, null);

  // Attempt 1's write finally lands: it must not settle attempt 2, and its
  // document id must not become attempt 2's.
  pendingWrites[0]({ id: 'stale-cmd' });
  await flush();
  assert.equal(tracker.state(row.id).pending, true);
  assert.equal(tracker.state(row.id).failure, null);
  tracker.command([{ id: 'stale-cmd', status: 'failed', error: 'no such active notification' }]);
  assert.equal(tracker.state(row.id).pending, true, 'the stale command does not settle it');

  // Attempt 2's own document does.
  pendingWrites[1]({ id: 'fresh-cmd' });
  await flush();
  tracker.command([{ id: 'fresh-cmd', status: 'failed', error: 'invalid notification id' }]);
  assert.equal(tracker.state(row.id).pending, false);
  assert.deepEqual(tracker.state(row.id).failure, {
    kind: 'command',
    reason: 'invalid notification id',
  });
  tracker.reset();
});

test('reset cancels a wait and forgets the attempt', () => {
  const { tracker, timers } = trackerHarness();
  const row = recordedRow();
  tracker.start(row);
  tracker.reset();
  assert.equal(timers[0].cancelled, true);
  assert.equal(tracker.state(row.id).pending, false);
  // A fresh attempt after a reset is accepted again.
  assert.equal(tracker.start(row), true);
  tracker.reset();
});

// ---------- dismissal (#205) ----------
//
// A dismissal record hides a row while the severity it names is the one the
// snapshot reports; it is retired when a usable report stops listing the id or
// lists it at another severity, and never on an unknown state. The records
// themselves are health-dismissals.js's business
// (test/web/health-dismissals.test.js); what is pinned here is what the one
// pass that builds the card does with them.

const T0 = 1794876000000;
const record = (severity) => ({ severity, dismissedAt: T0 });
// One row of each presentation: an active critical, the recorded critical
// from above, and an acknowledged warning.
const ACTIVE = {
  id: 'fault.stuck_relay',
  severity: 'critical',
  acked: false,
  first_seen: seconds(at(2026, 11, 12)),
  classification: 'active',
  corroborated: true,
};
const ACKED = {
  id: 'thermal.high_temp',
  severity: 'warning',
  acked: true,
  first_seen: seconds(at(2026, 11, 2)),
  classification: 'acknowledged',
  corroborated: false,
};
const threeRows = () => report({ advisories: [ACTIVE, RECORDED, ACKED] });
const ids = (state) => state.advisories.map((row) => row.id);

test('a record hides its row while the severity is unchanged, whatever its presentation', () => {
  assert.deepEqual(ids(visit(threeRows())), [
    'fault.stuck_relay',
    'fault.no_ground',
    'thermal.high_temp',
  ]);
  // No records at all: the input is optional and the answer is an empty map.
  assert.deepEqual(visit(threeRows()).dismissals, {});

  // Active, recorded and acknowledged alike.
  const active = visit(threeRows(), { dismissals: { 'fault.stuck_relay': record('critical') } });
  assert.deepEqual(ids(active), ['fault.no_ground', 'thermal.high_temp']);

  const recorded = visit(threeRows(), {
    dismissals: { 'fault.no_ground': record('critical') },
  });
  assert.deepEqual(ids(recorded), ['fault.stuck_relay', 'thermal.high_temp']);

  const acked = visit(threeRows(), {
    dismissals: { 'thermal.high_temp': record('warning') },
  });
  assert.deepEqual(ids(acked), ['fault.stuck_relay', 'fault.no_ground']);

  // Several at once, and the survivors keep their order.
  const both = visit(threeRows(), {
    dismissals: { 'fault.no_ground': record('critical'), 'thermal.high_temp': record('warning') },
  });
  assert.deepEqual(ids(both), ['fault.stuck_relay']);

  // A record for an advisory this snapshot does not list hides nothing.
  const elsewhere = visit(threeRows(), {
    dismissals: { 'wear.relay_life': record('info') },
  });
  assert.equal(elsewhere.advisories.length, 3);
});

test('a record that does not name the row’s severity hides nothing', () => {
  // The row is shown again — and dismissible again — the moment the firmware
  // rates the condition differently: that is the resurface rule.
  const worsened = visit(threeRows(), {
    dismissals: { 'fault.no_ground': record('warning') },
  });
  assert.deepEqual(ids(worsened), ['fault.stuck_relay', 'fault.no_ground', 'thermal.high_temp']);
  assert.equal(worsened.advisories[1].canAcknowledge, true);
  assert.equal(dismissControlState(worsened.advisories[1]).show, true);
  assert.equal(worsened.title, '3 advisories');

  // A record with no severity, or not a record, is not a match either.
  const shapeless = visit(threeRows(), { dismissals: { 'fault.no_ground': { dismissedAt: T0 } } });
  assert.equal(shapeless.advisories.length, 3);
});

test('a record is retired by a severity change, not kept for a return to it', () => {
  // The keying is id + severity, so the record says "this advisory, at this
  // rating, is dealt with" — and it lasts only while it hides a row. The
  // moment the snapshot lists the id at another rating the advisory has
  // changed: it is shown, and its record goes with the report that shows it.
  // So a condition that changes and then returns to the dismissed rating is
  // shown too, until the owner dismisses it again. Pinned so that it is a
  // decision, not an accident.
  const records = { 'fault.no_ground': record('critical') };
  // The same ring, with the firmware now rating that advisory `warning`.
  const changed = visit(
    report({ advisories: [ACTIVE, { ...RECORDED, severity: 'warning' }, ACKED] }),
    { dismissals: records },
  );
  assert.deepEqual(
    ids(changed),
    ['fault.stuck_relay', 'fault.no_ground', 'thermal.high_temp'],
    'the changed advisory is listed again',
  );
  assert.deepEqual(changed.dismissals, {}, 'and its record is retired on that report');
  // The input is never mutated: the screen keeps owning the map it passed.
  assert.deepEqual(records, { 'fault.no_ground': record('critical') });

  // Back at the dismissed severity without having left the ring: nothing is
  // left to hide it with, and it offers Dismiss again.
  const back = visit(threeRows(), { dismissals: changed.dismissals });
  assert.deepEqual(ids(back), ['fault.stuck_relay', 'fault.no_ground', 'thermal.high_temp']);
  assert.equal(back.title, '3 advisories');
  assert.equal(dismissControlState(back.advisories[1]).show, true);
});

test('absence retires the record, and the projection answers the pruned map', () => {
  // Pruning runs against every id the snapshot lists — including the rows a
  // record hides, so a dismissed row is not "absent" merely because it is
  // hidden.
  const records = {
    'fault.stuck_relay': record('critical'),
    'fault.no_ground': record('critical'),
    'thermal.high_temp': record('warning'),
    'wear.relay_life': record('info'),
  };
  const allHidden = visit(threeRows(), { dismissals: records });
  assert.deepEqual(allHidden.advisories, []);
  assert.deepEqual(allHidden.dismissals, {
    'fault.stuck_relay': record('critical'),
    'fault.no_ground': record('critical'),
    'thermal.high_temp': record('warning'),
  });
  // The input is never mutated: the screen keeps owning the map it passed.
  assert.deepEqual(Object.keys(records), [
    'fault.stuck_relay',
    'fault.no_ground',
    'thermal.high_temp',
    'wear.relay_life',
  ]);

  // One leaves the ring: its record goes with it, so a later re-listing shows.
  const gone = visit(report({ advisories: [RECORDED, ACKED] }), {
    dismissals: allHidden.dismissals,
  });
  assert.deepEqual(Object.keys(gone.dismissals), ['fault.no_ground', 'thermal.high_temp']);
  const relisted = visit(threeRows(), { dismissals: gone.dismissals });
  assert.deepEqual(ids(relisted), ['fault.stuck_relay']);

  // A quiet, complete report retires everything: nothing is listed.
  const quiet = visit(report(), { dismissals: gone.dismissals });
  assert.deepEqual(quiet.dismissals, {});
  assert.equal(quiet.state, 'none');
});

test('a new advisory id is shown whatever was dismissed before', () => {
  const records = {
    'fault.stuck_relay': record('critical'),
    'fault.no_ground': record('critical'),
    'thermal.high_temp': record('warning'),
  };
  const state = visit(
    report({
      advisories: [
        ACTIVE,
        RECORDED,
        ACKED,
        { ...ACTIVE, id: 'safety.vent_check', severity: 'warning' },
      ],
    }),
    {
      dismissals: records,
    },
  );
  assert.deepEqual(ids(state), ['safety.vent_check']);
  assert.equal(state.title, '1 active advisory');
  assert.equal(dismissControlState(state.advisories[0]).ariaLabel, 'Dismiss Vent check');
});

test('a dismissed row leaves the counts, the summary, the tone and the state', () => {
  const whole = visit(threeRows());
  assert.equal(whole.title, '3 advisories');
  assert.equal(whole.detail, '1 active, 1 recorded, 1 acknowledged.');
  assert.equal(whole.tone, 'err');

  // The live critical gone: nothing live is left, so the marker is muted and
  // the summary counts two.
  const active = visit(threeRows(), { dismissals: { 'fault.stuck_relay': record('critical') } });
  assert.deepEqual(active.counts, { active: 0, recorded: 1, acknowledged: 1 });
  assert.equal(active.title, '2 advisories');
  assert.equal(active.detail, '1 recorded, 1 acknowledged.');
  assert.equal(active.tone, 'muted');

  const one = visit(threeRows(), {
    dismissals: { 'fault.stuck_relay': record('critical'), 'fault.no_ground': record('critical') },
  });
  assert.deepEqual(one.counts, { active: 0, recorded: 0, acknowledged: 1 });
  assert.equal(one.title, '1 acknowledged advisory');
  assert.equal(one.state, 'advisories');

  // All dismissed: the card's existing presentation for an empty list, exactly.
  const all = visit(threeRows(), {
    dismissals: {
      'fault.stuck_relay': record('critical'),
      'fault.no_ground': record('critical'),
      'thermal.high_temp': record('warning'),
    },
  });
  assert.equal(all.state, 'none');
  assert.equal(all.title, 'No advisories');
  assert.equal(all.detail, 'The charger’s last health check listed none.');
  assert.equal(all.tone, 'muted');
  assert.equal(all.caveat, '');
  assert.deepEqual(all.counts, { active: 0, recorded: 0, acknowledged: 0 });
  assert.equal(all.incomplete, false);
  assert.doesNotMatch(copyOf(all), NO_FAULT_WORDING);

  // Under an open gate the same all-dismissed list is incomplete health, as
  // an empty list is — silence under an open gate is never "no advisories".
  const gate = { settings_known: true, relay_health_known: false };
  const gated = visit(report({ gates: gate, advisories: [ACTIVE, RECORDED, ACKED] }), {
    dismissals: {
      'fault.stuck_relay': record('critical'),
      'fault.no_ground': record('critical'),
      'thermal.high_temp': record('warning'),
    },
  });
  assert.equal(gated.state, 'incomplete');
  assert.equal(gated.incomplete, true);
  assert.equal(gated.title, 'Health incomplete');
  assert.equal(
    gated.detail,
    'Relay health isn’t reported, so some advisory checks may be missing.',
  );
  assert.equal(gated.caveat, '', 'the headline sentence is not repeated as a caveat');
  assert.equal(gated.tone, 'warn');
  // With one row left the list is the headline and the gate rides the caveat.
  const partial = visit(report({ gates: gate, advisories: [ACTIVE, RECORDED, ACKED] }), {
    dismissals: {
      'fault.stuck_relay': record('critical'),
      'fault.no_ground': record('critical'),
    },
  });
  assert.equal(partial.state, 'advisories');
  assert.equal(partial.title, '1 acknowledged advisory');
  assert.equal(
    partial.caveat,
    'Relay health isn’t reported, so some advisory checks may be missing.',
  );
});

test('an unknown state retires nothing: dismissals is null on every unknown path', () => {
  // A bridge outage, a failed listener, a stale or unreadable report — none of
  // them is evidence that an advisory is *gone*. Returning a map here would
  // prune every record the owner holds and resurrect each advisory once the
  // report came back; `null` tells the screen to leave the records alone.
  const records = { 'fault.no_ground': record('critical') };
  const stale = report({ checked_at: seconds(NOW - HEALTH_STALE_AFTER_MS - 1000) });
  const undated = report({ checked_at: undefined });
  for (const [why, state] of [
    ['absent', visit(null, { dismissals: records })],
    [
      'listener error',
      visit(report({ advisories: [RECORDED] }), { error: true, dismissals: records }),
    ],
    [
      'unsupported',
      visit(report({ source: 'unsupported', reachable: false }), { dismissals: records }),
    ],
    ['unreachable', visit(report({ reachable: false }), { dismissals: records })],
    ['unreadable', visit(report({ reachable: undefined }), { dismissals: records })],
    ['stale', visit(stale, { dismissals: records })],
    ['undated', visit(undated, { dismissals: records })],
  ]) {
    assert.equal(state.state, 'unknown', why);
    assert.equal(state.dismissals, null, `${why} must not retire a record`);
    assert.deepEqual(state.advisories, []);
  }
  // The input is left exactly as it was.
  assert.deepEqual(records, { 'fault.no_ground': record('critical') });
});

test('Dismiss is offered on every row and gated by nothing; Acknowledge stays gated', () => {
  const row = visit(threeRows()).advisories[0];
  assert.deepEqual(dismissControlState(row), {
    show: true,
    label: 'Dismiss',
    ariaLabel: 'Dismiss Stuck relay',
  });
  // The same shape when there is nothing to paint.
  assert.deepEqual(dismissControlState({ ...row, dismissible: false }), {
    show: false,
    label: '',
    ariaLabel: '',
  });
  assert.deepEqual(dismissControlState(null), { show: false, label: '', ariaLabel: '' });

  // On the current bridge: Acknowledge only on the unacknowledged rows,
  // Dismiss on all three — including the acknowledged one, which has nothing
  // left to mute but can still be hidden.
  const current = visit(threeRows()).advisories;
  assert.deepEqual(
    current.map((entry) => [entry.canAcknowledge, entry.dismissible]),
    [
      [true, true],
      [true, true],
      [false, true],
    ],
  );

  // Deploy skew (#159): an older bridge's document hides every Acknowledge
  // control. Dismiss never reaches the bridge, so nothing there gates it.
  const legacy = threeRows();
  delete legacy.ack_command;
  for (const entry of visit(legacy).advisories) {
    assert.equal(entry.canAcknowledge, false);
    assert.equal(ackControlState(entry).show, false);
    assert.equal(entry.dismissible, true);
    assert.equal(dismissControlState(entry).show, true);
  }
  for (const ack_command of [false, null, 'true']) {
    assert.equal(
      visit(report({ advisories: [RECORDED], ack_command })).advisories[0].canAcknowledge,
      false,
    );
    assert.equal(
      visit(report({ advisories: [RECORDED], ack_command })).advisories[0].dismissible,
      true,
    );
  }

  // An id the bridge would refuse offers no Acknowledge (it could only fail)
  // and still offers Dismiss (it cannot fail that way).
  const refused = visit(report({ advisories: [{ ...RECORDED, id: 'Fault.No_Ground' }] }));
  assert.equal(refused.advisories[0].canAcknowledge, false);
  assert.equal(refused.advisories[0].dismissible, true);
  assert.equal(dismissControlState(refused.advisories[0]).ariaLabel, 'Dismiss No Ground');

  // Unknown health lists no rows, so it offers no control of either kind.
  assert.deepEqual(visit(null).advisories, []);
});

test('a dismissals input that is not a record map hides nothing', () => {
  for (const dismissals of [
    null,
    undefined,
    [],
    'fault.no_ground',
    42,
    { 'fault.no_ground': null },
  ]) {
    const state = visit(threeRows(), { dismissals });
    assert.equal(state.advisories.length, 3, String(dismissals));
    assert.equal(state.state, 'advisories');
  }

  // A record that is only inherited is not a record: the lookup is by own key,
  // so nothing on a prototype can hide a row.
  const inherited = visit(threeRows(), {
    dismissals: Object.create({ 'fault.no_ground': record('critical') }),
  });
  assert.equal(inherited.advisories.length, 3);
  // …and the map it answers is a plain object, never that prototype.
  assert.equal(Object.getPrototypeOf(inherited.dismissals), Object.prototype);
  assert.deepEqual(inherited.dismissals, {});
});
