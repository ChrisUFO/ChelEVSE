import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConfigSections,
  configSignature,
  formatConfigValue,
  rawConfigJson,
} from '../../web/js/config.js';

test('formatConfigValue turns charger values into human text', () => {
  assert.equal(formatConfigValue('gfci_check', true), 'On');
  assert.equal(formatConfigValue('gfci_check', false), 'Off');
  assert.equal(formatConfigValue('pass', '***'), '***');
  assert.equal(formatConfigValue('sntp_hostname', null), 'Not reported');
  assert.equal(formatConfigValue('ssid', ''), 'Not set');
  assert.equal(formatConfigValue('http_supported_protocols', ['http', 'https']), 'http · https');
  assert.equal(formatConfigValue('http_supported_protocols', []), 'None');
  assert.equal(formatConfigValue('min_current_hard', 6), '6 A');
  assert.equal(formatConfigValue('max_current_soft', 32.5), '32.5 A');
  assert.equal(formatConfigValue('service', 1), 'Level 1');
  assert.equal(formatConfigValue('service', 2), 'Level 2');
  assert.equal(formatConfigValue('service', 0), '0');
  assert.equal(formatConfigValue('limit_default_type', 'time'), 'Time');
  assert.equal(formatConfigValue('limit_default_type', 'energy'), 'Energy');
  assert.equal(formatConfigValue('limit_default_type', 'none'), 'None');
  assert.equal(formatConfigValue('limit_default_value', 0), 'No limit');
  assert.equal(formatConfigValue('limit_default_value', 30), '30');
  assert.equal(formatConfigValue('hostname', 'chelevse-driveway'), 'chelevse-driveway');
  assert.equal(formatConfigValue('updated_at', { nested: true }), 'See Raw JSON');
});

test('the charger numeric unset sentinels read as absent', () => {
  // OpenEVSE reports absent uint32/uint64 settings as 2^32 − 1 and 2^64 − 1;
  // the bridge stores the latter as a float, which rounds to 2^64.
  assert.equal(formatConfigValue('max_current_soft', 2 ** 32 - 1), '—');
  assert.equal(formatConfigValue('min_current_hard', 2 ** 32 - 1), '—');
  assert.equal(formatConfigValue('max_current_soft', 18446744073709551615), '—');
  assert.equal(formatConfigValue('limit_default_value', 2 ** 64), '—');
  // Real values still format normally.
  assert.equal(formatConfigValue('max_current_soft', 32), '32 A');
  assert.equal(formatConfigValue('max_current_soft', 4294967294), '4294967294 A');
  assert.equal(formatConfigValue('max_current_soft', 0), '0 A');
});

test('buildConfigSections curates known fields and omits unknown keys', () => {
  const config = {
    hostname: 'chelevse-driveway',
    firmware: '8.2.2',
    version: 'v5.1.5',
    protocol: '-',
    service: 2,
    buildenv: 'openevse_wifi_v1',
    evse_serial: 'M06SBEFF0B787B',
    min_current_hard: 6,
    max_current_hard: 48,
    max_current_soft: 2 ** 64,
    limit_default_type: 'time',
    limit_default_value: 0,
    gfci_check: true,
    ground_check: true,
    temp_check: false,
    ohm_enabled: false,
    ssid: 'home',
    pass: '***',
    time_zone: 'Europe/London',
    sntp_enabled: true,
    sntp_hostname: 'pool.ntp.org',
    http_supported_protocols: ['http', 'https'],
    mqtt_enabled: true,
    mqtt_server: 'mqtt.example',
    ocpp_enabled: false,
    divert_enabled: false,
    current_shaper_enabled: true,
    // Unknown to the curated map: Raw JSON only.
    wifi_serial: 'B0A732FDCF04',
    espflash: 16777216,
  };
  const sections = buildConfigSections(config);
  assert.deepEqual(
    sections.map((section) => section.id),
    ['device', 'limits', 'safety', 'network', 'integrations'],
  );
  const rows = sections.flatMap((section) => section.rows);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.mqtt_server, undefined);
  assert.equal(byKey.wifi_serial, undefined);
  assert.equal(byKey.espflash, undefined);
  assert.equal(byKey.updated_at, undefined);
  assert.equal(byKey.hostname.value, 'chelevse-driveway');
  assert.equal(byKey.service.value, 'Level 2');
  assert.equal(byKey.min_current_hard.value, '6 A');
  // An unset numeric limit stays visible as absent rather than "1.8e+19 A".
  assert.equal(byKey.max_current_soft.value, '—');
  assert.equal(byKey.limit_default_value.value, 'No limit');
  assert.equal(byKey.gfci_check.value, 'On');
  assert.equal(byKey.gfci_check.tone, 'on');
  assert.equal(byKey.temp_check.value, 'Off');
  assert.equal(byKey.temp_check.tone, 'off');
  assert.equal(byKey.pass.value, '***');
  assert.equal(byKey.pass.tone, 'redacted');
  // The charger's "-" sentinel is a dead row: omitted here, kept in Raw JSON.
  assert.equal(byKey.protocol, undefined);
  assert.equal(byKey.http_supported_protocols.value, 'http · https');
  assert.equal(byKey.mqtt_enabled.value, 'On');
  assert.equal(byKey.divert_enabled.tone, 'off');
});

