"""The health rule table and the three-fact classifier (pi/health.py).

Pure projection tests: no charger, no Firestore. The ground-fault fixture is the
live one on this charger -- a cleared trip kept in the ring with `acked:true`,
`sticky:false` and a critical severity -- and the point of most of these cases is
that charging state, `/status.flags` and the firmware's `sticky` flag never
change what the advisory means.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import health  # noqa: E402
from parsing import parse_fault_counters, parse_notifications  # noqa: E402

# `flags` on this charger while charging: VFLAGS, which carries no `$GE` settings
# bits and must never corroborate `safety.*`.
CHARGING_FLAGS = 1280

CONFIG = {
    "ground_check": True,
    "relay_check": True,
    "diode_check": True,
    "vent_check": True,
    "temp_check": True,
    "over_temp_shutdown": 72,
}
RELAY_BLOCK = {
    "relay_life_pct": 80,
    "relay_cold_open_count": 0,
    "relay_transit_drift_warning": False,
    "relay_thermal_warning_level": 0,
    "relay_stuck_recovery_count": 0,
}
COUNTERS = {"nogndcount": 7, "gfcicount": 0, "stuckcount": 0}


_UNSET = object()


def facts(state=2, temps=(None, None, None), counters=None, config=_UNSET):
    """One live-observation snapshot, shaped like LiveObservations.snapshot()."""
    if config is _UNSET:
        config = CONFIG
    return {
        "state": state,
        "temps": temps,
        "counters": dict(COUNTERS if counters is None else counters),
        "config": dict(config) if config is not None else None,
        "flags": CHARGING_FLAGS,
    }


def advisory(advisory_id="fault.no_ground", **overrides):
    entry = {
        "id": advisory_id,
        "category": "fault",
        "severity": "critical",
        "firmware_sticky": False,
        "acked": False,
        "first_seen": 1794177153,
        "last_seen": 1794868200,
    }
    entry.update(overrides)
    return entry


def project(entries, live, first_observed=None, observed_at=1000, alerted=None):
    """The projection's content and its updated first-observed map."""
    return health.project(entries, live, first_observed or {}, observed_at, alerted)


def one(entries, live, **kwargs):
    """The first projected advisory, plus the content it came in."""
    content, _ = project(entries, live, **kwargs)
    return content["advisories"][0], content


class GroundFaultWhileChargingTests(unittest.TestCase):
    """The issue's fixture: a cleared ground fault while the car is charging."""

    def test_a_cleared_trip_keeps_its_critical_severity_but_is_historical(self):
        entry, content = one([advisory()], facts(state=3))

        self.assertEqual(entry["severity"], "critical")
        self.assertEqual(entry["classification"], "historical")
        self.assertFalse(entry["corroborated"])
        self.assertEqual(entry["counter_token"], 7)
        self.assertEqual(content["counters"], COUNTERS)

    def test_the_present_fault_state_corroborates_it(self):
        entry, _ = one([advisory()], facts(state=7))

        self.assertEqual(entry["classification"], "active")
        self.assertTrue(entry["corroborated"])
        self.assertEqual(entry["severity"], "critical")

    def test_an_acknowledged_advisory_wins_over_a_live_state(self):
        entry, _ = one([advisory(acked=True)], facts(state=7))

        self.assertEqual(entry["classification"], "acknowledged")
        # The liveness fact is still reported: the condition is present and the
        # owner muted it.
        self.assertTrue(entry["corroborated"])

    def test_each_fault_corroborates_only_its_own_controller_state(self):
        for advisory_id, state in health.FAULT_STATES.items():
            with self.subTest(advisory_id=advisory_id):
                entry, _ = one([advisory(advisory_id)], facts(state=state))
                self.assertEqual(entry["classification"], "active")
                other = 7 if state != 7 else 8
                entry, _ = one([advisory(advisory_id)], facts(state=other))
                self.assertEqual(entry["classification"], "historical")


