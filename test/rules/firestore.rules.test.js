// Emulator-backed tests for the authorization behavior in firestore.rules.
// Run with: npm run test:rules (requires Java for the Firestore emulator).
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';

const PROJECT_ID = 'demo-chelevse';
const RULES = readFileSync('firestore.rules', 'utf8');

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: '127.0.0.1', port: 8081, rules: RULES },
  });

  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users/u1'), { allowed: true, email: 'u1@example.com' });
    await setDoc(doc(db, 'fcmTokens/tok-update'), { uid: 'u1', created_at: new Date() });
    await setDoc(doc(db, 'fcmTokens/tok-shape'), { uid: 'u1', created_at: new Date() });
    await setDoc(doc(db, 'fcmTokens/tok-ungranted'), { uid: 'u2', created_at: new Date() });
    await setDoc(doc(db, 'fcmTokens/tok-ungranted-update'), { uid: 'u2', created_at: new Date() });
    await setDoc(doc(db, 'fcmTokens/tok-foreign'), { uid: 'u2', created_at: new Date() });
    await setDoc(doc(db, 'fcmTokens/tok-u1-owned'), { uid: 'u1', created_at: new Date() });
    await setDoc(doc(db, 'fcmTokens/tok-del'), { uid: 'u1', created_at: new Date() });
    await setDoc(doc(db, 'fcmTokens/tok-del-foreign'), { uid: 'u2', created_at: new Date() });
    await setDoc(doc(db, 'fcmTokens/tok-read'), { uid: 'u1', created_at: new Date() });
  });

  await seedConfig();
});

// The charger's capability snapshot, in the shape the bridge writes it
// (pi/bridge.py _write_config_doc: redact, then firestore_safe, then set — so
// integers stay Firestore integers). The set_current rule reads its soft
// ceiling from here, so every command test depends on it.
function configDoc() {
  return { max_current_soft: 16, max_current_hard: 24, hostname: 'x' };
}

function seedConfig() {
  return env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'status', 'config'), configDoc());
  });
}

after(async () => {
  await env.cleanup();
});

function allowlisted() {
  return env.authenticatedContext('u1', { email: 'u1@example.com', email_verified: true });
}

function ungranted() {
  return env.authenticatedContext('u2', { email: 'u2@example.com', email_verified: true });
}

function writeCommand(context, id, data) {
  return setDoc(doc(context.firestore(), 'commands', id), data);
}

function rapi(command) {
  return { type: 'rapi', status: 'pending', command };
}

test('allowlisted user can create rapi command $OK', async () => {
  await assertSucceeds(writeCommand(allowlisted(), 'rapi-ok', rapi('$OK')));
});

test('allowlisted user can create rapi command $FS 20', async () => {
  await assertSucceeds(writeCommand(allowlisted(), 'rapi-fs', rapi('$FS 20')));
});

test('rapi command of exactly 32 characters is accepted', async () => {
  const command = '$FS ' + 'A'.repeat(28);
  assert.equal(command.length, 32);
  await assertSucceeds(writeCommand(allowlisted(), 'rapi-max', rapi(command)));
});

test('rapi command with $$ is rejected', async () => {
  await assertFails(writeCommand(allowlisted(), 'rapi-dollars', rapi('$$')));
});

test('rapi command with x$ is rejected', async () => {
  await assertFails(writeCommand(allowlisted(), 'rapi-x', rapi('x$')));
});

test('rapi command longer than 32 characters is rejected', async () => {
  await assertFails(writeCommand(allowlisted(), 'rapi-long', rapi('$' + 'A'.repeat(32))));
  await assertFails(
    writeCommand(allowlisted(), 'rapi-long-valid-prefix', rapi('$OK ' + 'A'.repeat(29))),
  );
});

test('unauthenticated user cannot create a rapi command', async () => {
  await assertFails(writeCommand(env.unauthenticatedContext(), 'rapi-anon', rapi('$OK')));
});

test('authenticated user without a grant cannot create a rapi command', async () => {
  await assertFails(writeCommand(ungranted(), 'rapi-ungranted', rapi('$OK')));
});

function setCurrent(amps) {
  return { type: 'set_current', status: 'pending', amps };
}

