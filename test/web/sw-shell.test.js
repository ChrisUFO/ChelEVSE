import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guard for the offline app shell. `web/sw.js` is a classic script that
// runs only in a service-worker scope, so it is parsed as text here: a runtime
// module missing from SHELL (or an entry pointing at nothing) must fail the
// suite instead of surfacing as a broken offline load.
const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));
const SW_PATH = path.join(WEB_ROOT, 'sw.js');
const SOURCE = readFileSync(SW_PATH, 'utf8');

// Hosting-root assets the shell needs, outside js/.
const ROOT_ASSETS = [
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
];

// Deployment-local (untracked) and served no-cache outside the Cache API; the
// fetch handler skips it by name, so it is never precached.
const EXCLUDED_MODULES = new Set(['firebase-config.js']);

function block(name) {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(SOURCE);
  assert.ok(match, `web/sw.js declares ${name} as an array literal`);
  return match[1];
}

// Only quoted entries are accepted: an expression inside SHELL would resolve to
// nothing at install time, so a parser that cannot read it must fail loudly.
function shellEntries() {
  const body = block('SHELL');
  const entries = [...body.matchAll(/(['"])([^'"]*)\1/g)].map((match) => match[2]);
  const rest = body
    .replace(/(['"])([^'"]*)\1/g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/[\s,]/g, '');
  assert.equal(rest, '', `SHELL holds only quoted entries (found ${JSON.stringify(rest)})`);
  return entries;
}

// Every runtime module under web/js, recursively, as a SHELL-style './js/...'
// path. Sorted so failures and duplicates read deterministically.
function jsModules(dir = path.join(WEB_ROOT, 'js'), prefix = '') {
  const modules = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const relative = prefix ? `${prefix}/${name}` : name;
    if (entry.isDirectory()) {
      modules.push(...jsModules(path.join(dir, name), relative));
    } else if (entry.isFile() && name.endsWith('.js') && !EXCLUDED_MODULES.has(name)) {
      modules.push(`./js/${relative}`);
    }
  }
  return modules.sort();
}

test('the service-worker cache name is versioned', () => {
  const match = /const CACHE = '([^']*)';/.exec(SOURCE);
  assert.ok(match, 'web/sw.js declares CACHE as a string literal');
  assert.match(match[1], /^chelevse-v\d+$/, `CACHE is ${JSON.stringify(match[1])}`);
});

test('SHELL precaches every runtime module without duplicates', () => {
  const entries = shellEntries();
  assert.deepEqual(
    entries.filter((entry, index) => entries.indexOf(entry) !== index),
    [],
    'SHELL has duplicate entries',
  );
  const missing = [...jsModules(), ...ROOT_ASSETS].filter((asset) => !entries.includes(asset));
  assert.deepEqual(missing, [], `SHELL is missing: ${missing.join(', ')}`);
});

test('every SHELL entry is a relative path to a file that exists', () => {
  const entries = shellEntries();
  const wrong = entries.filter((entry) => !entry.startsWith('./'));
  assert.deepEqual(wrong, [], `SHELL entries are not app-relative: ${wrong.join(', ')}`);
  // './' is the hosting root itself, not a file.
  const absent = entries
    .filter((entry) => entry !== './')
    .filter((entry) => !existsSync(path.join(WEB_ROOT, entry)));
  assert.deepEqual(absent, [], `SHELL lists missing files: ${absent.join(', ')}`);
});
