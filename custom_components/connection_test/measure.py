"""Measurement maths and payload normalisation.

Pure functions: no Home Assistant imports, no I/O, no clock. Everything the
integration derives from a client's raw numbers happens here, so it can be
tested with nothing installed but pytest -- which is all CI has.

The client computes the same figures for its own live display (the card cannot
wait for a service round-trip to show a result). The JS copies live in
``frontend/connection-test-card.js`` and are pinned by ``tests/test_card.js``
against the same expectations as ``tests/test_measure.py``. **This module is
authoritative for what lands in entity state.**
"""

from __future__ import annotations

import ipaddress
import math
from collections.abc import Iterable, Mapping
from itertools import pairwise
from typing import Any

from .const import (
    CONNECTION_TYPES,
    DEFAULT_DOWNLOAD_BYTES,
    MAX_DEVICE_TEXT,
    MAX_DOWNLOAD_BYTES,
    MAX_TRACKED_CLIENTS,
    MIN_DOWNLOAD_BYTES,
    PATHS,
    PLATFORMS_CLIENT,
)

# Throughput is reported in MEGABITS PER SECOND, decimal (10^6 bits), because
# that is the unit every speed test, every ISP plan and Home Assistant's own
# UnitOfDataRate.MEGABITS_PER_SECOND use. Do not "correct" this to a binary
# mebibit to match the NOC's byte-throughput tiles -- those measure a different
# thing (bytes moved) and the two conventions genuinely differ by 4.9%.
BITS_PER_BYTE = 8
MEGABIT = 1_000_000

# Free text from the browser lands in a sensor attribute, which lands in the
# recorder. Bound it.
MAX_TEXT = 200


def _clean_text(value: Any, limit: int = MAX_TEXT) -> str:
    """Coerce to a bounded single-line string."""
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def _finite(value: Any) -> float | None:
    """Return value as a finite float, or None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def clamp_download_bytes(
    raw: Any,
    *,
    default: int = DEFAULT_DOWNLOAD_BYTES,
    minimum: int = MIN_DOWNLOAD_BYTES,
    maximum: int = MAX_DOWNLOAD_BYTES,
) -> int:
    """Resolve the ``?bytes=`` query parameter to a safe payload size.

    Anything unparseable falls back to the default rather than erroring: the
    client is asking for a *size hint*, and refusing the request would turn a
    typo into a failed test rather than a slightly differently sized one.
    """
    try:
        size = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if size <= 0:
        return default
    return max(minimum, min(size, maximum))


def mbits_per_second(byte_count: Any, seconds: Any) -> float | None:
    """Throughput in Mbit/s, or None when the inputs cannot support a figure."""
    size = _finite(byte_count)
    duration = _finite(seconds)
    if size is None or duration is None or size <= 0 or duration <= 0:
        return None
    return round(size * BITS_PER_BYTE / duration / MEGABIT, 2)


def percentile(values: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile of an unsorted list.

    Nearest-rank rather than interpolated because these are ~20 samples of a
    round trip: interpolating between two real measurements invents a latency
    that was never observed, and at this sample count the difference is noise
    with a false air of precision.
    """
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def summarise_latency(samples: Iterable[Any]) -> dict[str, Any]:
    """Reduce raw round-trip samples (ms) to the figures the card shows.

    ``jitter`` is the mean absolute difference between successive samples, in
    sample order -- the same shape as RFC 3550's interarrival jitter and a far
    better description of "does this feel laggy" than a standard deviation,
    which a single outlier dominates.
    """
    clean = [value for value in (_finite(sample) for sample in samples) if value is not None and value >= 0]
    if not clean:
        return {"count": 0, "min": None, "avg": None, "max": None, "p95": None, "jitter": None}

    if len(clean) >= 2:
        deltas = [abs(b - a) for a, b in pairwise(clean)]
        jitter = round(sum(deltas) / len(deltas), 2)
    else:
        jitter = None

    p95 = percentile(clean, 0.95)
    return {
        "count": len(clean),
        "min": round(min(clean), 2),
        "avg": round(sum(clean) / len(clean), 2),
        "max": round(max(clean), 2),
        "p95": None if p95 is None else round(p95, 2),
        "jitter": jitter,
    }


def _vocabulary(value: Any, allowed: frozenset[str], fallback: str) -> str:
    text = _clean_text(value, 32).lower()
    return text if text in allowed else fallback


# --------------------------------------------------------------- client address

# Headers a reverse proxy uses to name the client it is forwarding for, in the
# order they should be believed. `CF-Connecting-IP` is first because Cloudflare
# writes it itself and strips any inbound copy; `X-Real-IP` next because it is
# what nginx sets from `$remote_addr` *after* its own real_ip processing, so it
# already reflects any CF resolution the proxy did.
#
# `X-Forwarded-For` is deliberately last and only its FIRST element is read.
# There is no position in that header that is trustworthy in general: nginx's
# `$proxy_add_x_forwarded_for` appends the peer, so the last element is the
# nearest hop, while Cloudflare puts the real client first and nginx then
# appends Cloudflare. First-element is the conventional reading; the flag on the
# result says it was a guess.
_PROXY_IP_HEADERS = ("cf-connecting-ip", "x-real-ip", "true-client-ip")


