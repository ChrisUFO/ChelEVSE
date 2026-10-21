"""Unit tests for pi/bridge.py (stdlib unittest; no charger or Firestore)."""

import os
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

import bridge  # noqa: E402
from fakes import FakeDB, FakeResponse, FakeSession  # noqa: E402

UTC = timezone.utc


class FirestoreSafeTests(unittest.TestCase):
    def test_uint64_sentinel_becomes_float(self):
        safe = bridge.firestore_safe(
            {"tesla_created_at": 2**64 - 1, "ok": 42, "big_neg": -(2**63) - 1}
        )
        self.assertEqual(safe["tesla_created_at"], float(2**64 - 1))
        self.assertEqual(safe["ok"], 42)
        self.assertEqual(safe["big_neg"], float(-(2**63) - 1))

    def test_non_finite_floats_become_none(self):
        safe = bridge.firestore_safe([float("nan"), float("inf"), float("-inf")])
        self.assertEqual(safe, [None, None, None])

    def test_bools_and_containers_stay_intact(self):
        data = {"enabled": True, "nested": {"list": [1, False]}}
        self.assertEqual(bridge.firestore_safe(data), data)


class RedactConfigTests(unittest.TestCase):
    def test_secret_fields_are_redacted_and_others_kept(self):
        data = {
            "pass": "wifi-psk",
            "ap_pass": "ap",
            "www_password": "admin",
            "mqtt_pass": "mqtt",
            "emoncms_apikey": "key",
            "ocpp_authkey": "ocpp",
            "tesla_access_token": "access",
            "tesla_refresh_token": "refresh",
            "ssid": "home",
            "firmware": "5.1.5",
            "max_current": 48,
        }
        safe = bridge.redact_config(data)
        for key in (
            "pass",
            "ap_pass",
            "www_password",
            "mqtt_pass",
            "emoncms_apikey",
            "ocpp_authkey",
            "tesla_access_token",
            "tesla_refresh_token",
        ):
            self.assertEqual(safe[key], "***")
        self.assertEqual(safe["ssid"], "home")
        self.assertEqual(safe["firmware"], "5.1.5")
        self.assertEqual(safe["max_current"], 48)
        # The charger payload itself is not mutated.
        self.assertEqual(data["pass"], "wifi-psk")


class ParseStatusTests(unittest.TestCase):
    def test_curated_fields_and_absent_sensors(self):
        fields = bridge.parse_status(
            {
                "state": 3,
                "amp": 15400,
                "voltage": 240,
                "power": 3.8,
                "session_energy": 100,
                "total_energy": 37.26,
                "elapsed": 60,
                "temp1": 250,
                "temp2": False,
                "temp3": 0,
                "pilot": 16,
                "vehicle": 1,
            }
        )
        self.assertEqual(fields["state_label"], "charging")
        self.assertEqual(fields["temp1"], 25.0)
        self.assertIsNone(fields["temp2"])
        self.assertIsNone(fields["temp3"])
        self.assertEqual(fields["temp_c"], 25.0)
        self.assertEqual(fields["amp"], 15.4)
        self.assertEqual(fields["pilot"], 16)
        self.assertEqual(fields["vehicle"], 1)
        self.assertTrue(fields["charger_online"])

    def test_empty_payload_is_unknown_not_an_error(self):
        fields = bridge.parse_status({})
        self.assertIsNone(fields["state"])
        self.assertIsNone(fields["amp"])
        self.assertEqual(fields["state_label"], "unknown")
        self.assertIsNone(fields["temp_c"])


class ApplyCommandTests(unittest.TestCase):
    def test_pause_posts_disabled_override(self):
        session = FakeSession([FakeResponse(200)])
        self.assertEqual(
            bridge.apply_command(session, "http://charger", None, {"type": "pause"}),
            {},
        )
        method, url, kwargs = session.calls[0]
        self.assertEqual((method, url), ("post", "http://charger/override"))
        self.assertEqual(kwargs["json"], {"state": "disabled"})

    def test_resume_deletes_override(self):
        session = FakeSession([FakeResponse(200)])
        bridge.apply_command(session, "http://charger", None, {"type": "resume"})
        self.assertEqual(session.calls[0][0], "delete")
        self.assertEqual(session.calls[0][1], "http://charger/override")

    def test_resume_500_with_no_override_is_treated_as_acked(self):
        session = FakeSession(
            [FakeResponse(500, text="Failed to release"), FakeResponse(200, {"manual_override": 0})]
        )
        self.assertEqual(
            bridge.apply_command(session, "http://charger", None, {"type": "resume"}),
            {},
        )
        self.assertEqual([call[0] for call in session.calls], ["delete", "get"])

    def test_resume_500_with_override_still_fails(self):
        session = FakeSession(
            [FakeResponse(500, text="Failed to release"), FakeResponse(200, {"manual_override": 1})]
        )
        with self.assertRaises(bridge.CommandError):
            bridge.apply_command(session, "http://charger", None, {"type": "resume"})

    def test_resume_500_with_non_object_status_fails_cleanly(self):
        session = FakeSession(
            [FakeResponse(500, text="Failed to release"), FakeResponse(200, [1, 2])]
        )
        with self.assertRaises(bridge.CommandError):
            bridge.apply_command(session, "http://charger", None, {"type": "resume"})

    def test_set_current_clamps_to_firmware_limits(self):
        session = FakeSession([FakeResponse(200), FakeResponse(200)])
        bridge.apply_command(
            session, "http://charger", None, {"type": "set_current", "amps": 99}
        )
        bridge.apply_command(
            session, "http://charger", None, {"type": "set_current", "amps": 1}
        )
        self.assertEqual(session.calls[0][2]["json"]["charge_current"], bridge.MAX_AMPS)
        self.assertEqual(session.calls[1][2]["json"]["max_current"], bridge.MIN_AMPS)

    def test_set_current_rejects_missing_amps_without_calling_charger(self):
        session = FakeSession()
        with self.assertRaises(bridge.CommandError):
            bridge.apply_command(session, "http://charger", None, {"type": "set_current"})
        self.assertEqual(session.calls, [])

    def test_rapi_returns_ret_value(self):
        session = FakeSession([FakeResponse(200, {"ret": "OK"})])
        extra = bridge.apply_command(
            session, "http://charger", None, {"type": "rapi", "command": "$OK"}
        )
        self.assertEqual(extra, {"result": "OK"})
        self.assertEqual(session.calls[0][2]["data"], {"rapi": "$OK", "json": 1})

    def test_rapi_non_json_reply_is_returned_raw(self):
        session = FakeSession([FakeResponse(200, payload=None, text="  $OK  \n")])
        extra = bridge.apply_command(
            session, "http://charger", None, {"type": "rapi", "command": "$OK"}
        )
        self.assertEqual(extra, {"result": "$OK"})

    def test_rapi_validation_rejects_without_contacting_charger(self):
        for command in ("OK", "$" + "A" * 32, 42, None):
            session = FakeSession()
            with self.assertRaises(bridge.CommandError):
                bridge.apply_command(
                    session,
                    "http://charger",
                    None,
                    {"type": "rapi", "command": command},
                )
            self.assertEqual(session.calls, [])

    def test_non_2xx_reply_is_a_command_error_with_http_status(self):
        session = FakeSession([FakeResponse(500, payload=None, text="boom")])
        with self.assertRaises(bridge.CommandError) as raised:
            bridge.apply_command(session, "http://charger", None, {"type": "pause"})
        self.assertIn("HTTP 500", str(raised.exception))
        self.assertIn("boom", str(raised.exception))

    def test_unknown_type_fails(self):
        with self.assertRaises(bridge.CommandError):
            bridge.apply_command(FakeSession(), "http://charger", None, {"type": "x"})


def rule(rule_id, days, start, end, amps=16):
    return {
        "id": rule_id,
        "days": days,
        "start": start,
        "end": end,
        "amps": amps,
    }


class NormalizeScheduleTests(unittest.TestCase):
    def test_missing_enabled_is_malformed(self):
        self.assertIsNone(bridge.normalize_schedule({"rules": []}))

    def test_non_list_rules_is_malformed(self):
        self.assertIsNone(bridge.normalize_schedule({"enabled": True, "rules": {}}))

    def test_enabled_with_only_unusable_rules_is_malformed(self):
        self.assertIsNone(
            bridge.normalize_schedule(
                {"enabled": True, "rules": [rule("", [0], "10:00", "11:00")]}
            )
        )

    def test_explicit_disable_with_no_rules_is_a_valid_clear(self):
        self.assertEqual(
            bridge.normalize_schedule({"enabled": False, "rules": []}), (False, [])
        )

    def test_explicit_disable_ignores_unusable_rules(self):
        self.assertEqual(
            bridge.normalize_schedule(
                {"enabled": False, "rules": [{"id": "x", "days": "monday"}]}
            ),
            (False, []),
        )

    def test_valid_rules_are_canonical_and_sorted(self):
        enabled, rules = bridge.normalize_schedule(
            {
                "enabled": True,
                "rules": [
                    rule("b", [6, 6], "22:00", "06:00", amps=20),
                    rule("a", [0], "07:00", "09:00"),
                ],
            }
        )
        self.assertTrue(enabled)
        self.assertEqual([item["id"] for item in rules], ["a", "b"])
        self.assertEqual(rules[1]["days"], [6])

    def test_rule_accept_drop_matrix(self):
        valid = rule("a", [0], "10:00", "11:00")
        cases = [
            (valid, True),
            ("not a rule", False),
            (rule("", [0], "10:00", "11:00"), False),
            (rule("a", [], "10:00", "11:00"), False),
            (rule("a", [7], "10:00", "11:00"), False),
            (rule("a", [True], "10:00", "11:00"), False),
            (rule("a", [0], "7:00", "11:00"), False),
            (rule("a", [0], "10:00", "24:00"), False),
            (rule("a", [0], "10:00", "10:00"), False),
            (rule("a", [0], "10:00", "11:00", amps=True), False),
            (rule("a", [0], "10:00", "11:00", amps=float("inf")), False),
        ]
        for raw, accepted in cases:
            with self.subTest(raw=raw):
                self.assertEqual(bridge._normalize_rule(raw) is not None, accepted)

    def test_times_must_be_exact_ascii_hh_mm(self):
        malformed = [
            ("22:00\n", "06:00"),
            ("22:00", "06:00\n"),
            ("٢٢:٠٠", "06:00"),
            ("22:00", "٠٦:٠٠"),
            ("1٢:30", "06:00"),
            ("22:00", "10:3٥"),
            ("22:00\n", "06:00\n"),
        ]
        for start, end in malformed:
            with self.subTest(start=start, end=end):
                self.assertIsNone(bridge._normalize_rule(rule("a", [0], start, end)))
        self.assertEqual(
            bridge._normalize_rule(rule("a", [0], "22:00", "06:00"))["start"], "22:00"
        )

    def test_zero_length_rule_is_rejected(self):
        self.assertIsNone(bridge._normalize_rule(rule("a", [0], "10:00", "10:00")))

    def test_overlapping_rules_drop_the_later_one(self):
        enabled, rules = bridge.normalize_schedule(
            {
                "enabled": True,
                "rules": [
                    rule("a", [0], "10:00", "14:00"),
                    rule("b", [0], "12:00", "13:00"),
                ],
            }
        )
        self.assertEqual([item["id"] for item in rules], ["a"])

    def test_touching_windows_are_rejected(self):
        _, rules = bridge.normalize_schedule(
            {
                "enabled": True,
                "rules": [
                    rule("a", [0], "10:00", "12:00"),
                    rule("b", [0], "12:00", "14:00"),
                ],
            }
        )
        self.assertEqual([item["id"] for item in rules], ["a"])

    def test_rules_on_different_days_do_not_overlap(self):
        _, rules = bridge.normalize_schedule(
            {
                "enabled": True,
                "rules": [
                    rule("a", [0], "10:00", "12:00"),
                    rule("b", [1], "10:00", "12:00"),
                ],
            }
        )
        self.assertEqual(len(rules), 2)

    def test_overnight_spill_overlap_is_detected(self):
        # Sunday 22:00-06:00 occupies Monday 00:00-06:00 too.
        _, rules = bridge.normalize_schedule(
            {
                "enabled": True,
                "rules": [
                    rule("a", [6], "22:00", "06:00"),
                    rule("b", [0], "05:00", "07:00"),
                ],
            }
        )
        self.assertEqual([item["id"] for item in rules], ["a"])

    def test_overnight_ending_at_midnight_has_no_zero_segment(self):
        segments = bridge._rule_segments(rule("a", [0], "22:00", "00:00"))
        self.assertEqual(segments, [(0, 22 * 60, 24 * 60)])


