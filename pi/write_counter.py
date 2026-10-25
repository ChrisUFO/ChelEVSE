"""The process-local Firestore write counter: the write budget made visible.

Extracted from ``bridge.py`` (behavior-preserving move, issue #96): every
successful Firestore write records its kind here; the counts feed the hourly
journal summary, the ``status/health`` merge fields, and the 50% budget
tripwire.
"""

import threading
import time
from collections import deque


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.log(message)



# --- Write counter (issue #96) ------------------------------------------------
# The write budget is only verifiable if the bridge can see its own writes.
# Observability constants, deliberately not env tunables: counting is not
# policy. Kinds: the five the issue names -- status (status/current), history
# (history/<day>), session (sessions/<id>), config (status/config), command
# (commands/<id>) -- plus health (status/health, its own transition cadence)
# and fcm (token-prune deletes, which Firestore bills as writes), so the
# total matches what the console reports.
WRITE_KINDS = ("status", "history", "session", "config", "command", "health", "fcm")
_WRITE_KINDS = frozenset(WRITE_KINDS)
# The rolling window the budget is judged over, matching the quota's day.
WRITE_WINDOW_SEC = 24 * 3600
# One journal summary per hour; the same interval dedupes the quota-failure
# line (once per interval per process, not per failure).
WRITE_SUMMARY_INTERVAL = 3600.0
# The free tier allows 20,000 writes/day; the tripwire fires at its 50%, the
# loudest early warning that costs nothing to check.
WRITE_BUDGET_WARNING_AT = 10000
def quota_exceeded(exc, depth=8):
    """True when ``exc`` is, or wraps, a Firestore quota failure (429).

    In practice the SDK's retry hides the 429: the failure surfaces as
    ``RetryError: Timeout of 60.0s exceeded, last exception: 429 Quota
    exceeded.`` with the ``ResourceExhausted`` hanging off the wrapper's
    ``cause``. Both forms are recognised -- a 429 status code or a
    quota-shaped message anywhere in a bounded cause chain -- without
    importing the SDK's exception classes, so test doubles with the same
    shape count too. The bound keeps a pathological cause cycle from
    spinning.
    """
    candidate = exc
    seen = 0
    while candidate is not None and seen < depth:
        if getattr(candidate, "code", None) == 429:
            return True
        text = str(candidate)
        if "RESOURCE_EXHAUSTED" in text or "Quota exceeded" in text:
            return True
        candidate = (
            getattr(candidate, "cause", None)
            or getattr(candidate, "exception", None)
            or getattr(candidate, "__cause__", None)
        )
        seen += 1
    return False


