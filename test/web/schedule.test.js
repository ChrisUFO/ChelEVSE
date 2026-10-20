import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_NAMES,
  DISCARD_CHECKING_REASON,
  DISCARD_COMMITTED_REASON,
  DISCARD_FAILED_REASON,
  DISCARD_OFFLINE_REASON,
  DISCARD_RETRY_DELAYS_MS,
  MAX_AMPS,
  MAX_RULES,
  MIN_AMPS,
  defaultRule,
  defaultSchedule,
  discardBaselineReadApplies,
  discardBaselineStart,
  discardRetry,
  discardTarget,
  normalizeSchedule,
  queuedSaveState,
  reconcileAfterSave,
  reconcileDirtyRemote,
  reloadDiscardBaseline,
  reloadQueuedState,
  routeScheduleSnapshot,
  scheduleKey,
  scheduleSaveValid,
  toggleNote,
  validateSchedule,
} from '../../web/js/schedule.js';

const rule = (overrides = {}) => ({
  id: 'rule-1',
  days: [0, 2],
  start: '22:00',
  end: '06:00',
  amps: 32,
  ...overrides,
});

const schedule = (overrides = {}) => ({
  enabled: true,
  rules: [rule()],
  ...overrides,
});

test('defaults are an empty disabled schedule and a weekday window', () => {
  assert.deepEqual(defaultSchedule(), { enabled: false, rules: [] });
  assert.deepEqual(defaultRule('abc'), {
    id: 'abc',
    days: [0, 1, 2, 3, 4],
    start: '22:00',
    end: '06:00',
    amps: 32,
  });
  assert.deepEqual(DAY_NAMES, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(MIN_AMPS, 6);
  assert.equal(MAX_AMPS, 48);
  assert.equal(MAX_RULES, 20);
});

test('validateSchedule accepts the documented shape and empty rules', () => {
  assert.equal(validateSchedule(schedule()).valid, true);
  assert.equal(validateSchedule({ enabled: false, rules: [] }).valid, true);
  assert.equal(validateSchedule(schedule({ enabled: false })).valid, true);
});

test('validateSchedule enforces the 20-rule container limit', () => {
  const atLimit = {
    enabled: true,
    rules: Array.from({ length: 20 }, (_, i) => rule({ id: `r${i}` })),
  };
  assert.equal(validateSchedule(atLimit).valid, true);
  const over = {
    enabled: true,
    rules: Array.from({ length: 21 }, (_, i) => rule({ id: `r${i}` })),
  };
  const result = validateSchedule(over);
  assert.equal(result.valid, false);
  assert.match(result.errors.rules, /at most 20/);
});

test('validateSchedule rejects malformed days', () => {
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: [] })] })).ruleErrors[0].days,
    /at least one/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: null })] })).ruleErrors[0].days,
    /at least one/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: [0, 0] })] })).ruleErrors[0].days,
    /once/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: [7] })] })).ruleErrors[0].days,
    /0 to 6/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: [1.5] })] })).ruleErrors[0].days,
    /0 to 6/,
  );
  assert.match(
    validateSchedule(schedule({ rules: [rule({ days: ['1'] })] })).ruleErrors[0].days,
    /0 to 6/,
  );
});

test('validateSchedule rejects non-HH:MM times and equal ends', () => {
  for (const start of ['', '7:00', '24:00', '12:60', '22:00\n', '٢٢:٠٠', '2200', null]) {
    const result = validateSchedule(schedule({ rules: [rule({ start })] }));
    assert.equal(result.valid, false, String(start));
    assert.ok(result.ruleErrors[0].start, String(start));
  }
  const equal = validateSchedule(schedule({ rules: [rule({ start: '22:00', end: '22:00' })] }));
  assert.equal(equal.valid, false);
  assert.match(equal.ruleErrors[0].start, /different/);
  assert.match(equal.ruleErrors[0].end, /different/);
});

test('validateSchedule enforces integer amps from 6 to 48', () => {
  for (const amps of [6, 32, 48]) {
    assert.equal(validateSchedule(schedule({ rules: [rule({ amps })] })).valid, true, String(amps));
  }
  for (const amps of [5, 49, 32.5, '32', null, Number.NaN]) {
    const result = validateSchedule(schedule({ rules: [rule({ amps })] }));
    assert.equal(result.valid, false, String(amps));
    assert.match(result.ruleErrors[0].amps, /whole number from 6 to 48/);
  }
});

