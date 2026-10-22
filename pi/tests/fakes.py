"""In-memory Firestore and HTTP fakes for the pi bridge unit tests.

Nothing here touches the charger, Firestore, or FCM; the fakes implement only
the small surface bridge.py and acl.py use.
"""

import json

import requests
from firebase_admin import firestore


def _is_number(value):
    """True for int/float but not bool (bool is a subclass of int)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _field_path_segments(path):
    """Split ``a.b`` or ``a.`21`.c`` into segments (backticks quote a segment).

    Firestore field paths cannot carry a bare numeric segment -- the SDK's
    parser rejects ``hours.21`` -- so a write mask names the hour bucket as
    ``hours.`21```. The fake enforces the same rule, so a mask that only works
    on the fake cannot pass here.
    """
    segments = []
    current = []
    in_quotes = False
    was_quoted = False
    for char in path:
        if char == "`":
            in_quotes = not in_quotes
            was_quoted = True
        elif char == "." and not in_quotes:
            segments.append(("".join(current), was_quoted))
            current = []
            was_quoted = False
        else:
            current.append(char)
    segments.append(("".join(current), was_quoted))
    if in_quotes:
        raise ValueError(f"unterminated quote in field path {path!r}")
    for name, quoted in segments:
        if not name:
            raise ValueError(f"empty segment in field path {path!r}")
        if not quoted and name.isdigit():
            raise ValueError(f"numeric segment must be quoted in {path!r}")
    return [name for name, _ in segments]


def _leaf_write(existing, value, field):
    """One leaf of a write: an Increment accumulates, a plain value replaces."""
    if isinstance(value, firestore.Increment):
        if existing is None:
            return value._value
        if not _is_number(existing):
            raise TypeError(f"Increment on non-numeric field {field!r}")
        return existing + value._value
    return value


def _merge_top_level(existing, data):
    """``set(..., merge=True)``: merge top-level keys; nested maps replace."""
    merged = dict(existing)
    for key, value in data.items():
        merged[key] = _leaf_write(merged.get(key), value, key)
    return merged


def _write_path(target, segments, value):
    """Write one masked field path, copying each map so siblings survive."""
    head = segments[0]
    existing = target.get(head)
    if len(segments) == 1:
        target[head] = _leaf_write(existing, value, ".".join(segments))
        return
    if existing is None:
        child = {}
    elif isinstance(existing, dict):
        child = dict(existing)
    else:
        # The server rejects creating a nested field under a non-map value.
        raise TypeError(f"cannot write {'.'.join(segments)!r} under a non-map field")
    _write_path(child, segments[1:], value)
    target[head] = child


def _merge_field_paths(existing, data, field_paths):
    """``set(..., merge=[paths])``: write exactly the named leaves.

    The payload is addressed by the same nested shape the caller sent (the hour
    bucket lives under ``hours``), and only the masked leaf is written, so
    sibling leaves and every unmasked field stay exactly as they were. A mask
    naming a field the payload does not carry raises, as the server would.
    """
    merged = dict(existing)
    for path in field_paths:
        segments = _field_path_segments(path)
        value = data
        for segment in segments:
            value = value[segment]
        _write_path(merged, segments, value)
    return merged


class FakeSnapshot:
    """A document snapshot with the reference used by mutating callers."""

    def __init__(self, db, collection, doc_id, data, exists=True):
        self.id = doc_id
        self.exists = exists
        self._data = data
        self.reference = FakeDocument(db, collection, doc_id)

    def to_dict(self):
        if self._data is None:
            return None
        return dict(self._data)


class FakeDocument:
    """Document reference backed by a FakeDB dictionary."""

    def __init__(self, db, collection, doc_id):
        self._db = db
        self.collection = collection
        self.id = doc_id

    @property
    def reference(self):
        return self

    def get(self):
        if self._db.fail_reads:
            raise RuntimeError("read failed")
        store = self._db.data.get(self.collection, {})
        if self.id not in store:
            return FakeSnapshot(self._db, self.collection, self.id, None, exists=False)
        return FakeSnapshot(self._db, self.collection, self.id, store[self.id])

    def set(self, data, merge=False):
        """Model ``DocumentReference.set``, including the three merge forms.

        ``merge=False`` replaces the document, ``merge=True`` merges top-level
        keys only, and a list of field paths merges exactly those leaves
        (creating the document when absent, with no existence precondition).
        ``Increment`` transforms resolve to numbers here, so ``db.data`` reads
        like a stored document; ``db.writes`` keeps the raw payload and the
        merge argument the caller passed, for payload/mask assertions.
        """
        if self._db.write_error is not None:
            raise self._db.write_error
        if self._db.fail_writes:
            raise RuntimeError("write failed")
        self._db.writes.append(("set", self.collection, self.id, data, merge))
        store = self._db.data.setdefault(self.collection, {})
        existing = store.get(self.id)
        if merge is True:
            store[self.id] = _merge_top_level(existing or {}, data)
        elif isinstance(merge, (list, tuple)):
            store[self.id] = _merge_field_paths(existing or {}, data, merge)
        elif merge:
            raise TypeError(f"unsupported merge argument {merge!r}")
        else:
            store[self.id] = _merge_top_level({}, data)

    def update(self, data):
        if self._db.write_error is not None:
            raise self._db.write_error
        if self._db.fail_writes:
            raise RuntimeError("write failed")
        self._db.writes.append(("update", self.collection, self.id, data, None))
        store = self._db.data.setdefault(self.collection, {})
        if self.id not in store:
            raise KeyError(self.id)
        store[self.id].update(data)

    def delete(self):
        if self._db.write_error is not None:
            raise self._db.write_error
        if self._db.fail_deletes:
            raise RuntimeError("delete failed")
        self._db.writes.append(("delete", self.collection, self.id, None, None))
        self._db.data.get(self.collection, {}).pop(self.id, None)


class FakeQuery:
    """Equality filters, one order_by, and a limit -- enough for the bridge."""

    def __init__(self, db, collection, filters=(), order=None, count=None):
        self._db = db
        self._collection = collection
        self._filters = tuple(filters)
        self._order = order
        self._count = count

    def where(self, filter=None, **kwargs):
        return FakeQuery(
            self._db,
            self._collection,
            self._filters + (filter,),
            self._order,
            self._count,
        )

    def order_by(self, field, direction=None):
        return FakeQuery(
            self._db, self._collection, self._filters, (field, direction), self._count
        )

    def limit(self, count):
        return FakeQuery(self._db, self._collection, self._filters, self._order, count)

    def stream(self):
        if self._db.fail_reads:
            raise RuntimeError("read failed")
        rows = [
            FakeSnapshot(self._db, self._collection, doc_id, data)
            for doc_id, data in self._db.data.get(self._collection, {}).items()
        ]
        for condition in self._filters:
            if condition is None:
                continue
            rows = [row for row in rows if self._matches(row, condition)]
        if self._order is not None:
            field, direction = self._order
            reverse = str(direction).endswith("DESCENDING")

            def sort_key(row):
                value = (row.to_dict() or {}).get(field)
                return value if value is not None else ""

            rows.sort(key=sort_key, reverse=reverse)
        if self._count is not None:
            rows = rows[: self._count]
        return rows

    @staticmethod
    def _matches(row, condition):
        data = row.to_dict() or {}
        value = data.get(condition.field_path)
        if condition.op_string == "==":
            return value == condition.value
        raise AssertionError(f"fake query does not support {condition.op_string}")


class FakeCollection:
    def __init__(self, db, name):
        self._db = db
        self.name = name

    def document(self, doc_id):
        return FakeDocument(self._db, self.name, doc_id)

    def stream(self):
        return FakeQuery(self._db, self.name).stream()

    def where(self, filter=None, **kwargs):
        return FakeQuery(self._db, self.name).where(filter=filter, **kwargs)

    def order_by(self, field, direction=None):
        return FakeQuery(self._db, self.name).order_by(field, direction=direction)

    def limit(self, count):
        return FakeQuery(self._db, self.name).limit(count)


class FakeDB:
    """Minimal Firestore client: {collection: {doc_id: dict}} plus fault flags."""

    def __init__(self, data=None):
        self.data = data or {}
        self.writes = []
        self.fail_reads = False
        self.fail_writes = False
        self.fail_deletes = False
        # An exception to raise from every write instead of the generic
        # RuntimeError (tests simulating a specific Firestore failure).
        self.write_error = None

    def collection(self, name):
        return FakeCollection(self, name)


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self.text = text or (json.dumps(payload) if payload is not None else "")
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("not JSON")
        return self._payload

    def raise_for_status(self):
        if not 200 <= self.status_code < 300:
            raise requests.HTTPError(response=self)


class FakeSession:
    """Scripted requests.Session: records calls and pops one response each."""

    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.calls = []

    def _call(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if not self.responses:
            return FakeResponse()
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def get(self, url, **kwargs):
        return self._call("get", url, **kwargs)

    def post(self, url, **kwargs):
        return self._call("post", url, **kwargs)

    def delete(self, url, **kwargs):
        return self._call("delete", url, **kwargs)


class FakeMessage:
    """Just the paho message surface the source reads."""

    def __init__(self, topic, payload):
        self.topic = topic
        if isinstance(payload, bytes):
            self.payload = payload
        else:
            self.payload = str(payload).encode()


class FakeMqttPublishInfo:
    """paho's MQTTMessageInfo surface: the bridge only reads ``rc``."""

    def __init__(self, rc=0):
        self.rc = rc


