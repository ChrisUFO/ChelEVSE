"""The energy-history day reconciler (issue #161, PR-1).

A read-only cross-check of the archive's day total against the charger's own
meter: the ``history/{date}`` documents accumulate what the bridge observed,
and the gateway firmware (>= 4.2.2; this charger runs 8.2.3) independently
reports ``total_day`` -- kWh, full precision, reset at charger-local midnight
and surviving a reboot. When the two disagree beyond tolerance, something
lost energy -- an outage across a flush window, a dropped attribution step,
a counter reset the bridge missed -- and the reconciler says so in the
journal. It never writes: no history or session data is modified, corrected
or backfilled, and the day document stays exactly what the accumulator
wrote (#161's read-only invariant).

The bridge side of one evaluation is today's ``history/{date}.kwh`` plus
whatever the accumulator still holds pending for the day; the charger side
is the latest validated ``total_day`` sample. The loop that gathers those
lives in ``bridge.reconcile_loop``; this module is the pure core plus the
sample stream, unit-testable with neither Firestore nor a charger.
"""

import math

from parsing import (
    _gap_seconds,
    _interval_clock,
    _interval_step_allowance,
    _is_number,
)

# Default cadence of the reconcile loop; RECONCILE_INTERVAL=0 disables it.
RECONCILE_INTERVAL = 3600.0
# Two totals closer than this are the same number: metering noise, a flush
# still pending, observation skew. The 1% arm scales with the day (a 30 kWh
# day tolerates 0.3 kWh); the floor keeps tiny mornings from comparing
# noise against noise.
TOLERANCE_KWH = 0.05
TOLERANCE_FRACTION = 0.01
# A divergence episode journals one line; it re-arms only when the gap
# changes direction or grows by at least this much beyond the last journalled
# gap, so an ongoing known divergence cannot spam the journal hourly.
REARM_KWH = 1.0


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only

    return bridge.log(message)


def _localnow():
    # seam: tests patch bridge._localnow (PLAN.md facade rule)
    import bridge  # lazy, call-time only

    return bridge._localnow()


def _divergence_gap(bridge_kwh, charger_kwh):
    """Signed gap (bridge - charger) beyond tolerance, or None when clean.

    The tolerance is ``max(TOLERANCE_KWH, TOLERANCE_FRACTION`` of the larger
    side``)``: whichever total is right, the other one is wrong by the same
    amount, so the larger side sets the scale.
    """
    larger = max(abs(bridge_kwh), abs(charger_kwh))
    tolerance = max(TOLERANCE_KWH, TOLERANCE_FRACTION * larger)
    gap = bridge_kwh - charger_kwh
    if abs(gap) <= tolerance:
        return None
    return gap