test('validateSchedule rejects empty ids, non-boolean enabled, and non-list rules', () => {
  assert.match(validateSchedule(schedule({ rules: [rule({ id: '' })] })).ruleErrors[0].id, /id/);
  assert.match(validateSchedule(schedule({ rules: [rule({ id: 5 })] })).ruleErrors[0].id, /id/);
  assert.match(validateSchedule(schedule({ enabled: 'yes' })).errors.enabled, /true or false/);
  const badRules = validateSchedule({ enabled: false, rules: 'nope' });
  assert.equal(badRules.valid, false);
  assert.match(badRules.errors.rules, /list/);
  assert.equal(validateSchedule(null).valid, false);
});

test('normalizeSchedule keeps malformed server values visible for validation', () => {
  assert.deepEqual(normalizeSchedule(null), { enabled: false, rules: [] });
  // The bridge requires a boolean `enabled` and a list `rules`; anything else
  // is a malformed document it leaves untouched, so flag it instead of
  // presenting a silently repaired, saveable schedule.
  assert.deepEqual(normalizeSchedule({ enabled: 'true', rules: [] }), {
    enabled: false,
    rules: [],
    malformed: true,
  });
  // The bridge drops a whole rule for these values; repairing them here would
  // let a later save silently activate a window the charger is ignoring.
  const normalized = normalizeSchedule({
    enabled: true,
    rules: [
      {
        id: 'r',
        days: [2, 0, 2, 7, 1.5],
        start: '22:00',
        end: '06:00',
        amps: '32',
      },
    ],
  });
  assert.deepEqual(normalized, {
    enabled: true,
    rules: [{ id: 'r', days: [2, 0, 2, 7, 1.5], start: '22:00', end: '06:00', amps: '32' }],
  });
  const result = validateSchedule(normalized);
  assert.equal(result.valid, false);
  assert.match(result.ruleErrors[0].days, /0 to 6/);
  assert.match(result.ruleErrors[0].amps, /whole number/);
  // Non-object rules keep the editable shape without inventing values.
  assert.deepEqual(normalizeSchedule({ enabled: true, rules: [null, 5] }).rules, [
    { id: '', days: [], start: '', end: '', amps: 0 },
    { id: '', days: [], start: '', end: '', amps: 0 },
  ]);
});

test('normalizeSchedule flags malformed containers instead of repairing them', () => {
  for (const data of [
    { enabled: true, rules: {} },
    { enabled: true, rules: 'nope' },
    { enabled: false },
    { enabled: 'yes', rules: [] },
    { rules: [] },
  ]) {
    const normalized = normalizeSchedule(data);
    assert.equal(normalized.malformed, true, JSON.stringify(data));
    assert.deepEqual(normalized.rules, []);
    // Validation and save eligibility surface the unsupported shape.
    const result = validateSchedule(normalized);
    assert.equal(result.valid, false);
    assert.match(result.errors.rules, /unsupported shape/);
    assert.equal(scheduleSaveValid(normalized, result), false);
  }
  // The flag survives a re-normalization (clone) so the screen keeps showing it.
  const flagged = normalizeSchedule({ enabled: true, rules: {} });
  assert.equal(normalizeSchedule(flagged).malformed, true);
  // A well-formed document carries no flag.
  assert.deepEqual(normalizeSchedule(schedule()), schedule());
});

test('scheduleSaveValid lets a disable through invalid rules but not container errors', () => {
  assert.equal(scheduleSaveValid(schedule()), true);
  const invalidDisabled = schedule({ enabled: false, rules: [rule({ days: [] })] });
  assert.equal(validateSchedule(invalidDisabled).valid, false);
  assert.equal(scheduleSaveValid(invalidDisabled), true);
  // Enabled schedules still need every rule to pass.
  assert.equal(scheduleSaveValid(schedule({ rules: [rule({ days: [] })] })), false);
  assert.equal(scheduleSaveValid(schedule({ rules: [rule({ amps: 10.5 })] })), false);
  // Container errors block every save, including a disable.
  const tooMany = {
    enabled: false,
    rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => rule({ id: `r${i}` })),
  };
  assert.equal(scheduleSaveValid(tooMany), false);
  assert.equal(scheduleSaveValid({ enabled: false, rules: 'nope' }), false);
});

const payload = schedule({ rules: [rule({ amps: 40 })] });

test('reconcileAfterSave succeeds on the echo, a remote snapshot, or the payload', () => {
  const echo = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: payload,
    ok: true,
  });
  assert.equal(scheduleKey(echo.baseline), scheduleKey(payload));

  const remote = schedule({ enabled: false, rules: [] });
  const newer = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: remote,
    ok: true,
  });
  assert.equal(scheduleKey(newer.baseline), scheduleKey(remote));

  const alone = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: null,
    ok: true,
  });
  assert.equal(scheduleKey(alone.baseline), scheduleKey(payload));
});

