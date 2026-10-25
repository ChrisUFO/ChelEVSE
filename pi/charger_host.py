"""The charger's address and shared HTTP session (issue #54).

Extracted from ``bridge.py`` (behavior-preserving move): the host grammar and
the runtime-swappable ``ChargerHost``, the startup seed that picks the address
(app settings over the env bootstrap), and the one pooled keep-alive session
every charger request runs on. ``HTTP_TIMEOUT`` lives here with the session:
it is the per-request bound every charger-HTTP caller shares.
"""

import re
import threading

import requests


def log(message):
    # seam: tests patch bridge.log (PLAN.md facade rule)
    import bridge  # lazy, call-time only
    return bridge.log(message)



HTTP_TIMEOUT = 5  # seconds, per charger request
# --- Charger address (issue #54) -------------------------------------------
# The charger's address is app-managed once the bridge runs:
# ``settings/current.charger_host`` wins over ``CHARGER_HOST``, and
# ``settings_loop`` applies a change without a restart. The grammar below is
# shared with ``web/js/settings.js`` and ``firestore.rules``; the bridge
# re-validates fully because it must survive a value written from the console.
DEFAULT_CHARGER_HOST = "192.168.0.145"
CHARGER_HOST_MAX_LEN = 253
CHARGER_HOST_LABEL_MAX_LEN = 63
_CHARGER_HOST_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?")
_CHARGER_HOST_LABEL_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?")


def _normalize_charger_host(raw):
    """The charger-host grammar: the host as typed, or None when invalid.

    Trimmed first; empty after trim means unset (None). 1..253 characters of
    ``[A-Za-z0-9.-]`` with an alphanumeric first and last character, so a
    scheme, port, path, userinfo, inner whitespace and a leading or trailing
    dot/hyphen are all rejected by construction. Every dot-separated label is
    1..63 characters with no leading or trailing hyphen. A four-label
    all-numeric value is an IPv4 literal, so each octet must be 0..255. Case is
    preserved as typed. No logging here: the caller decides what a rejection
    means for the journal.
    """
    if not isinstance(raw, str):
        return None
    host = raw.strip()
    if not 1 <= len(host) <= CHARGER_HOST_MAX_LEN:
        return None
    if _CHARGER_HOST_RE.fullmatch(host) is None:
        return None
    labels = host.split(".")
    if any(
        not 1 <= len(label) <= CHARGER_HOST_LABEL_MAX_LEN
        or _CHARGER_HOST_LABEL_RE.fullmatch(label) is None
        for label in labels
    ):
        return None
    if len(labels) == 4 and all(label.isdigit() for label in labels):
        if any(int(label) > 255 for label in labels):
            return None
    return host


class ChargerHost:
    """The charger's current address, swapped at runtime (issue #54).

    One lock and nothing else. Every consumer reads ``base`` per request
    instead of capturing the string, so a saved app setting applies to the next
    request with no restart and no stale copy anywhere in the process. The
    shared ``ChargerTransport`` needs no changes: ``requests`` pools per host,
    so a swap simply opens a new socket.
    """

    def __init__(self, host):
        normalized = _normalize_charger_host(host)
        if normalized is None:
            raise ValueError(f"invalid charger host {host!r}")
        self._lock = threading.Lock()
        self._host = normalized

    @property
    def host(self):
        """The bare host the bridge was told to use."""
        with self._lock:
            return self._host

    @property
    def base(self):
        """``http://<host>``: the base every charger URL is built from."""
        with self._lock:
            return f"http://{self._host}"

    def set(self, host):
        """Adopt ``host``; True only when it really changed the address.

        ``None`` (or anything the grammar rejects) sets nothing, so a malformed
        value can never replace a working address.
        """
        normalized = _normalize_charger_host(host)
        if normalized is None:
            return False
        with self._lock:
            if normalized == self._host:
                return False
            self._host = normalized
            return True


def _bootstrap_host(bootstrap):
    """The env bootstrap as a valid host, else the built-in default (logged)."""
    host = _normalize_charger_host(bootstrap)
    if host is None:
        log(f"charger host rejected: {bootstrap} (using {DEFAULT_CHARGER_HOST})")
        return DEFAULT_CHARGER_HOST
    return host


def _read_charger_host(db):
    """The stored ``settings/current.charger_host``, or None when unset.

    Raises on a Firestore read failure; the caller decides how to keep going.
    """
    snapshot = db.collection("settings").document("current").get()
    data = snapshot.to_dict() if snapshot.exists else None
    return data.get("charger_host") if isinstance(data, dict) else None


def seed_host(db, bootstrap):
    """The charger host the bridge starts with; logs the choice and its source.

    A valid ``settings/current.charger_host`` wins over the env bootstrap, so an
    address saved in the app survives a service restart. A malformed stored
    value is logged and ignored, and a read failure falls back to the bootstrap:
    a fresh Pi with no settings document must still start.
    """
    host = _bootstrap_host(bootstrap)
    try:
        raw = _read_charger_host(db)
    except Exception as exc:
        log(
            f"charger host: settings read failed "
            f"({exc.__class__.__name__}: {exc}); using {host}"
        )
        log(f"charger host: http://{host} (environment)")
        return host
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        log(f"charger host: http://{host} (environment)")
        return host
    stored = _normalize_charger_host(raw)
    if stored is None:
        log(f"charger host rejected: {raw} (using {host})")
        log(f"charger host: http://{host} (environment)")
        return host
    log(f"charger host: http://{stored} (app settings)")
    return stored


def make_charger_session():
    """One keep-alive session for the charger, capped at two pooled sockets."""
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=1, pool_maxsize=2, max_retries=0
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session

