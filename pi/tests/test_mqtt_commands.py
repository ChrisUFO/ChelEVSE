"""Unit tests for commands over MQTT with HTTP fallback (#46).

No broker is needed: the MQTT client, HTTP session and Firestore are the
in-memory fakes from ``fakes.py``. The fake client's ``on_publish`` hook plays
the firmware — it delivers the retained ``<base>/override`` document or a
``<base>/rapi/out`` reply, exactly as the real charger does.
"""

import json
import sys
import threading
import time
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
from fakes import (  # noqa: E402
    FakeDB,
    FakeMqttFactory,
    FakeResponse,
    FakeSession,
)
from mqtt_source import MqttPublishError, MqttSource  # noqa: E402

BASE = "http://charger"
TOPIC = "chelevse"
CONFIRM = 0.05


def make_source(ready=True):
    """A started source backed by a fake client, optionally command-ready."""
    factory = FakeMqttFactory()
    source = MqttSource(host="broker", topic=TOPIC, client_factory=factory)
    source.start()
    client = factory.client
    client.connect()
    if ready:
        client.ack_subscribe(0)
    return source, client


def ack_override(client, reply):
    """Answer every override/set publish with a retained override document."""

    def on_publish(topic, _payload):
        if topic == f"{TOPIC}/override/set":
            client.deliver(f"{TOPIC}/override", json.dumps(reply))

    client.on_publish = on_publish


def ack_rapi(client, reply):
    """Answer every rapi/in publish with one rapi/out reply."""

    def on_publish(topic, _payload):
        if topic.startswith(f"{TOPIC}/rapi/in/"):
            client.deliver(f"{TOPIC}/rapi/out", reply)

    client.on_publish = on_publish


class _StopAfter:
    """Stand-in for the module stop event: ends the loop after N polls."""

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


