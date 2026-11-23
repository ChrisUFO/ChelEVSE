// Refuse to deploy if the target Firebase project does not match the
// service-account key about to be used, or — for hosting-capable deploys
// (`--require-web-config`) — if the web app config is absent or still the
// example. Prevents broken hosting releases and cross-project deploys (e.g.
// shipping this repo's hosting/rules over another app's project).
//
// Target resolution order: FIREBASE_PROJECT env, then .firebaserc's
// projects.default. Key resolution: GOOGLE_APPLICATION_CREDENTIALS, then
// private/service-account.json.
import { readFileSync, existsSync } from 'node:fs';

function fail(message, hint) {
  console.error(`\n✖ deploy blocked: ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

let target = process.env.FIREBASE_PROJECT;
if (!target && existsSync('.firebaserc')) {
  target = readJson('.firebaserc')?.projects?.default;
}
if (!target) {
  fail(
    'no Firebase project selected',
    'set FIREBASE_PROJECT or add {"projects":{"default":"<project-id>"}} to .firebaserc',
  );
}

// Only hosting-capable deploys need the web config: `deploy`, `deploy:dry-run`
// and `deploy:hosting` publish `web/`, while `deploy:rules` and
// `deploy:indexes` publish nothing from it. Those hooks therefore omit
// `--require-web-config`, so a Firestore-only deploy works in a checkout
// without the gitignored `web/firebase-config.js`.
const requireWebConfig = process.argv.includes('--require-web-config');
if (requireWebConfig) {
  const webConfigPath = 'web/firebase-config.js';
  if (!existsSync(webConfigPath)) {
    fail(
      `${webConfigPath} is missing`,
      'copy web/firebase-config.example.js there and fill in the Firebase web app values',
    );
  }

  let webConfig;
  try {
    webConfig = readFileSync(webConfigPath, 'utf8');
  } catch {
    fail(`cannot read ${webConfigPath}`, 'check that the deploy user can read the file');
  }

  const templateMarkers = [
    'AIza...',
    'your-project.firebaseapp.com',
    'your-project-id',
    'your-project.appspot.com',
    "messagingSenderId: '1234567890'",
    "appId: '1:1234567890:web:abcdef'",
  ];
  const foundMarkers = templateMarkers.filter((marker) => webConfig.includes(marker));
  if (foundMarkers.length) {
    fail(
      `${webConfigPath} still contains placeholder values (${foundMarkers.join(', ')})`,
      'replace the Firebase app fields with the values from the Firebase console; the VAPID placeholder may remain when notifications are disabled',
    );
  }
}

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || 'private/service-account.json';
if (!existsSync(keyPath)) {
  console.warn(
    `⚠ deploy guard: no service-account key at ${keyPath}; target "${target}" is unverified.`,
  );
  process.exit(0);
}

const keyProject = readJson(keyPath)?.project_id;
if (!keyProject) {
  fail(`cannot read project_id from ${keyPath}`, 'is it a valid service-account key?');
}
if (keyProject !== target) {
  fail(
    `target project "${target}" does not match the service-account key's project "${keyProject}"`,
    'use the key that belongs to the project you are deploying to (or fix FIREBASE_PROJECT)',
  );
}

console.log(`✔ deploy guard: ${target} (key ${keyPath} belongs to ${keyProject})`);
