/* Connection Test card for Home Assistant. */
const CARD_VERSION = "0.1.0"; // x-release-please-version

const CARD_TAG = "connection-test-card";
const DOMAIN = "connection_test";
const DOCS_URL = "https://github.com/johnbr/ha-connection-test";
const STYLE_CLASS = "ct-card-style";
const CLIENT_ID_KEY = "connection-test-client-id";

const API_ECHO = "/api/connection_test/echo";
const API_DOWNLOAD = "/api/connection_test/download";
const API_UPLOAD = "/api/connection_test/upload";

/*
 * What this card measures, and why each phase is measured the way it is.
 *
 * LATENCY rides the websocket the dashboard already has open
 * (`connection.ping()` -> `pong`). That is the transport every state update
 * and every button press uses, so it is the number that actually describes
 * "does this dashboard feel responsive". It also costs nothing: no new
 * connection, no new authentication, no server work beyond echoing an id.
 *
 * THROUGHPUT deliberately does NOT use that socket. Home Assistant disconnects
 * a websocket client that falls MAX_PENDING_MSG (4096) messages behind, so
 * pushing bulk data through it risks kicking the dashboard offline in the
 * middle of the measurement. It uses plain HTTP against /api/ endpoints
 * instead -- and the /api/ prefix is load-bearing, not cosmetic: the Home
 * Assistant service worker's catch-all route caches everything else
 * StaleWhileRevalidate, which would serve a "download" straight out of Cache
 * Storage at an imaginary speed. `cache: "no-store"` does not save you there;
 * that option controls the HTTP cache, not the service worker.
 *
 * Structure follows the house pattern for hand-written cards:
 *   - plain HTMLElement + light DOM, zero imports, no build step
 *   - the stylesheet is injected INSIDE the card element, because Lovelace
 *     nests cards in shadow roots a document.head sheet cannot reach
 *   - THE SHELL IS BUILT ONCE. Home Assistant hands a card a new `hass` object
 *     on every state change of every entity; a card that re-renders on that
 *     rebuilds its DOM many times a second. Here it would also tear down the
 *     DOM holding a measurement that is still in flight. `set hass` stores the
 *     object and nothing else.
 *   - dynamic text is written with textContent, never innerHTML, so a device
 *     name coming back from the server can never be markup.
 */

/* ------------------------------------------------------------------ maths */
/*
 * These mirror `measure.py` on the server. The card needs them because it must
 * show a result immediately rather than waiting for a service round-trip; the
 * server recomputes from the raw samples and IS authoritative for what lands
 * in entity state. tests/test_card.js and tests/test_measure.py pin both
 * copies to the same expectations.
 */

const BITS_PER_BYTE = 8;
const MEGABIT = 1000000;

/** Throughput in Mbit/s: decimal megabits, as every speed test and ISP uses. */
function mbitsPerSecond(byteCount, seconds) {
  const size = Number(byteCount);
  const duration = Number(seconds);
  if (!Number.isFinite(size) || !Number.isFinite(duration) || size <= 0 || duration <= 0) return null;
  return Math.round(((size * BITS_PER_BYTE) / duration / MEGABIT) * 100) / 100;
}

/** Nearest-rank percentile — no interpolation, see measure.py. */
function percentile(values, fraction) {
  if (!values || !values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * ordered.length));
  return ordered[Math.min(rank, ordered.length) - 1];
}

function round2(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

/**
 * Reduce raw round-trip samples (ms) to the figures shown.
 *
 * `jitter` is the mean absolute difference between successive samples, in
 * sample order — the shape RFC 3550 uses, and a much better answer to "does
 * this feel laggy" than a standard deviation, which one outlier dominates.
 */
function summariseLatency(samples) {
  // Number(null) is 0 and Number("") is 0, both of which would pass a
  // finite-and-positive filter and read as an impossibly fast round trip.
  // The server drops them (float(None) raises), so this must too.
  const clean = (samples || [])
    .map((value) => (value === null || value === undefined || value === "" ? NaN : Number(value)))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length) {
    return { count: 0, min: null, avg: null, max: null, p95: null, jitter: null };
  }
  let jitter = null;
  if (clean.length >= 2) {
    let total = 0;
    for (let i = 1; i < clean.length; i++) total += Math.abs(clean[i] - clean[i - 1]);
    jitter = round2(total / (clean.length - 1));
  }
  return {
    count: clean.length,
    min: round2(Math.min(...clean)),
    avg: round2(clean.reduce((a, b) => a + b, 0) / clean.length),
    max: round2(Math.max(...clean)),
    p95: round2(percentile(clean, 0.95)),
    jitter,
  };
}