class MqttSourceCommandTests(unittest.TestCase):
    """The source primitives the command path relies on."""

    def test_publish_prefixes_the_base_topic(self):
        source, client = make_source()
        source.publish("override/set", {"state": "disabled"})
        self.assertEqual(
            client.published,
            [(f"{TOPIC}/override/set", {"state": "disabled"}, 1)],
        )
        self.assertEqual(source.publishes, 1)

    def test_a_rejected_publish_raises(self):
        source, client = make_source()
        client.publish_rc = 4
        with self.assertRaises(MqttPublishError) as raised:
            source.publish("override/set", "clear")
        self.assertIn("rc 4", str(raised.exception))

    def test_a_publish_before_start_raises(self):
        with self.assertRaises(MqttPublishError):
            MqttSource(host="broker").publish("override/set", "clear")

    def test_ready_requires_connected_and_subscribed(self):
        source, client = make_source(ready=False)
        self.assertTrue(source.connected)
        self.assertFalse(source.subscribed)
        self.assertFalse(source.ready)
        client.ack_subscribe(0)
        self.assertTrue(source.ready)
        client.drop()
        self.assertFalse(source.ready)

    def test_the_override_echo_is_ignored_and_the_retained_document_tracked(self):
        source, client = make_source()
        client.deliver(f"{TOPIC}/override/set", '{"state":"disabled"}')
        self.assertIsNone(source.override)
        self.assertEqual(source.override_updates, 0)
        client.deliver(f"{TOPIC}/override", '{"state":"disabled","auto_release":true}')
        self.assertEqual(source.override, {"state": "disabled", "auto_release": True})
        self.assertEqual(
            source.command_view(),
            {
                "status": {},
                "override": {"state": "disabled", "auto_release": True},
            },
        )

    def test_wait_for_state_wakes_on_a_later_message(self):
        source, client = make_source()
        timer = threading.Timer(
            0.02,
            lambda: client.deliver(f"{TOPIC}/override", '{"state":"disabled"}'),
        )
        timer.daemon = True
        timer.start()
        try:
            confirmed = source.wait_for_state(
                lambda view: (view["override"] or {}).get("state") == "disabled", 1
            )
        finally:
            timer.cancel()
        self.assertTrue(confirmed)

    def test_wait_for_state_times_out(self):
        source, _client = make_source()
        started = time.monotonic()
        self.assertFalse(source.wait_for_state(lambda _view: False, CONFIRM))
        self.assertLess(time.monotonic() - started, 1)

    def test_wait_for_rapi_only_returns_a_newer_reply(self):
        source, client = make_source()
        client.deliver(f"{TOPIC}/rapi/out", "$OK old")
        self.assertIsNone(source.wait_for_rapi(source.rapi_generation(), CONFIRM))

    def test_rapi_transaction_returns_the_next_reply(self):
        source, client = make_source()
        ack_rapi(client, "$OK 01 0 01 0200^12")
        reply = source.rapi_transaction(f"rapi/in/$GS", "", CONFIRM)
        self.assertEqual(reply, "$OK 01 0 01 0200^12")
        self.assertEqual(client.published[-1][0], f"{TOPIC}/rapi/in/$GS")

    def test_rapi_transactions_are_serialised(self):
        source, client = make_source()
        state = {"active": 0, "max": 0}
        lock = threading.Lock()

        def on_publish(topic, _payload):
            if not topic.startswith(f"{TOPIC}/rapi/in/"):
                return
            with lock:
                state["active"] += 1
                state["max"] = max(state["max"], state["active"])
            time.sleep(0.05)
            client.deliver(f"{TOPIC}/rapi/out", "$OK")
            with lock:
                state["active"] -= 1

        client.on_publish = on_publish
        replies = []

        def run(command):
            replies.append(source.rapi_transaction(f"rapi/in/{command}", "", 1))

        threads = [threading.Thread(target=run, args=(cmd,)) for cmd in ("$GS", "$GV")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(2)
        self.assertEqual(state["max"], 1)
        self.assertEqual(replies, ["$OK", "$OK"])


class MqttOverrideCommandTests(unittest.TestCase):
    def test_pause_publishes_disabled_and_confirms_from_the_override_document(self):
        source, client = make_source()
        ack_override(client, {"state": "disabled", "auto_release": True})
        session = FakeSession()
        extra = bridge.apply_command(
            session, BASE, None, {"type": "pause"}, source=source, confirm_sec=CONFIRM
        )
        self.assertEqual(extra, {"transport": "mqtt"})
        self.assertEqual(
            client.published,
            [(f"{TOPIC}/override/set", '{"state": "disabled"}', 1)],
        )
        self.assertEqual(session.calls, [])

    def test_resume_publishes_clear(self):
        source, client = make_source()
        ack_override(client, {"state": "null"})
        session = FakeSession()
        extra = bridge.apply_command(
            session, BASE, None, {"type": "resume"}, source=source, confirm_sec=CONFIRM
        )
        self.assertEqual(extra, {"transport": "mqtt"})
        self.assertEqual(client.published, [(f"{TOPIC}/override/set", "clear", 1)])
        self.assertEqual(session.calls, [])

    def test_set_current_publishes_the_clamped_amps(self):
        source, client = make_source()
        ack_override(
            client,
            {"state": "active", "charge_current": 48, "max_current": 48},
        )
        session = FakeSession()
        extra = bridge.apply_command(
            session,
            BASE,
            None,
            {"type": "set_current", "amps": 99},
            source=source,
            confirm_sec=CONFIRM,
        )
        self.assertEqual(extra, {"transport": "mqtt"})
        self.assertEqual(
            client.published,
            [
                (
                    f"{TOPIC}/override/set",
                    '{"state": "active", "charge_current": 48, "max_current": 48}',
                    1,
                )
            ],
        )
        self.assertEqual(session.calls, [])

    def test_an_override_with_another_current_does_not_confirm(self):
        source, client = make_source()
        ack_override(
            client,
            {"state": "active", "charge_current": 16, "max_current": 16},
        )
        session = FakeSession()
        with self.assertRaises(bridge.CommandError) as raised:
            bridge.apply_command(
                session,
                BASE,
                None,
                {"type": "set_current", "amps": 20},
                source=source,
                confirm_sec=CONFIRM,
            )
        self.assertIn("no confirmation", str(raised.exception))
        self.assertEqual(raised.exception.transport, "mqtt")
        # A read-only status reconcile, never a second apply.
        self.assertEqual([call[0] for call in session.calls], ["get"])

    def test_the_status_seed_can_confirm_before_the_override_document(self):
        source, _client = make_source()
        source.seed({"state": 254, "status": "disabled", "manual_override": 1})
        session = FakeSession()
        extra = bridge.apply_command(
            session, BASE, None, {"type": "pause"}, source=source, confirm_sec=CONFIRM
        )
        self.assertEqual(extra, {"transport": "mqtt"})
        self.assertEqual(session.calls, [])

    def test_a_timeout_fails_without_reapplying_over_http(self):
        source, client = make_source()
        session = FakeSession(
            [FakeResponse(200, {"status": "active", "manual_override": 0})]
        )
        with self.assertRaises(bridge.CommandError) as raised:
            bridge.apply_command(
                session,
                BASE,
                None,
                {"type": "pause"},
                source=source,
                confirm_sec=CONFIRM,
            )
        self.assertIn("no confirmation", str(raised.exception))
        self.assertEqual(raised.exception.transport, "mqtt")
        self.assertEqual([call[0] for call in session.calls], ["get"])
        self.assertEqual(
            client.published,
            [(f"{TOPIC}/override/set", '{"state": "disabled"}', 1)],
        )

    def test_a_lost_confirmation_can_be_confirmed_by_a_status_reconcile(self):
        source, _client = make_source()
        session = FakeSession([FakeResponse(200, {"status": "disabled"})])
        extra = bridge.apply_command(
            session, BASE, None, {"type": "pause"}, source=source, confirm_sec=CONFIRM
        )
        self.assertEqual(extra, {"transport": "mqtt"})
        self.assertEqual([call[0] for call in session.calls], ["get"])

    def test_a_refused_publish_falls_back_to_http(self):
        source, client = make_source()
        client.publish_rc = 4
        session = FakeSession([FakeResponse(200)])
        extra = bridge.apply_command(
            session, BASE, None, {"type": "pause"}, source=source, confirm_sec=CONFIRM
        )
        self.assertEqual(extra, {})  # the HTTP path's shape is unchanged
        self.assertEqual(session.calls[0][0], "post")
        self.assertEqual(session.calls[0][1], f"{BASE}/override")

    def test_an_ack_wait_error_fails_without_an_http_reapply(self):
        source, _client = make_source()
        session = FakeSession()
        with mock.patch.object(
            source, "wait_for_state", side_effect=RuntimeError("boom")
        ):
            with self.assertRaises(bridge.CommandError) as raised:
                bridge.apply_command(
                    session,
                    BASE,
                    None,
                    {"type": "pause"},
                    source=source,
                    confirm_sec=CONFIRM,
                )
        self.assertIn("mqtt acknowledgement failed", str(raised.exception))
        self.assertEqual(raised.exception.transport, "mqtt")
        self.assertEqual(session.calls, [])


class MqttRapiCommandTests(unittest.TestCase):
    def test_rapi_publishes_the_command_as_topic_and_params_as_payload(self):
        source, client = make_source()
        ack_rapi(client, "$OK 01 0 01 0200^12")
        session = FakeSession()
        extra = bridge.apply_command(
            session,
            BASE,
            None,
            {"type": "rapi", "command": "$FS 20"},
            source=source,
            confirm_sec=CONFIRM,
        )
        self.assertEqual(
            extra, {"result": "$OK 01 0 01 0200^12", "transport": "mqtt"}
        )
        self.assertEqual(client.published, [(f"{TOPIC}/rapi/in/$FS", "20", 1)])
        self.assertEqual(session.calls, [])

    def test_rapi_without_params_publishes_an_empty_payload(self):
        source, client = make_source()
        ack_rapi(client, "$OK 01 0 01 0200^12")
        bridge.apply_command(
            FakeSession(),
            BASE,
            None,
            {"type": "rapi", "command": "$GS"},
            source=source,
            confirm_sec=CONFIRM,
        )
        self.assertEqual(client.published, [(f"{TOPIC}/rapi/in/$GS", "", 1)])

    def test_rapi_nk_is_a_failure_with_the_reply(self):
        source, client = make_source()
        ack_rapi(client, "$NK^21")
        with self.assertRaises(bridge.CommandError) as raised:
            bridge.apply_command(
                FakeSession(),
                BASE,
                None,
                {"type": "rapi", "command": "$XX 20"},
                source=source,
                confirm_sec=CONFIRM,
            )
        self.assertIn("$NK^21", str(raised.exception))
        self.assertEqual(raised.exception.transport, "mqtt")

    def test_rapi_timeout_fails_without_an_http_retry(self):
        source, _client = make_source()
        session = FakeSession()
        with self.assertRaises(bridge.CommandError) as raised:
            bridge.apply_command(
                session,
                BASE,
                None,
                {"type": "rapi", "command": "$GS"},
                source=source,
                confirm_sec=CONFIRM,
            )
        self.assertIn("no rapi/out", str(raised.exception))
        self.assertEqual(raised.exception.transport, "mqtt")
        self.assertEqual(session.calls, [])

    def test_a_refused_rapi_publish_falls_back_to_http(self):
        source, client = make_source()
        client.publish_rc = 1
        session = FakeSession([FakeResponse(200, {"ret": "OK"})])
        extra = bridge.apply_command(
            session,
            BASE,
            None,
            {"type": "rapi", "command": "$GS"},
            source=source,
            confirm_sec=CONFIRM,
        )
        self.assertEqual(extra, {"result": "OK"})
        self.assertEqual(session.calls[0][1], f"{BASE}/rapi")


class FallbackTests(unittest.TestCase):
    def test_a_connected_but_unsubscribed_source_uses_http(self):
        source, client = make_source(ready=False)
        session = FakeSession([FakeResponse(200)])
        extra = bridge.apply_command(
            session, BASE, None, {"type": "pause"}, source=source
        )
        self.assertEqual(extra, {})
        self.assertEqual(client.published, [])
        self.assertEqual(session.calls[0][0], "post")

    def test_a_disconnected_source_uses_http(self):
        source, client = make_source(ready=False)
        client.drop()
        session = FakeSession([FakeResponse(200)])
        bridge.apply_command(session, BASE, None, {"type": "pause"}, source=source)
        self.assertEqual(client.published, [])
        self.assertEqual(session.calls[0][0], "post")

    def test_no_source_keeps_the_existing_http_path(self):
        session = FakeSession([FakeResponse(200)])
        self.assertEqual(
            bridge.apply_command(session, BASE, None, {"type": "pause"}), {}
        )
        self.assertEqual(session.calls[0][0], "post")


class CommandLoopTransportTests(unittest.TestCase):
    def command(self, ctype="pause", **extra):
        return {
            "status": "pending",
            "type": ctype,
            "created_at": datetime.now(UTC),
            **extra,
        }

    def run_loop(self, db, source, polls=1, session=None, on_wait=None):
        session = session or FakeSession()
        transport = bridge.ChargerTransport(session)
        with mock.patch.object(bridge, "_stop", _StopAfter(polls, on_wait)):
            bridge.command_loop(db, BASE, None, transport, 0, source)
        return session

    def test_an_mqtt_ack_is_recorded_with_its_transport(self):
        source, client = make_source()
        ack_override(client, {"state": "disabled"})
        db = FakeDB({"commands": {"cmd": self.command()}})
        session = self.run_loop(db, source)
        doc = db.data["commands"]["cmd"]
        self.assertEqual(doc["status"], "acked")
        self.assertEqual(doc["transport"], "mqtt")
        self.assertEqual(session.calls, [])

    def test_an_http_ack_is_recorded_with_its_transport(self):
        source, client = make_source(ready=False)
        db = FakeDB({"commands": {"cmd": self.command()}})
        session = self.run_loop(db, source)
        doc = db.data["commands"]["cmd"]
        self.assertEqual(doc["status"], "acked")
        self.assertEqual(doc["transport"], "http")
        self.assertEqual(client.published, [])
        self.assertEqual(session.calls[0][0], "post")

    def test_an_mqtt_timeout_is_recorded_as_failed_with_its_transport(self):
        source, client = make_source()
        db = FakeDB({"commands": {"cmd": self.command()}})
        session = FakeSession(
            [FakeResponse(200, {"status": "active", "manual_override": 0})]
        )
        with mock.patch.object(bridge, "COMMAND_CONFIRM_SEC", CONFIRM):
            self.run_loop(db, source, session=session)
        doc = db.data["commands"]["cmd"]
        self.assertEqual(doc["status"], "failed")
        self.assertEqual(doc["transport"], "mqtt")
        self.assertIn("no confirmation", doc["error"])
        # One publish, then only the read-only status reconcile: no re-apply.
        self.assertEqual(len(client.published), 1)
        self.assertEqual([call[0] for call in session.calls], ["get"])

    def test_a_failed_status_write_does_not_republish_over_mqtt(self):
        source, client = make_source()
        ack_override(client, {"state": "disabled"})
        db = FakeDB({"commands": {"cmd": self.command()}})
        db.fail_writes = True

        def recover():
            db.fail_writes = False

        self.run_loop(db, source, polls=2, on_wait=recover)
        self.assertEqual(len(client.published), 1)
        self.assertEqual(db.data["commands"]["cmd"]["status"], "acked")

    def test_a_validation_failure_touches_no_transport(self):
        source, client = make_source()
        db = FakeDB(
            {"commands": {"cmd": self.command("rapi", command="not-a-command")}}
        )
        session = self.run_loop(db, source)
        doc = db.data["commands"]["cmd"]
        self.assertEqual(doc["status"], "failed")
        self.assertEqual(doc["error"], "invalid rapi")
        self.assertEqual(doc["transport"], "mqtt")
        self.assertEqual(client.published, [])
        self.assertEqual(session.calls, [])


if __name__ == "__main__":
    unittest.main()
