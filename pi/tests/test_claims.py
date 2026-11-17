"""The claims pipeline: the authoritative reason and its evidence (#159).

Pure projection tests over ``pi/claims.py`` (no charger, no Firestore, no
broker) beside loop-level tests over ``bridge.claims_loop`` with the
in-memory fakes. The acceptance criteria these pin hardest:

- the reason comes from ``GET /claims/target`` alone -- retained MQTT
  documents enrich ``detail`` and corroborate, never decide;
- an unavailable target (404 old firmware, fetch failure, never fetched)
  derives ``unknown`` -- never a guess from retained evidence;
- a steady charger costs zero writes: an identical answer, an unchanged
  response or an identical retained redelivery writes nothing.
"""

import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402
from firebase_admin import firestore  # noqa: E402

import bridge  # noqa: E402
import claims  # noqa: E402
from fakes import (  # noqa: E402
    FakeDB,
    FakeMqttFactory,
    FakeResponse,
    FakeSession,
    _StopAfter,
    _host,
    _status_payload,
)
from mqtt_source import MqttSource, Snapshot  # noqa: E402
from test_mqtt import _RecordingNotifier  # noqa: E402

MANUAL = 65537
DIVERT = 65538
BOOST = 65539
TIMER = 65540
LIMIT = 65542
ERROR = 65543
OCPP = 65545
RFID = 65546
MQTT = 65547
SHAPER = 65548
TEMP_THROTTLE = 65549


def target(
    state="none",
    charge_current=None,
    max_current=None,
    auto_release=False,
    state_claim=None,
    current_claim=None,
    max_current_claim=None,
):
    """One ``GET /claims/target`` payload, shaped to the pinned contract."""
    properties = {"state": state, "auto_release": auto_release}
    if charge_current is not None:
        properties["charge_current"] = charge_current
    if max_current is not None:
        properties["max_current"] = max_current
    winners = {}
    if state_claim is not None:
        winners["state"] = state_claim
    if current_claim is not None:
        winners["charge_current"] = current_claim
    if max_current_claim is not None:
        winners["max_current"] = max_current_claim
    return {"properties": properties, "claims": winners}


def facts(vehicle=1, evidence=None, schedule=None, charger_online=True):
    """One claims-observation snapshot, shaped like ClaimsObservations."""
    return {
        "vehicle": vehicle,
        "evidence": dict(evidence or {}),
        "schedule": schedule,
        "charger_online": charger_online,
    }


def reason(payload, live=None):
    """derive_reason over one raw payload (normalize + derive)."""
    return claims.derive_reason(claims.normalize_target(payload), live or facts())


# --- The pure module ----------------------------------------------------------


class NormalizeTargetTests(unittest.TestCase):
    def test_the_full_contract_is_subsettingly_normalized(self):
        normalized = claims.normalize_target(
            target(
                state="disabled",
                charge_current=20,
                max_current=32,
                auto_release=True,
                state_claim=MANUAL,
                current_claim=LIMIT,
                max_current_claim=LIMIT,
            )
        )
        self.assertEqual(
            normalized,
            {
                "state": "disabled",
                "charge_current": 20,
                "max_current": 32,
                "auto_release": True,
                "claims": {
                    "state": MANUAL,
                    "charge_current": LIMIT,
                    "max_current": LIMIT,
                },
            },
        )

    def test_omitted_claim_keys_never_win(self):
        normalized = claims.normalize_target(target())
        self.assertEqual(
            normalized["claims"],
            {"state": None, "charge_current": None, "max_current": None},
        )
        self.assertIsNone(normalized["charge_current"])
        self.assertIsNone(normalized["max_current"])

    def test_an_absent_claims_object_is_no_winners(self):
        payload = {"properties": {"state": "none", "auto_release": False}}
        normalized = claims.normalize_target(payload)
        self.assertEqual(
            normalized["claims"],
            {"state": None, "charge_current": None, "max_current": None},
        )

    def test_a_non_object_payload_is_not_the_contract(self):
        for payload in (None, [], "nope", 7, {"claims": {}}):
            with self.subTest(payload=payload):
                self.assertIsNone(claims.normalize_target(payload))

    def test_unknown_values_coerce_to_none_never_to_zero(self):
        normalized = claims.normalize_target(
            {
                "properties": {
                    "state": "banana",
                    "charge_current": "soon",
                    "max_current": None,
                    "auto_release": "yes",
                },
                "claims": {"state": True, "charge_current": "65537"},
            }
        )
        self.assertIsNone(normalized["state"])
        self.assertIsNone(normalized["charge_current"])
        self.assertIsNone(normalized["auto_release"])
        # A bool is not a client id; a numeric string is tolerated.
        self.assertIsNone(normalized["claims"]["state"])
        self.assertEqual(normalized["claims"]["charge_current"], 65537)


