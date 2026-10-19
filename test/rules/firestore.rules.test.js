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
});

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