class TokenTests(unittest.TestCase):
    def test_a_counter_move_changes_the_token(self):
        first, _ = one([advisory()], facts())
        moved, _ = one([advisory()], facts(counters={**COUNTERS, "nogndcount": 8}))

        self.assertEqual(first["counter_token"], 7)
        self.assertEqual(moved["counter_token"], 8)

    def test_a_counter_move_re_stamps_the_first_observation(self):
        entries, observed = project([advisory()], facts(), observed_at=1000)
        self.assertEqual(entries["advisories"][0]["first_observed"], 1000)

        same, observed = project(
            [advisory()], facts(), first_observed=observed, observed_at=2000
        )
        self.assertEqual(same["advisories"][0]["first_observed"], 1000)

        moved, _ = project(
            [advisory()],
            facts(counters={**COUNTERS, "nogndcount": 8}),
            first_observed=observed,
            observed_at=3000,
        )
        self.assertEqual(moved["advisories"][0]["first_observed"], 3000)

    def test_ordinary_relay_wear_does_not_move_the_token(self):
        """The firmware tokens relay life on the severity step, not the percentage."""
        config = {**CONFIG, **RELAY_BLOCK, "relay_life_pct": 19}
        at_nineteen, observed = project(
            [advisory("wear.relay_life", category="wear", severity="warning")],
            facts(config=config),
            observed_at=1000,
        )
        at_eighteen, _ = project(
            [advisory("wear.relay_life", category="wear", severity="warning")],
            facts(config={**config, "relay_life_pct": 18}),
            first_observed=observed,
            observed_at=2000,
        )

        self.assertEqual(
            at_nineteen["advisories"][0]["counter_token"],
            at_eighteen["advisories"][0]["counter_token"],
        )
        self.assertEqual(at_eighteen["advisories"][0]["first_observed"], 1000)


class UnknownAdvisoryTests(unittest.TestCase):
    def test_an_unknown_id_is_historical_with_its_severity_verbatim(self):
        entry, _ = one(
            [advisory("future.new_rule", category="future", severity="warning")],
            facts(state=3),
        )

        self.assertEqual(entry["severity"], "warning")
        self.assertEqual(entry["classification"], "historical")
        self.assertFalse(entry["corroborated"])
        self.assertEqual(entry["counter_token"], 1794177153)

    def test_an_unknown_severity_is_kept_as_the_firmware_sent_it(self):
        entry, _ = one([advisory(severity="degraded")], facts(state=7))
        self.assertEqual(entry["severity"], "degraded")


class SafetyCorroborationTests(unittest.TestCase):
    def test_a_disabled_check_is_active_from_the_config_boolean(self):
        entry, _ = one(
            [advisory("safety.vent_check", category="safety", severity="warning")],
            facts(config={**CONFIG, "vent_check": False}),
        )

        self.assertEqual(entry["classification"], "active")
        self.assertTrue(entry["corroborated"])

    def test_an_enabled_check_is_not_corroborated(self):
        entry, _ = one(
            [advisory("safety.vent_check", category="safety", severity="warning")],
            facts(config={**CONFIG, "vent_check": True}, state=3),
        )

        self.assertEqual(entry["classification"], "historical")
        self.assertFalse(entry["corroborated"])

    def test_status_flags_never_corroborate_a_safety_advisory(self):
        """`/status.flags` is VFLAGS, not the `$GE` settings word."""
        for advisory_id in health.SAFETY_IDS:
            with self.subTest(advisory_id=advisory_id):
                entry, _ = one(
                    [advisory(advisory_id, category="safety", severity="warning")],
                    facts(state=3, config=CONFIG),
                )
                self.assertFalse(entry["corroborated"])
                self.assertIn("flags", facts())

    def test_the_settings_token_is_the_five_checks_together(self):
        live = facts(config={**CONFIG, "diode_check": False})
        first, _ = project(
            [advisory("safety.diode_check", category="safety")], live
        )
        # `1` enabled, `0` disabled, in health.SAFETY_CHECKS order.
        self.assertEqual(first["advisories"][0]["counter_token"], "11011")

        both, _ = project(
            [
                advisory("safety.diode_check", category="safety"),
                advisory("safety.vent_check", category="safety"),
            ],
            live,
        )
        self.assertEqual(
            {entry["counter_token"] for entry in both["advisories"]}, {"11011"}
        )


class GateTests(unittest.TestCase):
    """A closed gate means "incomplete", never "no faults"."""

    def test_absent_safety_booleans_close_the_settings_gate(self):
        live = facts(config={"over_temp_shutdown": 72})
        content, _ = project([], live)

        self.assertEqual(content["advisories"], [])
        self.assertFalse(content["gates"]["settings_known"])
        self.assertTrue(content["gates"]["relay_health_known"] is False)

    def test_absent_relay_block_closes_the_relay_health_gate(self):
        content, _ = project([], facts())

        self.assertTrue(content["gates"]["settings_known"])
        self.assertFalse(content["gates"]["relay_health_known"])

    def test_no_config_observation_at_all_closes_both_gates(self):
        content, _ = project([], facts(config=None))

        self.assertEqual(
            content["gates"], {"settings_known": False, "relay_health_known": False}
        )

    def test_a_known_charger_reports_both_gates_closed(self):
        content, _ = project([], facts(config={**CONFIG, **RELAY_BLOCK}))

        self.assertEqual(
            content["gates"], {"settings_known": True, "relay_health_known": True}
        )

    def test_a_safety_advisory_under_a_closed_gate_is_not_active(self):
        # No settings booleans at all: the gateway raised this from a word the
        # bridge has not fetched, so nothing corroborates it -- and the closed
        # gate says the silence is incomplete, not healthy.
        entry, content = one(
            [advisory("safety.temp_check", category="safety", severity="warning")],
            facts(config={"over_temp_shutdown": 72}),
        )

        self.assertFalse(content["gates"]["settings_known"])
        self.assertEqual(entry["classification"], "historical")
        self.assertFalse(entry["corroborated"])


