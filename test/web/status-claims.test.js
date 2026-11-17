import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The claims reason line's DOM wiring (#159, PR-2): the paint of the pure
// projection (pinned in test/web/claims.test.js), the store subscription, the
// app fan-out, and the teardown reset. The repo's module-mock-free stub
// harness (the one test/web/status-health.test.js proves): one stub element
// per id, every lookup deferred to render time, then a plain `await import`
// of the real screen — so the call sites under test are the shipping ones.
//
// The staleness contract the line inherits is pinned from the format.js side:
// the banner's two thresholds keep their values, and the banner's own verdicts
// still render exactly as they did (PR-2 must not touch them).

const focusLog = [];

function stubElement(tag = '') {
  const classes = new Set();
  const listeners = new Map();
  const attrs = new Map();
  return {
    tag,
    classes,
    listeners,
    attrs,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    dataset: {},
    style: { setProperty() {} },
    children: [],
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    className: '',
    id: '',
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    focus(options) {
      this.focused = options;
      focusLog.push(this.id);
    },
  };
}

const elements = new Map();
const live = new Set();

function element(id) {
  let el = elements.get(id);
  if (!el) {
    el = stubElement();
    el.id = id;
    elements.set(id, el);
    live.add(el);
  }
  return el;
}

globalThis.document = {
  documentElement: { style: { setProperty() {} } },
  getElementById: (id) => element(id),
  createElement: (tag) => stubElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  contains: (node) => live.has(node),
};

const { showClaims, showStatus, showStatusError, leaveStatus } =
  await import('../../web/js/screens/status.js');
const { CHARGING_STALE_AFTER_MS, IDLE_STALE_AFTER_MS } = await import('../../web/js/format.js');

// The status snapshot the banner's freshness computation reads (the
// status-error.test.js shape): a fresh, online, charging charger by default.
const snapshot = (overrides = {}) => ({
  exists: () => true,
  data: () => ({
    state: 3,
    state_label: 'charging',
    charger_online: true,
    updated_at: { toMillis: () => Date.now() },
    elapsed: 600,
    power: 7400,
    session_energy: 2000,
    amp: 16,
    pilot: 16,
    ...overrides,
  }),
});

// The status/claims document (pi/claims.py `project`).
function claimsDoc(overrides = {}) {
  return {
    reachable: true,
    source: 'http',
    reason: 'manual_override',
    winner_state: 'manual',
    winner_current: null,
    detail: {},
    checked_at: Math.floor(Date.now() / 1000) - 60,
    ...overrides,
  };
}

const line = () => element('claims-line');

test('a reason document paints one line beside the state pills', () => {
  showStatus(snapshot());
  showClaims(claimsDoc());

  assert.equal(line().hidden, false);
  assert.equal(line().textContent, 'Stopped manually');
  assert.equal(line().getAttribute('data-tone'), 'muted');

  // A later reason repaints the same node with its own tone — the paint is
  // the projection, nothing local.
  showClaims(claimsDoc({ reason: 'safety', winner_state: 'error' }));
  assert.equal(line().textContent, 'Held by safety');
  assert.equal(line().getAttribute('data-tone'), 'warn');
});

test('a hidden projection leaves no copy behind in the node', () => {
  showStatus(snapshot());
  showClaims(claimsDoc());
  assert.equal(line().hidden, false);

  // Null reason — charging with no restriction — is the common case: the line
  // hides and the text goes with it, so it can never return as a bare
  // un-hide of stale copy (the #status-error order).
  showClaims(claimsDoc({ reason: null, winner_state: null }));
  assert.equal(line().hidden, true);
  assert.equal(line().textContent, '');
});

test('the projection owns every hide: absent document, unsupported gateway', () => {
  showStatus(snapshot());
  showClaims(claimsDoc());
  assert.equal(line().hidden, false);

  showClaims(null);
  assert.equal(line().hidden, true);
  showClaims(claimsDoc({ source: 'unsupported' }));
  assert.equal(line().hidden, true);
});

test('a charger-stale status hides the line while the banner carries the verdict', () => {
  // The banner's charger verdict and the line's hide are the same fact: the
  // screen feeds both from status/current. The banner speaks; the line, with
  // nothing confident to add, stands down.
  showStatus(snapshot({ charger_online: false, state_label: 'available' }));
  showClaims(claimsDoc());

  assert.equal(line().hidden, true);
  assert.equal(element('banner').hidden, false);
  assert.equal(element('banner').textContent, 'Charger offline — showing last known values');
});

test('the line stands down on the pre-data and error screens', () => {
  // No status document has arrived: no freshness fact exists, so no derived
  // state renders — the claims document alone paints nothing.
  showClaims(claimsDoc());
  assert.equal(line().hidden, true);

  showStatus(snapshot());
  assert.equal(line().hidden, false);

  // The status listener's failure takes the whole hero's derived state with
  // it, this line included.
  showStatusError();
  assert.equal(line().hidden, true);
  assert.equal(line().textContent, '');
});