class ChargerDayCounter:
    """The charger's ``total_day`` sample stream, guarded the record_history way.

    The status loop hands every applied observation's parsed ``total_day``
    here; each step is validated exactly like ``StatusTracker.record_history``
    validates ``total_energy``: a non-finite, negative or absent value is
    ignored, the first reading is only a baseline, a drop is the counter's
    own midnight rollover (or a mid-day firmware reset) and is recorded, and
    an upward step the charger could not have delivered in the elapsed
    boottime gap is rejected and rebaselined. A rejected sample poisons the
    counter's level, so the evaluation that would have compared it is
    suppressed until a plausible step restores trust -- a corrupt reading
    must not look like a reconciliation (or a divergence) either way.
    """

    def __init__(self):
        self._value = None  # last accepted sample, kWh
        self._boot = None  # _interval_clock() of the last accepted sample
        self._observed = None  # local datetime of the last accepted sample
        self._fed = False  # any observation applied here, usable or not
        self._present = False  # any usable sample ever (False => firmware <4.2.2)
        self._eval_ready = False  # the latest sample may anchor an evaluation
        # Local datetimes of observed counter drops -- the charger's midnight
        # rollover or a mid-day reset. PR-2's warning-authority rule (a
        # rollover within +/-1 h of Pi-local midnight) reads this history;
        # PR-1 only records it.
        self.rollovers = []

    @property
    def fed(self):
        """True once any status observation has been applied here."""
        return self._fed

    @property
    def present(self):
        """True once any usable ``total_day`` sample arrived (firmware >=4.2.2)."""
        return self._present

    @property
    def eval_ready(self):
        """False while the latest sample is an untrusted, rejected reading."""
        return self._eval_ready

    def sample(self):
        """``(value, observed_local)`` of the latest accepted sample, or None."""
        if self._value is None:
            return None
        return self._value, self._observed

    def note(self, value):
        """One observation's ``total_day``; validated, never raised upon."""
        self._fed = True
        if not _is_number(value) or not math.isfinite(value) or value < 0:
            # Absent (pre-4.2.2 firmware), a non-numeric reply or a corrupt
            # sentinel: no sample, and no state change to wipe a good one.
            return
        value = float(value)
        now = _localnow()
        boot = _interval_clock()
        if self._value is None:
            # The first reading is only a baseline: nothing to step against.
            self._value, self._boot, self._observed = value, boot, now
            self._present = True
            self._eval_ready = True
            return
        gap = None if self._boot is None else boot - self._boot
        step = value - self._value
        if step < 0:
            # The counter went backwards: the charger's own midnight rollover
            # (expected daily) or a mid-day firmware reset. Either way the new
            # reading is the counter's truth from here, and the drop itself is
            # the one observation PR-2's authority rule needs, so it is
            # stamped. The rebaselined counter stays evaluation-ready.
            self.rollovers.append(now)
            log(
                f"day counter rollover observed at "
                f"{now:%Y-%m-%d %H:%M:%S} local "
                f"({self._value:.3f} -> {value:.3f} kwh); rebaselining"
            )
            self._value, self._boot, self._observed = value, boot, now
            return
        allowed_wh = _interval_step_allowance(gap) if _is_number(gap) else None
        if allowed_wh is not None and step * 1000.0 > allowed_wh:
            # The same ceiling record_history applies: the charger cannot have
            # delivered this step in the time that passed, so the reading is
            # corrupt. Rebaseline to it (it is still the counter's level) but
            # withhold trust until a plausible step lands on top.
            log(
                f"day counter step dropped: {step:.3f} kwh "
                f"({step * 1000.0:.0f} Wh) in {_gap_seconds(gap)} exceeds the "
                f"{allowed_wh:.0f} Wh the charger could deliver; rebaselining "
                f"the day counter"
            )
            self._value, self._boot, self._observed = value, boot, now
            self._eval_ready = False
            return
        self._value, self._boot, self._observed = value, boot, now
        self._eval_ready = True


