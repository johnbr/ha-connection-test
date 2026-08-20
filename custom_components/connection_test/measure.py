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

import math
from collections.abc import Iterable, Mapping
from itertools import pairwise
from typing import Any

from .const import (
    DEFAULT_DOWNLOAD_BYTES,
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

    client_id = _clean_text(payload.get("client_id"), 64) or "unknown"
    return {
        "client_id": client_id,
        "client": _clean_text(payload.get("client_name"), 64) or client_id,
        "platform": _vocabulary(payload.get("platform"), PLATFORMS_CLIENT, "unknown"),
        "origin": _clean_text(payload.get("origin"), 128),
        "path": _vocabulary(payload.get("path"), PATHS, "unknown"),
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
