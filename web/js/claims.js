// The one authoritative "why isn't it charging?" line for the Status hero (#159).
//
// Pure and DOM-free, the health.js pattern: `claimsState` projects the bridge's
// `status/claims` document — the charger's own claim arbitration (GET
// /claims/target), normalized bridge-side by pi/claims.py — into exactly what
// the hero line paints, or null when the line hides. test/web/claims.test.js
// drives it directly; screens/status.js only writes the result into the DOM.
//
// The line is derived SOLELY from the document's `reason`, `source` and
// `reachable`. The winner fields (`winner_state`, `winner_current`) are never
// inputs: a failed fetch merges `reachable: false` into the document and
// leaves the previous winners behind, so anything derived from them could
// name a restriction the charger no longer reports. `detail` is evidence for
// other surfaces; a one-line answer has no use for it.
//
// Staleness is not re-derived here — the freshness banner (renderFreshness →
// format.js freshnessState) stays the only staleness UI, and no new threshold
// or heartbeat joins it. The projection receives the same facts that
// computation reads and asks the machinery itself: `chargerOnline === false`
// is exactly freshnessState's charger verdict, and under it the line hides —
// the banner already says the charger is offline, and the document's last
// arbitration cannot vouch for the present (unknown ≠ guess). Bridge
// staleness (the local cache age) is deliberately NOT an input, the same
// split the health card keeps: age-based verdicts are the banner's business
// alone, and the claims document is written only on change, so it carries no
// heartbeat of its own to test an age against. `stateLabel` rides along as
// the second fact of that same freshness computation, so the projection and
// the banner cannot drift apart on what they were asked about.

import { freshnessState } from './format.js';

// The reason vocabulary (pi/claims.py) and the one line each token paints.
// The tone follows the health card's words: an ordinary, chosen restriction
// reads muted; boost is the one accent (an actively desired state); a safety
// hold is the one warn. The line explains, it never alarms — severity is the
// health card's business.
const REASONS = {
  manual_override: { line: 'Stopped manually', tone: 'muted' },
  schedule: { line: 'Paused by schedule', tone: 'muted' },
  current_limit: { line: 'Limited by current cap', tone: 'muted' },
  boost: { line: 'Boost charge', tone: 'accent' },
  safety: { line: 'Held by safety', tone: 'warn' },
  not_connected: { line: 'Vehicle not connected', tone: 'muted' },
  unknown: { line: 'Reason unavailable', tone: 'muted' },
};

/**
 * Project `status/claims` into the hero line's render state.
 *
 * `doc` is the document's data (null/absent when the listener reported no
 * document); `chargerOnline`/`stateLabel` are the same facts the banner's
 * freshnessState call reads from `status/current`. Returns `{reason, line,
 * tone}` — the token the projection settled on, the copy the line paints, and
 * the health card's tone vocabulary — or null when the line hides: no
 * document, a gateway that cannot answer (`source: 'unsupported'`), a
 * charger-stale verdict, or no restriction at all (`reason: null`).
 */
export function claimsState({ doc, stateLabel, chargerOnline } = {}) {
  // No document, or firmware below 4.1.5 answering 404: nothing confident to
  // say. "Unsupported" must not read as the charger being asked and refusing —
  // the charger was never asked.
  if (!doc || typeof doc !== 'object') return null;
  if (doc.source === 'unsupported') return null;
  // Charger-stale hides the line, and only that freshness verdict does: asked
  // of the existing machinery, with no age to hold a write-on-change document
  // to, so just its charger branch can fire (it needs no age) and the
  // age-based bridge verdict stays the banner's.
  if (
    freshnessState({ chargerOnline, stateLabel, ageMs: Number.POSITIVE_INFINITY }) === 'charger'
  ) {
    return null;
  }
  // A document whose last fetch failed cannot name a reason, whatever a
  // stale `reason` field or the leftover winner fields still say: failure
  // transitions merge `reachable: false` beside `reason: "unknown"`, and the
  // line decides from the fetch fact itself — fail closed either way.
  const token = doc.reachable === false ? 'unknown' : doc.reason;
  if (token == null) return null; // charging/ready with no restriction
  // A token outside the vocabulary (a newer bridge) is a restriction this
  // line cannot name — unknown, the same fail-closed mapping pi/claims.py
  // gives an unmapped winner id, never a hidden line.
  const reason = REASONS[token] ? token : 'unknown';
  const { line, tone } = REASONS[reason];
  return { reason, line, tone };
}
