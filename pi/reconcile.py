"""The energy-history reconciler (issue #161; day core in PR-1, month and
warning authority in PR-2) — seam A of the chain.

A read-only cross-check of the archive against the charger's own meter: the
``history/{date}`` documents accumulate what the bridge observed, and the
gateway firmware (>= 4.2.2; this charger runs 8.2.3) independently reports
``total_day``/``total_month`` -- kWh, full precision, reset at the
charger-local day/month boundary (the same ``time_zone``) and surviving a
reboot. When the two disagree beyond tolerance, something lost energy -- an
outage across a flush window, a dropped attribution step, a counter reset
the bridge missed -- and the reconciler says so in the journal.

**The charter, shared by both seams (#212): detection never corrects; the
verdict only discloses.** This seam writes nothing at all — no history or
session data is modified, corrected or backfilled, and the documents stay
exactly what the accumulator wrote (#161's read-only invariant). Its
sibling, :mod:`archive_reconcile` (seam B: day docs vs the sessions
archive), adds the chain's only writes: additive disclosure metadata
(``gap_wh``/``recon_from``) on field paths it owns, never a measurement —
the same promise from the other side of the archive.

One evaluation is one comparison per period: the day side is today's
``history/{date}.kwh`` plus whatever the accumulator still holds pending
for the day; the month side is the month's documents (one documentId range
query) plus today's pending energy, compared once per local day. The
charger side is the latest validated period-counter sample from the same
applied observations the status loop already consumes. The loop that
gathers those lives in ``bridge.reconcile_loop``; this module is the pure
core plus the sample streams, unit-testable with neither Firestore nor a
charger.
"""

import math

from parsing import (
    _gap_seconds,
    _interval_clock,
    _interval_step_allowance,
    _is_number,
)
from transport import MAX_AMPS

# Default cadence of the reconcile loop; RECONCILE_INTERVAL=0 disables it.
RECONCILE_INTERVAL = 3600.0
# Two totals closer than this are the same number: metering noise, a flush
# still pending, observation skew. The 1% arm scales with the day (a 30 kWh
# day tolerates 0.3 kWh); the floor keeps tiny mornings from comparing
# noise against noise, and covers one reconcile interval of the MQTT-mode
# feed gap: the charger side advances only at the HTTP reconcile cadence
# while the bridge side advances from every applied snapshot, so up to one
# interval of delivering power sits on one side only. That cover is
# bounded, not open-ended -- ceiling power x admitted age <= TOLERANCE_KWH
# -- and the bound is enforced in one place by covered_window_sec() below.
TOLERANCE_KWH = 0.2
TOLERANCE_FRACTION = 0.01
# A divergence episode journals one line; it re-arms only when the gap
# changes direction or grows by at least this much beyond the last journalled
# gap, so an ongoing known divergence cannot spam the journal hourly.
REARM_KWH = 1.0
# The most power the charger can deliver, as the tolerance floor's
# co-bound: the firmware current ceiling (transport.MAX_AMPS, 48 A) at the
# top of the UK supply band (230 V +10% = 253 V -- the nominal 240 V would
# understate the ceiling by ~5% and leave the floor no headroom at the
# window edge). The floor can only absorb a feed gap while the skew it is
# asked to cover -- ceiling power x sample age -- stays inside it, so the
# same ceiling also bounds how old an admitted sample may be.
SUPPLY_BAND_MAX_V = 253.0
CEILING_POWER_KW = MAX_AMPS * SUPPLY_BAND_MAX_V / 1000.0
# The age at which one ceiling-power skew reaches the floor: the oldest
# sample any feed cadence may admit (~59 s at 48 A x 253 V).
MAX_COVERED_AGE_SEC = 3600.0 * TOLERANCE_KWH / CEILING_POWER_KW
# The warning-authority window (#161 PR-2): a total_day reset observed this
# close to Pi-local midnight -- on either side, wall clock -- proves the
# charger's day and the archive's day are the same day in the same time
# zone, which is what makes a divergence the reconciler's to warn about.
ROLLOVER_WINDOW_SEC = 3600.0
SECONDS_PER_DAY = 86400.0
# A Wh-scaled counter (firmware variant or misconfiguration) reads ~1000x
# the bridge total. The band is generous because the two sides are gathered
# moments apart: the skew is bounded by the tolerance machinery, well
# inside 5% of any magnitude large enough to carry the signature.
UNIT_MISMATCH_FACTOR = 1000.0
UNIT_MISMATCH_TOLERANCE = 0.05