test('reconcileAfterSave rolls a failed save back past the local echo', () => {
  // The SDK delivers the latency-compensated echo before it rejects the write,
  // so a queued snapshot equal to the payload is not remote truth.
  const result = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: payload,
    ok: false,
  });
  assert.equal(scheduleKey(result.baseline), scheduleKey(schedule()));
  assert.equal(result.remote, false);
  assert.match(result.error, /previous schedule was restored/);
});

test('reconcileAfterSave rolls back to a genuine external snapshot', () => {
  const remote = schedule({ enabled: false, rules: [] });
  const result = reconcileAfterSave({
    confirmed: schedule(),
    payload,
    pendingRemote: remote,
    ok: false,
  });
  assert.equal(scheduleKey(result.baseline), scheduleKey(remote));
  assert.equal(result.remote, true);
  assert.match(result.error, /latest server schedule was restored/);
});

test('reconcileAfterSave keeps the confirmed baseline when nothing was pending', () => {
  const baseline = schedule();
  const result = reconcileAfterSave({
    confirmed: baseline,
    payload,
    pendingRemote: null,
    ok: false,
  });
  assert.equal(scheduleKey(result.baseline), scheduleKey(baseline));
  assert.equal(result.remote, false);
});

test('queuedSaveState labels an offline save as queued and keeps editing open', () => {
  const state = queuedSaveState({ online: false, queued: true });
  assert.equal(state.label, 'Queued — will save when online.');
  assert.equal(state.kind, 'warn');
  assert.equal(state.busy, false);
  // Nothing newer than the queued payload, so a second save is not offered; the
  // discard is, because it queues the compensating revert.
  assert.equal(state.canSave, false);
  assert.equal(state.canDiscard, true);
});

test('queuedSaveState keeps newer edits distinct from the queued payload', () => {
  const state = queuedSaveState({ online: false, queued: true, dirty: true });
  assert.match(state.label, /^Queued — will save when online\./);
  assert.match(state.label, /newer edits are not saved/i);
  assert.equal(state.canSave, true);
  assert.equal(state.canDiscard, true);
});

test('queuedSaveState reports a reconnect settle without claiming newer edits', () => {
  const saved = queuedSaveState({ online: true, saved: true });
  assert.equal(saved.label, 'Saved.');
  assert.equal(saved.kind, 'ok');
  assert.equal(saved.canSave, false);
  assert.equal(saved.canDiscard, false);

  const stale = queuedSaveState({ online: true, saved: true, dirty: true });
  assert.equal(stale.label, 'Previous change saved — save your latest edits.');
  assert.equal(stale.kind, 'warn');
  assert.equal(stale.canSave, true);
});

test('queuedSaveState surfaces a failed settle as an error with a retry', () => {
  const error = "Couldn't save — your changes are still here. Try saving again.";
  const state = queuedSaveState({ online: true, dirty: true, error });
  assert.deepEqual(state, {
    label: error,
    kind: 'err',
    busy: false,
    canSave: true,
    canDiscard: true,
  });
  // A rollback that also cleared the draft leaves nothing to retry or discard.
  const rolledBack = queuedSaveState({
    online: true,
    error: "Couldn't save. The previous schedule was restored.",
  });
  assert.equal(rolledBack.kind, 'err');
  assert.equal(rolledBack.canSave, false);
  assert.equal(rolledBack.canDiscard, false);
});

test('queuedSaveState leaves the online save path unchanged', () => {
  const savingState = queuedSaveState({ online: true, saving: true });
  assert.equal(savingState.label, 'Saving…');
  assert.equal(savingState.busy, true);
  assert.equal(savingState.canSave, false);
  assert.equal(savingState.canDiscard, false);

  assert.deepEqual(queuedSaveState({ online: true }), {
    label: '',
    kind: '',
    busy: false,
    canSave: false,
    canDiscard: false,
  });
  assert.equal(queuedSaveState({ online: true, dirty: true }).label, 'Unsaved changes.');
  // The connection dropped mid-write: the editor is released with the same
  // unconfirmed copy, whether or not navigator has caught up.
  const unconfirmed = 'Save unconfirmed — connection lost. You can keep editing.';
  assert.equal(queuedSaveState({ saving: true, online: false }).label, unconfirmed);
  assert.equal(queuedSaveState({ unconfirmed: true }).label, unconfirmed);
});

test('scheduleKey ignores day order but notices any real change', () => {
  const a = schedule();
  const b = schedule({ rules: [rule({ days: [2, 0] })] });
  assert.equal(scheduleKey(a), scheduleKey(b));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ enabled: false })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ start: '23:00' })] })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ amps: 16 })] })));
  assert.notEqual(scheduleKey(a), scheduleKey(schedule({ rules: [rule({ id: 'other' })] })));
  // Clearing a malformed-container flag is a real change: it is the user
  // explicitly replacing the stored shape.
  assert.notEqual(scheduleKey(schedule()), scheduleKey({ ...schedule(), malformed: true }));
});

