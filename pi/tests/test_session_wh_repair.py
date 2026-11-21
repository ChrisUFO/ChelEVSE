"""Repair-decision tests for legacy under-recorded session ``wh`` (#195).

No Firestore, bridge or web import: the decision is pure, so every criterion,
boundary and classification is tested on plain dicts — the shapes
``.to_dict()`` returns, datetimes and numbers included. The live documents
that motivated the repair (November 2026, written before the fix) appear here
as fixtures so the exact production cases stay pinned.
"""

import math
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from session_wh_repair import (  # noqa: E402
    AFTER_BOUND,
    BAD_WH,
    INTERVALS_SHORT,
    NO_INTERVALS,
    RECONCILE,
    REPAIR,
    UNUSABLE_INTERVALS,
    classify_session,
    energy_tolerance,
    parse_before,
    repair_wh,
    usable_interval,
)

START = datetime(2026, 11, 1, 23, 0, 0)


def interval(wh, minutes=30, start=START):
    """One usable charging interval: positive wh over a real span."""
    return {
        "started_at": start,
        "ended_at": start + timedelta(minutes=minutes),
        "wh": wh,
    }


def session(wh, intervals):
    return {
        "started_at": START,
        "ended_at": START + timedelta(hours=8),
        "wh": wh,
        "intervals": intervals,
    }


def split(total, parts=2):
    """One usable interval list whose wh values sum to ``total``."""
    each = total / parts
    return [interval(each) for _ in range(parts)]


class RepairLiveDocuments(unittest.TestCase):
    """The eight live November-2026 documents: each repairs to its sum."""

    LIVE = [
        (15956, 48038),
        (11360, 24981),
        (23744, 29317),
        (14086, 22758),
        (11738, 20265),
        (11013, 19236),
        (12121, 14146),
        (8375, 10960),
    ]

    def test_every_live_undercount_repairs_to_the_interval_sum(self):
        for wh, total in self.LIVE:
            with self.subTest(wh=wh):
                decision = classify_session(session(wh, split(total)))
                self.assertEqual(decision.classification, REPAIR)
                self.assertEqual(decision.repaired_wh, float(total))
                self.assertEqual(decision.wh, float(wh))
                self.assertEqual(decision.interval_sum, float(total))

    def test_the_repaired_value_reconciles_within_the_web_guard(self):
        # The tolerance is the web's own, so a repaired document prices its
        # intervals by construction (|sum - wh| == 0 <= max(250, 2%)).
        for wh, total in self.LIVE:
            with self.subTest(wh=wh):
                repaired = repair_wh(session(wh, split(total)))
                self.assertLessEqual(abs(repaired - total), energy_tolerance(repaired))

    def test_the_live_short_and_matching_documents_are_left_alone(self):
        # 7237/10 and 13978/9447 are interval-short: wh is the better figure.
        for wh, total in [(7237, 10), (13978, 9447)]:
            with self.subTest(wh=wh):
                decision = classify_session(session(wh, split(total)))
                self.assertEqual(decision.classification, INTERVALS_SHORT)
                self.assertIsNone(decision.repaired_wh)