def covered_window_sec(feed_interval_sec):
    """The sample freshness window for a feed cadence (#161), in one place.

    One feed interval -- but never wider than the tolerance floor's
    coverage at ceiling power: the enforced form of ``CEILING_POWER_KW x
    window <= TOLERANCE_KWH``. A cadence slower than MAX_COVERED_AGE_SEC
    (a raised ``MQTT_RECONCILE_SEC`` or ``STATUS_INTERVAL``) would admit
    samples whose ceiling-power skew already outruns the floor -- the
    charger side advances only at the feed cadence while the bridge side
    advances from every applied snapshot -- so the window stops at the
    coverage bound instead and evaluations wait for a fresh sample rather
    than warning about observation skew. bridge.run resolves the live
    cadence and funnels every window through here.
    """
    return min(float(feed_interval_sec), MAX_COVERED_AGE_SEC)


def within_rollover_window(observed_local):
    """True when a counter reset stamp falls within 1 h of local midnight.

    Wall clock, on either side: the same clock the archive's day documents
    are keyed by, so the fold of a fall-back day cannot stretch the window
    (a stamp in the folded hour is judged by the hour it names) and a
    charger whose midnight runs up to an hour early or late still passes.
    """
    since_midnight = (
        observed_local
        - observed_local.replace(hour=0, minute=0, second=0, microsecond=0)
    ).total_seconds()
    return since_midnight <= ROLLOVER_WINDOW_SEC or (
        SECONDS_PER_DAY - since_midnight <= ROLLOVER_WINDOW_SEC
    )


def within_month_window(observed_local):
    """True when a month-counter reset stamp falls within 1 h of the month line.

    Day 1, 00:00 local, wall clock, on either side -- the month analogue of
    :func:`within_rollover_window`, on the same clock the month's day
    documents are keyed by: a month counter whose boundary runs up to an
    hour early or late still passes. A drop at any other hour is a
    mid-month restart, which proves the counter resets but not the period
    it reset to -- the month authority rule must not read it as month-line
    evidence, exactly as the day rule refuses a mid-day reset.
    """
    month_start = observed_local.replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    if (observed_local - month_start).total_seconds() <= ROLLOVER_WINDOW_SEC:
        return True
    if observed_local.month == 12:
        next_month_start = observed_local.replace(
            year=observed_local.year + 1,
            month=1,
            day=1,
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )
    else:
        next_month_start = observed_local.replace(
            month=observed_local.month + 1,
            day=1,
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )
    return (next_month_start - observed_local).total_seconds() <= ROLLOVER_WINDOW_SEC