class WriteCounter:
    """Process-local count of successful Firestore writes, by kind (issue #96).

    The milestone's premise: the write budget was discovered only when writes
    started failing. Every write site records its kind here the moment a
    write lands (:meth:`record` / the :meth:`counted` one-liner) and reports
    its failures (:meth:`note_failure`); the counts feed the hourly journal
    summary (:meth:`maybe_summary`), the ``writes_24h``/``writes_by_kind``
    fields merged into ``status/health`` (:meth:`health_fields` -- a document
    written only on watchdog/transport transitions, so the counter itself
    costs no writes), and the 50% budget tripwire that would have caught the
    outage before it bit.

    The tripwire fires when a *crossing* takes the rolling count to
    ``warning_at`` and re-arms only once the window rolls the count back
    below it: hysteresis, so a count hovering at the line logs one warning
    per re-crossing, never one per write.

    Thread-safety: the write sites run under different locks -- the sink's
    apply lock, the accumulator's flush points, none at all in the config
    loop -- so the counter keeps its own small lock and never requires a
    caller to hold any particular one. Injectable clock, the
    ``WritePolicy(clock=...)`` precedent; monotonic, because the window is a
    process-local span, not wall time.
    """

    def __init__(
        self,
        clock=time.monotonic,
        window_sec=WRITE_WINDOW_SEC,
        summary_interval=WRITE_SUMMARY_INTERVAL,
        warning_at=WRITE_BUDGET_WARNING_AT,
    ):
        self.clock = clock
        self.window_sec = window_sec
        self.summary_interval = summary_interval
        self.warning_at = warning_at
        # (timestamp, kind) per successful write, oldest first.
        self._events = deque()
        # True while the warning has fired for the current stretch above the
        # threshold.
        self._warned = False
        # When the next journal summary is due; None means one is due now
        # (a startup line proves the counter is alive before any write).
        self._next_summary_at = None
        # Clock time of the last quota-failure line.
        self._quota_logged_at = None
        self._lock = threading.Lock()

    def record(self, kind):
        """Count one successful write of ``kind``; run the tripwire check.

        An unknown kind is a programming error and raises here, at the
        recording site, rather than an hour later in the next summary.
        """
        if kind not in _WRITE_KINDS:
            raise KeyError(kind)
        crossed = False
        total = 0
        with self._lock:
            moment = self.clock()
            self._events.append((moment, kind))
            self._trim(moment)
            if not self._warned and len(self._events) >= self.warning_at:
                self._warned = True
                crossed = True
                total = len(self._events)
        if crossed:
            log(
                f"write budget warning: {total} writes in 24h "
                f"— 50% of the free-tier quota"
            )

    def note_failure(self, exc):
        """Report one failed write; a quota 429 gets its distinct line.

        The call sites keep their own detail logs (retry semantics, what was
        kept pending); this adds the one line that says *quota*, not network
        -- an exhaustion that reads like a timeout traceback is how the
        original outage went unnoticed. Deduped to once per interval per
        process, not per failure. Returns True for a quota failure whether
        or not this call was the one that logged.
        """
        if not quota_exceeded(exc):
            return False
        with self._lock:
            moment = self.clock()
            if (
                self._quota_logged_at is not None
                and moment - self._quota_logged_at < self.summary_interval
            ):
                return True
            self._quota_logged_at = moment
        log(
            "firestore write quota exceeded (RESOURCE_EXHAUSTED) "
            "— writes paused until the daily reset"
        )
        return True

    def counted(self, kind, write, *args, **kwargs):
        """Run one write call; count it on success, inspect it on failure.

        The one-liner for sites without failure handling of their own: the
        exception re-raises untouched, so the caller's existing retry/log
        semantics are unchanged.
        """
        try:
            result = write(*args, **kwargs)
        except Exception as exc:
            self.note_failure(exc)
            raise
        self.record(kind)
        return result

    def snapshot(self):
        """``(total, {kind: count})`` inside the rolling window.

        Also the trim point for a window that aged out while nothing was
        written, so ``writes_24h`` and the summary never report stale counts.
        """
        with self._lock:
            self._trim(self.clock())
            return self._counts()

    def health_fields(self):
        """The ``status/health`` merge fields for the current counts."""
        total, by_kind = self.snapshot()
        return {"writes_24h": total, "writes_by_kind": by_kind}

    def summary(self):
        """The journal line's message: the rolling total and its split."""
        total, by_kind = self.snapshot()
        detail = " ".join(f"{kind}={by_kind[kind]}" for kind in WRITE_KINDS)
        return f"firestore writes: {total} in 24h ({detail})"

    def maybe_summary(self):
        """Log the summary when the interval elapsed; True when a line went out.

        The first call logs at once: a startup ``firestore writes: 0 in 24h``
        line proves the counter works before any write has landed.
        """
        with self._lock:
            moment = self.clock()
            if self._next_summary_at is not None and moment < self._next_summary_at:
                return False
            self._next_summary_at = moment + self.summary_interval
            self._trim(moment)
            total, by_kind = self._counts()
        detail = " ".join(f"{kind}={by_kind[kind]}" for kind in WRITE_KINDS)
        log(f"firestore writes: {total} in 24h ({detail})")
        return True

    def _trim(self, now):
        """Drop writes older than the window; re-arm the tripwire below it."""
        cutoff = now - self.window_sec
        while self._events and self._events[0][0] <= cutoff:
            self._events.popleft()
        if len(self._events) < self.warning_at:
            self._warned = False

    def _counts(self):
        """``(total, by_kind)`` from the events; the caller holds the lock."""
        by_kind = dict.fromkeys(WRITE_KINDS, 0)
        for _at, kind in self._events:
            by_kind[kind] += 1
        return len(self._events), by_kind


