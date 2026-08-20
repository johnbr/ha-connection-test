"""Where a client's result lives once it has been reported.

One object per config entry, holding the most recent run and a bounded map of
the most recent run *per client*. Both are persisted, so a restart does not
blank the dashboard.

Persistence is a ``Store`` rather than ``RestoreEntity`` on purpose. The
interesting half of a result is the attributes, and four entities each
restoring their own copy of the same run would be four chances for them to
disagree after an upgrade. One store, four readers.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DATA_RUNTIME, DOMAIN, SIGNAL_RESULT, STORAGE_KEY, STORAGE_VERSION
from .measure import merge_clients, normalise_report

_LOGGER = logging.getLogger(__name__)


class ConnectionTestRuntime:
    """Holds, persists and publishes connection-test results."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.last: dict[str, Any] | None = None
        self.clients: dict[str, Any] = {}

    async def async_load(self) -> None:
        """Restore previous results.

        A store we cannot read costs history, not function -- the endpoints and
        the card work perfectly with an empty one -- so this warns and carries
        on rather than failing setup.
        """
        try:
            stored = await self._store.async_load()
        except HomeAssistantError:
            _LOGGER.warning("Could not read stored results; starting empty", exc_info=True)
            return

        if not stored:
            return
        last = stored.get("last")
        clients = stored.get("clients")
        self.last = last if isinstance(last, dict) else None
        self.clients = clients if isinstance(clients, dict) else {}

    async def async_record(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Normalise one reported run, publish it, and persist it."""
        entry = normalise_report(payload, timestamp=dt_util.utcnow().isoformat())
        self.last = entry
        self.clients = merge_clients(self.clients, entry)

        await self._store.async_save({"last": self.last, "clients": self.clients})
        async_dispatcher_send(self._hass, SIGNAL_RESULT)

        _LOGGER.debug(
            "Recorded connection test from %s: %s ms, %s down / %s up Mbit/s",
            entry["client"],
            entry["latency"]["avg"],
            entry["download"]["mbps"],
            entry["upload"]["mbps"],
        )
        return entry


def get_runtime(hass: HomeAssistant, entry_id: str) -> ConnectionTestRuntime | None:
    """Return the runtime for a config entry, if it is set up."""
    return (hass.data.get(DOMAIN, {}).get(entry_id) or {}).get(DATA_RUNTIME)
