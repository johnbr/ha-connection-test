"""The HTTP endpoints a client measures itself against.

Three views, all authenticated, all under ``/api/`` -- see ``const.py`` for why
the path prefix is load-bearing rather than cosmetic.

Nothing here decides how fast anything is. The endpoints exist to move a known
number of bytes and get out of the way; the client owns the stopwatch, for
reasons spelled out on the upload view.
"""

from __future__ import annotations

import logging
import secrets
from http import HTTPStatus

from aiohttp import web
from homeassistant.components.http import HomeAssistantView

from .const import (
    API_DOWNLOAD,
    API_ECHO,
    API_INFO,
    API_UPLOAD,
    CLOUDFLARE_UPLOAD_CEILING_BYTES,
    DOMAIN,
    MAX_DOWNLOAD_BYTES,
    MAX_UPLOAD_BYTES,
    STREAM_CHUNK_BYTES,
    UPLOAD_CHUNK_BYTES,
)
from .measure import (
    clamp_download_bytes,
    is_private_address,
    iter_windows,
    observed_client_ip,
)

_LOGGER = logging.getLogger(__name__)

# A measurement must never be answered from a cache -- not the browser's, not a
# reverse proxy's, not Cloudflare's. `no-store` is the only directive that
# forbids writing the response down at all; `no-cache` and `must-revalidate`
# are there for intermediaries that predate it.
#
# `X-Accel-Buffering: no` is for nginx. The Home Assistant vhost here already
# sets `proxy_buffering off`, but this integration is meant to run behind
# whatever proxy someone happens to have, and a buffering proxy turns a
# streamed download into one big burst at the end.
NO_STORE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "X-Accel-Buffering": "no",
}


class ConnectionTestEchoView(HomeAssistantView):
    """A deliberately empty response, for measuring HTTP round-trip time.

    The websocket ping is the better latency number -- it is the transport the
    dashboard actually runs on -- but the two disagreeing is itself a
    diagnosis: a fine websocket RTT next to a poor HTTP one points at the
    proxy or at TLS session resumption, not at the network.
    """

    url = API_ECHO
    name = f"api:{DOMAIN}:echo"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        return web.Response(status=HTTPStatus.NO_CONTENT, headers=NO_STORE)


class ConnectionTestInfoView(HomeAssistantView):
    """What the server can see about this client that the client cannot.

    Two things, and both change what a result means.

    THE ADDRESS THE REQUEST ARRIVED FROM. A browser has no way to learn its own
    network address, and the hostname it is using does not answer the question
    either -- an internal name can be reached over a VPN and an external name
    can be loaded while sitting on the same Wi-Fi as the server, which is the
    case that confuses people. Whether the address the server saw is private is
    a fact, and it is the one the ``internal``/``external`` verdict now rests
    on.

    THE SIZE THE PATH WILL TOLERATE. Cloudflare rejects request bodies over
    100 MB, so an upload test sized for the link rather than the path fails at
    a ceiling nothing on the client side knows about. ``CF-Ray`` is present
    exactly when a request came through Cloudflare, so this is detection, not
    a guess about hostnames.
    """

    url = API_INFO
    name = f"api:{DOMAIN}:info"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        address, source = observed_client_ip(request.headers, request.remote)
        private = is_private_address(address)

        # Cloudflare stamps every request it proxies with CF-Ray. Anything that
        # only sets CF-Connecting-IP is something imitating Cloudflare, so both
        # are required before the ceiling is applied.
        via_cloudflare = bool(request.headers.get("CF-Ray")) and bool(request.headers.get("CF-Connecting-IP"))

        max_upload = MAX_UPLOAD_BYTES
        if via_cloudflare:
            max_upload = min(max_upload, CLOUDFLARE_UPLOAD_CEILING_BYTES)

        return self.json(
            {
                "client_ip": address,
                "client_ip_source": source,
                # Tri-state on purpose: null means "no address to judge", which
                # is different from "judged, and it is public".
                "client_ip_is_private": private,
                "via_cloudflare": via_cloudflare,
                "max_upload_bytes": max_upload,
                "max_download_bytes": MAX_DOWNLOAD_BYTES,
            },
            headers=NO_STORE,
        )


class ConnectionTestDownloadView(HomeAssistantView):
    """Stream ``?bytes=N`` random bytes to the client."""

    url = API_DOWNLOAD
    name = f"api:{DOMAIN}:download"
    requires_auth = True

    def __init__(self, payload: bytes) -> None:
        # One shared pool, allocated once at setup. Held as a memoryview so the
        # slices handed to the writer never copy.
        self._payload = memoryview(payload)

    async def get(self, request: web.Request) -> web.StreamResponse:
        size = clamp_download_bytes(request.query.get("bytes"))

        response = web.StreamResponse(headers=NO_STORE)
        response.content_type = "application/octet-stream"
        # An explicit length keeps the transfer out of chunked encoding and
        # lets the client draw a real progress bar.
        response.content_length = size
        await response.prepare(request)

        start = secrets.randbelow(len(self._payload))
        for window in iter_windows(self._payload, size, STREAM_CHUNK_BYTES, start):
            # Each await yields to the event loop. That is why the payload is
            # pre-generated: the only work left in this loop is the socket
            # write, so a fast client cannot spin the loop generating bytes.
            await response.write(window)

        await response.write_eof()
        return response


class ConnectionTestUploadView(HomeAssistantView):
    """Drain a request body and report how much of it arrived.

    Two things about this view are unusual and both are deliberate.

    It reads ``request.content`` rather than ``request.read()``. Home Assistant
    builds its aiohttp application with ``client_max_size=16 MiB``, and that
    limit is enforced inside ``Request.read()`` -- so ``read()`` would cap an
    upload test at 16 MiB regardless of what the proxy in front allows. Reading
    the stream directly is the documented way past it, and it means this view
    has to enforce its own ceiling, which it does.

    It reports a byte count, not a speed. The client times the upload, because
    nginx buffers request bodies by default (``proxy_request_buffering on``):
    by the time this handler is called the bytes are already off the wire, so
    anything measured here would time nginx handing over a buffer rather than
    the client's link. The count is the honest half -- proof the bytes actually
    landed -- and the client owns the clock.
    """

    url = API_UPLOAD
    name = f"api:{DOMAIN}:upload"
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        received = 0
        async for chunk in request.content.iter_chunked(UPLOAD_CHUNK_BYTES):
            received += len(chunk)
            if received > MAX_UPLOAD_BYTES:
                _LOGGER.warning(
                    "Upload test aborted: body exceeded %s bytes",
                    MAX_UPLOAD_BYTES,
                )
                return self.json(
                    {"error": "payload too large", "limit": MAX_UPLOAD_BYTES},
                    status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    headers=NO_STORE,
                )

        return self.json({"bytes": received}, headers=NO_STORE)
