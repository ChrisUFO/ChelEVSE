// Charger health presentation for the Status screen (#158).
//
// Pure and DOM-free: `healthState` projects the bridge's `status/notifications`
// document — the gateway's live advisory ring in the three-fact model — into
// exactly what the health card paints. `test/web/health.test.js` drives it
// directly; `screens/status.js` only writes the result into the DOM.
//
// The three facts are never merged into one verdict:
//
//   severity      the firmware's own rating, passed through verbatim. A cleared
//                 ground fault stays "critical" — liveness never rewrites it;
//   acknowledged  the owner's mute: the gateway's own `acked` flag, or the
//                 `acks[<id>]` record the ack command writes immediately (D5);
//   liveness      the bridge's `classification`: whether a live signal the
//                 bridge already polls corroborates the condition *now*.
//
// So a counter-derived critical reads as **recorded**, not as a live emergency,
// and an acknowledged entry stays listed as dismissed-and-kept-for-the-record
// rather than disappearing. The card never infers safety: "No advisories" is a
// statement about the gateway's list, an open firmware gate makes even that
// incomplete, and a missing/unreadable/stale document is "Health unknown".
// Nothing here reads `status/current`, so no copy can tie health to whether the
// charger is charging.
//
// Bridge liveness is not this module's business at all: the freshness banner on
// `status/current` owns it (D8). The document is written only when its content
// changes, so `checked_at` dates the last change, not a heartbeat — the 24 h
// bound below is a last-resort guard on an ever-change document, never a poll-
// cadence staleness test.

import { dateLabel } from './format.js';

// The guard window, not a heartbeat: a health document older than this cannot
// vouch for the charger any more, whatever its content. Deliberately generous —
// a stable, healthy charger legitimately writes nothing for days.
export const HEALTH_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// The firmware's three severities, labelled for display. Anything else is
// passed through capitalised rather than silently dropped.
const SEVERITY_LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' };
// Ordering and tone both run off this: a live condition is ranked by how the
// firmware rated it, and a live entry with no usable severity is reported at
// warning weight (present, but not shouted).
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };
const TONE = { critical: 'err', warning: 'warn', info: 'accent' };

const PRESENTATION_LABEL = { active: 'Active', recorded: 'Recorded', acknowledged: 'Acknowledged' };
// Active first, then the records newest-first, then what the owner muted.
const ORDER = { active: 0, recorded: 1, acknowledged: 2 };

// Human names for the firmware's own rule ids, so the card reads as English and
// the raw id rides the meta line for cross-referencing. The table is the
// firmware's bounded rule set (15 ids, `notifications_rules.cpp`); a newer rule
// falls back to its id's tail rather than disappearing.
const NAMES = {
  'safety.ground_check': 'Ground check',
  'safety.relay_check': 'Relay check',
  'safety.diode_check': 'Diode check',
  'safety.vent_check': 'Vent check',
  'safety.temp_check': 'Temperature check',
  'fault.gfci_tripped': 'GFCI tripped',
  'fault.no_ground': 'No ground',
  'fault.stuck_relay': 'Stuck relay',
  'thermal.high_temp': 'High temperature',
  'thermal.relay_thermal': 'Relay temperature',
  'thermal.throttling': 'Throttling',
  'wear.relay_life': 'Relay life',
  'wear.relay_cold_open': 'Relay cold open',
  'wear.relay_transit_drift': 'Relay transit drift',
  'wear.stuck_relay_recovery': 'Stuck relay recovery',
};

// Why there is no health to show. Each is a different fact about the report, so
// each gets its own sentence — none of them is "no faults".
const UNKNOWN_DETAIL = {
  absent: 'The charger hasn’t reported its health yet.',
  unreachable: 'The bridge couldn’t reach the charger at its last check.',
  unsupported: 'This charger’s firmware doesn’t report health.',
  unusable: 'The health report couldn’t be read.',
  error: 'Couldn’t load charger health.',
};
const STALE_DETAIL = 'The last health report is over a day old.';
const UNDATED_DETAIL = 'The last health report has no usable check time.';

function epochSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function humanise(id) {
  const tail = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id;
  const words = tail.replace(/_/g, ' ').trim();
  return words ? capitalise(words) : 'Advisory';
}

export function advisoryName(id) {
  if (typeof id !== 'string' || !id) return 'Advisory';
  return NAMES[id] || humanise(id);
}

// "Checked 14:32" while the report is from today, "Checked 8 Nov" once a clock
// time would be ambiguous. A fixed stamp, not a relative age: this card is not
// repainted by the status ticker, so an age string would silently drift.
function checkedLabel(seconds, nowMs) {
  const date = new Date(seconds * 1000);
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (!sameDay) return `Checked ${dateLabel(seconds, nowMs)}`;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `Checked ${hh}:${mm}`;
}