class ScheduleEventsTests(unittest.TestCase):
    def test_day_mapping_and_overnight_end_shift(self):
        events, mapping = bridge.schedule_events(
            [rule("a", [6], "22:00", "06:00")]
        )
        self.assertEqual(events[0]["id"], 1)
        self.assertEqual(events[0]["state"], "active")
        self.assertEqual(events[0]["time"], "22:00:00")
        self.assertEqual(events[0]["days"], ["sunday"])
        self.assertEqual(events[1]["id"], 2)
        self.assertEqual(events[1]["state"], "disabled")
        self.assertEqual(events[1]["time"], "06:00:00")
        self.assertEqual(events[1]["days"], ["monday"])
        self.assertEqual(mapping, {1: "a", 2: "a"})

    def test_monday_maps_to_firmware_monday_and_non_wrapping_days_match(self):
        events, _ = bridge.schedule_events([rule("a", [0, 2], "08:00", "09:00")])
        self.assertEqual(events[0]["days"], ["monday", "wednesday"])
        self.assertEqual(events[1]["days"], ["monday", "wednesday"])

    def test_two_rules_get_distinct_deterministic_ids(self):
        events, mapping = bridge.schedule_events(
            [rule("a", [0], "08:00", "09:00"), rule("b", [1], "10:00", "11:00")]
        )
        self.assertEqual([event["id"] for event in events], [1, 2, 3, 4])
        self.assertEqual(mapping, {1: "a", 2: "a", 3: "b", 4: "b"})


class ScheduleStateTests(unittest.TestCase):
    def test_active_window(self):
        state = bridge.schedule_state(
            {
                "current_event": {"id": 1, "state": "active", "duration": 3600},
                "next_event_delay": 60,
            },
            {1: "a"},
        )
        self.assertEqual(state, {"in_window": True, "active_rule_id": "a"})

    def test_future_or_stale_event_is_not_a_window(self):
        state = bridge.schedule_state(
            {
                "current_event": {"id": 1, "state": "active", "duration": 3600},
                "next_event_delay": 4000,
            },
            {1: "a"},
        )
        self.assertEqual(state, {"in_window": False, "active_rule_id": None})

    def test_disabled_current_event_is_not_a_window(self):
        state = bridge.schedule_state(
            {
                "current_event": {"id": 2, "state": "disabled", "duration": 0},
                "next_event_delay": 0,
            },
            {2: "a"},
        )
        self.assertEqual(state, {"in_window": False, "active_rule_id": None})

    def test_missing_or_false_plan(self):
        for plan in ({}, {"current_event": False}, {"next_event_delay": False}, None):
            with self.subTest(plan=plan):
                self.assertEqual(
                    bridge.schedule_state(plan, {1: "a"}),
                    {"in_window": False, "active_rule_id": None},
                )


class HistoryTests(unittest.TestCase):
    """history/<local date>: one masked merge write per positive delta.

    The local clock is patched so the document id and the hour bucket are
    deterministic; every case goes through ``record`` for that reason.
    """

    def setUp(self):
        self.db = FakeDB()
        self.tracker = bridge.StatusTracker(self.db)
        self.tracker.seeded = True

    def record(self, total, when=None):
        when = when or datetime(2026, 10, 21, 21, 30, tzinfo=UTC)
        with mock.patch.object(bridge, "_localnow", return_value=when):
            self.tracker.record_history(total)

    def history(self):
        return self.db.data.get("history", {})

    def test_first_observation_is_only_a_baseline(self):
        self.record(100.0)
        self.assertEqual(self.history(), {})
        self.assertEqual(self.db.writes, [])
        self.assertEqual(self.tracker.total_energy, 100.0)

    def test_delta_accumulates_the_daily_total_and_its_hour_bucket(self):
        self.record(100.0)
        self.record(112.5)
        (day,) = self.history()
        self.assertEqual(day, "2026-10-21")
        self.assertAlmostEqual(self.history()[day]["kwh"], 12.5)
        self.assertAlmostEqual(self.history()[day]["hours"]["21"], 12.5)
        # One write carries both counters, and the raw payload is the nested
        # shape the SDK transforms: kwh plus hours.<HH>.
        (write,) = self.db.writes
        self.assertEqual(write[:3], ("set", "history", "2026-10-21"))
        payload, merge = write[3], write[4]
        self.assertIsInstance(payload["kwh"], bridge.firestore.Increment)
        self.assertEqual(list(payload["hours"]), ["21"])
        self.assertIsInstance(payload["hours"]["21"], bridge.firestore.Increment)
        # The field-path merge list (not dotted keys with merge=True, not
        # update()) is what keeps sibling hours and every other field alive.
        self.assertEqual(merge, ["kwh", "hours.`21`", "updated_at"])

    def test_hours_stay_separate_and_kwh_carries_their_sum(self):
        self.record(100.0)
        self.record(112.5, datetime(2026, 10, 21, 21, 30, tzinfo=UTC))
        self.record(118.0, datetime(2026, 10, 21, 22, 10, tzinfo=UTC))
        (day,) = self.history()
        self.assertAlmostEqual(self.history()[day]["kwh"], 18.0)
        self.assertEqual(sorted(self.history()[day]["hours"]), ["21", "22"])
        self.assertAlmostEqual(self.history()[day]["hours"]["21"], 12.5)
        self.assertAlmostEqual(self.history()[day]["hours"]["22"], 5.5)

    def test_local_midnight_rolls_to_the_new_day_and_leaves_the_old_one_alone(self):
        self.record(100.0)
        self.record(103.0, datetime(2026, 10, 21, 23, 59, 50, tzinfo=UTC))
        self.record(105.0, datetime(2026, 10, 22, 0, 0, 10, tzinfo=UTC))
        self.assertEqual(sorted(self.history()), ["2026-10-21", "2026-10-22"])
        first = self.history()["2026-10-21"]
        self.assertAlmostEqual(first["kwh"], 3.0)
        self.assertEqual(list(first["hours"]), ["23"])
        self.assertAlmostEqual(first["hours"]["23"], 3.0)
        second = self.history()["2026-10-22"]
        self.assertAlmostEqual(second["kwh"], 2.0)
        self.assertEqual(list(second["hours"]), ["00"])
        self.assertAlmostEqual(second["hours"]["00"], 2.0)

    def test_failed_write_keeps_the_delta_for_a_later_retry_hour(self):
        self.record(100.0)
        self.db.fail_writes = True
        self.record(110.0, datetime(2026, 10, 21, 21, 55, tzinfo=UTC))
        # The baseline did not advance, so the whole delta is still owed.
        self.assertEqual(self.tracker.total_energy, 100.0)
        self.assertEqual(self.history(), {})
        self.db.fail_writes = False
        self.record(110.0, datetime(2026, 10, 21, 22, 5, tzinfo=UTC))
        (day,) = self.history()
        self.assertAlmostEqual(self.history()[day]["kwh"], 10.0)
        # The retry lands in the hour the bridge observed the energy in.
        self.assertEqual(list(self.history()[day]["hours"]), ["22"])
        self.assertAlmostEqual(self.history()[day]["hours"]["22"], 10.0)
        self.assertEqual(self.tracker.total_energy, 110.0)
        self.assertEqual(self.db.writes[-1][4], ["kwh", "hours.`22`", "updated_at"])

    def test_meter_reset_writes_neither_counter_and_rebaselines(self):
        self.record(100.0)
        self.record(90.0)
        self.assertEqual(self.history(), {})
        self.assertEqual(self.db.writes, [])
        self.assertEqual(self.tracker.total_energy, 90.0)
        self.record(95.0)
        (day,) = self.history()
        self.assertAlmostEqual(self.history()[day]["kwh"], 5.0)
        self.assertEqual(list(self.history()[day]["hours"]), ["21"])
        self.assertAlmostEqual(self.history()[day]["hours"]["21"], 5.0)

    def test_existing_document_without_hours_gains_a_bucket_and_keeps_its_fields(self):
        self.db.data["history"] = {
            "2026-10-21": {
                "kwh": 40.0,
                "updated_at": "2026-10-20T23:00:00Z",
                "source": "manual-backfill",
            }
        }
        self.record(100.0)
        self.record(110.0)
        doc = self.history()["2026-10-21"]
        self.assertAlmostEqual(doc["kwh"], 50.0)
        self.assertAlmostEqual(doc["hours"]["21"], 10.0)
        # Fields outside the mask survive the merge untouched.
        self.assertEqual(doc["source"], "manual-backfill")
        self.assertIs(doc["updated_at"], bridge.firestore.SERVER_TIMESTAMP)

    def test_unchanged_tick_performs_no_write(self):
        self.record(100.0)
        self.record(100.0)
        self.record(100.0)
        self.assertEqual(self.history(), {})
        self.assertEqual(self.db.writes, [])

    def test_unseeded_history_waits_for_the_stored_baseline(self):
        self.tracker.seeded = False
        self.record(100.0)
        self.record(110.0)
        self.assertEqual(self.history(), {})
        self.db.data["status"] = {"current": {"total_energy": 90.0, "state": 1}}
        self.assertTrue(self.tracker.seed())
        self.record(120.0)
        (day,) = self.history()
        # 120 - 90, i.e. everything since the last stored reading.
        self.assertAlmostEqual(self.history()[day]["kwh"], 30.0)
        self.assertAlmostEqual(self.history()[day]["hours"]["21"], 30.0)