class DeriveReasonTests(unittest.TestCase):
    """The precedence ladder, one step at a time."""

    def test_no_authoritative_target_is_unknown(self):
        for live in (
            facts(),
            facts(vehicle=0),
            facts(evidence={"claim": {"state": "disabled"}}),
            facts(vehicle=0, evidence={"boost": {"type": "energy"}}),
        ):
            with self.subTest(live=live):
                derived = claims.derive_reason(None, live)
                self.assertEqual(derived["reason"], "unknown")
                self.assertIsNone(derived["winner_state"])
                self.assertEqual(derived["detail"], {})

    def test_an_offline_charger_is_unknown_even_with_a_fresh_target(self):
        derived = claims.derive_reason(
            claims.normalize_target(target(state_claim=MANUAL)),
            facts(charger_online=False),
        )
        self.assertEqual(derived["reason"], "unknown")

    def test_an_unknown_online_fact_derives_normally(self):
        # Never observed is not offline (the tracker starts None).
        derived = claims.derive_reason(
            claims.normalize_target(target(state_claim=MANUAL)),
            facts(charger_online=None),
        )
        self.assertEqual(derived["reason"], "manual_override")

    def test_every_mapped_state_winner_id(self):
        for client_id, expected in (
            (MANUAL, "manual_override"),
            (TIMER, "schedule"),
            (BOOST, "boost"),
            (LIMIT, "current_limit"),
            (ERROR, "safety"),
            (SHAPER, "safety"),
            (TEMP_THROTTLE, "safety"),
        ):
            with self.subTest(client_id=client_id):
                derived = reason(
                    target(state_claim=client_id), facts(vehicle=0)
                )
                self.assertEqual(derived["reason"], expected)
                self.assertEqual(
                    derived["winner_state"], claims.client_name(client_id)
                )

    def test_every_unmapped_state_winner_id_is_unknown(self):
        # divert, ocpp, rfid, mqtt and a future id are restrictions this
        # vocabulary cannot name -- never "no restriction".
        for client_id in (DIVERT, OCPP, RFID, MQTT, 70000):
            with self.subTest(client_id=client_id):
                derived = reason(target(state_claim=client_id), facts(vehicle=1))
                self.assertEqual(derived["reason"], "unknown")
                self.assertIsNotNone(derived["winner_state"])

    def test_a_limit_current_winner_without_a_state_winner(self):
        for kwargs in (
            {"current_claim": LIMIT, "charge_current": 16},
            {"max_current_claim": LIMIT, "max_current": 32},
        ):
            with self.subTest(kwargs=kwargs):
                derived = reason(target(**kwargs), facts(vehicle=1))
                self.assertEqual(derived["reason"], "current_limit")
                self.assertEqual(derived["winner_current"], "limit")
                self.assertIsNone(derived["winner_state"])

    def test_a_non_limit_current_winner_is_no_restriction(self):
        # The confirmed precedence: only the limit client maps a current
        # winner; any other winner falls through to the final step.
        derived = reason(
            target(current_claim=OCPP, charge_current=10), facts(vehicle=1)
        )
        self.assertIsNone(derived["reason"])
        self.assertIsNotNone(derived["winner_current"])

    def test_no_winners_and_a_disconnected_vehicle(self):
        for vehicle in (0, 2):
            with self.subTest(vehicle=vehicle):
                derived = reason(target(), facts(vehicle=vehicle))
                self.assertEqual(derived["reason"], "not_connected")

    def test_no_winners_and_a_connected_or_unknown_vehicle(self):
        for vehicle in (1, None):
            with self.subTest(vehicle=vehicle):
                derived = reason(target(), facts(vehicle=vehicle))
                self.assertIsNone(derived["reason"])

    def test_a_state_winner_beats_the_current_and_vehicle_steps(self):
        derived = reason(
            target(
                state_claim=BOOST,
                current_claim=LIMIT,
                charge_current=16,
            ),
            facts(vehicle=0),
        )
        self.assertEqual(derived["reason"], "boost")


class EvidenceCanNotChangeTheReasonTests(unittest.TestCase):
    """The structural guarantee: evidence enters through detail only."""

    def test_conflicting_retained_evidence_never_moves_the_reason(self):
        live = facts(
            evidence={
                "claim": {"state": "active", "charge_current": 32000},
                "limit": {"type": "soc", "value": 80},
                "boost": {"type": "energy", "value": 10, "remaining": 3500},
            }
        )
        # No target: unknown, whatever the retained documents claim.
        self.assertEqual(claims.derive_reason(None, live)["reason"], "unknown")
        # No winners: None, even with a boost document in hand.
        self.assertIsNone(claims.derive_reason(claims.normalize_target(target()), live)["reason"])
        # A manual winner stays manual beside a limit document.
        self.assertEqual(
            claims.derive_reason(
                claims.normalize_target(target(state_claim=MANUAL)), live
            )["reason"],
            "manual_override",
        )

    def test_detail_carries_only_the_documents_that_explain_the_reason(self):
        boost = {"type": "energy", "value": 10, "remaining": 3500}
        claim = {"state": "disabled", "charge_current": 32000}
        limit = {"type": "soc", "value": 80}
        live = facts(evidence={"boost": boost, "claim": claim, "limit": limit})
        self.assertEqual(
            claims.derive_reason(
                claims.normalize_target(target(state_claim=BOOST)), live
            )["detail"],
            {"boost": boost},
        )
        self.assertEqual(
            claims.derive_reason(
                claims.normalize_target(target(state_claim=MANUAL)), live
            )["detail"],
            {"claim": claim},
        )
        self.assertEqual(
            claims.derive_reason(
                claims.normalize_target(
                    target(current_claim=LIMIT, charge_current=16)
                ),
                live,
            )["detail"],
            {"limit": limit},
        )
        # A reason with no evidence carries no detail keys.
        self.assertEqual(
            claims.derive_reason(
                claims.normalize_target(target(state_claim=TIMER)), live
            )["detail"],
            {},
        )

    def test_the_schedule_detail_names_the_active_rule(self):
        derived = claims.derive_reason(
            claims.normalize_target(target(state_claim=TIMER)),
            facts(schedule={"in_window": True, "active_rule_id": "cheap"}),
        )
        self.assertEqual(derived["detail"], {"schedule_rule_id": "cheap"})
        # Outside a window the firmware names no rule; detail stays empty.
        derived = claims.derive_reason(
            claims.normalize_target(target(state_claim=TIMER)),
            facts(schedule={"in_window": False, "active_rule_id": None}),
        )
        self.assertEqual(derived["detail"], {})