class RepairBoundaries(unittest.TestCase):
    """The tolerance band and its exact edges."""

    def test_a_sum_above_wh_within_the_band_reconciles(self):
        # 250 Wh floor: 1000 + 250 is still inside, not a repair.
        self.assertEqual(
            classify_session(session(1000, split(1250))).classification, RECONCILE
        )

    def test_a_sum_just_past_the_band_repairs(self):
        self.assertEqual(
            classify_session(session(1000, split(1250.01))).classification, REPAIR
        )

    def test_the_two_percent_branch_scales_with_the_session(self):
        # wh 30000: 2% (600) overtakes the 250 Wh floor.
        self.assertEqual(energy_tolerance(30000), 600.0)
        self.assertEqual(
            classify_session(session(30000, split(30600))).classification, RECONCILE
        )
        self.assertEqual(
            classify_session(session(30000, split(30601))).classification, REPAIR
        )

    def test_the_floor_governs_small_sessions(self):
        self.assertEqual(energy_tolerance(0), 250.0)
        self.assertEqual(energy_tolerance(10000), 250.0)

    def test_a_zero_wh_with_a_complete_list_repairs(self):
        # wh 0 is a finite number >= 0: the aggregate undercounts a list that
        # alone exceeds the 250 Wh floor.
        self.assertEqual(
            classify_session(session(0, split(300))).classification, REPAIR
        )
        self.assertEqual(repair_wh(session(0, split(300))), 300.0)

    def test_a_zero_wh_with_a_tiny_list_reconciles(self):
        self.assertEqual(
            classify_session(session(0, split(200))).classification, RECONCILE
        )

    def test_an_equal_sum_reconciles(self):
        self.assertEqual(
            classify_session(session(15956, split(15956))).classification, RECONCILE
        )

    def test_a_short_sum_below_wh_within_the_band_reconciles(self):
        self.assertEqual(
            classify_session(session(1000, split(800))).classification, RECONCILE
        )

    def test_a_sum_far_below_wh_is_intervals_short(self):
        self.assertEqual(
            classify_session(session(1000, split(100))).classification, INTERVALS_SHORT
        )

    def test_a_reconciling_decision_carries_both_figures_and_no_repair(self):
        decision = classify_session(session(1000, split(1000)))
        self.assertIsNone(decision.repaired_wh)
        self.assertEqual(decision.wh, 1000.0)
        self.assertEqual(decision.interval_sum, 1000.0)


class IntervalUsability(unittest.TestCase):
    """One unusable entry makes the whole list untrustworthy."""

    def test_every_criterion_failure_is_unusable(self):
        span = timedelta(minutes=30)
        cases = {
            "zero wh": {"started_at": START, "ended_at": START + span, "wh": 0},
            "negative wh": {"started_at": START, "ended_at": START + span, "wh": -5},
            "missing wh": {"started_at": START, "ended_at": START + span},
            "string wh": {"started_at": START, "ended_at": START + span, "wh": "300"},
            "nan wh": {"started_at": START, "ended_at": START + span, "wh": math.nan},
            "inf wh": {"started_at": START, "ended_at": START + span, "wh": math.inf},
            "bool wh": {"started_at": START, "ended_at": START + span, "wh": True},
            "missing start": {"ended_at": START + span, "wh": 300},
            "missing end": {"started_at": START, "wh": 300},
            "string start": {
                "started_at": "2026-11-01",
                "ended_at": START + span,
                "wh": 300,
            },
            "equal endpoints": {"started_at": START, "ended_at": START, "wh": 300},
            "inverted span": {"started_at": START + span, "ended_at": START, "wh": 300},
        }
        for name, entry in cases.items():
            with self.subTest(case=name):
                self.assertFalse(usable_interval(entry))
                self.assertEqual(
                    classify_session(session(1000, [entry])).classification,
                    UNUSABLE_INTERVALS,
                )

    def test_a_non_dict_entry_is_unusable(self):
        for entry in [None, 42, "interval", [START, START, 300]]:
            with self.subTest(entry=entry):
                self.assertFalse(usable_interval(entry))

    def test_one_unusable_entry_disqualifies_the_whole_list(self):
        # A repair must never rest on a list with a corrupt member: the sum
        # of the survivors is not known to be energy-complete.
        intervals = [
            interval(40000),
            {"started_at": START, "ended_at": START, "wh": 8000},
        ]
        decision = classify_session(session(15956, intervals))
        self.assertEqual(decision.classification, UNUSABLE_INTERVALS)
        self.assertIsNone(decision.repaired_wh)

    def test_epoch_millisecond_endpoints_are_parseable(self):
        entry = {
            "started_at": 1_789_000_000_000,
            "ended_at": 1_789_001_800_000,
            "wh": 300,
        }
        self.assertTrue(usable_interval(entry))
        # wh 10 + the 250 Wh floor is 260: a 300 Wh list exceeds it.
        self.assertEqual(classify_session(session(10, [entry])).classification, REPAIR)

    def test_equal_epoch_millisecond_endpoints_are_unusable(self):
        entry = {
            "started_at": 1_789_000_000_000,
            "ended_at": 1_789_000_000_000,
            "wh": 300,
        }
        self.assertFalse(usable_interval(entry))

    def test_a_usable_interval(self):
        self.assertTrue(usable_interval(interval(0.5, minutes=1)))


