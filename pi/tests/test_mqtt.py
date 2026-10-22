"""Unit tests for the MQTT status source and its bridge integration (#44).

No broker, charger, Firestore or FCM is touched: the MQTT client, HTTP session
and Firestore are the in-memory fakes from ``fakes.py``.
"""

import os
import sys
import threading
import time
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

import bridge  # noqa: E402
from fakes import FakeDB, FakeMqttFactory, FakeResponse, FakeSession  # noqa: E402
from mqtt_source import MqttSource, Snapshot, TOPIC_FIELDS  # noqa: E402


class _RecordingNotifier:
    def __init__(self):
        self.bodies = []

    def enqueue(self, body):
        self.bodies.append(body)


class _RecordingWatchdog:
    def __init__(self):
        self.successes = 0
        self.failures = 0

    def record_success(self, _payload):
        self.successes += 1

    def observe_failure(self, _charging):
        self.failures += 1


class _StopAfter:
    """Stop-event stand-in that ends the loop after N waits."""

    def __init__(self, polls, on_wait=None):
        self._polls = polls
        self._waited = 0
        self._on_wait = on_wait

    def is_set(self):
        return self._waited >= self._polls

    def wait(self, _interval):
        self._waited += 1
        if self._on_wait is not None:
            self._on_wait()
        return True


class _HookedSession(FakeSession):
    """FakeSession that runs ``hook(url)`` before answering (in-flight work)."""

    def __init__(self, responses=None, hook=None):
        super().__init__(responses)
        self.hook = hook

    def get(self, url, **kwargs):
        if self.hook is not None:
            self.hook(url)
        return super().get(url, **kwargs)


def wait_for(predicate, timeout=5):
    """Bound a test's wait on another thread (raises instead of hanging)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition not reached")


class _ReasonCode:
    """The bits of paho's ReasonCode the source reads."""

    def __init__(self, value, name=None):
        self.value = value
        self.is_failure = bool(value)
        self._name = name

    def getName(self):
        return self._name


def status_payload(**overrides):
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
        "rapi_connected": 1,
        "evse_connected": 1,
    }
    payload.update(overrides)
    return payload


class MqttSourceBase(unittest.TestCase):
    def setUp(self):
        self.factory = FakeMqttFactory()
        self.snapshots = []
        self.versions = []
        self.logs = []
        self.source = MqttSource(
            "192.168.0.224",
            1883,
            "chelevse",
            user="chelevse",
            password="secret",
            client_id="test-bridge",
            on_status=self.snapshots.append,
            on_config_version=self.versions.append,
            debounce=60,  # never fires: the tests flush by hand
            client_factory=self.factory,
            log=self.logs.append,
        )
        self.addCleanup(self.source.stop)

    def connect(self):
        self.source.start()
        client = self.factory.client
        client.connect()
        return client


class MqttSourceTests(MqttSourceBase):
    def test_start_connects_subscribes_and_authenticates(self):
        client = self.connect()
        self.assertEqual(client.connect_args, ("192.168.0.224", 1883, 60))
        self.assertEqual(client.credentials, ("chelevse", "secret"))
        self.assertEqual(client.reconnect_delay, (1, 30))
        self.assertTrue(client.looping)
        self.assertEqual(
            client.subscriptions,
            [("chelevse/#", 0), ("openevse/announce/#", 0)],
        )
        self.assertTrue(self.source.connected)
        self.source.stop()
        self.assertFalse(self.source.connected)
        self.assertTrue(client.disconnected)

    def test_reconnect_resubscribes(self):
        client = self.connect()
        client.drop()
        self.assertFalse(self.source.connected)
        client.connect()
        self.assertTrue(self.source.connected)
        self.assertEqual(
            client.subscriptions, [("chelevse/#", 0), ("openevse/announce/#", 0)] * 2
        )

    def test_topic_mapping_reaches_the_status_contract(self):
        client = self.connect()
        client.deliver("chelevse/amp", 15400)
        client.deliver("chelevse/session_elapsed", 65)
        client.deliver("chelevse/temp1", 247)
        client.deliver("chelevse/state", 3)
        client.deliver("chelevse/vehicle", 1)
        client.deliver("chelevse/power", 3800)
        self.assertEqual(self.snapshots, [])
        self.source.flush()
        self.assertEqual(len(self.snapshots), 1)
        fields = bridge.parse_status(self.snapshots[0].fields)
        self.assertEqual(fields["amp"], 15.4)  # milliamps -> amps
        self.assertEqual(fields["elapsed"], 65)  # session_elapsed -> elapsed
        self.assertEqual(fields["temp1"], 24.7)  # 10ths of °C
        self.assertEqual(fields["state"], 3)
        self.assertEqual(fields["state_label"], "charging")
        self.assertEqual(fields["vehicle"], 1)
        self.assertEqual(fields["power"], 3800)

    def test_all_mapped_topics_land_on_their_status_key(self):
        client = self.connect()
        for index, (leaf, field) in enumerate(TOPIC_FIELDS.items()):
            client.deliver(f"chelevse/{leaf}", index)
        self.source.flush()
        snapshot = self.snapshots[0].fields
        for index, field in enumerate(TOPIC_FIELDS.values()):
            self.assertEqual(snapshot[field], index, field)

    def test_debounce_coalesces_a_burst_into_one_snapshot(self):
        client = self.connect()
        client.deliver("chelevse/state", 3)
        client.deliver("chelevse/amp", 6000)
        client.deliver("chelevse/voltage", 238)
        self.assertEqual(self.source.messages, 3)
        self.source.flush()
        self.source.flush()  # nothing left to deliver
        self.assertEqual(
            self.snapshots[0].fields,
            {"state": 3, "amp": 6000, "voltage": 238},
        )
        self.assertEqual(len(self.snapshots), 1)

    def test_timer_flushes_the_buffer_once(self):
        self.source.debounce = 0.02
        client = self.connect()
        client.deliver("chelevse/state", 2)
        deadline = time.monotonic() + 2
        while not self.snapshots and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertEqual([record.fields for record in self.snapshots], [{"state": 2}])

    def test_a_delivery_carries_its_arrival_and_flush_time_completeness(self):
        # The worker may run long after the flush: both facts must be frozen
        # with the payload, not re-read from the source later.
        client = self.connect()
        client.deliver("chelevse/amp", 6000)
        self.source.flush()
        self.assertFalse(self.snapshots[0].complete)  # no /status seed yet
        self.assertEqual(self.snapshots[0].arrival, 1)
        self.source.seed(status_payload())
        client.deliver("chelevse/amp", 7000)
        self.source.flush()
        self.assertTrue(self.snapshots[1].complete)
        self.assertEqual(self.snapshots[1].arrival, 2)

    def test_seed_keeps_fields_the_firmware_never_publishes(self):
        client = self.connect()
        self.source.seed(status_payload())
        client.deliver("chelevse/amp", 7000)
        self.source.flush()
        snapshot = self.snapshots[0].fields
        for key in ("comm_sent", "comm_success", "rapi_connected", "voltage"):
            self.assertEqual(snapshot[key], status_payload()[key])
        self.assertEqual(snapshot["amp"], 7000)

    def test_seed_if_current_rejects_a_reply_overtaken_by_a_flush(self):
        # The compare and the merge are one critical section: a flush between
        # the caller's freshness read and the seed must not be overwritten.
        client = self.connect()
        generation = self.source.arrival_generation()
        client.deliver("chelevse/state", 2)
        self.source.flush()
        self.assertFalse(
            self.source.seed_if_current(generation, status_payload(comm_sent=99))
        )
        self.assertNotIn("comm_sent", self.source.snapshot)
        self.assertEqual(self.source.snapshot["state"], 2)
        self.assertFalse(self.source.seeded)

    def test_seed_if_current_merges_when_nothing_arrived(self):
        generation = self.source.arrival_generation()
        self.assertTrue(self.source.seed_if_current(generation, status_payload()))
        self.assertTrue(self.source.seeded)
        self.assertEqual(self.source.snapshot["comm_sent"], 10)

    def test_unmapped_topics_are_ignored(self):
        client = self.connect()
        for topic in (
            "chelevse/config",
            "chelevse/config_version_extra",
            "chelevse/override/set",
            "chelevse/rapi/out",
            "chelevse/limit",
            "chelevse/elapsed",  # deprecated; session_elapsed is the source
            "othertopic/amp",
        ):
            client.deliver(topic, 42)
        self.assertEqual(self.source.messages, 0)
        self.source.flush()
        self.assertEqual(self.snapshots, [])

    def test_config_version_fires_once_per_change(self):
        client = self.connect()
        client.deliver("chelevse/config_version", 3)
        client.deliver("chelevse/config_version", 3)
        client.deliver("chelevse/config_version", 4)
        self.assertEqual(self.versions, [3, 4])
        self.assertEqual(self.source.config_version, 4)
        self.assertEqual(self.source.messages, 0)

    def test_the_last_will_marks_the_gateway_gone_and_a_reconnect_clears_it(self):
        client = self.connect()
        client.ack_subscribe([0])
        self.assertIsNone(self.source.announced)  # nothing announced yet
        self.assertIsNone(self.source.last_lwt_at)
        client.deliver("openevse/announce/3988", '{"state":"connected"}')
        self.assertTrue(self.source.announced)
        self.assertIsNone(self.source.last_lwt_at)
        client.deliver("openevse/announce/3988", '{"state":"disconnected"}')
        self.assertFalse(self.source.announced)
        self.assertIsNotNone(self.source.last_lwt_at)
        self.assertEqual(self.source.announce_messages, 2)
        # Our own link is untouched: the broker is fine, the gateway is not.
        self.assertTrue(self.source.connected)
        self.assertTrue(self.source.mqtt_ready)
        # A reconnect re-announces and clears the Last Will state.
        client.deliver("openevse/announce/3988", '{"state":"connected"}')
        self.assertTrue(self.source.announced)

    def test_a_redelivered_retained_will_does_not_move_last_lwt_at(self):
        # The will is retained, so a re-subscribe (our own broker link blipping)
        # redelivers it while the gateway is still gone. The timestamp must keep
        # saying when the Last Will fired, not when we reconnected.
        client = self.connect()
        client.ack_subscribe([0])
        client.deliver("openevse/announce/3988", '{"state":"disconnected"}')
        self.assertIsNotNone(self.source.last_lwt_at)
        fired = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
        self.source.last_lwt_at = fired
        client.drop()
        client.connect()
        client.ack_subscribe([0])
        client.deliver("openevse/announce/3988", '{"state":"disconnected"}')
        self.assertIs(self.source.last_lwt_at, fired)
        self.assertFalse(self.source.announced)
        self.assertEqual(self.source.announce_messages, 2)
        # A later, genuinely new will is still stamped.
        client.deliver("openevse/announce/3988", '{"state":"connected"}')
        client.deliver("openevse/announce/3988", '{"state":"disconnected"}')
        self.assertNotEqual(self.source.last_lwt_at, fired)

    def test_an_announce_without_a_known_state_is_ignored(self):
        client = self.connect()
        for payload in ('{"state":"booting"}', '{"other":1}', "42", "", '{"state":1}'):
            client.deliver("openevse/announce/3988", payload)
        self.assertIsNone(self.source.announced)
        self.assertEqual(self.source.announce_messages, 0)
        self.assertEqual(self.source.messages, 0)

    def test_the_announce_topic_is_configurable(self):
        factory = FakeMqttFactory()
        source = MqttSource(
            "192.168.0.224",
            topic="chelevse",
            announce_topic="home/evse/status/#",
            client_factory=factory,
            log=self.logs.append,
        )
        self.addCleanup(source.stop)
        source.start()
        client = factory.client
        client.connect()
        self.assertEqual(
            client.subscriptions,
            [("chelevse/#", 0), ("home/evse/status/#", 0)],
        )
        client.deliver("home/evse/status/1", '{"state":"disconnected"}')
        self.assertFalse(source.announced)
        # A topic outside the configured filter is not an announce.
        client.deliver("openevse/announce/3988", '{"state":"connected"}')
        self.assertFalse(source.announced)


