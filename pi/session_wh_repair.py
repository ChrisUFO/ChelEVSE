"""Repair decision for legacy under-recorded session ``wh`` (issue #195).

Pure logic, no I/O: given a session document as a plain dict (the shape
``.to_dict()`` returns), decide whether its ``wh`` aggregate undercounts an
energy-complete interval list — the class of documents written before the
bridge accumulated every counter epoch's per-tick deltas into ``wh``
(status_tracker, #195). The web's reconciliation guard
(``web/js/cost.js`` ``sessionIntervalsValid``) prices the interval list only
when it adds up to ``wh`` within ``max(250 Wh, 2%)``, so repairing ``wh`` to
the interval sum is what lets those documents price exactly instead of
pro-rating a bounded undercount.

The decision mirrors that guard's own tolerance, so a repaired document
reconciles by construction. Everything else is left alone: a session whose
intervals are short (a mid-charge restart left energy in the aggregate and in
no interval) keeps its ``wh``, because the aggregate is the better figure, and
a document that already reconciles needs nothing.
"""

import math
from datetime import datetime
from typing import NamedTuple, Optional

# The web guard's tolerance (INTERVAL_ENERGY_FLOOR_WH / _SHARE in cost.js):
# the floor covers one observation gap of energy at the charger's ceiling,
# the share scales it with the session.
INTERVAL_ENERGY_FLOOR_WH = 250.0
INTERVAL_ENERGY_SHARE = 0.02

# Per-document classifications, most specific defect first.
REPAIR = "repair"
RECONCILE = "reconcile"
INTERVALS_SHORT = "intervals-short"
NO_INTERVALS = "no-intervals"
UNUSABLE_INTERVALS = "unusable-intervals"
# Not in the report's core vocabulary, but a usable interval list beside an
# unusable aggregate fits none of the above and must not be misfiled.
BAD_WH = "bad-wh"


def energy_tolerance(wh):
    """The reconciliation band, identical to the web guard's."""
    return max(INTERVAL_ENERGY_FLOOR_WH, INTERVAL_ENERGY_SHARE * wh)


class RepairDecision(NamedTuple):
    """One document's verdict: a class, the repaired ``wh`` (or None) and the
    figures the report prints. ``repaired_wh`` is set only for REPAIR."""

    classification: str
    repaired_wh: Optional[float]
    wh: Optional[float]
    interval_sum: Optional[float]


def _is_number(value):
    """True for a real finite int/float; ``bool`` is not energy."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def _endpoint_ms(value):
    """Milliseconds since epoch for a parseable interval endpoint, else None.

    Firestore returns the stored timestamps as ``datetime`` (its timestamp
    class subclasses it); a raw finite number counts as epoch milliseconds,
    the same leniency the web's ``valueMillis`` applies.
    """
    if isinstance(value, datetime):
        try:
            ms = value.timestamp() * 1000.0
        except (OverflowError, OSError, ValueError):
            return None
        return ms if math.isfinite(ms) else None
    if _is_number(value):
        return float(value)
    return None


def usable_interval(entry):
    """True for one usable interval: finite positive ``wh`` over a real span.

    The same rules the bridge's merge path applies to a stored entry
    (``status_tracker._usable_interval``): a dict with both endpoints
    parseable and ordered, and energy a positive finite number.
    """
    if not isinstance(entry, dict):
        return False
    wh = entry.get("wh")
    if not _is_number(wh) or wh <= 0:
        return False
    started_at = _endpoint_ms(entry.get("started_at"))
    ended_at = _endpoint_ms(entry.get("ended_at"))
    if started_at is None or ended_at is None:
        return False
    return started_at < ended_at


def classify_session(document):
    """Classify one session document and propose the repaired ``wh``.

    REPAIR — and ``repaired_wh`` set to the float interval sum — exactly when
    every criterion holds: ``wh`` is a finite number ≥ 0, ``intervals`` is a
    non-empty list, every interval is usable, and the interval sum exceeds
    ``wh + max(250 Wh, 2%·wh)``. Every other shape keeps ``wh`` as it is.
    """
    if not isinstance(document, dict):
        return RepairDecision(NO_INTERVALS, None, None, None)
    intervals = document.get("intervals")
    if not isinstance(intervals, (list, tuple)) or not intervals:
        return RepairDecision(NO_INTERVALS, None, _aggregate_wh(document), None)
    if not all(usable_interval(entry) for entry in intervals):
        return RepairDecision(UNUSABLE_INTERVALS, None, _aggregate_wh(document), None)
    interval_sum = float(sum(float(entry["wh"]) for entry in intervals))
    raw_wh = document.get("wh")
    if not _is_number(raw_wh) or raw_wh < 0:
        return RepairDecision(BAD_WH, None, None, interval_sum)
    wh = float(raw_wh)
    tolerance = energy_tolerance(wh)
    if interval_sum > wh + tolerance:
        return RepairDecision(REPAIR, interval_sum, wh, interval_sum)
    if interval_sum < wh - tolerance:
        return RepairDecision(INTERVALS_SHORT, None, wh, interval_sum)
    return RepairDecision(RECONCILE, None, wh, interval_sum)


def _aggregate_wh(document):
    """The document's own ``wh`` as a float, or None when unusable."""
    raw_wh = document.get("wh")
    if not _is_number(raw_wh) or raw_wh < 0:
        return None
    return float(raw_wh)


def repair_wh(document):
    """The repaired ``wh`` for one session document, or None when it must be
    left alone — the one-call contract the CLI's write step uses."""
    return classify_session(document).repaired_wh
