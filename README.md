# Connection Test

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz)
[![Hassfest](https://github.com/johnbr/ha-connection-test/actions/workflows/hassfest.yml/badge.svg)](https://github.com/johnbr/ha-connection-test/actions/workflows/hassfest.yml)
[![HACS validation](https://github.com/johnbr/ha-connection-test/actions/workflows/validate.yml/badge.svg)](https://github.com/johnbr/ha-connection-test/actions/workflows/validate.yml)

A **Test Connection** button for your dashboard. Measures latency and throughput
between the device you are holding and your Home Assistant server, from a
browser, the Android Companion app, or the iOS Companion app.

<!-- prettier-ignore -->
> Everything else in a typical install measures the *server's* connectivity —
> pings leaving the host, throughput counters read off a switch, an internet
> speed test run on the server. None of that describes the leg that is actually
> slow when a dashboard feels sluggish, which is the one between your phone and
> Home Assistant. That leg can only be measured from the client, which is what
> this does.

## What it measures

| Reading | How | Why that way |
|---|---|---|
| **Latency** | `connection.ping()` → `pong` over the websocket the dashboard already has open | It is the transport every state update and button press uses, so it is the number that describes how responsive the dashboard *feels*. Reported as min / average / p95 / jitter. |
| **Download** | Parallel `GET`s of incompressible random bytes from `/api/connection_test/download` | Sized from a probe run, so it lands near the target duration on both a 2.5 GbE LAN and bad cellular. |
| **Upload** | `POST` to `/api/connection_test/upload`, which counts what arrives | Timed by the client — see the note on proxies below. |

Bulk data deliberately does **not** go over the websocket: Home Assistant
disconnects a websocket client that falls 4096 messages behind, so a throughput
test run over it could kick the dashboard offline mid-measurement.

## Install

**HACS** → Integrations → ⋮ → Custom repositories → add
`https://github.com/johnbr/ha-connection-test` as an **Integration** → install →
**restart Home Assistant** → *Settings → Devices & Services → Add Integration →
Connection Test*.

**Manually**: copy `custom_components/connection_test/` into your `config/custom_components/`,
restart, then add the integration.

The dashboard card registers its own Lovelace resource — there is nothing to add
by hand. (If your Lovelace *resources* are in YAML mode the integration cannot
register it for you; it logs the exact `url:` to add.)

## The card

```yaml
type: custom:connection-test-card
```

Every option is optional:

```yaml
type: custom:connection-test-card
title: Connection Test
client_name: Pixel 9 Pro        # default: derived from the platform + user agent
internal_origins:               # see "Which URL am I on?" below
  - https://homeassistant.local:8123
  - http://192.168.1.10:8123
ping_count: 20                  # 3–100
target_seconds: 4               # aim each transfer at this duration, 1–20
download_streams: 4             # parallel connections, 1–8
min_download_mb: 2              # probe size / floor
max_download_mb: 256            # ceiling, 1–512
min_upload_mb: 1
max_upload_mb: 64               # ceiling, 1–128
report: true                    # push the result into the sensors below
```

### Which URL am I on?

This changes what the numbers mean, and the card cannot work it out alone: a
browser cannot resolve a hostname, so a public-looking name pointed at a private
address is indistinguishable from a genuinely remote one.

List the URLs you consider local in `internal_origins` and every run is labelled
`internal` or `external`. Without it, a private-address URL is labelled
`internal` and anything else is labelled **`unknown`** rather than guessed —
a wrong label is worse than an absent one.

An `external` run measures the whole path, including your reverse proxy, any CDN
in front of it, and the internet. That is a legitimate and useful thing to know;
it is just not the same measurement as the LAN one, so the card says so on screen.

## Entities

One device, four sensors:

| Entity | |
|---|---|
| `sensor.connection_test_latency` | Average round-trip in ms; min / max / p95 / jitter / sample count as attributes |
| `sensor.connection_test_download` | Mbit/s, with bytes, duration and stream count |
| `sensor.connection_test_upload` | Mbit/s, with bytes and duration |
| `sensor.connection_test_last_run` | Timestamp of the most recent run; a `clients` attribute holds the latest result **per device** |

<!-- prettier-ignore -->
> **They report the most recent run from any client.** Home Assistant state is
> per-instance, not per-browser, so a test on the phone overwrites one on the
> tablet — the same trade-off as any other shared helper. Every sensor carries
> the `client` that produced its current value, and the `clients` attribute on
> *Last run* keeps the latest figure for each device, which is enough to build a
> per-device table on a dashboard. What it cannot give you is per-device
> *history*: the recorder sees one mixed series.

The card reports results through the `connection_test.report` service, so a run
can also be recorded from a script or by hand from Developer Tools.

## Endpoints

All three require authentication and live under `/api/`:

| | |
|---|---|
| `GET /api/connection_test/echo` | Empty `204`, for HTTP round-trip time |
| `GET /api/connection_test/download?bytes=N` | `N` bytes of random data (`N` is clamped server-side, max 512 MiB) |
| `POST /api/connection_test/upload` | Counts and discards the body (max 128 MiB) |

The `/api/` prefix is load-bearing rather than cosmetic. The Home Assistant
frontend's service worker routes `/api/` **NetworkOnly**, while its catch-all
route caches everything else *StaleWhileRevalidate* — so the same file served
from `/local/` would come back out of Cache Storage at an imaginary speed on the
second run, and `cache: "no-store"` would not help, because that option controls
the HTTP cache and not the service worker.

## Behind a reverse proxy

Both are worth knowing before you trust a number:

- **Upload is timed by the client**, because nginx buffers request bodies by
  default (`proxy_request_buffering on`). By the time Home Assistant sees the
  request the bytes are already off the wire, so a server-side clock would time
  the proxy handing over a buffer. The server's byte count is still reported, as
  proof the data really arrived.
- **Your proxy's body limit caps the upload test.** nginx defaults to
  `client_max_body_size 1m`, which is far below anything worth measuring; raise
  it, or lower `max_upload_mb` to match. Cloudflare's free plan caps request
  bodies at 100 MB regardless.

If downloads look bursty rather than smooth, the proxy is buffering responses —
`proxy_buffering off` on the Home Assistant location fixes it. The download
endpoint also sends `X-Accel-Buffering: no`.

## Reading the results

- **Latency** is the one to look at first. Average tells you the floor; **jitter**
  — the mean difference between successive samples — is what makes a dashboard
  feel unreliable rather than merely slow, and a high p95 next to a low average
  means occasional stalls rather than a uniformly bad link.
- A **fine websocket latency next to a poor HTTP latency** (`http_latency_ms`)
  accuses the proxy or TLS setup, not the network.
- **Throughput is a floor, not a ceiling.** A single measurement over one path
  cannot see more than the narrowest link, and on an HTTP/2 or HTTP/3 connection
  the parallel streams are multiplexed over one TCP connection, so they add less
  than they would over HTTP/1.1.

## Development

```bash
pip install pytest pytest-asyncio ruff
ruff check . && pytest tests/ -v      # Python: pure maths + repo shape
node --test tests/test_card.js        # the card's maths and formatters
```

The card duplicates the server's arithmetic so it can show a result without
waiting for a service round-trip. The numeric fixtures in `tests/test_measure.py`
and `tests/test_card.js` are deliberately the same, so the two cannot drift into
showing one number and recording another — that pairing has already caught two
real bugs.

## Licence

MIT — see [LICENSE](LICENSE).