class MqttSourceLoggingTests(MqttSourceBase):
    """A refused CONNACK or SUBACK must name itself in the journal."""

    def test_a_refused_connack_is_logged_and_never_subscribes(self):
        self.source.start()
        client = self.factory.client
        client.connect(_ReasonCode(5, "Not authorized"))
        self.assertEqual(client.subscriptions, [])
        self.assertFalse(self.source.subscribed)
        self.assertEqual(self.source.connect_failures, 1)
        self.assertTrue(any("connect refused" in line for line in self.logs))
        self.assertTrue(any("Not authorized" in line for line in self.logs))

    def test_an_unreachable_broker_is_logged(self):
        self.source.start()
        self.factory.client.fail_connect()
        self.assertEqual(self.source.connect_failures, 1)
        self.assertTrue(any("connect failed" in line for line in self.logs))

    def test_a_denied_subscription_is_logged(self):
        client = self.connect()
        client.ack_subscribe([_ReasonCode(128, "Unspecified error")])
        self.assertFalse(self.source.subscribed)
        self.assertTrue(any("subscription denied" in line for line in self.logs))

    def test_a_granted_subscription_is_recorded_until_the_drop(self):
        client = self.connect()
        client.ack_subscribe([0])
        self.assertTrue(self.source.subscribed)
        self.assertNotIn("subscription denied", " ".join(self.logs))
        client.drop(_ReasonCode(7, "Connection lost"))
        self.assertFalse(self.source.subscribed)
        self.assertTrue(any("mqtt disconnected" in line for line in self.logs))
        self.assertTrue(any("Connection lost" in line for line in self.logs))

    def test_a_denied_announce_subscription_keeps_the_status_source(self):
        client = self.connect()
        # Mid 1 is the status subscription, mid 2 the announce one.
        client.ack_subscribe([0], mid=1)
        client.ack_subscribe([_ReasonCode(128, "Unspecified error")], mid=2)
        self.assertTrue(self.source.subscribed)
        self.assertFalse(self.source.announce_subscribed)
        self.assertTrue(
            any("announce subscription denied" in line for line in self.logs)
        )
        self.assertNotIn("mqtt subscription denied", " ".join(self.logs))

    def test_a_granted_announce_subscription_is_logged_once(self):
        client = self.connect()
        client.ack_subscribe([0], mid=1)
        client.ack_subscribe([0], mid=2)
        client.ack_subscribe([0], mid=2)  # a duplicate grant does not re-log
        self.assertTrue(self.source.announce_subscribed)
        self.assertEqual(
            [line for line in self.logs if "announce subscribed" in line],
            ["mqtt announce subscribed (openevse/announce/#)"],
        )


class MqttConfigTests(unittest.TestCase):
    def parse(self, **env):
        with mock.patch.dict(bridge._FILE_ENV, {}, clear=True), mock.patch.dict(
            os.environ, env, clear=True
        ):
            return bridge.mqtt_config()

    def test_defaults_are_off(self):
        config = self.parse()
        self.assertFalse(config.enabled)
        self.assertEqual(config.topic, "chelevse")
        self.assertEqual(config.port, 1883)
        self.assertEqual(config.reconcile_sec, 60)
        self.assertEqual(config.client_id, "chelevse-bridge")
        self.assertEqual(config.announce_topic, "openevse/announce/#")
        self.assertEqual(config, bridge.MqttConfig())

    def test_overrides(self):
        config = self.parse(
            MQTT_ENABLED="true",
            MQTT_HOST="192.168.0.224",
            MQTT_PORT="1884",
            MQTT_USER="chelevse",
            MQTT_PASS="secret",
            MQTT_TOPIC="/chelevse/",
            MQTT_RECONCILE_SEC="120",
            MQTT_CLIENT_ID="bridge-1",
            MQTT_ANNOUNCE_TOPIC="home/evse/status/#",
        )
        self.assertTrue(config.enabled)
        self.assertEqual(config.host, "192.168.0.224")
        self.assertEqual(config.port, 1884)
        self.assertEqual(config.user, "chelevse")
        self.assertEqual(config.password, "secret")
        self.assertEqual(config.topic, "chelevse")
        self.assertEqual(config.reconcile_sec, 120)
        self.assertEqual(config.client_id, "bridge-1")
        self.assertEqual(config.announce_topic, "home/evse/status/#")

    def test_enabled_without_a_host_fails_loudly(self):
        with self.assertRaises(ValueError) as raised:
            self.parse(MQTT_ENABLED="true")
        self.assertIn("MQTT_HOST", str(raised.exception))

    def test_bad_values_name_their_variable(self):
        cases = (
            ("MQTT_ENABLED", "maybe"),
            ("MQTT_PORT", "0"),
            ("MQTT_PORT", "70000"),
            ("MQTT_RECONCILE_SEC", "nan"),
            ("MQTT_RECONCILE_SEC", "0"),
            ("MQTT_TOPIC", " "),
        )
        for name, value in cases:
            with self.subTest(variable=name, value=value), self.assertRaises(
                ValueError
            ) as raised:
                self.parse(**{name: value})
            self.assertIn(name, str(raised.exception))


class StatusSinkTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.notifier = _RecordingNotifier()
        self.tracker = bridge.StatusTracker(self.db)
        self.tracker.seeded = True
        # A stored baseline, as after a bridge start: the first tick of a run
        # establishes state and never notifies, so tests start from state 1.
        self.tracker.has_state = True
        self.tracker.state = 1
        self.tracker.previous_state = 1
        self.tracker.charger_online = True
        self.sink = bridge.StatusSink(self.db, self.tracker, self.notifier)

    def apply(self, payload, source):
        self.sink.apply_status(bridge.parse_status(payload), source)

    def test_same_transition_from_both_sources_notifies_once(self):
        self.apply(status_payload(state=3, total_energy=100), "http")
        self.apply(status_payload(state=3, total_energy=110), "mqtt")
        self.assertEqual(self.notifier.bodies, ["Charging started"])
        self.apply(status_payload(state=1, total_energy=110), "mqtt")
        self.apply(status_payload(state=1, total_energy=110), "http")
        self.assertEqual(
            self.notifier.bodies, ["Charging started", "Charging stopped"]
        )

    def test_a_repeated_snapshot_does_not_double_count_history(self):
        self.apply(status_payload(total_energy=100), "http")
        self.apply(status_payload(total_energy=110), "mqtt")
        self.apply(status_payload(total_energy=110), "http")
        # No flush point fired yet, so the delta is still pending -- but it
        # is pending exactly once however often the unchanged reading lands.
        self.assertEqual(self.tracker.history.pending_kwh, 10.0)
        self.tracker.history.flush("shutdown")
        (day,) = self.db.data["history"]
        self.assertAlmostEqual(self.db.data["history"][day]["kwh"], 10.0)

    def test_a_stale_http_response_cannot_reopen_a_closed_session(self):
        # The exact race: charging, an MQTT stop, then the reconcile reply that
        # was generated before the stop. Its state=3 must not re-fire an edge.
        self.apply(status_payload(state=3, session_energy=6000, elapsed=3600), "mqtt")
        mark = self.sink.mqtt_generation()
        self.apply(status_payload(state=1, session_energy=6000, elapsed=3600), "mqtt")
        applied = self.sink.apply_status(
            bridge.parse_status(status_payload(state=3, session_energy=6000)),
            "http",
            mqtt_mark=mark,
        )
        self.assertFalse(applied)
        self.assertEqual(
            self.notifier.bodies, ["Charging started", "Charging stopped"]
        )
        self.assertEqual(len(self.db.data["sessions"]), 1)
        self.assertEqual(self.tracker.state, 1)

    def test_an_http_apply_with_no_mqtt_apply_in_between_is_kept(self):
        mark = self.sink.mqtt_generation()
        applied = self.sink.apply_status(
            bridge.parse_status(status_payload(state=3)), "http", mqtt_mark=mark
        )
        self.assertTrue(applied)
        self.assertEqual(self.notifier.bodies, ["Charging started"])

    def test_consecutive_http_applies_with_a_quiet_source_all_apply(self):
        # The HTTP path passes the arrival it read before its GET as its own
        # arrival. With no flush in between that equals the watermark the
        # previous reply recorded -- the ordinary idle charger, and the whole
        # HTTP fallback -- yet the reply is still the newest observation that
        # exists, so every poll has to apply. The document write is the write
        # policy's business (issue #93): total_energy is continuous, so only
        # the first apply publishes; the tracker still sees every value.
        for energy in (100, 110, 120):
            applied = self.sink.apply_status(
                bridge.parse_status(status_payload(total_energy=energy)),
                "http",
                mqtt_mark=self.sink.mqtt_generation(),
                arrival=0,
            )
            self.assertTrue(applied, energy)
        self.assertEqual(self.tracker.total_energy, 120)
        self.assertEqual(
            [write[3]["total_energy"] for write in self.db.writes
             if write[1] == "status" and write[2] == "current"],
            [100],
        )

    def test_the_watermark_gates_records_not_the_reconcile_reply(self):
        # A reconcile records its arrival, so a snapshot flushed at or before
        # that arrival describes the charger no later than the reply does and is
        # dropped when the worker reaches it; one flushed afterwards is newer and
        # applies.
        self.assertTrue(
            self.sink.apply_status(
                bridge.parse_status(status_payload(state=1, total_energy=100)),
                "http",
                arrival=2,
            )
        )
        for stale in (1, 2):
            self.assertFalse(
                self.sink.apply_status(
                    bridge.parse_status(status_payload(state=1, total_energy=110)),
                    "mqtt",
                    arrival=stale,
                ),
                stale,
            )
        self.assertTrue(
            self.sink.apply_status(
                bridge.parse_status(status_payload(state=1, total_energy=120)),
                "mqtt",
                arrival=3,
            )
        )
        # The dropped records never reached the tracker either; the applied one
        # did. The document carries only the first (published) write --
        # total_energy is continuous and never triggers one (issue #93).
        self.assertEqual(self.tracker.total_energy, 120)
        self.assertEqual(
            [write[3]["total_energy"] for write in self.db.writes
             if write[1] == "status" and write[2] == "current"],
            [100],
        )

    def test_a_partial_snapshot_only_merges_its_fields(self):
        # No /status seed and the tracker charging: an amp-only snapshot must
        # not read as "not charging" (a false stop, a bogus session, and the
        # loss of the charging guard).
        self.tracker.previous_state = 3
        self.tracker.state = 3
        self.tracker.last_charging_energy = 6000
        self.tracker.last_charging_elapsed = 3600
        self.sink.apply_status(
            bridge.parse_snapshot({"amp": 15400}), "mqtt", complete=False
        )
        self.assertEqual(self.notifier.bodies, [])
        self.assertNotIn("sessions", self.db.data)
        self.assertEqual(self.tracker.state, 3)
        self.assertEqual(self.tracker.previous_state, 3)
        self.assertEqual(self.db.data["status"]["current"]["amp"], 15.4)

    def test_the_seed_and_the_apply_are_one_locked_decision(self):
        # The seed used to run under its own lock acquisition, so an MQTT apply
        # could land between the staleness check and the apply, leaving a seed
        # older than that apply behind for the next flush. It now runs inside
        # the apply's critical section: the worker waits, then applies after it.
        mark = self.sink.mqtt_generation()
        seeding = threading.Event()
        release = threading.Event()
        seeds = []

        def seed():
            seeds.append("seed")
            seeding.set()
            release.wait(2)  # the apply lock is held for the whole seed

        outcome = []
        http = threading.Thread(
            target=lambda: outcome.append(
                self.sink.apply_status(
                    bridge.parse_status(status_payload(state=1)),
                    "http",
                    mqtt_mark=mark,
                    seed=seed,
                )
            ),
            daemon=True,
        )
        http.start()
        self.assertTrue(seeding.wait(2))

        applied = threading.Event()

        def apply_live():
            self.sink.apply_status(
                bridge.parse_status(status_payload(state=3, total_energy=110)), "mqtt"
            )
            applied.set()

        worker = threading.Thread(target=apply_live, daemon=True)
        worker.start()
        self.assertFalse(applied.wait(0.05))  # cannot land while the seed runs
        release.set()
        self.assertTrue(applied.wait(2))
        http.join(2)
        worker.join(2)
        self.assertEqual(seeds, ["seed"])
        self.assertEqual(outcome, [True])
        # The HTTP reply was applied first (its seed was still current), then
        # the live snapshot: exactly one edge, no torn ordering.
        self.assertEqual(self.notifier.bodies, ["Charging started"])
        self.assertEqual(self.tracker.state, 3)

    def test_the_offline_edge_cannot_interleave_with_an_apply(self):
        # The offline transition used to run outside the sink lock: an MQTT
        # flush landing mid-transition could leave the tracker online and the
        # document offline. It now shares the lock, so the apply waits.
        real_doc = self.sink.status_doc
        writing = threading.Event()
        release = threading.Event()

        class _BlockingDoc:
            def set(self, data, merge=False):
                writing.set()
                release.wait(2)
                real_doc.set(data, merge=merge)

        self.sink.status_doc = _BlockingDoc()
        offline = threading.Thread(
            target=self.sink.apply_offline, args=("blackholed",), daemon=True
        )
        offline.start()
        self.assertTrue(writing.wait(2))
        self.assertFalse(self.tracker.charger_online)  # in effect before the doc

        applied = threading.Event()

        def apply_live():
            self.sink.apply_status(
                bridge.parse_status(status_payload(state=1)), "mqtt"
            )
            applied.set()

        worker = threading.Thread(target=apply_live, daemon=True)
        worker.start()
        self.assertFalse(applied.wait(0.05))  # cannot land mid-offline-write
        release.set()
        self.assertTrue(applied.wait(2))
        offline.join(2)
        worker.join(2)
        # Whichever runs last owns both halves: the live snapshot restores the
        # tracker and the document together.
        self.assertTrue(self.tracker.charger_online)
        self.assertTrue(self.db.data["status"]["current"]["charger_online"])
        self.assertEqual(self.notifier.bodies, ["Charger offline"])


class MqttWorkerBase(unittest.TestCase):
    """The production path: raw topic values -> parse -> apply -> document."""

    def setUp(self):
        self.db = FakeDB()
        self.factory = FakeMqttFactory()
        self.notifier = _RecordingNotifier()
        self.tracker = bridge.StatusTracker(self.db)
        self.tracker.seeded = True
        self.tracker.has_state = True
        self.tracker.state = 1
        self.tracker.previous_state = 1
        self.tracker.charger_online = True
        self.sink = bridge.StatusSink(self.db, self.tracker, self.notifier)
        self.snapshots = bridge.queue.Queue(maxsize=bridge.MQTT_PENDING_QUEUE)
        self.source = MqttSource(
            "192.168.0.224",
            topic="chelevse",
            on_status=lambda record: bridge.enqueue_latest(self.snapshots, record),
            debounce=60,  # never fires: the tests flush by hand
            client_factory=self.factory,
            log=lambda _message: None,
        )
        self.addCleanup(self.source.stop)
        self.source.start()
        self.client = self.factory.client
        self.client.connect()

    def run_worker(self, applied=1):
        """Apply queued snapshots on the worker until ``applied`` have landed."""
        stop = threading.Event()
        with mock.patch.object(bridge, "_stop", stop):
            thread = threading.Thread(
                target=bridge.mqtt_status_loop,
                args=(self.sink, self.snapshots),
                daemon=True,
            )
            thread.start()
            try:
                wait_for(lambda: len(self.current_writes()) >= applied)
            finally:
                stop.set()
                thread.join(timeout=5)
        self.assertFalse(thread.is_alive())

    def current_writes(self):
        return [
            write
            for write in self.db.writes
            if write[1] == "status" and write[2] == "current"
        ]

    def current(self):
        return self.db.data["status"]["current"]


