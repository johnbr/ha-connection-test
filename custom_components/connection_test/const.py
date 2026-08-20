"""Constants for the Connection Test integration.

Pure data only -- no Home Assistant imports and no I/O -- so this module can be
imported by the unit tests, which run with nothing installed but pytest.
"""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "connection_test"

# --- Frontend ---------------------------------------------------------------
URL_BASE: Final = "/connection_test"
CARD_FILENAME: Final = "connection-test-card.js"

# --- HTTP test endpoints ----------------------------------------------------
# These live under /api/ deliberately, and it is the single most important
# decision in this integration.
#
# The Home Assistant frontend registers a Workbox service worker whose LAST
# route is a catch-all `/.*` handled StaleWhileRevalidate into a 24h
# "file-cache". Anything served from /local/ therefore comes back out of Cache
# Storage on the second request -- a "download" that never touches the network
# and reports an absurd speed -- while every cache-busted run *writes* another
# copy of the payload into the client's cache. `fetch(..., {cache: "no-store"})`
# does NOT save you: that option controls the HTTP cache, not the service
# worker, whose fetch handler runs regardless.
#
# `/(api|auth)/.*` is registered ahead of that catch-all as NetworkOnly, so a
# request under /api/ is guaranteed to hit the network every time. Verified
# against hass_frontend/service_worker.js in 2026.8.2.
API_ECHO: Final = "/api/connection_test/echo"
API_DOWNLOAD: Final = "/api/connection_test/download"
API_UPLOAD: Final = "/api/connection_test/upload"

# --- Payload sizing ---------------------------------------------------------
# One buffer of real random bytes, allocated once at setup and streamed in
# windows. Random so nothing downstream can compress it (a repetitive payload
# through a proxy with gzip enabled would measure the compressor, not the
# link); allocated once so a 512 MB download costs no per-request CPU on a box
# whose event loop is already the scarce resource.
RANDOM_BUFFER_BYTES: Final = 4 * 1024 * 1024
STREAM_CHUNK_BYTES: Final = 256 * 1024

DEFAULT_DOWNLOAD_BYTES: Final = 8 * 1024 * 1024
MIN_DOWNLOAD_BYTES: Final = 64 * 1024
# A hard server-side ceiling. `?bytes=` is attacker-controlled input from any
# authenticated session, and an unclamped size parameter is a self-inflicted
# amplification lever.
MAX_DOWNLOAD_BYTES: Final = 512 * 1024 * 1024

# The upload view drains request.content directly rather than calling
# request.read(), which is what sidesteps Home Assistant's 16 MiB
# MAX_CLIENT_SIZE (that limit is enforced inside aiohttp's Request.read()).
# Since the framework is no longer counting, this view counts for itself.
MAX_UPLOAD_BYTES: Final = 128 * 1024 * 1024
UPLOAD_CHUNK_BYTES: Final = 64 * 1024

# --- Service ----------------------------------------------------------------
SERVICE_REPORT: Final = "report"

# --- Storage ----------------------------------------------------------------
STORAGE_KEY: Final = f"{DOMAIN}.results"
STORAGE_VERSION: Final = 1

# Enough for every screen in a house several times over. Bounded because the
# whole map is published as a sensor attribute, and an unbounded attribute is a
# recorder-row problem waiting to happen.
MAX_TRACKED_CLIENTS: Final = 12

# --- hass.data keys / signals -----------------------------------------------
DATA_RUNTIME: Final = "runtime"
DATA_VIEWS_REGISTERED: Final = "views_registered"
DATA_STATIC_REGISTERED: Final = "static_registered"
SIGNAL_RESULT: Final = f"{DOMAIN}_result"

# --- Vocabularies -----------------------------------------------------------
PATHS: Final = frozenset({"internal", "external", "unknown"})
PLATFORMS_CLIENT: Final = frozenset({"browser", "android_app", "ios_app", "unknown"})