test('reconcileDirtyRemote tracks server truth without touching the draft', () => {
  const draft = schedule({ rules: [rule({ amps: 40 })] });
  const remote = schedule({ rules: [rule({ amps: 24 })] });
  const result = reconcileDirtyRemote({ confirmed: schedule(), draft, incoming: remote });
  assert.equal(scheduleKey(result.confirmed), scheduleKey(remote));
  assert.equal(result.dirty, true);
  assert.equal(result.remoteNotice, true);
  // The draft object itself is untouched (the editor owns it).
  assert.equal(draft.rules[0].amps, 40);

  // The server is still on the snapshot the draft was based on: no notice.
  const same = reconcileDirtyRemote({ confirmed: schedule(), draft, incoming: schedule() });
  assert.equal(same.dirty, true);
  assert.equal(same.remoteNotice, false);

  // The remote change matches the draft exactly: nothing is unsaved anymore.
  const matches = reconcileDirtyRemote({ confirmed: schedule(), draft, incoming: draft });
  assert.equal(matches.dirty, false);
  assert.equal(matches.remoteNotice, false);
});

test('reconcileDirtyRemote marks a metadata-only repeat so notices stay sticky', () => {
  const draft = schedule({ rules: [rule({ amps: 40 })] });
  const remote = schedule({ rules: [rule({ amps: 24 })] });
  const changed = reconcileDirtyRemote({ confirmed: schedule(), draft, incoming: remote });
  assert.equal(changed.metadataOnly, false);
  assert.equal(changed.remoteNotice, true);

  // With metadata changes enabled an ack or a fromCache flip repeats the data:
  // it must not look like a new remote change (that would erase the notice
  // explaining the last real one).
  const repeat = reconcileDirtyRemote({ confirmed: remote, draft, incoming: remote });
  assert.equal(repeat.metadataOnly, true);
  assert.equal(repeat.remoteNotice, false);
  assert.equal(repeat.dirty, true);
});

test('reloadQueuedState labels a pending snapshot with no local save in flight', () => {
  const key = scheduleKey(payload);
  const result = reloadQueuedState({ pendingWrites: true, dataKey: key, draftKey: key });
  assert.deepEqual(result, { queued: true, payloadKey: key, outcome: 'queued', adopt: false });

  // Still queued on the same payload: the label is already correct.
  const same = reloadQueuedState({
    pendingWrites: true,
    queued: true,
    dataKey: key,
    payloadKey: key,
  });
  assert.deepEqual(same, { queued: true, payloadKey: key, outcome: 'none', adopt: false });

  // A different pending payload (a newer queued write) becomes the baseline.
  const newerKey = scheduleKey(schedule({ rules: [rule({ amps: 24 })] }));
  const newer = reloadQueuedState({
    pendingWrites: true,
    queued: true,
    dataKey: newerKey,
    payloadKey: key,
  });
  assert.equal(newer.outcome, 'queued');
  assert.equal(newer.queued, true);
  assert.equal(newer.payloadKey, newerKey);
});

test('reloadQueuedState ignores a pending snapshot while a local save is in flight', () => {
  const key = scheduleKey(payload);
  const saving = reloadQueuedState({
    pendingWrites: true,
    saving: true,
    dataKey: key,
    payloadKey: key,
  });
  assert.deepEqual(saving, { queued: false, payloadKey: key, outcome: 'none', adopt: false });
  // The unconfirmed (late settle) window is the same: the promise is the arbiter.
  const unconfirmed = reloadQueuedState({
    pendingWrites: true,
    savingUnconfirmed: true,
    queued: true,
    dataKey: key,
    payloadKey: key,
  });
  assert.deepEqual(unconfirmed, {
    queued: true,
    payloadKey: key,
    outcome: 'none',
    adopt: false,
  });
});

test('reloadQueuedState clears the queued state when the payload is acknowledged', () => {
  const key = scheduleKey(payload);
  const acked = reloadQueuedState({
    pendingWrites: false,
    queued: true,
    dataKey: key,
    payloadKey: key,
    draftKey: key,
  });
  // The draft is untouched; the screen shows "Saved." from queuedSaveState.
  assert.deepEqual(acked, { queued: false, payloadKey: null, outcome: 'acked', adopt: false });
  assert.equal(queuedSaveState({ saved: true }).label, 'Saved.');

  // A repeated metadata-only ack (the same data, metadata already false) has
  // nothing left to resolve: the label must not be re-fired.
  const repeat = reloadQueuedState({
    pendingWrites: false,
    queued: acked.queued,
    dataKey: key,
    payloadKey: acked.payloadKey,
    draftKey: key,
  });
  assert.deepEqual(repeat, { queued: false, payloadKey: null, outcome: 'none', adopt: false });
});