class FakeMqttClient:
    """Stand-in for paho's Client: no broker, callbacks are called by hand.

    ``connect()``/``drop()`` simulate the network loop's connection callbacks;
    ``ack_subscribe()`` simulates a SUBACK and ``deliver()`` feeds one message
    as the broker would. ``publish()`` records the call and returns rc 0 unless
    ``publish_rc`` is set (which simulates a client that refuses the send).
    """

    def __init__(self, client_id=None):
        self.client_id = client_id
        self.connected = False
        self.subscriptions = []
        self.subscribe_mid = 0
        self.credentials = None
        self.reconnect_delay = None
        self.connect_args = None
        self.looping = False
        self.disconnected = False
        self.published = []
        self.publish_rc = 0
        self.on_publish = None
        self.on_connect = None
        self.on_disconnect = None
        self.on_subscribe = None
        self.on_message = None
        self.on_connect_fail = None

    def username_pw_set(self, username, password=None):
        self.credentials = (username, password)

    def reconnect_delay_set(self, min_delay=1, max_delay=120):
        self.reconnect_delay = (min_delay, max_delay)

    def connect_async(self, host, port, keepalive=60):
        self.connect_args = (host, port, keepalive)

    def loop_start(self):
        self.looping = True

    def loop_stop(self):
        self.looping = False

    def subscribe(self, topic, qos=0):
        self.subscriptions.append((topic, qos))
        self.subscribe_mid += 1
        return (0, self.subscribe_mid)

    def publish(self, topic, payload=None, qos=0, retain=False):
        self.published.append((topic, payload, qos))
        if self.on_publish is not None:
            self.on_publish(topic, payload)
        return FakeMqttPublishInfo(self.publish_rc)

    def is_connected(self):
        return self.connected

    def disconnect(self):
        self.disconnected = True
        self.connected = False

    # -- test helpers ------------------------------------------------------

    def connect(self, reason_code=0):
        self.connected = not getattr(reason_code, "is_failure", bool(reason_code))
        if self.on_connect is not None:
            self.on_connect(self, None, {}, reason_code, None)

    def drop(self, reason_code=0):
        self.connected = False
        if self.on_disconnect is not None:
            self.on_disconnect(self, None, None, reason_code, None)

    def fail_connect(self):
        self.connected = False
        if self.on_connect_fail is not None:
            self.on_connect_fail(self, None)

    def ack_subscribe(self, reason_codes, mid=1):
        """Grant/deny one SUBACK. Default mid 1 is the status subscription."""
        if self.on_subscribe is not None:
            self.on_subscribe(self, None, mid, reason_codes, None)

    def deliver(self, topic, payload):
        if self.on_message is not None:
            self.on_message(self, None, FakeMessage(topic, payload))


class FakeMqttFactory:
    """Client factory for MqttSource(client_factory=...)."""

    def __init__(self):
        self.clients = []

    def __call__(self, client_id):
        client = FakeMqttClient(client_id)
        self.clients.append(client)
        return client

    @property
    def client(self):
        return self.clients[-1]

