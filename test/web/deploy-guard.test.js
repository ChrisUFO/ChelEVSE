import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const guard = resolve('scripts/check-firebase-project.mjs');

const placeholderConfig = `
export const firebaseConfig = {
  apiKey: 'AIza...',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project-id',
  storageBucket: 'your-project.appspot.com',
  messagingSenderId: '1234567890',
  appId: '1:1234567890:web:abcdef',
};
export const vapidKey = '<public Web Push key>';
`;

const realConfigWithoutPush = `
export const firebaseConfig = {
  apiKey: 'AIzaSyD-real-public-web-key',
  authDomain: 'charge-home.firebaseapp.com',
  projectId: 'charge-home',
  storageBucket: 'charge-home.appspot.com',
  messagingSenderId: '9876543210',
  appId: '1:9876543210:web:0123456789abcdef',
};
export const vapidKey = '<public Web Push key>';
`;

function fixture(t, config) {
  const root = mkdtempSync(join(tmpdir(), 'chelevse-deploy-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (config !== undefined) {
    mkdirSync(join(root, 'web'));
    writeFileSync(join(root, 'web', 'firebase-config.js'), config);
  }
  return root;
}

function runGuard(cwd, args = ['--require-web-config']) {
  return spawnSync(process.execPath, [guard, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FIREBASE_PROJECT: 'charge-home',
      GOOGLE_APPLICATION_CREDENTIALS: '',
    },
  });
}

test('deploy guard blocks a missing web config', (t) => {
  const result = runGuard(fixture(t));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /deploy blocked: web\/firebase-config\.js is missing/);
});

test('deploy guard blocks an untouched placeholder web config', (t) => {
  const result = runGuard(fixture(t, placeholderConfig));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /firebase-config\.js still contains placeholder values/);
});

test('deploy guard accepts real web config with push left disabled', (t) => {
  const result = runGuard(fixture(t, realConfigWithoutPush));

  assert.equal(result.status, 0);
  assert.match(result.stderr, /no service-account key/);
  assert.doesNotMatch(result.stderr, /deploy blocked/);
});

test('deploy guard skips the web config for rules/indexes deploys', (t) => {
  const result = runGuard(fixture(t), []);

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /deploy blocked/);
});

test('every deploy script runs the guard with the web config only where needed', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const hostingHooks = ['predeploy', 'predeploy:dry-run', 'predeploy:hosting'];
  const firestoreHooks = ['predeploy:rules', 'predeploy:indexes'];

  for (const hook of hostingHooks) {
    assert.equal(
      pkg.scripts[hook],
      'node scripts/check-firebase-project.mjs --require-web-config',
      `${hook} must check the web config because it publishes web/`,
    );
  }
  for (const hook of firestoreHooks) {
    assert.equal(
      pkg.scripts[hook],
      'node scripts/check-firebase-project.mjs',
      `${hook} publishes no web/ and must not require the web config`,
    );
  }
});
