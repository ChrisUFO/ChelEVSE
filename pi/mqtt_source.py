"""MQTT status source for the ChelEVSE bridge (issue #44).

The OpenEVSE gateway publishes its status as individual topics under a base
topic (``<base>/amp``, ``<base>/state``, …) whenever the EVSE poll reports a
change. This module subscribes to them, coalesces a burst into one snapshot and
hands that snapshot to a callback; the bridge then runs it through the same
``parse_status``/``apply_status`` path as an HTTP poll, so this module never
writes a document itself.

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
  receiving worker runs ``parse_status`` on every snapshot, so the existing
  parser remains the one owner of every unit conversion and of the curated
  document shape — MQTT and HTTP cannot disagree about the document.
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


def _default_log(message):
    """Fallback journal line; the bridge injects its own ``log`` in production."""
    print(message, flush=True)


def _reason_value(reason_code):
    """Reason code as an int, whether paho handed over an int or a ReasonCode."""
    return getattr(reason_code, "value", reason_code)


def _is_failure(reason_code):
    """True when a CONNACK/SUBACK reason code reports a failure."""
    is_failure = getattr(reason_code, "is_failure", None)
    if isinstance(is_failure, bool):
        return is_failure
    value = _reason_value(reason_code)
    return value not in (0, None)


def _reason_text(reason_code):
    """Reason code as ``<name> (<value>)``, or ``rc <value>`` without a name."""
    value = _reason_value(reason_code)
    name = getattr(reason_code, "getName", None)
    label = name() if callable(name) else None
    return f"{label} ({value})" if label else f"rc {value}"


def _first_reason(args):
    """First reason code in a paho callback's variadic tail, or None.

    paho 2.x calls ``on_disconnect(client, userdata, flags, reason_code,
    properties)``; 1.x calls ``on_disconnect(client, userdata, rc)``.
    """
    for value in args:
        if isinstance(value, int) or hasattr(value, "value"):
            return value
    return None


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
        log=None,
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
        self.log = log or _default_log
        self.snapshot = {}
        self.config_version = None
        self.messages = 0
        self.snapshots = 0
        # True once the snapshot carries a /status seed: only then is a
        # snapshot a complete observation the state machine may run on.
        self.seeded = False
        self.subscribed = False
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
        client.on_subscribe = self._on_subscribe
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
        self.subscribed = False
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
        the seed. The seed is raw: the receiver parses every snapshot, so the
        snapshot needs the same raw units a ``/status`` reply carries.
        """
        if not isinstance(payload, dict):
            return
        with self._lock:
            self.snapshot.update(payload)
            self.seeded = True

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

    def _on_connect(self, client, _userdata, _flags, reason_code, _properties=None, *_):
        if _is_failure(reason_code):
            # A refused CONNACK (wrong password, unknown client, ACL) never
            # subscribes: without this line the bridge just serves HTTP.
            self.connect_failures += 1
            self.log(f"mqtt connect refused ({_reason_text(reason_code)})")
            return
        self.connects += 1
        # Re-subscribed on every (re)connect: the session is clean, so the
        # broker holds no subscription across a drop.
        result = client.subscribe(self.subscription, qos=0)
        if isinstance(result, tuple) and result and result[0] != 0:
            self.log(f"mqtt subscribe failed ({self.subscription}: rc {result[0]})")

    def _on_subscribe(self, _client, _userdata, _mid, reason_codes, *_):
        codes = (
            list(reason_codes)
            if isinstance(reason_codes, (list, tuple))
            else [reason_codes]
        )
        denied = [code for code in codes if _is_failure(code)]
        if denied:
            # An ACL/misconfigured topic looks exactly like an idle charger
            # otherwise: connected, no status, no config_version.
            self.subscribed = False
            detail = ", ".join(_reason_text(code) for code in denied)
            self.log(f"mqtt subscription denied ({self.subscription}: {detail})")
            return
        if not self.subscribed:
            self.log(f"mqtt subscribed ({self.subscription})")
        self.subscribed = True

    def _on_disconnect(self, _client, _userdata, *args):
        self.disconnects += 1
        self.subscribed = False
        reason = _first_reason(args)
        if reason is None or not _is_failure(reason):
            self.log("mqtt disconnected")
        else:
            self.log(f"mqtt disconnected ({_reason_text(reason)})")

    def _on_connect_fail(self, _client, _userdata):
        self.connect_failures += 1
        self.log(f"mqtt connect failed (broker {self.host}:{self.port} unreachable)")

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
