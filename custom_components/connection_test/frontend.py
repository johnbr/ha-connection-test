"""Serve the card and register it as a Lovelace resource.

Adapted from ``ha-teslamate-cards``, including the HA 2026.7 ``mode`` ->
``resource_mode`` rename fallback.

The ``?v=`` on the resource URL is the only cache-buster. The card is served
with a 31-day ``max-age``, so a browser that already has it will not ask again
until that URL changes -- there is no revalidation to fall back on.

The key is ``<manifest version>.<content hash>``, and the hash half is not
belt-and-braces. The version alone is only a correct cache key for *released*
installs: deploy straight from a branch, or hand-copy the folder, and the card
changes while release-please has not yet bumped the manifest, so the URL stays
byte-identical and every browser keeps running the previous module. That is a
silent failure -- the server serves the new file the whole time, and the only
symptom is Home Assistant's generic "Configuration error" card, which names
neither the cache nor the file.

Hashing the bytes actually served makes the URL stale only when the card is
unchanged, which is exactly when a stale cache is the right answer.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import CARD_FILENAME, DATA_STATIC_REGISTERED, DOMAIN, URL_BASE

_LOGGER = logging.getLogger(__name__)

_CARD_URL_PATH = f"{URL_BASE}/{CARD_FILENAME}"


def _read_card(card_path: Path) -> bytes | None:
    """Read the card, or None if it is missing.

    Existence check and read happen together so they cost one trip to the
    executor: Home Assistant flags file reads made on the event loop.
    """
    try:
        return card_path.read_bytes()
    except OSError:
        return None


async def async_register_frontend(hass: HomeAssistant, version: str) -> None:
    """Serve the card at a stable path and point Lovelace at a versioned URL."""
    data = hass.data.setdefault(DOMAIN, {})
    card_path = Path(__file__).parent / "frontend" / CARD_FILENAME

    card = await hass.async_add_executor_job(_read_card, card_path)
    if card is None:
        # An incomplete checkout. The endpoints and entities still work, so
        # say what is missing rather than failing setup over it.
        _LOGGER.warning("Card not found at %s -- the dashboard card will not load", card_path)
        return

    if not data.get(DATA_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(_CARD_URL_PATH, str(card_path), cache_headers=True)]
        )
        data[DATA_STATIC_REGISTERED] = True

    # Truncated to 8 hex characters: this is a cache key, not a signature, and
    # a collision would only mean one browser keeps a stale module -- the same
    # failure the full-length hash protects against, at 2^-32 odds.
    fingerprint = hashlib.sha256(card).hexdigest()[:8]
    versioned_url = f"{_CARD_URL_PATH}?v={version}.{fingerprint}"

    resources = _storage_resources(hass)
    if resources is None:
        _LOGGER.info(
            "Lovelace resources are in YAML mode; add the card manually: url: %s, type: module",
            versioned_url,
        )
        return

    if not resources.loaded:
        await resources.async_load()
        resources.loaded = True

    for item in resources.async_items():
        if (item.get("url") or "").split("?")[0] == _CARD_URL_PATH:
            if item["url"] != versioned_url:
                await resources.async_update_item(item["id"], {"res_type": "module", "url": versioned_url})
                _LOGGER.debug("Updated Lovelace resource to %s", versioned_url)
            return

    await resources.async_create_item({"res_type": "module", "url": versioned_url})
    _LOGGER.debug("Registered Lovelace resource %s", versioned_url)


def _storage_resources(hass: HomeAssistant):
    """Return the resource storage collection, or None in YAML resource mode."""
    lovelace = hass.data.get("lovelace")
    # HA 2026.7 renamed LovelaceData.mode to resource_mode; check both so
    # older cores (>= 2025.7) keep working.
    mode = getattr(lovelace, "resource_mode", None) or getattr(lovelace, "mode", None)
    if mode != "storage":
        return None
    return getattr(lovelace, "resources", None)