class MqttWorkerTests(MqttWorkerBase):
    def test_a_raw_snapshot_reaches_the_document_in_document_units(self):
        # What the charger actually publishes: milliamps, tenths of °C, the
        # absent-sensor `false`, and the uncurated /status fields.
        payload = status_payload(
            state=3,
            amp=0,
            temp1=247,
            temp2=False,
            temp3=False,
            session_energy=6000,
            elapsed=3600,
            total_energy=100.5,
            comm_sent=10,
            comm_success=10,
            rapi_connected=1,
            ipaddress="192.168.0.143",
            macaddress="aa:bb:cc:dd:ee:ff",
            mqtt_connected=1,
        )
        self.source.seed(payload)
        self.client.deliver("chelevse/amp", 15400)
        self.source.flush()
        self.run_worker()
        doc = self.current()
        self.assertEqual(doc["amp"], 15.4)  # mA -> A
        self.assertEqual(doc["temp1"], 24.7)  # 10ths -> °C
        self.assertEqual(doc["temp_c"], 24.7)
        self.assertIsNone(doc["temp2"])  # absent sensor sentinel
        self.assertEqual(doc["state"], 3)
        self.assertEqual(doc["state_label"], "charging")
        self.assertIs(doc["charger_online"], True)
        self.assertIs(doc["updated_at"], bridge.firestore.SERVER_TIMESTAMP)
        for key in (
            "comm_sent",
            "comm_success",
            "rapi_connected",
            "ipaddress",
            "macaddress",
            "mqtt_connected",
        ):
            self.assertNotIn(key, doc)
        self.assertEqual(self.notifier.bodies, ["Charging started"])

    def test_an_unseeded_partial_snapshot_only_merges_fields(self):
        # Bridge restarted while the charger's HTTP is wedged: the tracker is
        # charging from Firestore, /status has never answered, and the first
        # MQTT change is an amp update. It must not stop the session.
        self.tracker.state = 3
        self.tracker.previous_state = 3
        self.tracker.last_charging_energy = 6000
        self.tracker.last_charging_elapsed = 3600
        self.client.deliver("chelevse/amp", 15400)
        self.source.flush()
        self.run_worker()
        self.assertEqual(self.current()["amp"], 15.4)
        self.assertEqual(self.notifier.bodies, [])
        self.assertNotIn("sessions", self.db.data)
        # state 3 is also what the watchdog reads for its charging guard.
        self.assertEqual(self.tracker.state, 3)
        self.assertEqual(self.tracker.previous_state, 3)
        self.assertFalse(self.source.seeded)
        # The later HTTP reply for the same state fires no edge either.
        self.sink.apply_status(
            bridge.parse_status(status_payload(state=3)),
            "http",
            mqtt_mark=self.sink.mqtt_generation(),
        )
        self.assertEqual(self.notifier.bodies, [])

    def test_an_unseeded_snapshot_with_state_is_not_a_transition(self):
        # Without the seed the snapshot has no session counters, so a state
        # change alone cannot be a complete observation.
        self.client.deliver("chelevse/state", 3)
        self.source.flush()
        self.run_worker()
        self.assertEqual(self.notifier.bodies, [])
        self.assertEqual(self.tracker.state, 1)
        self.assertEqual(self.current()["state_label"], "charging")

    def test_the_seeded_snapshot_is_a_complete_observation(self):
        self.source.seed(status_payload(state=1))
        self.client.deliver("chelevse/state", 3)
        self.source.flush()
        self.run_worker()
        self.assertEqual(self.notifier.bodies, ["Charging started"])
        self.assertEqual(self.tracker.state, 3)

    def test_a_pre_seed_snapshot_is_not_promoted_by_a_later_seed(self):
        # Flushed before /status answered, seeded while it sat in the queue: its
        # completeness is a flush-time fact, so the worker must still treat it
        # as a field update instead of running the state machine on a partial
        # observation (a false start, a session with no counters).
        self.client.deliver("chelevse/state", 3)
        self.source.flush()
        self.source.seed(status_payload(state=1, session_energy=0, elapsed=0))
        self.run_worker()
        self.assertEqual(self.notifier.bodies, [])
        self.assertEqual(self.tracker.state, 1)
        self.assertNotIn("sessions", self.db.data)
        self.assertEqual(self.current()["state"], 3)  # the fields still merge

    def test_a_snapshot_queued_before_a_reconcile_is_not_replayed(self):
        # The flush is queued while the worker is busy; the reconcile GET that
        # follows it is newer, and applies. Draining the queued snapshot
        # afterwards would rewind the tracker and re-fire the stop's edge.
        self.source.seed(status_payload(state=1))
        self.client.deliver("chelevse/state", 3)
        self.source.flush()  # arrival 1, queued: no worker yet
        arrival = self.source.arrival_generation()
        self.assertEqual(arrival, 1)
        self.assertTrue(
            self.sink.apply_status(
                bridge.parse_status(status_payload(state=1)),
                "http",
                seed=lambda: self.source.seed_if_current(arrival, status_payload()),
                arrival=arrival,
            )
        )
        self.assertEqual(self.tracker.state, 1)
        self.assertEqual(self.notifier.bodies, [])

        logs = []
        stop = threading.Event()
        with mock.patch.object(bridge, "log", logs.append), mock.patch.object(
            bridge, "_stop", stop
        ):
            thread = threading.Thread(
                target=bridge.mqtt_status_loop,
                args=(self.sink, self.snapshots),
                daemon=True,
            )
            thread.start()
            try:
                wait_for(lambda: logs)  # the worker dropped it, not applied it
            finally:
                stop.set()
                thread.join(timeout=5)
        self.assertIn("reconcile applied a newer view", logs[0])
        self.assertEqual(self.tracker.state, 1)
        self.assertEqual(self.notifier.bodies, [])

    def test_a_start_and_stop_survive_a_busy_worker(self):
        # The worker is applying one snapshot (blocked in the Firestore write)
        # when the charger starts and stops: both edges arrive while it is
        # busy, and coalescing to the newest snapshot would leave only state=1.
        # The tracker would then never see the start, and the stop could not
        # finalize the session or notify.
        self.source.seed(status_payload(state=1, session_energy=0, elapsed=0))
        busy = threading.Event()
        release = threading.Event()
        parse_snapshot = bridge.parse_snapshot

        def blocking_parse(snapshot):
            if not busy.is_set():
                busy.set()
                release.wait(5)  # the worker is busy with this snapshot
            return parse_snapshot(snapshot)

        stop = threading.Event()
        self.client.deliver("chelevse/amp", 1000)
        self.source.flush()  # the worker takes this one and blocks on it
        with mock.patch.object(bridge, "parse_snapshot", blocking_parse), mock.patch.object(
            bridge, "_stop", stop
        ):
            thread = threading.Thread(
                target=bridge.mqtt_status_loop,
                args=(self.sink, self.snapshots),
                daemon=True,
            )
            thread.start()
            try:
                self.assertTrue(busy.wait(2))
                self.client.deliver("chelevse/state", 3)
                self.client.deliver("chelevse/session_energy", 6000)
                self.source.flush()  # start edge, queued behind the busy worker
                self.client.deliver("chelevse/state", 1)
                self.source.flush()  # stop edge, queued behind the start
                release.set()
                wait_for(lambda: len(self.db.data.get("sessions", {})) == 1)
            finally:
                release.set()
                stop.set()
                thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(
            self.notifier.bodies, ["Charging started", "Charging stopped"]
        )
        self.assertEqual(len(self.db.data["sessions"]), 1)
        self.assertEqual(self.tracker.state, 1)

    def test_every_session_edge_survives_a_blocked_worker(self):
        # Three complete sessions -- six state changes, more than the telemetry
        # capacity -- arrive while the worker is blocked in its first write.
        # Coalescing may drop only repeated telemetry: each transition is one
        # session record and one notification, so truncating the backlog to the
        # telemetry bound would lose whole sessions even though the final state
        # is right.
        self.source.seed(status_payload(state=1, session_energy=0, elapsed=0))
        busy = threading.Event()
        release = threading.Event()
        parse_snapshot = bridge.parse_snapshot

        def blocking_parse(snapshot):
            if not busy.is_set():
                busy.set()
                release.wait(5)  # the worker is busy with this snapshot
            return parse_snapshot(snapshot)

        def session_writes():
            return [write for write in self.db.writes if write[1] == "sessions"]

        stop = threading.Event()
        self.client.deliver("chelevse/amp", 1000)
        self.source.flush()  # the worker takes this one and blocks on it
        with mock.patch.object(bridge, "parse_snapshot", blocking_parse), mock.patch.object(
            bridge, "_stop", stop
        ):
            thread = threading.Thread(
                target=bridge.mqtt_status_loop,
                args=(self.sink, self.snapshots),
                daemon=True,
            )
            thread.start()
            try:
                self.assertTrue(busy.wait(2))
                for session in (1, 2, 3):
                    self.client.deliver("chelevse/state", 3)
                    self.client.deliver("chelevse/session_energy", session * 1000)
                    self.client.deliver("chelevse/session_elapsed", session * 100)
                    self.source.flush()  # start edge, queued behind the worker
                    self.client.deliver("chelevse/state", 1)
                    self.source.flush()  # stop edge, queued behind the start
                release.set()
                wait_for(lambda: len(session_writes()) >= 3)
            finally:
                release.set()
                stop.set()
                thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(
            self.notifier.bodies,
            [
                "Charging started",
                "Charging stopped",
                "Charging started",
                "Charging stopped",
                "Charging started",
                "Charging stopped",
            ],
        )
        # Every stop wrote its session with the energy that session used: no
        # transition was evicted, so no session was folded into another.
        self.assertEqual(
            [write[3]["wh"] for write in session_writes()],
            [1000.0, 2000.0, 3000.0],
        )
        # The rapid sessions merge into one record (cumulative counters), but
        # each wrote its own energy: none was folded away unobserved.
        (session_doc,) = self.db.data["sessions"].values()
        self.assertEqual((session_doc["wh"], session_doc["elapsed"]), (3000.0, 300))
        self.assertEqual(self.tracker.state, 1)