// The rule enforces the charger's configured soft ceiling (seeded at 16 A), not
// the app's 6–48 A setting range. 48 A is inside that range and must still be
// rejected here; the bridge re-checks the ceiling, the hard maximum's coherence
// and rejects before contacting the charger.
test('allowlisted user can create a set_current at the soft ceiling', async () => {
  await assertSucceeds(writeCommand(allowlisted(), 'current-soft', setCurrent(16)));
});

test('allowlisted user can create a set_current at the 6 A minimum', async () => {
  await assertSucceeds(writeCommand(allowlisted(), 'current-min', setCurrent(6)));
});

test('set_current one amp above the soft ceiling is rejected', async () => {
  await assertFails(writeCommand(allowlisted(), 'current-above-soft', setCurrent(17)));
});

test('set_current at 48 A is rejected when the soft ceiling is 16 A', async () => {
  // 48 A is the old hard-coded ceiling and the app's setting range; it is not
  // the device's limit.
  await assertFails(writeCommand(allowlisted(), 'current-48', setCurrent(48)));
});

test('set_current with a fractional amp value is rejected', async () => {
  await assertFails(writeCommand(allowlisted(), 'current-fractional', setCurrent(16.5)));
});

test('pause and resume are unaffected by the current ceiling', async () => {
  await assertSucceeds(
    writeCommand(allowlisted(), 'pause-under-ceiling', { type: 'pause', status: 'pending' }),
  );
  await assertSucceeds(
    writeCommand(allowlisted(), 'resume-under-ceiling', { type: 'resume', status: 'pending' }),
  );
});

// An absent status/config makes get() null, so .data errors and the create is
// denied — fail-closed, never a fallback ceiling. The bridge is equally
// unwilling to set current without verified capabilities. The lookup sits
// inside the set_current branch, so the commands that never read it must keep
// working: hoisting get() above the type dispatch would strand pause/resume on
// a device whose config has not been written yet.
test('set_current is denied when status/config is absent, pause and resume are not', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await deleteDoc(doc(context.firestore(), 'status', 'config'));
  });
  try {
    await assertFails(writeCommand(allowlisted(), 'current-no-config', setCurrent(16)));
    await assertSucceeds(
      writeCommand(allowlisted(), 'pause-no-config', { type: 'pause', status: 'pending' }),
    );
    await assertSucceeds(
      writeCommand(allowlisted(), 'resume-no-config', { type: 'resume', status: 'pending' }),
    );
  } finally {
    await seedConfig();
  }
});

// A present config without the soft ceiling is not a licence to fall back to
// another limit: the rule requires the field to be a number, so the create
// fails. A tolerant lookup (.get('max_current_soft', 48)) would pass here and
// silently reintroduce the hard-coded ceiling.
test('set_current is denied when status/config omits max_current_soft', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'status', 'config'), { hostname: 'x' });
  });
  try {
    await assertFails(writeCommand(allowlisted(), 'current-no-soft', setCurrent(16)));
  } finally {
    await seedConfig();
  }
});

function scheduleRule(overrides = {}) {
  return { id: 'r1', days: [0, 2], start: '22:00', end: '06:00', amps: 16, ...overrides };
}

function writeSchedule(context, id, data) {
  return setDoc(doc(context.firestore(), 'schedule', id), data);
}

// Rules validate the schedule container only (keys, types, max 20 rules).
// Per-rule contents are not rules-tested: Firestore cannot iterate a list and
// per-element validation exceeds its 1000-expression evaluation limit at 4
// rules. The bridge re-validates each rule (skipping and logging malformed
// ones); the app-side check lands with the schedule screen.
test('allowlisted user can write a valid schedule', async () => {
  await assertSucceeds(
    writeSchedule(allowlisted(), 'valid', { enabled: true, rules: [scheduleRule()] }),
  );
});

test('schedule with 20 rules is accepted', async () => {
  const rules = Array.from({ length: 20 }, (_, i) => scheduleRule({ id: `r${i}` }));
  await assertSucceeds(writeSchedule(allowlisted(), 'twenty-rules', { enabled: true, rules }));
});

test('schedule with 21 rules is rejected', async () => {
  const rules = Array.from({ length: 21 }, (_, i) => scheduleRule({ id: `r${i}` }));
  await assertFails(writeSchedule(allowlisted(), 'too-many', { enabled: true, rules }));
});

