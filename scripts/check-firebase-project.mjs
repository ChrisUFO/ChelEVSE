// Refuse to deploy if the target Firebase project does not match the
// service-account key about to be used. Prevents cross-project deploys
// (e.g. shipping this repo's hosting/rules over another app's project).
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