class EnqueueLatestTests(unittest.TestCase):
    @staticmethod
    def record(state, arrival=1, complete=False, **fields):
        return Snapshot({"state": state, **fields}, arrival, complete)

    def test_enqueue_latest_coalesces_telemetry_of_the_same_state(self):
        snapshots = bridge.queue.Queue(maxsize=bridge.MQTT_PENDING_QUEUE)
        bridge.enqueue_latest(snapshots, self.record(1, 1, amp=10))
        bridge.enqueue_latest(snapshots, self.record(1, 2, amp=12))
        queued = snapshots.get_nowait()
        self.assertEqual(queued.fields, {"state": 1, "amp": 12})
        self.assertEqual(queued.arrival, 2)  # the newest record is the one kept
        self.assertTrue(snapshots.empty())

    def test_enqueue_latest_keeps_a_state_change_in_order(self):
        # A start and a stop queued behind a busy worker are edges the tracker
        # has to observe: coalescing to the newest would lose the session.
        snapshots = bridge.queue.Queue(maxsize=bridge.MQTT_PENDING_QUEUE)
        for arrival, state in enumerate((1, 3, 1), start=1):
            bridge.enqueue_latest(snapshots, self.record(state, arrival))
        self.assertEqual(
            [snapshots.get_nowait().fields for _ in range(3)],
            [{"state": 1}, {"state": 3}, {"state": 1}],
        )
        self.assertTrue(snapshots.empty())

    def test_enqueue_latest_keeps_more_edges_than_the_telemetry_capacity(self):
        # The telemetry bound must not cap the transitions: six state changes
        # queued behind a blocked worker all fit, in order, because the queue
        # reserves an edge backlog on top of the telemetry slots.
        snapshots = bridge.queue.Queue(maxsize=bridge.MQTT_PENDING_QUEUE)
        states = (1, 3, 1, 3, 1, 3)
        for arrival, state in enumerate(states, start=1):
            bridge.enqueue_latest(snapshots, self.record(state, arrival))
        self.assertEqual(
            [snapshots.get_nowait().fields["state"] for _ in states], list(states)
        )
        self.assertTrue(snapshots.empty())

    def test_enqueue_latest_logs_an_edge_overflow(self):
        # A bound smaller than the transitions queued behind it can only drop
        # edges, so the loss is reported instead of silently absorbed.
        snapshots = bridge.queue.Queue(maxsize=2)
        logs = []
        with mock.patch.object(bridge, "log", logs.append):
            for arrival, state in enumerate((1, 3, 1), start=1):
                bridge.enqueue_latest(snapshots, self.record(state, arrival))
        self.assertEqual(
            [snapshots.get_nowait().fields for _ in range(2)],
            [{"state": 3}, {"state": 1}],
        )
        self.assertEqual(len(logs), 1)
        self.assertIn("backlog over capacity (2)", logs[0])


