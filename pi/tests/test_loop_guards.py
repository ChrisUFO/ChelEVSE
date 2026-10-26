"""Whole-tick loop-guard tests (issue #136): log the line, keep looping.

Each poll loop wraps its entire tick in a bare ``except Exception`` that logs
``<name> loop error (<Type>: <msg>)`` and continues — the bridge must survive
any collaborator crash without losing a loop. Pinned here, ahead of the loop
decomposition (#137–#139), with one novel mid-tick failure per loop: the exact
line is emitted and the next tick still runs. The status loop's prologue —
the transport-edge read and health write the #139 decomposition widened into
the guard (a novel exception there used to kill the poller) — is pinned the
same way, as is the other preservation constraint that decomposition added:
a config tick that already waited on the version event must not stack the
tail wait on top of it. ``settings_loop`` and
``mqtt_status_loop`` have structurally different (narrower) guards and are out
of scope.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
from fakes import (  # noqa: E402
    FakeDB,
    FakeMqttFactory,
    FakeResponse,
    FakeSession,
    _StopAfter,
    _host,
    _status_payload,
)
from mqtt_source import MqttSource  # noqa: E402


def _flaky_once(error, real):
    """A stand-in that raises once, then delegates to the real function."""

    def stand_in(*args, **kwargs):
        if stand_in.first:
            stand_in.first = False
            raise error
        return real(*args, **kwargs)

    stand_in.first = True
    return stand_in


class StatusLoopGuardTests(unittest.TestCase):
    def test_a_mid_tick_crash_logs_the_guard_line_and_the_loop_continues(self):
        db = FakeDB()
        host = _host()
        session = FakeSession([FakeResponse(200, _status_payload())] * 2)
        transport = bridge.ChargerTransport(session)
        notifier = bridge.Notifier(db)
        tracker = bridge.StatusTracker(db)
        watchdog = bridge.Watchdog(
            db, host, None, transport, notifier, bridge.WatchdogConfig(enabled=False)
        )
        logs = []
        with mock.patch.object(bridge, "_stop", _StopAfter(2)), mock.patch.object(
            bridge, "log", logs.append
        ), mock.patch.object(
            bridge,
            "parse_status",
            _flaky_once(RuntimeError("novel blip"), bridge.parse_status),
        ):
            bridge.status_loop(db, host, None, transport, 10, tracker, notifier, watchdog)
        self.assertEqual(logs.count("status loop error (RuntimeError: novel blip)"), 1)
        # The second tick polled again: the loop continued past the crash.
        self.assertEqual(
            [call[1] for call in session.calls], ["http://charger/status"] * 2
        )

    def test_a_prologue_crash_logs_the_guard_line_and_the_loop_continues(self):
        # The prologue (the transport-state edge read and its health write)
        # sat outside the old loop's try: a novel exception there killed the
        # status poller outright. The whole-tick guard now covers it, and this
        # pins that widening: the crash is logged, the next tick still polls.
        factory = FakeMqttFactory()
        mqtt = MqttSource(
            "broker", topic="chelevse", client_factory=factory, log=lambda _m: None
        )
        self.addCleanup(mqtt.stop)
        mqtt.start()
        factory.client.connect()
        factory.client.ack_subscribe([0])  # grant the status subscription
        db = FakeDB()
        host = _host()
        session = FakeSession([FakeResponse(200, _status_payload())])
        transport = bridge.ChargerTransport(session)
        notifier = bridge.Notifier(db)
        tracker = bridge.StatusTracker(db)
        watchdog = bridge.Watchdog(
            db, host, None, transport, notifier, bridge.WatchdogConfig(enabled=False)
        )
        logs = []
        with mock.patch.object(bridge, "_stop", _StopAfter(2)), mock.patch.object(
            bridge, "log", logs.append
        ), mock.patch.object(
            bridge,
            "write_transport_health",
            _flaky_once(RuntimeError("novel blip"), bridge.write_transport_health),
        ):
            bridge.status_loop(
                db, host, None, transport, 10, tracker, notifier, watchdog, mqtt
            )
        self.assertEqual(logs.count("status loop error (RuntimeError: novel blip)"), 1)
        # The crash struck the prologue's edge block: its source line is the
        # last thing logged before the health write raised — the exact prefix,
        # not merely membership.
        self.assertEqual(
            logs[:2],
            [
                "status source: mqtt (mqtt connected)",
                "status loop error (RuntimeError: novel blip)",
            ],
        )
        # The crashing tick died before its poll; the second tick ran anyway
        # and completed the reconcile poll.
        self.assertEqual(
            [call[1] for call in session.calls], ["http://charger/status"]
        )


class ConfigLoopGuardTests(unittest.TestCase):
    def test_a_mid_tick_crash_logs_the_guard_line_and_the_loop_continues(self):
        db = FakeDB()
        session = FakeSession([FakeResponse(200, {"firmware": "master"})] * 2)
        transport = bridge.ChargerTransport(session)
        logs = []
        with mock.patch.object(bridge, "_stop", _StopAfter(2)), mock.patch.object(
            bridge, "log", logs.append
        ), mock.patch.object(
            bridge,
            "redact_config",
            _flaky_once(RuntimeError("novel blip"), bridge.redact_config),
        ):
            bridge.config_loop(db, _host(), None, transport, 60)
        self.assertEqual(logs.count("config loop error (RuntimeError: novel blip)"), 1)
        # The second tick fetched /config again and completed its sync.
        self.assertEqual(
            [call[1] for call in session.calls], ["http://charger/config"] * 2
        )
        self.assertIn("config synced", logs)


class _ReadyMqtt:
    """The MQTT surface config_loop reads, mid-session: fully usable."""

    def __init__(self):
        self.connected = True
        self.subscribed = True
        self.subscription = "chelevse/#"
        self.config_version = 1
        self.announced = None


class _TimingOutEvent:
    """A config_version event that times out N times, then fires.

    Waits are counted so the pin can assert them; nothing blocks, so the
    tick sequence is deterministic without threads or timers.
    """

    def __init__(self, timeouts):
        self._timeouts = timeouts
        self.waits = 0

    def wait(self, timeout=None):
        self.waits += 1
        return self.waits > self._timeouts

    def set(self):
        pass

    def clear(self):
        pass


class RunLoopEventWaitTests(unittest.TestCase):
    def test_an_event_wait_pass_skips_the_tail_wait(self):
        # A config tick that waited on the version event returns True so
        # run_loop skips the tail wait (the old loop expressed the same skip
        # as continue). If that regressed, every event-driven tick would
        # stack a second wait on top of the event wait and slow config syncs
        # — with no other test noticing — so pin the wait counts directly.
        event = _TimingOutEvent(timeouts=1)
        session = FakeSession([FakeResponse(200, {"firmware": "master"})])
        transport = bridge.ChargerTransport(session)
        stop = _StopAfter(1)
        with mock.patch.object(bridge, "_stop", stop):
            bridge.config_loop(
                FakeDB(),
                _host(),
                None,
                transport,
                60,
                0,
                _ReadyMqtt(),
                event,
                tick=0,
            )
        # Tick 1 timed out on the event and skipped its tail wait; tick 2
        # fired, synced over HTTP, and took the one tail wait that tripped
        # _StopAfter. A regressed skip would tail-wait after tick 1 too,
        # end the loop there, and never reach the fetch.
        self.assertEqual(event.waits, 2)
        self.assertEqual(stop._waited, 1)
        self.assertEqual([call[1] for call in session.calls], ["http://charger/config"])


class CommandLoopGuardTests(unittest.TestCase):
    def test_a_firestore_read_failure_logs_the_guard_line_each_tick(self):
        db = FakeDB()
        db.fail_reads = True
        session = FakeSession()
        transport = bridge.ChargerTransport(session)
        logs = []
        with mock.patch.object(bridge, "_stop", _StopAfter(2)), mock.patch.object(
            bridge, "log", logs.append
        ):
            bridge.command_loop(db, _host(), None, transport, 0)
        # Two ticks, one guard line each: the loop kept going after the crash.
        self.assertEqual(logs, ["command loop error (RuntimeError: read failed)"] * 2)
        # The crash preceded the dispatch: the charger was never contacted.
        self.assertEqual(session.calls, [])


class ScheduleLoopGuardTests(unittest.TestCase):
    def test_a_firestore_read_failure_logs_the_guard_line_each_tick(self):
        db = FakeDB()
        db.fail_reads = True
        transport = bridge.ChargerTransport(FakeSession())
        sink = mock.Mock()
        logs = []
        with mock.patch.object(bridge, "_stop", _StopAfter(2)), mock.patch.object(
            bridge, "log", logs.append
        ):
            bridge.schedule_loop(db, _host(), None, transport, 60, 300, sink)
        # Two ticks, one guard line each: the loop kept going after the crash.
        self.assertEqual(logs, ["schedule loop error (RuntimeError: read failed)"] * 2)
        # The crash preceded the plan read: nothing reached the sink.
        sink.note_schedule.assert_not_called()


if __name__ == "__main__":
    unittest.main()
