"""Unit tests for the pure measurement maths and payload normalisation.

The numeric fixtures here are duplicated in ``tests/test_card.js`` on purpose:
the card computes the same figures for its live display, and the two
implementations drifting apart would show one number on screen and record a
different one. Change a fixture here, change it there.
"""

from __future__ import annotations

import pytest
from conftest import const, measure

SAMPLES = [10.0, 12.0, 11.0, 40.0, 10.5, 11.5, 12.5, 10.0, 11.0, 12.0]


# --------------------------------------------------------------- clamping


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1048576", 1048576),
        (1048576, 1048576),
        ("  1048576  ", 1048576),
        # Anything unparseable falls back rather than erroring: the client is
        # asking for a size hint, not issuing a command.
        (None, const.DEFAULT_DOWNLOAD_BYTES),
        ("", const.DEFAULT_DOWNLOAD_BYTES),
        ("banana", const.DEFAULT_DOWNLOAD_BYTES),
        ("-5", const.DEFAULT_DOWNLOAD_BYTES),
        ("0", const.DEFAULT_DOWNLOAD_BYTES),
    ],
)
def test_clamp_download_bytes_parses_or_falls_back(raw, expected) -> None:
    assert measure.clamp_download_bytes(raw) == expected


def test_clamp_download_bytes_enforces_the_ceiling() -> None:
    """`?bytes=` is attacker-controlled input from any authenticated session."""
    assert measure.clamp_download_bytes(const.MAX_DOWNLOAD_BYTES * 100) == const.MAX_DOWNLOAD_BYTES
    assert measure.clamp_download_bytes("999999999999999") == const.MAX_DOWNLOAD_BYTES


def test_clamp_download_bytes_enforces_the_floor() -> None:
    assert measure.clamp_download_bytes(1) == const.MIN_DOWNLOAD_BYTES


# ------------------------------------------------------------- throughput


def test_mbits_per_second_is_decimal_megabits() -> None:
    """1 MB in 1 s is 8 Mbit/s, not 8.39 -- decimal, like every ISP plan."""
    assert measure.mbits_per_second(1_000_000, 1.0) == 8.0
    assert measure.mbits_per_second(125_000_000, 1.0) == 1000.0


@pytest.mark.parametrize(
    ("size", "seconds"),
    [(0, 1.0), (1000, 0), (1000, -1), (None, 1.0), (1000, None), ("x", 1.0), (float("inf"), 1.0)],
)
def test_mbits_per_second_refuses_nonsense(size, seconds) -> None:
    assert measure.mbits_per_second(size, seconds) is None


# ---------------------------------------------------------------- latency


def test_summarise_latency_reports_the_shape_of_the_samples() -> None:
    summary = measure.summarise_latency(SAMPLES)
    assert summary["count"] == 10
    assert summary["min"] == 10.0
    assert summary["max"] == 40.0
    assert summary["avg"] == 14.05
    # Nearest-rank: ceil(0.95 * 10) = 10th of 10 sorted values.
    assert summary["p95"] == 40.0


def test_jitter_is_successive_difference_not_deviation() -> None:
    """A steady link with one spike has low jitter; an alternating one does not.

    Both lists below have the same mean and nearly the same standard
    deviation, which is exactly why a deviation would be the wrong statistic
    to describe how a dashboard feels.
    """
    steady = measure.summarise_latency([10, 10, 10, 10, 30])["jitter"]
    alternating = measure.summarise_latency([10, 30, 10, 30, 10])["jitter"]
    assert steady == 5.0
    assert alternating == 20.0
    assert alternating > steady


def test_summarise_latency_handles_thin_and_dirty_input() -> None:
    assert measure.summarise_latency([])["count"] == 0
    assert measure.summarise_latency([])["avg"] is None
    # One sample cannot have a jitter -- there is no successive difference.
    single = measure.summarise_latency([7.5])
    assert single["count"] == 1
    assert single["jitter"] is None
    # Junk is dropped, not coerced to zero, which would drag the average down.
    dirty = measure.summarise_latency([10, None, "x", float("nan"), -1, 20])
    assert dirty["count"] == 2
    assert dirty["avg"] == 15.0


# ------------------------------------------------------------- percentile


def test_percentile_never_invents_a_value() -> None:
    """Nearest-rank returns an observed sample, never a point between two."""
    values = [1.0, 2.0, 3.0, 4.0]
    assert measure.percentile(values, 0.5) in values
    assert measure.percentile(values, 0.95) == 4.0
    assert measure.percentile([], 0.5) is None


# ---------------------------------------------------------- normalisation


def _payload(**overrides):
    payload = {
        "client_id": "abc-123",
        "client_name": "Pixel 9 Pro",
        "platform": "android_app",
        "origin": "https://ha.example.net",
        "path": "external",
        "user": "John",
        "user_agent": "Mozilla/5.0",
        "latency_samples_ms": SAMPLES,
        "http_latency_ms": 18.2,
        "download_bytes": 33_554_432,
        "download_seconds": 4.0,
        "download_streams": 4,
        "upload_bytes": 8_388_608,
        "upload_seconds": 2.0,
    }
    payload.update(overrides)
    return payload


