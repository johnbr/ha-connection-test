/* Connection Test card for Home Assistant. */
const CARD_VERSION = "0.1.0"; // x-release-please-version

const CARD_TAG = "connection-test-card";
const DOMAIN = "connection_test";
const DOCS_URL = "https://github.com/johnbr/ha-connection-test";
const STYLE_CLASS = "ct-card-style";
const CLIENT_ID_KEY = "connection-test-client-id";
const CLIENT_NAME_KEY = "connection-test-client-name";

const API_ECHO = "/api/connection_test/echo";
const API_INFO = "/api/connection_test/info";
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
  const configured = (internalOrigins || []).map(normaliseOrigin).filter(Boolean);
  const current = normaliseOrigin(origin);
  if (configured.length) return configured.includes(current) ? "internal" : "external";
  return isPrivateHost(hostOf(current)) ? "internal" : "unknown";
}

/* --------------------------------------------------------------- targeting */

/** One spelling of an origin, so two of them can be compared. */
function normaliseOrigin(value) {
  return String(value || "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** The origin this dashboard was loaded from, "" where there is no window. */
function pageOriginOf(win) {
  return (win && win.location && win.location.origin) || "";
}

/**
 * The URL to offer as "measure the internet path instead".
 *
 * Configured `external_origin` first, because a page loaded from a LAN URL has
 * no other way to name it. Failing that, the page's own origin serves when the
 * page itself came in from outside -- which is the case where a run was
 * switched onto the LAN and the user wants the original path back.
 */
function externalTarget(pageOrigin, config) {
  const configured = normaliseOrigin(config && config.external_origin);
  if (configured) return configured;
  const current = normaliseOrigin(pageOrigin);
  return classifyPath(current, (config && config.internal_origins) || []) === "internal" ? "" : current;
}

/**
 * Which internal URLs are worth trying before this run starts?
 *
 * THE POINT OF THIS IS TO MEASURE THE PATH THE COMPANION APP WOULD USE, not
 * the one the dashboard happens to have been loaded from. The app switches
 * between an internal and an external URL by SSID; a browser tab does not, so
 * a phone sitting on the house Wi-Fi with the public URL open sends every
 * request out to the internet and back, and the card then reports that round
 * trip as if it were the connection to Home Assistant.
 *
 * The switch only ever runs one way. A page already loaded from an internal
 * origin is on the LAN by construction -- the page could not have loaded
 * otherwise -- so there is nothing to probe and nothing to gain. The reverse,
 * an external page that can also reach the LAN, is the case worth catching.
 */
function internalCandidates(pageOrigin, config) {
  if (!config || config.prefer_internal === false) return [];
  const configured = (config.internal_origins || []).map(normaliseOrigin).filter(Boolean);
  if (!configured.length) return [];
  const current = normaliseOrigin(pageOrigin);
  if (configured.includes(current)) return [];
  return configured;
}

/**
 * An AbortSignal that gives up on its own after `ms`, and follows `outer`.
 *
 * `AbortSignal.any`/`AbortSignal.timeout` would be the modern spelling; this
 * card runs in Companion WebViews old enough not to have either, and a probe
 * that throws a TypeError on an old phone would silently disable the feature
 * on exactly the devices most likely to need it.
 */
function deadlineSignal(outer, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const relay = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", relay, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      if (outer && outer.removeEventListener) outer.removeEventListener("abort", relay);
    },
  };
}

/**
 * Can this device open a connection to `origin` at all?
 *
 * `mode: "no-cors"` is what makes this answerable. The reply is opaque -- no
 * status, no body, and the Authorization header is dropped before it is sent,
 * so Home Assistant answers 401 -- but the promise still RESOLVES, and that
 * resolution is the whole signal: TCP connected, TLS verified, HTTP answered.
 * A CORS-enabled request cannot separate "the host is not there" from "the
 * host is there and did not allow you to read it", and those two need
 * different advice.
 */
async function probeReachable(origin, outerSignal, timeoutMs) {
  const deadline = deadlineSignal(outerSignal, timeoutMs);
  try {
    await fetch(`${origin}${API_ECHO}?probe=${Date.now()}`, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal: deadline.signal,
    });
    return true;
  } catch (err) {
    return false;
  } finally {
    deadline.done();
  }
}

/**
 * Reachable is not enough: the run also has to be able to READ the answers.
 *
 * A cross-origin measurement needs `cors_allowed_origins` in Home Assistant's
 * `http:` config to name the origin the dashboard is loaded from, and some
 * browsers additionally gate a public page reaching a private address behind
 * a permission. Both fail the same way from here, so this is checked
 * separately from reachability and reported as its own sentence -- the fix is
 * a line of configuration, and a card that silently fell back to the slow path
 * would never say so.
 */
async function probeUsable(origin, hass, outerSignal, timeoutMs) {
  const deadline = deadlineSignal(outerSignal, timeoutMs);
  try {
    const response = await fetch(`${origin}${API_ECHO}?probe=${Date.now()}`, {
      cache: "no-store",
      headers: authHeaders(hass),
      signal: deadline.signal,
    });
    return response.ok || response.status === 204;
  } catch (err) {
    return false;
  } finally {
    deadline.done();
  }
}

/**
 * Which kind of client this is.
 *
 * Both Companion apps inject a bridge into the WebView they render dashboards
 * in — `externalApp` on Android, a `webkit.messageHandlers.externalBus`
 * handler on iOS — and those are the primary signals. The user-agent check is
 * a backstop: both apps append their own token to the WebView's user agent, so
 * an app whose bridge has not been installed yet (it appears after the page
 * has begun loading) is still recognised rather than reported as a browser.
 */