class ThermalTests(unittest.TestCase):
    def test_high_temp_is_active_within_the_margin_of_panic(self):
        entry, _ = one(
            [advisory("thermal.high_temp", category="thermal", severity="warning")],
            facts(temps=(60.0, 67.0, None), config={**CONFIG, "over_temp_shutdown": 72}),
        )
        self.assertEqual(entry["classification"], "active")
        self.assertEqual(entry["counter_token"], 1794177153)

    def test_high_temp_is_historical_below_the_margin(self):
        entry, _ = one(
            [advisory("thermal.high_temp", category="thermal", severity="warning")],
            facts(temps=(60.0, 66.0, None), config={**CONFIG, "over_temp_shutdown": 72}),
        )
        self.assertEqual(entry["classification"], "historical")

    def test_high_temp_uses_the_firmware_default_panic_without_one(self):
        config = {
            key: value for key, value in CONFIG.items() if key != "over_temp_shutdown"
        }
        entry, _ = one(
            [advisory("thermal.high_temp", category="thermal", severity="warning")],
            facts(temps=(67.0, None, None), config=config),
        )
        self.assertEqual(entry["classification"], "active")

    def test_high_temp_needs_a_valid_sensor(self):
        entry, _ = one(
            [advisory("thermal.high_temp", category="thermal", severity="warning")],
            facts(temps=(None, None, None)),
        )
        self.assertEqual(entry["classification"], "historical")
        self.assertFalse(entry["corroborated"])

    def test_relay_thermal_follows_the_gl_level(self):
        base = {**CONFIG, **RELAY_BLOCK}
        watch, _ = one(
            [advisory("thermal.relay_thermal", category="thermal", severity="warning")],
            facts(config={**base, "relay_thermal_warning_level": 1}),
        )
        warn, _ = one(
            [advisory("thermal.relay_thermal", category="thermal", severity="warning")],
            facts(config={**base, "relay_thermal_warning_level": 2}),
        )
        clear, _ = one(
            [advisory("thermal.relay_thermal", category="thermal", severity="warning")],
            facts(config={**base, "relay_thermal_warning_level": 0}),
        )

        self.assertEqual(watch["classification"], "active")
        self.assertEqual(watch["counter_token"], 1)
        self.assertEqual(warn["counter_token"], 2)
        self.assertEqual(clear["classification"], "historical")
        self.assertEqual(clear["counter_token"], 0)

    def test_throttling_and_wear_are_always_historical(self):
        config = {
            **CONFIG,
            **RELAY_BLOCK,
            "relay_thermal_warning_level": 2,
            "relay_life_pct": 3,
        }
        entries = [
            advisory("thermal.throttling", category="thermal", severity="warning"),
            advisory("wear.relay_life", category="wear", severity="warning"),
            advisory("wear.relay_transit_drift", category="wear", severity="warning"),
            advisory("wear.relay_cold_open", category="wear", severity="warning"),
            advisory("wear.stuck_relay_recovery", category="wear", severity="info"),
        ]
        content, _ = project(
            entries, facts(state=3, temps=(70.0, None, None), config=config)
        )

        for entry in content["advisories"]:
            with self.subTest(advisory_id=entry["id"]):
                self.assertEqual(entry["classification"], "historical")
                self.assertFalse(entry["corroborated"])

    def test_counter_backed_wear_tokens_are_their_counters(self):
        config = {
            **CONFIG,
            **RELAY_BLOCK,
            "relay_cold_open_count": 12,
            "relay_stuck_recovery_count": 3,
        }
        content, _ = project(
            [
                advisory("wear.relay_cold_open", category="wear"),
                advisory("wear.stuck_relay_recovery", category="wear"),
            ],
            facts(config=config),
        )

        tokens = {entry["id"]: entry["counter_token"] for entry in content["advisories"]}
        self.assertEqual(tokens["wear.relay_cold_open"], 12)
        self.assertEqual(tokens["wear.stuck_relay_recovery"], 3)


