"""MQTT status source for the ChelEVSE bridge (issue #44).

The OpenEVSE gateway publishes its status as individual topics under a base
topic (``<base>/amp``, ``<base>/state``, …) whenever the EVSE poll reports a
change. This module subscribes to them, coalesces a burst into one snapshot and
hands that snapshot to a callback; the bridge then runs it through the same
``parse_status``/``apply_status`` path as an HTTP poll.

Design notes:

- **Liveness is the client's connection state** (``client.is_connected()``), not
  message recency: an idle charger legitimately publishes nothing for minutes,
  and treating silence as failure would flap to HTTP for no reason. The bridge's
  periodic HTTP reconciliation covers staleness instead.
- **Snapshots are merged into a seed.** A burst carries only the fields that
  changed, so a snapshot built from it alone would miss (and, merged into
  Firestore, null) everything else. ``seed()`` takes the last ``/status`` reply
  and each flush merges the changed fields into it.
- **Units stay raw.** Topic values are mapped to their ``/status`` key and handed
  over unchanged (``amp`` in milliamps, temperatures in 10ths of °C); the
  existing ``parse_status`` owns every unit conversion, so MQTT and HTTP cannot
  disagree about the document shape.
- **Config is not read from MQTT.** ``<base>/config`` is retained, but the bridge
  keeps ``/config`` as the single redaction/coercion path: a change of
  ``config_version`` only triggers one HTTP sync.
- **Announce/LWT is not consumed here.** PR-3 adds the announce subscription;
  this module only exposes the broker connection state.

The client is injected (``client_factory``), so the unit tests need no broker.
"""

import json
import threading

import paho.mqtt.client as mqtt

# The firmware publishes one topic per field in a burst when the EVSE poll
# changes. Buffer a short window so one change becomes one Firestore write.
DEBOUNCE_SEC = 0.5
# MQTT 3.1.1 keepalive; well above the firmware's publish cadence.
KEEPALIVE_SEC = 60
# Reconnect backoff bounds (paho retries inside its network loop).
RECONNECT_MIN_SEC = 1
RECONNECT_MAX_SEC = 30

# Topic leaf -> /status key. Only the curated status fields the bridge stores
# are mapped; command/retained-JSON topics (override, claim, schedule, config,
# rapi/…, */set) are ignored by construction because they are not listed here.
TOPIC_FIELDS = {
    "amp": "amp",
    "voltage": "voltage",
    "power": "power",
    "pilot": "pilot",
    "state": "state",
    "vehicle": "vehicle",
    "session_energy": "session_energy",
    "session_elapsed": "elapsed",
    "total_energy": "total_energy",
    "temp1": "temp1",
    "temp2": "temp2",
    "temp3": "temp3",
}

CONFIG_VERSION_TOPIC = "config_version"


def _default_client_factory(client_id):
    """paho client for the installed major version (2.x callback API)."""
    if hasattr(mqtt, "CallbackAPIVersion"):
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    return mqtt.Client(client_id=client_id)


def _decode(payload):
    """Topic payload -> JSON value (number/bool/None), or the raw string."""
    if isinstance(payload, bytes):
        text = payload.decode("utf-8", "replace")
    else:
        text = str(payload)
    text = text.strip()
    try:
        return json.loads(text)
    except ValueError:
        return text