function detectPlatform(win) {
  if (!win) return "unknown";
  if (win.externalApp) return "android_app";
  if (win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.externalBus) return "ios_app";
  const ua = (win.navigator && win.navigator.userAgent) || "";
  if (/Home\s?Assistant\//i.test(ua)) return /iPhone|iPad|iPod|Macintosh/.test(ua) ? "ios_app" : "android_app";
  if (win.document) return "browser";
  return "unknown";
}

/**
 * Ask Chromium for the details it keeps out of the user-agent string.
 *
 * THIS IS THE ONLY WAY TO LEARN AN ANDROID DEVICE'S MODEL from a modern
 * browser. Chrome's user-agent reduction replaced the model with the literal
 * "K" and froze the Android version at "10", so every Pixel, Galaxy and tablet
 * on the network parses out of the user agent as the same non-device — which
 * is exactly why two different devices here were both reporting themselves as
 * plain "Chrome browser". `getHighEntropyValues` returns the real model.
 *
 * It is Chromium-only and async, and it resolves to null everywhere else
 * (Safari, Firefox), which is why the user-agent parser below still exists as
 * a fallback rather than being replaced by this.
 */
async function highEntropyHints(win) {
  const data = win && win.navigator && win.navigator.userAgentData;
  if (!data || typeof data.getHighEntropyValues !== "function") return null;
  try {
    const hints = await data.getHighEntropyValues(["platform", "platformVersion", "model", "architecture"]);
    return { ...hints, mobile: data.mobile, brands: data.brands };
  } catch (err) {
    // Rejects in some embedded WebViews. Not worth surfacing: the user-agent
    // fallback covers it, just less precisely.
    return null;
  }
}

/** Strip the values Chrome's user-agent reduction substitutes for real ones. */
function realModel(value) {
  const model = String(value || "").trim();
  if (!model || model === "K" || /^Android$/i.test(model)) return "";
  // WebViews append the build fingerprint to the model.
  return model.replace(/\s+Build\/.*$/i, "").trim();
}

function parseUserAgent(ua, win) {
  const text = String(ua || "");
  const touch = (win && win.navigator && win.navigator.maxTouchPoints) || 0;
  let os = "";
  let model = "";
  let formFactor = "desktop";

  let match;
  if ((match = /Android\s+([\d.]+)/.exec(text))) {
    os = `Android ${match[1]}`;
    const device = /Android\s+[\d.]+;\s*([^;)]+)/.exec(text);
    model = realModel(device && device[1]);
    // Chrome marks phones with a "Mobile" token and omits it for tablets.
    formFactor = /\bMobile\b/.test(text) ? "phone" : "tablet";
  } else if ((match = /(?:iPhone|CPU) OS ([\d_]+)/.exec(text)) && /iPhone|iPad|iPod/.test(text)) {
    os = `iOS ${match[1].replace(/_/g, ".")}`;
    model = /iPad/.test(text) ? "iPad" : "iPhone";
    formFactor = /iPad/.test(text) ? "tablet" : "phone";
  } else if (/Macintosh/.test(text)) {
    // iPadOS Safari asks for desktop pages and calls itself a Mac. A Mac has
    // no touchscreen, so the touch-point count separates them.
    if (touch > 1) {
      os = "iPadOS";
      model = "iPad";
      formFactor = "tablet";
    } else {
      match = /Mac OS X ([\d_]+)/.exec(text);
      os = match ? `macOS ${match[1].replace(/_/g, ".")}` : "macOS";
      model = "Mac";
    }
  } else if (/CrOS/.test(text)) {
    os = "ChromeOS";
  } else if ((match = /Windows NT ([\d.]+)/.exec(text))) {
    // 10.0 covers both Windows 10 and 11; the user agent cannot tell them
    // apart, and claiming one of them would be a coin flip.
    os = match[1] === "10.0" ? "Windows 10/11" : `Windows NT ${match[1]}`;
  } else if (/Linux|X11/.test(text)) {
    os = "Linux";
  }

  return { os, model, formFactor };
}