class ProjectionTests(unittest.TestCase):
    def test_the_ring_order_is_kept_and_departed_entries_are_dropped(self):
        first, observed = project(
            [advisory("fault.no_ground"), advisory("wear.relay_life", category="wear")],
            facts(config={**CONFIG, **RELAY_BLOCK}),
        )
        self.assertEqual(
            [entry["id"] for entry in first["advisories"]],
            ["fault.no_ground", "wear.relay_life"],
        )

        second, _ = project(
            [advisory("wear.relay_life", category="wear")],
            facts(config={**CONFIG, **RELAY_BLOCK}),
            first_observed=observed,
        )
        self.assertEqual(
            [entry["id"] for entry in second["advisories"]], ["wear.relay_life"]
        )

    def test_every_projected_entry_carries_the_contract_fields(self):
        entry, _ = one([advisory()], facts())
        self.assertEqual(
            set(entry),
            {
                "id",
                "category",
                "severity",
                "firmware_sticky",
                "acked",
                "first_seen",
                "last_seen",
                "classification",
                "corroborated",
                "counter_token",
                "first_observed",
            },
        )

    def test_the_alert_watermark_is_carried_through_unchanged(self):
        content, _ = project([], facts(), alerted={"fault.no_ground|7": 1000})
        self.assertEqual(content["alerted"], {"fault.no_ground|7": 1000})


class ParsingTests(unittest.TestCase):
    def test_the_live_gateway_payload_normalizes(self):
        payload = {
            "count": 0,
            "max_severity": "info",
            "notifications": [
                {
                    "id": "fault.no_ground",
                    "category": "fault",
                    "severity": "critical",
                    "sticky": False,
                    "acked": True,
                    "first_seen": 1794177153,
                    "last_seen": 1794868200,
                }
            ],
        }
        self.assertEqual(
            parse_notifications(payload),
            [
                {
                    "id": "fault.no_ground",
                    "category": "fault",
                    "severity": "critical",
                    "firmware_sticky": False,
                    "acked": True,
                    "first_seen": 1794177153,
                    "last_seen": 1794868200,
                }
            ],
        )

    def test_an_empty_ring_is_an_empty_list_not_unsupported(self):
        self.assertEqual(parse_notifications({"count": 0, "notifications": []}), [])

    def test_a_payload_that_is_not_the_contract_is_none(self):
        for payload in (
            None,
            [],
            "nope",
            {},
            {"count": 0},
            {"notifications": "nope"},
        ):
            with self.subTest(payload=payload):
                self.assertIsNone(parse_notifications(payload))

    def test_mistyped_entries_are_tolerated(self):
        parsed = parse_notifications(
            {
                "notifications": [
                    "nope",
                    {"category": "fault"},
                    {"id": ""},
                    {"id": "x", "acked": "yes", "sticky": 1, "first_seen": "soon"},
                ]
            }
        )
        self.assertEqual(
            parsed,
            [
                {
                    "id": "x",
                    "category": None,
                    "severity": None,
                    "firmware_sticky": False,
                    "acked": False,
                    "first_seen": None,
                    "last_seen": None,
                }
            ],
        )

    def test_fault_counters_coerce_and_keep_absent_as_none(self):
        self.assertEqual(
            parse_fault_counters({"nogndcount": 7, "gfcicount": "3"}),
            {"nogndcount": 7, "gfcicount": 3, "stuckcount": None},
        )
        self.assertEqual(
            parse_fault_counters({}),
            {"nogndcount": None, "gfcicount": None, "stuckcount": None},
        )
        self.assertEqual(
            parse_fault_counters("nope"),
            {"nogndcount": None, "gfcicount": None, "stuckcount": None},
        )


class LiveObservationsTests(unittest.TestCase):
    def test_the_holder_swaps_whole_observations(self):
        live = health.LiveObservations()
        self.assertEqual(
            live.snapshot(),
            {"state": None, "temps": (None, None, None), "counters": {}, "config": None},
        )

        live.note_status(
            {"state": 3, "temp1": 41.5, "temp2": None, "temp3": None}, COUNTERS
        )
        live.note_config(CONFIG)
        snapshot = live.snapshot()

        self.assertEqual(snapshot["state"], 3)
        self.assertEqual(snapshot["temps"], (41.5, None, None))
        self.assertEqual(snapshot["counters"], COUNTERS)
        self.assertEqual(snapshot["config"], CONFIG)

    def test_a_snapshot_does_not_expose_the_holder_s_own_dicts(self):
        live = health.LiveObservations()
        live.note_config(CONFIG)
        live.snapshot()["config"]["ground_check"] = False

        self.assertTrue(live.snapshot()["config"]["ground_check"])


if __name__ == "__main__":
    unittest.main()