class DocumentShape(unittest.TestCase):
    """Everything that is not a repairable undercount, by document shape."""

    def test_missing_intervals(self):
        self.assertEqual(classify_session({"wh": 15956}).classification, NO_INTERVALS)

    def test_empty_interval_list(self):
        self.assertEqual(
            classify_session(session(15956, [])).classification, NO_INTERVALS
        )

    def test_null_intervals(self):
        self.assertEqual(
            classify_session({"wh": 15956, "intervals": None}).classification,
            NO_INTERVALS,
        )

    def test_non_list_intervals(self):
        self.assertEqual(
            classify_session({"wh": 15956, "intervals": "many"}).classification,
            NO_INTERVALS,
        )

    def test_a_non_dict_document(self):
        self.assertEqual(classify_session(None).classification, NO_INTERVALS)
        self.assertEqual(classify_session("sessions/1").classification, NO_INTERVALS)

    def test_bad_wh_beside_good_intervals(self):
        # An unusable aggregate cannot reconcile anything (the web guard
        # agrees) and must not be repaired from a list nothing can check.
        for wh in [None, "15956", -1, math.inf, math.nan, True]:
            with self.subTest(wh=wh):
                decision = classify_session(session(wh, split(48038)))
                self.assertEqual(decision.classification, BAD_WH)
                self.assertIsNone(decision.repaired_wh)
                self.assertEqual(decision.interval_sum, 48038.0)

    def test_no_intervals_beside_bad_wh_still_reports_no_intervals(self):
        self.assertEqual(classify_session({"wh": None}).classification, NO_INTERVALS)

    def test_a_negative_wh_with_unusable_intervals_reports_the_intervals(self):
        decision = classify_session(session(-1, [{"wh": 0}]))
        self.assertEqual(decision.classification, UNUSABLE_INTERVALS)

    def test_an_int_wh_is_read_as_a_float(self):
        decision = classify_session(session(15956, split(48038)))
        self.assertIsInstance(decision.wh, float)
        self.assertIsInstance(decision.repaired_wh, float)