class StatusLoopMqttTests(unittest.TestCase):
    def setUp(self):
        self.factory = FakeMqttFactory()
        self.db = FakeDB()
        self.notifier = _RecordingNotifier()
        self.watchdog = _RecordingWatchdog()
        self.tracker = bridge.StatusTracker(self.db)
        self.source = MqttSource(
            "192.168.0.224",
            topic="chelevse",
            on_status=self.db_snapshot,
            debounce=60,
            client_factory=self.factory,
            log=lambda _message: None,
        )
        self.addCleanup(self.source.stop)
        self.applied = []

    def db_snapshot(self, record):
        self.applied.append(record.fields)

    def current_writes(self):
        """The ``status/current`` writes the sink performed, in order."""
        return [
            write
            for write in self.db.writes
            if write[1] == "status" and write[2] == "current"
        ]

    def connect(self):
        """Start the source and let the broker grant the subscription."""
        self.source.start()
        client = self.factory.client
        client.connect()
        client.ack_subscribe([0])
        return client

    def run_loop(
        self, session, polls, on_wait=None, reconcile=3600, sink=None, interval=10
    ):
        transport = bridge.ChargerTransport(session)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.status_loop(
                self.db,
                bridge.ChargerHost("charger"),
                None,
                transport,
                interval,
                self.tracker,
                self.notifier,
                self.watchdog,
                self.source,
                reconcile,
                sink,
            )
        return session

    def test_falls_back_to_the_http_poll_when_mqtt_drops(self):
        client = self.connect()
        session = FakeSession(
            [FakeResponse(200, status_payload()), FakeResponse(200, status_payload())]
        )
        waits = {"n": 0}

        def on_wait():
            waits["n"] += 1
            if waits["n"] == 2:
                client.drop()  # broker connection lost mid-run

        self.run_loop(session, polls=4, on_wait=on_wait)
        # One seed/reconcile poll while MQTT is healthy, one immediately after
        # the fallback; no 10 s polling in between.
        self.assertEqual(len(session.calls), 2)
        health = self.db.data["status"]["health"]
        self.assertEqual(health["source"], "http")
        self.assertFalse(health["mqtt_connected"])

    def test_every_reconcile_applies_while_mqtt_is_quiet(self):
        # A granted subscription that publishes nothing (an idle charger)
        # advances neither counter, so each reply's arrival equals the previous
        # watermark. Every poll must still apply: the journal claiming
        # "mqtt advanced" would be a falsely discarded fresh reply. Which of
        # those applies *writes* is the write policy's decision (issue #93):
        # total_energy is continuous, so only the first publishes and the
        # heartbeats carry the rest.
        self.connect()
        session = FakeSession(
            [
                FakeResponse(200, status_payload(total_energy=energy))
                for energy in (100, 110, 120)
            ]
        )
        logs = []
        with mock.patch.object(bridge, "log", logs.append):
            self.run_loop(session, polls=3, reconcile=0)
        self.assertEqual(len(session.calls), 3)
        self.assertEqual(
            [write[3]["total_energy"] for write in self.current_writes()],
            [100],
        )
        self.assertEqual(self.tracker.total_energy, 120)
        self.assertEqual(
            [line for line in logs if "reconcile discarded" in line],
            [],
            "a fresh reply was reported as overtaken by MQTT",
        )

    def test_every_fallback_poll_after_a_broker_drop_applies(self):
        # The generation freezes when the broker drops, so every fallback poll
        # reads the same arrival: the whole fallback must keep applying status,
        # not just its first poll. The document itself follows the write policy
        # (issue #93): continuous movement rides the heartbeats.
        client = self.connect()
        session = FakeSession(
            [
                FakeResponse(200, status_payload(total_energy=energy))
                for energy in (100, 110, 120, 130)
            ]
        )
        waits = {"n": 0}

        def on_wait():
            waits["n"] += 1
            if waits["n"] == 1:
                client.drop()

        logs = []
        with mock.patch.object(bridge, "log", logs.append):
            self.run_loop(session, polls=4, on_wait=on_wait, interval=0)
        # One reconcile while MQTT was healthy, then three fallback polls.
        self.assertEqual(len(session.calls), 4)
        self.assertEqual(
            [write[3]["total_energy"] for write in self.current_writes()],
            [100],
        )
        self.assertEqual(self.tracker.total_energy, 130)
        self.assertEqual([line for line in logs if "reconcile discarded" in line], [])

    def test_every_poll_under_a_denied_subscription_applies(self):
        # Same freeze behind a connected-but-denied subscription: HTTP is the
        # source and every poll is the newest observation. Writes stay on the
        # write policy's cadence (issue #93); the applies all land.
        self.source.start()
        client = self.factory.client
        client.connect()
        client.ack_subscribe([_ReasonCode(135, "Not authorized")])
        session = FakeSession(
            [
                FakeResponse(200, status_payload(total_energy=energy))
                for energy in (100, 110, 120)
            ]
        )
        logs = []
        with mock.patch.object(bridge, "log", logs.append):
            self.run_loop(session, polls=3, reconcile=3600, interval=0)
        self.assertEqual(len(session.calls), 3)
        self.assertEqual(
            [write[3]["total_energy"] for write in self.current_writes()],
            [100],
        )
        self.assertEqual(self.tracker.total_energy, 120)
        self.assertEqual([line for line in logs if "reconcile discarded" in line], [])

    def test_transport_source_is_recorded_on_each_edge(self):
        client = self.connect()
        session = FakeSession([FakeResponse(200, status_payload())] * 2)
        writes = []
        original = bridge.write_transport_health

        def spy(db, source, connected, announced=None, last_lwt_at=None, counter=None):
            writes.append((source, connected))
            original(
                db, source, connected, announced, last_lwt_at, counter=counter
            )

        def on_wait():
            if client.connected:
                client.drop()

        with mock.patch.object(bridge, "write_transport_health", spy):
            self.run_loop(session, polls=3, on_wait=on_wait)
        self.assertEqual(writes, [("mqtt", True), ("http", False)])

    def test_an_lwt_drop_falls_back_to_http_and_a_reconnect_restores_mqtt(self):
        client = self.connect()
        session = FakeSession([FakeResponse(200, status_payload())] * 6)
        waits = {"n": 0}

        def on_wait():
            waits["n"] += 1
            if waits["n"] == 2:
                client.deliver(
                    "openevse/announce/3988", '{"state":"disconnected"}'
                )
            elif waits["n"] == 4:
                client.deliver("openevse/announce/3988", '{"state":"connected"}')

        self.run_loop(session, polls=6, on_wait=on_wait)
        health = self.db.data["status"]["health"]
        self.assertEqual(health["source"], "mqtt")
        self.assertTrue(health["mqtt_connected"])
        self.assertTrue(health["mqtt_announced"])
        # The Last Will was written while it held: HTTP source, link fact false.
        self.assertTrue(
            any(
                write[3].get("source") == "http"
                and write[3].get("mqtt_connected") is False
                and write[3].get("mqtt_announced") is False
                for write in self.db.writes
                if write[:3] == ("set", "status", "health")
            )
        )
        self.assertIsNotNone(health["mqtt_last_lwt_at"])

    def test_an_lwt_with_a_denied_announce_grant_is_unknown_not_disconnected(self):
        # No announce message ever arrives: the watchdog must not invent an
        # outage, so the source stays MQTT.
        self.connect()
        session = FakeSession([FakeResponse(200, status_payload())] * 2)
        self.run_loop(session, polls=1)
        health = self.db.data["status"]["health"]
        self.assertEqual(health["source"], "mqtt")
        self.assertIsNone(health["mqtt_announced"])

    def test_http_failure_while_mqtt_reports_is_not_an_outage(self):
        client = self.connect()
        session = FakeSession(
            [
                FakeResponse(200, status_payload()),
                requests.ConnectionError("http blackholed"),
                requests.ConnectionError("http blackholed"),
            ]
        )

        def on_wait():
            if len(session.calls) == 1 and not self.applied:
                # MQTT is still delivering: the charger is alive.
                self.source.seed(status_payload())
                client.deliver("chelevse/amp", 6000)
                self.source.flush()

        self.run_loop(session, polls=2, on_wait=on_wait, reconcile=0)
        self.assertIsNot(self.tracker.charger_online, False)
        self.assertEqual(self.notifier.bodies, [])

    def test_http_failure_without_mqtt_traffic_flags_offline(self):
        self.connect()
        session = FakeSession([requests.ConnectionError("gone")] * 3)
        self.run_loop(session, polls=2, reconcile=0)
        self.assertFalse(self.tracker.charger_online)
        self.assertEqual(self.notifier.bodies, ["Charger offline"])
        self.assertFalse(self.db.data["status"]["current"]["charger_online"])

    def test_a_successful_reconcile_seeds_the_mqtt_snapshot(self):
        self.connect()
        session = FakeSession([FakeResponse(200, status_payload())])
        self.run_loop(session, polls=1)
        self.assertEqual(self.source.snapshot["comm_sent"], 10)  # the seed is raw
        self.assertEqual(self.source.snapshot["voltage"], 240)
        # ... while the document only gets the curated fields.
        doc = self.db.data["status"]["current"]
        self.assertEqual(doc["state_label"], "ready")
        self.assertNotIn("comm_sent", doc)

    def test_a_reconcile_in_flight_during_an_mqtt_stop_is_discarded(self):
        # Charging; the reconcile GET is in flight when the MQTT stop lands, so
        # the reply (state=3) predates it. Exactly one "Charging stopped".
        self.tracker.seeded = True
        self.tracker.has_state = True
        self.tracker.state = 3
        self.tracker.previous_state = 3
        self.tracker.last_charging_energy = 6000
        self.tracker.last_charging_elapsed = 3600
        self.tracker.charger_online = True
        sink = bridge.StatusSink(self.db, self.tracker, self.notifier)
        self.connect()

        def stop_while_in_flight(_url):
            sink.apply_status(
                bridge.parse_status(
                    status_payload(state=1, session_energy=6000, elapsed=3600)
                ),
                "mqtt",
            )

        session = _HookedSession(
            [
                FakeResponse(
                    200, status_payload(state=3, session_energy=6000, elapsed=3600)
                )
            ],
            stop_while_in_flight,
        )
        self.run_loop(session, polls=2, sink=sink)
        self.assertEqual(self.notifier.bodies, ["Charging stopped"])
        self.assertEqual(self.tracker.state, 1)
        self.assertEqual(len(self.db.data["sessions"]), 1)
        # The stale reply is still a successful charger poll for the watchdog.
        self.assertEqual(self.watchdog.successes, 1)

    def test_http_polls_still_feed_the_watchdog(self):
        self.connect()
        session = FakeSession([FakeResponse(200, status_payload())] * 2)
        self.run_loop(session, polls=1)
        self.assertEqual(self.watchdog.successes, 1)
        # MQTT application happens on the sink, never through the watchdog.
        self.assertEqual(self.watchdog.failures, 0)

    def test_a_reconcile_overtaken_by_an_mqtt_apply_does_not_seed(self):
        # The seed belongs to the same decision as the apply: a reply that
        # predates an MQTT apply may not rewind the raw snapshot either (the
        # next flush would republish its stale fields).
        sink = bridge.StatusSink(self.db, self.tracker, self.notifier)
        seeds = []
        original = self.source.seed_if_current

        def spy(generation, payload):
            accepted = original(generation, payload)
            seeds.append((generation, accepted))
            return accepted

        self.source.seed_if_current = spy
        self.connect()

        def apply_while_in_flight(_url):
            sink.apply_status(bridge.parse_status(status_payload(state=1)), "mqtt")

        session = _HookedSession(
            [FakeResponse(200, status_payload(comm_sent=99))], apply_while_in_flight
        )
        self.run_loop(session, polls=1, sink=sink)
        self.assertEqual(seeds, [])  # the apply mark rejected it first
        self.assertNotIn("comm_sent", self.source.snapshot)

    def test_a_reconcile_overtaken_by_a_queued_flush_does_not_seed(self):
        # The flush that lands during the GET is queued, not applied (no worker
        # here), so the apply generation has not moved; only the arrival
        # generation shows the reply is older than it. Accepting it would seed
        # the raw snapshot with the stale state, and the next flush -- carrying
        # only amp, say -- would republish that state.
        sink = bridge.StatusSink(self.db, self.tracker, self.notifier)
        seeds = []
        original = self.source.seed_if_current

        def spy(generation, payload):
            accepted = original(generation, payload)
            seeds.append((generation, accepted))
            return accepted

        self.source.seed_if_current = spy
        client = self.connect()

        def flush_while_in_flight(_url):
            client.deliver("chelevse/state", 1)
            self.source.flush()  # queued for the worker; not applied yet

        session = _HookedSession(
            [
                FakeResponse(
                    200, status_payload(state=3, session_energy=6000, elapsed=3600)
                )
            ],
            flush_while_in_flight,
        )
        logs = []
        with mock.patch.object(bridge, "log", logs.append):
            self.run_loop(session, polls=1, sink=sink)
        self.assertTrue(any("reconcile discarded" in line for line in logs))
        self.assertEqual(seeds, [(0, False)])  # compared, rejected
        self.assertNotIn("comm_sent", self.source.snapshot)
        self.assertIsNone(self.tracker.state)  # the reply never applied
        self.assertEqual(self.notifier.bodies, [])
        self.assertEqual(self.applied, [{"state": 1}])  # still queued

    def test_a_flush_after_the_freshness_read_still_rejects_the_reply(self):
        # The interleaving the separate lock acquisitions allowed: read the
        # arrival generation, let a flush land, then try to seed. Compare and
        # merge are now one critical section, so the newer snapshot survives.
        sink = bridge.StatusSink(self.db, self.tracker, self.notifier)
        client = self.connect()
        arrivals = self.source.arrival_generation()
        client.deliver("chelevse/state", 3)
        self.source.flush()  # after the read, before the seed
        applied = sink.apply_status(
            bridge.parse_status(status_payload(state=1, comm_sent=99)),
            "http",
            seed=lambda: self.source.seed_if_current(
                arrivals, status_payload(state=1, comm_sent=99)
            ),
            arrival=arrivals,
        )
        self.assertFalse(applied)
        self.assertEqual(self.source.snapshot["state"], 3)
        self.assertNotIn("comm_sent", self.source.snapshot)
        self.assertIsNone(self.tracker.state)

    def test_a_denied_subscription_keeps_the_http_cadence(self):
        # The broker accepts the connection and denies the subscription: the
        # topics are dead, which looks exactly like an idle charger, so HTTP
        # must stay the source and keep its own cadence.
        logs = []
        self.source.log = logs.append
        self.source.start()
        client = self.factory.client
        client.connect()
        client.ack_subscribe([_ReasonCode(135, "Not authorized")])
        session = FakeSession([FakeResponse(200, status_payload())] * 3)
        with mock.patch.object(bridge, "log", logs.append):
            # interval=0 makes the fallback cadence visible: every tick polls,
            # while the MQTT reconcile cadence (3600 s) would poll once.
            self.run_loop(session, polls=3, reconcile=3600, interval=0)
        self.assertEqual(len(session.calls), 3)
        health = self.db.data["status"]["health"]
        self.assertEqual(health["source"], "http")
        self.assertTrue(health["mqtt_connected"])  # degraded, not disconnected
        self.assertEqual(
            [line for line in logs if line.startswith("status source:")],
            ["status source: http (mqtt connected, chelevse/# not subscribed)"],
        )

    def test_a_link_drop_after_a_denied_subscription_refreshes_health(self):
        # The source stays "http" across this drop, so the health write must key
        # on the (source, connected) pair: otherwise status/health keeps
        # mqtt_connected: true for a link that is down.
        self.source.log = lambda _message: None
        self.source.start()
        client = self.factory.client
        client.connect()
        client.ack_subscribe([_ReasonCode(135, "Not authorized")])
        session = FakeSession([FakeResponse(200, status_payload())] * 2)

        def on_wait():
            if client.connected:
                client.drop()

        self.run_loop(session, polls=3, reconcile=3600, on_wait=on_wait)
        health = self.db.data["status"]["health"]
        self.assertEqual(health["source"], "http")
        self.assertFalse(health["mqtt_connected"])

    def test_one_failed_reconcile_while_mqtt_is_idle_is_not_an_outage(self):
        # An idle charger publishes nothing for minutes, so one failed HTTP
        # reconcile next to that silence is not evidence of an outage: the
        # charger is still connected, and writing charger_online: false would
        # push a false alert.
        self.connect()
        session = FakeSession([requests.ConnectionError("idle blip")])
        logs = []
        with mock.patch.object(bridge, "log", logs.append):
            self.run_loop(session, polls=1, reconcile=0)
        self.assertIsNot(self.tracker.charger_online, False)
        self.assertEqual(self.notifier.bodies, [])
        self.assertNotIn(
            "charger_online", self.db.data.get("status", {}).get("current", {})
        )
        self.assertTrue(
            [line for line in logs if "outage unconfirmed" in line],
            "the unconfirmed outage was not logged",
        )

    def test_repeated_failed_reconciles_do_flag_the_outage(self):
        self.connect()
        session = FakeSession([requests.ConnectionError("gone")] * 3)
        self.run_loop(session, polls=2, reconcile=0)
        self.assertFalse(self.tracker.charger_online)
        self.assertEqual(self.notifier.bodies, ["Charger offline"])

    def test_a_flush_in_the_offline_gap_refuses_the_outage(self):
        # The second failed reconcile has already decided "no snapshot since
        # the last one" when a flush lands, before the offline write. The sink
        # re-reads the arrival sequence in the same critical section as the
        # tracker/document writes, so the fresh data refuses the outage instead
        # of writing charger_online: false (and pushing an alert) over live
        # data. The streak restarts from that snapshot.
        client = self.connect()
        flushes = []

        def arrival_hook():
            if not flushes:
                flushes.append(True)
                client.deliver("chelevse/state", 1)
                self.source.flush()  # arrives after the streak check
            return self.source.arrival_generation()

        sink = bridge.StatusSink(
            self.db, self.tracker, self.notifier, arrivals=arrival_hook
        )
        session = FakeSession([requests.ConnectionError("gone")] * 3)
        logs = []
        with mock.patch.object(bridge, "log", logs.append):
            self.run_loop(session, polls=3, reconcile=0, sink=sink)
        self.assertNotEqual(self.tracker.charger_online, False)
        self.assertEqual(self.notifier.bodies, [])
        self.assertNotIn(
            "charger_online", self.db.data.get("status", {}).get("current", {})
        )
        self.assertTrue(
            [line for line in logs if "outage refused" in line],
            "the refused outage was not logged",
        )
        self.assertEqual(self.applied, [{"state": 1}])  # the flush was real
        # Two unconfirmed failures, one refusal: the refusal reset the streak.
        self.assertEqual(
            len([line for line in logs if "outage unconfirmed" in line]), 2
        )

    def test_a_status_write_failure_does_not_repoll_at_the_tick(self):
        # The deadline advanced before the apply, so a Firestore write failure
        # must not leave it overdue: the tick would otherwise re-poll the
        # charger at 1 Hz for the whole outage.
        self.connect()
        self.db.fail_writes = True
        session = FakeSession([FakeResponse(200, status_payload())] * 3)
        self.run_loop(session, polls=3, reconcile=3600)
        self.assertEqual(len(session.calls), 1)