class SeedTests(unittest.TestCase):
    def test_failed_seed_is_retryable(self):
        db = FakeDB()
        tracker = bridge.StatusTracker(db)
        db.fail_reads = True
        self.assertFalse(tracker.seed())
        self.assertFalse(tracker.seeded)
        db.fail_reads = False
        db.data["status"] = {"current": {"total_energy": 50.0, "state": 1}}
        self.assertTrue(tracker.seed())
        self.assertTrue(tracker.seeded)
        self.assertEqual(tracker.total_energy, 50.0)

    def test_retry_seed_keeps_live_state_and_only_restores_the_baseline(self):
        db = FakeDB()
        tracker = bridge.StatusTracker(db)
        tracker.has_state = True
        tracker.state = 3
        tracker.previous_state = 3
        tracker.charger_online = True
        db.data["status"] = {"current": {"total_energy": 42.0, "state": 1}}
        self.assertTrue(tracker.seed())
        self.assertEqual(tracker.previous_state, 3)
        self.assertEqual(tracker.state, 3)
        self.assertTrue(tracker.charger_online)
        self.assertEqual(tracker.total_energy, 42.0)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.tracker = bridge.StatusTracker(self.db)
        self.start = datetime(2026, 1, 5, 10, 0, tzinfo=UTC)

    def finalize(self, when, energy, elapsed, vehicle):
        self.tracker.last_charging_energy = energy
        self.tracker.last_charging_elapsed = elapsed
        with mock.patch.object(bridge, "_utcnow", return_value=when):
            self.tracker._finalize_session(
                {"vehicle": vehicle, "session_energy": energy, "elapsed": elapsed}
            )

    def sessions(self):
        return self.db.data.get("sessions", {})

    def test_fresh_session_uses_a_deterministic_id(self):
        self.finalize(self.start + timedelta(hours=1), 6000, 3600, vehicle=0)
        expected = str(int((self.start).timestamp()))
        self.assertEqual(list(self.sessions()), [expected])
        record = self.sessions()[expected]
        self.assertEqual(record["wh"], 6000.0)
        self.assertEqual(record["elapsed"], 3600)

    def test_pause_resume_merges_into_one_cumulative_record(self):
        first = self.start + timedelta(hours=1)
        self.finalize(first, 6000, 3600, vehicle=1)
        second = first + timedelta(hours=2)
        self.finalize(second, 12000, 7200, vehicle=1)
        self.assertEqual(len(self.sessions()), 1)
        (record,) = self.sessions().values()
        self.assertEqual(record["wh"], 12000.0)
        self.assertEqual(record["elapsed"], 7200)
        self.assertEqual(record["started_at"], self.start)
        self.assertEqual(record["ended_at"], second)

    def test_scheduled_stop_across_a_gap_merges_while_plugged_in(self):
        first = self.start + timedelta(hours=1)
        self.finalize(first, 6000, 3600, vehicle=1)
        # Overnight idle gap, still plugged in: counters are cumulative.
        self.finalize(first + timedelta(hours=10), 12000, 7200, vehicle=1)
        self.assertEqual(len(self.sessions()), 1)
        (record,) = self.sessions().values()
        self.assertEqual(record["wh"], 12000.0)

    def test_unplugged_second_session_is_recorded_separately(self):
        first = self.start + timedelta(hours=1)
        self.finalize(first, 6000, 3600, vehicle=0)
        second = first + timedelta(hours=3)
        self.finalize(second, 3000, 1800, vehicle=0)
        self.assertEqual(len(self.sessions()), 2)
        self.assertEqual(sorted(record["wh"] for record in self.sessions().values()), [3000.0, 6000.0])

    def test_no_negative_or_zero_wh_record(self):
        self.finalize(self.start + timedelta(hours=1), 0, 0, vehicle=0)
        self.assertEqual(self.sessions(), {})
        self.assertIsNone(self.tracker.pending_session)

    def test_failed_session_write_is_retried_next_tick(self):
        self.db.fail_writes = True
        self.finalize(self.start + timedelta(hours=1), 6000, 3600, vehicle=0)
        self.assertEqual(self.sessions(), {})
        self.assertIsNotNone(self.tracker.pending_session)
        self.db.fail_writes = False
        self.tracker._flush_pending_session()
        self.assertEqual(len(self.sessions()), 1)
        self.assertIsNone(self.tracker.pending_session)

    def test_malformed_prior_session_falls_back_to_a_fresh_record(self):
        self.db.data["sessions"] = {
            "old": {"started_at": "not-a-date", "ended_at": "not-a-date", "wh": "x"}
        }
        self.finalize(self.start + timedelta(hours=1), 6000, 3600, vehicle=1)
        fresh = str(int(self.start.timestamp()))
        self.assertEqual(set(self.sessions()), {"old", fresh})
        self.assertEqual(self.sessions()[fresh]["wh"], 6000.0)
        self.assertEqual(self.sessions()[fresh]["elapsed"], 3600)

    def test_unusable_prior_timestamps_fall_back_to_a_fresh_record(self):
        self.db.data["sessions"] = {
            "old": {
                "started_at": "2026-01-01 00:00:00",
                "ended_at": "2026-01-01 00:00:00",
                "wh": 1.0,
                "elapsed": 0,
            }
        }
        self.finalize(self.start + timedelta(hours=1), 6000, 3600, vehicle=1)
        fresh = str(int(self.start.timestamp()))
        self.assertEqual(set(self.sessions()), {"old", fresh})
        self.assertEqual(self.sessions()[fresh]["started_at"], self.start)
        self.assertEqual(self.sessions()[fresh]["wh"], 6000.0)
        self.assertEqual(self.sessions()[fresh]["elapsed"], 3600)


class IntervalTests(unittest.TestCase):
    """Charging intervals: one per contiguous charging block, energy per block.

    Every tick goes through ``observe`` with ``_utcnow`` patched, so an interval
    opens and closes on the state edge the way the status loop drives it.
    """

    def setUp(self):
        self.db = FakeDB()
        self.tracker = bridge.StatusTracker(self.db)
        self.now = datetime(2026, 1, 5, 10, 0, tzinfo=UTC)
        self.mono = 1000.0
        self.boot = 5000.0

    def tick(
        self,
        state,
        energy,
        elapsed,
        vehicle=1,
        step=timedelta(minutes=20),
        tracker=None,
        mono_step=None,
    ):
        """One status tick ``step`` later; returns that instant.

        Both clocks move with the step: ``_utcnow`` stamps the interval bounds
        and the interval clock (``CLOCK_BOOTTIME`` here) measures the gap the
        step allowance is derived from. ``mono_step`` advances the plain
        monotonic clock by something else, to reproduce a suspend — where
        monotonic stops but boottime keeps counting. A 20 min default keeps a
        2–3 kWh step at ~7 kW, i.e. a plausible charger.
        """
        self.now += step
        self.mono += (mono_step if mono_step is not None else step).total_seconds()
        self.boot += step.total_seconds()
        with mock.patch.object(bridge, "_utcnow", return_value=self.now), mock.patch.object(
            bridge.time, "monotonic", return_value=self.mono
        ), mock.patch.object(bridge.time, "clock_gettime", return_value=self.boot):
            (tracker or self.tracker).observe(
                {
                    "state": state,
                    "session_energy": energy,
                    "elapsed": elapsed,
                    "vehicle": vehicle,
                }
            )
        return self.now

    def sessions(self):
        return self.db.data.get("sessions", {})

    def test_an_uninterrupted_session_is_one_interval_equal_to_wh(self):
        started = self.tick(3, 0, 0)
        self.tick(3, 3000, 1200)
        self.tick(3, 6000, 2400)
        ended = self.tick(1, 6000, 3600)
        (record,) = self.sessions().values()
        # Aggregates are untouched: the charger's own counters and plug-in span.
        self.assertEqual(record["wh"], 6000.0)
        # elapsed is the last charging tick's timer, as before intervals existed.
        self.assertEqual(record["elapsed"], 2400)
        self.assertEqual(record["started_at"], ended - timedelta(seconds=2400))
        self.assertEqual(record["ended_at"], ended)
        (interval,) = record["intervals"]
        self.assertEqual(interval["started_at"], started)
        self.assertEqual(interval["ended_at"], ended)
        self.assertAlmostEqual(interval["wh"], record["wh"])

    def test_a_pause_and_resume_records_two_intervals_that_sum_to_wh(self):
        block1 = self.tick(3, 0, 0)
        self.tick(3, 2000, 1200)
        paused = self.tick(1, 2000, 2400)
        block2 = self.tick(3, 5000, 3600)
        self.tick(3, 7000, 4800)
        stopped = self.tick(1, 7000, 6000)

        self.assertEqual(len(self.sessions()), 1)
        (record,) = self.sessions().values()
        self.assertEqual(record["wh"], 7000.0)
        self.assertEqual(record["elapsed"], 4800)
        first, second = record["intervals"]
        # The pause closed the first interval; the resume opened a second one
        # and its energy is measured from where the counters stood at the pause.
        self.assertEqual((first["started_at"], first["ended_at"]), (block1, paused))
        self.assertEqual((second["started_at"], second["ended_at"]), (block2, stopped))
        self.assertAlmostEqual(first["wh"], 2000.0)
        self.assertAlmostEqual(second["wh"], 5000.0)
        self.assertAlmostEqual(first["wh"] + second["wh"], record["wh"])
        # The merged write keeps the pre-pause document id.
        self.assertEqual(list(self.sessions()), [str(int(record["started_at"].timestamp()))])

    def test_a_restart_mid_charge_keeps_one_interval_and_fabricates_nothing(self):
        self.db.data["status"] = {
            "current": {
                "state": 3,
                "session_energy": 4000,
                "elapsed": 2400,
                "total_energy": 20.0,
            }
        }
        # A new process: the tracker seeds from status/current and must not fold
        # the 4 kWh it never measured into the interval it opens now.
        tracker = bridge.StatusTracker(self.db)
        self.assertTrue(tracker.seed())
        self.tick(3, 4000, 2700, tracker=tracker)
        self.tick(3, 6000, 3900, tracker=tracker)
        self.tick(1, 6000, 5100, tracker=tracker)

        (record,) = self.sessions().values()
        self.assertEqual(record["wh"], 6000.0)
        (interval,) = record["intervals"]
        self.assertAlmostEqual(interval["wh"], 2000.0)
        for entry in record["intervals"]:
            self.assertGreater(entry["wh"], 0)
            self.assertGreater(entry["ended_at"], entry["started_at"])

    def test_a_counter_reset_is_dropped_instead_of_written_as_negative(self):
        self.tick(3, 1000, 600)
        self.tick(3, 3000, 1800)
        self.tick(3, 100, 3000)  # firmware reset mid-session
        self.tick(3, 900, 4200)
        self.tick(1, 900, 5400)
        (record,) = self.sessions().values()
        (interval,) = record["intervals"]
        self.assertGreater(interval["wh"], 0)
        # 3000-1000 growth, then nothing for the reset tick, then 800 from the
        # reset baseline. The first tick only supplies the baseline.
        self.assertAlmostEqual(interval["wh"], 2800.0)

    def test_a_seeded_session_attributes_its_first_step_without_a_gap(self):
        # The seeded baseline predates the tracker (the bridge was down), so the
        # first step has no measurable gap and must not be judged impossible:
        # dropping it would orphan that energy from the intervals as well.
        self.db.data["status"] = {
            "current": {"state": 3, "session_energy": 4000, "elapsed": 2400}
        }
        tracker = bridge.StatusTracker(self.db)
        self.assertTrue(tracker.seed())
        self.tick(3, 5000, 3600, tracker=tracker)
        self.tick(3, 6000, 4800, tracker=tracker)
        self.tick(1, 6000, 6000, tracker=tracker)
        (record,) = self.sessions().values()
        (interval,) = record["intervals"]
        # Both steps count: 1000 from the seeded baseline, then 1000 more.
        self.assertAlmostEqual(interval["wh"], 2000.0)

    def test_a_reset_step_is_logged_with_its_size_and_gap(self):
        with mock.patch.object(bridge, "log") as log:
            self.tick(3, 1000, 600)
            self.tick(3, 3000, 1800)
            self.tick(3, 100, 3000)  # reset: -2900 Wh
            self.tick(1, 100, 3000)
        messages = [call.args[0] for call in log.call_args_list]
        reset = [line for line in messages if "counter reset" in line]
        self.assertEqual(len(reset), 1, messages)
        self.assertIn("-2900 Wh", reset[0])
        self.assertIn("1200 s", reset[0])

    def test_a_suspend_sized_gap_keeps_a_legitimate_step(self):
        # Two hours of suspend mid-charge: `time.monotonic()` slept through it
        # (60 s of awake time), so a monotonic gap would call 6 kWh impossible.
        # The interval clock includes suspend, so the step is attributed.
        with mock.patch.object(bridge, "log") as log:
            started = self.tick(3, 0, 0)
            self.tick(
                3,
                6000,
                7200,
                step=timedelta(hours=2),
                mono_step=timedelta(seconds=60),
            )
            ended = self.tick(1, 6000, 7260)
        messages = [call.args[0] for call in log.call_args_list]
        self.assertEqual(
            [line for line in messages if "interval step dropped" in line], [], messages
        )
        self.assertEqual(
            [line for line in messages if "counter reset" in line], [], messages
        )
        # The presumption behind the test: the awake-time gap could not have
        # carried the step, so the boottime gap is what kept it.
        self.assertLess(bridge._interval_step_allowance(60), 6000)
        (record,) = self.sessions().values()
        (interval,) = record["intervals"]
        self.assertAlmostEqual(interval["wh"], 6000.0)
        self.assertEqual((interval["started_at"], interval["ended_at"]), (started, ended))

    def test_a_new_plug_in_counter_is_not_logged_as_a_reset(self):
        # The firmware clears session_energy at unplug, so the next plug-in's
        # first reading is a fresh baseline — not a counter that went backwards.
        with mock.patch.object(bridge, "log") as log:
            self.tick(3, 0, 0)
            self.tick(3, 4000, 1200)
            self.tick(1, 0, 0)  # unplug clears the counters
            self.tick(3, 0, 0)  # new plug-in: counter starts at zero
            self.tick(3, 3000, 1200)
            self.tick(1, 3000, 2400)
        messages = [call.args[0] for call in log.call_args_list]
        self.assertEqual(
            [line for line in messages if "counter reset" in line], [], messages
        )
        opened = [line for line in messages if "interval opened" in line]
        self.assertEqual(len(opened), 2, messages)
        # Nothing but the log changed: each plug-in still carries its own growth.
        stored = sum(
            entry["wh"]
            for record in self.sessions().values()
            for entry in record.get("intervals", [])
        )
        self.assertAlmostEqual(stored, 7000.0)

    def test_a_long_outage_step_is_kept(self):
        # 20 kWh across a 2 h stall is ~10 kW, well inside what the charger could
        # have delivered — the allowance is time-aware, not a fixed 20 kWh cap.
        started = self.tick(3, 0, 0)
        self.tick(3, 20000, 7200, step=timedelta(hours=2))
        ended = self.tick(1, 20000, 7200, step=timedelta(minutes=20))
        (record,) = self.sessions().values()
        (interval,) = record["intervals"]
        self.assertAlmostEqual(interval["wh"], 20000.0)
        self.assertEqual((interval["started_at"], interval["ended_at"]), (started, ended))

    def test_an_impossible_step_is_dropped_logged_and_the_next_tick_attributed(self):
        # 20 kWh in ten seconds would need 7 MW. It is dropped and logged, and the
        # following plausible tick is still attributed (the incident does not
        # poison the rest of the interval).
        with mock.patch.object(bridge, "log") as log:
            self.tick(3, 0, 0)
            self.tick(3, 20000, 10, step=timedelta(seconds=10))
            self.tick(3, 20100, 20, step=timedelta(seconds=10))
            self.tick(1, 20100, 30, step=timedelta(seconds=10))
        messages = [call.args[0] for call in log.call_args_list]
        dropped = [line for line in messages if "interval step dropped" in line]
        self.assertEqual(len(dropped), 1, messages)
        self.assertIn("20000 Wh", dropped[0])
        self.assertIn("10 s", dropped[0])
        (record,) = self.sessions().values()
        (interval,) = record["intervals"]
        # Only the plausible 100 Wh step landed; the aggregate keeps all 20.1 kWh,
        # which is exactly the divergence the web layer falls back on.
        self.assertAlmostEqual(interval["wh"], 100.0)
        self.assertEqual(record["wh"], 20100.0)
        self.assertEqual(self.tracker.interval_energy, 20100.0)

    def test_no_intervals_beside_a_skipped_zero_wh_session(self):
        self.tick(3, 0, 0)
        self.tick(1, 0, 0)
        self.assertEqual(self.sessions(), {})
        self.assertIsNone(self.tracker.open_interval)
        self.assertIsNone(self.tracker.pending_session)

    def test_a_seeded_session_without_measured_growth_has_no_intervals(self):
        # Restarted mid-charge, stopped before any tick showed growth: the
        # session is still written from the counters, but it carries no interval
        # — a record with no measured shape falls back to pro-rating.
        self.db.data["status"] = {
            "current": {"state": 3, "session_energy": 5000, "elapsed": 3000}
        }
        tracker = bridge.StatusTracker(self.db)
        self.assertTrue(tracker.seed())
        self.tick(3, 5000, 3300, tracker=tracker)
        self.tick(1, 5000, 3600, tracker=tracker)
        (record,) = self.sessions().values()
        self.assertEqual(record["wh"], 5000.0)
        self.assertNotIn("intervals", record)


