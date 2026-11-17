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
  healthState,
} from '../../web/js/health.js';

// Local timestamps, so a fixture reads the same in every timezone (the date
// labels are local, like the rest of the app).
const at = (year, month, day, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();
const NOW = at(2026, 11, 16, 9, 30);
const seconds = (ms) => Math.floor(ms / 1000);
// A complete, quiet report: both gates closed, nothing listed.
const report = (overrides = {}) => ({
  reachable: true,
  source: 'http',
  checked_at: seconds(at(2026, 11, 16, 9, 15)),
  gates: { settings_known: true, relay_health_known: true },
  counters: { nogndcount: 0, gfcicount: 0, stuckcount: 0 },
  advisories: [],
  alerted: {},
  acks: {},
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
  assert.match(state.detail, /Dismissed on the charger, kept here for the record/);
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
  // entry the owner just acknowledged must read as dismissed, not active.
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