def _unit_mismatch(bridge_kwh, charger_kwh):
    """True when the charger counter reads like the bridge total in Wh.

    A divergence near 1000x is not lost energy -- no charger delivers a
    month's power in an hour -- so it is rejected with its own line instead
    of warned about. The ratio only carries that signature above
    ``REARM_KWH`` on the small side: a genuine Wh-scaled counter crosses
    1 kWh on its first charge session, while below it a ~1000x ratio is
    exactly what an outage's opening looks like (a bridge dark since the
    period start restarting into a charging session -- a whisker of
    observed energy against a charger that delivered on its own schedule),
    which the ordinary comparison already carries. The magnitudes are
    bounded by the same tolerance machinery that bounds the comparison
    itself, which is what keeps the band honest at every scale it can
    fire at.
    """
    if bridge_kwh < REARM_KWH:
        # Too small to carry only the counter signature: the ordinary
        # warning/note decides, not the rejection.
        return False
    ratio = charger_kwh / bridge_kwh
    return abs(ratio - UNIT_MISMATCH_FACTOR) <= (
        UNIT_MISMATCH_TOLERANCE * UNIT_MISMATCH_FACTOR
    )


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
    """One charger period-counter sample stream, guarded the record_history way.

    One instance per period (``day`` for ``total_day``, ``month`` for
    ``total_month``): the status loop hands every applied observation's
    parsed counter here; each step is validated exactly like
    ``StatusTracker.record_history`` validates ``total_energy``: a
    non-finite, negative or absent value is ignored, the first reading is
    only a baseline, a drop from a trusted level is the counter's own
    period rollover (or a mid-period firmware reset), rebaselined and
    stamped, a drop measured from a rejected (corrupt) baseline
    rebaselines without stamping (it proves nothing about when the boundary
    fell), and an upward step the charger could not have delivered in the
    elapsed boottime gap is rejected and rebaselined. A rejected sample
    poisons the counter's level, so the evaluation that would have compared
    it is suppressed until a plausible step restores trust -- a corrupt
    reading must not look like a reconciliation (or a divergence) either
    way.

    A trusted pair of samples that straddles the period boundary
    *without* dropping is the opposite evidence -- the counter is not
    measuring this period (a time-zone or period mismatch) -- and is
    recorded in :attr:`non_resets`, but only where a hidden reset is
    excluded: if the current value could have been delivered since the
    boundary (the same step allowance judges that), a reset-and-rebuilt
    counter explains it just as well and nothing is concluded.

    The status loop thread writes (:meth:`note`) while the reconcile thread
    reads (:meth:`latest`, :meth:`sample`, :attr:`eval_ready`,
    :attr:`rollovers`, :attr:`non_resets`); the whole accepted-sample state
    lives in one atomically-replaced tuple, and :meth:`latest` loads it
    once, so that reader always sees one note's value, stamp and trust
    together -- never yesterday's value paired with today's stamp, and
    never a just-rejected reading still marked ready.
    """

    def __init__(self, period="day"):
        # The period this counter measures ("day"/"month"): names it in the
        # journal lines and sets the boundary its reset evidence is judged
        # against (a day counter resets at every local midnight, a month
        # counter at the month line).
        self.period = period
        # (value_kwh, boot_clock, observed_local, eval_ready) of the latest
        # applied sample, replaced whole in one attribute assignment (atomic
        # under the GIL): separate attributes tore across threads.
        self._state = None
        self._fed = False  # any observation applied here, usable or not
        self._present = False  # any usable sample ever (False => firmware <4.2.2)
        # Local datetimes of observed counter drops -- the counter's own
        # period rollover or a mid-period reset. The day stream's stamps are
        # the warning-authority rule's evidence (#161 PR-2): a rollover
        # within 1 h of Pi-local midnight unlocks warnings.
        self.rollovers = []
        # Local datetimes of proven non-resets across the period boundary
        # (a trusted pair that straddled it without dropping, with the
        # current value beyond anything a hidden reset could explain).
        self.non_resets = []

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
        state = self._state
        return state is not None and state[3]

    def sample(self):
        """``(value, observed_local)`` of the latest accepted sample, or None."""
        state = self._state
        if state is None:
            return None
        return state[0], state[2]

    def latest(self):
        """``(value, observed_local, eval_ready)`` from one state load.

        The reader that needs the value together with its stamp and its
        trust (the reconcile loop's tick) takes all three in this one
        load, so no interleaved :meth:`note` can pair one note's value
        with another note's readiness.
        """
        state = self._state
        if state is None:
            return None
        return state[0], state[2], state[3]

    def note(self, value):
        """One observation's period counter; validated, never raised upon."""
        self._fed = True
        if not _is_number(value) or not math.isfinite(value) or value < 0:
            # Absent (pre-4.2.2 firmware), a non-numeric reply or a corrupt
            # sentinel: no sample, and no state change to wipe a good one.
            return
        value = float(value)
        now = _localnow()
        boot = _interval_clock()
        state = self._state
        if state is None:
            # The first reading is only a baseline: nothing to step against.
            self._state = (value, boot, now, True)
            self._present = True
            return
        gap = None if state[1] is None else boot - state[1]
        step = value - state[0]
        if step < 0:
            # The counter went backwards: its own period rollover (the
            # expected reset at the boundary) or a mid-period firmware reset.
            # Either way the new reading is the counter's truth from here --
            # a reset is a direct observation, not a step to judge -- so the
            # rebaselined counter stays evaluation-ready. The stamp is
            # evidence only from a trusted level: a drop measured from a
            # rejected (corrupt) baseline proves nothing about when the
            # boundary fell, so the authority rule must not read it.
            if state[3]:
                self.rollovers.append(now)
            log(
                f"{self.period} counter rollover observed at "
                f"{now:%Y-%m-%d %H:%M:%S} local "
                f"({state[0]:.3f} -> {value:.3f} kwh); rebaselining"
            )
            self._state = (value, boot, now, True)
            return
        allowed_wh = _interval_step_allowance(gap) if _is_number(gap) else None
        if allowed_wh is not None and step * 1000.0 > allowed_wh:
            # The same ceiling record_history applies: the charger cannot have
            # delivered this step in the time that passed, so the reading is
            # corrupt. Rebaseline to it (it is still the counter's level) but
            # withhold trust until a plausible step lands on top. The level
            # and its withheld trust are one atomic store, so no reader can
            # pair the corrupt value with the previous sample's readiness.
            log(
                f"{self.period} counter step dropped: {step:.3f} kwh "
                f"({step * 1000.0:.0f} Wh) in {_gap_seconds(gap)} exceeds the "
                f"{allowed_wh:.0f} Wh the charger could deliver; rebaselining "
                f"the {self.period} counter"
            )
            self._state = (value, boot, now, False)
            return
        if (
            allowed_wh is not None
            and state[3]
            and self._boundary_crossed(state[2], now)
            and value * 1000.0 > allowed_wh
        ):
            # A trusted pair straddling the period boundary with no drop, and
            # the current value alone exceeds what could have been delivered
            # since the boundary: no reset hides in this gap -- the counter
            # did not reset before this stamp. From an untrusted baseline
            # nothing is concluded, and a smaller value leaves a
            # reset-and-rebuilt counter just as likely. The line stops at
            # what is proven: a boundary reset up to an hour late (the
            # authority window's tolerance) can still land after this
            # pair, so the mismatch conclusion is the reconcilers' to draw
            # when no reset arrives, not this observation's.
            self.non_resets.append(now)
            log(
                f"{self.period} counter did not reset across the local "
                f"{self.period} boundary before {now:%Y-%m-%d %H:%M} local "
                f"({value:.3f} kwh vs {state[0]:.3f} kwh before); period "
                f"alignment unproven until a boundary reset is observed"
            )
        self._state = (value, boot, now, True)

    def _boundary_crossed(self, previous_local, now):
        """Whether two consecutive observations straddled the reset boundary."""
        if self.period == "month":
            return (previous_local.year, previous_local.month) != (
                now.year,
                now.month,
            )
        return previous_local.date() != now.date()


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
    note only -- never a warning. The evidence is the rollover rule: one
    ``total_day`` reset observed within 1 h of Pi-local midnight
    (:func:`within_rollover_window`), fed from
    :class:`ChargerDayCounter.rollovers` by :meth:`consider_evidence`. A
    reset at any other hour, or a counter that crosses local midnight
    *without* resetting, is boundary evidence of a time-zone or period
    mismatch: the mismatch is said once, distinctly, and a grant the
    non-reset contradicts is revoked -- comparisons stay informational
    until a midnight rollover is observed. A ~1000x divergence is none of
    that: it is a unit mismatch, rejected with its own line (:meth:`evaluate`).
    """

    PERIOD = "day"
    COUNTER = "total_day"

    def __init__(self):
        self.authorized = False
        # (day, period) -> {"gap": last journalled gap, "first_observed": the
        # episode's first divergent observation, frozen for the outage window}.
        self._episodes = {}
        self._last_clean = None  # local datetime of the last clean evaluation
        # How much of each evidence list has been consumed: every grant or
        # mismatch note is said once per observed event, never per tick.
        self._rollovers_seen = 0
        self._non_resets_seen = 0

    def consider_evidence(self, rollovers, non_resets):
        """One tick's boundary evidence from the charger's day counter.

        The loop hands the counter's rollover and non-reset stamps each
        tick; each new stamp is judged exactly once. A rollover inside the
        window grants warning authority (if not already held); a rollover
        outside it, while authority is not held, journals the one-time
        time-zone/period mismatch note; a non-reset revokes a held grant
        (the counter stopped measuring this period) and says so once.
        """
        for observed in rollovers[self._rollovers_seen :]:
            self._rollovers_seen += 1
            if within_rollover_window(observed):
                self._grant_authority(observed)
            elif not self.authorized:
                # Once per wrong-hour event, and only while the alignment
                # is unproven: after a verified midnight, a mid-day reset is
                # the restart scenario, not a time-zone mismatch.
                log(
                    f"day reconciliation: total_day reset observed at "
                    f"{observed:%Y-%m-%d %H:%M} local, outside 1 h of local "
                    f"midnight; time-zone or period mismatch suspected -- "
                    f"comparisons stay informational until a rollover lands "
                    f"within the window"
                )
        for observed in non_resets[self._non_resets_seen :]:
            self._non_resets_seen += 1
            if self.authorized:
                self.authorized = False
                log(
                    f"day reconciliation: warning authority revoked -- the "
                    f"day counter did not reset across the local midnight "
                    f"before {observed:%Y-%m-%d %H:%M} local; comparisons "
                    f"are informational again until a rollover lands within "
                    f"1 h of local midnight"
                )

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
        """One evaluation. Logs only; returns "clean", "warned", "noted",
        "rejected" or "held".

        ``day`` is the Pi-local date string the bridge side was gathered for
        (the month reconciler passes the ``YYYY-MM`` month instead);
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
            return "clean"
        # Evaluations only ever name the current period, so episodes from
        # earlier ones cannot still matter: keep exactly the current
        # period's keys bounded.
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
        if _unit_mismatch(bridge_kwh, float(charger_kwh)):
            # Not lost energy: a Wh-scaled counter. Rejected with its own
            # bounded line, never warned, never reconciled.
            log(
                self._rejection_line(
                    day,
                    bridge_kwh=bridge_kwh,
                    charger_kwh=charger_kwh,
                )
            )
            self._episodes[key] = {"gap": gap, "first_observed": first_observed}
            return "rejected"
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

    def _grant_authority(self, rollover_local):
        """The one authority seam: the observed-rollover rule (#161).

        A ``total_day`` reset within 1 h of Pi-local midnight proves the
        period semantics and the time-zone alignment -- the "verify one
        known-good day" rule, automated -- so a later divergence is the
        reconciler's to warn about. Granted once; a later wrong-hour reset
        does not undo it (a mid-day firmware restart is expected), only a
        non-reset does (:meth:`consider_evidence`).
        """
        if self.authorized:
            return
        self.authorized = True
        log(
            f"day reconciliation: warning authority granted (total_day "
            f"rollover observed at {rollover_local:%Y-%m-%d %H:%M} local, "
            f"within 1 h of local midnight -- period and time-zone "
            f"alignment verified)"
        )

    def _rejection_line(self, day, *, bridge_kwh, charger_kwh):
        """The one-line unit-mismatch rejection (neither period's warning)."""
        return (
            f"{self.PERIOD} reconciliation rejected ({self.PERIOD} {day}): "
            f"charger {self.COUNTER} {float(charger_kwh):.3f} kwh is about "
            f"1000x the bridge history {bridge_kwh:.3f} kwh; unit mismatch "
            f"suspected (a Wh-scaled counter?) -- the comparison is "
            f"rejected, not warned; no history or session data modified"
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
            f"{float(pending_kwh):.3f}) vs charger {self.COUNTER} "
            f"{float(charger_kwh):.3f} kwh, gap {abs(gap):.3f} kwh "
            f"({'bridge low' if gap < 0 else 'bridge high'}); likely outage "
            f"window [{start} -> {first_observed:%Y-%m-%d %H:%M}] local; "
            f"no history or session data modified"
        )
        if self.authorized:
            return (
                f"{self.PERIOD} reconciliation warning ({self.PERIOD} {day}): "
                f"bridge history {core}"
            )
        return (
            f"{self.PERIOD} reconciliation note ({self.PERIOD} {day}, "
            f"informational, warning authority not yet granted): "
            f"bridge history {core}"
        )