class MergeIntervalTests(unittest.TestCase):
    """Interval lists on the merge path: concatenation, order, cap."""

    def record(self, start, intervals, wh, elapsed=3600):
        return {
            "started_at": start,
            "ended_at": start + timedelta(seconds=elapsed),
            "wh": wh,
            "elapsed": elapsed,
            "intervals": intervals,
        }

    def interval(self, start, minutes, wh):
        return {
            "started_at": start,
            "ended_at": start + timedelta(minutes=minutes),
            "wh": wh,
        }

    def test_a_merge_concatenates_intervals_in_start_order(self):
        start = datetime(2026, 1, 5, 10, 0, tzinfo=UTC)
        candidate = self.record(start, [self.interval(start, 30, 2000)], 2000)
        candidate["_id"] = "first"
        later = self.interval(start + timedelta(hours=2), 30, 1500)
        record = self.record(start + timedelta(hours=1), [later], 3500)
        merged = bridge._merge_session(candidate, record, vehicle_connected=True)
        self.assertEqual(merged["_id"], "first")
        self.assertEqual(merged["intervals"], [candidate["intervals"][0], later])
        self.assertAlmostEqual(
            sum(entry["wh"] for entry in merged["intervals"]), merged["wh"]
        )

    def test_unusable_stored_intervals_are_dropped_on_merge(self):
        start = datetime(2026, 1, 5, 10, 0, tzinfo=UTC)
        candidate = self.record(start, [], 2000)
        candidate["intervals"] = [
            {"started_at": "not-a-date", "ended_at": start, "wh": 100},
            {"started_at": start, "ended_at": start, "wh": 100},
            {"started_at": start, "ended_at": start + timedelta(minutes=10), "wh": 0},
            "junk",
        ]
        record = self.record(start + timedelta(hours=1), [self.interval(start, 30, 500)], 2500)
        with mock.patch.object(bridge, "log") as log:
            merged = bridge._merge_session(candidate, record, vehicle_connected=True)
        # Per entry, not per list: the good block survives, the corrupt ones go.
        self.assertEqual(merged["intervals"], record["intervals"])
        messages = [call.args[0] for call in log.call_args_list]
        self.assertEqual(len(messages), 1, messages)
        self.assertIn("4 unusable interval(s) dropped", messages[0])

    def test_the_cap_keeps_the_most_recent_intervals_and_folds_the_oldest(self):
        start = datetime(2026, 1, 5, 0, 0, tzinfo=UTC)
        stored = [
            self.interval(start + timedelta(minutes=10 * index), 5, 10.0)
            for index in range(bridge.MAX_SESSION_INTERVALS + 20)
        ]
        candidate = self.record(start, stored, 1200)
        candidate["_id"] = "first"
        newest = self.interval(start + timedelta(hours=30), 5, 7.0)
        record = self.record(start + timedelta(hours=29), [newest], 1207.0)
        merged = bridge._merge_session(candidate, record, vehicle_connected=True)
        kept = merged["intervals"]
        self.assertEqual(len(kept), bridge.MAX_SESSION_INTERVALS)
        self.assertEqual(kept[-1], newest)
        starts = [entry["started_at"] for entry in kept]
        self.assertEqual(starts, sorted(starts))
        # The oldest entries fold into one head: nothing is silently unpriced.
        head = len(stored) + 1 - bridge.MAX_SESSION_INTERVALS
        self.assertEqual(kept[0]["started_at"], stored[0]["started_at"])
        self.assertEqual(kept[0]["ended_at"], stored[head]["ended_at"])
        self.assertAlmostEqual(
            sum(entry["wh"] for entry in kept), 1200.0 + 7.0
        )
        # Aggregates still cover the whole session.
        self.assertEqual(merged["wh"], 1207.0)
        self.assertEqual(merged["started_at"], start)

    def test_a_cap_fold_is_logged_with_the_session_and_the_dropped_count(self):
        start = datetime(2026, 1, 5, 0, 0, tzinfo=UTC)
        stored = [
            self.interval(start + timedelta(minutes=10 * index), 5, 10.0)
            for index in range(bridge.MAX_SESSION_INTERVALS + 20)
        ]
        candidate = self.record(start, stored, 1200)
        candidate["_id"] = "1792345678"
        newest = self.interval(start + timedelta(hours=30), 5, 7.0)
        record = self.record(start + timedelta(hours=29), [newest], 1207.0)
        with mock.patch.object(bridge, "log") as log:
            bridge._merge_session(candidate, record, vehicle_connected=True)
        messages = [call.args[0] for call in log.call_args_list]
        self.assertEqual(len(messages), 1, messages)
        self.assertIn("session 1792345678", messages[0])
        # 121 entries, 100 kept: 22 oldest fold into the head.
        self.assertIn("22 oldest intervals folded", messages[0])
        self.assertIn("220 Wh", messages[0])

    def test_one_hundred_intervals_are_kept_as_they_are(self):
        start = datetime(2026, 1, 5, 0, 0, tzinfo=UTC)
        stored = [
            self.interval(start + timedelta(minutes=10 * index), 5, 10.0)
            for index in range(bridge.MAX_SESSION_INTERVALS)
        ]
        self.assertEqual(bridge._merge_intervals(stored), stored)


class FcmTests(unittest.TestCase):
    def test_transition_edges(self):
        self.assertIsNone(bridge._transition_body(False, False, True))
        self.assertEqual(bridge._transition_body(True, False, True), "Charging started")
        self.assertEqual(bridge._transition_body(True, True, False), "Charging stopped")
        self.assertIsNone(bridge._transition_body(True, True, True))

    def test_notify_prunes_dead_tokens_and_keeps_good_ones(self):
        db = FakeDB(
            {
                "fcmTokens": {
                    "good": {"token": "good"},
                    "dead": {},
                    "invalid": {},
                }
            }
        )

        def fake_send(message):
            if message.token == "dead":
                raise bridge.messaging.UnregisteredError("gone")
            if message.token == "invalid":
                raise bridge.exceptions.InvalidArgumentError("bad")
            return "ok"

        with mock.patch.object(bridge.messaging, "send", side_effect=fake_send):
            bridge.notify(db, "Charging started")
        self.assertEqual(set(db.data["fcmTokens"]), {"good"})

    def test_notifier_sends_on_a_background_worker(self):
        db = FakeDB()
        notifier = bridge.Notifier(db)
        with mock.patch.object(bridge, "notify") as fake_notify:
            notifier.enqueue("Charging stopped")
            notifier.queue.join()
        fake_notify.assert_called_once_with(db, "Charging stopped")


class CommandTests(unittest.TestCase):
    def test_missing_created_at_sorts_first(self):
        cmds = [
            {"created_at": datetime(2026, 1, 1, 10, tzinfo=UTC)},
            {},
            {"created_at": datetime(2026, 1, 1, 9, tzinfo=UTC)},
        ]
        ordered = sorted(cmds, key=bridge._command_sort_key)
        self.assertIs(ordered[0], cmds[1])
        self.assertEqual(ordered[1]["created_at"].hour, 9)

    def test_staleness(self):
        now = datetime(2026, 1, 1, 12, tzinfo=UTC)
        fresh = {"created_at": now - timedelta(seconds=60)}
        stale = {"created_at": now - timedelta(seconds=601)}
        self.assertFalse(bridge.command_is_stale(fresh, now))
        self.assertTrue(bridge.command_is_stale(stale, now))
        self.assertFalse(bridge.command_is_stale({}, now))

    def test_pending_commands_filter_and_sort_without_order_by(self):
        db = FakeDB(
            {
                "commands": {
                    "later": {
                        "status": "pending",
                        "created_at": datetime(2026, 1, 1, 10, tzinfo=UTC),
                    },
                    "no-ts": {"status": "pending"},
                    "done": {
                        "status": "acked",
                        "created_at": datetime(2026, 1, 1, 8, tzinfo=UTC),
                    },
                }
            }
        )
        docs = bridge.pending_commands(db)
        self.assertEqual([doc.id for doc in docs], ["no-ts", "later"])