class ProjectAndComparableTests(unittest.TestCase):
    def test_project_shapes_the_document_content(self):
        content = claims.project(
            claims.normalize_target(target(state_claim=MANUAL)),
            facts(evidence={"claim": {"state": "disabled"}}),
        )
        self.assertEqual(
            content,
            {
                "reachable": True,
                "source": "http",
                "reason": "manual_override",
                "winner_state": "manual",
                "winner_current": None,
                "detail": {"claim": {"state": "disabled"}},
            },
        )

    def test_comparable_drops_the_write_stamps(self):
        content = claims.project(claims.normalize_target(target()), facts())
        again = {**content, "checked_at": 100, "updated_at": "later"}
        self.assertEqual(claims.comparable(again), claims.comparable(content))
        self.assertNotIn("checked_at", claims.comparable(again))
        self.assertNotIn("updated_at", claims.comparable(again))

    def test_comparable_drops_the_moving_boost_countdown(self):
        running = claims.project(
            claims.normalize_target(target(state_claim=BOOST)),
            facts(evidence={"boost": {"type": "energy", "remaining": 3500}}),
        )
        ticked = claims.project(
            claims.normalize_target(target(state_claim=BOOST)),
            facts(evidence={"boost": {"type": "energy", "remaining": 3400}}),
        )
        # The written documents differ (the countdown is the honest fact)...
        self.assertNotEqual(running["detail"], ticked["detail"])
        # ...but the change test does not see it.
        self.assertEqual(claims.comparable(running), claims.comparable(ticked))

    def test_comparable_still_sees_a_changed_limit_value(self):
        # The positive direction of the countdown drop: a limit document
        # genuinely republished at a new value is a content change, not a
        # value that moves on its own -- the change test must see it.
        first = claims.project(
            claims.normalize_target(target(current_claim=LIMIT, charge_current=16)),
            facts(evidence={"limit": {"type": "soc", "value": 80}}),
        )
        second = claims.project(
            claims.normalize_target(target(current_claim=LIMIT, charge_current=16)),
            facts(evidence={"limit": {"type": "soc", "value": 60}}),
        )
        self.assertNotEqual(claims.comparable(first), claims.comparable(second))

    def test_comparable_still_sees_a_changed_boost_type(self):
        # Only the countdown is dropped; the boost's own content is not.
        first = claims.project(
            claims.normalize_target(target(state_claim=BOOST)),
            facts(evidence={"boost": {"type": "energy", "value": 10}}),
        )
        second = claims.project(
            claims.normalize_target(target(state_claim=BOOST)),
            facts(evidence={"boost": {"type": "time", "value": 10}}),
        )
        self.assertNotEqual(claims.comparable(first), claims.comparable(second))


class EvidenceParserTests(unittest.TestCase):
    def test_the_claim_document(self):
        self.assertEqual(
            claims.parse_claim(
                {"priority": 500, "state": "active", "charge_current": 32000,
                 "max_current": 40000, "auto_release": False}
            ),
            {
                "priority": 500,
                "state": "active",
                "charge_current": 32000,
                "max_current": 40000,
                "auto_release": False,
            },
        )
        # Idle is the null state, not a claim.
        self.assertIsNone(claims.parse_claim({"state": "null"}))
        # Anything else is not evidence; inside a kept document an invalid
        # optional field is dropped, not fatal (the state word is the claim).
        for value in (None, [], "active", {}, {"state": "banana"}):
            with self.subTest(value=value):
                self.assertIsNone(claims.parse_claim(value))
        self.assertEqual(
            claims.parse_claim({"priority": "high", "state": "active"}),
            {"state": "active"},
        )

    def test_the_limit_document(self):
        self.assertEqual(
            claims.parse_limit({"type": "soc", "value": 80, "auto_release": True}),
            {"type": "soc", "value": 80, "auto_release": True},
        )
        for value in (
            None,
            {},
            {"type": "bogus", "value": 1},
            {"type": "time"},
            {"type": "energy", "value": "many"},
            "soc",
        ):
            with self.subTest(value=value):
                self.assertIsNone(claims.parse_limit(value))

    def test_the_boost_document(self):
        running = claims.parse_boost(
            {"type": "energy", "value": 10, "remaining": 3500,
             "started": "2026-11-17T09:00:00Z"}
        )
        self.assertEqual(
            running,
            {
                "type": "energy",
                "value": 10,
                "remaining": 3500,
                "started": "2026-11-17T09:00:00Z",
            },
        )
        # {} is idle; garbage is not evidence.
        for value in (None, {}, [], {"value": 10}, {"type": ""}):
            with self.subTest(value=value):
                self.assertIsNone(claims.parse_boost(value))


