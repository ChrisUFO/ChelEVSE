"""Unit tests for the MQTT status source and its bridge integration (#44).

No broker, charger, Firestore or FCM is touched: the MQTT client, HTTP session
and Firestore are the in-memory fakes from ``fakes.py``.
"""

import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

import bridge  # noqa: E402
from fakes import FakeDB, FakeMqttFactory, FakeResponse, FakeSession  # noqa: E402
from mqtt_source import MqttSource, TOPIC_FIELDS  # noqa: E402


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


def wait_for(predicate, timeout=5):
    """Bound a test's wait on another thread (raises instead of hanging)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition not reached")


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
        self.assertEqual(client.subscriptions, [("chelevse/#", 0)])
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
        self.assertEqual(client.subscriptions, [("chelevse/#", 0)] * 2)

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
        fields = bridge.parse_status(self.snapshots[0])
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
        snapshot = self.snapshots[0]
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
        self.assertEqual(self.snapshots, [{"state": 3, "amp": 6000, "voltage": 238}])

    def test_timer_flushes_the_buffer_once(self):
        self.source.debounce = 0.02
        client = self.connect()
        client.deliver("chelevse/state", 2)
        deadline = time.monotonic() + 2
        while not self.snapshots and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertEqual(self.snapshots, [{"state": 2}])

    def test_seed_keeps_fields_the_firmware_never_publishes(self):
        client = self.connect()
        self.source.seed(status_payload())
        client.deliver("chelevse/amp", 7000)
        self.source.flush()
        snapshot = self.snapshots[0]
        for key in ("comm_sent", "comm_success", "rapi_connected", "voltage"):
            self.assertEqual(snapshot[key], status_payload()[key])
        self.assertEqual(snapshot["amp"], 7000)

    def test_unmapped_topics_are_ignored(self):
        client = self.connect()
        for topic in (
            "chelevse/config",
            "chelevse/config_version_extra",
            "chelevse/override/set",
            "chelevse/rapi/out",
            "chelevse/limit",
            "chelevse/elapsed",  # deprecated; session_elapsed is the source
            "openevse/announce/3988",
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

    def test_announce_is_not_consumed_but_connection_state_is_exposed(self):
        client = self.connect()
        client.deliver("openevse/announce/3988", '{"state":"disconnected"}')
        self.assertTrue(self.source.connected)  # LWT consumption is PR-3
        client.drop()
        self.assertFalse(self.source.connected)


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
        )
        self.assertTrue(config.enabled)
        self.assertEqual(config.host, "192.168.0.224")
        self.assertEqual(config.port, 1884)
        self.assertEqual(config.user, "chelevse")
        self.assertEqual(config.password, "secret")
        self.assertEqual(config.topic, "chelevse")
        self.assertEqual(config.reconcile_sec, 120)
        self.assertEqual(config.client_id, "bridge-1")

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
        (day,) = self.db.data["history"]
        self.assertAlmostEqual(self.db.data["history"][day]["kwh"]._value, 10.0)

    def test_a_stale_http_poll_cannot_reopen_a_closed_session(self):
        # One 3 -> 1 edge from MQTT, then an HTTP poll still reporting 3 (a
        # reconcile sent before the edge) must not create a second edge.
        self.apply(status_payload(state=3, session_energy=6000, elapsed=3600), "mqtt")
        self.apply(status_payload(state=1, session_energy=6000, elapsed=3600), "mqtt")
        self.apply(status_payload(state=1, session_energy=6000, elapsed=3600), "http")
        self.assertEqual(
            self.notifier.bodies, ["Charging started", "Charging stopped"]
        )
        self.assertEqual(len(self.db.data["sessions"]), 1)


class MqttStatusLoopTests(unittest.TestCase):
    def test_snapshots_apply_without_touching_the_watchdog(self):
        db = FakeDB()
        tracker = bridge.StatusTracker(db)
        tracker.seeded = True
        tracker.has_state = True
        tracker.state = 1
        tracker.previous_state = 1
        notifier = _RecordingNotifier()
        sink = bridge.StatusSink(db, tracker, notifier)
        snapshots = bridge.queue.Queue(maxsize=1)
        bridge.enqueue_latest(snapshots, bridge.parse_status(status_payload(state=3)))
        stop = threading.Event()
        with mock.patch.object(bridge, "_stop", stop):
            thread = threading.Thread(
                target=bridge.mqtt_status_loop, args=(sink, snapshots), daemon=True
            )
            thread.start()
            wait_for(lambda: "current" in db.data.get("status", {}))
            stop.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(db.data["status"]["current"]["state"], 3)
        self.assertEqual(notifier.bodies, ["Charging started"])

    def test_enqueue_latest_replaces_a_queued_snapshot(self):
        snapshots = bridge.queue.Queue(maxsize=1)
        bridge.enqueue_latest(snapshots, {"state": 1})
        bridge.enqueue_latest(snapshots, {"state": 2})
        self.assertEqual(snapshots.get_nowait(), {"state": 2})
        self.assertTrue(snapshots.empty())


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
        )
        self.addCleanup(self.source.stop)
        self.applied = []

    def db_snapshot(self, fields):
        self.applied.append(fields)

    def run_loop(self, session, polls, on_wait=None, reconcile=3600):
        transport = bridge.ChargerTransport(session)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.status_loop(
                self.db,
                "http://charger",
                None,
                transport,
                10,
                self.tracker,
                self.notifier,
                self.watchdog,
                self.source,
                reconcile,
            )
        return session

    def test_falls_back_to_the_http_poll_when_mqtt_drops(self):
        self.source.start()
        client = self.factory.client
        client.connect()
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

    def test_transport_source_is_recorded_on_each_edge(self):
        self.source.start()
        client = self.factory.client
        client.connect()
        session = FakeSession([FakeResponse(200, status_payload())] * 2)
        writes = []
        original = bridge.write_transport_health

        def spy(db, source, connected):
            writes.append((source, connected))
            original(db, source, connected)

        def on_wait():
            if client.connected:
                client.drop()

        with mock.patch.object(bridge, "write_transport_health", spy):
            self.run_loop(session, polls=3, on_wait=on_wait)
        self.assertEqual(writes, [("mqtt", True), ("http", False)])

    def test_http_failure_while_mqtt_reports_is_not_an_outage(self):
        self.source.start()
        client = self.factory.client
        client.connect()
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
        self.source.start()
        client = self.factory.client
        client.connect()
        session = FakeSession([requests.ConnectionError("gone")] * 3)
        self.run_loop(session, polls=2, reconcile=0)
        self.assertFalse(self.tracker.charger_online)
        self.assertEqual(self.notifier.bodies, ["Charger offline"])
        self.assertFalse(self.db.data["status"]["current"]["charger_online"])

    def test_a_successful_reconcile_seeds_the_mqtt_snapshot(self):
        self.source.start()
        self.factory.client.connect()
        session = FakeSession([FakeResponse(200, status_payload())])
        self.run_loop(session, polls=1)
        self.assertEqual(self.source.snapshot["comm_sent"], 10)
        self.assertEqual(self.source.snapshot["voltage"], 240)

    def test_http_polls_still_feed_the_watchdog(self):
        self.source.start()
        self.factory.client.connect()
        session = FakeSession([FakeResponse(200, status_payload())] * 2)
        self.run_loop(session, polls=1)
        self.assertEqual(self.watchdog.successes, 1)
        # MQTT application happens on the sink, never through the watchdog.
        self.assertEqual(self.watchdog.failures, 0)


class ConfigLoopMqttTests(unittest.TestCase):
    class Session:
        def __init__(self):
            self.calls = 0

        def get(self, url, **kwargs):
            self.calls += 1
            return FakeResponse(200, {"firmware": "master", "config_version": 1})

    def test_config_syncs_only_when_the_version_changes(self):
        db = FakeDB()
        session = self.Session()
        transport = bridge.ChargerTransport(session)
        source = mock.Mock()
        source.connected = True
        event = threading.Event()
        stop = threading.Event()
        with mock.patch.object(bridge, "_stop", stop):
            thread = threading.Thread(
                target=bridge.config_loop,
                args=(db, "http://charger", None, transport, 60, 0, source, event),
                kwargs={"tick": 0.005},
                daemon=True,
            )
            thread.start()
            event.set()  # the retained version on connect
            wait_for(lambda: "config" in db.data.get("status", {}))
            self.assertEqual(session.calls, 1)
            time.sleep(0.05)
            self.assertEqual(session.calls, 1)  # no 60 s polling in MQTT mode
            event.set()
            wait_for(lambda: session.calls == 2)
            source.connected = False
            stop.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())


class HealthTests(unittest.TestCase):
    def test_watchdog_and_transport_writes_do_not_clobber_each_other(self):
        db = FakeDB()
        bridge.write_transport_health(db, "mqtt", True)
        notifier = _RecordingNotifier()
        watchdog = bridge.Watchdog(
            db,
            "http://charger",
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
                "http://charger",
                None,
                (10, 60, 60, 300, 5),
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
        self.assertEqual(
            [name for name, _args in threads],
            ["status_loop", "config_loop", "schedule_loop", "mqtt_status_loop"],
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
                "http://charger",
                None,
                (10, 60, 60, 300, 5),
                transport,
                bridge.WatchdogConfig(),
                bridge.MqttConfig(enabled=False),
            )
        self.assertEqual(
            threads, [bridge.status_loop, bridge.config_loop, bridge.schedule_loop]
        )


if __name__ == "__main__":
    unittest.main()