test('reloadDiscardBaseline enables Discard only with a trustworthy server copy', () => {
  const server = schedule({ rules: [rule({ amps: 24 })] });
  const payloadKey = scheduleKey(payload);

  const ready = reloadDiscardBaseline({ baseline: server, baselineKey: payloadKey, payloadKey });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.reason, '');
  assert.equal(scheduleKey(ready.baseline), scheduleKey(server));

  // The server already holds the queued payload: writing it again would repeat
  // the change, so there is nothing to discard.
  const committed = reloadDiscardBaseline({
    baseline: payload,
    baselineKey: payloadKey,
    payloadKey,
  });
  assert.equal(committed.status, 'committed');
  assert.equal(committed.baseline, null);
  assert.equal(committed.reason, DISCARD_COMMITTED_REASON);
  assert.match(committed.reason, /already saved/);

  // The server read is in flight: disabled, but with progress copy.
  const checking = reloadDiscardBaseline({
    baseline: server,
    baselineKey: payloadKey,
    payloadKey,
    pending: true,
  });
  assert.equal(checking.status, 'checking');
  assert.equal(checking.baseline, null);
  assert.equal(checking.reason, DISCARD_CHECKING_REASON);

  // Offline or a failed read: no baseline can be trusted, and the copy names
  // which one it is — a connection problem versus a read that failed anyway.
  const offline = reloadDiscardBaseline({ baseline: server, payloadKey, online: false });
  assert.equal(offline.status, 'unavailable');
  assert.equal(offline.baseline, null);
  assert.equal(offline.reason, DISCARD_OFFLINE_REASON);
  assert.match(offline.reason, /connection/);

  const failed = reloadDiscardBaseline({ baseline: null, payloadKey, failed: true });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.reason, DISCARD_FAILED_REASON);
  assert.match(failed.reason, /Couldn't check the saved schedule/);
  // A failed read on a healthy connection must not blame the connection.
  assert.doesNotMatch(failed.reason, /connection|online/i);

  // Online, no read yet, no data: still unavailable (never a silent enable),
  // and it reads as a failed check rather than an offline one.
  const absent = reloadDiscardBaseline({ payloadKey });
  assert.equal(absent.status, 'unavailable');
  assert.equal(absent.reason, DISCARD_FAILED_REASON);

  // A missing payload key cannot prove the server is committed, so a fetched
  // baseline is used.
  const unknownPayload = reloadDiscardBaseline({ baseline: server });
  assert.equal(unknownPayload.status, 'ready');
  assert.equal(scheduleKey(unknownPayload.baseline), scheduleKey(server));
});

test('reloadQueuedState reports a changed acknowledged snapshot as reverted', () => {
  const key = scheduleKey(payload);
  const remote = schedule({ rules: [rule({ amps: 24 })] });
  const remoteKey = scheduleKey(remote);
  // Clean draft (still the queued payload): the screen may adopt server truth.
  const clean = reloadQueuedState({
    pendingWrites: false,
    queued: true,
    dataKey: remoteKey,
    payloadKey: key,
    draftKey: key,
  });
  assert.deepEqual(clean, {
    queued: false,
    payloadKey: null,
    outcome: 'reverted',
    adopt: true,
  });
  // Dirty draft: the notice shows, but the edits are never clobbered.
  const dirty = reloadQueuedState({
    pendingWrites: false,
    queued: true,
    dataKey: remoteKey,
    payloadKey: key,
    draftKey: scheduleKey(schedule({ rules: [rule({ amps: 16 })] })),
  });
  assert.equal(dirty.outcome, 'reverted');
  assert.equal(dirty.adopt, false);
  // An unknown draft is never adopted (the conservative default).
  assert.equal(
    reloadQueuedState({ pendingWrites: false, queued: true, dataKey: remoteKey, payloadKey: key })
      .adopt,
    false,
  );
});

test('reloadQueuedState leaves the state alone when snapshot metadata is absent', () => {
  const key = scheduleKey(payload);
  assert.deepEqual(reloadQueuedState({ dataKey: key, draftKey: key }), {
    queued: false,
    payloadKey: null,
    outcome: 'none',
    adopt: false,
  });
  // Absent metadata is not evidence of acknowledgement: a queued write stays
  // queued (only an explicit `false` resolves it).
  const queuedState = { queued: true, payloadKey: key, outcome: 'none', adopt: false };
  assert.deepEqual(
    reloadQueuedState({ queued: true, dataKey: key, payloadKey: key, draftKey: key }),
    queuedState,
  );
  assert.deepEqual(
    reloadQueuedState({ pendingWrites: null, queued: true, dataKey: key, payloadKey: key }),
    queuedState,
  );
  // An acknowledged snapshot while nothing is queued changes nothing.
  assert.equal(reloadQueuedState({ pendingWrites: false, dataKey: key }).outcome, 'none');
});

