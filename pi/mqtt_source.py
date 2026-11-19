"""MQTT status source for the ChelEVSE bridge (issue #44).

The OpenEVSE gateway publishes its status as individual topics under a base
topic (``<base>/amp``, ``<base>/state``, …) whenever the EVSE poll reports a
change. This module subscribes to them, coalesces a burst into one snapshot and
hands that snapshot to a callback; the bridge then runs it through the same
``parse_status``/``apply_status`` path as an HTTP poll, so this module never
writes a document itself. Each delivery is a ``Snapshot`` record: the raw fields
plus the arrival number and the seeded-at-flush flag the receiver needs to order
it against a reconcile.

Design notes:

- **Liveness is the client's connection state** (``client.is_connected()``), not
  message recency: an idle charger legitimately publishes nothing for minutes,
  and treating silence as failure would flap to HTTP for no reason. The bridge's
  periodic HTTP reconciliation covers staleness instead. A granted subscription
  is part of that liveness: a denied SUBACK leaves the connection up and
  delivers nothing, so the bridge only treats MQTT as its status source when
  ``connected`` and ``subscribed`` both hold.
- **Snapshots are merged into a seed.** A burst carries only the fields that
  changed, so a snapshot built from it alone would miss (and, merged into
  Firestore, null) everything else. ``seed()`` takes the last ``/status`` reply
  and each flush merges the changed fields into it.
- **Units stay raw.** Topic values are mapped to their ``/status`` key and handed
  over unchanged (``amp`` in milliamps); the receiving worker runs
  ``parse_status`` on every snapshot, so the existing
  parser remains the one owner of every unit conversion and of the curated
  document shape — MQTT and HTTP cannot disagree about the document.
- **Config is not read from MQTT.** ``<base>/config`` is retained, but the bridge
  keeps ``/config`` as the single redaction/coercion path: a change of
  ``config_version`` only triggers one HTTP sync.
- **Claim-family topics are evidence, not answers.** ``<base>/claim``,
  ``<base>/limit`` and ``<base>/boost`` are retained, but they carry no
  authoritative freshness: each delivery is decoded and handed to
  ``on_evidence`` (the claims holder), never applied as status and never
  allowed to answer "why isn't it charging?" -- that is
  ``GET /claims/target`` (#159). The retained ``<base>/schedule`` event list
  is not evidence either -- the schedule reason's rule id comes from the
  schedule loop's ``/schedule/plan`` window -- so it is ignored like any
  other unmapped retained document.
- **Announce/LWT is the gateway's own presence.** The firmware publishes a
  retained ``openevse/announce/<id>`` document (``{"state": "connected"}`` on
  connect, and the broker publishes ``{"state": "disconnected"}`` as its Last
  Will). The source subscribes to that filter and exposes the gateway's
  announced state (``announced``/``last_lwt_at``) beside its own link state, so
  the watchdog can tell "our broker link is fine but the gateway is gone" from
  "the broker link dropped". ``ready``/``mqtt_ready`` stay the link facts only;
  the bridge combines them with the announcement.
- **Commands are published, acknowledged by the firmware's own topics.** PR-2
  adds ``publish`` plus one waiter each for the retained ``<base>/override``
  document (pause/resume/set-current) and the next ``<base>/rapi/out`` (RAPI).
  The connection is only usable for commands when ``connected`` and
  ``subscribed`` both hold; the bridge decides that, not this module. The
  retained override document doubles as the only fresher-than-the-seed
  ``manual_override`` fact on the MQTT path: no status topic publishes the
  flag, so a document that changes it feeds the debounced snapshot and the
  label for ``state 254`` stays ``stopped`` for a user Stop (#159).

The client is injected (``client_factory``), so the unit tests need no broker.
"""

import json
import threading
import time
from collections import deque
from datetime import UTC, datetime
from typing import NamedTuple

import paho.mqtt.client as mqtt

# The firmware publishes one topic per field in a burst when the EVSE poll
# changes. Buffer a short window so one change becomes one Firestore write.
DEBOUNCE_SEC = 0.5
# Retained announce document carrying the gateway's own presence; the broker
# publishes ``disconnected`` there as the gateway's Last Will.
DEFAULT_ANNOUNCE_TOPIC = "openevse/announce/#"
ANNOUNCE_CONNECTED = "connected"
ANNOUNCE_DISCONNECTED = "disconnected"
ANNOUNCE_STATES = frozenset({ANNOUNCE_CONNECTED, ANNOUNCE_DISCONNECTED})
# MQTT 3.1.1 keepalive; well above the firmware's publish cadence.
KEEPALIVE_SEC = 60
# Reconnect backoff bounds (paho retries inside its network loop).
RECONNECT_MIN_SEC = 1
RECONNECT_MAX_SEC = 30