class ClaimsObservationsTests(unittest.TestCase):
    def setUp(self):
        self.holder = claims.ClaimsObservations()

    def note(self, fields, payload=None):
        return self.holder.note_status(fields, payload)

    def test_a_first_observation_is_a_transition_for_the_state(self):
        self.assertTrue(self.note({"state": 3, "state_label": "charging"}))
        self.assertFalse(self.note({"state": 3, "state_label": "charging"}))
        self.assertTrue(self.note({"state": 1, "state_label": "ready"}))
        # The label alone is a transition (a Stop at a constant state 254).
        self.assertTrue(self.note({"state": 254, "state_label": "stopped"}))

    def test_telemetry_and_vehicle_changes_never_wake(self):
        self.note({"state": 3, "state_label": "charging"})
        self.assertFalse(self.note({"amp": 15.4, "vehicle": 1}))
        self.assertFalse(self.note({"vehicle": 0}))

    def test_a_partial_snapshot_keeps_the_fields_it_omitted(self):
        self.note({"state": 3, "state_label": "charging", "vehicle": 1})
        self.note({"amp": 15.4})
        facts_ = self.holder.snapshot()
        self.assertEqual(facts_["state"], 3)
        self.assertEqual(facts_["vehicle"], 1)

    def test_a_claims_version_move_wakes_and_is_remembered(self):
        self.assertFalse(self.note({}, {}))
        self.assertTrue(self.note({}, {"claims_version": 4}))
        self.assertFalse(self.note({}, {"claims_version": 4}))
        self.assertTrue(self.note({}, {"claims_version": 5}))
        self.assertEqual(self.holder.snapshot()["claims_version"], 5)

    def test_evidence_is_parsed_into_the_holder(self):
        self.holder.note_evidence("claim", {"state": "active", "priority": 500})
        self.holder.note_evidence("boost", {"type": "energy", "value": 10})
        self.assertEqual(
            self.holder.snapshot()["evidence"],
            {
                "claim": {"state": "active", "priority": 500},
                "boost": {"type": "energy", "value": 10},
            },
        )

    def test_malformed_evidence_drops_its_previous_value(self):
        self.holder.note_evidence("boost", {"type": "energy", "value": 10})
        self.holder.note_evidence("boost", {"remaining": "soon"})
        self.holder.note_evidence("unknown-leaf", {"state": "active"})
        self.assertEqual(self.holder.snapshot()["evidence"], {})

    def test_the_schedule_window_is_remembered(self):
        self.holder.note_schedule({"in_window": True, "active_rule_id": "off-peak"})
        self.assertEqual(
            self.holder.snapshot()["schedule"],
            {"in_window": True, "active_rule_id": "off-peak"},
        )
        self.holder.note_schedule(None)
        self.assertIsNone(self.holder.snapshot()["schedule"])

    def test_wake_sets_the_trigger(self):
        self.assertFalse(self.holder.trigger.is_set())
        self.holder.wake()
        self.assertTrue(self.holder.trigger.is_set())

    def test_a_snapshot_is_a_copy(self):
        self.note({"state": 3, "vehicle": 1}, {"claims_version": 2})
        self.holder.note_evidence("claim", {"state": "active"})
        first = self.holder.snapshot()
        self.holder.note_evidence("claim", {"state": "disabled"})
        self.note({"state": 1})
        self.assertEqual(first["evidence"]["claim"], {"state": "active"})
        self.assertEqual(first["state"], 3)
        self.assertEqual(self.holder.snapshot()["state"], 1)


# --- The loop -----------------------------------------------------------------


class _Monotonic:
    """A controllable monotonic clock (the debounce/safety-cadence seam)."""

    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