def test_normalise_report_derives_rather_than_trusts() -> None:
    entry = measure.normalise_report(_payload(), timestamp="2026-08-20T12:00:00+00:00")
    assert entry["download"]["mbps"] == measure.mbits_per_second(33_554_432, 4.0)
    assert entry["upload"]["mbps"] == measure.mbits_per_second(8_388_608, 2.0)
    assert entry["latency"] == measure.summarise_latency(SAMPLES)
    assert entry["ts"] == "2026-08-20T12:00:00+00:00"


def test_normalise_report_survives_a_partial_run() -> None:
    """A cancelled run reports what it got; the rest must read as absent."""
    entry = measure.normalise_report(
        {"client_id": "abc-123", "client_name": "Pixel"},
        timestamp="2026-08-20T12:00:00+00:00",
    )
    assert entry["latency"]["count"] == 0
    assert entry["download"]["mbps"] is None
    assert entry["upload"]["mbps"] is None
    assert entry["platform"] == "unknown"
    assert entry["path"] == "unknown"


def test_normalise_report_rejects_values_outside_the_vocabulary() -> None:
    entry = measure.normalise_report(
        _payload(platform="<script>", path="sideways"),
        timestamp="2026-08-20T12:00:00+00:00",
    )
    assert entry["platform"] == "unknown"
    assert entry["path"] == "unknown"


def test_normalise_report_bounds_free_text() -> None:
    """User agents reach a recorded attribute; unbounded ones bloat the DB."""
    entry = measure.normalise_report(_payload(user_agent="A" * 5000), timestamp="2026-08-20T12:00:00+00:00")
    assert len(entry["user_agent"]) == measure.MAX_TEXT


def test_normalise_report_falls_back_to_the_id_when_unnamed() -> None:
    entry = measure.normalise_report(
        {"client_id": "abc-123", "client_name": "   "},
        timestamp="2026-08-20T12:00:00+00:00",
    )
    assert entry["client"] == "abc-123"


# ------------------------------------------------------------------ merge


def _entry(client_id: str, ts: str, name: str | None = None):
    return measure.normalise_report({"client_id": client_id, "client_name": name or client_id}, timestamp=ts)


def test_merge_clients_keys_on_id_not_name() -> None:
    """Renaming a device updates its row; two devices sharing a name stay apart."""
    clients = measure.merge_clients({}, _entry("a", "2026-08-20T10:00:00+00:00", "Phone"))
    clients = measure.merge_clients(clients, _entry("a", "2026-08-20T11:00:00+00:00", "John's Phone"))
    clients = measure.merge_clients(clients, _entry("b", "2026-08-20T11:30:00+00:00", "John's Phone"))

    assert set(clients) == {"a", "b"}
    assert clients["a"]["client"] == "John's Phone"


def test_merge_clients_orders_newest_first_and_bounds_the_map() -> None:
    """The whole map is published as a sensor attribute, so it must be bounded."""
    clients: dict = {}
    for index in range(const.MAX_TRACKED_CLIENTS + 5):
        clients = measure.merge_clients(clients, _entry(f"c{index:02d}", f"2026-08-20T10:{index:02d}:00+00:00"))

    assert len(clients) == const.MAX_TRACKED_CLIENTS
    assert next(iter(clients)) == f"c{const.MAX_TRACKED_CLIENTS + 4:02d}"
    # The oldest fell off, not the newest.
    assert "c00" not in clients


def test_merge_clients_ignores_a_corrupt_stored_map() -> None:
    """A hand-edited or half-written store must not take the integration down."""
    clients = measure.merge_clients({"junk": "not a mapping"}, _entry("a", "2026-08-20T10:00:00+00:00"))
    assert set(clients) == {"a"}


# ------------------------------------------------------------ byte windows


def test_iter_windows_covers_exactly_the_requested_total() -> None:
    buffer = memoryview(bytes(range(256)) * 4)  # 1024 bytes
    chunks = list(measure.iter_windows(buffer, 3000, 256))
    assert sum(len(chunk) for chunk in chunks) == 3000
    assert max(len(chunk) for chunk in chunks) <= 256


def test_iter_windows_wraps_without_copying() -> None:
    """A 512 MB download must not allocate 512 MB."""
    buffer = memoryview(bytes(range(256)))
    chunks = list(measure.iter_windows(buffer, 700, 100, start=200))
    assert all(isinstance(chunk, memoryview) for chunk in chunks)
    assert sum(len(chunk) for chunk in chunks) == 700
    # Starting mid-buffer must not lose or duplicate bytes.
    assert b"".join(bytes(chunk) for chunk in chunks)[:56] == bytes(range(200, 256))


@pytest.mark.parametrize(("total", "chunk"), [(0, 256), (-1, 256), (100, 0)])
def test_iter_windows_yields_nothing_for_degenerate_requests(total, chunk) -> None:
    assert list(measure.iter_windows(memoryview(b"abcd"), total, chunk)) == []


def test_iter_windows_tolerates_an_empty_buffer() -> None:
    assert list(measure.iter_windows(memoryview(b""), 100, 10)) == []