class MqttSource:
    """Subscriber for the charger's MQTT status topics.

    Callbacks run on the paho network thread (``on_config_version``) or on a
    short-lived debounce timer (``on_status``); both must be quick and must not
    block. The bridge enqueues the snapshot and applies it on its own worker.
    """

    def __init__(
        self,
        host,
        port=1883,
        topic="chelevse",
        user=None,
        password=None,
        client_id=None,
        on_status=None,
        on_config_version=None,
        debounce=DEBOUNCE_SEC,
        client_factory=None,
    ):
        self.host = host
        self.port = int(port)
        self.base = (topic or "").strip("/")
        self.user = user or None
        self.password = password or None
        self.client_id = client_id or "chelevse-bridge"
        self.on_status = on_status
        self.on_config_version = on_config_version
        self.debounce = max(0.0, float(debounce))
        self.subscription = f"{self.base}/#" if self.base else "#"
        self.snapshot = {}
        self.config_version = None
        self.messages = 0
        self.snapshots = 0
        self.connects = 0
        self.disconnects = 0
        self.connect_failures = 0
        self._client_factory = client_factory or _default_client_factory
        self._client = None
        self._pending = {}
        self._timer = None
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        """Create the client and connect asynchronously (never blocks)."""
        client = self._client_factory(self.client_id)
        self._client = client
        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        client.on_connect_fail = self._on_connect_fail
        if self.user:
            client.username_pw_set(self.user, self.password)
        client.reconnect_delay_set(RECONNECT_MIN_SEC, RECONNECT_MAX_SEC)
        client.connect_async(self.host, self.port, keepalive=KEEPALIVE_SEC)
        client.loop_start()
        return self

    def stop(self):
        """Stop the network loop and drop the connection."""
        with self._lock:
            timer, self._timer = self._timer, None
        if timer is not None:
            timer.cancel()
        client, self._client = self._client, None
        if client is None:
            return
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:  # never let teardown mask a shutdown
            pass

    @property
    def connected(self):
        """Broker connection state (paho's own view; never message recency)."""
        client = self._client
        return bool(client is not None and client.is_connected())

    # -- seeding and flushing ---------------------------------------------

    def seed(self, payload):
        """Merge a ``/status`` reply into the snapshot (HTTP-only fields too).

        Fields the firmware does not publish over MQTT (``comm_sent``,
        ``comm_success``, ``rapi_connected``, …) stay in the snapshot, so a
        later MQTT flush cannot null them. The 60 s HTTP reconciliation refreshes
        the seed.
        """
        if not isinstance(payload, dict):
            return
        with self._lock:
            self.snapshot.update(payload)

    def flush(self):
        """Deliver the buffered fields as one snapshot (timer target)."""
        with self._lock:
            pending, self._pending = self._pending, {}
            self._timer = None
            if not pending:
                return
            self.snapshot.update(pending)
            snapshot = dict(self.snapshot)
            self.snapshots += 1
        if self.on_status is not None:
            self.on_status(snapshot)

    # -- paho callbacks ----------------------------------------------------

    def _on_connect(self, client, _userdata, _flags, _reason_code, _properties=None, *_):
        self.connects += 1
        # Re-subscribed on every (re)connect: the session is clean, so the
        # broker holds no subscription across a drop.
        client.subscribe(self.subscription, qos=0)

    def _on_disconnect(self, _client, _userdata, *args):
        self.disconnects += 1

    def _on_connect_fail(self, _client, _userdata):
        self.connect_failures += 1

    def _on_message(self, _client, _userdata, message):
        topic = getattr(message, "topic", "") or ""
        prefix = f"{self.base}/" if self.base else ""
        if not topic.startswith(prefix):
            return
        leaf = topic[len(prefix) :]
        if leaf == CONFIG_VERSION_TOPIC:
            self._config_version(_decode(getattr(message, "payload", b"")))
            return
        field = TOPIC_FIELDS.get(leaf)
        if field is None:  # retained JSON, commands, rapi/out, deprecated topics
            return
        self.messages += 1
        value = _decode(getattr(message, "payload", b""))
        with self._lock:
            self._pending[field] = value
            if self._timer is None:
                timer = threading.Timer(self.debounce, self.flush)
                timer.daemon = True
                self._timer = timer
                timer.start()

    def _config_version(self, value):
        """One config sync per version change (the first value counts too)."""
        if value == self.config_version:
            return
        self.config_version = value
        if self.on_config_version is not None:
            self.on_config_version(value)