class ClaimsLoopTests(unittest.TestCase):
    def setUp(self):
        # One WriteCounter per run_loop call, in order: the tests assert
        # the claims write kind at the boundary the loop advertises.
        self.counters = []

    def run_loop(
        self,
        responses,
        polls,
        db=None,
        holder=None,
        tracker=None,
        on_wait=None,
        clock=lambda: 1000.4,
    ):
        db = db if db is not None else FakeDB()
        holder = holder if holder is not None else claims.ClaimsObservations()
        holder.wake()  # the first tick is the status loop's start-up poll
        monotonic = _Monotonic(1000.0)

        def between_ticks():
            # What a driving status loop does between claims ticks: one
            # interval passes and the next applied observation wakes us.
            monotonic.now += 10.0
            holder.wake()
            if on_wait is not None:
                on_wait()

        session = FakeSession(responses)
        counter = bridge.WriteCounter()
        self.counters.append(counter)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, between_ticks)):
            bridge.claims_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(session),
                holder,
                tracker=tracker,
                counter=counter,
                clock=clock,
                monotonic=monotonic,
            )
        return db, session

    @staticmethod
    def claims_writes(db):
        return [
            write
            for write in db.writes
            if write[1] == "status" and write[2] == "claims"
        ]

    def test_the_first_poll_writes_the_reason_and_an_unchanged_poll_writes_nothing(
        self,
    ):
        payload = target(state_claim=MANUAL, state="disabled")
        db, session = self.run_loop(
            [FakeResponse(200, payload), FakeResponse(200, payload)], polls=2
        )
        writes = self.claims_writes(db)

        self.assertEqual(len(writes), 1, "steady state must add zero writes")
        self.assertIs(writes[0][4], True, "the projection is a merge write")
        document = writes[0][3]
        self.assertTrue(document["reachable"])
        self.assertEqual(document["source"], "http")
        self.assertEqual(document["reason"], "manual_override")
        self.assertEqual(document["winner_state"], "manual")
        self.assertIsNone(document["winner_current"])
        self.assertEqual(document["detail"], {})
        self.assertEqual(document["checked_at"], 1000)
        self.assertIs(document["updated_at"], firestore.SERVER_TIMESTAMP)
        # One charger GET per fetched tick, and nothing else.
        self.assertEqual(
            [call[1] for call in session.calls],
            ["http://charger/claims/target"] * 2,
        )
        # The stored document is exactly what was written.
        self.assertEqual(db.data["status"]["claims"]["reason"], "manual_override")
        # Every claims write is counted under its own kind: a wrong kind
        # string would raise only *after* the Firestore write landed and
        # turn the loop into a silent rewrite loop.
        self.assertEqual(
            self.counters[-1].health_fields()["writes_by_kind"]["claims"],
            len(writes),
        )

    def test_a_reason_change_writes_once(self):
        db, _ = self.run_loop(
            [
                FakeResponse(200, target(state_claim=MANUAL)),
                FakeResponse(200, target()),
                FakeResponse(200, target()),
            ],
            polls=3,
        )
        writes = self.claims_writes(db)
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0][3]["reason"], "manual_override")
        self.assertIsNone(writes[1][3]["reason"])

    def test_an_identical_retained_redelivery_writes_nothing(self):
        # The broker republishes the same retained documents on every
        # reconnect; with the target unchanged the projection is identical.
        holder = claims.ClaimsObservations()
        holder.note_evidence("claim", {"state": "disabled"})
        holder.note_evidence("boost", {"type": "energy", "value": 10, "remaining": 90})
        db, _ = self.run_loop(
            [FakeResponse(200, target(state_claim=BOOST))],
            polls=1,
            holder=holder,
        )
        self.assertEqual(len(self.claims_writes(db)), 1)
        # The identical redelivery -- and a countdown that ticked, which the
        # change test must not see (comparable drops the moving value).
        holder.note_evidence("claim", {"state": "disabled"})
        holder.note_evidence(
            "boost", {"type": "energy", "value": 10, "remaining": 80}
        )
        db, _ = self.run_loop(
            [FakeResponse(200, target(state_claim=BOOST))],
            polls=1,
            db=db,
            holder=holder,
        )
        self.assertEqual(
            len(self.claims_writes(db)), 1, "identical evidence is not a change"
        )
        # The stored document still carries the first write's countdown: the
        # honest "as of that write" fact, refreshed only when a write lands.
        self.assertEqual(
            db.data["status"]["claims"]["detail"]["boost"]["remaining"], 90
        )

    def test_a_changed_retained_evidence_value_writes_again(self):
        # The positive direction of the identical-redelivery test: the limit
        # document genuinely changed (80 -> 60) while the target stayed
        # identical, and detail is part of the change test -- the next
        # fetched tick writes the new value instead of freezing the first.
        holder = claims.ClaimsObservations()
        holder.note_evidence("limit", {"type": "soc", "value": 80})
        db, _ = self.run_loop(
            [FakeResponse(200, target(current_claim=LIMIT, charge_current=16))],
            polls=1,
            holder=holder,
        )
        holder.note_evidence("limit", {"type": "soc", "value": 60})
        db, _ = self.run_loop(
            [FakeResponse(200, target(current_claim=LIMIT, charge_current=16))],
            polls=1,
            db=db,
            holder=holder,
        )
        writes = self.claims_writes(db)
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[1][3]["reason"], "current_limit")
        self.assertEqual(writes[1][3]["detail"]["limit"]["value"], 60)
        self.assertEqual(
            db.data["status"]["claims"]["detail"]["limit"]["value"], 60
        )
        self.assertEqual(
            sum(
                counter.health_fields()["writes_by_kind"]["claims"]
                for counter in self.counters
            ),
            len(writes),
        )

    def test_a_reason_transition_drops_the_departed_detail_keys(self):
        # A merge write deep-merges maps: without the delete sentinel the
        # stored document would keep the previous reason's evidence -- a
        # ``limit`` beside a ``boost`` reason -- and, because the restart
        # seed reads that stale detail back, pay one write per restart
        # that still cannot drop it.
        holder = claims.ClaimsObservations()
        holder.note_evidence("limit", {"type": "soc", "value": 80})
        db, _ = self.run_loop(
            [FakeResponse(200, target(current_claim=LIMIT, charge_current=16))],
            polls=1,
            holder=holder,
        )
        holder.note_evidence(
            "boost", {"type": "energy", "value": 10, "remaining": 90}
        )
        db, _ = self.run_loop(
            [FakeResponse(200, target(state_claim=BOOST))],
            polls=1,
            db=db,
            holder=holder,
        )
        writes = self.claims_writes(db)
        self.assertEqual(writes[1][3]["detail"]["limit"], firestore.DELETE_FIELD)
        self.assertEqual(db.data["status"]["claims"]["reason"], "boost")
        # The stored document carries only the new reason's evidence: the
        # fake's merge honours the sentinel, as the server's does.
        self.assertEqual(
            db.data["status"]["claims"]["detail"],
            {"boost": {"type": "energy", "value": 10, "remaining": 90}},
        )

    def test_a_restart_seed_writes_nothing_for_an_identical_answer(self):
        stored = {
            "reachable": True,
            "source": "http",
            "reason": "manual_override",
            "winner_state": "manual",
            "winner_current": None,
            "detail": {},
            "checked_at": 500,
        }
        db = FakeDB({"status": {"claims": stored}})
        db, _ = self.run_loop(
            [FakeResponse(200, target(state_claim=MANUAL))], polls=1, db=db
        )
        self.assertEqual(self.claims_writes(db), [])

    def test_a_404_is_unsupported_once_and_carries_unknown(self):
        db, _ = self.run_loop(
            [FakeResponse(404), FakeResponse(404), FakeResponse(404)], polls=3
        )
        writes = self.claims_writes(db)
        self.assertEqual(len(writes), 1, "the transition writes once")
        document = writes[0][3]
        self.assertFalse(document["reachable"])
        self.assertEqual(document["source"], "unsupported")
        self.assertEqual(document["reason"], "unknown")
        # Nothing in an unanswered poll may look like a winner.
        self.assertNotIn("winner_state", document)
        self.assertNotIn("detail", document)

    def test_a_non_404_failure_is_reachable_false_once(self):
        db, _ = self.run_loop(
            [FakeResponse(500)] + [requests.ConnectionError("down")] * 2, polls=3
        )
        writes = self.claims_writes(db)
        self.assertEqual(len(writes), 1)
        document = writes[0][3]
        self.assertFalse(document["reachable"])
        self.assertEqual(document["source"], "http")
        self.assertEqual(document["reason"], "unknown")

    def test_a_recovery_writes_once(self):
        db = FakeDB(
            {
                "status": {
                    "claims": {
                        "reachable": False,
                        "source": "http",
                        "reason": "unknown",
                        "checked_at": 900,
                    }
                }
            }
        )
        db, _ = self.run_loop(
            [
                FakeResponse(200, target(state_claim=MANUAL)),
                FakeResponse(200, target(state_claim=MANUAL)),
            ],
            polls=2,
            db=db,
        )
        writes = self.claims_writes(db)
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0][3]["reachable"])
        self.assertEqual(writes[0][3]["reason"], "manual_override")

    def test_a_payload_that_is_not_the_contract_is_unsupported(self):
        db, _ = self.run_loop(
            [FakeResponse(200, {"properties": "no"}), FakeResponse(200, [1])],
            polls=2,
        )
        writes = self.claims_writes(db)
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][3]["source"], "unsupported")
        self.assertEqual(writes[0][3]["reason"], "unknown")

    def test_a_failed_write_is_retried_on_the_next_poll(self):
        db = FakeDB()
        db.fail_writes = True
        db, _ = self.run_loop(
            [FakeResponse(200, target(state_claim=MANUAL))] * 2,
            polls=2,
            db=db,
            on_wait=lambda: setattr(db, "fail_writes", False),
        )
        self.assertEqual(len(self.claims_writes(db)), 1)

    def test_the_tracker_offline_fact_derives_unknown(self):
        tracker = bridge.StatusTracker(FakeDB())
        tracker.charger_online = False
        db, _ = self.run_loop(
            [FakeResponse(200, target(state_claim=MANUAL))],
            polls=1,
            tracker=tracker,
        )
        document = self.claims_writes(db)[0][3]
        self.assertTrue(document["reachable"])
        self.assertEqual(document["reason"], "unknown")

    def test_the_evidence_detail_rides_the_write(self):
        holder = claims.ClaimsObservations()
        holder.note_evidence("boost", {"type": "energy", "value": 10, "remaining": 90})
        db, _ = self.run_loop(
            [FakeResponse(200, target(state_claim=BOOST))],
            polls=1,
            holder=holder,
        )
        document = self.claims_writes(db)[0][3]
        self.assertEqual(
            document["detail"],
            {"boost": {"type": "energy", "value": 10, "remaining": 90}},
        )