class _StubMqtt:
    """Just the MQTT source surface ``config_loop`` reads."""

    def __init__(self):
        self.connected = True
        self.subscribed = True
        self.subscription = "chelevse/#"
        self.config_version = 1
        self.announced = None


class ConfigLoopMqttTests(unittest.TestCase):
    class Session:
        def __init__(self, failures=0, on_get=None, payload=None):
            self.calls = 0
            self.failures = failures
            self.on_get = on_get
            # Copied per instance: a test may change it mid-flight.
            self.payload = (
                {"firmware": "master", "config_version": 1}
                if payload is None
                else payload
            )

        def get(self, url, **kwargs):
            self.calls += 1
            if self.calls <= self.failures:
                raise requests.ConnectionError("config blackholed")
            # The reply is generated before the hook runs: a change the hook
            # makes is one the charger reported during this fetch, not in it.
            payload = dict(self.payload)
            if self.on_get is not None:
                self.on_get(self)
            return FakeResponse(200, payload)

    def start(
        self,
        session,
        source=None,
        retry=(0.05, 0.2),
        logs=None,
        db=None,
        interval=60,
        safety=600,
    ):
        self.db = db if db is not None else FakeDB()
        self.source = source or _StubMqtt()
        self.event = threading.Event()
        self.stop = threading.Event()
        if logs is not None:
            log_patch = mock.patch.object(bridge, "log", logs.append)
            log_patch.start()
            self.addCleanup(log_patch.stop)

        def run():
            with mock.patch.object(bridge, "_stop", self.stop), mock.patch.object(
                bridge, "CONFIG_RETRY_MIN_SEC", retry[0]
            ), mock.patch.object(
                bridge, "CONFIG_RETRY_MAX_SEC", retry[1]
            ), mock.patch.object(
                bridge, "CONFIG_SAFETY_RESYNC_SEC", safety
            ):
                bridge.config_loop(
                    self.db,
                    bridge.ChargerHost("charger"),
                    None,
                    bridge.ChargerTransport(session),
                    interval,
                    0,
                    self.source,
                    self.event,
                    tick=0.005,
                )

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.stop.set)
        return thread

    def synced(self):
        return "config" in self.db.data.get("status", {})

    def test_config_syncs_only_when_the_version_changes(self):
        session = self.Session()
        thread = self.start(session)
        self.event.set()  # the retained version on connect
        wait_for(self.synced)
        self.assertEqual(session.calls, 1)
        time.sleep(0.05)
        self.assertEqual(session.calls, 1)  # no 60 s polling in MQTT mode
        self.event.set()
        wait_for(lambda: session.calls == 2)
        self.source.connected = False
        self.stop.set()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())

    def test_a_failed_config_sync_is_retried_without_a_new_version(self):
        session = self.Session(failures=1)
        self.start(session)
        self.event.set()
        wait_for(self.synced)
        self.assertEqual(session.calls, 2)  # failure, then the retry

    def test_a_version_during_the_backoff_retries_immediately(self):
        session = self.Session(failures=1)
        self.start(session, retry=(5, 60))  # a real backoff, not a test one
        self.event.set()
        wait_for(lambda: session.calls == 1)
        time.sleep(0.05)
        self.assertEqual(session.calls, 1)  # still waiting out the backoff
        self.source.config_version = 2  # the changed value a reconnect republishes
        self.event.set()
        wait_for(lambda: session.calls == 2, timeout=1)
        wait_for(self.synced)

    def test_a_failed_config_write_is_retried_instead_of_hot_looping(self):
        # A Firestore write that fails after a good fetch leaves the config as
        # stale as a failed fetch. It used to escape the handler with the
        # trigger still set: no backoff, no wait, ~136k fetches/s. It must now
        # arm the same bounded retry.
        session = self.Session()
        db = FakeDB()
        db.fail_writes = True
        logs = []
        self.start(session, retry=(0.05, 0.2), logs=logs, db=db)
        started = time.monotonic()
        self.event.set()
        wait_for(lambda: session.calls >= 2)  # the owed retry runs
        self.assertGreaterEqual(time.monotonic() - started, 0.05)  # waited it out
        self.assertFalse(self.event.is_set())  # trigger consumed, retry armed
        time.sleep(0.15)
        self.assertLessEqual(session.calls, 5)  # bounded, not one fetch per loop
        self.assertTrue(
            [line for line in logs if "retrying in" in line], "backoff not logged"
        )
        self.assertFalse([line for line in logs if "config loop error" in line])
        self.assertNotIn("config", db.data.get("status", {}))

    def test_a_version_change_during_the_fetch_is_re_armed_not_lost(self):
        logs = []

        def bump(session):
            if session.calls == 1:
                # The charger's settings changed while this GET was in flight.
                self.source.config_version = 2
                session.payload = {"firmware": "master", "config_version": 2}

        session = self.Session(on_get=bump)
        self.start(session, logs=logs)
        self.event.set()
        wait_for(lambda: session.calls == 2)
        # The newer config was synced on its own, without a new trigger.
        wait_for(lambda: logs.count("config synced") == 2)
        self.assertEqual(self.db.data["status"]["config"]["config_version"], 2)
        time.sleep(0.05)
        self.assertEqual(session.calls, 2)  # the re-arm is consumed once

    def test_a_denied_subscription_keeps_the_config_poll(self):
        # The broker accepted the connection and denied <base>/#: no
        # config_version can ever arrive, so waiting on the event would freeze
        # status/config for as long as the link stays up. HTTP must stay the
        # source, at its own cadence, with the degraded edge logged once.
        source = _StubMqtt()
        source.subscribed = False
        logs = []
        session = self.Session()
        self.start(session, source=source, logs=logs, interval=0.01)
        # The event is never set, so only the fallback poll can sync -- and it
        # keeps polling instead of syncing once.
        wait_for(lambda: session.calls >= 3)
        wait_for(self.synced)
        self.assertFalse(self.event.is_set())
        self.assertEqual(
            [line for line in logs if line.startswith("config source:")],
            ["config source: http (mqtt connected, chelevse/# not subscribed)"],
        )

    def test_a_last_will_keeps_the_config_poll(self):
        # The charger announced `disconnected`: no config_version will arrive
        # while it is away, so the HTTP poll must resume instead of waiting on
        # an event that cannot come.
        source = _StubMqtt()
        source.announced = False
        logs = []
        session = self.Session()
        self.start(session, source=source, logs=logs, interval=0.01)
        wait_for(lambda: session.calls >= 2)
        wait_for(self.synced)
        self.assertEqual(
            [line for line in logs if line.startswith("config source:")],
            ["config source: http (mqtt connected, gateway announced disconnected)"],
        )

    def test_a_granted_but_silent_subscription_bootstraps_over_http(self):
        # Connected and subscribed, but no config_version has ever been
        # delivered (topic mismatch, charger-side MQTT off, no retained
        # version). Waiting on the event alone would leave status/config stale
        # forever, so the loop syncs once immediately and says it is degraded.
        source = _StubMqtt()
        source.config_version = None
        logs = []
        session = self.Session()
        self.start(session, source=source, logs=logs)
        wait_for(self.synced)
        self.assertEqual(session.calls, 1)  # bootstrap, without any event
        self.assertFalse(self.event.is_set())
        self.assertTrue(
            [line for line in logs if "no config_version observed" in line],
            "the silent subscription was not logged",
        )

    def test_a_silent_subscription_keeps_a_slow_safety_resync(self):
        source = _StubMqtt()
        source.config_version = None
        logs = []
        session = self.Session()
        self.start(session, source=source, logs=logs, safety=0.02)
        wait_for(lambda: session.calls >= 3)
        # Bounded: the resync is a slow safety net, not a hot loop.
        self.assertLessEqual(session.calls, 5)
        self.assertFalse(self.event.is_set())