function parseBrowser(ua, hints) {
  const brands = (hints && hints.brands) || [];
  // Chromium sends a deliberately absurd padding brand ("Not)A;Brand") to stop
  // anyone matching the list exactly. Drop it, and prefer a named browser over
  // the generic Chromium entry that always accompanies it.
  const named = brands
    .filter((entry) => entry && entry.brand && !/not.{0,2}a.{0,2}brand/i.test(entry.brand))
    .sort((a, b) => (/chromium/i.test(a.brand) ? 1 : 0) - (/chromium/i.test(b.brand) ? 1 : 0));
  if (named.length) {
    const major = String(named[0].version || "").split(".")[0];
    return major ? `${named[0].brand} ${major}` : named[0].brand;
  }
  const text = String(ua || "");
  for (const [pattern, name] of [
    [/Edg\/([\d.]+)/, "Edge"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/Firefox\/([\d.]+)/, "Firefox"],
    [/Chrome\/([\d.]+)/, "Chrome"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
  ]) {
    const found = pattern.exec(text);
    if (found) return `${name} ${String(found[1]).split(".")[0]}`;
  }
  return "";
}

/**
 * Everything the client can work out about itself.
 *
 * `hints` is the resolved value of highEntropyHints(), or null. Passing it in
 * rather than fetching it here keeps this function synchronous and pure, which
 * is what lets the tests drive it with a fabricated window.
 */
function describeDevice(win, hints) {
  const ua = (win && win.navigator && win.navigator.userAgent) || "";
  const parsed = parseUserAgent(ua, win);

  let os = parsed.os;
  let model = parsed.model;
  let formFactor = parsed.formFactor;

  if (hints) {
    if (hints.platform) {
      const version = String(hints.platformVersion || "").split(".")[0];
      os = version && version !== "0" ? `${hints.platform} ${version}` : hints.platform;
    }
    model = realModel(hints.model) || model;
    if (typeof hints.mobile === "boolean") {
      // `mobile` is a request for a mobile-formatted page, so it is true on
      // phones and false on tablets AND desktops. It can promote a device to
      // "phone" but never demote one — a tablet already identified as such
      // from the user agent must not become a desktop here.
      if (hints.mobile) formFactor = "phone";
      else if (formFactor === "phone") formFactor = "tablet";
    }
  }

  const platform = detectPlatform(win);
  if (platform === "ios_app" && !model) model = /iPad/.test(ua) ? "iPad" : "iPhone";

  const screen = win && win.screen ? `${win.screen.width}x${win.screen.height}@${win.devicePixelRatio || 1}` : "";

  return {
    os: os || "",
    model: model || "",
    browser: parseBrowser(ua, hints),
    form_factor: formFactor,
    screen,
    platform,
  };
}

/**
 * A readable default name, so a device is identifiable before anyone names it.
 *
 * The device comes first and the software second, because the question this
 * card answers is "which of my screens is slow" — "Pixel Tablet · Chrome",
 * not "Chrome, on something". When the model is unknown the OS and form factor
 * stand in for it, which is how a desktop becomes "Linux desktop" rather than
 * the "Chrome browser" that every machine in the house used to report.
 */
function deviceLabel(device) {
  const shape =
    { phone: "phone", tablet: "tablet", desktop: "desktop", watch: "watch" }[device.form_factor] || "device";
  const primary = device.model || (device.os ? `${device.os.replace(/\s+[\d.]+$/, "")} ${shape}` : `Unknown ${shape}`);
  const app = { android_app: "HA app", ios_app: "HA app" }[device.platform];
  const secondary = app || device.browser;
  return secondary ? `${primary} · ${secondary}` : primary;
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

/* ------------------------------------------------------------- the network */

/**
 * Whatever `navigator.connection` will tell us.
 *
 * Read defensively because this API is unevenly implemented: Chromium on
 * Android populates `type` ("wifi" / "cellular" / "ethernet"), desktop
 * Chromium omits `type` entirely and offers only the derived fields, and
 * Safari and Firefox do not implement it at all. Everything here is therefore
 * best-effort, and the raw values are reported alongside the verdict so a
 * surprising verdict can be traced to the evidence rather than argued with.
 */
function readNetwork(win) {
  const nav = (win && win.navigator) || {};
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (!conn) return { type: "", effectiveType: "", downlink: null, rtt: null, saveData: false };
  const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    type: String(conn.type || "").toLowerCase(),
    effectiveType: String(conn.effectiveType || "").toLowerCase(),
    // `downlink` and `rtt` are the browser's own coarse estimates from recent
    // traffic — heavily rounded, and not a substitute for the measurement this
    // card exists to take. Recorded as context, never shown as a result.
    downlink: numeric(conn.downlink),
    rtt: numeric(conn.rtt),
    saveData: Boolean(conn.saveData),
  };
}

/**
 * Fold "did it stay on the LAN" and "over what medium" into one word.
 *
 * MIRRORS classify_connection() IN measure.py — the server recomputes this
 * from the same inputs and is authoritative for what lands in entity state.
 * The card needs its own copy only to label the run on screen immediately.
 *
 * `remoteIsPrivate` comes from the server (see /api/connection_test/info): it
 * is the address Home Assistant actually saw the request arrive from, so the
 * local/remote half is observed rather than inferred. The medium half is the
 * browser's, and is often simply unavailable.
 *
 * `effectiveType` is deliberately ignored. It grades a link's behaviour
 * ("4g", "3g"), not its nature — congested Wi-Fi reports "3g" — so reading
 * cellular out of it would fabricate the one fact most worth trusting.
 */
function classifyConnection(networkType, remoteIsPrivate) {
  let medium = String(networkType || "").toLowerCase();
  if (["none", "unknown", "other", "mixed"].includes(medium)) medium = "";

  // Cellular is never local, whatever address the far end reports.
  if (medium === "cellular") return "cellular";

  const wired = medium === "ethernet" || medium === "wimax";
  if (remoteIsPrivate === true) {
    if (medium === "wifi") return "local_wifi";
    return wired ? "local_wired" : "local";
  }
  if (remoteIsPrivate === false) {
    if (medium === "wifi") return "wifi";
    return wired ? "ethernet" : "remote";
  }
  if (medium === "wifi") return "wifi";
  return wired ? "ethernet" : "unknown";
}

const CONNECTION_LABELS = {
  local_wifi: "Local Wi-Fi",
  local_wired: "Local wired",
  local: "Local network",
  // The parenthetical is the finding, not decoration: a device on the house
  // Wi-Fi loading the external URL lands here, and the round trip out to the
  // internet is the reason its numbers look nothing like the LAN's.
  wifi: "Wi-Fi · via internet",
  ethernet: "Wired · via internet",
  cellular: "Cellular",
  remote: "Remote",
  unknown: "Unknown network",
};

function connectionLabel(type) {
  return CONNECTION_LABELS[type] || CONNECTION_LABELS.unknown;
}

/**
 * A name for this device, chosen on this device.
 *
 * `client_name:` in the card config cannot do this job: one card configuration
 * is served to every screen in the house, so a name set there names all of
 * them at once. A per-device override has to live in per-device storage.
 */
function storedName(win) {
  try {
    return win.localStorage.getItem(CLIENT_NAME_KEY) || "";
  } catch (err) {
    return (win && win.__connectionTestClientName) || "";
  }
}

function setStoredName(win, name) {
  const value = String(name || "")
    .trim()
    .slice(0, 64);
  try {
    if (value) win.localStorage.setItem(CLIENT_NAME_KEY, value);
    else win.localStorage.removeItem(CLIENT_NAME_KEY);
  } catch (err) {
    win.__connectionTestClientName = value;
  }
  return value;
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
  // Eight seconds per direction. Long enough that TCP is well past slow-start
  // and a transient stall is averaged rather than measured, short enough that
  // nobody walks away from the card. The ceilings below, not this, are what
  // bound a run on a fast link: at 1 Gbit/s the sizing wants 1 GB and gets the
  // 512 MB cap instead, so the download finishes in about four seconds.
  target_seconds: 8,
  download_streams: 4,
  min_download_mb: 2,
  // Matches the server's own MAX_DOWNLOAD_BYTES; asking for more is clamped
  // server-side anyway, and the value the server reports from /info wins.
  max_download_mb: 512,
  min_upload_mb: 1,
  // The nginx default in front of Home Assistant is 128 MB and Cloudflare
  // refuses anything over 100 MB. /info reports the real ceiling for THIS
  // path, so this is only the ceiling on what may be asked for.
  max_upload_mb: 128,
  // Metered links get a smaller run. A full-size test is a few hundred
  // megabytes, which is not something to spend out of someone's data
  // allowance without saying so — the card labels a capped run as capped.
  // Raise it if you would rather have the accuracy than the allowance.
  cellular_max_mb: 64,
  report: true,
  internal_origins: [],
  // Measure the path the Companion app would use rather than the one this tab
  // happens to be open on -- see internalCandidates(). Inert unless
  // `internal_origins` is set, so it changes nothing for an install that has
  // not said where its LAN URLs are.
  prefer_internal: true,
  // The public URL, so a card loaded from the LAN can still offer to measure
  // the internet path. Only needed for that direction: a page already loaded
  // from outside can offer its own origin.
  external_origin: "",
  // How long to wait for an internal URL to answer before giving up on it.
  // A LAN round trip is single-digit milliseconds; this is sized for a phone
  // waking its radio, and it is also the cost added to every run made from
  // outside the house, where the probe can only ever time out.
  internal_probe_ms: 2000,
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
  merged.target_seconds = clampInt(merged.target_seconds, DEFAULTS.target_seconds, 1, 30);
  merged.download_streams = clampInt(merged.download_streams, DEFAULTS.download_streams, 1, 8);
  merged.max_download_mb = clampInt(merged.max_download_mb, DEFAULTS.max_download_mb, 1, 512);
  merged.max_upload_mb = clampInt(merged.max_upload_mb, DEFAULTS.max_upload_mb, 1, 128);
  merged.cellular_max_mb = clampInt(merged.cellular_max_mb, DEFAULTS.cellular_max_mb, 1, 512);
  merged.internal_origins = Array.isArray(merged.internal_origins) ? merged.internal_origins : [];
  merged.prefer_internal = merged.prefer_internal !== false;
  merged.external_origin = normaliseOrigin(merged.external_origin);
  merged.internal_probe_ms = clampInt(merged.internal_probe_ms, DEFAULTS.internal_probe_ms, 200, 10000);
  return merged;
}

/* ------------------------------------------------------------ measurement */

/**
 * A latency source: something that can be pinged, and closed when done.
 *
 * Normally this is the websocket the dashboard already has open, which is the
 * transport every state update and button press uses and therefore the number
 * that describes how responsive the dashboard feels.
 *
 * IT CANNOT BE, THOUGH, WHEN THE RUN IS MEASURING A DIFFERENT ORIGIN. That
 * socket is bound to the page, so pinging it while the transfers go over the
 * LAN would put a Cloudflare round trip next to LAN throughput and present the
 * pair as one result -- a number that is not wrong so much as not about
 * anything. A run against another origin therefore opens its own websocket
 * there, and says so if it cannot.
 */
function pagePinger(hass) {
  return {
    kind: "page",
    ping: () => hass.connection.ping(),
    close: () => {},
  };
}

/**
 * Open and authenticate a second websocket against `base`.
 *
 * Home Assistant's websocket API is a plain `auth_required` -> `auth` ->
 * `auth_ok` handshake carrying the same bearer token the HTTP calls use, and
 * `{type: "ping"}` -> `pong` is the same round trip `connection.ping()` makes.
 * The handshake is not subject to CORS -- a websocket upgrade never is -- so
 * this half works even where the HTTP half needs `cors_allowed_origins`.
 */
function openSocketPinger(base, hass, timeoutMs) {
  return new Promise((resolve, reject) => {
    const token = hass && hass.auth && hass.auth.accessToken;
    if (!token) {
      reject(new Error("no access token"));
      return;
    }
    let socket;
    try {
      socket = new WebSocket(`${base.replace(/^http/i, "ws")}/api/websocket`);
    } catch (err) {
      reject(err);
      return;
    }

    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timed out")), timeoutMs);

    const close = () => {
      try {
        socket.close();
      } catch (err) {
        /* already gone */
      }
    };
    // One exit for every failure path. A socket that dies mid-run must reject
    // the ping in flight, or the measurement loop waits for a pong that can
    // never arrive and the card sits on "Measuring latency..." forever.
    const fail = (err) => {
      for (const waiter of pending.values()) waiter.fail(err);
      pending.clear();
    };
    function finish(err) {
      clearTimeout(timer);
      fail(err);
      if (settled) return;
      settled = true;
      close();
      reject(err);
    }

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (message.type === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      }
      if (message.type === "auth_invalid") {
        finish(new Error("authentication rejected"));
        return;
      }
      if (message.type === "auth_ok" && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          kind: "direct",
          ping: () =>
            new Promise((ok, bad) => {
              const id = nextId++;
              // Per-ping deadline as well as the socket-level one: a link that
              // stops answering without closing is exactly the fault this card
              // is for, and it must show up as a failed run, not a hang.
              const ping_timer = setTimeout(() => {
                pending.delete(id);
                bad(new Error("ping timed out"));
              }, timeoutMs);
              pending.set(id, {
                ok: () => {
                  clearTimeout(ping_timer);
                  ok();
                },
                fail: (err) => {
                  clearTimeout(ping_timer);
                  bad(err);
                },
              });
              socket.send(JSON.stringify({ id, type: "ping" }));
            }),
          close,
        });
        return;
      }
      if (message.type === "pong") {
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          waiter.ok();
        }
      }
    });

    socket.addEventListener("error", () => finish(new Error("websocket error")));
    socket.addEventListener("close", () => finish(new Error("websocket closed")));
  });
}

