import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildConfigSections, formatConfigValue, rawConfigJson } from '../../web/js/config.js';

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

test('rawConfigJson keeps every field, redactions, and readable timestamps', () => {
  const config = {
    hostname: 'chelevse-driveway',
    pass: '***',
    protocol: '-',
    wifi_serial: 'B0A732FDCF04',
    updated_at: { toDate: () => new Date('2026-10-19T12:34:56.000Z') },
    nested: { list: [1, true] },
  };
  const raw = rawConfigJson(config);
  assert.match(raw, /"hostname": "chelevse-driveway"/);
  assert.match(raw, /"pass": "\*\*\*"/);
  assert.match(raw, /"protocol": "-"/);
  assert.match(raw, /"wifi_serial": "B0A732FDCF04"/);
  assert.match(raw, /"updated_at": "2026-10-19T12:34:56.000Z"/);
  assert.match(raw, /"list": \[/);
  assert.equal(rawConfigJson(null), '{}');
  assert.equal(rawConfigJson('nope'), '{}');
});
