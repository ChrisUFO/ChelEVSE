"""Edge-branch tests for pi/notify.py (issue #136).

The FCM paths the happy-path tests skip: the never-raises edges of ``notify``
(a token-read failure, a generic send failure with no retry, both prune
outcomes) and the worker's own resilience (a crashing push, the full-queue
drop, a dead worker thread restarted by the next enqueue). Pinned ahead of
the loop decomposition: these branches must survive the refactor unchanged.
"""

import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge  # noqa: E402
import notify  # noqa: E402
from fakes import FakeDB  # noqa: E402


class NotifyEdgeTests(unittest.TestCase):
    """notify(): one log line per failure, never a raise, never a retry."""

    def setUp(self):
        self.logs = []
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_token_read_failure_is_logged_and_nothing_is_sent(self):
        db = FakeDB({"fcmTokens": {"a": {"token": "a"}}})
        db.fail_reads = True
        send = mock.Mock()
        with mock.patch.object(bridge.messaging, "send", send):
            bridge.notify(db, "Charging started")
        send.assert_not_called()
        self.assertEqual(
            self.logs, ["fcm token read failed (RuntimeError: read failed)"]
        )

    def test_a_generic_send_failure_is_logged_once_per_token_and_not_retried(self):
        db = FakeDB(
            {"fcmTokens": {"flaky": {"token": "flaky"}, "good": {"token": "good"}}}
        )

        def fake_send(message):
            if message.token == "flaky":
                raise TimeoutError("fcm timeout")
            return "ok"

        with mock.patch.object(
            bridge.messaging, "send", side_effect=fake_send
        ) as send:
            bridge.notify(db, "Charging stopped")
        # One attempt per token: a failed push is log-and-drop, never retried.
        self.assertEqual(send.call_count, 2)
        self.assertEqual(self.logs, ["fcm send failed (TimeoutError: fcm timeout)"])
        # A send failure (unlike an unregistered token) never prunes the token.
        self.assertEqual(set(db.data["fcmTokens"]), {"flaky", "good"})

    def test_an_unsendable_token_is_pruned_and_the_delete_counts_fcm(self):
        for gone in (
            bridge.messaging.UnregisteredError("gone"),
            bridge.exceptions.InvalidArgumentError("bad token"),
        ):
            with self.subTest(error=type(gone).__name__):
                db = FakeDB({"fcmTokens": {"dead": {"token": "dead"}}})
                counter = bridge.WriteCounter()
                self.logs.clear()
                with mock.patch.object(bridge.messaging, "send", side_effect=gone):
                    bridge.notify(db, "Charging stopped", counter=counter)
                self.assertEqual(set(db.data["fcmTokens"]), set())
                # The prune is a billed write (issue #96).
                self.assertEqual(counter.snapshot()[1]["fcm"], 1)
                self.assertEqual(self.logs, ["pruned fcm token dead"])

    def test_a_failed_prune_counts_a_failed_write_and_keeps_the_token(self):
        db = FakeDB({"fcmTokens": {"dead": {"token": "dead"}}})
        db.fail_deletes = True
        counter = mock.Mock()
        with mock.patch.object(
            bridge.messaging,
            "send",
            side_effect=bridge.messaging.UnregisteredError("gone"),
        ):
            bridge.notify(db, "Charging stopped", counter=counter)
        (failure,) = counter.note_failure.call_args.args
        self.assertIsInstance(failure, RuntimeError)
        self.assertEqual(
            self.logs, ["fcm token prune failed (RuntimeError: delete failed)"]
        )
        self.assertEqual(set(db.data["fcmTokens"]), {"dead"})


class NotifierWorkerTests(unittest.TestCase):
    """The background worker's own edges: crash guard, queue, thread life."""

    def setUp(self):
        self.logs = []
        patcher = mock.patch.object(bridge, "log", self.logs.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_crashing_push_is_logged_and_the_worker_drains_the_next_one(self):
        notifier = bridge.Notifier(FakeDB())
        with mock.patch.object(
            bridge,
            "notify",
            side_effect=[RuntimeError("worker boom"), None],
        ) as fake_notify:
            notifier.enqueue("one")
            notifier.queue.join()
            notifier.enqueue("two")
            notifier.queue.join()
        # The worker survived the crash (join returned: task_done ran) and the
        # next push was still delivered.
        self.assertEqual(fake_notify.call_count, 2)
        self.assertIn("fcm notify error (RuntimeError: worker boom)", self.logs)

    def test_a_full_queue_drops_the_newest_push_without_blocking(self):
        notifier = bridge.Notifier(FakeDB(), max_queue=1)
        entered = threading.Event()
        release = threading.Event()
        delivered = []

        def blocked(db, body, counter=None):
            delivered.append(body)
            entered.set()
            release.wait(timeout=5)

        with mock.patch.object(notify, "_notify", blocked):
            notifier.enqueue("first")
            self.assertTrue(entered.wait(5), "worker never picked up the first push")
            worker = notifier._thread
            notifier.enqueue("second")
            # The queue (maxsize 1) is full: the newest push is dropped inline
            # by enqueue itself, not after waiting for space.
            notifier.enqueue("third")
            self.assertIn("fcm queue full; dropped notification: third", self.logs)
            release.set()
            notifier.queue.join()
        self.assertEqual(delivered, ["first", "second"])
        # One lazy worker serves every enqueue; a drop never restarts it.
        self.assertIs(notifier._thread, worker)

    def test_a_dead_worker_thread_is_restarted_by_the_next_enqueue(self):
        notifier = bridge.Notifier(FakeDB())

        def dying():
            raise RuntimeError("worker died")

        notifier._run = dying  # the next started thread dies immediately
        with mock.patch.object(threading, "excepthook", lambda _args: None):
            notifier.enqueue("backlog")
            notifier._thread.join(timeout=5)
        self.assertFalse(notifier._thread.is_alive())
        dead_thread = notifier._thread
        del notifier._run  # restore the real worker body

        delivered = []
        with mock.patch.object(
            bridge, "notify", lambda db, body, counter=None: delivered.append(body)
        ):
            notifier.enqueue("retry me")
            deadline = time.monotonic() + 5
            while "retry me" not in delivered and time.monotonic() < deadline:
                time.sleep(0.01)
        # The restarted worker is a fresh thread that also drains the backlog
        # the dead one never took. (queue.join is unusable here: the dead
        # thread died without task_done for its item.)
        self.assertEqual(delivered, ["backlog", "retry me"])
        self.assertIsNot(notifier._thread, dead_thread)
        self.assertTrue(notifier._thread.is_alive())


if __name__ == "__main__":
    unittest.main()