# Topic leaf -> /status key. Only the curated status fields are mapped; every
# other leaf arriving on the wildcard subscription — command/retained-JSON
# topics (override, config, rapi/…, */set) and the temp1-temp3 sensor readings
# alike — is never mapped into a snapshot. The temp topics are liveness only
# (``TEMP_TOPICS`` below): the health gate never reads them — its temperatures
# come from the /status parse on polls and reconciles (parse_status feeds
# LiveObservations), so mapping them would be ingest with no consumer (#159) —
# but a delivery still proves the charger is publishing, which the outage
# classifier reads off the arrival generation. The retained claim-family
# documents (claim/limit/boost) are below: they are not status fields either,
# but they feed the claims pipeline's evidence holder instead of being dropped
# (issue #159).
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
}

# The per-sensor temperature topics (#159): liveness only. No consumer reads a
# topic temperature — the health gate's readings come from the /status parse on
# polls and reconciles — so a delivery is never mapped into a snapshot. It
# still counts as the charger publishing: a temp-only burst arms the debounce
# and flushes with nothing merged, advancing the arrival generation exactly as
# a mapped-field flush does (see ``flush``), so the outage classifier keeps its
# base proof of life.
TEMP_TOPICS = frozenset({"temp1", "temp2", "temp3"})

CONFIG_VERSION_TOPIC = "config_version"
# Retained document the firmware rewrites on every override change. It is the
# acknowledgement for pause/resume/set-current: {"state": "null"} for auto,
# {"state": "disabled", "auto_release": …} for pause, and
# {"state": "active", "charge_current": N, "max_current": N, …} for a hold.
OVERRIDE_TOPIC = "override"
# Retained claim-family documents, supporting evidence for the claims
# pipeline (#159): the gateway's own claim state (``claim``), the charge
# limit (``limit``) and a running boost (``boost``). Decoded here, parsed
# defensively by the claims module via ``on_evidence``; never authoritative
# -- the reason comes from ``GET /claims/target`` -- and never a status
# field, so none feed the debounced snapshot. The retained ``schedule``
# event list is deliberately absent: nothing consumes it (the schedule
# reason's rule id arrives via the schedule loop's plan window instead).
CLAIM_EVIDENCE_TOPICS = frozenset({"claim", "limit", "boost"})
# RAPI replies arrive with no correlation id, so the bridge must serialise
# commands and match the next one itself.
RAPI_OUT_TOPIC = "rapi/out"
# QoS 1: the bridge waits for the firmware's own acknowledgement anyway, and a
# dropped command is worse than a duplicate publish.
COMMAND_QOS = 1
# How long a timed-out RAPI transaction keeps the RAPI lock after its timeout,
# so a reply arriving late for the abandoned command is retired before the next
# command is published. Without a correlation id this is the only way to keep
# one command's reply from settling another (a bounded residual risk remains for
# replies arriving after this window).
RAPI_QUARANTINE_SEC = 2.0
# Replies kept for matching. Only the first reply after the captured generation
# is returned; the recent ones are kept so an older reply can never be mistaken
# for a newer one.
RAPI_REPLY_MEMORY = 32


class MqttPublishError(RuntimeError):
    """The client did not accept a publish (nothing was delivered)."""


def _default_client_factory(client_id):
    """paho client for the installed major version (2.x callback API)."""
    if hasattr(mqtt, "CallbackAPIVersion"):
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    return mqtt.Client(client_id=client_id)


def _decode(payload):
    """Topic payload -> JSON value (number/bool/None), or the raw string.

    A payload nested past the interpreter's recursion limit raises
    ``RecursionError``, not ``ValueError`` -- and this runs on the paho
    network thread, where an escapee would end ``loop_start()``'s thread
    while ``connected`` still reads healthy, silently degrading the bridge
    to the HTTP reconcile. Both are the same "not decodable" fact, so both
    take the raw-string fallback.
    """
    if isinstance(payload, bytes):
        text = payload.decode("utf-8", "replace")
    else:
        text = str(payload)
    text = text.strip()
    try:
        return json.loads(text)
    except (ValueError, RecursionError):
        return text