class ClaimsCadenceTests(unittest.TestCase):
    """The debounce, the safety cadence and the trigger flag."""

    def run_loop(self, db, holder, clock, steps):
        session = FakeSession([FakeResponse(200, target())] * len(steps))
        pending = list(steps)

        def on_wait():
            if pending:
                advance, wake = pending.pop(0)
                clock.now += advance
                if wake:
                    holder.wake()

        with mock.patch.object(bridge, "_stop", _StopAfter(len(steps) + 1, on_wait)):
            bridge.claims_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(session),
                holder,
                counter=bridge.WriteCounter(),
                clock=lambda: 1000.4,
                monotonic=clock,
            )
        return session

    def test_a_trigger_inside_the_debounce_window_is_deferred_to_its_close(self):
        clock = _Monotonic()
        holder = claims.ClaimsObservations()
        holder.wake()
        session = self.run_loop(
            FakeDB(),
            holder,
            clock,
            [(0.0, False), (3.0, True), (3.0, False), (0.0, False)],
        )
        # t=1000 forced -> fetch. t=1003 forced but 3 s since the last fetch
        # (< 5 s debounce) -> deferred, the trigger stays armed; t=1006 no
        # new wake, yet the closed window (6 s since) plus the still-armed
        # trigger -> fetch; t=1006 idle, 0 s since the last fetch, no
        # trigger -> skip. A dropped trigger would leave t=1006 unfetched
        # until the safety cadence.
        self.assertEqual(len(session.calls), 2)

    def test_without_a_trigger_only_the_safety_cadence_fetches(self):
        clock = _Monotonic()
        holder = claims.ClaimsObservations()
        session = self.run_loop(
            FakeDB(),
            holder,
            clock,
            [(299.0, False), (1.0, False), (299.0, False), (0.0, False)],
        )
        # t=1000: the start-up fetch. t=1299: 299 s since it, no trigger --
        # below the 300 s safety cadence, so nothing. t=1300: still no
        # trigger, 300 s since the last fetch -> the safety cadence fetches.
        # t=1599: 299 s again -> nothing.
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(session.calls[0][1], "http://charger/claims/target")

    def test_the_safety_cadence_fetches_even_with_no_trigger_ever(self):
        clock = _Monotonic()
        holder = claims.ClaimsObservations()
        session = self.run_loop(
            FakeDB(),
            holder,
            clock,
            [(0.0, False), (300.0, False), (300.0, False)],
        )
        # t=1000 (first pass), t=1300 and t=1600: each 300 s past the last.
        self.assertEqual(len(session.calls), 3)


# --- The trigger wiring -------------------------------------------------------