// What the card says when a firmware gate is open. The gateway evaluates its
// rules from caches that can still be unknown and stays silent while they are,
// so silence under an open gate is a gap, never health (D7). "Safety" is the
// `$GE` settings word (the `safety.*` family), "relay health" the `$GL` block
// (`wear.*` and `thermal.relay_thermal`).
function gateSentence(gates) {
  const safety = gates.settings_known === true ? '' : 'safety';
  const relay = gates.relay_health_known === true ? '' : 'relay';
  if (safety && relay) {
    return 'Safety and relay checks aren’t reported, so some advisory checks may be missing.';
  }
  if (safety) return 'Safety checks aren’t reported, so some advisory checks may be missing.';
  if (relay) return 'Relay health isn’t reported, so some advisory checks may be missing.';
  return '';
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// The counts sentence (or the single-class sentence), and the title. Mixed
// lists count everything; a one-class list names that class and says what it
// means for the record.
function summary(counts) {
  const { active, recorded, acknowledged } = counts;
  const total = active + recorded + acknowledged;
  if (total === 0) {
    return { title: 'No advisories', detail: 'The charger’s last health check listed none.' };
  }
  const classes = [active, recorded, acknowledged].filter((count) => count > 0).length;
  if (classes > 1) {
    const parts = [];
    if (active) parts.push(`${active} active`);
    if (recorded) parts.push(`${recorded} recorded`);
    if (acknowledged) parts.push(`${acknowledged} acknowledged`);
    return { title: plural(total, 'advisory', 'advisories'), detail: `${parts.join(', ')}.` };
  }
  if (active) {
    return {
      title: plural(active, 'active advisory', 'active advisories'),
      detail:
        active === 1
          ? 'The charger reports this condition now.'
          : 'The charger reports these conditions now.',
    };
  }
  if (recorded) {
    return {
      title: plural(recorded, 'recorded advisory', 'recorded advisories'),
      // The classification's own meaning, in the owner's words: a counter or
      // lifetime record with no live signal behind it. This is what keeps a
      // critical fault from reading as a live emergency.
      detail: 'Recorded by the charger, not reported as present now.',
    };
  }
  return {
    title: plural(acknowledged, 'acknowledged advisory', 'acknowledged advisories'),
    detail: 'Dismissed on the charger, kept here for the record.',
  };
}

// The five reason-specific states are one shape, so the screen paints one
// thing whichever of them it is.
function unknownState(reason, checkedAt, nowMs) {
  const detail =
    reason === 'stale'
      ? checkedAt
        ? STALE_DETAIL
        : UNDATED_DETAIL
      : UNKNOWN_DETAIL[reason] || UNKNOWN_DETAIL.absent;
  return {
    state: 'unknown',
    reason,
    tone: 'muted',
    title: 'Health unknown',
    detail,
    // The stamp of a report we cannot use is still worth showing: it is why the
    // card is unknown, and it dates the last thing the bridge managed to write.
    meta: checkedAt ? checkedLabel(checkedAt, nowMs) : '',
    incomplete: false,
    gates: null,
    caveat: '',
    advisories: [],
    counts: { active: 0, recorded: 0, acknowledged: 0 },
  };
}

// Acknowledged wins over the stored classification: `acks[<id>]` is the ack
// command's own record, written before the next 300 s poll can report the
// gateway's `acked` flag (D5). An entry with no usable classification falls back
// to the corroboration fact rather than defaulting to either extreme.
function presentationOf(entry, acks) {
  if (entry.acked === true) return 'acknowledged';
  if (typeof entry.id === 'string' && acks && Object.hasOwn(acks, entry.id)) {
    return 'acknowledged';
  }
  if (entry.classification === 'acknowledged') return 'acknowledged';
  if (entry.classification === 'active') return 'active';
  if (entry.classification === 'historical') return 'recorded';
  return entry.corroborated === true ? 'active' : 'recorded';
}

function advisoryRow(entry, acks, nowMs) {
  const id = typeof entry.id === 'string' ? entry.id : '';
  const severity = typeof entry.severity === 'string' ? entry.severity : '';
  const presentation = presentationOf(entry, acks);
  const firstSeen = epochSeconds(entry.first_seen);
  return {
    id,
    name: advisoryName(id),
    severity,
    severityLabel: severity ? SEVERITY_LABEL[severity] || capitalise(severity) : '',
    presentation,
    presentationLabel: PRESENTATION_LABEL[presentation],
    seen: firstSeen ? `First seen ${dateLabel(firstSeen, nowMs)}` : '',
    since: firstSeen || 0,
  };
}

// Active first (worst severity, then newest), then the records newest-first,
// then the muted ones. A stable, meaningful order so the list does not
// reshuffle between snapshots.
function compareRows(a, b) {
  const group = ORDER[a.presentation] - ORDER[b.presentation];
  if (group) return group;
  if (a.presentation === 'active') {
    const severity = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (severity) return severity;
  }
  return b.since - a.since;
}

// The card's marker colour: only a live corroborated condition (its severity)
// or an incomplete check (amber) earns one. A complete report with no
// advisories stays neutral — green would read as a safety verdict the app has
// no basis for.
function toneFor(rows, incomplete) {
  const actives = rows.filter((row) => row.presentation === 'active');
  if (actives.length) {
    const worst = actives.reduce(
      (rank, row) => Math.max(rank, SEVERITY_RANK[row.severity] || 0),
      0,
    );
    const severity = Object.keys(SEVERITY_RANK).find((key) => SEVERITY_RANK[key] === worst);
    return (severity && TONE[severity]) || 'warn';
  }
  return incomplete ? 'warn' : 'muted';
}

function countRows(rows) {
  const counts = { active: 0, recorded: 0, acknowledged: 0 };
  for (const row of rows) counts[row.presentation] += 1;
  return counts;
}

/**
 * Project `status/notifications` into the health card's render state.
 *
 * `doc` is the document's data (null/absent when the listener reported no
 * document), `error` says the listener failed, and `nowMs` is the clock the
 * 24 h guard and the date labels read.
 *
 * Returns `{state, reason, tone, title, detail, meta, incomplete, gates,
 * caveat, advisories, counts}`:
 *   state      `unknown` | `incomplete` (gate open, nothing listed) |
 *              `none` (both gates closed, nothing listed) | `advisories`
 *   tone       `muted` | `warn` | `err` | `accent` — the card's marker colour
 *   caveat     the open-gate sentence when advisories are listed beside one
 *              (never at the same time as an `incomplete` headline)
 */
export function healthState({ doc, error = false, nowMs = Date.now() } = {}) {
  if (error) return unknownState('error', null, nowMs);
  if (!doc || typeof doc !== 'object') return unknownState('absent', null, nowMs);
  if (doc.source === 'unsupported') return unknownState('unsupported', null, nowMs);
  if (doc.reachable === false) return unknownState('unreachable', null, nowMs);
  // Anything that does not positively report a successful check is unknown, not
  // health: an absent flag is exactly the silence this card must not read as
  // good news.
  if (doc.reachable !== true) return unknownState('unusable', null, nowMs);
  const checkedAt = epochSeconds(doc.checked_at);
  if (checkedAt == null) return unknownState('stale', null, nowMs);
  if (nowMs - checkedAt * 1000 > HEALTH_STALE_AFTER_MS) {
    return unknownState('stale', checkedAt, nowMs);
  }

  // Strict `true`: an absent gate object is a report that cannot say which
  // rules it evaluated, which is an open gate — never a closed one.
  const gates = {
    settings_known: doc.gates && doc.gates.settings_known === true,
    relay_health_known: doc.gates && doc.gates.relay_health_known === true,
  };
  const incomplete = !gates.settings_known || !gates.relay_health_known;
  const caveat = gateSentence(gates);
  const acks = doc.acks && typeof doc.acks === 'object' ? doc.acks : null;
  const entries = Array.isArray(doc.advisories) ? doc.advisories : [];
  const advisories = entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => advisoryRow(entry, acks, nowMs))
    .sort(compareRows);
  const counts = countRows(advisories);
  const meta = checkedLabel(checkedAt, nowMs);

  // Silence under an open gate is incomplete health, never "no advisories".
  // With something listed, the list is the headline and the gate rides the
  // caveat line instead, so the same sentence never appears twice.
  if (!advisories.length && incomplete) {
    return {
      state: 'incomplete',
      reason: null,
      tone: 'warn',
      title: 'Health incomplete',
      detail: caveat,
      meta,
      incomplete,
      gates,
      caveat: '',
      advisories,
      counts,
    };
  }

  const said = summary(counts);
  return {
    state: advisories.length ? 'advisories' : 'none',
    reason: null,
    tone: toneFor(advisories, incomplete),
    title: said.title,
    detail: said.detail,
    meta,
    incomplete,
    gates,
    caveat: advisories.length ? caveat : '',
    advisories,
    counts,
  };
}