class _StopAfter:
    """Stand-in for the module stop event: ends the loop after N polls."""

    def __init__(self, polls, on_wait=None):
        self._polls = polls
        self._waited = 0
        self._on_wait = on_wait

    def is_set(self):
        return self._waited >= self._polls

    def wait(self, interval):
        self._waited += 1
        if self._on_wait is not None:
            self._on_wait()
        return True


class CommandLoopTests(unittest.TestCase):
    def run_loop(self, db, polls, on_wait=None):
        session = FakeSession()
        transport = bridge.ChargerTransport(session)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.command_loop(db, "http://charger", None, transport, 0)
        return session

    def test_stale_command_is_failed_without_contacting_the_charger(self):
        db = FakeDB(
            {
                "commands": {
                    "old": {
                        "status": "pending",
                        "type": "pause",
                        "created_at": datetime.now(UTC)
                        - timedelta(seconds=bridge.COMMAND_MAX_AGE + 60),
                    }
                }
            }
        )
        session = self.run_loop(db, polls=1)
        self.assertEqual(session.calls, [])
        doc = db.data["commands"]["old"]
        self.assertEqual(doc["status"], "failed")
        self.assertIn("stale command", doc["error"])

    def test_failed_ack_write_sends_the_command_only_once(self):
        db = FakeDB(
            {
                "commands": {
                    "cmd": {
                        "status": "pending",
                        "type": "pause",
                        "created_at": datetime.now(UTC),
                    }
                }
            }
        )
        db.fail_writes = True

        def recover():
            db.fail_writes = False

        session = self.run_loop(db, polls=2, on_wait=recover)
        self.assertEqual([call[0] for call in session.calls], ["post"])
        self.assertEqual(db.data["commands"]["cmd"]["status"], "acked")


class SyncScheduleTests(unittest.TestCase):
    def test_only_changed_events_are_posted_and_surplus_deleted(self):
        matching = {
            "id": 1,
            "state": "active",
            "time": "10:00:00",
            "days": ["monday"],
        }
        session = FakeSession(
            [
                FakeResponse(200, [matching, {"id": 9, "state": "active"}]),
                FakeResponse(200),
                FakeResponse(200),
            ]
        )
        events = [
            matching,
            {"id": 2, "state": "disabled", "time": "11:00:00", "days": ["monday"]},
        ]
        bridge.sync_schedule(session, "http://charger", None, events)
        methods = [call[0] for call in session.calls]
        self.assertEqual(methods, ["get", "post", "delete"])
        self.assertEqual(session.calls[1][2]["json"]["id"], 2)
        self.assertTrue(session.calls[2][1].endswith("/schedule/9"))


class SchedulePlanResponseTests(unittest.TestCase):
    def test_an_empty_firmware_plan_is_an_empty_object(self):
        session = FakeSession([FakeResponse(200, [])])
        self.assertEqual(bridge._schedule_plan(session, "http://charger", None), {})

    def test_a_non_empty_list_is_still_malformed(self):
        session = FakeSession([FakeResponse(200, [1])])
        with self.assertRaises(ValueError):
            bridge._schedule_plan(session, "http://charger", None)

    def test_an_object_is_returned_unchanged(self):
        plan = {"current_event": {"id": 1}}
        session = FakeSession([FakeResponse(200, plan)])
        self.assertEqual(bridge._schedule_plan(session, "http://charger", None), plan)

    def test_the_schedule_loop_publishes_the_empty_state_without_an_error(self):
        db = FakeDB()
        stop = _RecordingStop(1)
        transport = bridge.ChargerTransport(FakeSession([FakeResponse(200, [])]))
        logs = []
        with mock.patch.object(bridge, "_stop", stop), mock.patch.object(
            bridge, "log", logs.append
        ):
            bridge.schedule_loop(db, "http://charger", None, transport, 60, 300)
        schedule = db.data["status"]["current"].get("schedule")
        self.assertEqual(schedule, {"in_window": False, "active_rule_id": None})
        self.assertFalse([line for line in logs if "schedule plan failed" in line])

    def test_the_schedule_loop_logs_a_malformed_plan(self):
        db = FakeDB()
        stop = _RecordingStop(1)
        transport = bridge.ChargerTransport(FakeSession([FakeResponse(200, [1])]))
        logs = []
        with mock.patch.object(bridge, "_stop", stop), mock.patch.object(
            bridge, "log", logs.append
        ):
            bridge.schedule_loop(db, "http://charger", None, transport, 60, 300)
        self.assertTrue(
            any(
                "schedule plan failed (ValueError: schedule plan is not a JSON object)"
                in line
                for line in logs
            )
        )


class ChargerSessionTests(unittest.TestCase):
    def test_factory_bounds_the_pool(self):
        session = bridge.make_charger_session()
        self.addCleanup(session.close)
        for url in ("http://charger", "https://charger"):
            adapter = session.get_adapter(url)
            self.assertEqual(adapter._pool_connections, 1)
            self.assertEqual(adapter._pool_maxsize, 2)
            self.assertEqual(adapter.max_retries.total, 0)

    def test_transport_forwards_to_the_given_session(self):
        session = FakeSession([FakeResponse(200, {"ok": True}) for _ in range(3)])
        transport = bridge.ChargerTransport(session)
        for method in ("get", "post", "delete"):
            with self.subTest(method=method):
                url = f"http://charger/{method}"
                kwargs = {"timeout": 5, "auth": ("user", "pass")}
                resp = getattr(transport, method)(url, **kwargs)
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(session.calls[-1], (method, url, kwargs))
        self.assertEqual(len(session.calls), 3)


class _SlowSession:
    """Session that records whether two calls were ever in flight together."""

    def __init__(self, delay=0.02):
        self._delay = delay
        self._guard = threading.Lock()
        self._in_flight = 0
        self.overlapped = False
        self.calls = 0

    def get(self, url, **kwargs):
        with self._guard:
            self._in_flight += 1
            if self._in_flight > 1:
                self.overlapped = True
        time.sleep(self._delay)
        with self._guard:
            self._in_flight -= 1
            self.calls += 1
        return FakeResponse(200)