test('schedule with an extra top-level key is rejected', async () => {
  await assertFails(
    writeSchedule(allowlisted(), 'extra-key', {
      enabled: true,
      rules: [scheduleRule()],
      extra: true,
    }),
  );
});

test('schedule without a boolean enabled is rejected', async () => {
  await assertFails(
    writeSchedule(allowlisted(), 'bad-enabled', {
      enabled: 'true',
      rules: [scheduleRule()],
    }),
  );
});

test('schedule without a rules list is rejected', async () => {
  await assertFails(
    writeSchedule(allowlisted(), 'bad-rules', { enabled: true, rules: scheduleRule() }),
  );
});

test('unauthenticated user cannot write a schedule', async () => {
  await assertFails(
    writeSchedule(env.unauthenticatedContext(), 'anon', {
      enabled: true,
      rules: [scheduleRule()],
    }),
  );
});

test('allowlisted user can write valid settings', async () => {
  await assertSucceeds(
    setDoc(doc(allowlisted().firestore(), 'settings', 'main'), { rate: 0.31, currency: '$' }),
  );
});

test('settings without currency are rejected', async () => {
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'settings', 'missing-currency'), { rate: 0.31 }),
  );
});

function rateWindow(overrides = {}) {
  return {
    id: 'w1',
    rate: 0.12,
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    months: null,
    ...overrides,
  };
}

function writeSettings(context, id, data) {
  return setDoc(doc(context.firestore(), 'settings', id), data);
}

// Rules guard the `rates` container only (list, at most 24 rows): Firestore
// cannot iterate a list. Per-window shape and overlaps are validated by
// web/js/rates.js before the write, and covered in test/web/rates.test.js.
test('settings may omit the optional rates list', async () => {
  await assertSucceeds(writeSettings(allowlisted(), 'flat', { rate: 0.31, currency: 'USD' }));
});

test('allowlisted user can write a settings document with rate windows', async () => {
  await assertSucceeds(
    writeSettings(allowlisted(), 'scheduled', {
      rate: 0.31,
      currency: 'USD',
      rates: [rateWindow(), rateWindow({ id: 'w2', days: [5, 6], months: [6, 7, 8] })],
    }),
  );
});

test('settings with 24 rate windows are accepted', async () => {
  const rates = Array.from({ length: 24 }, (_, i) => rateWindow({ id: `w${i}` }));
  await assertSucceeds(
    writeSettings(allowlisted(), 'twenty-four', { rate: 0.31, currency: '$', rates }),
  );
});

test('settings rates must be a list', async () => {
  await assertFails(
    writeSettings(allowlisted(), 'rates-object', {
      rate: 0.31,
      currency: '$',
      rates: rateWindow(),
    }),
  );
  await assertFails(
    writeSettings(allowlisted(), 'rates-string', { rate: 0.31, currency: '$', rates: 'night' }),
  );
});

test('settings with more than 24 rate windows are rejected', async () => {
  const rates = Array.from({ length: 25 }, (_, i) => rateWindow({ id: `w${i}` }));
  await assertFails(
    writeSettings(allowlisted(), 'too-many-rates', { rate: 0.31, currency: '$', rates }),
  );
});

test('unauthenticated users cannot write settings with rates', async () => {
  await assertFails(
    writeSettings(env.unauthenticatedContext(), 'anon-rates', {
      rate: 0.31,
      currency: '$',
      rates: [rateWindow()],
    }),
  );
});

// The charger address guard is the coarse subset of the shared grammar (issue
// #54): length 1–253, `[A-Za-z0-9.-]`, first and last alphanumeric. Rules cannot
// check per-label length or IPv4 octets — the app and the bridge do.
test('settings may carry a valid charger address', async () => {
  for (const [id, host] of [
    ['host-ipv4', '192.168.1.50'],
    ['host-name', 'evse.local'],
    ['host-mixed-case', 'TerranceCharge.local'],
    ['host-hyphen', 'my-charger.local'],
    ['host-single', 'a'],
    ['host-long', [63, 63, 63, 61].map((n) => 'a'.repeat(n)).join('.')],
  ]) {
    await assertSucceeds(
      writeSettings(allowlisted(), id, { rate: 0.31, currency: 'USD', charger_host: host }),
    );
  }
});

