// Config screen: a read-only, curated view of status/config plus the complete
// snapshot in a collapsed Raw JSON panel. Changes go through the Advanced
// console; the data layer keeps this screen a pure renderer.

import { $, setText } from '../ui.js';
import { buildConfigSections, rawConfigJson } from '../config.js';

let config = null;
let configLoaded = false;
let configFailed = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function updatedLabel(data) {
  const updated = data && data.updated_at;
  if (!updated || typeof updated.toDate !== 'function') return '';
  try {
    const time = updated.toDate().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `Updated ${time}`;
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
  setText($('config-updated'), config ? updatedLabel(config) : '');

  if (configFailed || !configLoaded) {
    sections.replaceChildren();
    empty.hidden = true;
    rawDetails.hidden = true;
    setText($('config-raw'), '');
    return;
  }

  if (!config) {
    sections.replaceChildren();
    empty.hidden = false;
    setText(empty, 'No configuration reported yet. The bridge refreshes it about once a minute.');
    rawDetails.hidden = true;
    setText($('config-raw'), '');
    return;
  }

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
  if (!$('config-sections')) return;
  render();
}
