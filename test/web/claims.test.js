import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claimsState } from '../../web/js/claims.js';
import { CHARGING_STALE_AFTER_MS, freshnessState } from '../../web/js/format.js';

// The claims reason line's pure projection (#159, PR-2): every token of the
// bridge's vocabulary onto its one line, and every input that hides the line
// instead. The projection is DOM-free and owns no staleness machinery of its
// own — the freshness facts arrive exactly as the banner's freshnessState
// computation reads them, which the last block pins from the format.js side.

// The document shape the bridge writes (pi/claims.py `project`): `reachable`
// is endpoint reachability, `winner_*` name the gateway's winning clients,
// `detail` carries the retained evidence. The winners are deliberately in
// every fixture: the line must never read them.
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

// The freshness facts the banner reads from status/current: charger online,
// not charging. `staleAfterMs` is pinned to the charging bound so the bridge
// verdict below is the machinery's own, not a test-only override.
const FRESH = {
  stateLabel: 'available',
  chargerOnline: true,
  staleAfterMs: CHARGING_STALE_AFTER_MS,
};

test('every reason token paints its one line', () => {
  // The seven-token vocabulary (pi/claims.py) and the copy each paints; the
  // winners beside each reason are the ones a live doc would carry, and the
  // assertion is on the line alone.
  const cases = [
    ['manual_override', 'Stopped manually', 'manual', 'muted'],
    ['schedule', 'Paused by schedule', 'timer', 'muted'],
    ['current_limit', 'Limited by current cap', null, 'muted'],
    ['boost', 'Boost charge', 'boost', 'accent'],
    ['safety', 'Held by safety', 'error', 'warn'],
    ['not_connected', 'Vehicle not connected', null, 'muted'],
    ['unknown', 'Reason unavailable', null, 'muted'],
  ];
  for (const [token, line, winnerState, tone] of cases) {
    const state = claimsState({
      doc: claimsDoc({ reason: token, winner_state: winnerState }),
      ...FRESH,
    });
    assert.deepEqual(state, { reason: token, line, tone }, token);
  }
});

test('the live not_connected document reads as the charger reported it', () => {
  // The live example from the charger this repo runs against: reason
  // not_connected, empty detail, reachable — no winner anywhere.
  const state = claimsState({
    doc: {
      reachable: true,
      source: 'http',
      reason: 'not_connected',
      winner_state: null,
      winner_current: null,
      detail: {},
      checked_at: Math.floor(Date.now() / 1000) - 60,
    },
    ...FRESH,
  });
  assert.deepEqual(state, {
    reason: 'not_connected',
    line: 'Vehicle not connected',
    tone: 'muted',
  });
});

test('a null reason is no restriction: the line hides while charging', () => {
  // `reason: null` is the charger charging or ready with no claim held — the
  // common case, and the reason the line is not a permanent fixture.
  for (const stateLabel of ['charging', 'available', 'sleeping']) {
    assert.equal(
      claimsState({ doc: claimsDoc({ reason: null, winner_state: null }), ...FRESH, stateLabel }),
      null,
      stateLabel,
    );
  }
});

test('an absent document hides the line', () => {
  // The bridge writes only on change; before it ever has, there is no
  // confident answer. A non-object document is the same absence.
  assert.equal(claimsState({ doc: null, ...FRESH }), null);
  assert.equal(claimsState({ doc: undefined, ...FRESH }), null);
  assert.equal(claimsState({ ...FRESH }), null);
  assert.equal(claimsState({ doc: 'manual_override', ...FRESH }), null);
});

test('an unsupported gateway hides the line — it was never asked', () => {
  // Firmware < 4.1.5 answers GET /claims/target with 404 and the bridge
  // records `source: "unsupported"` once. That is not the charger refusing to
  // charge; showing any line (even "Reason unavailable") would claim it was.
  assert.equal(claimsState({ doc: claimsDoc({ source: 'unsupported' }), ...FRESH }), null);
});

test('a charger-stale verdict hides the line, whatever the document says', () => {
  // The banner's own verdict: `chargerOnline === false` is freshnessState's
  // charger branch, and under it the document's last arbitration cannot vouch
  // for the present. Even the most confident reason hides.
  const cases = [
    claimsDoc(),
    claimsDoc({ reason: null, winner_state: null }),
    claimsDoc({ source: 'unsupported' }),
  ];
  for (const doc of cases) {
    assert.equal(
      claimsState({ doc, stateLabel: 'charging', chargerOnline: false }),
      null,
      doc.reason,
    );
  }
  // The hide is the machinery's charger verdict exactly: no other verdict of
  // the same computation hides the line (the bridge verdict is the banner's
  // business alone), and an unknown charger fact is not a verdict.
  for (const chargerOnline of [true, undefined]) {
    for (const stateLabel of ['charging', 'available', undefined]) {
      const verdict = freshnessState({
        chargerOnline,
        stateLabel,
        ageMs: Number.POSITIVE_INFINITY,
      });
      const state = claimsState({ doc: claimsDoc(), stateLabel, chargerOnline });
      assert.equal(state === null, verdict === 'charger', `${chargerOnline} ${stateLabel}`);
    }
  }
});

test('a failed fetch never names a reason, and its stale winners never speak', () => {
  // The failure transition merges `reachable: false` beside `reason:
  // "unknown"`, and the merge leaves the previous winners in the document —
  // the #186 review's watchout. The line reads reason/reachable only.
  const state = claimsState({
    doc: claimsDoc({ reachable: false, reason: 'unknown', winner_state: 'manual' }),
    ...FRESH,
  });
  assert.deepEqual(state, { reason: 'unknown', line: 'Reason unavailable', tone: 'muted' });

  // Defensive against a document that somehow kept a confident reason under a
  // failed fetch: the fetch fact wins, fail closed.
  assert.deepEqual(
    claimsState({ doc: claimsDoc({ reachable: false, reason: 'manual_override' }), ...FRESH }).line,
    'Reason unavailable',
  );
});

test('a token outside the vocabulary is a reason this line cannot name', () => {
  // A newer bridge may add tokens; an old web must not hide the restriction
  // the charger did report — unknown, the same fail-closed mapping
  // pi/claims.py gives an unmapped winner id.
  for (const token of ['divert', 'ocpp', 'solar_divert', '', 5, true]) {
    const state = claimsState({ doc: claimsDoc({ reason: token }), ...FRESH });
    assert.deepEqual(
      state,
      { reason: 'unknown', line: 'Reason unavailable', tone: 'muted' },
      String(token),
    );
  }
});