class EraBound(unittest.TestCase):
    """The --before era bound: post-bound documents are never repairs.

    The bound is what keeps the tool off the post-#195 "reset-to-exactly-0"
    resume corner (ARCHITECTURE §4): such a document satisfies every repair
    criterion — its interval list legitimately exceeds wh — and only its
    ended_at era disqualifies it.
    """

    # The default bound: the instant the Pi restarted onto the #195 bridge.
    BEFORE = datetime(2026, 11, 20, 18, 41, 52, tzinfo=timezone.utc)
    BEFORE_MS = BEFORE.timestamp() * 1000.0

    def ended_session(self, ended_at):
        """The 15956-vs-48038 undercount shape, closed at ``ended_at``."""
        return {
            "started_at": datetime(2026, 11, 1, 23, 0, tzinfo=timezone.utc),
            "ended_at": ended_at,
            "wh": 15956,
            "intervals": split(48038),
        }

    def test_a_post_bound_undercount_shape_is_after_bound(self):
        # The finding-1 corner: repair criteria all hold, era does not.
        ended = self.BEFORE + timedelta(seconds=1)
        decision = classify_session(self.ended_session(ended), self.BEFORE_MS)
        self.assertEqual(decision.classification, AFTER_BOUND)
        self.assertIsNone(decision.repaired_wh)
        self.assertEqual(decision.wh, 15956.0)

    def test_a_session_closed_exactly_at_the_bound_is_after_bound(self):
        # Strictly before only: the boundary instant itself is excluded.
        decision = classify_session(self.ended_session(self.BEFORE), self.BEFORE_MS)
        self.assertEqual(decision.classification, AFTER_BOUND)

    def test_a_session_closed_just_before_the_bound_repairs(self):
        # Same-day pre-fix closes before the restart instant stay eligible.
        ended = self.BEFORE - timedelta(seconds=1)
        decision = classify_session(self.ended_session(ended), self.BEFORE_MS)
        self.assertEqual(decision.classification, REPAIR)
        self.assertEqual(decision.repaired_wh, 48038.0)

    def test_a_live_session_without_ended_at_is_after_bound(self):
        decision = classify_session(self.ended_session(None), self.BEFORE_MS)
        self.assertEqual(decision.classification, AFTER_BOUND)
        self.assertIsNone(decision.repaired_wh)

    def test_a_malformed_ended_at_is_after_bound(self):
        document = self.ended_session(self.BEFORE + timedelta(hours=1))
        document["ended_at"] = "2026-11-20T19:00:00Z"
        self.assertEqual(
            classify_session(document, self.BEFORE_MS).classification, AFTER_BOUND
        )

    def test_an_epoch_millisecond_ended_at_honours_the_bound(self):
        after = self.ended_session(
            (self.BEFORE + timedelta(hours=1)).timestamp() * 1000
        )
        self.assertEqual(
            classify_session(after, self.BEFORE_MS).classification, AFTER_BOUND
        )
        before = self.ended_session(
            (self.BEFORE - timedelta(hours=1)).timestamp() * 1000
        )
        self.assertEqual(
            classify_session(before, self.BEFORE_MS).classification, REPAIR
        )

    def test_no_bound_leaves_the_decision_unbounded(self):
        # Direct callers default to the unbounded decision; the bound is an
        # explicit argument, not a hidden global.
        ended = self.BEFORE + timedelta(hours=1)
        self.assertEqual(
            classify_session(self.ended_session(ended)).classification, REPAIR
        )

    def test_the_bound_gates_before_any_interval_analysis(self):
        # A post-bound document is after-bound even when its list is corrupt:
        # the era disqualifies it before the shape is even read.
        document = self.ended_session(self.BEFORE + timedelta(hours=1))
        document["intervals"] = [{"wh": 0}]
        self.assertEqual(
            classify_session(document, self.BEFORE_MS).classification, AFTER_BOUND
        )

    def test_repair_wh_honours_the_bound(self):
        post = self.ended_session(self.BEFORE + timedelta(hours=1))
        pre = self.ended_session(self.BEFORE - timedelta(hours=1))
        self.assertIsNone(repair_wh(post, self.BEFORE_MS))
        self.assertEqual(repair_wh(pre, self.BEFORE_MS), 48038.0)
        self.assertEqual(repair_wh(post), 48038.0)


class BeforeParsing(unittest.TestCase):
    """``parse_before``: ISO-8601 instants to epoch milliseconds."""

    def test_the_deploy_instant_parses(self):
        self.assertEqual(
            parse_before("2026-11-20T18:41:52Z"),
            datetime(2026, 11, 20, 18, 41, 52, tzinfo=timezone.utc).timestamp()
            * 1000.0,
        )

    def test_a_lowercase_z_is_accepted(self):
        self.assertEqual(
            parse_before("2026-11-20T18:41:52z"), parse_before("2026-11-20T18:41:52Z")
        )

    def test_a_naive_timestamp_is_read_as_utc(self):
        self.assertEqual(
            parse_before("2026-11-20T18:41:52"), parse_before("2026-11-20T18:41:52Z")
        )

    def test_an_explicit_offset_is_honoured(self):
        self.assertEqual(
            parse_before("2026-11-20T19:41:52+01:00"),
            parse_before("2026-11-20T18:41:52Z"),
        )

    def test_unparseable_input_is_none(self):
        for value in ["not-a-time", "", "   ", "2026-13-45T99:00:00Z", None, 42]:
            with self.subTest(value=value):
                self.assertIsNone(parse_before(value))


class RepairContract(unittest.TestCase):
    """``repair_wh`` is the one-call write guard the CLI uses."""

    def test_returns_the_float_sum_for_a_repairable_document(self):
        self.assertEqual(repair_wh(session(15956, split(48038))), 48038.0)

    def test_returns_none_for_every_left_alone_shape(self):
        for document in [
            session(1000, split(1000)),  # reconcile
            session(7237, split(10)),  # intervals-short
            {"wh": 15956},  # no intervals
            session(1000, [{"wh": 0}]),  # unusable intervals
            session(None, split(48038)),  # bad wh
        ]:
            with self.subTest(document=document):
                self.assertIsNone(repair_wh(document))


if __name__ == "__main__":
    unittest.main()
