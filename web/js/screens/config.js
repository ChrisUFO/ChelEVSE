// Config screen: a read-only, curated view of status/config plus the complete
// snapshot in a collapsed Raw JSON panel. Changes go through the Advanced
// console; the data layer keeps this screen a pure renderer.

import { $, setText } from '../ui.js';
import { buildConfigSections, configSignature, rawConfigJson } from '../config.js';
import { fmtK, toNumber } from '../format.js';

let config = null;
let configLoaded = false;
let configFailed = false;
// Signature of the snapshot currently on screen, so a replace that only bumps
// `updated_at` refreshes the heading instead of rebuilding the panel (which
// would collapse a text selection the user is copying).
let renderedSignature = null;
// status/current.total_energy (kWh) — the Lifetime figure's small home since
// the Status figures row gave its tile to the session cost (#116).
let lifetime = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// "Synced", not "Updated": under MQTT the bridge replaces `status/config` only
// when the charger's `config_version` changes, so `updated_at` marks the
// config's last change, not a fetch (issue #99).
function syncedLabel(data) {
  const updated = data && data.updated_at;
  if (!updated || typeof updated.toDate !== 'function') return '';
  try {
    const time = updated.toDate().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `Synced ${time}`;
  } catch {
    return '';
  }
}

function render() {
  const loading = $('config-loading');
  const error = $('config-error');
  const empty = $('config-empty');
  const sections = $('config-sections');
  const rawDetails = $('config-raw-details');

  loading.hidden = configLoaded || configFailed;
  error.hidden = !configFailed;
  setText($('config-updated'), config ? syncedLabel(config) : '');

  if (configFailed || !configLoaded) {
    renderedSignature = null;
    sections.replaceChildren();
    empty.hidden = true;
    rawDetails.hidden = true;
    setText($('config-raw'), '');
    return;
  }

  if (!config) {
    renderedSignature = null;
    sections.replaceChildren();
    empty.hidden = false;
    setText(empty, 'No configuration reported yet. The bridge refreshes it about once a minute.');
    rawDetails.hidden = true;
    setText($('config-raw'), '');
    return;
  }

  const signature = configSignature(config);
  if (signature && signature === renderedSignature) return;
  renderedSignature = signature;

  const curated = buildConfigSections(config);
  sections.replaceChildren(
    ...curated.map((section) => {
      const card = el('section', 'config-card');
      card.setAttribute('aria-labelledby', `config-${section.id}`);
      const heading = el('h3', null, section.title);
      heading.id = `config-${section.id}`;
      const list = el('dl', 'config-list');
      for (const row of section.rows) {
        const line = el('div', 'config-row');
        line.dataset.key = row.key;
        const value = el('dd', row.tone ? `cfg-${row.tone}` : null, row.value);
        // The value is the literal "***" marker; the word only exists for
        // assistive tech so the marker is not read as punctuation.
        if (row.tone === 'redacted') value.append(el('span', 'sr-only', ' (redacted)'));
        line.append(el('dt', null, row.label), value);
        list.append(line);
      }
      card.append(heading, list);
      return card;
    }),
  );

  const hasCurated = curated.length > 0;
  empty.hidden = hasCurated;
  if (!hasCurated) {
    setText(
      empty,
      'This snapshot has no settings this screen recognises. Every field is still listed in the Raw JSON below.',
    );
  }
  rawDetails.hidden = false;
  setText($('config-raw'), rawConfigJson(config));
}

// status/config — a missing document is "not reported yet"; a listener error is
// the failed state.
export function showConfigData(data) {
  config = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  configLoaded = true;
  configFailed = false;
  render();
}

// status/current.total_energy, fanned out from the status listener: one plain
// line beside the charger details, hidden until a usable value exists.
export function showLifetimeEnergy(totalKwh) {
  lifetime = totalKwh;
  renderLifetime();
}

function renderLifetime() {
  const el = $('lifetime-note');
  const kwh = toNumber(lifetime);
  el.hidden = !(Number.isFinite(kwh) && kwh > 0);
  setText(el, `Lifetime energy: ${fmtK(kwh)} kWh`);
}

export function showConfigError() {
  config = null;
  configLoaded = true;
  configFailed = true;
  render();
}

// ---------- screen lifecycle ----------

export function initConfig() {
  $('config-goto-advanced').addEventListener('click', () => {
    location.hash = 'advanced';
  });
  render();
}

export function resetConfig() {
  config = null;
  configLoaded = false;
  configFailed = false;
  lifetime = null;
  renderLifetime();
  if (!$('config-sections')) return;
  render();
}