class DayReconciler:
    """Compares the archive's day total with the charger's; journals only.

    One evaluation is one comparison: the bridge's day total (the archive
    document's ``kwh`` plus the accumulator's pending energy for the day)
    against the charger's ``total_day`` sample. Beyond tolerance is a
    divergence; each divergence *episode* per ``(day, period)`` journals ONE
    bounded single-line warning naming the period, the date, both totals,
    the gap, the likely outage window (last clean evaluation -> first
    divergent observation, local) and the read-only promise, and re-arms
    only when the gap changes direction or grows by ``REARM_KWH``. A clean
    evaluation closes the episode.

    **Warning authority** (#161): until the reconciler has evidence the two
    totals measure the same day, a divergence says less than it appears to
    (a charger-local midnight skew, a firmware upgrade mid-day, a fresh
    install over an old archive), so it is journalled as an informational
    note only -- never a warning. PR-1 grants authority after one clean
    evaluation; PR-2 extends the grant with the observed-rollover rule (one
    ``total_day`` reset within +/-1 h of Pi-local midnight), which is why
    every grant funnels through ``_grant_authority``.
    """

    PERIOD = "day"  # the only period PR-1 reconciles; PR-3 extends to month

    def __init__(self):
        self.authorized = False
        # (day, period) -> {"gap": last journalled gap, "first_observed": the
        # episode's first divergent observation, frozen for the outage window}.
        self._episodes = {}
        self._last_clean = None  # local datetime of the last clean evaluation

    def evaluate(
        self,
        *,
        day,
        now_local,
        archive_kwh,
        pending_kwh,
        charger_kwh,
        charger_observed_local,
    ):
        """One evaluation. Logs only; returns "clean", "warned", "noted" or "held".

        ``day`` is the Pi-local date string the bridge side was gathered for;
        ``now_local`` the evaluation instant; ``charger_observed_local`` the
        wall-clock time of the charger sample being compared (the outage
        window's upper bound). Pure otherwise: every input is injected, so
        the whole divergence/authority/episode matrix is testable without
        Firestore or a charger.
        """
        bridge_kwh = float(archive_kwh) + float(pending_kwh)
        gap = _divergence_gap(bridge_kwh, float(charger_kwh))
        if gap is None:
            self._episodes.pop((day, self.PERIOD), None)
            self._last_clean = now_local
            if not self.authorized:
                self._grant_authority(now_local)
            return "clean"
        # Evaluations only ever name today, so episodes from earlier days
        # cannot still matter: keep exactly the current day's keys bounded.
        self._episodes = {
            key: episode for key, episode in self._episodes.items() if key[0] == day
        }
        key = (day, self.PERIOD)
        episode = self._episodes.get(key)
        if episode is not None and not self._rearmed(episode["gap"], gap):
            # Still the same divergence, neither flipped nor a kWh deeper:
            # the episode has already said its line.
            return "held"
        first_observed = (
            episode["first_observed"] if episode is not None else charger_observed_local
        )
        log(
            self._line(
                day,
                archive_kwh=archive_kwh,
                pending_kwh=pending_kwh,
                bridge_kwh=bridge_kwh,
                charger_kwh=charger_kwh,
                gap=gap,
                first_observed=first_observed,
            )
        )
        self._episodes[key] = {"gap": gap, "first_observed": first_observed}
        return "warned" if self.authorized else "noted"

    @staticmethod
    def _rearmed(previous_gap, gap):
        """True when a divergent episode may say its line again."""
        if (gap > 0) != (previous_gap > 0):
            return True  # the shortfall changed sides: a different problem
        return abs(gap) >= abs(previous_gap) + REARM_KWH

    def _grant_authority(self, now_local):
        """The one authority seam; PR-2 extends the grant rule here.

        PR-1 grants after one clean evaluation: the two totals demonstrably
        measured the same day, so a later divergence is the reconciler's to
        warn about. PR-2 adds the rollover rule (one ``total_day`` reset
        observed within +/-1 h of Pi-local midnight, from
        ``ChargerDayCounter.rollovers``) so authority survives a day that
        never had a clean evaluation.
        """
        self.authorized = True
        log(
            f"day reconciliation: warning authority granted "
            f"(clean evaluation at {now_local:%Y-%m-%d %H:%M} local)"
        )

    def _line(
        self,
        day,
        *,
        archive_kwh,
        pending_kwh,
        bridge_kwh,
        charger_kwh,
        gap,
        first_observed,
    ):
        """The one-line divergence journal entry (warning or informational)."""
        start = (
            f"{self._last_clean:%Y-%m-%d %H:%M}"
            if self._last_clean is not None
            else "no clean evaluation yet"
        )
        core = (
            f"{bridge_kwh:.3f} kwh (archive {float(archive_kwh):.3f} + pending "
            f"{float(pending_kwh):.3f}) vs charger total_day "
            f"{float(charger_kwh):.3f} kwh, gap {abs(gap):.3f} kwh "
            f"({'bridge low' if gap < 0 else 'bridge high'}); likely outage "
            f"window [{start} -> {first_observed:%Y-%m-%d %H:%M}] local; "
            f"no history or session data modified"
        )
        if self.authorized:
            return f"day reconciliation warning (day {day}): bridge history {core}"
        return (
            f"day reconciliation note (day {day}, informational, warning "
            f"authority not yet granted): bridge history {core}"
        )