test('sign-out teardown drops the line and the document behind it', () => {
  showStatus(snapshot());
  showClaims(claimsDoc());
  assert.equal(line().hidden, false);

  leaveStatus();
  assert.equal(line().hidden, true);
  assert.equal(line().textContent, '');

  // The document was dropped, not just the paint: a fresh status snapshot
  // without a new claims delivery keeps the line hidden.
  showStatus(snapshot());
  assert.equal(line().hidden, true);
});

test('the freshness banner and its thresholds are exactly as they were', () => {
  // PR-2's contract: the banner stays the only staleness UI, byte-identical.
  // The thresholds are pinned by value (format.js owns the derivation), and
  // the verdicts by behavior: a charging snapshot goes stale at 150 s, an
  // idle one at 12 min, and each keeps its own banner copy.
  assert.equal(CHARGING_STALE_AFTER_MS, 150000);
  assert.equal(IDLE_STALE_AFTER_MS, 720000);

  showStatus(snapshot({ updated_at: { toMillis: () => Date.now() - 100000 } }));
  assert.equal(element('banner').hidden, true);

  showStatus(snapshot({ updated_at: { toMillis: () => Date.now() - 200000 } }));
  assert.equal(element('banner').hidden, false);
  assert.equal(element('banner').textContent, 'Not updating — showing last known values');

  showStatus(
    snapshot({
      state_label: 'available',
      updated_at: { toMillis: () => Date.now() - 200000 },
    }),
  );
  assert.equal(element('banner').hidden, true);

  showStatus(
    snapshot({
      state_label: 'available',
      updated_at: { toMillis: () => Date.now() - 800000 },
    }),
  );
  assert.equal(element('banner').hidden, false);
  assert.equal(element('banner').textContent, 'Bridge offline — showing last known values');
});

test('index.html ships the line inside the hero badge row', () => {
  // The stub answers any id on demand, so the markup facts are pinned from
  // source (the status-health convention): the line is a quiet caption in the
  // badges row of the status hero — not a new card, not a second banner.
  const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(source, /<span class="section-note" id="claims-line" hidden><\/span>/);
  const at = {
    panel: source.indexOf('id="panel-status"'),
    badges: source.indexOf('class="badges"'),
    claims: source.indexOf('id="claims-line"'),
    power: source.indexOf('id="power"'),
    figures: source.indexOf('aria-label="Live figures"'),
  };
  for (const [marker, position] of Object.entries(at)) {
    assert.notEqual(position, -1, `${marker} is missing from web/index.html`);
  }
  assert.ok(
    at.panel < at.badges && at.badges < at.claims && at.claims < at.power && at.power < at.figures,
    'the claims line sits in the badge row, inside the hero',
  );
});

test('styles.css keeps a colour consumer for every painted tone', () => {
  // The paint tests above assert the attribute, but a stub element never
  // resolves CSS: deleting the rules would pass the suite while the tone
  // distinction went invisible — the exact gap the harden stage once found
  // and closed (918fb22). The consumers are pinned from source, the same
  // convention as the index.html placement pin above.
  const source = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(source, /#claims-line\[data-tone='warn'\] \{\s*color: var\(--warn\);/);
  assert.match(source, /#claims-line\[data-tone='accent'\] \{\s*color: var\(--accent\);/);
});

test('the claims document is one subscription through the shared watch path', () => {
  // The same pin as the health document (test/web/store.test.js): one
  // `watch` call — no query, no index — so the denied() gate stays in one
  // place and an absent document reaches the screen as null.
  const source = readFileSync(new URL('../../web/js/store.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function startStore(');
  assert.ok(start >= 0, 'store.js declares startStore');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'store.js closes startStore');
  const body = source.slice(start, end + 2).replace(/\s+/g, ' ');
  assert.match(
    body,
    /unsubClaims = watch\( 'status\/claims', \(data\) => onClaims && onClaims\(data\), \(err\) => onClaimsError && onClaimsError\(err\), \);/,
    'the claims listener mirrors the status/notifications watch idiom',
  );
});

test('app.js fans the claims callbacks out to the screen', () => {
  // The wiring under the store options: data to showClaims, and a failed
  // listener as a null document — the line hides rather than presenting the
  // last reason as current. Pinned from source (the config-lifetime
  // convention): app.js runs only as a browser module.
  const source = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*showClaims,[^}]*\} from '\.\/js\/screens\/status\.js';/s);
  assert.match(source, /onClaims: showClaims,/);
  assert.match(source, /onClaimsError: \(\) => showClaims\(null\),/);
});