/**
 * Pick a payload size from a probe, aiming for `targetSeconds` of transfer.
 *
 * Sizing matters more than it looks. A fixed size is wrong at both ends: on a
 * 2.5 GbE LAN a 4 MB download finishes inside TCP slow-start and measures the
 * ramp rather than the link, while on poor cellular the same run in reverse
 * would take minutes. So probe first, then size the real run from what the
 * probe saw.
 */
function nextSize(observedMbps, targetSeconds, minBytes, maxBytes) {
  if (!Number.isFinite(observedMbps) || observedMbps <= 0) return minBytes;
  const bytes = Math.round((observedMbps * MEGABIT * targetSeconds) / BITS_PER_BYTE);
  return Math.max(minBytes, Math.min(bytes, maxBytes));
}

/* ------------------------------------------------------------- client id */

function hostOf(origin) {
  const match = /^[a-z]+:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(String(origin || ""));
  if (!match) return String(origin || "").toLowerCase();
  return match[1].replace(/^\[|\]$/g, "").toLowerCase();
}

/** Hosts that are knowably on the local network from inside a browser. */
function isPrivateHost(host) {
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Unique-local and link-local IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  return false;
}

/**
 * Decide whether this run went over the LAN or in from outside.
 *
 * A browser cannot resolve a hostname, so a name that happens to point at a
 * private address is indistinguishable from a public one. `internal_origins`
 * in the card config is therefore the only way to be certain; without it this
 * reports "unknown" rather than guessing, because the distinction changes what
 * the numbers mean and a wrong label is worse than an absent one.
 */
function classifyPath(origin, internalOrigins) {
  const normalise = (value) =>
    String(value || "")
      .replace(/\/+$/, "")
      .toLowerCase();
  const configured = (internalOrigins || []).map(normalise).filter(Boolean);
  const current = normalise(origin);
  if (configured.length) return configured.includes(current) ? "internal" : "external";
  return isPrivateHost(hostOf(current)) ? "internal" : "unknown";
}

/**
 * Which kind of client this is.
 *
 * Both Companion apps inject a bridge into the WebView they render dashboards
 * in — `externalApp` on Android, a `webkit.messageHandlers.externalBus`
 * handler on iOS — and those are the only reliable signals; a user agent
 * string is not, because the app's WebView reports the system browser's.
 */
function detectPlatform(win) {
  if (!win) return "unknown";
  if (win.externalApp) return "android_app";
  if (win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.externalBus) return "ios_app";
  if (win.document) return "browser";
  return "unknown";
}

