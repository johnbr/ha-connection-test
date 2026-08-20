"""Sensors carrying the most recent connection test.

Four entities, one device, all reading the same stored run.

**They report the most recent run from ANY client**, which is a real trade-off
and not an oversight: Home Assistant state is per-instance, not per-browser, so
a test run on the phone overwrites one run on the tablet. Splitting them into
per-client entities would mean registering entities dynamically for devices the
integration has never seen, and a graveyard of them when a phone is replaced.

The compromise is the ``clients`` attribute on the "Last Run" sensor: a bounded
map of the latest result *per client*, which is enough to render a per-device
table on a dashboard without any of that machinery. What it cannot give you is
per-client *history* -- the recorder sees one mixed series -- so every numeric
sensor carries the ``client`` that produced its current value.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfDataRate, UnitOfTime
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SIGNAL_RESULT
from .runtime import ConnectionTestRuntime, get_runtime


@dataclass(frozen=True, kw_only=True)
class ConnectionTestSensorDescription(SensorEntityDescription):
    """Describes one reading taken from a stored run."""

    value_fn: Callable[[dict[str, Any]], Any]
    attrs_fn: Callable[[dict[str, Any], ConnectionTestRuntime], dict[str, Any]] = lambda run, runtime: {}


def _latency_attrs(run: dict[str, Any], _: ConnectionTestRuntime) -> dict[str, Any]:
    latency = run.get("latency") or {}
    return {
        "minimum_ms": latency.get("min"),
        "maximum_ms": latency.get("max"),
        "p95_ms": latency.get("p95"),
        "jitter_ms": latency.get("jitter"),
        "samples": latency.get("count"),
        # The websocket figure above is the one that matters; this is the same
        # trip over plain HTTP. A large gap between them accuses the proxy.
        "http_latency_ms": run.get("http_latency_ms"),
    }


def _download_attrs(run: dict[str, Any], _: ConnectionTestRuntime) -> dict[str, Any]:
    download = run.get("download") or {}
    return {
        "bytes": download.get("bytes"),
        "seconds": download.get("seconds"),
        "streams": download.get("streams"),
    }


def _upload_attrs(run: dict[str, Any], _: ConnectionTestRuntime) -> dict[str, Any]:
    upload = run.get("upload") or {}
    return {"bytes": upload.get("bytes"), "seconds": upload.get("seconds")}


def _last_run_attrs(run: dict[str, Any], runtime: ConnectionTestRuntime) -> dict[str, Any]:
    return {
        "latency_ms": (run.get("latency") or {}).get("avg"),
        "download_mbps": (run.get("download") or {}).get("mbps"),
        "upload_mbps": (run.get("upload") or {}).get("mbps"),
        "clients": runtime.clients,
    }


SENSORS: tuple[ConnectionTestSensorDescription, ...] = (
    ConnectionTestSensorDescription(
        key="latency",
        translation_key="latency",
        icon="mdi:timer-outline",
        native_unit_of_measurement=UnitOfTime.MILLISECONDS,
        device_class=SensorDeviceClass.DURATION,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda run: (run.get("latency") or {}).get("avg"),
        attrs_fn=_latency_attrs,
    ),
    ConnectionTestSensorDescription(
        key="download",
        translation_key="download",
        icon="mdi:download-network-outline",
        native_unit_of_measurement=UnitOfDataRate.MEGABITS_PER_SECOND,
        device_class=SensorDeviceClass.DATA_RATE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda run: (run.get("download") or {}).get("mbps"),
        attrs_fn=_download_attrs,
    ),
    ConnectionTestSensorDescription(
        key="upload",
        translation_key="upload",
        icon="mdi:upload-network-outline",
        native_unit_of_measurement=UnitOfDataRate.MEGABITS_PER_SECOND,
        device_class=SensorDeviceClass.DATA_RATE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda run: (run.get("upload") or {}).get("mbps"),
        attrs_fn=_upload_attrs,
    ),
    ConnectionTestSensorDescription(
        key="last_run",
        translation_key="last_run",
        icon="mdi:lan-connect",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=lambda run: dt_util.parse_datetime(str(run.get("ts") or "")),
        attrs_fn=_last_run_attrs,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the connection-test sensors."""
    runtime = get_runtime(hass, entry.entry_id)
    if runtime is None:  # pragma: no cover - setup order guarantees this
        return
    async_add_entities(ConnectionTestSensor(entry, runtime, description) for description in SENSORS)


class ConnectionTestSensor(SensorEntity):
    """One reading from the most recently reported run."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    entity_description: ConnectionTestSensorDescription

    def __init__(
        self,
        entry: ConfigEntry,
        runtime: ConnectionTestRuntime,
        description: ConnectionTestSensorDescription,
    ) -> None:
        self.entity_description = description
        self._runtime = runtime
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Connection Test",
            manufacturer="Home Assistant",
            entry_type=DeviceEntryType.SERVICE,
        )

    async def async_added_to_hass(self) -> None:
        """Repaint whenever a client reports a run."""
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_RESULT, self._handle_result))

    @callback
    def _handle_result(self) -> None:
        self.async_write_ha_state()

    @property
    def native_value(self) -> float | datetime | None:
        run = self._runtime.last
        if not run:
            return None
        return self.entity_description.value_fn(run)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        run = self._runtime.last
        if not run:
            return {}
        # Every sensor carries who produced its current value, because the
        # state itself cannot say -- see the module docstring.
        context = {
            "client": run.get("client"),
            "client_id": run.get("client_id"),
            "platform": run.get("platform"),
            "origin": run.get("origin"),
            "path": run.get("path"),
            "user": run.get("user"),
        }
        return {**context, **self.entity_description.attrs_fn(run, self._runtime)}