test('buildConfigSections omits empty sections and tolerates missing documents', () => {
  assert.deepEqual(buildConfigSections(null), []);
  assert.deepEqual(buildConfigSections(undefined), []);
  assert.deepEqual(buildConfigSections('nope'), []);
  assert.deepEqual(buildConfigSections([]), []);
  assert.deepEqual(buildConfigSections({ wifi_serial: 'x' }), []);
  const onlyDevice = buildConfigSections({ hostname: 'garage' });
  assert.deepEqual(
    onlyDevice.map((section) => section.id),
    ['device'],
  );
});

test('rawConfigJson keeps every content field, redactions, and readable timestamps', () => {
  const config = {
    hostname: 'chelevse-driveway',
    pass: '***',
    protocol: '-',
    wifi_serial: 'B0A732FDCF04',
    updated_at: { toDate: () => new Date('2026-10-19T12:34:56.000Z') },
    nested: { list: [1, true], at: { toDate: () => new Date('2026-10-18T00:00:00.000Z') } },
  };
  const raw = rawConfigJson(config);
  assert.match(raw, /"hostname": "chelevse-driveway"/);
  assert.match(raw, /"pass": "\*\*\*"/);
  assert.match(raw, /"protocol": "-"/);
  assert.match(raw, /"wifi_serial": "B0A732FDCF04"/);
  assert.match(raw, /"nested": \{/);
  assert.match(raw, /"at": "2026-10-18T00:00:00.000Z"/);
  // The heading already shows this timestamp; repeating it in the snapshot
  // would make the text change on a replace the screen skips rebuilding.
  assert.doesNotMatch(raw, /updated_at/);
  assert.equal(rawConfigJson(null), '{}');
  assert.equal(rawConfigJson('nope'), '{}');
});

test('configSignature ignores updated_at and key order', () => {
  const first = {
    hostname: 'chelevse-driveway',
    max_current_soft: 32,
    updated_at: { toDate: () => new Date('2026-10-19T12:00:00.000Z') },
    nested: { list: [1, true], flag: false },
  };
  const polled = {
    nested: { flag: false, list: [1, true] },
    updated_at: { toDate: () => new Date('2026-10-19T12:01:00.000Z') },
    max_current_soft: 32,
    hostname: 'chelevse-driveway',
  };
  // Same charger data, a new `updated_at` and property order: one signature, so
  // the screen can leave the panel and any text selection alone.
  assert.equal(configSignature(first), configSignature(polled));
  assert.notEqual(configSignature(first), '');
  assert.ok(!configSignature(first).includes('updated_at'));
});

test('configSignature changes with any rendered value', () => {
  const base = { hostname: 'garage', max_current_soft: 32, wifi_serial: 'B0A732FDCF04' };
  const signature = configSignature(base);
  // A curated field.
  assert.notEqual(configSignature({ ...base, max_current_soft: 16 }), signature);
  // A field only the Raw JSON shows.
  assert.notEqual(configSignature({ ...base, wifi_serial: 'FFFF' }), signature);
  // A key the screen has never seen before.
  assert.notEqual(configSignature({ ...base, espflash: 16777216 }), signature);
  // A timestamp change on its own is still not a change.
  assert.equal(configSignature({ ...base, updated_at: { toDate: () => new Date(0) } }), signature);
});

test('configSignature reports no signature for unusable documents', () => {
  assert.equal(configSignature(null), '');
  assert.equal(configSignature(undefined), '');
  assert.equal(configSignature('nope'), '');
  assert.equal(configSignature([]), '');
  // An empty document is a valid signature; the screen renders its empty state.
  assert.equal(configSignature({}), '{}');
  assert.equal(configSignature({ updated_at: 1 }), '{}');
});

// ---------- screen rendering ----------

// The Config screen renders into the live DOM. Give it the smallest document it
// needs — one stub element per id — and import the module afterwards; every
// lookup is deferred to render time (same pattern as status-pulse.test.js).
function stubElement() {
  return {
    hidden: false,
    textContent: '',
    dataset: {},
    attrs: {},
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes;
      this.textContent = nodes.map((node) => node.textContent || '').join('');
    },
    append(...nodes) {
      this.children.push(...nodes);
      this.textContent += nodes.map((node) => node.textContent || '').join('');
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener() {},
  };
}

const elements = new Map();
const element = (id) => {
  let node = elements.get(id);
  if (!node) {
    node = stubElement();
    elements.set(id, node);
  }
  return node;
};

globalThis.document = {
  getElementById: (id) => element(id),
  createElement: () => stubElement(),
};

const { showConfigData } = await import('../../web/js/screens/config.js');

const clock = (iso) => ({ toDate: () => new Date(iso) });
const heading = () => element('config-updated').textContent;
const panelNodes = () => element('config-sections').children;
const asHeadingTime = (date) =>
  `Synced ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

test("the heading says Synced HH:MM — the config's last change, not a poll", () => {
  // Under MQTT the bridge replaces status/config only when config_version
  // changes, so updated_at marks the last change (#99); the time itself
  // follows the viewer's locale, like the status screen's timestamps.
  const when = new Date('2026-10-22T17:01:00');
  showConfigData({ hostname: 'garage', updated_at: { toDate: () => when } });
  assert.equal(heading(), asHeadingTime(when));
  // No usable timestamp: no heading, no throw.
  showConfigData({ hostname: 'garage' });
  assert.equal(heading(), '');
});

test('a replace that only moves updated_at refreshes the heading, not the panel', () => {
  // The skip-rebuild contract: unchanged content with a new timestamp (an
  // HTTP-mode poll, an MQTT reconnect republish) moves only the heading, so a
  // text selection in the panel or Raw JSON survives; a real change rebuilds.
  showConfigData({ hostname: 'garage', updated_at: clock('2026-10-22T17:01:00') });
  const built = panelNodes();
  assert.ok(built.length > 0);

  showConfigData({ hostname: 'garage', updated_at: clock('2026-10-22T18:02:00') });
  assert.equal(panelNodes(), built, 'an unchanged snapshot must not rebuild the panel');
  assert.equal(heading(), asHeadingTime(new Date('2026-10-22T18:02:00')));

  showConfigData({ hostname: 'driveway', updated_at: clock('2026-10-22T18:02:00') });
  assert.notEqual(panelNodes(), built, 'a changed value must rebuild the panel');
});

test('each curated group is a collapsed disclosure with its heading in the summary', () => {
  // The snapshot card's structure contract: one <details class="disclosure
  // config-group"> per curated group, no `open` attribute — collapsed by
  // default, so a rebuild (a genuine content change) re-collapses every group
  // while the signature skip keeps an open group open across a timestamp-only
  // replace. The summary carries the group's h3, keeping the heading
  // hierarchy h1 panel → h2 card → h3 group.
  showConfigData({ hostname: 'garage', gfci_check: true });
  const groups = panelNodes();
  assert.ok(groups.length > 0);
  const [first, second] = groups;
  assert.equal(first.className, 'disclosure config-group');
  assert.equal(first.children[0].children[0].textContent, 'Device');
  assert.equal(second.children[0].children[0].textContent, 'Safety');
  for (const group of groups) {
    assert.ok(!('open' in group.attrs), 'a built group sets no open attribute');
    assert.equal(group.open, undefined, 'a built group is collapsed');
  }
});
