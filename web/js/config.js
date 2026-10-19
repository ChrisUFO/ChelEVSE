// Pure helpers for the Config screen's curated charger snapshot and its raw
// JSON view. No DOM, no Firebase — covered by test/web.

const REDACTED = '***';

const AMP_KEYS = new Set(['min_current_hard', 'max_current_hard', 'max_current_soft']);

// Only the fields a person can act on: everything else stays in the Raw JSON.
// Order is the section order on screen.
const CONFIG_SECTIONS = [
  {
    id: 'device',
    title: 'Device',
    rows: [
      { key: 'hostname', label: 'Hostname' },
      { key: 'firmware', label: 'EVSE firmware' },
      { key: 'version', label: 'WiFi firmware' },
      { key: 'protocol', label: 'Protocol' },
      { key: 'service', label: 'Service level' },
      { key: 'buildenv', label: 'Build' },
      { key: 'evse_serial', label: 'EVSE serial' },
    ],
  },
  {
    id: 'limits',
    title: 'Limits',
    rows: [
      { key: 'min_current_hard', label: 'Minimum current' },
      { key: 'max_current_hard', label: 'Maximum current' },
      { key: 'max_current_soft', label: 'Soft maximum' },
      { key: 'limit_default_type', label: 'Default limit type' },
      { key: 'limit_default_value', label: 'Default limit amount' },
    ],
  },
  {
    id: 'safety',
    title: 'Safety',
    rows: [
      { key: 'gfci_check', label: 'GFCI check' },
      { key: 'ground_check', label: 'Ground check' },
      { key: 'relay_check', label: 'Relay check' },
      { key: 'temp_check', label: 'Temperature check' },
      { key: 'vent_check', label: 'Vent check' },
      { key: 'diode_check', label: 'Diode check' },
      { key: 'ohm_enabled', label: 'OhmConnect' },
    ],
  },
  {
    id: 'network',
    title: 'Network',
    rows: [
      { key: 'ssid', label: 'Wi-Fi network' },
      { key: 'pass', label: 'Wi-Fi password' },
      { key: 'time_zone', label: 'Time zone' },
      { key: 'sntp_enabled', label: 'Clock sync' },
      { key: 'sntp_hostname', label: 'NTP server' },
      { key: 'http_supported_protocols', label: 'HTTP protocols' },
    ],
  },
  {
    id: 'integrations',
    title: 'Integrations',
    rows: [
      { key: 'mqtt_enabled', label: 'MQTT' },
      { key: 'ocpp_enabled', label: 'OCPP' },
      { key: 'emoncms_enabled', label: 'Emoncms' },
      { key: 'tesla_enabled', label: 'Tesla' },
      { key: 'divert_enabled', label: 'Solar divert' },
      { key: 'current_shaper_enabled', label: 'Current shaper' },
    ],
  },
];

function isRedacted(value) {
  return value === REDACTED;
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function formatService(value) {
  if (value === 1) return 'Level 1';
  if (value === 2) return 'Level 2';
  return formatNumber(value);
}

// The firmware reports limit types as strings ("time", "energy", "none"); a
// numeric type is shown as-is rather than guessed.
function formatLimitType(value) {
  if (typeof value === 'string' && value.trim()) {
    const lower = value.trim().toLowerCase();
    if (lower === 'time') return 'Time';
    if (lower === 'energy') return 'Energy';
    if (lower === 'none') return 'None';
    return value;
  }
  return formatNumber(value);
}

// Unknown keys are deliberately not here: the Raw JSON is the complete view.
export function formatConfigValue(key, value) {
  if (isRedacted(value)) return 'Redacted';
  if (value == null) return 'Not reported';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) {
    return value.length ? value.map((item) => String(item)).join(' · ') : 'None';
  }
  if (typeof value === 'string') {
    if (key === 'limit_default_type') return formatLimitType(value);
    return value.trim() ? value : 'Not set';
  }
  if (typeof value === 'number') {
    if (AMP_KEYS.has(key)) return `${formatNumber(value)} A`;
    if (key === 'service') return formatService(value);
    if (key === 'limit_default_type') return formatLimitType(value);
    if (key === 'limit_default_value') return value === 0 ? 'No limit' : formatNumber(value);
    return formatNumber(value);
  }
  if (typeof value === 'object') return 'See Raw JSON';
  return String(value);
}

function configTone(value) {
  if (isRedacted(value)) return 'redacted';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value == null || value === '') return 'muted';
  return '';
}

// Curated sections, filtered to the fields this snapshot actually reports.
// Empty sections are omitted so a partial document stays compact.
export function buildConfigSections(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  return CONFIG_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    rows: section.rows
      .filter((row) => Object.hasOwn(config, row.key))
      .map((row) => ({
        key: row.key,
        label: row.label,
        value: formatConfigValue(row.key, config[row.key]),
        tone: configTone(config[row.key]),
      })),
  })).filter((section) => section.rows.length > 0);
}

// Raw JSON is the complete view, including keys the curated map does not know.
// Firestore timestamps become ISO strings so the panel stays readable; redacted
// values are the bridge's own "***" sentinel and are printed unchanged.
function plainValue(value) {
  if (value && typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return String(value);
    }
  }
  if (Array.isArray(value)) return value.map(plainValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = plainValue(item);
    return out;
  }
  return value;
}

export function rawConfigJson(config) {
  if (!config || typeof config !== 'object') return '{}';
  try {
    return JSON.stringify(plainValue(config), null, 2);
  } catch {
    return '{}';
  }
}