class StatusLoopTriggerTests(unittest.TestCase):
    def run_status(self, payloads, holder, polls=None, on_wait=None):
        """Drive ``status_loop`` over payloads (dicts) or failures (exceptions)."""
        db = FakeDB()
        session = FakeSession(
            [
                item if isinstance(item, Exception) else FakeResponse(200, item)
                for item in payloads
            ]
        )
        tracker = bridge.StatusTracker(db)
        notifier = _RecordingNotifier()
        stop = _StopAfter(polls or len(payloads), on_wait)
        with mock.patch.object(bridge, "_stop", stop):
            bridge.status_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(session),
                10,
                tracker,
                notifier,
                bridge.Watchdog(
                    db,
                    _host(),
                    None,
                    bridge.ChargerTransport(FakeSession()),
                    notifier,
                    bridge.WatchdogConfig(enabled=False),
                ),
                claims=holder,
            )
        return db, session, tracker

    def test_every_applied_observation_feeds_the_holder_and_wakes_the_loop(self):
        holder = claims.ClaimsObservations()
        payload = _status_payload(state=3, vehicle=1, claims_version=7)
        self.run_status([payload, dict(payload, claims_version=8)], holder)

        snapshot = holder.snapshot()
        self.assertEqual(snapshot["state"], 3)
        self.assertEqual(snapshot["state_label"], "charging")
        self.assertEqual(snapshot["vehicle"], 1)
        self.assertEqual(snapshot["claims_version"], 8)
        self.assertTrue(holder.trigger.is_set(), "the tick wakes the claims loop")

    def test_an_absent_claims_version_leaves_the_fact_unknown(self):
        holder = claims.ClaimsObservations()
        self.run_status([_status_payload(state=1)], holder)
        self.assertIsNone(holder.snapshot()["claims_version"])
        self.assertTrue(holder.trigger.is_set())

    def test_a_landed_offline_transition_wakes_the_loop(self):
        # The failure direction of the applied-observation wake: an outage
        # that lands charger_online: false is exactly when a user asks "why
        # isn't it charging?", and the loop must answer reachable: false
        # within the debounce, not hold a stale reason for the 300 s safety
        # cadence (#159). Nothing else wakes it: no observation applied.
        holder = claims.ClaimsObservations()
        db, _, tracker = self.run_status(
            [requests.ConnectionError("gone")], holder
        )
        self.assertFalse(tracker.charger_online)  # the transition landed
        self.assertFalse(db.data["status"]["current"]["charger_online"])
        self.assertTrue(holder.trigger.is_set(), "the offline edge is a wake")

    def test_a_refailure_over_an_offline_charger_does_not_rewake(self):
        # Only the landed transition is claims-relevant: a charger already
        # flagged offline adds no new fact, so the re-failures that follow
        # leave the trigger alone (the on_wait clear stands in for the
        # claims loop consuming each tick's trigger).
        holder = claims.ClaimsObservations()
        self.run_status(
            [requests.ConnectionError("gone")] * 3,
            holder,
            on_wait=holder.trigger.clear,
        )
        self.assertFalse(holder.trigger.is_set())


class MqttWorkerTriggerTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.notifier = _RecordingNotifier()
        self.tracker = bridge.StatusTracker(self.db)
        self.tracker.seeded = True
        self.tracker.has_state = True
        self.tracker.state = 1
        self.tracker.previous_state = 1
        self.tracker.charger_online = True
        self.sink = bridge.StatusSink(self.db, self.tracker, self.notifier)
        self.snapshots = bridge.queue.Queue(maxsize=bridge.MQTT_PENDING_QUEUE)
        self.holder = claims.ClaimsObservations()

    def apply_snapshot(self, fields, arrival):
        applied = threading.Event()
        original = self.sink.apply_status

        def spy(record_fields, source, **kwargs):
            result = original(record_fields, source, **kwargs)
            applied.set()
            return result

        stop = threading.Event()
        self.snapshots.put(Snapshot(dict(fields), arrival, True))
        with mock.patch.object(bridge, "_stop", stop), mock.patch.object(
            self.sink, "apply_status", spy
        ):
            thread = threading.Thread(
                target=bridge.mqtt_status_loop,
                args=(self.sink, self.snapshots, self.holder),
                daemon=True,
            )
            thread.start()
            self.assertTrue(applied.wait(2))
            stop.set()
            thread.join(2)

    def test_a_state_transition_wakes_the_claims_loop(self):
        self.holder.note_status({"state": 1, "state_label": "ready"})
        self.holder.trigger.clear()
        self.apply_snapshot({"state": 3, "vehicle": 1}, 1)
        self.assertTrue(self.holder.trigger.is_set())

    def test_unchanged_telemetry_does_not_wake_the_claims_loop(self):
        self.holder.note_status({"state": 3, "state_label": "charging"})
        self.holder.trigger.clear()
        self.apply_snapshot({"state": 3, "amp": 15400}, 2)
        self.assertFalse(self.holder.trigger.is_set())


class ScheduleWindowFeedTests(unittest.TestCase):
    def test_the_schedule_loop_hands_the_window_to_the_claims_holder(self):
        db = FakeDB()
        tracker = bridge.StatusTracker(db)
        tracker.seeded = True
        tracker.has_state = True
        tracker.state = 1
        tracker.previous_state = 1
        tracker.charger_online = True
        sink = bridge.StatusSink(db, tracker, _RecordingNotifier())
        sink.apply_status(bridge.parse_status(_status_payload()), "http")
        holder = claims.ClaimsObservations()
        plan = {
            "current_event": {"id": 1, "state": "active", "duration": 3600},
            "next_event_delay": 600,
        }
        session = FakeSession([FakeResponse(200, plan)])
        with mock.patch.object(bridge, "_stop", _StopAfter(1)):
            bridge.schedule_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(session),
                60,
                300,
                sink,
                claims=holder,
            )
        self.assertEqual(
            holder.snapshot()["schedule"],
            {"in_window": True, "active_rule_id": None},
        )