test('routeScheduleSnapshot keeps an in-session write ahead of the queued branches', () => {
  const key = scheduleKey(payload);
  const remote = schedule({ rules: [rule({ amps: 24 })] });
  // A metadata repeat while the write is in flight changes no notice: the
  // snapshot belongs to the promise, even when it carries pending metadata.
  assert.deepEqual(
    routeScheduleSnapshot({
      initialized: true,
      saving: true,
      queued: true,
      queuedFromSnapshot: true,
      pendingWrites: false,
      confirmed: payload,
      draft: payload,
      incoming: payload,
      payloadKey: key,
    }),
    { kind: 'in-flight', remoteChange: null },
  );
  // A different payload is a remote change…
  assert.equal(
    routeScheduleSnapshot({
      initialized: true,
      savingUnconfirmed: true,
      confirmed: payload,
      draft: payload,
      incoming: remote,
      payloadKey: key,
    }).remoteChange,
    true,
  );
  // …unless it is the echoed payload being saved (the confirmed copy is older).
  assert.equal(
    routeScheduleSnapshot({
      initialized: true,
      saving: true,
      confirmed: remote,
      draft: payload,
      incoming: payload,
      payloadKey: key,
    }).remoteChange,
    false,
  );
});

test('routeScheduleSnapshot leaves a metadata repeat of a reload-queued write inert', () => {
  const key = scheduleKey(payload);
  const still = {
    initialized: true,
    queued: true,
    queuedFromSnapshot: true,
    confirmed: payload,
    draft: payload,
    payloadKey: key,
  };
  // Same payload, still pending: the queued label is already correct.
  assert.equal(
    routeScheduleSnapshot({ ...still, incoming: payload, pendingWrites: true }).kind,
    'queued-still',
  );
  // Absent metadata is not an acknowledgement either.
  assert.equal(routeScheduleSnapshot({ ...still, incoming: payload }).kind, 'queued-still');
  // The ack repeats the data and flips only hasPendingWrites.
  const acked = routeScheduleSnapshot({ ...still, incoming: payload, pendingWrites: false });
  assert.equal(acked.kind, 'transition');
  assert.equal(acked.transition.outcome, 'acked');
  // A newer pending payload re-baselines instead of being ignored.
  const newer = schedule({ rules: [rule({ amps: 24 })] });
  const next = routeScheduleSnapshot({ ...still, incoming: newer, pendingWrites: true });
  assert.equal(next.kind, 'transition');
  assert.equal(next.transition.outcome, 'queued');
  assert.equal(next.transition.payloadKey, scheduleKey(newer));
});

test('routeScheduleSnapshot resolves a queued write before the dirty-draft branch', () => {
  const key = scheduleKey(payload);
  const remote = schedule({ rules: [rule({ amps: 24 })] });
  const dirtyDraft = schedule({ rules: [rule({ amps: 16 })] });
  const base = {
    initialized: true,
    queued: true,
    queuedFromSnapshot: true,
    confirmed: payload,
    payloadKey: key,
    pendingWrites: false,
  };
  // A reverted write with a clean draft may adopt server truth.
  const clean = routeScheduleSnapshot({ ...base, draft: payload, incoming: remote });
  assert.equal(clean.kind, 'transition');
  assert.equal(clean.transition.outcome, 'reverted');
  assert.equal(clean.transition.adopt, true);
  // A dirty draft is routed to the reverted transition too, never to the
  // dirty-branch reconcile that would erase the notice.
  const dirty = routeScheduleSnapshot({
    ...base,
    dirty: true,
    draft: dirtyDraft,
    incoming: remote,
  });
  assert.equal(dirty.kind, 'transition');
  assert.equal(dirty.transition.adopt, false);
});

test('routeScheduleSnapshot keeps the notice on a metadata-only repeat while dirty', () => {
  const remote = schedule({ rules: [rule({ amps: 24 })] });
  const changed = schedule({ rules: [rule({ amps: 20 })] });
  const draft = schedule({ rules: [rule({ amps: 16 })] });
  const repeat = routeScheduleSnapshot({
    initialized: true,
    dirty: true,
    confirmed: remote,
    draft,
    incoming: remote,
  });
  assert.equal(repeat.kind, 'dirty');
  assert.equal(repeat.reconcile.metadataOnly, true);
  assert.equal(repeat.reconcile.remoteNotice, false);
  assert.equal(repeat.reconcile.dirty, true);

  const real = routeScheduleSnapshot({
    initialized: true,
    dirty: true,
    confirmed: remote,
    draft,
    incoming: changed,
  });
  assert.equal(real.reconcile.metadataOnly, false);
  assert.equal(real.reconcile.remoteNotice, true);
  assert.equal(scheduleKey(real.reconcile.confirmed), scheduleKey(changed));

  // A remote copy that matches the draft leaves nothing unsaved.
  const caughtUp = routeScheduleSnapshot({
    initialized: true,
    dirty: true,
    confirmed: remote,
    draft,
    incoming: draft,
  });
  assert.equal(caughtUp.reconcile.dirty, false);
  assert.equal(caughtUp.reconcile.remoteNotice, false);
});