class ChargerTransportTests(unittest.TestCase):
    def test_serialises_concurrent_calls(self):
        session = _SlowSession()
        transport = bridge.ChargerTransport(session)
        threads = [
            threading.Thread(target=transport.get, args=("http://charger/status",))
            for _ in range(4)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertFalse(session.overlapped)
        self.assertEqual(session.calls, 4)

    def test_lock_is_released_when_the_call_raises(self):
        class _FailOnceSession:
            def __init__(self):
                self.calls = 0

            def get(self, url, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise requests.ConnectionError("charger unreachable")
                return FakeResponse(200)

        transport = bridge.ChargerTransport(_FailOnceSession())
        with self.assertRaises(requests.ConnectionError):
            transport.get("http://charger/status", timeout=5)

        finished = threading.Event()

        def follow_up():
            transport.get("http://charger/status", timeout=5)
            finished.set()

        # A later call from another thread only runs if the failed call released
        # the lock; the wait is bounded so a leak fails instead of hanging.
        worker = threading.Thread(target=follow_up, daemon=True)
        worker.start()
        worker.join(timeout=5)
        self.assertTrue(finished.is_set(), "lock was not released after the raise")


class _RecordingStop:
    """Stop event stand-in: records each wait and sets after `polls` waits."""

    def __init__(self, polls):
        self._polls = polls
        self.waits = []

    def is_set(self):
        return len(self.waits) >= self._polls

    def wait(self, seconds):
        self.waits.append(seconds)
        return self.is_set()


class LoopJitterTests(unittest.TestCase):
    def run_config(self, polls, interval, **kwargs):
        stop = _RecordingStop(polls)
        transport = bridge.ChargerTransport(FakeSession())
        with mock.patch.object(bridge, "_stop", stop):
            bridge.config_loop(FakeDB(), "http://charger", None, transport, interval, **kwargs)
        return stop.waits

    def run_schedule(self, polls, interval, **kwargs):
        stop = _RecordingStop(polls)
        transport = bridge.ChargerTransport(FakeSession([FakeResponse(200, {})]))
        with mock.patch.object(bridge, "_stop", stop):
            bridge.schedule_loop(
                FakeDB(), "http://charger", None, transport, interval, 300, **kwargs
            )
        return stop.waits

    def test_config_offsets_only_the_first_iteration(self):
        waits = self.run_config(2, 60, initial_delay=bridge.CONFIG_INITIAL_DELAY)
        self.assertEqual(waits, [bridge.CONFIG_INITIAL_DELAY, 60])

    def test_schedule_offsets_only_the_first_iteration(self):
        waits = self.run_schedule(2, 60, initial_delay=bridge.SCHEDULE_INITIAL_DELAY)
        self.assertEqual(waits, [bridge.SCHEDULE_INITIAL_DELAY, 60])

    def test_no_offset_without_an_initial_delay(self):
        self.assertEqual(self.run_config(1, 60), [60])
        self.assertEqual(self.run_schedule(1, 60), [60])

    def test_a_config_write_failure_in_http_mode_is_one_error_per_interval(self):
        # Flag-off parity: with no MQTT event to wait on, a failed write is the
        # loop's own error and the tail wait is still the interval.
        db = FakeDB()
        db.fail_writes = True
        stop = _RecordingStop(2)
        transport = bridge.ChargerTransport(
            FakeSession([FakeResponse(200, {"firmware": "master"})] * 2)
        )
        logs = []
        with mock.patch.object(bridge, "_stop", stop), mock.patch.object(
            bridge, "log", logs.append
        ):
            bridge.config_loop(db, "http://charger", None, transport, 60)
        self.assertEqual(stop.waits, [60, 60])
        self.assertEqual(len(logs), 2)
        self.assertTrue(all(line.startswith("config loop error") for line in logs))

    def test_pollers_start_at_different_offsets(self):
        self.assertTrue(0 < bridge.CONFIG_INITIAL_DELAY < bridge.SCHEDULE_INITIAL_DELAY)


class LoopWiringTests(unittest.TestCase):
    def test_run_gives_every_loop_the_same_transport(self):
        transport = bridge.ChargerTransport(FakeSession())
        calls = {}
        threads = []

        def spy(name):
            def record(*args, **kwargs):
                calls[name] = args

            return record

        class _ThreadSpy:
            def __init__(self, target, args, daemon=None):
                self.target = target
                self.args = args
                self.daemon = daemon
                threads.append(self)

            def start(self):
                self.target(*self.args)

        with mock.patch.object(bridge, "status_loop", spy("status")), mock.patch.object(
            bridge, "config_loop", spy("config")
        ), mock.patch.object(bridge, "schedule_loop", spy("schedule")), mock.patch.object(
            bridge, "command_loop", spy("command")
        ), mock.patch.object(
            bridge.threading, "Thread", _ThreadSpy
        ), mock.patch.object(
            bridge, "StatusTracker"
        ) as tracker, mock.patch.object(
            bridge, "Notifier"
        ):
            bridge.run(
                FakeDB(),
                "http://charger",
                None,
                (10, 60, 60, 300, 5),
                transport,
                bridge.WatchdogConfig(),
            )

        self.assertEqual(set(calls), {"status", "config", "schedule", "command"})
        for name, args in calls.items():
            self.assertIs(args[3], transport, f"{name} loop got another transport")
        self.assertEqual(len(threads), 3)
        for thread in threads:
            self.assertIs(thread.args[3], transport)
            self.assertTrue(thread.daemon)
        tracker.return_value.seed.assert_called_once_with()

    def test_run_leaves_shutdown_logging_to_main(self):
        """main() owns lifecycle logging: run() must not log a second stop line."""
        transport = bridge.ChargerTransport(FakeSession())
        with mock.patch.object(bridge, "status_loop"), mock.patch.object(
            bridge, "config_loop"
        ), mock.patch.object(bridge, "schedule_loop"), mock.patch.object(
            bridge, "command_loop"
        ), mock.patch.object(
            bridge.threading, "Thread"
        ), mock.patch.object(
            bridge, "StatusTracker"
        ), mock.patch.object(
            bridge, "Notifier"
        ), mock.patch.object(
            bridge, "log"
        ) as fake_log:
            bridge.run(
                FakeDB(),
                "http://charger",
                None,
                (10, 60, 60, 300, 5),
                transport,
                bridge.WatchdogConfig(),
            )

        self.assertEqual([call.args[0] for call in fake_log.call_args_list], [])


class WatchdogConfigTests(unittest.TestCase):
    """WATCHDOG_* parsing: defaults, overrides, and loud failures."""

    def parse(self, **env):
        with mock.patch.dict(bridge._FILE_ENV, {}, clear=True), mock.patch.dict(
            os.environ, env, clear=True
        ):
            return bridge.watchdog_config()

    def test_defaults(self):
        self.assertEqual(self.parse(), bridge.WatchdogConfig(True, 3, 600.0, 3, False))

    def test_overrides(self):
        config = self.parse(
            WATCHDOG_ENABLED="false",
            WATCHDOG_FAILURES="5",
            WATCHDOG_COOLDOWN_SEC="120",
            WATCHDOG_MAX_PER_HOUR="2",
            WATCHDOG_RESTART_WHILE_CHARGING="yes",
        )
        self.assertEqual(config, bridge.WatchdogConfig(False, 5, 120.0, 2, True))

    def test_bad_numbers_fail_loudly(self):
        for env in (
            {"WATCHDOG_FAILURES": "three"},
            {"WATCHDOG_FAILURES": "0"},
            {"WATCHDOG_COOLDOWN_SEC": "-1"},
            {"WATCHDOG_COOLDOWN_SEC": "soon"},
            {"WATCHDOG_MAX_PER_HOUR": "0"},
        ):
            with self.subTest(env=env), self.assertRaises(ValueError):
                self.parse(**env)

    def test_bad_boolean_fails_loudly(self):
        with self.assertRaises(ValueError):
            self.parse(WATCHDOG_ENABLED="maybe")
        with self.assertRaises(ValueError):
            self.parse(WATCHDOG_RESTART_WHILE_CHARGING="2")

    def test_non_finite_numbers_fail_loudly(self):
        for name in (
            "WATCHDOG_COOLDOWN_SEC",
            "WATCHDOG_FAILURES",
            "WATCHDOG_MAX_PER_HOUR",
        ):
            for value in ("nan", "inf", "-inf", "Infinity"):
                with self.subTest(variable=name, value=value), self.assertRaises(
                    ValueError
                ) as raised:
                    self.parse(**{name: value})
                self.assertIn(name, str(raised.exception))

    def test_finite_numbers_still_parse(self):
        config = self.parse(
            WATCHDOG_COOLDOWN_SEC="0.5",
            WATCHDOG_FAILURES="1",
            WATCHDOG_MAX_PER_HOUR="24",
        )
        self.assertEqual(config, bridge.WatchdogConfig(True, 1, 0.5, 24, False))
        # Zero is documented as "no cooldown" and must stay accepted.
        self.assertEqual(self.parse(WATCHDOG_COOLDOWN_SEC="0").cooldown, 0.0)


class WatchdogConfigExitTests(unittest.TestCase):
    """main()'s fail-loud wiring: a bad WATCHDOG_* value stops the bridge."""

    def exit_message(self, **env):
        with mock.patch.dict(bridge._FILE_ENV, {}, clear=True), mock.patch.dict(
            os.environ, env, clear=True
        ):
            with self.assertRaises(SystemExit) as raised:
                bridge.watchdog_config_or_exit()
        return str(raised.exception.code)

    def test_bad_values_exit_naming_the_variable(self):
        cases = {
            "WATCHDOG_ENABLED": "maybe",
            "WATCHDOG_FAILURES": "three",
            "WATCHDOG_COOLDOWN_SEC": "-1",
            "WATCHDOG_MAX_PER_HOUR": "0",
            "WATCHDOG_RESTART_WHILE_CHARGING": "2",
        }
        for name, value in cases.items():
            with self.subTest(variable=name):
                self.assertIn(name, self.exit_message(**{name: value}))

    def test_non_finite_values_exit_naming_the_variable(self):
        for name in (
            "WATCHDOG_COOLDOWN_SEC",
            "WATCHDOG_FAILURES",
            "WATCHDOG_MAX_PER_HOUR",
        ):
            for value in ("nan", "inf", "-inf"):
                with self.subTest(variable=name, value=value):
                    self.assertIn(name, self.exit_message(**{name: value}))

    def test_a_valid_config_is_returned(self):
        with mock.patch.dict(bridge._FILE_ENV, {}, clear=True), mock.patch.dict(
            os.environ, {"WATCHDOG_FAILURES": "5"}, clear=True
        ):
            self.assertEqual(
                bridge.watchdog_config_or_exit(),
                bridge.WatchdogConfig(True, 5, 600.0, 3, False),
            )


class RecoveryDecisionTests(unittest.TestCase):
    """The pure decision matrix: every guard and every action."""

    NOW = datetime(2026, 10, 20, 12, tzinfo=UTC)

    def decide(self, **overrides):
        inputs = {
            "now": self.NOW,
            "consecutive_failures": 3,
            "threshold": 3,
            "http_reachable": True,
            "controller_ok": True,
            "charging": False,
            "last_attempt_at": None,
            "attempts_in_window": (),
            "window": bridge.WATCHDOG_WINDOW,
            "max_attempts": 3,
            "cooldown": 600,
            "restart_while_charging": False,
            "enabled": True,
            "mqtt_ready": False,
        }
        inputs.update(overrides)
        return bridge.recovery_decision(**inputs)

    def test_below_threshold_does_nothing(self):
        self.assertEqual(self.decide(consecutive_failures=2)["action"], "none")

    def test_success_resets_the_streak(self):
        self.assertEqual(self.decide(consecutive_failures=0)["action"], "none")

    def test_healthy_controller_behind_failing_http_restarts_the_gateway(self):
        decision = self.decide()
        self.assertEqual(decision["action"], "restart_gateway")
        self.assertEqual(decision["transport"], "http")
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_RESTART)

    def test_unhealthy_controller_restarts_the_evse(self):
        decision = self.decide(controller_ok=False)
        self.assertEqual(decision["action"], "restart_evse")
        self.assertEqual(decision["transport"], "http")
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_RESTART_EVSE)

    def test_http_dead_without_mqtt_alerts_and_never_restarts(self):
        decision = self.decide(http_reachable=False)
        self.assertEqual(decision["action"], "alert")
        self.assertEqual(decision["transport"], None)
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_FAILED)

    def test_http_dead_with_mqtt_ready_restarts_the_gateway_over_mqtt(self):
        decision = self.decide(http_reachable=False, mqtt_ready=True)
        self.assertEqual(decision["action"], "restart_gateway")
        self.assertEqual(decision["transport"], "mqtt")
        self.assertIn("MQTT", decision["reason"])
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_RESTART)

    def test_http_dead_with_mqtt_ready_and_a_bad_controller_restarts_the_evse(self):
        decision = self.decide(
            http_reachable=False, mqtt_ready=True, controller_ok=False
        )
        self.assertEqual(decision["action"], "restart_evse")
        self.assertEqual(decision["transport"], "mqtt")
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_RESTART_EVSE)

    def test_mqtt_ready_does_not_change_the_http_transport(self):
        # A ready link is only the fallback: an answering HTTP server keeps the
        # restart on HTTP.
        decision = self.decide(mqtt_ready=True)
        self.assertEqual(decision["action"], "restart_gateway")
        self.assertEqual(decision["transport"], "http")

    def test_both_transports_down_alerts_only(self):
        decision = self.decide(http_reachable=False, mqtt_ready=False)
        self.assertEqual(decision["action"], "alert")
        self.assertEqual(decision["reason"], "charger unreachable over HTTP and MQTT")
        self.assertIsNone(decision["transport"])
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_FAILED)

    def test_cooldown_blocks_a_restart(self):
        decision = self.decide(last_attempt_at=self.NOW - timedelta(seconds=60))
        self.assertEqual(decision["action"], "none")
        self.assertIn("cooldown", decision["reason"])
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_BLOCKED_COOLDOWN)

    def test_cooldown_expires(self):
        decision = self.decide(last_attempt_at=self.NOW - timedelta(seconds=601))
        self.assertEqual(decision["action"], "restart_gateway")

    def test_hourly_cap_blocks_a_restart(self):
        attempts = (self.NOW - timedelta(minutes=5),) * 3
        decision = self.decide(
            attempts_in_window=attempts,
            last_attempt_at=self.NOW - timedelta(hours=1, seconds=1),
        )
        self.assertEqual(decision["action"], "none")
        self.assertIn("hourly cap", decision["reason"])
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_BLOCKED_CAP)

    def test_window_expiry_frees_the_cap(self):
        attempts = (self.NOW - timedelta(seconds=3601),) * 3
        decision = self.decide(
            attempts_in_window=attempts,
            last_attempt_at=self.NOW - timedelta(seconds=3601),
        )
        self.assertEqual(decision["action"], "restart_gateway")

    def test_charging_blocks_a_restart(self):
        decision = self.decide(charging=True)
        self.assertEqual(decision["action"], "none")
        self.assertIn("charging", decision["reason"])
        self.assertEqual(decision["alert"], bridge.WATCHDOG_ALERT_BLOCKED_CHARGING)
        self.assertIn("WATCHDOG_RESTART_WHILE_CHARGING", decision["alert"])
        self.assertNotEqual(decision["alert"], bridge.WATCHDOG_ALERT_FAILED)

    def test_charging_is_allowed_when_configured(self):
        decision = self.decide(charging=True, restart_while_charging=True)
        self.assertEqual(decision["action"], "restart_gateway")

    def test_guard_precedence_is_charging_then_cap_then_cooldown(self):
        """All guards satisfied at once: the earlier guard owns the push body."""
        cap_spent = (self.NOW - timedelta(minutes=5),) * 3
        recent_attempt = self.NOW - timedelta(seconds=60)
        cases = (
            (
                "charging",
                {
                    "charging": True,
                    "attempts_in_window": cap_spent,
                    "last_attempt_at": recent_attempt,
                },
                "charging in progress; WATCHDOG_RESTART_WHILE_CHARGING is off",
                bridge.WATCHDOG_ALERT_BLOCKED_CHARGING,
            ),
            (
                "cap",
                {
                    "charging": True,
                    "restart_while_charging": True,
                    "attempts_in_window": cap_spent,
                    "last_attempt_at": recent_attempt,
                },
                "hourly cap reached (3/3 attempts)",
                bridge.WATCHDOG_ALERT_BLOCKED_CAP,
            ),
            (
                "cooldown",
                {
                    "charging": True,
                    "restart_while_charging": True,
                    "last_attempt_at": recent_attempt,
                },
                "cooldown after the last attempt (600s)",
                bridge.WATCHDOG_ALERT_BLOCKED_COOLDOWN,
            ),
        )
        for guard, overrides, reason, alert in cases:
            with self.subTest(guard=guard):
                decision = self.decide(**overrides)
                self.assertEqual(decision["action"], "none")
                self.assertEqual(decision["reason"], reason)
                self.assertEqual(decision["alert"], alert)

    def test_disabled_watchdog_does_nothing(self):
        decision = self.decide(enabled=False, http_reachable=False)
        self.assertEqual(decision["action"], "none")
        self.assertIn("disabled", decision["reason"])

    def test_the_mqtt_path_is_below_threshold_too(self):
        decision = self.decide(
            http_reachable=False, mqtt_ready=True, consecutive_failures=2
        )
        self.assertEqual(decision["action"], "none")

    def test_guards_precede_the_mqtt_transport(self):
        """Every guard blocks the MQTT restart exactly as it blocks HTTP."""
        cap_spent = (self.NOW - timedelta(minutes=5),) * 3
        recent_attempt = self.NOW - timedelta(seconds=60)
        cases = (
            (
                "disabled",
                {"enabled": False},
                None,
                "disabled",
            ),
            (
                "charging",
                {"charging": True},
                bridge.WATCHDOG_ALERT_BLOCKED_CHARGING,
                "charging in progress",
            ),
            (
                "cap",
                {"attempts_in_window": cap_spent},
                bridge.WATCHDOG_ALERT_BLOCKED_CAP,
                "hourly cap",
            ),
            (
                "cooldown",
                {"last_attempt_at": recent_attempt},
                bridge.WATCHDOG_ALERT_BLOCKED_COOLDOWN,
                "cooldown",
            ),
        )
        for guard, overrides, alert, reason in cases:
            with self.subTest(guard=guard):
                decision = self.decide(
                    http_reachable=False, mqtt_ready=True, **overrides
                )
                self.assertEqual(decision["action"], "none")
                self.assertIsNone(decision["transport"])
                self.assertIn(reason, decision["reason"])
                self.assertEqual(decision["alert"], alert)

    def test_attempts_within_keeps_the_closed_window(self):
        edge = self.NOW - timedelta(seconds=bridge.WATCHDOG_WINDOW)
        stale = edge - timedelta(seconds=1)
        recent = bridge.attempts_within(self.NOW, (edge, stale), 3600)
        self.assertEqual(recent, [edge])


