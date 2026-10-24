"""FCM push notifications.

Extracted from ``bridge.py`` (behavior-preserving move): ``notify`` pushes one
notification to every registered FCM token (pruning dead ones); ``Notifier``
is the bounded background worker the status path enqueues onto.
"""

import queue
import threading

from firebase_admin import exceptions, messaging

from write_counter import WriteCounter


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.log(message)


def _notify(db, body, counter=None):
    # seam: tests patch bridge.notify (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.notify(db, body, counter=counter)



def notify(db, body, counter=None):
    """Push one notification to every registered FCM token; never raises.

    Tokens live in fcmTokens/{docId} with an optional `token` field (the doc id
    is the fallback). Each token is sent independently so one dead token cannot
    block the rest; unregistered/invalid tokens are pruned.
    """
    counter = counter or WriteCounter()
    try:
        docs = list(db.collection("fcmTokens").stream())
    except Exception as exc:
        log(f"fcm token read failed ({exc.__class__.__name__}: {exc})")
        return
    for doc in docs:
        try:
            data = doc.to_dict() or {}
        except Exception:
            data = {}
        token = data.get("token") if isinstance(data, dict) else None
        if not (isinstance(token, str) and token):
            token = doc.id
        try:
            messaging.send(
                messaging.Message(
                    notification=messaging.Notification(title="ChelEVSE", body=body),
                    token=token,
                )
            )
        except (messaging.UnregisteredError, exceptions.InvalidArgumentError):
            try:
                doc.reference.delete()
            except Exception as exc:
                counter.note_failure(exc)
                log(f"fcm token prune failed ({exc.__class__.__name__}: {exc})")
            else:
                # A delete is a billed write; it counts (issue #96).
                counter.record("fcm")
                log(f"pruned fcm token {doc.id}")
        except Exception as exc:
            log(f"fcm send failed ({exc.__class__.__name__}: {exc})")


class Notifier:
    """Background FCM sender: status ticks enqueue and never wait on a push.

    firebase-admin's HTTP client defaults to a long timeout with retries, so a
    stalled FCM/network call must not hold the status loop (and with it status,
    history and session writes). One daemon worker drains a bounded queue; a
    full queue drops the newest push rather than blocking the caller.
    """

    def __init__(self, db, max_queue=64, counter=None):
        self.db = db
        self.queue = queue.Queue(maxsize=max_queue)
        self._thread = None
        self._lock = threading.Lock()
        # The write counter the token prunes record into (issue #96).
        self.counter = counter or WriteCounter()

    def enqueue(self, body):
        self._ensure_worker()
        try:
            self.queue.put_nowait(body)
        except queue.Full:
            log(f"fcm queue full; dropped notification: {body}")

    def _ensure_worker(self):
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._run, name="fcm-notifier", daemon=True
            )
            self._thread.start()

    def _run(self):
        while True:
            body = self.queue.get()
            try:
                _notify(self.db, body, counter=self.counter)
            except Exception as exc:  # never let one push kill the worker
                log(f"fcm notify error ({exc.__class__.__name__}: {exc})")
            finally:
                self.queue.task_done()