class MonthReconciler(DayReconciler):
    """Compares the archive's month total with the charger's ``total_month``.

    Same machinery as the day comparison -- tolerance, episode bounding,
    unit-mismatch rejection, the read-only promise -- over a month-keyed
    episode space, fed by ``bridge._month_totals`` (one documentId range
    query over the month's day documents plus today's pending energy, once
    per local day).

    **Warning authority** (#161): one clean *day* comparison is the month's
    gate. The day comparison proving the shared period semantics and
    time-zone alignment is exactly what the month needs too (the month
    counter rides the same observations and resets on the same local
    clock), so the loop grants it via :meth:`note_clean_day`; the
    rollover evidence itself stays the day reconciler's business. The
    same holds in reverse: the loop feeds the day counter's non-resets
    to :meth:`consider_evidence`, and each one revokes a held grant --
    evidence that disproves the shared clock for the day disproves it
    for the month too. The month counter's own boundary evidence is its
    own (:meth:`consider_month_evidence`): a ``total_month`` that sails
    across the month line without resetting is not measuring this month
    (a cumulative counter -- a firmware variant or misconfiguration),
    so its non-reset revokes a held grant and withholds the clean-day
    gate until that counter is observed resetting at a month boundary:
    a clean day proves the day's alignment, not a cumulative counter's.
    """

    PERIOD = "month"
    COUNTER = "total_month"

    def __init__(self):
        super().__init__()
        # The month counter's own evidence lists get their own seen-indices:
        # the inherited ones index the day stream's lists, and one index
        # cannot track two lists.
        self._month_rollovers_seen = 0
        self._month_non_resets_seen = 0
        # True while the month counter's own period alignment is disproven
        # (a non-reset at the month line): the clean-day gate is withheld
        # until the counter is observed resetting at the month line
        # (within the hour either side) -- or a cumulative ``total_month``
        # would walk back through that gate every day and keep
        # false-warning forever.
        self._period_misaligned = False

    def consider_evidence(self, rollovers, non_resets):
        """Consume the day counter's non-resets: each revokes a held grant.

        The month's gate is the day comparison (:meth:`note_clean_day`),
        so rollovers are not this reconciler's business -- but a day
        counter that stopped resetting across local midnight disproves
        the shared period/time-zone alignment for *both* periods (the
        counters ride the same clock), so the loop hands the day's
        non-reset stamps here beside the day reconciler's own judgement.
        A grant one contradicts falls: comparisons are informational
        again until the next clean day comparison.
        """
        for observed in non_resets[self._non_resets_seen :]:
            self._non_resets_seen += 1
            if self.authorized:
                self.authorized = False
                log(
                    f"month reconciliation: warning authority revoked -- "
                    f"the day counter did not reset across the local "
                    f"midnight before {observed:%Y-%m-%d %H:%M} local; "
                    f"month comparisons are informational again until a "
                    f"clean day comparison"
                )

    def consider_month_evidence(self, rollovers, non_resets):
        """Consume the month counter's own boundary evidence.

        The day-fed evidence (:meth:`consider_evidence`) speaks for the
        shared clock; this is the month counter's own period alignment.
        A non-reset -- the counter sailing across its month line -- means
        the ``total_month`` being compared is not this month's total (a
        cumulative counter, a firmware variant or misconfiguration), so a
        grant it disproves falls and the clean-day gate is withheld: a
        clean day proves the day's alignment, not a cumulative counter's.
        The next month rollover observed at the month line -- within the
        hour either side (:func:`within_month_window`), the counter
        actually resetting at its boundary -- restores the alignment and
        clean days grant again; a rollover at any other hour is a
        mid-month restart, which proves the counter resets but not the
        period it reset to, so the gate stays withheld. The same
        evidence-driven shape as the day rule, one boundary deeper.
        """
        for observed in rollovers[self._month_rollovers_seen :]:
            self._month_rollovers_seen += 1
            if not self._period_misaligned:
                # Nothing is withheld: a drop while the counter's own
                # alignment is not in question is the restart scenario,
                # and the counter has already journaled its rebaseline.
                continue
            if within_month_window(observed):
                self._period_misaligned = False
                log(
                    f"month reconciliation: month counter reset observed "
                    f"at {observed:%Y-%m-%d %H:%M} local after a non-reset, "
                    f"within 1 h of the month line; period alignment "
                    f"restored -- the next clean day comparison can "
                    f"re-grant warning authority"
                )
            else:
                log(
                    f"month reconciliation: month counter reset observed "
                    f"at {observed:%Y-%m-%d %H:%M} local, outside 1 h of "
                    f"the month line; period alignment still unproven -- "
                    f"a mid-month restart does not show the counter "
                    f"measuring this month"
                )
        for observed in non_resets[self._month_non_resets_seen :]:
            self._month_non_resets_seen += 1
            if self.authorized:
                self.authorized = False
                log(
                    f"month reconciliation: warning authority revoked -- "
                    f"the month counter did not reset across the local "
                    f"month boundary before {observed:%Y-%m-%d %H:%M} "
                    f"local; month comparisons are informational again "
                    f"until the counter is observed resetting at a month "
                    f"boundary and a day comparison runs clean"
                )
            self._period_misaligned = True

    def note_clean_day(self, now_local):
        """Grant authority after one clean day comparison (once).

        Withheld while the month counter's own alignment is disproven
        (:meth:`consider_month_evidence`): a clean day says the day's
        semantics match, not that a cumulative ``total_month`` started
        measuring the month.
        """
        if not self.authorized and not self._period_misaligned:
            self._grant_authority(now_local)

    def _grant_authority(self, now_local):
        self.authorized = True
        log(
            f"month reconciliation: warning authority granted (one clean "
            f"day comparison at {now_local:%Y-%m-%d %H:%M} local)"
        )