class EvidenceIngestionTests(unittest.TestCase):
    def setUp(self):
        self.factory = FakeMqttFactory()
        self.holder = claims.ClaimsObservations()
        self.source = MqttSource(
            "192.168.0.224",
            topic="chelevse",
            on_evidence=self.holder.note_evidence,
            debounce=60,  # never fires: nothing here is a status field
            client_factory=self.factory,
            log=lambda _message: None,
        )
        self.addCleanup(self.source.stop)
        self.source.start()
        self.client = self.factory.client
        self.client.connect()

    def test_the_retained_documents_feed_the_holder(self):
        self.client.deliver(
            "chelevse/claim",
            '{"priority":500,"state":"active","charge_current":32000,'
            '"max_current":40000,"auto_release":false}',
        )
        self.client.deliver("chelevse/limit", '{"type":"soc","value":80}')
        self.client.deliver(
            "chelevse/boost",
            '{"type":"energy","value":10,"remaining":3500,'
            '"started":"2026-11-17T09:00:00Z"}',
        )
        evidence = self.holder.snapshot()["evidence"]
        self.assertEqual(
            evidence["claim"],
            {
                "priority": 500,
                "state": "active",
                "charge_current": 32000,
                "max_current": 40000,
                "auto_release": False,
            },
        )
        self.assertEqual(evidence["limit"], {"type": "soc", "value": 80})
        self.assertEqual(evidence["boost"]["remaining"], 3500)

    def test_the_retained_schedule_event_list_is_not_evidence(self):
        # Nothing consumes the retained event list: the schedule reason's
        # rule id comes from the schedule loop's plan window, so a valid
        # delivery is ignored rather than ingested.
        self.client.deliver(
            "chelevse/schedule",
            '[{"id":1,"state":"active","time":"13:00:00","days":["mon","tue"]}]',
        )
        self.assertEqual(self.holder.snapshot()["evidence"], {})

    def test_malformed_documents_are_ignored(self):
        self.holder.note_evidence("claim", {"state": "active"})
        self.client.deliver("chelevse/claim", "not json at all")
        self.client.deliver("chelevse/limit", '{"type":"bogus","value":1}')
        self.client.deliver("chelevse/boost", "{}")
        self.assertEqual(self.holder.snapshot()["evidence"], {})

    def test_a_deeply_nested_payload_is_not_a_thread_killer(self):
        # json.loads raises RecursionError -- not ValueError -- past the
        # interpreter's recursion limit, and the decode runs on the paho
        # network thread: an escapee would end loop_start()'s thread while
        # ``connected`` still reads healthy, silently degrading the bridge
        # to the HTTP reconcile. The raw-string fallback keeps the delivery
        # a non-event: not a claim document, so no evidence.
        deep = "[" * 50000 + "]" * 50000
        self.client.deliver("chelevse/claim", deep)
        self.assertEqual(self.holder.snapshot()["evidence"], {})

    def test_evidence_is_never_status(self):
        self.client.deliver("chelevse/claim", '{"state":"active"}')
        self.assertEqual(self.source.snapshot, {})
        self.assertEqual(self.source.messages, 0)
        self.source.flush()
        self.assertEqual(self.source.snapshots, 0, "nothing was buffered")


# --- The acceptance fixtures (#159) -------------------------------------------


class AcceptanceFixtures(unittest.TestCase):
    """One named fixture per scenario the issue's acceptance names."""

    def test_ac_normal_charging_has_no_restriction(self):
        derived = reason(target(), facts(vehicle=1))
        self.assertIsNone(derived["reason"])
        self.assertEqual(
            derived, {"reason": None, "winner_state": None, "winner_current": None, "detail": {}},
        )

    def test_ac_manual_pause_is_manual_override(self):
        derived = reason(
            target(state="disabled", state_claim=MANUAL),
            facts(vehicle=1, evidence={"claim": {"state": "disabled"}}),
        )
        self.assertEqual(derived["reason"], "manual_override")
        self.assertEqual(derived["winner_state"], "manual")
        self.assertEqual(derived["detail"], {"claim": {"state": "disabled"}})

    def test_ac_schedule_limited_is_schedule(self):
        derived = reason(
            target(state="disabled", state_claim=TIMER),
            facts(
                vehicle=1,
                schedule={"in_window": False, "active_rule_id": None},
            ),
        )
        self.assertEqual(derived["reason"], "schedule")
        self.assertEqual(derived["detail"], {})

    def test_ac_current_limited_is_current_limit(self):
        derived = reason(
            target(current_claim=LIMIT, charge_current=16, state="active"),
            facts(vehicle=1, evidence={"limit": {"type": "soc", "value": 80}}),
        )
        self.assertEqual(derived["reason"], "current_limit")
        self.assertEqual(derived["winner_current"], "limit")
        self.assertEqual(derived["detail"], {"limit": {"type": "soc", "value": 80}})

    def test_ac_charger_offline_is_unknown(self):
        # The status loop has flagged the charger offline; even a gateway
        # that still answers cannot make a stale arbitration current.
        derived = claims.derive_reason(
            claims.normalize_target(target(state_claim=BOOST)),
            facts(vehicle=1, charger_online=False),
        )
        self.assertEqual(derived["reason"], "unknown")

    def test_ac_stale_or_conflicting_retained_evidence_is_unknown(self):
        # No authoritative answer; the retained documents disagree with each
        # other (a paused claim beside a running boost). The reason is
        # unknown -- never one of the documents' stories.
        derived = claims.derive_reason(
            None,
            facts(
                vehicle=1,
                evidence={
                    "claim": {"state": "disabled"},
                    "boost": {"type": "energy", "value": 10, "remaining": 3500},
                    "limit": {"type": "soc", "value": 80},
                },
            ),
        )
        self.assertEqual(derived["reason"], "unknown")
        self.assertEqual(derived["detail"], {})


if __name__ == "__main__":
    unittest.main()