/**
 * Round-trip time over the websocket.
 *
 * The first samples are discarded: the very first ping after an idle period
 * pays for whatever the connection had to wake up, which is real but is not
 * the steady-state latency the rest of the dashboard experiences.
 */
async function measureLatency(pinger, count, signal, onSample) {
  const warmup = 2;
  const samples = [];
  for (let i = 0; i < count + warmup; i++) {
    if (signal.aborted) break;
    const started = performance.now();
    await pinger.ping();
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

/**
 * Ask the server what it can see about this client.
 *
 * The two things it returns are things a browser cannot determine for itself:
 * the address the request arrived from, and how large a body this path will
 * carry. Both are treated as advisory — a failure here degrades the run to the
 * old behaviour (config-based path labelling, config-based size caps) rather
 * than failing it, because a missing label is worth far less than a missing
 * measurement.
 */
async function fetchServerInfo(base, hass, signal) {
  try {
    const response = await fetch(`${base}${API_INFO}?t=${Date.now()}`, {
      cache: "no-store",
      headers: authHeaders(hass),
      signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    return null;
  }
}

async function measureHttpLatency(base, hass, signal) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    if (signal.aborted) break;
    const started = performance.now();
    const response = await fetch(`${base}${API_ECHO}?t=${Date.now()}-${i}`, {
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

async function measureDownload(base, hass, bytes, streams, signal, onProgress) {
  const perStream = Math.max(1, Math.floor(bytes / streams));
  const started = performance.now();
  const totals = await Promise.all(
    Array.from({ length: streams }, async (_, index) => {
      const url = `${base}${API_DOWNLOAD}?bytes=${perStream}&s=${index}&t=${Date.now()}`;
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

async function measureUpload(base, hass, bytes, signal) {
  const body = makeUploadBody(bytes, typeof crypto !== "undefined" ? crypto : null);
  const started = performance.now();
  const response = await fetch(`${base}${API_UPLOAD}?t=${Date.now()}`, {
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
  .ct-context { font-size: 0.72rem; color: var(--secondary-text-color); word-break: break-all; margin-top: 2px; }
  .ct-target { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-top: 6px; font-size: 0.78rem; }
  .ct-target-label { color: var(--secondary-text-color); }
  .ct-target-host { font-weight: 500; color: var(--primary-text-color); word-break: break-all; }
  .ct-link {
    font: inherit; font-size: 0.75rem; cursor: pointer;
    background: none; border: none; padding: 0; text-decoration: underline;
    color: var(--primary-color);
  }
  .ct-link[hidden] { display: none; }
  .ct-ident { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .ct-device { font-size: 0.9rem; font-weight: 500; color: var(--primary-text-color); }
  .ct-chip {
    font-size: 0.68rem; font-weight: 500; letter-spacing: 0.02em;
    padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--divider-color); color: var(--secondary-text-color);
  }
  /* Local is the good case, so it is the only one that gets a colour; a row
     of coloured chips would leave nothing for the exceptional case to say. */
  .ct-chip[data-scope="local"] { color: var(--success-color); border-color: var(--success-color); }
  .ct-chip[data-scope="remote"] { color: var(--warning-color); border-color: var(--warning-color); }
  .ct-icon {
    font: inherit; cursor: pointer; line-height: 1;
    background: none; border: none; padding: 2px 6px; border-radius: 6px;
    color: var(--secondary-text-color);
  }
  .ct-icon:hover { color: var(--primary-color); }
  .ct-rename { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
  .ct-rename[hidden] { display: none; }
  .ct-input {
    font: inherit; flex: 1 1 140px; min-width: 0;
    padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--divider-color);
    background: var(--card-background-color); color: var(--primary-text-color);
  }
  .ct-switch { color: var(--primary-color); white-space: nowrap; }
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
  /* A switched run is not a fault, so it must not be painted as one -- but it
     still has to be said, because the numbers then describe a path the address
     bar does not show. */
  .ct-warn[data-tone="info"] { color: var(--secondary-text-color); }
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
    // Resolved once by _identify(); survives setConfig, because reconfiguring
    // a card does not change what device it is running on.
    this._identifying = null;
    this._device = null;
    // The server's last answer about this connection, so the identity block
    // keeps its verdict between runs instead of reverting to "unknown".
    this._info = null;
    // Which origin the last run measured, and why. `base` is "" for the
    // ordinary same-origin case and a full origin when the run was switched
    // onto a LAN URL; every fetch prefixes it, so "" needs no special case.
    this._target = { base: "", origin: "", note: "", scope: "unknown" };
    // "auto" measures the LAN when it can be reached; "external" is the user
    // asking for the internet path instead. Deliberately NOT persisted: it is
    // a one-off comparison, and a measurement mode that quietly survived a
    // reload would have every later run describing a path nobody chose.
    this._targetChoice = "auto";
    this._targetPromise = null;
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
    const first = !this._hass;
    this._hass = hass;
    // One probe, on the first hass we are given -- the shell is built before
    // hass arrives, and the target row would otherwise sit blank until the
    // first run. Nothing else happens here; re-rendering on a hass update is
    // what rebuilds the DOM many times a second.
    if (first && this._shellBuilt) this._resolveTargetOnce();
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
        <button class="ct-icon" data-action="rename" title="Name this device">&#9998;</button>
      </div>
      <div class="ct-ident">
        <span class="ct-device"></span>
        <span class="ct-chip" data-field="conn"></span>
      </div>
      <div class="ct-context"></div>
      <div class="ct-target">
        <span class="ct-target-label">Testing</span>
        <span class="ct-target-host" data-field="target-host">&mdash;</span>
        <span class="ct-chip" data-field="target-scope" hidden></span>
        <button class="ct-link" data-action="switch-target" hidden></button>
      </div>
      <div class="ct-rename" hidden>
        <input class="ct-input" type="text" maxlength="64" placeholder="Name this device" />
        <button class="ct-btn ct-secondary" data-action="rename-save">Save</button>
        <button class="ct-btn ct-secondary" data-action="rename-cancel">Cancel</button>
      </div>
      <div class="ct-warn" hidden></div>
      <div class="ct-grid">
        <div class="ct-metric">
          <span class="ct-label">Latency</span>
          <span class="ct-value" data-field="latency">&mdash;</span><span class="ct-unit">ms</span>
          <div class="ct-detail" data-field="latency-detail"></div>
        </div>
        <div class="ct-metric">
          <span class="ct-label">Download</span>
          <span class="ct-value" data-field="download">&mdash;</span><span class="ct-unit">Mbit/s</span>
          <div class="ct-detail" data-field="download-detail"></div>
        </div>
        <div class="ct-metric">
          <span class="ct-label">Upload</span>
          <span class="ct-value" data-field="upload">&mdash;</span><span class="ct-unit">Mbit/s</span>
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
      device: root.querySelector(".ct-device"),
      conn: root.querySelector('[data-field="conn"]'),
      context: root.querySelector(".ct-context"),
      targetHost: root.querySelector('[data-field="target-host"]'),
      targetScope: root.querySelector('[data-field="target-scope"]'),
      targetSwitch: root.querySelector('[data-action="switch-target"]'),
      rename: root.querySelector(".ct-rename"),
      input: root.querySelector(".ct-input"),
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
      const what = action.dataset.action;
      if (what === "run") this._run();
      if (what === "cancel") this._cancel();
      if (what === "rename") this._openRename();
      if (what === "rename-save") this._saveRename();
      if (what === "rename-cancel") this._closeRename();
      if (what === "switch-target") this._switchTarget();
    });
    this._nodes.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this._saveRename();
      if (event.key === "Escape") this._closeRename();
    });

    this._shellBuilt = true;
    this._paintTarget();
    this._paintContext();
    // hass usually arrives before setConfig, in which case the setter already
    // fired and did nothing because the shell did not exist yet.
    if (this._hass) this._resolveTargetOnce();
    // Chromium's high-entropy hints are the only source for an Android model
    // (see highEntropyHints), and they are async. Paint immediately from the
    // user agent, then repaint when the better answer lands.
    this._identify().then(() => this._shellBuilt && this._paintContext(this._info));
  }

  /**
   * Work out what this device is, once, and remember the promise.
   *
   * Cached as the promise rather than the result so that a run starting while
   * the hints are still in flight waits for the same lookup instead of firing
   * a second one.
   */
  _identify() {
    if (!this._identifying) {
      this._identifying = highEntropyHints(window)
        .then((hints) => {
          this._device = describeDevice(window, hints);
          return this._device;
        })
        .catch(() => {
          this._device = describeDevice(window, null);
          return this._device;
        });
    }
    return this._identifying;
  }

  /**
   * Decide which Home Assistant URL this run should measure.
   *
   * Two probes, because "did not work" has two causes needing two different
   * sentences: the LAN URL is not reachable from here (ordinary -- you are
   * out of the house), or it is reachable but the browser was not allowed to
   * read the answer (a missing `cors_allowed_origins` entry, or a browser
   * gating a public page's access to a private address).
   *
   * Either way the run continues on the current origin. A slower measurement
   * of the real path beats no measurement, and the card says which it got.
   */
  async _resolveTarget(signal) {
    const pageOrigin = normaliseOrigin(pageOriginOf(window));
    const timeout = this._config.internal_probe_ms;
    const here = (origin, note, extra) => ({
      base: normaliseOrigin(origin) === pageOrigin ? "" : origin,
      origin,
      note: note || "",
      scope: classifyPath(origin, this._config.internal_origins),
      ...(extra || {}),
    });

    // Nothing to probe with until the connection exists; the hass setter runs
    // this again the moment it does.
    if (!this._hass) return here(pageOrigin, "");

    // Asked for the internet path. From a page already loaded that way there
    // is nothing to do; from a LAN page it means measuring another origin,
    // which needs the same permission the other direction does.
    if (this._targetChoice === "external") {
      const external = externalTarget(pageOrigin, this._config);
      if (!external || external === pageOrigin) return here(pageOrigin, "manual");
      const verdict = await this._tryOrigin(external, signal, timeout);
      if (verdict === "ok") return here(external, "manual");
      return here(pageOrigin, verdict, { blocked: external });
    }

    const candidates = internalCandidates(pageOrigin, this._config);
    if (!candidates.length) return here(pageOrigin, "");

    for (const candidate of candidates) {
      if (signal.aborted) break;
      const verdict = await this._tryOrigin(candidate, signal, timeout);
      if (verdict === "unreachable") continue;
      if (verdict === "ok") return here(candidate, "switched");
      // Reachable but unreadable. Name the first one that got this far and
      // stop: a second candidate on the same server would fail identically.
      return here(pageOrigin, "blocked", { blocked: candidate });
    }
    return here(pageOrigin, "");
  }

  /** "ok" | "blocked" (reachable, unreadable) | "unreachable". */
  async _tryOrigin(origin, signal, timeout) {
    if (!(await probeReachable(origin, signal, timeout))) return "unreachable";
    return (await probeUsable(origin, this._hass, signal, timeout)) ? "ok" : "blocked";
  }

  /**
   * Resolve the target once, and remember the promise rather than the answer.
   *
   * Cached as the promise so a run starting while the probe is still in
   * flight waits for that lookup instead of firing a second one -- the same
   * shape as _identify(). Dropped whenever the choice changes, and re-run at
   * the start of every measurement, because a phone can move between networks
   * between one run and the next.
   */
  _resolveTargetOnce(signal) {
    if (!this._targetPromise) {
      const controller = signal ? null : new AbortController();
      this._targetPromise = this._resolveTarget(signal || controller.signal)
        .catch(() => ({ base: "", origin: normaliseOrigin(pageOriginOf(window)), note: "", scope: "unknown" }))
        .then((target) => {
          this._target = target;
          if (this._shellBuilt) this._paintTarget();
          return target;
        });
    }
    return this._targetPromise;
  }

  /**
   * Flip between the LAN path and the internet path, in place.
   *
   * In place is the point: the card already offers a link that reloads the
   * dashboard on the other hostname, and that costs the session -- every card
   * on the page rebuilds, the websocket reconnects, and anything half-typed is
   * gone. Only the measurement needs to move, so only the measurement moves.
   */
  _switchTarget() {
    const alternative = this._targetAlternative();
    if (!alternative) return;
    // Keyed on what the button OFFERS, not on the current choice. Those two
    // come apart the moment the card lands on the external path by itself --
    // "auto" while measuring the internet is not the same state as "auto"
    // while measuring the LAN, and toggling the choice would have sent the
    // button labelled "use halan..." off to the external one.
    this._targetChoice = alternative.choice;
    this._targetPromise = null;
    this._paintTarget();
    this._resolveTargetOnce();
  }

  /**
   * The other path, or null when there is not one worth offering.
   *
   * Going LAN -> internet is always available: the internet URL is either
   * configured or is the one this page was loaded from.
   *
   * Coming back is only offered after a MANUAL switch. When the card chose the
   * internet path itself it did so having just probed the LAN one, so a button
   * promising it would fail the same way a second later -- an offer the card
   * already knows it cannot keep.
   */
  _targetAlternative() {
    const pageOrigin = normaliseOrigin(pageOriginOf(window));
    const target = this._target || {};
    const origin = target.origin || pageOrigin;
    const scope = target.scope || classifyPath(origin, this._config.internal_origins);

    if (scope === "internal") {
      const external = externalTarget(pageOrigin, this._config);
      return external && normaliseOrigin(external) !== normaliseOrigin(origin)
        ? { choice: "external", origin: external }
        : null;
    }
    if (this._targetChoice !== "external") return null;
    const internal =
      internalCandidates(pageOrigin, this._config)[0] ||
      (classifyPath(pageOrigin, this._config.internal_origins) === "internal" ? pageOrigin : "");
    return internal ? { choice: "auto", origin: internal } : null;
  }

  /**
   * Name the host this run will measure, and offer the other one.
   *
   * The hostname is shown because it is the one thing about a result that a
   * viewer cannot work out for themselves and that changes what every number
   * on the card means.
   */
  _paintTarget() {
    const nodes = this._nodes;
    if (!nodes.targetHost) return;

    const pageOrigin = normaliseOrigin(pageOriginOf(window));
    const target = this._target || {};
    const origin = target.origin || pageOrigin;
    const scope = target.scope || classifyPath(origin, this._config.internal_origins);

    nodes.targetHost.textContent = hostOf(origin) || "unknown";
    const label = scope === "internal" ? "local network" : scope === "external" ? "internet" : "";
    nodes.targetScope.textContent = label;
    nodes.targetScope.hidden = !label;
    if (label) nodes.targetScope.dataset.scope = scope === "internal" ? "local" : "remote";

    // The other path, named by host so the button says where it goes.
    const alternative = this._targetAlternative();
    nodes.targetSwitch.hidden = !alternative;
    nodes.targetSwitch.textContent = alternative ? `use ${hostOf(alternative.origin)}` : "";
  }

  _openRename() {
    this._nodes.input.value = storedName(window) || this._nodes.device.textContent || "";
    this._nodes.rename.hidden = false;
    this._nodes.input.focus();
    this._nodes.input.select();
  }

  _closeRename() {
    this._nodes.rename.hidden = true;
  }

  _saveRename() {
    setStoredName(window, this._nodes.input.value);
    this._closeRename();
    this._paintContext(this._info);
  }

  /**
   * Repaint the identity block, and return the context a run should report.
   *
   * `info` is the server's answer from /api/connection_test/info, absent
   * before the first run. Without it the local/remote verdict falls back to
   * matching the origin against the configured `internal_origins`, which is a
   * guess about hostnames rather than an observation about addresses.
   */
  _paintContext(info, target) {
    this._info = info || this._info || null;
    const served = this._info;
    if (target) this._target = target;

    const pageOrigin = normaliseOrigin(pageOriginOf(window));
    // What the numbers are ABOUT, which is not always where the page came
    // from -- everything below is labelled against the tested origin.
    const origin = this._target.base || pageOrigin;
    const device = this._device || describeDevice(window, null);
    const network = readNetwork(window);

    const remoteIsPrivate =
      served && typeof served.client_ip_is_private === "boolean" ? served.client_ip_is_private : null;
    const connection = classifyConnection(network.type, remoteIsPrivate);
    const path =
      remoteIsPrivate === null
        ? classifyPath(origin, this._config.internal_origins)
        : remoteIsPrivate
          ? "internal"
          : "external";

    // Precedence: what this device was named here, then what the dashboard
    // named every device, then what the device looks like. The per-device name
    // wins because it is the only one that can differ per device.
    const name = storedName(window) || this._config.client_name || deviceLabel(device);

    this._nodes.device.textContent = name;
    this._nodes.conn.textContent = connectionLabel(connection);
    this._nodes.conn.dataset.scope = connection.startsWith("local")
      ? "local"
      : connection === "unknown"
        ? "unknown"
        : "remote";

    const ip = served && served.client_ip ? served.client_ip : "";
    const context = [ip ? `${origin || "unknown origin"} — seen as ${ip}` : origin || "unknown origin"];
    if (this._target.base && this._target.base !== pageOrigin) {
      context.push(`dashboard loaded from ${hostOf(pageOrigin)}`);
    }
    this._nodes.context.textContent = context.join(" · ");

    this._paintWarning(origin, path, served);

    return { origin, page_origin: pageOrigin, path, name, device, network, connection, info: served };
  }

  /**
   * Say what the current path means, and offer the other one where there is
   * one to offer.
   *
   * The interesting case is a device sitting on the house network that has
   * loaded the external URL: its traffic leaves the building and comes back,
   * and every number on this card is then describing that round trip rather
   * than the LAN. That is not an error, and the card must not present it as
   * one — but it is almost always the answer to "why is this slow", so it gets
   * a link to the internal origin rather than only a sentence.
   */
  _paintWarning(origin, path, served) {
    const warn = this._nodes.warn;
    warn.textContent = "";
    delete warn.dataset.tone;

    // The run was moved onto a LAN URL. Not a fault, and the card must not
    // dress it as one -- but it does have to say so, because the numbers now
    // describe a different path from the one the address bar shows.
    if (this._target.base) {
      warn.dataset.tone = "info";
      warn.textContent = `Measured over the local network (${hostOf(this._target.base)}); this dashboard itself is loaded from ${hostOf(pageOriginOf(window))}.`;
      warn.hidden = false;
      return;
    }

    // Reachable, but this page was not allowed to read the answer, so the run
    // fell back to the origin it was loaded from. Say what to change: the
    // alternative is a card that quietly measures the wrong path forever.
    if (this._target.note === "blocked") {
      warn.textContent = `${hostOf(this._target.blocked)} answered but would not let this page measure it — add ${pageOriginOf(window)} to cors_allowed_origins under http: in configuration.yaml (or allow this site to reach the local network).`;
      warn.hidden = false;
      return;
    }

    // Asked for an origin that is not answering from here at all. Only worth
    // saying when it was asked for by hand: not reaching the LAN URL from a
    // coffee shop is the ordinary case and needs no sentence.
    if (this._target.note === "unreachable") {
      warn.textContent = `${hostOf(this._target.blocked)} did not answer from this device, so the test used ${hostOf(pageOriginOf(window))} instead.`;
      warn.hidden = false;
      return;
    }

    if (path === "internal") {
      warn.hidden = true;
      return;
    }

    if (path === "unknown") {
      // Only a complaint once the server has actually been asked and could not
      // say. Before the first run there is simply nothing to report yet, and a
      // warning on a card nobody has pressed reads as a fault.
      warn.hidden = !served;
      if (served) {
        warn.textContent =
          "Could not tell whether this connection is local or remote — the proxy in front of Home Assistant is not passing the client address on.";
      }
      return;
    }

    const cloudflare = served && served.via_cloudflare;
    warn.textContent = cloudflare
      ? "This run goes out to the internet and back through Cloudflare, which also caps the upload at 100 MB."
      : "This run goes out to the internet and back, so it measures that path rather than the local network.";

    // Only offer an origin that is configured AND is not the one already in
    // use; the link keeps the current dashboard path so it lands on this card.
    const alternatives = (this._config.internal_origins || []).filter(
      (candidate) => String(candidate).replace(/\/+$/, "").toLowerCase() !== String(origin).toLowerCase()
    );
    if (alternatives.length) {
      const link = document.createElement("a");
      link.className = "ct-switch";
      link.href = `${String(alternatives[0]).replace(/\/+$/, "")}${window.location.pathname}${window.location.search}`;
      link.textContent = `Open on ${hostOf(alternatives[0])}`;
      warn.appendChild(document.createTextNode(" "));
      warn.appendChild(link);
    }
    warn.hidden = false;
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
    const controller = new AbortController();
    this._abort = controller;
    this._busy(true);
    this._progress(0);

    for (const key of ["latency", "download", "upload"]) {
      this._nodes[key].textContent = "—";
      this._nodes[`${key}Detail`].textContent = "";
    }

    try {
      await this._identify();

      /* ---- which URL is this run measuring? ---- */
      // Re-probed rather than reused: a phone can leave the house between one
      // run and the next, and a cached verdict would keep reporting the path
      // it used to be on.
      this._status("Choosing the path…");
      this._targetPromise = null;
      const target = await this._resolveTargetOnce(controller.signal);
      const base = target.base;

      /* ---- what the server can see that we cannot ---- */
      this._status("Checking the connection…");
      const info = await fetchServerInfo(base, hass, controller.signal);
      const context = this._paintContext(info, target);

      // Ceilings, tightest wins: the card's own configuration, whatever the
      // server says this path will carry (Cloudflare's 100 MB, or the proxy's
      // limit), and a smaller allowance on a metered link.
      const serverMaxDown = Number(info && info.max_download_bytes) || Infinity;
      const serverMaxUp = Number(info && info.max_upload_bytes) || Infinity;
      let maxDown = Math.min(config.max_download_mb * MB, serverMaxDown);
      let maxUp = Math.min(config.max_upload_mb * MB, serverMaxUp);
      let capNote = "";
      if (context.connection === "cellular") {
        const cap = config.cellular_max_mb * MB;
        if (cap < maxDown || cap < maxUp) capNote = " · capped for cellular";
        maxDown = Math.min(maxDown, cap);
        maxUp = Math.min(maxUp, cap);
      }

      /* ---- latency (websocket) ---- */
      this._status("Measuring latency…");
      // A run measuring another origin pings THAT origin. Falling back to the
      // page's own socket would report a Cloudflare round trip beside LAN
      // throughput, so the fallback says so rather than passing silently.
      let pinger = pagePinger(hass);
      let latencyNote = "";
      if (base) {
        try {
          pinger = await openSocketPinger(base, hass, 5000);
        } catch (err) {
          latencyNote = ` · latency over ${hostOf(pageOriginOf(window))}`;
        }
      }
      let samples;
      let httpLatency;
      try {
        samples = await measureLatency(pinger, config.ping_count, controller.signal, (taken) => {
          this._progress((taken.length / config.ping_count) * 0.2);
          const running = summariseLatency(taken);
          this._nodes.latency.textContent = fmtMs(running.avg);
        });
        httpLatency = await measureHttpLatency(base, hass, controller.signal);
      } finally {
        pinger.close();
      }
      const latency = summariseLatency(samples);
      this._nodes.latency.textContent = fmtMs(latency.avg);
      this._nodes.latencyDetail.textContent = `min ${fmtMs(latency.min)} · p95 ${fmtMs(latency.p95)} · jitter ${fmtMs(latency.jitter)}${latencyNote}`;

      /* ---- download ---- */
      this._status("Measuring download…");
      const minDown = Math.min(config.min_download_mb * MB, maxDown);
      // The probe doubles as connection warm-up: it opens (and TLS-handshakes)
      // the sockets the measured run then reuses via keep-alive, so setup cost
      // is not billed to the throughput figure.
      const probe = await measureDownload(base, hass, minDown, 1, controller.signal, null);
      const downloadSize = nextSize(
        mbitsPerSecond(probe.bytes, probe.seconds),
        config.target_seconds,
        minDown,
        maxDown
      );

      let downloaded = 0;
      const download = await measureDownload(
        base,
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
      this._nodes.downloadDetail.textContent = `${fmtBytes(download.bytes)} in ${download.seconds.toFixed(1)}s · ${download.streams} streams${capNote}`;

      /* ---- upload ---- */
      this._status("Measuring upload…");
      const minUp = Math.min(config.min_upload_mb * MB, maxUp);
      const upProbe = await measureUpload(base, hass, minUp, controller.signal);
      const uploadSize = nextSize(mbitsPerSecond(upProbe.bytes, upProbe.seconds), config.target_seconds, minUp, maxUp);
      this._progress(0.75);
      const upload = await measureUpload(base, hass, uploadSize, controller.signal);
      const uploadMbps = mbitsPerSecond(upload.bytes, upload.seconds);
      this._nodes.upload.textContent = fmtRate(uploadMbps);
      this._nodes.uploadDetail.textContent = `${fmtBytes(upload.bytes)} in ${upload.seconds.toFixed(1)}s${capNote}`;
      this._progress(1);

      /* ---- report ---- */
      if (config.report) {
        const device = context.device;
        const network = context.network;
        await hass.callService(DOMAIN, "report", {
          client_id: clientId(window),
          client_name: context.name,
          platform: device.platform,
          // The origin the run MEASURED, which is not always the one the
          // dashboard was loaded from -- `page_origin` keeps that distinction
          // in the sensor rather than only on screen.
          origin: context.origin,
          page_origin: context.page_origin,
          path: context.path,
          user: (hass.user && hass.user.name) || "",
          user_agent: (window.navigator && window.navigator.userAgent) || "",
          device_model: device.model,
          device_os: device.os,
          device_browser: device.browser,
          device_form_factor: device.form_factor,
          device_screen: device.screen,
          // Echoed straight back from /info. The server re-derives the
          // internal/external verdict from it rather than trusting `path`
          // above, which is why sending it matters.
          client_ip: (info && info.client_ip) || "",
          client_ip_source: (info && info.client_ip_source) || "",
          via_cloudflare: Boolean(info && info.via_cloudflare),
          network_type: network.type,
          effective_type: network.effectiveType,
          downlink_mbps: network.downlink,
          network_rtt_ms: network.rtt,
          save_data: network.saveData,
          latency_samples_ms: samples.map((value) => Math.round(value * 100) / 100),
          http_latency_ms: httpLatency,
          download_bytes: download.bytes,
          download_seconds: download.seconds,
          download_streams: download.streams,
          upload_bytes: upload.bytes,
          upload_seconds: upload.seconds,
        });
      }
      this._status(`Done · ${connectionLabel(context.connection)}.`, "ok");
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
    normaliseOrigin,
    pageOriginOf,
    internalCandidates,
    externalTarget,
    detectPlatform,
    describeDevice,
    deviceLabel,
    parseUserAgent,
    parseBrowser,
    realModel,
    readNetwork,
    classifyConnection,
    connectionLabel,
    clientId,
    fmtRate,
    fmtMs,
    fmtBytes,
    resolveConfig,
    makeUploadBody,
    DEFAULTS,
    // The class itself, so the target-choosing methods can be driven against
    // a stub. They decide what gets measured, they are not pure, and the one
    // real bug in them (a button that offered one path and switched to the
    // other) was invisible to every pure test above.
    ConnectionTestCard,
  };
}