def is_private_address(value: Any) -> bool | None:
    """Is this address on a local network? ``None`` when it is not an address.

    The predicate is ``not is_global``: could a packet from this address have
    been routed in off the internet? That is the question the internal/external
    label is really asking, and one attribute answers it for every case at once
    -- RFC1918, loopback, link-local, carrier-grade NAT space, and the
    documentation ranges.

    Reaching for ``is_private or is_loopback or is_link_local`` instead looks
    equivalent and is not: it misses ``100.64.0.0/10``, which is precisely the
    range a network large enough to need it would be using.

    ``ipaddress`` also resolves IPv4-mapped IPv6 (``::ffff:172.31.4.57``)
    correctly, which matters because that is what a dual-stack socket reports.

    The tri-state return is load-bearing: ``None`` means "no address to judge",
    which must not collapse into "judged, and it is public".
    """
    text = str(value).strip()
    # A scope id on a link-local address (fe80::1%eth0) is not part of it.
    text = text.split("%", 1)[0]
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return None
    return not address.is_global


def observed_client_ip(headers: Mapping[str, Any], peer: Any) -> tuple[str, str]:
    """Work out which address the client actually reached the server from.

    Returns ``(address, source)`` where source names the evidence used, because
    a diagnostic that cannot say where its number came from is not much of a
    diagnostic.

    Proxy headers are consulted ONLY when the peer is itself local -- loopback
    for a proxy on the same host, an RFC1918 address for one on the LAN or a
    container bridge. A request arriving straight off the internet has its own
    address believed and its headers ignored, so a remote client cannot dress
    itself up as local.

    A client on the LAN talking to Home Assistant directly still can, since its
    peer address is private. That is accepted: this value labels a card and
    feeds no access-control decision anywhere. **Do not reuse it for one.** The
    IP-ban allowlist in this house learned that lesson the expensive way.
    """
    peer_text = "" if peer is None else str(peer).strip()
    peer_private = is_private_address(peer_text)

    if peer_private:
        lowered = {str(key).lower(): value for key, value in headers.items()}
        for header in _PROXY_IP_HEADERS:
            candidate = str(lowered.get(header) or "").strip()
            if is_private_address(candidate) is not None:
                return candidate, header
        forwarded = str(lowered.get("x-forwarded-for") or "")
        first = forwarded.split(",")[0].strip()
        if is_private_address(first) is not None:
            return first, "x-forwarded-for"

    if peer_private is None:
        return "", "unknown"
    return peer_text, "peer"


def classify_connection(
    *,
    network_type: Any = None,
    remote_is_private: bool | None = None,
) -> str:
    """Fold "did it stay local" and "over what medium" into one word.

    ``network_type`` is whatever ``navigator.connection.type`` gave the browser
    and is frequently absent; ``remote_is_private`` is the server's own
    observation and is not. The scope half therefore survives on its own, which
    is the half worth having: "you are at home but this went out to the
    internet and back" is the answer to most questions this card gets asked.

    ``effectiveType`` (``4g``/``3g``/...) is deliberately NOT consulted. It
    describes how fast a link behaves, not what it is -- a slow Wi-Fi network
    reports ``3g`` -- so using it to guess "cellular" would invent the one fact
    the user most wants to be able to trust.
    """
    medium = _clean_text(network_type, 16).lower()
    if medium in {"none", "unknown", "other", "mixed"}:
        medium = ""

    # A cellular link never stays on the LAN, whatever an address suggests.
    if medium == "cellular":
        return "cellular"

    if remote_is_private is True:
        if medium == "wifi":
            return "local_wifi"
        if medium in {"ethernet", "wimax"}:
            return "local_wired"
        return "local"

    if remote_is_private is False:
        if medium == "wifi":
            return "wifi"
        if medium in {"ethernet", "wimax"}:
            return "ethernet"
        return "remote"

    if medium == "wifi":
        return "wifi"
    if medium in {"ethernet", "wimax"}:
        return "ethernet"
    return "unknown"


def _device(payload: Mapping[str, Any]) -> dict[str, Any]:
    """The device description a client reported about itself."""
    return {
        "model": _clean_text(payload.get("device_model"), MAX_DEVICE_TEXT),
        "os": _clean_text(payload.get("device_os"), MAX_DEVICE_TEXT),
        "browser": _clean_text(payload.get("device_browser"), MAX_DEVICE_TEXT),
        "form_factor": _clean_text(payload.get("device_form_factor"), 16).lower(),
        "screen": _clean_text(payload.get("device_screen"), 24),
    }


