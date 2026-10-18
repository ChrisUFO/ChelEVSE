"""In-memory Firestore and HTTP fakes for the pi bridge unit tests.

Nothing here touches the charger, Firestore, or FCM; the fakes implement only
the small surface bridge.py and acl.py use.
"""

import json

import requests


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
        if self._db.fail_writes:
            raise RuntimeError("write failed")
        self._db.writes.append(("set", self.collection, self.id, data))
        store = self._db.data.setdefault(self.collection, {})
        if merge and self.id in store:
            store[self.id].update(data)
        else:
            store[self.id] = dict(data)

    def update(self, data):
        if self._db.fail_writes:
            raise RuntimeError("write failed")
        self._db.writes.append(("update", self.collection, self.id, data))
        store = self._db.data.setdefault(self.collection, {})
        if self.id not in store:
            raise KeyError(self.id)
        store[self.id].update(data)

    def delete(self):
        if self._db.fail_deletes:
            raise RuntimeError("delete failed")
        self._db.writes.append(("delete", self.collection, self.id, None))
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
        return self.responses.pop(0)

    def get(self, url, **kwargs):
        return self._call("get", url, **kwargs)

    def post(self, url, **kwargs):
        return self._call("post", url, **kwargs)

    def delete(self, url, **kwargs):
        return self._call("delete", url, **kwargs)
