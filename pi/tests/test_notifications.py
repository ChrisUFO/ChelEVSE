"""The notifications poll: persistence, the change test, and the failure paths.

One-tick fixtures over the in-memory fakes. The acceptance criterion these pin
hardest is the write economy: an unchanged poll writes nothing, so the health
document's cost is the number of real changes plus one on start-up.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402
from firebase_admin import firestore  # noqa: E402

import bridge  # noqa: E402
from fakes import (  # noqa: E402
    FakeDB,
    FakeResponse,
    FakeSession,
    _StopAfter,
    _host,
    _status_payload,
)
from test_mqtt import _RecordingNotifier  # noqa: E402

# The live gateway payload captured read-only from this charger (the advisory is
# a cleared trip kept for the record: acked, sticky:false, critical).
LIVE_PAYLOAD = {
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
CONFIG = {
    "ground_check": True,
    "relay_check": True,
    "diode_check": True,
    "vent_check": True,
    "temp_check": True,
    "over_temp_shutdown": 72,
}
RELAY_CONFIG = {
    **CONFIG,
    "relay_life_pct": 80,
    "relay_cold_open_count": 0,
    "relay_transit_drift_warning": False,
    "relay_thermal_warning_level": 0,
    "relay_stuck_recovery_count": 0,
}
COUNTERS = {"nogndcount": 7, "gfcicount": 0, "stuckcount": 0}


def payload(notifications=None):
    return {
        "count": 0,
        "max_severity": "info",
        "notifications": list(
            LIVE_PAYLOAD["notifications"] if notifications is None else notifications
        ),
    }


def advisory(advisory_id="fault.no_ground", **overrides):
    entry = {
        "id": advisory_id,
        "category": "fault",
        "severity": "critical",
        "sticky": False,
        "acked": False,
        "first_seen": 1794177153,
        "last_seen": 1794868200,
    }
    entry.update(overrides)
    return entry


def observations(state=2, counters=None, config=CONFIG, temps=(None, None, None)):
    live = bridge.LiveObservations()
    live.note_status(
        {"state": state, "temp1": temps[0], "temp2": temps[1], "temp3": temps[2]},
        dict(COUNTERS if counters is None else counters),
    )
    live.note_config(config)
    return live


class NotificationsLoopTests(unittest.TestCase):
    def run_loop(
        self,
        responses,
        polls,
        db=None,
        live=None,
        on_wait=None,
        clock=lambda: 1000.4,
        notifier=None,
    ):
        db = db if db is not None else FakeDB()
        session = FakeSession(responses)
        transport = bridge.ChargerTransport(session)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.notifications_loop(
                db,
                _host(),
                None,
                transport,
                300,
                live or observations(),
                notifier or _RecordingNotifier(),
                counter=bridge.WriteCounter(),
                clock=clock,
            )
        return db, session

    @staticmethod
    def health_writes(db):
        return [
            write
            for write in db.writes
            if write[1] == "status" and write[2] == "notifications"
        ]

    def test_the_first_poll_writes_the_projection_and_an_unchanged_poll_writes_nothing(
        self,
    ):
        db, session = self.run_loop(
            [FakeResponse(200, LIVE_PAYLOAD), FakeResponse(200, LIVE_PAYLOAD)], polls=2
        )
        writes = self.health_writes(db)

        self.assertEqual(len(writes), 1, "steady state must add zero writes")
        self.assertIs(writes[0][4], True, "the projection is a merge write")
        document = writes[0][3]
        self.assertTrue(document["reachable"])
        self.assertEqual(document["source"], "http")
        self.assertEqual(document["counters"], COUNTERS)
        self.assertEqual(
            document["gates"], {"settings_known": True, "relay_health_known": False}
        )
        (entry,) = document["advisories"]
        self.assertEqual(entry["id"], "fault.no_ground")
        self.assertEqual(entry["severity"], "critical")
        self.assertEqual(entry["classification"], "acknowledged")
        self.assertFalse(entry["firmware_sticky"])
        self.assertEqual(entry["counter_token"], 7)
        self.assertEqual(entry["first_observed"], 1000)
        self.assertEqual(document["alerted"], {})
        # `checked_at` is the comparable observation time, `updated_at` the
        # server stamp the write resolves.
        self.assertEqual(document["checked_at"], 1000)
        self.assertIs(document["updated_at"], firestore.SERVER_TIMESTAMP)
        # One charger GET per tick: the health poll needs nothing else.
        self.assertEqual(
            [call[1] for call in session.calls],
            ["http://charger/notifications"] * 2,
        )

    def test_the_projection_never_touches_status_current(self):
        db, _ = self.run_loop([FakeResponse(200, LIVE_PAYLOAD)], polls=1)
        self.assertNotIn("current", db.data.get("status", {}))

    def test_a_moving_last_seen_alone_is_not_a_change(self):
        # The gateway re-stamps `last_seen` every ~5 s for every live advisory, so
        # two polls of one unchanged advisory differ in exactly that field.
        db, _ = self.run_loop(
            [
                FakeResponse(200, payload([advisory(last_seen=1794868200)])),
                FakeResponse(200, payload([advisory(last_seen=1794868805)])),
                # The next real change still writes, and that write carries the
                # poll's own fresh `last_seen`.
                FakeResponse(
                    200, payload([advisory(last_seen=1794869410, acked=True)])
                ),
            ],
            polls=3,
        )

        writes = self.health_writes(db)
        self.assertEqual(len(writes), 2, "a re-stamped last_seen is not a change")
        self.assertEqual(writes[0][3]["advisories"][0]["last_seen"], 1794868200)
        self.assertEqual(writes[1][3]["advisories"][0]["last_seen"], 1794869410)
        self.assertEqual(
            writes[1][3]["advisories"][0]["classification"], "acknowledged"
        )

    def test_first_seen_acked_and_a_counter_move_each_still_write(self):
        # The stability view drops `last_seen` only: every other projected field
        # is still a change, whatever the payload's `last_seen` did.
        for field, changed in (
            ("first_seen", advisory(first_seen=1794177200)),
            ("acked", advisory(acked=True)),
        ):
            with self.subTest(field=field):
                db, _ = self.run_loop(
                    [
                        FakeResponse(200, payload([advisory(last_seen=1794868200)])),
                        FakeResponse(
                            200,
                            payload([{**changed, "last_seen": 1794868805}]),
                        ),
                    ],
                    polls=2,
                )
                self.assertEqual(len(self.health_writes(db)), 2)

        live = observations()

        def move_counter():
            live.note_status(
                {"state": 2, "temp1": None, "temp2": None, "temp3": None},
                {**COUNTERS, "nogndcount": 8},
            )

        times = iter([1000.4, 2000.4])
        db, _ = self.run_loop(
            [
                FakeResponse(200, payload([advisory(last_seen=1794868200)])),
                FakeResponse(200, payload([advisory(last_seen=1794868805)])),
            ],
            polls=2,
            live=live,
            on_wait=move_counter,
            clock=lambda: next(times),
        )
        writes = self.health_writes(db)
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[1][3]["advisories"][0]["counter_token"], 8)

    def test_an_ack_flip_writes_once(self):
        db, _ = self.run_loop(
            [
                FakeResponse(200, payload([advisory()])),
                FakeResponse(200, payload([advisory(acked=True)])),
                FakeResponse(200, payload([advisory(acked=True)])),
            ],
            polls=3,
        )

        writes = self.health_writes(db)
        self.assertEqual(len(writes), 2)
        self.assertEqual(
            writes[1][3]["advisories"][0]["classification"], "acknowledged"
        )

    def test_a_new_advisory_writes_once(self):
        db, _ = self.run_loop(
            [
                FakeResponse(200, payload([])),
                FakeResponse(
                    200, payload([advisory("thermal.high_temp", category="thermal")])
                ),
                FakeResponse(
                    200, payload([advisory("thermal.high_temp", category="thermal")])
                ),
            ],
            polls=3,
        )

        writes = self.health_writes(db)
        self.assertEqual(len(writes), 2)
        self.assertEqual(
            [entry["id"] for entry in writes[1][3]["advisories"]],
            ["thermal.high_temp"],
        )
        self.assertEqual(writes[0][3]["advisories"], [])

    def test_a_counter_move_writes_once_and_moves_the_token(self):
        live = observations()

        def move_counter():
            live.note_status(
                {"state": 2, "temp1": None, "temp2": None, "temp3": None},
                {**COUNTERS, "nogndcount": 8},
            )

        times = iter([1000.4, 2000.4, 3000.4])
        db, _ = self.run_loop(
            [FakeResponse(200, payload([advisory()]))] * 3,
            polls=3,
            live=live,
            on_wait=move_counter,
            clock=lambda: next(times),
        )

        writes = self.health_writes(db)
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0][3]["advisories"][0]["counter_token"], 7)
        self.assertEqual(writes[0][3]["advisories"][0]["first_observed"], 1000)
        self.assertEqual(writes[1][3]["advisories"][0]["counter_token"], 8)
        # A new counter is a new observation: the watermark moved with it.
        self.assertEqual(writes[1][3]["advisories"][0]["first_observed"], 2000)

    def test_the_gate_says_incomplete_not_healthy(self):
        db, _ = self.run_loop(
            [FakeResponse(200, payload([]))], polls=1, live=observations(config=None)
        )
        document = self.health_writes(db)[0][3]

        self.assertEqual(document["advisories"], [])
        self.assertEqual(
            document["gates"], {"settings_known": False, "relay_health_known": False}
        )


class FailurePathTests(unittest.TestCase):
    def run_loop(self, responses, polls, db=None, live=None, on_wait=None):
        db = db if db is not None else FakeDB()
        session = FakeSession(responses)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.notifications_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(session),
                300,
                live or observations(),
                _RecordingNotifier(),
                counter=bridge.WriteCounter(),
                clock=lambda: 2000.0,
            )
        return db, session

    @staticmethod
    def health_writes(db):
        return [
            write
            for write in db.writes
            if write[1] == "status" and write[2] == "notifications"
        ]

    def test_an_unreachable_poll_writes_once_and_then_stays_quiet(self):
        db, _ = self.run_loop(
            [requests.ConnectionError("down")] * 3,
            polls=3,
        )

        writes = self.health_writes(db)
        self.assertEqual(len(writes), 1)
        document = writes[0][3]
        self.assertFalse(document["reachable"])
        self.assertEqual(document["source"], "http")
        # Nothing in a failed poll may look like an empty advisory ring.
        self.assertNotIn("advisories", document)
        self.assertNotIn("gates", document)

    def test_a_recovery_writes_once(self):
        # Seed a stored unreachable projection, as a restart would find it.
        db = FakeDB(
            {
                "status": {
                    "notifications": {
                        "reachable": False,
                        "source": "http",
                        "checked_at": 1500,
                    }
                }
            }
        )
        db, _ = self.run_loop(
            [FakeResponse(200, LIVE_PAYLOAD), FakeResponse(200, LIVE_PAYLOAD)],
            polls=2,
            db=db,
        )

        writes = self.health_writes(db)
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0][3]["reachable"])

    def test_a_404_is_unsupported_and_never_implies_health(self):
        db, _ = self.run_loop([FakeResponse(404)], polls=1)

        document = self.health_writes(db)[0][3]
        self.assertFalse(document["reachable"])
        self.assertEqual(document["source"], "unsupported")
        self.assertNotIn("advisories", document)

    def test_a_payload_that_is_not_the_contract_is_unsupported(self):
        db, _ = self.run_loop([FakeResponse(200, {"count": 0})], polls=1)

        document = self.health_writes(db)[0][3]
        self.assertFalse(document["reachable"])
        self.assertEqual(document["source"], "unsupported")

    def test_a_non_json_200_is_unsupported_not_an_http_failure(self):
        db, _ = self.run_loop([FakeResponse(200, text="<html>proxy</html>")], polls=1)

        document = self.health_writes(db)[0][3]
        self.assertFalse(document["reachable"])
        self.assertEqual(document["source"], "unsupported")

    def test_a_non_2xx_is_an_unreachable_poll_not_a_404(self):
        db, _ = self.run_loop([FakeResponse(500)], polls=1)

        document = self.health_writes(db)[0][3]
        self.assertFalse(document["reachable"])
        self.assertEqual(document["source"], "http")

    def test_a_failed_write_is_retried_on_the_next_poll(self):
        db = FakeDB()
        db.fail_writes = True
        db, _ = self.run_loop(
            [FakeResponse(200, LIVE_PAYLOAD)] * 2,
            polls=2,
            db=db,
            on_wait=lambda: setattr(db, "fail_writes", False),
        )

        # The failed write was not counted as written, so the identical second
        # poll retried it instead of skipping as unchanged.
        self.assertEqual(len(self.health_writes(db)), 1)


class SeedTests(unittest.TestCase):
    """What a restart must not forget: the alert watermark and first observations."""

    def run_loop(self, db, responses, polls=1, notifier=None):
        session = FakeSession(responses)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls)):
            bridge.notifications_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(session),
                300,
                observations(),
                notifier or _RecordingNotifier(),
                counter=bridge.WriteCounter(),
                clock=lambda: 5000.0,
            )
        return [
            write
            for write in db.writes
            if write[1] == "status" and write[2] == "notifications"
        ]

    def test_the_alert_watermark_survives_a_write_pass(self):
        # The ring's own key, so the pass that writes it keeps it: pruning keeps
        # only the keys of advisories the ring still lists.
        db = FakeDB(
            {
                "status": {
                    "notifications": {
                        "reachable": True,
                        "source": "http",
                        "gates": {"settings_known": True, "relay_health_known": False},
                        "counters": COUNTERS,
                        "advisories": [],
                        "alerted": {"fault.no_ground|7": 1700000000},
                    }
                }
            }
        )
        notifier = _RecordingNotifier()
        writes = self.run_loop(db, [FakeResponse(200, LIVE_PAYLOAD)], notifier=notifier)

        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][3]["alerted"], {"fault.no_ground|7": 1700000000})
        self.assertEqual(
            db.data["status"]["notifications"]["alerted"],
            {"fault.no_ground|7": 1700000000},
        )
        # The stored advisory is the acked `fault.no_ground`: nothing to alert.
        self.assertEqual(notifier.bodies, [])

    def test_a_first_observation_survives_a_restart(self):
        stored = {
            "reachable": True,
            "source": "http",
            "gates": {"settings_known": True, "relay_health_known": False},
            "counters": COUNTERS,
            "advisories": [
                {
                    "id": "fault.no_ground",
                    "category": "fault",
                    "severity": "critical",
                    "firmware_sticky": False,
                    "acked": False,
                    "first_seen": 1794177153,
                    "last_seen": 1794868200,
                    "classification": "historical",
                    "corroborated": False,
                    "counter_token": 7,
                    "first_observed": 999,
                }
            ],
            "alerted": {"fault.no_ground|7": 1234},
        }
        db = FakeDB({"status": {"notifications": stored}})
        notifier = _RecordingNotifier()
        writes = self.run_loop(
            db, [FakeResponse(200, payload([advisory()]))], notifier=notifier
        )

        # Nothing but `checked_at` moved: the projection content is identical,
        # so the restarted loop writes nothing at all -- and, with the seeded
        # watermark, sends nothing.
        self.assertEqual(writes, [])
        self.assertEqual(notifier.bodies, [])

    def test_a_corrupt_stored_first_observation_is_ignored(self):
        stored = {
            "reachable": True,
            "advisories": [
                {"id": "fault.no_ground", "counter_token": 7, "first_observed": "soon"}
            ],
            "alerted": "not-a-map",
        }
        db = FakeDB({"status": {"notifications": stored}})
        writes = self.run_loop(db, [FakeResponse(200, payload([advisory()]))])

        document = writes[0][3]
        self.assertEqual(document["advisories"][0]["first_observed"], 5000)
        # An unreadable watermark is no watermark: the advisory is critical and
        # unacknowledged, so it alerts and the write carries the fresh key.
        self.assertEqual(document["alerted"], {"fault.no_ground|7": 5000})


class _CountingNotifier:
    """Records each body beside how many Firestore writes had already landed."""

    def __init__(self, db):
        self.db = db
        self.bodies = []
        self.writes_at_enqueue = []

    def enqueue(self, body):
        self.bodies.append(body)
        self.writes_at_enqueue.append(len(self.db.writes))


class AlertTests(unittest.TestCase):
    """The one push (#158, D9): critical, unacknowledged, newly observed only."""

    RECORDED = "Charger health: No ground recorded — see Health. Not a live fault."
    ACTIVE = "Charger health: No ground active now — see Health."

    def run_loop(
        self,
        responses,
        polls,
        db=None,
        live=None,
        on_wait=None,
        clock=lambda: 1000.4,
        notifier=None,
    ):
        db = db if db is not None else FakeDB()
        notifier = notifier if notifier is not None else _CountingNotifier(db)
        session = FakeSession(responses)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.notifications_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(session),
                300,
                live or observations(),
                notifier,
                counter=bridge.WriteCounter(),
                clock=clock,
            )
        return db, notifier

    @staticmethod
    def health_writes(db):
        return [
            write
            for write in db.writes
            if write[1] == "status" and write[2] == "notifications"
        ]

    def test_one_push_for_a_newly_observed_critical_unacked_advisory(self):
        db, notifier = self.run_loop([FakeResponse(200, payload([advisory()]))], polls=1)

        self.assertEqual(notifier.bodies, [self.RECORDED])
        (write,) = self.health_writes(db)
        # The same pass carries the watermark that silences it (D3's key).
        self.assertEqual(write[3]["alerted"], {"fault.no_ground|7": 1000})
        self.assertEqual(write[3]["advisories"][0]["classification"], "historical")

    def test_a_repeated_poll_pushes_nothing(self):
        db, notifier = self.run_loop(
            [FakeResponse(200, payload([advisory()]))] * 3, polls=3
        )

        self.assertEqual(notifier.bodies, [self.RECORDED])
        self.assertEqual(len(self.health_writes(db)), 1, "steady state: zero writes")

    def test_an_acknowledged_advisory_never_pushes(self):
        db, notifier = self.run_loop(
            [FakeResponse(200, payload([advisory(acked=True)]))], polls=1
        )

        self.assertEqual(notifier.bodies, [])
        (write,) = self.health_writes(db)
        self.assertEqual(write[3]["alerted"], {})

    def test_a_rating_below_critical_never_pushes(self):
        for severity in ("warning", "info"):
            with self.subTest(severity=severity):
                db, notifier = self.run_loop(
                    [FakeResponse(200, payload([advisory(severity=severity)]))],
                    polls=1,
                )
                self.assertEqual(notifier.bodies, [])
                self.assertEqual(self.health_writes(db)[0][3]["alerted"], {})

    def test_a_counter_move_re_alerts_and_prunes_the_old_key(self):
        live = observations()

        def move_counter():
            live.note_status(
                {"state": 2, "temp1": None, "temp2": None, "temp3": None},
                {**COUNTERS, "nogndcount": 8},
            )

        times = iter([1000.4, 2000.4])
        db, notifier = self.run_loop(
            [FakeResponse(200, payload([advisory()]))] * 2,
            polls=2,
            live=live,
            on_wait=move_counter,
            clock=lambda: next(times),
        )

        # A new trip moves the controller counter, which voids the ack: that is
        # a new D3 key, so it alerts again.
        self.assertEqual(notifier.bodies, [self.RECORDED, self.RECORDED])
        writes = self.health_writes(db)
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[1][3]["advisories"][0]["counter_token"], 8)
        # The old key is gone from the write *and* from the stored map (the
        # merge would otherwise keep it forever).
        self.assertEqual(writes[1][3]["alerted"]["fault.no_ground|8"], 2000)
        self.assertIs(writes[1][3]["alerted"]["fault.no_ground|7"], firestore.DELETE_FIELD)
        self.assertEqual(
            db.data["status"]["notifications"]["alerted"],
            {"fault.no_ground|8": 2000},
        )

    def test_the_watermark_is_pruned_when_the_advisory_leaves_the_ring(self):
        db, notifier = self.run_loop(
            [
                FakeResponse(200, payload([advisory()])),
                FakeResponse(200, payload([])),
            ],
            polls=2,
        )

        self.assertEqual(notifier.bodies, [self.RECORDED])
        writes = self.health_writes(db)
        self.assertEqual(writes[0][3]["alerted"], {"fault.no_ground|7": 1000})
        # The advisory left the ring, so its key goes: the map stays bounded by
        # the ring instead of growing for the life of the bridge.
        self.assertEqual(writes[1][3]["alerted"], {})

    def test_a_pass_without_the_facts_defers_the_alert_and_keeps_the_watermark(self):
        # A cold holder: the notifications poll can run before the first
        # *applied* `/status` observation (an HTTP reply overtaken by an MQTT
        # snapshot is discarded), so the counter token is unknown. That state
        # has no stable dedupe key, so it must push nothing and must not prune
        # the seeded key it cannot re-derive.
        live = bridge.LiveObservations()

        def feed():
            live.note_status(
                {"state": 2, "temp1": None, "temp2": None, "temp3": None},
                dict(COUNTERS),
            )
            live.note_config(CONFIG)

        db = FakeDB(
            {
                "status": {
                    "notifications": {
                        "reachable": False,
                        "source": "http",
                        "alerted": {"fault.gfci_tripped|3": 500},
                    }
                }
            }
        )
        times = iter([2000.4, 3000.4])
        db, notifier = self.run_loop(
            [FakeResponse(200, payload([advisory()]))] * 2,
            polls=2,
            db=db,
            live=live,
            on_wait=feed,
            clock=lambda: next(times),
        )

        # The pass with the counters alerted once, on the real key, and the
        # last write had landed when it was queued.
        self.assertEqual(notifier.bodies, [self.RECORDED])
        self.assertEqual(notifier.writes_at_enqueue, [2])
        # The deferred pass wrote the projection but kept the seeded watermark:
        # it did not key on `fault.no_ground|None` and did not prune a key it
        # could not re-derive.
        cold = self.health_writes(db)[0][3]
        self.assertEqual(cold["alerted"], {"fault.gfci_tripped|3": 500})
        self.assertEqual(
            db.data["status"]["notifications"]["alerted"]["fault.no_ground|7"], 3000
        )

    def test_a_partial_prune_deletes_the_stale_key_from_the_stored_document(self):
        # `set(merge=True)` deep-merges maps, so a key omitted from `alerted`
        # would stay in Firestore for the life of the install -- and a restart
        # would seed it back, silencing a key the running bridge had pruned.
        # The departed key is named by the delete sentinel, so the stored map
        # stays bounded by the ring even when it does not empty outright.
        other = advisory("fault.gfci_tripped")
        db, notifier = self.run_loop(
            [
                FakeResponse(200, payload([advisory(), other])),
                FakeResponse(200, payload([other])),
            ],
            polls=2,
        )

        self.assertEqual(len(notifier.bodies), 2, "one push per advisory")
        writes = self.health_writes(db)
        self.assertEqual(
            writes[0][3]["alerted"],
            {"fault.no_ground|7": 1000, "fault.gfci_tripped|0": 1000},
        )
        second = writes[1][3]["alerted"]
        self.assertIs(second["fault.no_ground|7"], firestore.DELETE_FIELD)
        self.assertEqual(second["fault.gfci_tripped|0"], 1000)
        # What a restart would seed: only the live ring's key survives.
        self.assertEqual(
            db.data["status"]["notifications"]["alerted"],
            {"fault.gfci_tripped|0": 1000},
        )

    def test_the_watermark_is_written_before_the_push(self):
        db = FakeDB()
        notifier = _CountingNotifier(db)
        self.run_loop(
            [FakeResponse(200, payload([advisory()]))] * 2,
            polls=2,
            db=db,
            notifier=notifier,
        )

        # One push, and the write that carries its watermark had already landed
        # when it was queued: a crash after this point cannot alert twice.
        self.assertEqual(notifier.bodies, [self.RECORDED])
        self.assertEqual(notifier.writes_at_enqueue, [1])
        self.assertEqual(self.health_writes(db)[0][3]["alerted"], {"fault.no_ground|7": 1000})

    def test_a_failed_write_sends_nothing_and_the_next_poll_alerts_once(self):
        db = FakeDB()
        db.fail_writes = True
        _, notifier = self.run_loop(
            [FakeResponse(200, payload([advisory()]))] * 2,
            polls=2,
            db=db,
            on_wait=lambda: setattr(db, "fail_writes", False),
        )

        self.assertEqual(notifier.bodies, [self.RECORDED])
        self.assertEqual(self.health_writes(db)[0][3]["alerted"], {"fault.no_ground|7": 1000})

    def test_a_failed_poll_keeps_the_watermark_and_pushes_nothing(self):
        db = FakeDB()
        db, notifier = self.run_loop(
            [
                FakeResponse(200, payload([advisory()])),
                requests.ConnectionError("down"),
            ],
            polls=2,
            db=db,
        )

        self.assertEqual(notifier.bodies, [self.RECORDED])
        # The outage write is the transition only; the merge leaves `alerted`
        # exactly as the successful poll wrote it.
        self.assertEqual(
            db.data["status"]["notifications"]["alerted"], {"fault.no_ground|7": 1000}
        )

    def test_a_corroborated_advisory_reads_as_active_now(self):
        # State 7 is the controller's own proof that the ground fault is present
        # now, so the body must not call it a record.
        db, notifier = self.run_loop(
            [FakeResponse(200, payload([advisory()]))],
            polls=1,
            live=observations(state=7),
        )

        self.assertEqual(notifier.bodies, [self.ACTIVE])
        entry = self.health_writes(db)[0][3]["advisories"][0]
        self.assertEqual(entry["classification"], "active")