class ControllerHealthTests(unittest.TestCase):
    """Gateway-versus-controller classification from v5.1.5 status fields."""

    def status(self, **overrides):
        payload = {
            "state": 1,
            "comm_sent": 10,
            "comm_success": 10,
            "rapi_connected": True,
            "evse_connected": True,
        }
        payload.update(overrides)
        return payload

    def test_advancing_counters_are_healthy(self):
        self.assertTrue(
            bridge.controller_healthy(
                self.status(), self.status(comm_sent=12, comm_success=12)
            )
        )

    def test_frozen_success_with_rising_sent_is_controller_side(self):
        self.assertFalse(
            bridge.controller_healthy(
                self.status(), self.status(comm_sent=14, comm_success=10)
            )
        )

    def test_disconnected_flags_are_controller_side(self):
        for flag in ("rapi_connected", "evse_connected"):
            with self.subTest(flag=flag):
                self.assertFalse(
                    bridge.controller_healthy(None, self.status(**{flag: False}))
                )
                self.assertFalse(
                    bridge.controller_healthy(None, self.status(**{flag: 0}))
                )

    def test_missing_fields_are_assumed_healthy(self):
        self.assertTrue(bridge.controller_healthy(None, {"state": 1}))
        self.assertTrue(bridge.controller_healthy({}, {"state": 1}))

    def test_one_sample_uses_flags_only(self):
        self.assertTrue(bridge.controller_healthy(None, self.status(comm_sent=99)))

    def test_counter_reset_is_not_controller_side(self):
        self.assertTrue(
            bridge.controller_healthy(
                self.status(comm_sent=10, comm_success=9),
                self.status(comm_sent=1, comm_success=1),
            )
        )

    def test_non_dict_latest_is_healthy(self):
        self.assertTrue(bridge.controller_healthy(self.status(), None))


def _status_payload(**overrides):
    """A healthy /status reply for the watchdog integration tests."""
    payload = {
        "state": 1,
        "amp": 0,
        "voltage": 240,
        "power": 0,
        "session_energy": 0,
        "total_energy": 100,
        "elapsed": 0,
        "vehicle": 0,
        "comm_sent": 10,
        "comm_success": 10,
        "rapi_connected": True,
        "evse_connected": True,
    }
    payload.update(overrides)
    return payload


class _Clock:
    """Controllable UTC clock: the watchdog reads time through it."""

    def __init__(self, start):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)