test('routeScheduleSnapshot keeps "Saved." on a data-identical clean repeat', () => {
  assert.deepEqual(
    routeScheduleSnapshot({
      initialized: true,
      confirmed: payload,
      draft: payload,
      incoming: payload,
    }),
    { kind: 'repeat' },
  );
  const adopt = routeScheduleSnapshot({
    initialized: true,
    confirmed: payload,
    draft: payload,
    incoming: schedule({ rules: [rule({ amps: 24 })] }),
  });
  assert.equal(adopt.kind, 'adopt');
  // First snapshot: the screen adopts it and only applies the queue transition.
  const initial = routeScheduleSnapshot({
    incoming: payload,
    draft: payload,
    pendingWrites: true,
  });
  assert.equal(initial.kind, 'initial');
  assert.equal(initial.transition.outcome, 'queued');
  assert.equal(initial.transition.payloadKey, scheduleKey(payload));
});

test('discardTarget writes only a baseline the state can justify', () => {
  const server = schedule({ rules: [rule({ amps: 24 })] });
  const key = scheduleKey(payload);
  const ready = reloadDiscardBaseline({ baseline: server, baselineKey: key, payloadKey: key });
  assert.equal(
    scheduleKey(discardTarget({ queuedFromSnapshot: true, decision: ready, confirmed: payload })),
    scheduleKey(server),
  );
  // Not-ready statuses carry no compensating payload at all.
  assert.equal(
    discardTarget({
      queuedFromSnapshot: true,
      decision: reloadDiscardBaseline({ payloadKey: key, online: false }),
      confirmed: payload,
    }),
    null,
  );
  assert.equal(
    discardTarget({
      queuedFromSnapshot: true,
      decision: reloadDiscardBaseline({ baseline: payload, baselineKey: key, payloadKey: key }),
      confirmed: payload,
    }),
    null,
  );
  assert.equal(
    discardTarget({
      queuedFromSnapshot: true,
      decision: reloadDiscardBaseline({
        baseline: server,
        baselineKey: key,
        payloadKey: key,
        pending: true,
      }),
      confirmed: payload,
    }),
    null,
  );
  // An in-session write still discards against the confirmed snapshot.
  assert.equal(discardTarget({ confirmed: payload }), payload);
});

test('discardRetry retries only a failed online read, within a bounded budget', () => {
  assert.equal(DISCARD_RETRY_DELAYS_MS.length, 3);
  assert.equal(discardRetry({ status: 'failed', online: true, attempts: 0 }), 5000);
  assert.equal(discardRetry({ status: 'failed', online: true, attempts: 2 }), 30000);
  assert.equal(
    discardRetry({ status: 'failed', online: true, attempts: DISCARD_RETRY_DELAYS_MS.length }),
    null,
  );
  // Offline failures wait for the reconnect event instead of a timer.
  assert.equal(discardRetry({ status: 'failed', online: false, attempts: 0 }), null);
  // Only a failure is retried: a pending, ready, or idle read is not.
  assert.equal(discardRetry({ status: 'loading', online: true, attempts: 0 }), null);
  assert.equal(discardRetry({ status: 'ready', online: true, attempts: 0 }), null);
  assert.equal(discardRetry({ online: true }), null);
  // The delays back off between attempts.
  assert.deepEqual(
    DISCARD_RETRY_DELAYS_MS,
    [...DISCARD_RETRY_DELAYS_MS].sort((a, b) => a - b),
  );
});

test('a discard baseline is only usable for the payload it was read for', () => {
  const server = schedule({ rules: [rule({ amps: 24 })] });
  const keyP1 = scheduleKey(payload);
  const keyP2 = scheduleKey(schedule({ rules: [rule({ amps: 48 })] }));
  assert.notEqual(keyP1, keyP2);

  const current = reloadDiscardBaseline({
    baseline: server,
    baselineKey: keyP1,
    payloadKey: keyP1,
  });
  assert.equal(current.status, 'ready');
  assert.equal(scheduleKey(current.baseline), scheduleKey(server));

  // A copy read for an earlier queued payload says nothing about the current
  // one: Discard waits for a fresh read instead of writing the stale copy.
  const superseded = reloadDiscardBaseline({
    baseline: server,
    baselineKey: keyP1,
    payloadKey: keyP2,
  });
  assert.equal(superseded.status, 'checking');
  assert.equal(superseded.baseline, null);
  assert.equal(superseded.reason, DISCARD_CHECKING_REASON);
  assert.equal(
    discardTarget({ queuedFromSnapshot: true, decision: superseded, confirmed: payload }),
    null,
  );
});

