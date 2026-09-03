"""The Connection Test integration.

Measures the link between a *client* -- a browser, or the Home Assistant
Companion app on Android or iOS -- and the Home Assistant server. Everything
else in a typical install measures the server's own connectivity: pings leaving
the host, throughput counters read off a switch. None of that describes the leg
that is actually slow when a dashboard feels sluggish, which is the one between
the device in your hand and Home Assistant.

The measurement therefore has to happen *in the client*, and this integration
exists to give it something honest to measure against:

  * ``/api/connection_test/echo``      -- an empty response, for HTTP latency
  * ``/api/connection_test/download``  -- N bytes of incompressible random data
  * ``/api/connection_test/upload``    -- a sink that counts what arrives

Latency itself is measured over the websocket the dashboard already runs on
(``connection.ping()`` -> ``pong``), which is both the most representative
number available and the one that costs nothing to obtain. Bulk data
deliberately does *not* go over that socket: Home Assistant disconnects a
websocket client that falls ``MAX_PENDING_MSG`` (4096) messages behind, so a
throughput test run over it could kick the dashboard offline mid-measurement.

The card reports its results back through ``connection_test.report``, and four
sensors publish the most recent run.
"""

from __future__ import annotations

import logging
import os

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .const import (
    DATA_RUNTIME,
    DATA_VIEWS_REGISTERED,
    DOMAIN,
    RANDOM_BUFFER_BYTES,
    SERVICE_REPORT,
)
from .frontend import async_register_frontend
from .runtime import ConnectionTestRuntime
from .views import (
    ConnectionTestDownloadView,
    ConnectionTestEchoView,
    ConnectionTestInfoView,
    ConnectionTestUploadView,
)

_LOGGER = logging.getLogger(__name__)

# Configured through the UI only.
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

PLATFORMS: list[Platform] = [Platform.SENSOR]

# The card sends raw measurements and nothing derived -- see measure.py for why
# the server recomputes rather than trusting a figure it cannot check. The
# schema's job is to keep the types honest and the payload bounded; meaning is
# decided in `normalise_report`.
REPORT_SCHEMA = vol.Schema(
    {
        vol.Required("client_id"): cv.string,
        vol.Required("client_name"): cv.string,
        vol.Optional("platform"): cv.string,
        # `origin` is the URL the run MEASURED and `page_origin` the one the
        # dashboard was loaded from. They differ whenever the card switched a
        # run onto the LAN path, and the pair is the only thing that explains
        # a result taken from a hostname nobody typed.
        vol.Optional("origin"): cv.string,
        vol.Optional("page_origin"): cv.string,
        vol.Optional("path"): cv.string,
        vol.Optional("user"): cv.string,
        vol.Optional("user_agent"): cv.string,
        # What the device says it is. Free text from a browser, bounded in
        # measure.py before it reaches an attribute.
        vol.Optional("device_model"): cv.string,
        vol.Optional("device_os"): cv.string,
        vol.Optional("device_browser"): cv.string,
        vol.Optional("device_form_factor"): cv.string,
        vol.Optional("device_screen"): cv.string,
        # How it got here. `client_ip` is echoed back from /info rather than
        # claimed by the client, so it is the server's own observation making
        # a round trip -- see normalise_report.
        vol.Optional("client_ip"): cv.string,
        vol.Optional("client_ip_source"): cv.string,
        vol.Optional("via_cloudflare"): cv.boolean,
        vol.Optional("network_type"): cv.string,
        vol.Optional("effective_type"): cv.string,
        vol.Optional("downlink_mbps"): vol.Coerce(float),
        vol.Optional("network_rtt_ms"): vol.Coerce(float),
        vol.Optional("save_data"): cv.boolean,
        # Bounded: this list is free input from a browser and every element
        # ends up summarised into a recorded attribute.
        vol.Optional("latency_samples_ms"): vol.All(cv.ensure_list, vol.Length(max=200), [vol.Coerce(float)]),
        vol.Optional("http_latency_ms"): vol.Coerce(float),
        vol.Optional("download_bytes"): vol.Coerce(float),
        vol.Optional("download_seconds"): vol.Coerce(float),
        vol.Optional("download_streams"): vol.Coerce(int),
        vol.Optional("upload_bytes"): vol.Coerce(float),
        vol.Optional("upload_seconds"): vol.Coerce(float),
    }
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the shared data bucket."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the endpoints, the service, the sensors and the card."""
    data = hass.data.setdefault(DOMAIN, {})

    runtime = ConnectionTestRuntime(hass)
    await runtime.async_load()
    data[entry.entry_id] = {DATA_RUNTIME: runtime}

    if not data.get(DATA_VIEWS_REGISTERED):
        # One pool of random bytes for the lifetime of the process. Generated
        # off the event loop because os.urandom of this size is a syscall that
        # can block, and reused for every download so that streaming 512 MB
        # costs no CPU beyond the socket writes.
        payload = await hass.async_add_executor_job(os.urandom, RANDOM_BUFFER_BYTES)

        hass.http.register_view(ConnectionTestEchoView())
        hass.http.register_view(ConnectionTestInfoView())
        hass.http.register_view(ConnectionTestDownloadView(payload))
        hass.http.register_view(ConnectionTestUploadView())
        # aiohttp has no route deregistration, so these outlive an unload. That
        # is why the manifest sets `single_config_entry`: a second entry could
        # never register a second copy anyway.
        data[DATA_VIEWS_REGISTERED] = True

    if not hass.services.has_service(DOMAIN, SERVICE_REPORT):
        hass.services.async_register(DOMAIN, SERVICE_REPORT, _async_handle_report, schema=REPORT_SCHEMA)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    integration = await async_get_integration(hass, DOMAIN)
    await async_register_frontend(hass, str(integration.version))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the sensors and drop the stored runtime."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return unloaded


async def _async_handle_report(call: ServiceCall) -> None:
    """Record a run reported by a client."""
    hass = call.hass
    for stored in hass.data.get(DOMAIN, {}).values():
        if isinstance(stored, dict) and (runtime := stored.get(DATA_RUNTIME)):
            await runtime.async_record(dict(call.data))
            return
    _LOGGER.warning("connection_test.report called before the integration finished setting up")