class _WatchdogSession:
    """Scripted session: each call pops a response or raises a queued error."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def _call(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        item = (
            self.script.pop(0)
            if self.script
            else FakeResponse(200, _status_payload())
        )
        if isinstance(item, Exception):
            raise item
        return item

    def get(self, url, **kwargs):
        return self._call("get", url, **kwargs)

    def post(self, url, **kwargs):
        return self._call("post", url, **kwargs)


class _RecordingNotifier:
    def __init__(self):
        self.bodies = []

    def enqueue(self, body):
        self.bodies.append(body)


class _FakeMqtt:
    """The MQTT source surface the watchdog reads, with a publish recorder."""

    def __init__(self, connected=True, subscribed=True, announced=None):
        self.connected = connected
        self.subscribed = subscribed
        self.announced = announced
        self.last_lwt_at = None
        self.subscription = "chelevse/#"
        self.published = []
        self.refuse = None

    @property
    def mqtt_ready(self):
        return self.connected and self.subscribed

    def publish(self, topic, payload, qos=0):
        if self.refuse is not None:
            raise bridge.MqttPublishError(self.refuse)
        self.published.append((topic, payload, qos))


class WatchdogLoopTests(unittest.TestCase):
    """status_loop + Watchdog against a scripted transport and clock."""

    START = datetime(2026, 10, 20, 12, tzinfo=UTC)
    OUTAGE = requests.ConnectionError("charger unreachable")

    def run_loop(self, script, polls, config=None, data=None, step=10, mqtt=None):
        db = FakeDB(data)
        clock = _Clock(self.START)
        session = _WatchdogSession(script)
        transport = bridge.ChargerTransport(session)
        notifier = _RecordingNotifier()
        tracker = bridge.StatusTracker(db)
        watchdog = bridge.Watchdog(
            db,
            "http://charger",
            None,
            transport,
            notifier,
            config or bridge.WatchdogConfig(),
            clock,
            mqtt,
        )
        stop = _StopAfter(polls, on_wait=lambda: clock.advance(step))
        with mock.patch.object(bridge, "_stop", stop), mock.patch.object(
            bridge, "_utcnow", clock
        ):
            bridge.status_loop(
                db,
                "http://charger",
                None,
                transport,
                10,
                tracker,
                notifier,
                watchdog,
            )
        return db, session, notifier, watchdog

    @staticmethod
    def posts(session):
        return [call for call in session.calls if call[0] == "post"]

    def health(self, db):
        return db.data["status"]["health"]

    def test_three_failures_restart_the_gateway_once(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
            ],
            polls=3,
        )
        posts = self.posts(session)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][1], "http://charger/restart")
        self.assertEqual(posts[0][2]["json"], {"device": "gateway"})
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
            ],
        )
        health = self.health(db)
        self.assertEqual(health["state"], "unhealthy")
        self.assertEqual(health["reason"], "HTTP answered but the gateway was failing")
        self.assertTrue(health["http_ok"])
        self.assertTrue(health["controller_ok"])
        self.assertEqual(health["last_attempt_at"], self.START + timedelta(seconds=20))
        self.assertEqual(health["attempts_last_hour"], 1)
        self.assertEqual(health["last_action"], "restart_gateway")
        self.assertEqual(health["last_result"], "HTTP 200")
        self.assertEqual(watchdog.failures, 3)

    def test_a_further_failure_inside_the_cooldown_does_not_restart(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=4,
        )
        self.assertEqual(len(self.posts(session)), 1)
        self.assertEqual(
            notifier.bodies,
            ["Charger offline", bridge.WATCHDOG_ALERT_RESTART],
        )
        self.assertEqual(watchdog.failures, 4)
        self.assertEqual(watchdog.last_attempt_at, self.START + timedelta(seconds=20))

    def test_a_success_clears_the_streak_and_alerts_recovery(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                FakeResponse(200, _status_payload()),
            ],
            polls=4,
        )
        self.assertEqual(len(self.posts(session)), 1)
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
                bridge.WATCHDOG_ALERT_RECOVERED,
            ],
        )
        self.assertEqual(watchdog.failures, 0)
        self.assertEqual(watchdog.state, "healthy")
        health = self.health(db)
        self.assertEqual(health["state"], "healthy")
        self.assertEqual(health["reason"], "status polls succeeding")
        self.assertEqual(health["attempts_last_hour"], 1)

    @staticmethod
    def health_writes(db):
        return [write for write in db.writes if write[:3] == ("set", "status", "health")]

    def test_a_healthy_charger_writes_health_once(self):
        db, session, notifier, watchdog = self.run_loop([], polls=4)
        self.assertEqual(watchdog.state, "healthy")
        writes = self.health_writes(db)
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][3]["state"], "healthy")

    def test_recovery_writes_health_once_then_only_ticks(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                FakeResponse(200, _status_payload()),
            ],
            polls=5,
        )
        self.assertEqual(watchdog.state, "healthy")
        self.assertEqual(
            [write[3]["state"] for write in self.health_writes(db)],
            ["unhealthy", "healthy"],
        )

    def test_a_frozen_controller_restarts_the_evse(self):
        db, session, notifier, _ = self.run_loop(
            [
                FakeResponse(200, _status_payload()),
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload(comm_sent=14, comm_success=10)),
                FakeResponse(200),
            ],
            polls=4,
        )
        posts = self.posts(session)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][2]["json"], {"device": "evse"})
        self.assertEqual(notifier.bodies[-1], bridge.WATCHDOG_ALERT_RESTART_EVSE)
        health = self.health(db)
        self.assertFalse(health["controller_ok"])
        self.assertEqual(health["last_action"], "restart_evse")

    def test_http_dead_alerts_without_touching_the_gateway(self):
        db, session, notifier, watchdog = self.run_loop(
            [self.OUTAGE, self.OUTAGE, self.OUTAGE, self.OUTAGE], polls=3
        )
        self.assertEqual(self.posts(session), [])
        self.assertEqual(
            notifier.bodies,
            ["Charger offline", bridge.WATCHDOG_ALERT_FAILED],
        )
        health = self.health(db)
        self.assertEqual(health["state"], "unhealthy")
        self.assertFalse(health["http_ok"])
        self.assertEqual(health["last_action"], "alert")
        self.assertIsNone(health["last_attempt_at"])
        self.assertEqual(health["attempts_last_hour"], 0)
        self.assertEqual(watchdog.failures, 3)

    def test_spent_attempts_alert_recovery_failed(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=4,
            config=bridge.WatchdogConfig(cooldown=0, max_per_hour=1),
        )
        self.assertEqual(len(self.posts(session)), 1)
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
                bridge.WATCHDOG_ALERT_FAILED,
            ],
        )
        health = self.health(db)
        self.assertEqual(health["last_action"], "restart_gateway")
        self.assertEqual(health["last_result"], "HTTP 200")

    def test_one_recovery_failed_push_per_episode(self):
        db, session, notifier, _ = self.run_loop(
            [
                FakeResponse(200, _status_payload()),
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=6,
            config=bridge.WatchdogConfig(max_per_hour=1),
        )
        self.assertEqual(len(self.posts(session)), 1)
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
                bridge.WATCHDOG_ALERT_FAILED,
            ],
        )

    def test_charging_blocks_the_restart_until_configured(self):
        data = {"status": {"current": {"state": 3}}}
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=3,
            data=data,
        )
        self.assertEqual(self.posts(session), [])
        health = self.health(db)
        self.assertEqual(
            health["reason"],
            "charging in progress; WATCHDOG_RESTART_WHILE_CHARGING is off",
        )
        self.assertEqual(health["state"], "unhealthy")
        self.assertTrue(health["http_ok"])
        # Nothing was attempted, so the guard's reason is the last result and no
        # attempt fields are claimed.
        self.assertEqual(health["last_result"], health["reason"])
        self.assertIsNone(health["last_attempt_at"])
        self.assertEqual(health["attempts_last_hour"], 0)
        # A guard block is not a failed recovery: no "power cycle" advice.
        self.assertEqual(
            notifier.bodies, ["Charger offline", bridge.WATCHDOG_ALERT_BLOCKED_CHARGING]
        )
        self.assertNotIn(bridge.WATCHDOG_ALERT_FAILED, notifier.bodies)
        self.assertEqual(health["last_action"], "none")
        self.assertIn("WATCHDOG_RESTART_WHILE_CHARGING", notifier.bodies[-1])
        self.assertEqual(watchdog.failures, 3)

        db, session, _, _ = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
            ],
            polls=3,
            data={"status": {"current": {"state": 3}}},
            config=bridge.WatchdogConfig(restart_while_charging=True),
        )
        self.assertEqual(len(self.posts(session)), 1)

    def test_cap_blocked_entry_names_the_cap(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                FakeResponse(200, _status_payload()),
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                FakeResponse(200, _status_payload()),
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=8,
            config=bridge.WatchdogConfig(cooldown=0, max_per_hour=1),
        )
        self.assertEqual(len(self.posts(session)), 1)
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
                bridge.WATCHDOG_ALERT_RECOVERED,
                "Charger offline",
                bridge.WATCHDOG_ALERT_BLOCKED_CAP,
            ],
        )
        self.assertNotIn(bridge.WATCHDOG_ALERT_FAILED, notifier.bodies)
        health = self.health(db)
        self.assertIn("hourly cap", health["reason"])
        # The attempt that spent the allowance stays on record.
        self.assertEqual(health["last_action"], "restart_gateway")
        self.assertEqual(health["last_result"], "HTTP 200")

    def test_cooldown_blocked_entry_names_the_cooldown(self):
        db, session, notifier, _ = self.run_loop(
            [
                FakeResponse(200, _status_payload()),
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                FakeResponse(200, _status_payload()),
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=8,
        )
        self.assertEqual(len(self.posts(session)), 1)
        self.assertEqual(notifier.bodies[-1], bridge.WATCHDOG_ALERT_BLOCKED_COOLDOWN)
        self.assertNotIn(bridge.WATCHDOG_ALERT_FAILED, notifier.bodies)
        health = self.health(db)
        self.assertIn("cooldown", health["reason"])
        self.assertEqual(health["last_action"], "restart_gateway")

    def test_restart_then_dark_gateway_pushes_one_recovery_failed(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
            ],
            polls=8,
        )
        # Restart accepted, then the gateway never answers again: five more
        # failures must surface exactly one "recovery failed" push.
        self.assertEqual(len(self.posts(session)), 1)
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
                bridge.WATCHDOG_ALERT_FAILED,
            ],
        )
        self.assertEqual(watchdog.failures, 8)
        health = self.health(db)
        self.assertEqual(health["state"], "unhealthy")
        self.assertFalse(health["http_ok"])
        self.assertEqual(health["last_attempt_at"], self.START + timedelta(seconds=20))
        self.assertEqual(health["attempts_last_hour"], 1)
        self.assertEqual(health["last_action"], "restart_gateway")
        self.assertEqual(health["last_result"], "HTTP 200")

    def test_health_keeps_the_attempt_after_recovery(self):
        db, session, notifier, _ = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(200),
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=5,
        )
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
                bridge.WATCHDOG_ALERT_FAILED,
                bridge.WATCHDOG_ALERT_RECOVERED,
            ],
        )
        health = self.health(db)
        self.assertEqual(health["state"], "healthy")
        self.assertEqual(health["last_action"], "restart_gateway")
        self.assertEqual(health["last_result"], "HTTP 200")
        self.assertEqual(health["attempts_last_hour"], 1)

    def test_a_failed_restart_post_is_recorded_and_counts(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
                FakeResponse(500),
            ],
            polls=3,
        )
        self.assertEqual(len(self.posts(session)), 1)
        self.assertEqual(
            notifier.bodies,
            ["Charger offline", bridge.WATCHDOG_ALERT_RESTART],
        )
        health = self.health(db)
        self.assertTrue(health["last_result"].startswith("failed ("))
        self.assertEqual(health["last_action"], "restart_gateway")
        self.assertEqual(health["attempts_last_hour"], 1)
        # The failed POST still spends the cooldown, so no immediate retry.
        self.assertEqual(watchdog.last_attempt_at, self.START + timedelta(seconds=20))

    def test_disabled_watchdog_only_flags_the_outage(self):
        db, session, notifier, watchdog = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=4,
            config=bridge.WatchdogConfig(enabled=False),
        )
        self.assertEqual(self.posts(session), [])
        # The outage edge pushes once; the restore sends no recovery push even
        # though the disabled watchdog never observed the failure.
        self.assertEqual(notifier.bodies, ["Charger offline"])
        self.assertEqual(watchdog.failures, 0)
        # Restore is status-loop business, not watchdog business: the document
        # returns online while status/health stays absent.
        self.assertTrue(db.data["status"]["current"]["charger_online"])
        self.assertNotIn("health", db.data["status"])

    # -- MQTT restart fallback (issue #45) --------------------------------

    def test_http_dead_with_mqtt_ready_restarts_once_over_mqtt(self):
        mqtt = _FakeMqtt()
        db, session, notifier, watchdog = self.run_loop(
            [self.OUTAGE, self.OUTAGE, self.OUTAGE, self.OUTAGE],
            polls=3,
            mqtt=mqtt,
        )
        # No HTTP restart at all: the MQTT publish is the only attempt.
        self.assertEqual(self.posts(session), [])
        self.assertEqual(
            mqtt.published, [("restart", '{"device": "gateway"}', 0)]
        )
        self.assertEqual(
            notifier.bodies,
            ["Charger offline", bridge.WATCHDOG_ALERT_RESTART],
        )
        health = self.health(db)
        self.assertEqual(health["state"], "unhealthy")
        self.assertEqual(health["last_action"], "restart_gateway")
        self.assertEqual(health["last_transport"], "mqtt")
        self.assertEqual(health["last_result"], "MQTT published")
        self.assertEqual(health["last_attempt_at"], self.START + timedelta(seconds=20))
        self.assertEqual(health["attempts_last_hour"], 1)
        self.assertEqual(watchdog.last_transport, "mqtt")

    def test_an_lwt_disconnect_makes_the_outage_alert_only(self):
        mqtt = _FakeMqtt(announced=False)
        db, session, notifier, watchdog = self.run_loop(
            [self.OUTAGE, self.OUTAGE, self.OUTAGE, self.OUTAGE],
            polls=3,
            mqtt=mqtt,
        )
        self.assertEqual(mqtt.published, [])
        self.assertEqual(self.posts(session), [])
        self.assertEqual(
            notifier.bodies,
            ["Charger offline", bridge.WATCHDOG_ALERT_FAILED],
        )
        health = self.health(db)
        self.assertEqual(health["last_action"], "alert")
        self.assertIsNone(health["last_transport"])
        self.assertIsNone(health["last_attempt_at"])
        self.assertEqual(health["attempts_last_hour"], 0)
        self.assertFalse(health["mqtt_connected"])
        self.assertFalse(health["mqtt_announced"])

    def test_an_announced_connected_gateway_keeps_the_mqtt_path(self):
        mqtt = _FakeMqtt(announced=True)
        db, session, notifier, _ = self.run_loop(
            [self.OUTAGE, self.OUTAGE, self.OUTAGE, self.OUTAGE],
            polls=3,
            mqtt=mqtt,
        )
        self.assertEqual(
            mqtt.published, [("restart", '{"device": "gateway"}', 0)]
        )
        self.assertEqual(notifier.bodies[-1], bridge.WATCHDOG_ALERT_RESTART)

    def test_the_charging_guard_blocks_an_mqtt_restart(self):
        db, session, notifier, _ = self.run_loop(
            [self.OUTAGE, self.OUTAGE, self.OUTAGE, self.OUTAGE],
            polls=3,
            data={"status": {"current": {"state": 3}}},
            mqtt=_FakeMqtt(),
        )
        self.assertEqual(self.posts(session), [])
        health = self.health(db)
        self.assertIn("charging in progress", health["reason"])
        self.assertIsNone(health["last_transport"])
        self.assertEqual(
            notifier.bodies, ["Charger offline", bridge.WATCHDOG_ALERT_BLOCKED_CHARGING]
        )

    def test_the_hourly_cap_bounds_mqtt_restarts(self):
        mqtt = _FakeMqtt()
        db, session, notifier, _ = self.run_loop(
            [self.OUTAGE] * 10,
            polls=4,
            config=bridge.WatchdogConfig(cooldown=0, max_per_hour=1),
            mqtt=mqtt,
        )
        self.assertEqual(
            mqtt.published, [("restart", '{"device": "gateway"}', 0)]
        )
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
                bridge.WATCHDOG_ALERT_FAILED,
            ],
        )
        health = self.health(db)
        self.assertEqual(health["attempts_last_hour"], 1)
        self.assertIn("hourly cap", health["reason"])

    def test_a_controller_fault_restarts_the_evse_over_mqtt(self):
        mqtt = _FakeMqtt()
        db, session, notifier, _ = self.run_loop(
            [
                FakeResponse(200, _status_payload(rapi_connected=False)),
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
            ],
            polls=4,
            mqtt=mqtt,
        )
        self.assertEqual(self.posts(session), [])
        self.assertEqual(mqtt.published, [("restart", '{"device": "evse"}', 0)])
        self.assertEqual(notifier.bodies[-1], bridge.WATCHDOG_ALERT_RESTART_EVSE)
        health = self.health(db)
        self.assertFalse(health["controller_ok"])
        self.assertEqual(health["last_action"], "restart_evse")
        self.assertEqual(health["last_transport"], "mqtt")

    def test_a_refused_publish_is_recorded_and_counts(self):
        mqtt = _FakeMqtt()
        mqtt.refuse = "publish restart rejected (rc 4)"
        db, session, notifier, watchdog = self.run_loop(
            [self.OUTAGE, self.OUTAGE, self.OUTAGE, self.OUTAGE],
            polls=3,
            mqtt=mqtt,
        )
        self.assertEqual(self.posts(session), [])
        health = self.health(db)
        self.assertTrue(health["last_result"].startswith("failed ("))
        self.assertEqual(health["last_transport"], "mqtt")
        self.assertEqual(health["attempts_last_hour"], 1)
        # The failed publish still spends the cooldown.
        self.assertEqual(watchdog.last_attempt_at, self.START + timedelta(seconds=20))

    def test_recovery_after_an_mqtt_restart_keeps_the_transport_on_record(self):
        mqtt = _FakeMqtt()
        db, session, notifier, _ = self.run_loop(
            [
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                self.OUTAGE,
                FakeResponse(200, _status_payload()),
            ],
            polls=4,
            mqtt=mqtt,
        )
        # The restart is proved by the next successful probe (the reconcile
        # poll), not by the publish.
        self.assertEqual(
            notifier.bodies,
            [
                "Charger offline",
                bridge.WATCHDOG_ALERT_RESTART,
                bridge.WATCHDOG_ALERT_RECOVERED,
            ],
        )
        health = self.health(db)
        self.assertEqual(health["state"], "healthy")
        self.assertEqual(health["last_action"], "restart_gateway")
        self.assertEqual(health["last_transport"], "mqtt")


if __name__ == "__main__":
    unittest.main()