test('a new queued payload invalidates the old baseline and starts a fresh read', () => {
  const keyP1 = scheduleKey(payload);
  const keyP2 = scheduleKey(schedule({ rules: [rule({ amps: 48 })] }));

  // A ready copy for the previous payload: dropped, and a new read started.
  assert.deepEqual(
    discardBaselineStart({ status: 'ready', baselineKey: keyP1, payloadKey: keyP2, fresh: true }),
    { reusable: false, invalidate: true, resetRetries: true, start: true },
  );
  // A read still in flight for the previous payload is abandoned the same way,
  // and the fresh trigger still resets the retry budget.
  assert.deepEqual(
    discardBaselineStart({ status: 'loading', baselineKey: keyP1, payloadKey: keyP2, fresh: true }),
    { reusable: false, invalidate: true, resetRetries: true, start: true },
  );
  // A same-payload read in flight is reused, but a fresh trigger still restarts
  // the bounded retry budget before the early return.
  assert.deepEqual(
    discardBaselineStart({ status: 'loading', baselineKey: keyP2, payloadKey: keyP2, fresh: true }),
    { reusable: true, invalidate: false, resetRetries: true, start: false },
  );
  // Ready for the current payload: reusable, no second read.
  assert.deepEqual(
    discardBaselineStart({ status: 'ready', baselineKey: keyP2, payloadKey: keyP2 }),
    { reusable: true, invalidate: false, resetRetries: false, start: false },
  );
  // A failed read for the current payload is retried, not invalidated.
  assert.deepEqual(
    discardBaselineStart({ status: 'failed', baselineKey: keyP2, payloadKey: keyP2 }),
    { reusable: false, invalidate: false, resetRetries: false, start: true },
  );
  // Offline: the stale copy is dropped and nothing is read until `online`.
  assert.deepEqual(
    discardBaselineStart({
      status: 'ready',
      baselineKey: keyP1,
      payloadKey: keyP2,
      fresh: true,
      online: false,
    }),
    { reusable: false, invalidate: true, resetRetries: true, start: false },
  );
  // No queued payload means there is no key to fetch a baseline for.
  assert.equal(discardBaselineStart({ status: 'idle', online: true }).start, false);
});

test('a baseline read for a superseded payload cannot land', () => {
  const keyP1 = scheduleKey(payload);
  const keyP2 = scheduleKey(schedule({ rules: [rule({ amps: 48 })] }));
  const read = { readGeneration: 3, readToken: 7, readKey: keyP1 };
  const current = { generation: 3, token: 7, payloadKey: keyP1 };

  assert.equal(discardBaselineReadApplies({ ...read, ...current }), true);
  // A new payload bumped the token: the old response is inert.
  assert.equal(discardBaselineReadApplies({ ...read, ...current, token: 8 }), false);
  // So is a response from before a page reset, or one keyed to another payload.
  assert.equal(discardBaselineReadApplies({ ...read, ...current, generation: 4 }), false);
  assert.equal(discardBaselineReadApplies({ ...read, ...current, payloadKey: keyP2 }), false);
  // A read with no payload key never owns a baseline.
  assert.equal(
    discardBaselineReadApplies({ ...read, ...current, readKey: null, payloadKey: null }),
    false,
  );
});

test('toggleNote reports an unknown state for a malformed stored schedule', () => {
  assert.equal(toggleNote(schedule({ enabled: true })), 'Charging follows these windows.');
  assert.equal(
    toggleNote(schedule({ enabled: false })),
    'Charging is not restricted by a schedule.',
  );
  // The bridge skips a malformed container and leaves the charger's firmware
  // schedule alone, so the toggle must not assert "not restricted".
  const malformed = normalizeSchedule({ enabled: 'yes', rules: [] });
  assert.equal(malformed.malformed, true);
  assert.match(toggleNote(malformed), /Unsupported stored schedule/);
  assert.match(toggleNote(malformed), /firmware schedule/);
  assert.doesNotMatch(toggleNote(malformed), /not restricted/);
  // Empty and missing documents are well-formed "off", not unknown.
  assert.equal(toggleNote(defaultSchedule()), 'Charging is not restricted by a schedule.');
});