test('settings may omit the optional charger address', async () => {
  await assertSucceeds(
    writeSettings(allowlisted(), 'no-host', {
      rate: 0.31,
      currency: 'USD',
      rates: [rateWindow()],
    }),
  );
});

// The temperature toggle guard (issue #117): optional, absent = visible, but a
// present value must be a bool — defense-in-depth like charger_host, since the
// app only ever writes an explicit false.
test('settings may carry the optional show_temperature boolean', async () => {
  for (const [id, value] of [
    ['temp-hidden', false],
    ['temp-visible', true],
  ]) {
    await assertSucceeds(
      writeSettings(allowlisted(), id, { rate: 0.31, currency: 'USD', show_temperature: value }),
    );
  }
  await assertSucceeds(
    writeSettings(allowlisted(), 'temp-absent', { rate: 0.31, currency: 'USD' }),
  );
});

test('settings reject a show_temperature that is not a boolean', async () => {
  for (const [id, value] of [
    ['string', 'false'],
    ['number', 0],
    ['null', null],
  ]) {
    await assertFails(
      writeSettings(allowlisted(), `bad-temp-${id}`, {
        rate: 0.31,
        currency: 'USD',
        show_temperature: value,
      }),
    );
  }
});

test('settings reject a charger address that is not a bare host', async () => {
  const tooLong = [63, 63, 63, 62].map((n) => 'a'.repeat(n)).join('.');
  for (const [id, host] of [
    ['scheme', 'http://192.168.1.50'],
    ['port', '192.168.1.50:8080'],
    ['path', '192.168.1.50/status'],
    ['space', 'a b'],
    ['blank', ''],
    ['trailing-dot', '192.168.1.50.'],
    ['leading-hyphen', '-evse'],
    ['too-long', tooLong],
    ['number', 192],
  ]) {
    await assertFails(
      writeSettings(allowlisted(), `bad-host-${id}`, {
        rate: 0.31,
        currency: 'USD',
        charger_host: host,
      }),
    );
  }
});

test('allowlisted user can register their own fcm token', async () => {
  await assertSucceeds(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-own'), {
      uid: 'u1',
      created_at: new Date(),
    }),
  );
});

test('an fcm token create must carry exactly uid and a timestamp', async () => {
  // No created_at.
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-no-date'), { uid: 'u1' }),
  );
  // Wrong type.
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-bad-date'), {
      uid: 'u1',
      created_at: 'yesterday',
    }),
  );
  // The rules pin the shape: the bridge honours `token`, so a client must not be
  // able to inject or override it.
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-extra'), {
      uid: 'u1',
      created_at: new Date(),
      token: 'rewritten',
    }),
  );
});

test('an fcm token cannot be registered for another uid', async () => {
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-other'), {
      uid: 'u2',
      created_at: new Date(),
    }),
  );
});

test('an fcm token can be updated by its owner only', async () => {
  await assertSucceeds(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-update'), {
      uid: 'u1',
      created_at: new Date(),
    }),
  );
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-foreign'), {
      uid: 'u1',
      created_at: new Date(),
    }),
  );
});

test('an fcm token update is shape-pinned and may not add fields', async () => {
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-shape'), {
      uid: 'u1',
      created_at: new Date(),
      extra: true,
    }),
  );
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-shape'), {
      uid: 'u1',
      created_at: 'yesterday',
    }),
  );
});

