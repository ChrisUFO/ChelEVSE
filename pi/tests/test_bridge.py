"""Unit tests for pi/bridge.py (stdlib unittest; no charger or Firestore)."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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
                "amp": 16,
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
        self.assertEqual(fields["pilot"], 16)
        self.assertEqual(fields["vehicle"], 1)
        self.assertTrue(fields["charger_online"])

    def test_empty_payload_is_unknown_not_an_error(self):
        fields = bridge.parse_status({})
        self.assertIsNone(fields["state"])
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
    def setUp(self):
        self.db = FakeDB()
        self.tracker = bridge.StatusTracker(self.db)
        self.tracker.seeded = True

    def history(self):
        return self.db.data.get("history", {})

    def test_first_observation_is_only_a_baseline(self):
        self.tracker.record_history(100.0)
        self.assertEqual(self.history(), {})
        self.assertEqual(self.tracker.total_energy, 100.0)

    def test_delta_is_written_as_an_increment(self):
        self.tracker.record_history(100.0)
        self.tracker.record_history(112.5)
        (day,) = self.history()
        self.assertAlmostEqual(self.history()[day]["kwh"]._value, 12.5)

    def test_failed_write_keeps_the_baseline_for_retry(self):
        self.tracker.record_history(100.0)
        self.db.fail_writes = True
        self.tracker.record_history(110.0)
        self.assertEqual(self.tracker.total_energy, 100.0)
        self.db.fail_writes = False
        self.tracker.record_history(120.0)
        (day,) = self.history()
        self.assertAlmostEqual(self.history()[day]["kwh"]._value, 20.0)

    def test_meter_reset_rebaselines_without_a_negative_write(self):
        self.tracker.record_history(100.0)
        self.tracker.record_history(90.0)
        self.assertEqual(self.history(), {})
        self.tracker.record_history(95.0)
        (day,) = self.history()
        self.assertAlmostEqual(self.history()[day]["kwh"]._value, 5.0)

    def test_unseeded_history_waits_for_the_stored_baseline(self):
        self.tracker.seeded = False
        self.tracker.record_history(100.0)
        self.tracker.record_history(110.0)
        self.assertEqual(self.history(), {})
        self.db.data["status"] = {"current": {"total_energy": 90.0, "state": 1}}
        self.assertTrue(self.tracker.seed())
        self.tracker.record_history(120.0)
        (day,) = self.history()
        # 120 - 90, i.e. everything since the last stored reading.
        self.assertAlmostEqual(self.history()[day]["kwh"]._value, 30.0)


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
        with mock.patch.object(
            bridge.requests, "Session", return_value=session
        ), mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.command_loop(db, "http://charger", None, 0)
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


if __name__ == "__main__":
    unittest.main()