/** A readable default name, so a device is identifiable before anyone names it. */
function defaultClientName(win) {
  const platform = detectPlatform(win);
  const ua = (win && win.navigator && win.navigator.userAgent) || "";
  if (platform === "android_app") {
    const model = /Android [\d.]+; ([^);]+)/.exec(ua);
    return model ? `${model[1].trim()} (Android app)` : "Android app";
  }
  if (platform === "ios_app") {
    if (/iPad/.test(ua)) return "iPad app";
    return "iPhone app";
  }
  for (const [pattern, name] of [
    [/Edg\//, "Edge"],
    [/OPR\//, "Opera"],
    [/Firefox\//, "Firefox"],
    [/Chrome\//, "Chrome"],
    [/Safari\//, "Safari"],
  ]) {
    if (pattern.test(ua)) return `${name} browser`;
  }
  return "Browser";
}

/**
 * A stable per-device id.
 *
 * localStorage can be unavailable — private browsing, or a WebView with
 * storage disabled — and that is not fatal: the run still measures correctly,
 * it just forks a new row per page load. Reporting that honestly beats
 * throwing, and beats silently reusing an id across devices.
 */
function clientId(win) {
  const fresh = () =>
    win && win.crypto && win.crypto.randomUUID
      ? win.crypto.randomUUID()
      : `ct-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  try {
    const existing = win.localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const created = fresh();
    win.localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch (err) {
    if (!win.__connectionTestClientId) win.__connectionTestClientId = fresh();
    return win.__connectionTestClientId;
  }
}

/* -------------------------------------------------------------- formatting */

function fmtRate(mbps) {
  if (mbps === null || mbps === undefined || !Number.isFinite(Number(mbps))) return "—";
  const value = Number(mbps);
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function fmtMs(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  return number >= 100 ? number.toFixed(0) : number.toFixed(1);
}

/** Binary units here — this is an amount of data moved, not a rate. */
function fmtBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled >= 10 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

/* ----------------------------------------------------------------- config */

const DEFAULTS = {
  title: "Connection Test",
  ping_count: 20,
  target_seconds: 4,
  download_streams: 4,
  min_download_mb: 2,
  max_download_mb: 256,
  min_upload_mb: 1,
  max_upload_mb: 64,
  report: true,
  internal_origins: [],
  client_name: "",
};

const MB = 1024 * 1024;

function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config || {}) };
  const clampInt = (value, fallback, min, max) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(min, Math.min(number, max)) : fallback;
  };
  merged.ping_count = clampInt(merged.ping_count, DEFAULTS.ping_count, 3, 100);
  merged.target_seconds = clampInt(merged.target_seconds, DEFAULTS.target_seconds, 1, 20);
  merged.download_streams = clampInt(merged.download_streams, DEFAULTS.download_streams, 1, 8);
  merged.max_download_mb = clampInt(merged.max_download_mb, DEFAULTS.max_download_mb, 1, 512);
  merged.max_upload_mb = clampInt(merged.max_upload_mb, DEFAULTS.max_upload_mb, 1, 128);
  merged.internal_origins = Array.isArray(merged.internal_origins) ? merged.internal_origins : [];
  return merged;
}

/* ------------------------------------------------------------ measurement */

/**
 * Round-trip time over the websocket.
 *
 * The first samples are discarded: the very first ping after an idle period
 * pays for whatever the connection had to wake up, which is real but is not
 * the steady-state latency the rest of the dashboard experiences.
 */
async function measureLatency(hass, count, signal, onSample) {
  const warmup = 2;
  const samples = [];
  for (let i = 0; i < count + warmup; i++) {
    if (signal.aborted) break;
    const started = performance.now();
    await hass.connection.ping();
    const elapsed = performance.now() - started;
    if (i >= warmup) {
      samples.push(elapsed);
      if (onSample) onSample(samples);
    }
  }
  return samples;
}

function authHeaders(hass) {
  const token = hass && hass.auth && hass.auth.accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function measureHttpLatency(hass, signal) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    if (signal.aborted) break;
    const started = performance.now();
    const response = await fetch(`${API_ECHO}?t=${Date.now()}-${i}`, {
      cache: "no-store",
      headers: authHeaders(hass),
      signal,
    });
    if (!response.ok && response.status !== 204) throw new Error(`echo returned HTTP ${response.status}`);
    samples.push(performance.now() - started);
  }
  return percentile(samples, 0.5);
}

/** Drain one download stream, reporting progress as it goes. */
async function drain(response, onChunk) {
  let received = 0;
  if (response.body && response.body.getReader) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (onChunk) onChunk(value.length);
    }
    return received;
  }
  // Older WebViews expose no response stream. No progress, same total.
  const buffer = await response.arrayBuffer();
  received = buffer.byteLength;
  if (onChunk) onChunk(received);
  return received;
}

async function measureDownload(hass, bytes, streams, signal, onProgress) {
  const perStream = Math.max(1, Math.floor(bytes / streams));
  const started = performance.now();
  const totals = await Promise.all(
    Array.from({ length: streams }, async (_, index) => {
      const url = `${API_DOWNLOAD}?bytes=${perStream}&s=${index}&t=${Date.now()}`;
      const response = await fetch(url, { cache: "no-store", headers: authHeaders(hass), signal });
      if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
      return drain(response, onProgress);
    })
  );
  const seconds = (performance.now() - started) / 1000;
  return { bytes: totals.reduce((a, b) => a + b, 0), seconds, streams };
}

/**
 * Build an upload body.
 *
 * `crypto.getRandomValues` refuses more than 65536 bytes in one call, so the
 * buffer is tiled from a handful of random blocks rather than filled in one
 * go. Tiling is fine here: request bodies are not compressed by browsers, and
 * a handful of distinct blocks defeats anything that would try.
 */
function makeUploadBody(bytes, cryptoImpl) {
  const body = new Uint8Array(bytes);
  const blockSize = Math.min(65536, bytes);
  const block = new Uint8Array(blockSize);
  for (let offset = 0; offset < bytes; offset += blockSize) {
    if (offset % (blockSize * 8) === 0 && cryptoImpl && cryptoImpl.getRandomValues) {
      cryptoImpl.getRandomValues(block);
    }
    body.set(block.subarray(0, Math.min(blockSize, bytes - offset)), offset);
  }
  return body;
}

async function measureUpload(hass, bytes, signal) {
  const body = makeUploadBody(bytes, typeof crypto !== "undefined" ? crypto : null);
  const started = performance.now();
  const response = await fetch(`${API_UPLOAD}?t=${Date.now()}`, {
    method: "POST",
    cache: "no-store",
    headers: { ...authHeaders(hass), "Content-Type": "application/octet-stream" },
    body,
    signal,
  });
  const seconds = (performance.now() - started) / 1000;
  if (!response.ok) throw new Error(`upload returned HTTP ${response.status}`);
  const result = await response.json().catch(() => ({}));
  // The server's byte count is the honest half. It does not time the upload:
  // nginx buffers request bodies by default, so by the time the handler runs
  // the bytes are already off the wire. The clock has to live here.
  return { bytes: Number(result.bytes) || body.length, seconds };
}

/* -------------------------------------------------------------------- CSS */

const CARD_CSS = `
  .ct-root { padding: 16px; }
  .ct-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .ct-title { font-size: 1.1rem; font-weight: 500; color: var(--primary-text-color); }
  .ct-context { font-size: 0.75rem; color: var(--secondary-text-color); word-break: break-all; }
  .ct-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
    margin: 14px 0 10px;
  }
  .ct-metric {
    background: var(--ha-card-background, var(--card-background-color));
    border: 1px solid var(--divider-color);
    border-radius: 10px;
    padding: 10px 12px;
    min-width: 0;
  }
  .ct-label { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--secondary-text-color); }
  .ct-value { font-size: 1.6rem; font-weight: 700; color: var(--primary-text-color); line-height: 1.2; }
  .ct-unit { font-size: 0.8rem; color: var(--secondary-text-color); margin-left: 3px; }
  .ct-detail { font-size: 0.72rem; color: var(--secondary-text-color); margin-top: 2px; min-height: 1em; }
  .ct-track { height: 4px; border-radius: 2px; background: var(--divider-color); overflow: hidden; }
  .ct-bar { height: 100%; width: 0%; background: var(--primary-color); transition: width 0.2s linear; }
  .ct-status { font-size: 0.8rem; color: var(--secondary-text-color); margin: 8px 0 12px; min-height: 1.2em; }
  .ct-status[data-tone="error"] { color: var(--error-color); }
  .ct-status[data-tone="ok"] { color: var(--success-color); }
  .ct-actions { display: flex; gap: 8px; }
  .ct-btn {
    font: inherit; font-weight: 500; cursor: pointer;
    border-radius: 8px; padding: 9px 16px;
    border: 1px solid var(--primary-color);
    background: var(--primary-color); color: var(--text-primary-color, #fff);
  }
  .ct-btn.ct-secondary { background: transparent; color: var(--primary-color); }
  .ct-btn[disabled] { opacity: 0.5; cursor: default; }
  .ct-warn { font-size: 0.72rem; color: var(--warning-color); margin-bottom: 8px; }
  .ct-warn[hidden] { display: none; }
`;

/* ------------------------------------------------------------------- card */

class ConnectionTestCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = resolveConfig({});
    this._shellBuilt = false;
    this._abort = null;
    this._nodes = {};
  }

  setConfig(config) {
    this._config = resolveConfig(config);
    // The shell is rebuilt only here — never on a hass update.
    this._shellBuilt = false;
    this.innerHTML = "";
    this._render();
  }

  /*
   * Home Assistant pushes a new hass object on every state change of every
   * entity. Storing it is all that happens: re-rendering here would rebuild
   * the DOM many times a second and tear down a measurement in flight.
   */
  set hass(hass) {
    this._hass = hass;
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 4;
  }

  static getStubConfig() {
    return { type: `custom:${CARD_TAG}` };
  }

  _render() {
    if (this._shellBuilt) return;

    const card = document.createElement("ha-card");
    const style = document.createElement("style");
    style.className = STYLE_CLASS;
    style.textContent = CARD_CSS;
    card.appendChild(style);

    const root = document.createElement("div");
    root.className = "ct-root";
    root.innerHTML = `
      <div class="ct-head">
        <div class="ct-title"></div>
        <div class="ct-context"></div>
      </div>
      <div class="ct-warn" hidden></div>
      <div class="ct-grid">
        <div class="ct-metric">
          <span class="ct-label">Latency</span>
          <span class="ct-value" data-field="latency">—</span><span class="ct-unit">ms</span>
          <div class="ct-detail" data-field="latency-detail"></div>
        </div>
        <div class="ct-metric">
          <span class="ct-label">Download</span>
          <span class="ct-value" data-field="download">—</span><span class="ct-unit">Mbit/s</span>
          <div class="ct-detail" data-field="download-detail"></div>
        </div>
        <div class="ct-metric">
          <span class="ct-label">Upload</span>
          <span class="ct-value" data-field="upload">—</span><span class="ct-unit">Mbit/s</span>
          <div class="ct-detail" data-field="upload-detail"></div>
        </div>
      </div>
      <div class="ct-track"><div class="ct-bar"></div></div>
      <div class="ct-status">Ready.</div>
      <div class="ct-actions">
        <button class="ct-btn" data-action="run">Test connection</button>
        <button class="ct-btn ct-secondary" data-action="cancel" hidden>Cancel</button>
      </div>
    `;
    card.appendChild(root);
    this.appendChild(card);

    this._nodes = {
      title: root.querySelector(".ct-title"),
      context: root.querySelector(".ct-context"),
      warn: root.querySelector(".ct-warn"),
      bar: root.querySelector(".ct-bar"),
      status: root.querySelector(".ct-status"),
      run: root.querySelector('[data-action="run"]'),
      cancel: root.querySelector('[data-action="cancel"]'),
      latency: root.querySelector('[data-field="latency"]'),
      latencyDetail: root.querySelector('[data-field="latency-detail"]'),
      download: root.querySelector('[data-field="download"]'),
      downloadDetail: root.querySelector('[data-field="download-detail"]'),
      upload: root.querySelector('[data-field="upload"]'),
      uploadDetail: root.querySelector('[data-field="upload-detail"]'),
    };

    this._nodes.title.textContent = this._config.title;

    // One delegated listener, attached once: per-element handlers would be
    // orphaned by any future innerHTML replacement.
    root.addEventListener("click", (event) => {
      const action = event.target && event.target.closest && event.target.closest("[data-action]");
      if (!action) return;
      if (action.dataset.action === "run") this._run();
      if (action.dataset.action === "cancel") this._cancel();
    });

    this._shellBuilt = true;
    this._paintContext();
  }

  _paintContext() {
    const origin = (typeof window !== "undefined" && window.location && window.location.origin) || "";
    const path = classifyPath(origin, this._config.internal_origins);
    const name = this._config.client_name || defaultClientName(window);
    this._nodes.context.textContent = `${name} · ${origin || "unknown origin"}`;

    if (path === "external") {
      this._nodes.warn.textContent =
        "Measuring the external URL: these figures include the internet leg and anything in front of Home Assistant.";
      this._nodes.warn.hidden = false;
    } else if (path === "unknown") {
      this._nodes.warn.textContent =
        "Cannot tell whether this URL is local or remote. Set internal_origins on the card to label runs.";
      this._nodes.warn.hidden = false;
    } else {
      this._nodes.warn.hidden = true;
    }
    return { origin, path, name };
  }

  _status(text, tone) {
    this._nodes.status.textContent = text;
    if (tone) this._nodes.status.dataset.tone = tone;
    else delete this._nodes.status.dataset.tone;
  }

  _progress(fraction) {
    this._nodes.bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  _busy(isBusy) {
    this._nodes.run.disabled = isBusy;
    this._nodes.cancel.hidden = !isBusy;
  }

  _cancel() {
    if (this._abort) this._abort.abort();
  }

  async _run() {
    if (this._abort) return;
    const hass = this._hass;
    if (!hass || !hass.connection) {
      this._status("Home Assistant connection not ready.", "error");
      return;
    }

    const config = this._config;
    const context = this._paintContext();
    const controller = new AbortController();
    this._abort = controller;
    this._busy(true);
    this._progress(0);

    for (const key of ["latency", "download", "upload"]) {
      this._nodes[key].textContent = "—";
      this._nodes[`${key}Detail`].textContent = "";
    }

    try {
      /* ---- latency (websocket) ---- */
      this._status("Measuring latency…");
      const samples = await measureLatency(hass, config.ping_count, controller.signal, (taken) => {
        this._progress((taken.length / config.ping_count) * 0.2);
        const running = summariseLatency(taken);
        this._nodes.latency.textContent = fmtMs(running.avg);
      });
      const latency = summariseLatency(samples);
      this._nodes.latency.textContent = fmtMs(latency.avg);
      this._nodes.latencyDetail.textContent = `min ${fmtMs(latency.min)} · p95 ${fmtMs(latency.p95)} · jitter ${fmtMs(latency.jitter)}`;

      const httpLatency = await measureHttpLatency(hass, controller.signal);

      /* ---- download ---- */
      this._status("Measuring download…");
      const minDown = config.min_download_mb * MB;
      const maxDown = config.max_download_mb * MB;
      // The probe doubles as connection warm-up: it opens (and TLS-handshakes)
      // the sockets the measured run then reuses via keep-alive, so setup cost
      // is not billed to the throughput figure.
      const probe = await measureDownload(hass, minDown, 1, controller.signal, null);
      const downloadSize = nextSize(mbitsPerSecond(probe.bytes, probe.seconds), config.target_seconds, minDown, maxDown);

      let downloaded = 0;
      const download = await measureDownload(
        hass,
        downloadSize,
        config.download_streams,
        controller.signal,
        (chunk) => {
          downloaded += chunk;
          this._progress(0.2 + (downloaded / downloadSize) * 0.45);
        }
      );
      const downloadMbps = mbitsPerSecond(download.bytes, download.seconds);
      this._nodes.download.textContent = fmtRate(downloadMbps);
      this._nodes.downloadDetail.textContent = `${fmtBytes(download.bytes)} in ${download.seconds.toFixed(1)}s · ${download.streams} streams`;

      /* ---- upload ---- */
      this._status("Measuring upload…");
      const minUp = config.min_upload_mb * MB;
      const maxUp = config.max_upload_mb * MB;
      const upProbe = await measureUpload(hass, minUp, controller.signal);
      const uploadSize = nextSize(mbitsPerSecond(upProbe.bytes, upProbe.seconds), config.target_seconds, minUp, maxUp);
      this._progress(0.75);
      const upload = await measureUpload(hass, uploadSize, controller.signal);
      const uploadMbps = mbitsPerSecond(upload.bytes, upload.seconds);
      this._nodes.upload.textContent = fmtRate(uploadMbps);
      this._nodes.uploadDetail.textContent = `${fmtBytes(upload.bytes)} in ${upload.seconds.toFixed(1)}s`;
      this._progress(1);

      /* ---- report ---- */
      if (config.report) {
        await hass.callService(DOMAIN, "report", {
          client_id: clientId(window),
          client_name: context.name,
          platform: detectPlatform(window),
          origin: context.origin,
          path: context.path,
          user: (hass.user && hass.user.name) || "",
          user_agent: (window.navigator && window.navigator.userAgent) || "",
          latency_samples_ms: samples.map((value) => Math.round(value * 100) / 100),
          http_latency_ms: httpLatency,
          download_bytes: download.bytes,
          download_seconds: download.seconds,
          download_streams: download.streams,
          upload_bytes: upload.bytes,
          upload_seconds: upload.seconds,
        });
      }
      this._status("Done.", "ok");
    } catch (err) {
      if (err && err.name === "AbortError") {
        this._status("Cancelled.");
      } else {
        this._status(`Failed: ${(err && err.message) || err}`, "error");
      }
      this._progress(0);
    } finally {
      this._abort = null;
      this._busy(false);
    }
  }
}

if (typeof customElements !== "undefined") {
  customElements.define(CARD_TAG, ConnectionTestCard);

  window.customCards = window.customCards || [];
  if (!window.customCards.find((entry) => entry.type === CARD_TAG)) {
    window.customCards.push({
      type: CARD_TAG,
      name: "Connection Test",
      description: "Measure latency and throughput between this device and Home Assistant.",
      preview: true,
      documentationURL: DOCS_URL,
    });
  }

  console.info(`%c CONNECTION-TEST-CARD %c ${CARD_VERSION} `, "color:white;background:#03a9f4", "");
}

// Test-only surface. `typeof module` is undefined in a browser ES module, so
// this is inert in production.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CARD_VERSION,
    mbitsPerSecond,
    percentile,
    summariseLatency,
    nextSize,
    hostOf,
    isPrivateHost,
    classifyPath,
    detectPlatform,
    defaultClientName,
    clientId,
    fmtRate,
    fmtMs,
    fmtBytes,
    resolveConfig,
    makeUploadBody,
    DEFAULTS,
  };
}