def _network(payload: Mapping[str, Any], connection: str) -> dict[str, Any]:
    """The raw network evidence behind the ``connection`` verdict.

    Kept alongside the verdict rather than thrown away: when the verdict reads
    ``remote`` and you expected ``local_wifi``, these are the fields that say
    which half of the reasoning to distrust.
    """
    return {
        "type": connection,
        # Exactly what navigator.connection reported, empty when the browser
        # does not implement it -- which is most of them.
        "reported_type": _clean_text(payload.get("network_type"), 16).lower(),
        "effective_type": _clean_text(payload.get("effective_type"), 16).lower(),
        "downlink_mbps": _finite(payload.get("downlink_mbps")),
        "rtt_ms": _finite(payload.get("network_rtt_ms")),
        "save_data": bool(payload.get("save_data")),
        # As observed by the server; see observed_client_ip().
        "client_ip": _clean_text(payload.get("client_ip"), 64),
        "client_ip_source": _clean_text(payload.get("client_ip_source"), 24),
        "via_cloudflare": bool(payload.get("via_cloudflare")),
    }


def normalise_report(payload: Mapping[str, Any], *, timestamp: str) -> dict[str, Any]:
    """Turn one ``connection_test.report`` service call into a stored entry.

    The service schema has already checked types; this decides meaning --
    which fields are authoritative, what a missing phase looks like, and how
    much free text is allowed through to the recorder.
    """
    latency = summarise_latency(payload.get("latency_samples_ms") or [])

    download_bytes = _finite(payload.get("download_bytes")) or 0
    download_seconds = _finite(payload.get("download_seconds")) or 0
    upload_bytes = _finite(payload.get("upload_bytes")) or 0
    upload_seconds = _finite(payload.get("upload_seconds")) or 0

    # The client reports the address the server told it about (via /info), so
    # the scope verdict below rests on the server's own observation rather than
    # on the hostname the client happens to be using. That distinction is the
    # whole point: a phone sitting on the house Wi-Fi but loading the external
    # URL is genuinely on an external path, and only the address can say so.
    client_ip = _clean_text(payload.get("client_ip"), 64)
    remote_is_private = is_private_address(client_ip)

    if remote_is_private is True:
        path = "internal"
    elif remote_is_private is False:
        path = "external"
    else:
        # No usable address: fall back to whatever the card concluded from its
        # `internal_origins` list, which is a configured guess about hostnames.
        path = _vocabulary(payload.get("path"), PATHS, "unknown")

    connection = _vocabulary(
        classify_connection(
            network_type=payload.get("network_type"),
            remote_is_private=remote_is_private,
        ),
        CONNECTION_TYPES,
        "unknown",
    )

    client_id = _clean_text(payload.get("client_id"), 64) or "unknown"
    return {
        "client_id": client_id,
        "client": _clean_text(payload.get("client_name"), 64) or client_id,
        "platform": _vocabulary(payload.get("platform"), PLATFORMS_CLIENT, "unknown"),
        "origin": _clean_text(payload.get("origin"), 128),
        "path": path,
        "connection": connection,
        "device": _device(payload),
        "network": _network(payload, connection),
        "user": _clean_text(payload.get("user"), 64),
        "user_agent": _clean_text(payload.get("user_agent")),
        "latency": latency,
        "http_latency_ms": _finite(payload.get("http_latency_ms")),
        "download": {
            "mbps": mbits_per_second(download_bytes, download_seconds),
            "bytes": int(download_bytes),
            "seconds": round(download_seconds, 3),
            "streams": int(_finite(payload.get("download_streams")) or 0),
        },
        "upload": {
            "mbps": mbits_per_second(upload_bytes, upload_seconds),
            "bytes": int(upload_bytes),
            "seconds": round(upload_seconds, 3),
        },
        "ts": timestamp,
    }


def merge_clients(
    existing: Mapping[str, Any] | None,
    entry: Mapping[str, Any],
    *,
    limit: int = MAX_TRACKED_CLIENTS,
) -> dict[str, Any]:
    """Fold a result into the per-client map, newest first, bounded.

    Keyed by ``client_id`` rather than by name, so renaming a device updates
    its row instead of forking a second one -- and so two devices a user
    happens to give the same name stay distinct.

    Sorting is lexicographic on the ISO-8601 ``ts``, which is only correct
    because every timestamp written here is UTC with the same field widths.
    """
    merged = {key: dict(value) for key, value in (existing or {}).items() if isinstance(value, Mapping)}
    merged[entry["client_id"]] = dict(entry)

    ordered = sorted(merged.items(), key=lambda item: str(item[1].get("ts") or ""), reverse=True)
    return dict(ordered[:limit])


def iter_windows(buffer: memoryview, total: int, chunk: int, start: int = 0):
    """Yield up to ``chunk``-sized slices of ``buffer`` covering ``total`` bytes.

    The buffer is a fixed pool of random bytes that is smaller than most
    payloads, so windows wrap around it. Slices of a memoryview do not copy,
    which is the point: a 512 MB download must not allocate 512 MB.

    ``start`` staggers concurrent requests so parallel streams are not reading
    the identical byte range at the identical moment -- irrelevant to
    correctness, but it keeps a packet capture readable.
    """
    length = len(buffer)
    if length == 0 or total <= 0 or chunk <= 0:
        return
    position = start % length
    remaining = total
    while remaining > 0:
        size = min(chunk, remaining, length - position)
        yield buffer[position : position + size]
        position = (position + size) % length
        remaining -= size