class HealthTests(unittest.TestCase):
    def test_watchdog_and_transport_writes_do_not_clobber_each_other(self):
        db = FakeDB()
        bridge.write_transport_health(db, "mqtt", True)
        notifier = _RecordingNotifier()
        watchdog = bridge.Watchdog(
            db,
            bridge.ChargerHost("charger"),
            None,
            bridge.ChargerTransport(FakeSession()),
            notifier,
            bridge.WatchdogConfig(),
        )
        watchdog.record_success(status_payload())
        health = db.data["status"]["health"]
        self.assertEqual(health["state"], "healthy")
        self.assertEqual(health["source"], "mqtt")
        self.assertTrue(health["mqtt_connected"])

        bridge.write_transport_health(db, "http", False)
        health = db.data["status"]["health"]
        self.assertEqual(health["state"], "healthy")  # watchdog fields survive
        self.assertEqual(health["source"], "http")
        self.assertFalse(health["mqtt_connected"])

    def test_a_failed_transport_write_is_only_a_log_line(self):
        db = FakeDB()
        db.fail_writes = True
        with mock.patch.object(bridge, "log") as fake_log:
            bridge.write_transport_health(db, "mqtt", True)
        self.assertTrue(fake_log.called)

    def test_the_last_will_fields_merge_with_the_watchdog_state(self):
        db = FakeDB()
        source = mock.Mock()
        source.connected = True
        source.announced = False
        source.last_lwt_at = "2026-10-20T12:00:00Z"
        fields = bridge.mqtt_health_fields(source)
        self.assertEqual(
            fields,
            {
                "mqtt_connected": False,
                "mqtt_announced": False,
                "mqtt_last_lwt_at": "2026-10-20T12:00:00Z",
            },
        )
        bridge.write_transport_health(
            db, "http", False, source.announced, source.last_lwt_at
        )
        watchdog = bridge.Watchdog(
            db,
            bridge.ChargerHost("charger"),
            None,
            bridge.ChargerTransport(FakeSession()),
            _RecordingNotifier(),
            bridge.WatchdogConfig(),
            mqtt=source,
        )
        watchdog.record_success(status_payload())
        health = db.data["status"]["health"]
        self.assertEqual(health["state"], "healthy")
        self.assertEqual(health["source"], "http")
        self.assertFalse(health["mqtt_connected"])
        self.assertFalse(health["mqtt_announced"])
        self.assertEqual(health["mqtt_last_lwt_at"], "2026-10-20T12:00:00Z")

    def test_the_watchdog_refreshes_the_last_will_fields_it_writes(self):
        db = FakeDB()
        source = mock.Mock()
        source.connected = True
        source.announced = True
        source.last_lwt_at = None
        watchdog = bridge.Watchdog(
            db,
            bridge.ChargerHost("charger"),
            None,
            bridge.ChargerTransport(FakeSession()),
            _RecordingNotifier(),
            bridge.WatchdogConfig(),
            mqtt=source,
        )
        watchdog.record_success(status_payload())
        health = db.data["status"]["health"]
        self.assertTrue(health["mqtt_connected"])
        self.assertTrue(health["mqtt_announced"])
        # A Last Will that fires later replaces the transport fields without
        # erasing the watchdog's.
        source.announced = False
        watchdog.write_health(False, True)
        health = db.data["status"]["health"]
        self.assertEqual(health["state"], "healthy")
        self.assertFalse(health["mqtt_connected"])
        self.assertFalse(health["mqtt_announced"])


class RunWiringTests(unittest.TestCase):
    def test_enabled_mqtt_starts_the_source_and_an_apply_worker(self):
        transport = bridge.ChargerTransport(FakeSession())
        calls = {}
        threads = []

        class _ThreadSpy:
            def __init__(self, target, args, daemon=None):
                self.target = target
                self.args = args
                threads.append((target.__name__, args))

            def start(self):
                if self.target.__name__ == "mqtt_status_loop":
                    return  # would block; wiring is what this test checks
                self.target(*self.args)

        def spy(name):
            def record(*args, **kwargs):
                calls[name] = (args, kwargs)

            record.__name__ = name
            return record

        source = mock.Mock()
        source.snapshots = 0
        source.messages = 0
        config = bridge.MqttConfig(
            enabled=True, host="192.168.0.224", topic="chelevse"
        )
        with mock.patch.object(bridge, "status_loop", spy("status_loop")), mock.patch.object(
            bridge, "config_loop", spy("config_loop")
        ), mock.patch.object(
            bridge, "schedule_loop", spy("schedule_loop")
        ), mock.patch.object(
            bridge, "settings_loop", spy("settings_loop")
        ), mock.patch.object(
            bridge, "command_loop", spy("command_loop")
        ), mock.patch.object(
            bridge, "mqtt_status_loop", spy("mqtt_status_loop")
        ), mock.patch.object(
            bridge, "MqttSource", return_value=source
        ) as source_cls, mock.patch.object(
            bridge.threading, "Thread", _ThreadSpy
        ), mock.patch.object(
            bridge, "StatusTracker"
        ), mock.patch.object(
            bridge, "Notifier"
        ):
            bridge.run(
                FakeDB(),
                bridge.ChargerHost("charger"),
                None,
                (10, 60, 60, 300, 5, 60),
                transport,
                bridge.WatchdogConfig(),
                config,
            )

        self.assertTrue(source_cls.called)
        kwargs = source_cls.call_args.kwargs
        self.assertEqual(kwargs["host"], "192.168.0.224")
        self.assertEqual(kwargs["topic"], "chelevse")
        source.start.assert_called_once_with()
        source.stop.assert_called_once_with()
        self.assertEqual(calls["status_loop"][0][8], source)
        self.assertEqual(calls["status_loop"][0][9], 60)
        self.assertEqual(calls["config_loop"][0][6], source)
        worker = [args for name, args in threads if name == "mqtt_status_loop"]
        self.assertEqual(len(worker), 1)
        self.assertEqual(len(worker[0]), 2)  # (sink, queue); the record has the rest
        self.assertIsInstance(worker[0][1], bridge.queue.Queue)
        self.assertEqual(
            [name for name, _args in threads],
            [
                "status_loop",
                "config_loop",
                "settings_loop",
                "schedule_loop",
                "mqtt_status_loop",
            ],
        )

    def test_disabled_mqtt_keeps_the_http_only_wiring(self):
        transport = bridge.ChargerTransport(FakeSession())
        threads = []

        class _ThreadSpy:
            def __init__(self, target, args, daemon=None):
                threads.append(target)
                self._args = args

            def start(self):
                pass

        with mock.patch.object(bridge.threading, "Thread", _ThreadSpy), mock.patch.object(
            bridge, "StatusTracker"
        ), mock.patch.object(
            bridge, "Notifier"
        ), mock.patch.object(
            bridge, "command_loop"
        ):
            bridge.run(
                FakeDB(),
                bridge.ChargerHost("charger"),
                None,
                (10, 60, 60, 300, 5, 60),
                transport,
                bridge.WatchdogConfig(),
                bridge.MqttConfig(enabled=False),
            )
        self.assertEqual(
            threads,
            [
                bridge.status_loop,
                bridge.config_loop,
                bridge.settings_loop,
                bridge.schedule_loop,
            ],
        )


if __name__ == "__main__":
    unittest.main()
