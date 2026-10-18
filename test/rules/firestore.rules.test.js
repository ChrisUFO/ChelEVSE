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
import { doc, setDoc } from 'firebase/firestore';

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

test('allowlisted user can write a valid schedule', async () => {
  await assertSucceeds(
    writeSchedule(allowlisted(), 'valid', { enabled: true, rules: [scheduleRule()] }),
  );
});

test('schedule with 21 rules is rejected', async () => {
  const rules = Array.from({ length: 21 }, (_, i) => scheduleRule({ id: `r${i}` }));
  await assertFails(writeSchedule(allowlisted(), 'too-many', { enabled: true, rules }));
});

test('schedule rule with start equal to end is rejected', async () => {
  await assertFails(
    writeSchedule(allowlisted(), 'same-time', {
      enabled: true,
      rules: [scheduleRule({ start: '06:00', end: '06:00' })],
    }),
  );
});

test('schedule rule without amps is rejected', async () => {
  const { amps, ...withoutAmps } = scheduleRule();
  await assertFails(
    writeSchedule(allowlisted(), 'missing-amps', { enabled: true, rules: [withoutAmps] }),
  );
});

test('schedule rule with non-numeric amps is rejected', async () => {
  await assertFails(
    writeSchedule(allowlisted(), 'string-amps', {
      enabled: true,
      rules: [scheduleRule({ amps: '16' })],
    }),
  );
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
