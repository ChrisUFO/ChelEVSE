"""Whole-tick loop-guard tests (issue #136): log the line, keep looping.

Each poll loop wraps its entire tick in a bare ``except Exception`` that logs
``<name> loop error (<Type>: <msg>)`` and continues — the bridge must survive
any collaborator crash without losing a loop. Pinned here, ahead of the loop
decomposition (#137–#139), with one novel mid-tick failure per loop: the exact
line is emitted and the next tick still runs. ``settings_loop`` and
``mqtt_status_loop`` have structurally different (narrower) guards and are out
of scope.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
from fakes import FakeDB, FakeResponse, FakeSession  # noqa: E402
from test_bridge import _StopAfter, _host, _status_payload  # noqa: E402


def _flaky_once(error, real):
    """A stand-in that raises once, then delegates to the real function."""

    def stand_in(payload):
        if stand_in.first:
            stand_in.first = False
            raise error
        return real(payload)

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