def _default_log(message):
    """Fallback journal line; the bridge injects its own ``log`` in production."""
    print(message, flush=True)


def _override_manual_flag(override):
    """Retained override document -> the ``manual_override`` status fact.

    The firmware rewrites ``<base>/override`` on every override change, and its
    states map exactly onto the flag ``/status`` reports for the same change:
    ``disabled`` (a pause) and ``active`` (a held current) both carry
    ``manual_override`` 1 — the flag is 1 for *either* override — while
    ``"null"`` is the auto state, 0. Any other shape (not a document, no
    recognised ``state``) states no fact: None leaves whatever the ``/status``
    seed last said standing, so the label stays honest about what is knowable.

    This is the MQTT path's cure for the 254 ambiguity (#159): no topic
    publishes ``manual_override``, so without it a user Stop (state 254 with
    override 1) merges into a seed whose override fact predates the Stop and
    the snapshot labels ``sleeping`` until the next HTTP reconcile.
    """
    if not isinstance(override, dict):
        return None
    state = override.get("state")
    if state == "null":
        return 0
    if state in ("disabled", "active"):
        return 1
    return None


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


class Snapshot(NamedTuple):
    """One delivered snapshot plus the facts the receiver must not re-read.

    ``fields`` is the raw merged payload, ``arrival`` is the source's snapshot
    counter for this delivery and ``complete`` says whether a ``/status`` seed
    was in place when it was flushed. The apply worker runs after the source has
    moved on -- a seed may have landed, a reconcile may have applied -- so both
    facts are frozen with the payload: a pre-seed partial must not be promoted
    to a complete observation later, and its arrival orders it against a
    reconcile that already applied newer data.
    """

    fields: dict
    arrival: int
    complete: bool


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
        on_evidence=None,
        announce_topic=DEFAULT_ANNOUNCE_TOPIC,
        debounce=DEBOUNCE_SEC,
        client_factory=None,
        log=None,
    ):
        self.host = host
        self.port = int(port)
        self.base = (topic or "").strip("/")
        self.announce_topic = (announce_topic or "").strip()
        self.user = user or None
        self.password = password or None
        self.client_id = client_id or "chelevse-bridge"
        self.on_status = on_status
        self.on_config_version = on_config_version
        self.on_evidence = on_evidence
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
        self.announce_subscribed = False
        # The gateway's announced presence (None until an announce arrives) and
        # when the Last Will last fired.
        self.announce_state = None
        self.announce_messages = 0
        self.last_lwt_at = None
        self.connects = 0
        self.disconnects = 0
        self.connect_failures = 0
        self.publishes = 0
        # Command acknowledgement state (PR-2): the retained override document,
        # and the ordered (generation, payload) rapi/out replies. The count is
        # the generation captured before a publish.
        self.override = None
        self.override_updates = 0
        self.rapi_messages = 0
        self._rapi_replies = deque(maxlen=RAPI_REPLY_MEMORY)
        self._command_cv = threading.Condition()
        self._rapi_lock = threading.Lock()
        self._client_factory = client_factory or _default_client_factory
        self._client = None
        self._pending = {}
        self._liveness_only = False
        self._pending_subscriptions = {}
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
        self.announce_subscribed = False
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

    @property
    def ready(self):
        """Usable as a command transport: connected **and** subscribed.

        A denied SUBACK leaves the link up but delivers nothing, so publishing
        there would never be acknowledged. The bridge only falls back to HTTP
        when this is false *before* a publish.
        """
        return self.connected and self.subscribed

    @property
    def mqtt_ready(self):
        """The same link facts as ``ready``, named for the watchdog/health input.

        It deliberately says nothing about the gateway's own announcement: the
        bridge combines it with ``announced`` so a Last Will still counts as an
        unavailable gateway while our broker link stays up.
        """
        return self.ready

    @property
    def announced(self):
        """Gateway presence from the announce topic: True/False, None unknown.

        ``False`` means the broker published the gateway's Last Will and it has
        not re-announced since. Unknown is neither: the watchdog must not invent
        a gateway outage from a message it has not seen.
        """
        if self.announce_state is None:
            return None
        return self.announce_state == ANNOUNCE_CONNECTED

    # -- commands (PR-2) ---------------------------------------------------

    def publish(self, topic, payload, qos=COMMAND_QOS):
        """Publish under the base topic; raise when the client rejects it.

        ``topic`` is relative to ``self.base`` (``override/set``,
        ``rapi/in/$FS``). A rejected publish means the client never queued the
        message, so the caller may still use its HTTP fallback; a publish with
        rc 0 may or may not reach the broker and must never be re-applied.
        """
        client = self._client
        if client is None:
            raise MqttPublishError("mqtt client not started")
        full_topic = f"{self.base}/{topic}" if self.base else topic
        try:
            info = client.publish(full_topic, payload, qos=qos)
        except Exception as exc:  # paho raises when the loop is gone
            raise MqttPublishError(
                f"publish {full_topic} failed ({exc.__class__.__name__}: {exc})"
            ) from exc
        rc = getattr(info, "rc", 0)
        if rc != 0:
            raise MqttPublishError(f"publish {full_topic} rejected (rc {rc})")
        with self._lock:
            self.publishes += 1
        return info

    def command_view(self):
        """Raw status snapshot plus the retained override document."""
        with self._lock:
            override = dict(self.override) if isinstance(self.override, dict) else None
            return {"status": dict(self.snapshot), "override": override}

    def wait_for_state(self, predicate, timeout):
        """Wait until ``predicate(command_view())`` holds, or the window closes.

        Woken by every status flush, override update and rapi/out reply. The
        view is re-read under the condition: a callback that lands between the
        check and the wait still wakes this thread, and one that landed before
        it is seen by the first check (an already-satisfied state confirms at
        once, which is the idempotent no-op case).
        """
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._command_cv:
            while True:
                if predicate(self.command_view()):
                    return True
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._command_cv.wait(remaining)

    def rapi_generation(self):
        """rapi/out replies received so far (capture before publishing)."""
        with self._lock:
            return self.rapi_messages

    def wait_for_rapi(self, expected, timeout):
        """First rapi/out payload *after* ``expected``, or None on timeout.

        The first reply is the one this command's publish can have caused;
        returning the newest would silently discard one of two replies that
        landed inside the window.
        """
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._command_cv:
            while True:
                with self._lock:
                    for generation, payload in self._rapi_replies:
                        if generation > expected:
                            return payload
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._command_cv.wait(remaining)

    def _retire_late_replies(self):
        """Hold the RAPI lock briefly so a timed-out command's reply is retired.

        ``rapi/out`` carries no correlation id. After a timeout, the abandoned
        publish may still be answered; publishing the next command right away
        would let that reply settle it (a false ack, or a failure for a command
        that applied). Publishing nothing for ``RAPI_QUARANTINE_SEC`` means a
        late reply lands *before* the next transaction captures its generation,
        so it can never be returned. A reply that arrives later still cannot be
        excluded without a correlation id — the residual risk is documented.
        """
        deadline = time.monotonic() + RAPI_QUARANTINE_SEC
        with self._command_cv:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self._command_cv.wait(remaining)

    def rapi_transaction(self, topic, payload, timeout):
        """Publish one RAPI command and wait for its reply, serialised.

        The firmware answers ``rapi/out`` with no correlation id, so two
        overlapping commands cannot be matched. The lock covers the publish,
        the wait *and* the late-reply quarantine after a timeout, so the next
        command starts from a generation no earlier reply can cross.
        """
        with self._rapi_lock:
            expected = self.rapi_generation()
            self.publish(topic, payload, qos=COMMAND_QOS)
            reply = self.wait_for_rapi(expected, timeout)
            if reply is None:
                if RAPI_QUARANTINE_SEC > 0:
                    self.log(
                        f"rapi: no reply within {float(timeout):g}s; "
                        f"retiring a late reply for {RAPI_QUARANTINE_SEC:g}s"
                    )
                self._retire_late_replies()
            return reply

    def _notify_command_waiters(self):
        with self._command_cv:
            self._command_cv.notify_all()

    # -- seeding and flushing ---------------------------------------------

    def arrival_generation(self):
        """Snapshots delivered so far (``flush`` advances it before delivery).

        An HTTP reconcile takes this before its GET: a value that moved means
        newer MQTT data exists, even when the apply worker has not run yet.
        """
        with self._lock:
            return self.snapshots

    def seed(self, payload):
        """Merge a ``/status`` reply into the snapshot (HTTP-only fields too).

        Fields the firmware does not publish over MQTT (``comm_sent``,
        ``comm_success``, ``rapi_connected``, …) stay in the snapshot, so a
        later MQTT flush cannot null them. The 60 s HTTP reconciliation refreshes
        the seed. The seed is raw: the receiver parses every snapshot, so the
        snapshot needs the same raw units a ``/status`` reply carries.

        The status loop uses ``seed_if_current`` instead: on its own this merge
        is not ordered against the snapshots that arrived while the reply was in
        flight.
        """
        if not isinstance(payload, dict):
            return
        with self._lock:
            self.snapshot.update(payload)
            self.seeded = True

    def seed_if_current(self, expected_generation, payload):
        """Seed only if no snapshot arrived since ``expected_generation``.

        The comparison, the merge and the ``seeded`` flag are one critical
        section. Checking the arrival generation and then calling ``seed`` would
        leave a gap: a flush landing between them still sees the generation it
        expects, so the older reply would overwrite the newer snapshot and a
        later partial flush would republish its fields. Returns True when the
        payload was merged.
        """
        if not isinstance(payload, dict):
            return False
        with self._lock:
            if self.snapshots != expected_generation:
                return False
            self.snapshot.update(payload)
            self.seeded = True
            return True

    def flush(self):
        """Deliver the buffered fields as one snapshot (timer target).

        The delivered record carries this delivery's arrival number and whether
        the snapshot was seeded yet, both read under the same lock as the merge:
        the worker may consume it long after a seed or a newer flush.

        A temp-only burst flushes too, with nothing to merge: that delivery is
        pure liveness — transport facts and the accumulated view, no temp key —
        and the arrival generation advances exactly as a mapped-field flush
        does, so the outage classifier still sees the charger publishing.
        """
        with self._lock:
            pending, self._pending = self._pending, {}
            liveness, self._liveness_only = self._liveness_only, False
            self._timer = None
            if not pending and not liveness:
                return
            self.snapshot.update(pending)
            self.snapshots += 1
            record = Snapshot(dict(self.snapshot), self.snapshots, self.seeded)
        if self.on_status is not None:
            self.on_status(record)
        # A new status snapshot can satisfy an override confirmation.
        self._notify_command_waiters()

    def _arm_debounce(self):
        """Schedule the debounced flush once (the caller holds the lock)."""
        if self._timer is None:
            timer = threading.Timer(self.debounce, self.flush)
            timer.daemon = True
            self._timer = timer
            timer.start()

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
        self._subscribe(client, self.subscription, "status")
        if self.announce_topic:
            self._subscribe(client, self.announce_topic, "announce")

    def _subscribe(self, client, topic_filter, kind):
        """Subscribe one filter and remember which SUBACK belongs to it."""
        result = client.subscribe(topic_filter, qos=0)
        if not isinstance(result, tuple) or not result:
            return
        rc = result[0]
        if rc != 0:
            self.log(f"mqtt subscribe failed ({topic_filter}: rc {rc})")
            return
        if len(result) > 1 and result[1] is not None:
            self._pending_subscriptions[result[1]] = kind

    def _on_subscribe(self, _client, _userdata, mid, reason_codes, *_):
        kind = self._pending_subscriptions.pop(mid, "status")
        codes = (
            list(reason_codes)
            if isinstance(reason_codes, (list, tuple))
            else [reason_codes]
        )
        denied = [code for code in codes if _is_failure(code)]
        if kind == "announce":
            # A denied announce grant only costs the LWT input; the status
            # source must keep working.
            if denied:
                self.announce_subscribed = False
                detail = ", ".join(_reason_text(code) for code in denied)
                self.log(
                    f"mqtt announce subscription denied "
                    f"({self.announce_topic}: {detail})"
                )
                return
            if not self.announce_subscribed:
                self.log(f"mqtt announce subscribed ({self.announce_topic})")
            self.announce_subscribed = True
            return
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
        self.announce_subscribed = False
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
        if self._is_announce(topic):
            self._announce(_decode(getattr(message, "payload", b"")))
            return
        prefix = f"{self.base}/" if self.base else ""
        if not topic.startswith(prefix):
            return
        leaf = topic[len(prefix) :]
        if leaf == CONFIG_VERSION_TOPIC:
            self._config_version(_decode(getattr(message, "payload", b"")))
            return
        if leaf == OVERRIDE_TOPIC:
            self._override(_decode(getattr(message, "payload", b"")))
            return
        if leaf == RAPI_OUT_TOPIC:
            self._rapi_out(_decode(getattr(message, "payload", b"")))
            return
        if leaf in CLAIM_EVIDENCE_TOPICS:
            # Supporting evidence for the claims pipeline (#159): decoded
            # here on the network thread, parsed and held by the callback.
            # An escapee here would end loop_start()'s thread while
            # ``connected`` still reads healthy (the decode's own docstring),
            # and a retained payload redelivers the kill on every reconnect,
            # so the dispatch is guarded whatever a future parser raises.
            if self.on_evidence is not None:
                try:
                    self.on_evidence(leaf, _decode(getattr(message, "payload", b"")))
                except Exception as exc:
                    self.log(
                        f"mqtt evidence callback failed "
                        f"({exc.__class__.__name__}: {exc})"
                    )
            return
        field = TOPIC_FIELDS.get(leaf)
        temp = field is None and leaf in TEMP_TOPICS
        if field is None and not temp:
            return  # retained JSON, commands, rapi/in, deprecated topics
        self.messages += 1
        value = None if temp else _decode(getattr(message, "payload", b""))
        with self._lock:
            if temp:
                # Liveness only (#159): the delivery proves the charger is
                # publishing but its value is never ingested — no consumer
                # reads a topic temperature. The burst still arms the debounce
                # and flushes (see ``flush``).
                self._liveness_only = True
            else:
                self._pending[field] = value
            self._arm_debounce()

    def _is_announce(self, topic):
        """True for a topic the announce filter covers.

        The filter is matched client-side only to classify a delivery: a
        ``<prefix>/#`` filter (the default) matches everything below it, any
        other filter is matched exactly. paho already delivers only matching
        topics, so this never has to reject a real announce.
        """
        if not self.announce_topic:
            return False
        if self.announce_topic.endswith("/#"):
            return topic.startswith(self.announce_topic[:-1])
        return topic == self.announce_topic

    def _announce(self, value):
        """The gateway's announced presence; ``state`` is the field that counts."""
        state = value.get("state") if isinstance(value, dict) else value
        if not isinstance(state, str):
            return
        state = state.strip().lower()
        if state not in ANNOUNCE_STATES:
            return
        previous, self.announce_state = self.announce_state, state
        self.announce_messages += 1
        if state != previous:
            # Stamp only on the transition into disconnected: the will is
            # retained, so every re-subscribe redelivers it, and a redelivery
            # must not move the time the Last Will actually fired.
            if state == ANNOUNCE_DISCONNECTED:
                self.last_lwt_at = datetime.now(UTC)
            self.log(f"mqtt gateway announced {state}")

    def _override(self, value):
        """Retained override document -> confirmation state for override commands.

        ``<base>/override/set`` echoes the command and is ignored: only the
        retained ``<base>/override`` document is the firmware's state.

        A document that *changes* the ``manual_override`` fact also feeds the
        debounced snapshot: no status topic publishes the flag, so this
        document is the only fresher-than-the-seed source on the MQTT path,
        and without it a user Stop (state 254) would label ``sleeping`` until
        the next HTTP reconcile (#159). Only a change queues a delivery — a
        retained redelivery that restates the known fact must not advance the
        arrival generation, which the outage classifier reads as the charger
        publishing (a retained copy is broker-held, not fresh publishing).
        """
        with self._lock:
            self.override = value if isinstance(value, dict) else None
            self.override_updates += 1
            flag = _override_manual_flag(self.override)
            known = self._pending.get(
                "manual_override", self.snapshot.get("manual_override")
            )
            if flag is not None and flag != known:
                self._pending["manual_override"] = flag
                self._arm_debounce()
        self._notify_command_waiters()

    def _rapi_out(self, value):
        """One RAPI reply; there is no correlation id, so the count orders it."""
        with self._lock:
            self.rapi_messages += 1
            self._rapi_replies.append((self.rapi_messages, value))
        self._notify_command_waiters()

    def _config_version(self, value):
        """One config sync per version change (the first value counts too)."""
        if value == self.config_version:
            return
        self.config_version = value
        if self.on_config_version is not None:
            # Same exposure as the evidence dispatch in ``_on_message``:
            # this runs on the paho network thread, an escapee would end
            # loop_start()'s thread while ``connected`` still reads
            # healthy, and the retained ``config_version`` redelivers the
            # kill on every reconnect.
            try:
                self.on_config_version(value)
            except Exception as exc:
                self.log(
                    f"mqtt config-version callback failed "
                    f"({exc.__class__.__name__}: {exc})"
                )