class ObservationWiringTests(unittest.TestCase):
    """The holder is fed by the loops that already have the data (D6)."""

    def test_the_status_loop_feeds_the_holder(self):
        db = FakeDB()
        host = _host()
        session = FakeSession(
            [
                FakeResponse(
                    200,
                    _status_payload(state=7, nogndcount=7, gfcicount=1, stuckcount=2),
                )
            ]
        )
        transport = bridge.ChargerTransport(session)
        notifier = bridge.Notifier(db)
        live = bridge.LiveObservations()

        with mock.patch.object(bridge, "_stop", _StopAfter(1)):
            bridge.status_loop(
                db,
                host,
                None,
                transport,
                10,
                bridge.StatusTracker(db),
                notifier,
                bridge.Watchdog(
                    db,
                    host,
                    None,
                    transport,
                    notifier,
                    bridge.WatchdogConfig(enabled=False),
                ),
                observations=live,
            )

        facts = live.snapshot()
        self.assertEqual(facts["state"], 7)
        self.assertEqual(
            facts["counters"], {"nogndcount": 7, "gfcicount": 1, "stuckcount": 2}
        )

    def test_the_config_loop_feeds_the_written_view(self):
        db = FakeDB()
        session = FakeSession([FakeResponse(200, CONFIG)])
        live = bridge.LiveObservations()

        with mock.patch.object(bridge, "_stop", _StopAfter(1)):
            bridge.config_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(session),
                60,
                observations=live,
            )

        self.assertEqual(live.snapshot()["config"], CONFIG)

    def test_a_failed_config_write_does_not_feed_the_holder(self):
        db = FakeDB()
        db.fail_writes = True
        live = bridge.LiveObservations()

        with mock.patch.object(bridge, "_stop", _StopAfter(1)):
            bridge.config_loop(
                db,
                _host(),
                None,
                bridge.ChargerTransport(FakeSession([FakeResponse(200, CONFIG)])),
                60,
                observations=live,
            )

        # status/config still holds whatever it held; the health projection
        # must not classify against a view that never landed.
        self.assertIsNone(live.snapshot()["config"])


if __name__ == "__main__":
    unittest.main()