test('an allowlisted user can delete their own fcm token, but not another uid doc', async () => {
  await assertSucceeds(deleteDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-del')));
  await assertFails(deleteDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-del-foreign')));
});

test('deleting an already-removed token is a harmless no-op', async () => {
  // A release retry may run after the first delete's acknowledgement was lost.
  await assertSucceeds(deleteDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-gone')));
});

test('an ungranted owner can delete its own fcm token after access is revoked', async () => {
  // Revocation must not trap the device's registration: the no-access screen's
  // sign-out still runs the release while this account is authenticated.
  await assertSucceeds(deleteDoc(doc(ungranted().firestore(), 'fcmTokens', 'tok-ungranted')));
});

test('an ungranted user cannot delete another uid fcm token', async () => {
  await assertFails(deleteDoc(doc(ungranted().firestore(), 'fcmTokens', 'tok-u1-owned')));
});

test('an ungranted user still cannot create or update a token', async () => {
  await assertFails(
    setDoc(doc(ungranted().firestore(), 'fcmTokens', 'tok-ungranted-new'), {
      uid: 'u2',
      created_at: new Date(),
    }),
  );
  await assertFails(
    setDoc(doc(ungranted().firestore(), 'fcmTokens', 'tok-ungranted-update'), {
      uid: 'u2',
      created_at: new Date(),
    }),
  );
});

test('fcm tokens cannot be read by clients', async () => {
  await assertFails(getDoc(doc(allowlisted().firestore(), 'fcmTokens', 'tok-read')));
});

// An `ack_notification` command carries one advisory id. The rules mirror the
// firmware's rule-name grammar (a lowercase dotted path) and the bridge's
// 64-char cap: a create the bridge would refuse must not be storable.
function ackCommand(overrides = {}) {
  return {
    type: 'ack_notification',
    status: 'pending',
    notification_id: 'fault.no_ground',
    ...overrides,
  };
}

test('allowlisted user can create an ack_notification command', async () => {
  await assertSucceeds(writeCommand(allowlisted(), 'ack-ok', ackCommand()));
  await assertSucceeds(
    writeCommand(allowlisted(), 'ack-single', ackCommand({ notification_id: 'thermal' })),
  );
  await assertSucceeds(
    writeCommand(allowlisted(), 'ack-long', ackCommand({ notification_id: 'a' + 'b'.repeat(63) })),
  );
});

test('an ack_notification without an advisory id is rejected', async () => {
  const { notification_id: _omitted, ...withoutId } = ackCommand();
  await assertFails(writeCommand(allowlisted(), 'ack-no-id', withoutId));
  await assertFails(
    writeCommand(allowlisted(), 'ack-null-id', ackCommand({ notification_id: null })),
  );
  await assertFails(
    writeCommand(allowlisted(), 'ack-number-id', ackCommand({ notification_id: 7 })),
  );
});

test('an ack_notification id must be 1 to 64 characters', async () => {
  await assertFails(
    writeCommand(allowlisted(), 'ack-empty-id', ackCommand({ notification_id: '' })),
  );
  await assertFails(
    writeCommand(
      allowlisted(),
      'ack-too-long',
      ackCommand({ notification_id: 'a' + 'b'.repeat(64) }),
    ),
  );
});

test('an ack_notification id with illegal characters is rejected', async () => {
  for (const [id, notification_id] of [
    ['uppercase', 'Fault.No_Ground'],
    ['leading-digit', '1fault.no_ground'],
    ['leading-dot', '.fault'],
    ['trailing-dot', 'fault.'],
    ['empty-segment', 'fault..no_ground'],
    ['hyphen', 'fault.no-ground'],
    ['space', 'fault. no_ground'],
    ['slash', 'fault/no_ground'],
    // RE2 `$` is end-of-text, not end-of-line, so a trailing newline is not a
    // terminator the grammar accepts.
    ['trailing-newline', 'fault.no_ground\n'],
  ]) {
    await assertFails(
      writeCommand(allowlisted(), `ack-bad-id-${id}`, ackCommand({ notification_id })),
    );
  }
});

test('an ack_notification create is still pinned to a pending status', async () => {
  await assertFails(writeCommand(allowlisted(), 'ack-acked', ackCommand({ status: 'acked' })));
});

test('unauthenticated and ungranted users cannot create an ack_notification', async () => {
  await assertFails(writeCommand(env.unauthenticatedContext(), 'ack-anon', ackCommand()));
  await assertFails(writeCommand(ungranted(), 'ack-ungranted', ackCommand()));
});

// The health documents belong to the bridge: `status/notifications` (and the
// `acks` map the ack command writes into it) must never be client-forgeable.
test('a client cannot write the bridge-owned health document', async () => {
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'status', 'notifications'), {
      reachable: true,
      advisories: [],
    }),
  );
  await assertFails(
    setDoc(doc(allowlisted().firestore(), 'status', 'notifications'), {
      acks: { 'fault.no_ground': 1794177153 },
    }),
  );
});
