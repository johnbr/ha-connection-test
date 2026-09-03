/*
 * Card tests — Node's built-in runner, zero dependencies.
 *
 *   node --test tests/test_card.js
 *
 * The card duplicates the server's maths so it can show a result immediately
 * instead of waiting for a service round-trip. That duplication is the risk
 * these tests exist to manage: the numeric fixtures below are the SAME ones
 * used in tests/test_measure.py, so the two implementations cannot drift into
 * showing one number on screen and recording another.
 *
 * The DOM half — the shell, the delegated listener, the progress bar — is not
 * covered; that needs a real browser and is verified by hand.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// The card class is DECLARED at module load and `class X extends HTMLElement`
// needs the base to exist, even though nothing here instantiates one. A bare
// stub is enough; `customElements` stays undefined, which is what keeps the
// registration block from running.
global.HTMLElement = class {};

const card = require(
  path.join(__dirname, "..", "custom_components", "connection_test", "frontend", "connection-test-card.js")
);

const {
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
  ConnectionTestCard,
} = card;

// Shared with tests/test_measure.py — keep the two in step.
const SAMPLES = [10.0, 12.0, 11.0, 40.0, 10.5, 11.5, 12.5, 10.0, 11.0, 12.0];

/* -------------------------------------------------------------- throughput */

test("mbitsPerSecond is decimal megabits", () => {
  assert.strictEqual(mbitsPerSecond(1000000, 1), 8);
  assert.strictEqual(mbitsPerSecond(125000000, 1), 1000);
});

test("mbitsPerSecond refuses nonsense rather than returning zero", () => {
  for (const [bytes, seconds] of [
    [0, 1],
    [1000, 0],
    [1000, -1],
    [null, 1],
    [1000, null],
    ["x", 1],
    [Infinity, 1],
  ]) {
    assert.strictEqual(mbitsPerSecond(bytes, seconds), null, `${bytes}/${seconds}`);
  }
});

/* ----------------------------------------------------------------- latency */

test("summariseLatency matches the server for the shared fixture", () => {
  const summary = summariseLatency(SAMPLES);
  assert.strictEqual(summary.count, 10);
  assert.strictEqual(summary.min, 10);
  assert.strictEqual(summary.max, 40);
  assert.strictEqual(summary.avg, 14.05);
  assert.strictEqual(summary.p95, 40);
});

test("jitter is successive difference, not deviation", () => {
  assert.strictEqual(summariseLatency([10, 10, 10, 10, 30]).jitter, 5);
  assert.strictEqual(summariseLatency([10, 30, 10, 30, 10]).jitter, 20);
});

test("summariseLatency handles thin and dirty input", () => {
  assert.strictEqual(summariseLatency([]).count, 0);
  assert.strictEqual(summariseLatency([]).avg, null);
  assert.strictEqual(summariseLatency([7.5]).jitter, null);

  const dirty = summariseLatency([10, null, "x", NaN, -1, 20]);
  assert.strictEqual(dirty.count, 2);
  assert.strictEqual(dirty.avg, 15);
});

test("percentile never invents a value", () => {
  assert.strictEqual(percentile([1, 2, 3, 4], 0.95), 4);
  assert.strictEqual(percentile([], 0.5), null);
});

/* -------------------------------------------------------------- run sizing */

test("nextSize aims at the target duration", () => {
  // 80 Mbit/s for 4 s = 40 MB.
  assert.strictEqual(nextSize(80, 4, 1024, 1024 * 1024 * 1024), 40000000);
});

test("nextSize clamps both ways", () => {
  const min = 2 * 1024 * 1024;
  const max = 64 * 1024 * 1024;
  // Gigabit would ask for far more than the ceiling allows.
  assert.strictEqual(nextSize(1000, 4, min, max), max);
  // Bad cellular would ask for less than is worth measuring.
  assert.strictEqual(nextSize(0.05, 4, min, max), min);
});

test("nextSize falls back to the floor when the probe told us nothing", () => {
  const min = 2 * 1024 * 1024;
  for (const probe of [0, -1, NaN, null, undefined, "x"]) {
    assert.strictEqual(nextSize(probe, 4, min, 999999999), min, String(probe));
  }
});

/* ------------------------------------------------------------ host / path */

test("hostOf strips scheme, port and IPv6 brackets", () => {
  assert.strictEqual(hostOf("https://ha.example.net:8123"), "ha.example.net");
  assert.strictEqual(hostOf("http://172.31.0.3:8123"), "172.31.0.3");
  assert.strictEqual(hostOf("http://[fd00::1]:8123"), "fd00::1");
});

test("isPrivateHost recognises the local network, and only it", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.10",
    "172.31.0.3",
    "172.16.0.1",
    "homeassistant.local",
    "fd00::1",
    "fe80::1",
    "::1",
  ]) {
    assert.ok(isPrivateHost(host), `${host} should be private`);
  }
  // 172.32 is outside the private range even though it looks close.
  for (const host of ["ha.example.net", "8.8.8.8", "172.32.0.1", "1.1.1.1", ""]) {
    assert.ok(!isPrivateHost(host), `${host} should not be private`);
  }
});

test("classifyPath trusts configuration over guesswork", () => {
  const internal = ["https://halan.example.net"];
  assert.strictEqual(classifyPath("https://halan.example.net", internal), "internal");
  // Trailing slashes and case must not fork the comparison.
  assert.strictEqual(classifyPath("https://HALAN.example.net/", internal), "internal");
  assert.strictEqual(classifyPath("https://ha.example.net", internal), "external");
});

test("classifyPath says unknown rather than guessing wrong", () => {
  // A browser cannot resolve a name, so a public-looking hostname pointed at a
  // private address is indistinguishable. A wrong label is worse than none.
  assert.strictEqual(classifyPath("https://ha.example.net", []), "unknown");
  assert.strictEqual(classifyPath("http://172.31.0.3:8123", []), "internal");
});

/* ------------------------------------------------------------- client id */

/* ---------------------------------------------------------- target choice */
/*
 * Which URL a run measures, driven through the real methods against a stub.
 * These are not pure -- they probe -- so `fetch` is replaced with a fake
 * network whose only knowledge is which hosts answer and which allow a
 * cross-origin read. Nothing here touches the DOM.
 */

const CONFIG = {
  internal_origins: ["https://halan.prowlah.net"],
  external_origin: "https://ha.prowlah.net",
  prefer_internal: true,
  internal_probe_ms: 50,
};

/**
 * @param reachable  hosts that answer at all (an opaque no-cors fetch resolves)
 * @param readable   hosts that also allow this page to read the answer
 */
function fakeNetwork({ reachable = [], readable = [] } = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, mode: options.mode });
    const host = String(url).split("/api/")[0];
    if (!reachable.includes(host)) throw new TypeError("Failed to fetch");
    // no-cors resolves opaquely even for a 401 -- that is the whole point of
    // using it as the reachability probe.
    if (options.mode === "no-cors") return { ok: false, status: 0, type: "opaque" };
    if (!readable.includes(host)) throw new TypeError("CORS refused");
    return { ok: true, status: 204 };
  };
  return calls;
}

function stubCard(pageOrigin, config = CONFIG) {
  global.window = { location: { origin: pageOrigin } };
  const stub = Object.create(ConnectionTestCard.prototype);
  stub._config = resolveConfig({ ...config });
  stub._hass = { auth: { accessToken: "token" } };
  stub._target = { base: "", origin: "", note: "", scope: "unknown" };
  stub._targetChoice = "auto";
  stub._targetPromise = null;
  stub._shellBuilt = false;
  stub._nodes = {};
  return stub;
}

const signal = () => new AbortController().signal;

test("a LAN page measures itself, and probes nothing", async () => {
  const calls = fakeNetwork({ reachable: [], readable: [] });
  const stub = stubCard("https://halan.prowlah.net");
  const target = await stub._resolveTarget(signal());
  assert.equal(target.base, "");
  assert.equal(target.scope, "internal");
  assert.equal(calls.length, 0);
});

test("an external page switches onto the LAN URL when it answers", async () => {
  fakeNetwork({ reachable: ["https://halan.prowlah.net"], readable: ["https://halan.prowlah.net"] });
  const stub = stubCard("https://ha.prowlah.net");
  const target = await stub._resolveTarget(signal());
  assert.equal(target.base, "https://halan.prowlah.net");
  assert.equal(target.note, "switched");
  assert.equal(target.scope, "internal");
});

test("out of the house it stays put, silently", async () => {
  // Nothing answers. This is the ordinary case and must not produce a warning
  // note, or the card would complain every time it leaves the building.
  fakeNetwork({ reachable: [], readable: [] });
  const stub = stubCard("https://ha.prowlah.net");
  const target = await stub._resolveTarget(signal());
  assert.equal(target.base, "");
  assert.equal(target.note, "");
});

test("reachable but unreadable is reported, not silently ignored", async () => {
  // The missing cors_allowed_origins case: answering, but this page may not
  // read it. Falling back is right; falling back quietly is not.
  fakeNetwork({ reachable: ["https://halan.prowlah.net"], readable: [] });
  const stub = stubCard("https://ha.prowlah.net");
  const target = await stub._resolveTarget(signal());
  assert.equal(target.base, "");
  assert.equal(target.note, "blocked");
  assert.equal(target.blocked, "https://halan.prowlah.net");
});

test("the probe is opaque first, authenticated second", async () => {
  const calls = fakeNetwork({ reachable: ["https://halan.prowlah.net"], readable: ["https://halan.prowlah.net"] });
  await stubCard("https://ha.prowlah.net")._resolveTarget(signal());
  assert.equal(calls[0].mode, "no-cors");
  assert.equal(calls[1].mode, undefined);
});

test("asking for the internet path measures it from a LAN page", async () => {
  fakeNetwork({ reachable: ["https://ha.prowlah.net"], readable: ["https://ha.prowlah.net"] });
  const stub = stubCard("https://halan.prowlah.net");
  stub._targetChoice = "external";
  const target = await stub._resolveTarget(signal());
  assert.equal(target.base, "https://ha.prowlah.net");
  assert.equal(target.scope, "external");
});

test("the switch goes where its label says, not wherever the toggle lands", async () => {
  // The bug this exists for: the card lands on the external path by itself
  // (LAN unreachable), so the button offers the LAN one back -- and a toggle
  // keyed on the CURRENT CHOICE would have sent it to external instead.
  const stub = stubCard("https://ha.prowlah.net");
  stub._target = { base: "", origin: "https://ha.prowlah.net", note: "", scope: "external" };

  // Auto already tried the LAN and could not reach it: nothing to offer.
  stub._targetChoice = "auto";
  assert.equal(stub._targetAlternative(), null);

  // Manually on the internet path: offer the way back, and say so by host.
  stub._targetChoice = "external";
  assert.deepEqual(stub._targetAlternative(), { choice: "auto", origin: "https://halan.prowlah.net" });

  // On the LAN: offer the internet path.
  stub._target = { base: "https://halan.prowlah.net", origin: "https://halan.prowlah.net", scope: "internal" };
  stub._targetChoice = "auto";
  assert.deepEqual(stub._targetAlternative(), { choice: "external", origin: "https://ha.prowlah.net" });
});

test("with no external_origin a LAN-loaded card has nothing to offer", async () => {
  const stub = stubCard("https://halan.prowlah.net", { ...CONFIG, external_origin: "" });
  stub._target = { base: "", origin: "https://halan.prowlah.net", scope: "internal" };
  assert.equal(stub._targetAlternative(), null);
});

/* ----------------------------------------------------------------- target */
/*
 * Which URL a run measures. The decision is pure and the probes are not, so
 * everything decidable without a network is decided here.
 */

test("normaliseOrigin makes two spellings of one origin comparable", () => {
  assert.equal(normaliseOrigin("https://HALAN.prowlah.net/"), "https://halan.prowlah.net");
  assert.equal(normaliseOrigin("https://halan.prowlah.net///"), "https://halan.prowlah.net");
  assert.equal(normaliseOrigin(undefined), "");
});

test("internalCandidates offers the LAN URLs when the page is on the external one", () => {
  const config = {
    prefer_internal: true,
    internal_origins: ["https://halan.prowlah.net", "http://172.31.0.3:8123"],
  };
  assert.deepEqual(internalCandidates("https://ha.prowlah.net", config), [
    "https://halan.prowlah.net",
    "http://172.31.0.3:8123",
  ]);
});

test("internalCandidates has nothing to offer a page already on a LAN URL", () => {
  // The page could not have loaded otherwise, so there is nothing to probe --
  // and a trailing slash must not be able to hide that.
  const config = { prefer_internal: true, internal_origins: ["https://halan.prowlah.net"] };
  assert.deepEqual(internalCandidates("https://halan.prowlah.net", config), []);
  assert.deepEqual(internalCandidates("https://HALAN.prowlah.net/", config), []);
});

test("internalCandidates stays inert without configuration or consent", () => {
  assert.deepEqual(internalCandidates("https://ha.prowlah.net", { prefer_internal: true, internal_origins: [] }), []);
  assert.deepEqual(
    internalCandidates("https://ha.prowlah.net", {
      prefer_internal: false,
      internal_origins: ["https://halan.prowlah.net"],
    }),
    []
  );
});

test("externalTarget names the internet path from either side", () => {
  const internal = ["https://halan.prowlah.net"];
  // Configured: the only way a LAN-loaded page can name the public URL.
  assert.equal(
    externalTarget("https://halan.prowlah.net", {
      internal_origins: internal,
      external_origin: "https://ha.prowlah.net",
    }),
    "https://ha.prowlah.net"
  );
  // Unconfigured: a page loaded from outside already is the external path.
  assert.equal(
    externalTarget("https://ha.prowlah.net", { internal_origins: internal, external_origin: "" }),
    "https://ha.prowlah.net"
  );
  // Unconfigured on a LAN page: nothing to offer, and it must not offer the
  // LAN URL back as if it were the internet one.
  assert.equal(externalTarget("https://halan.prowlah.net", { internal_origins: internal, external_origin: "" }), "");
});

test("resolveConfig defaults to preferring the LAN and clamps the probe", () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.prefer_internal, true);
  assert.equal(defaults.internal_probe_ms, 2000);
  assert.equal(resolveConfig({ prefer_internal: false }).prefer_internal, false);
  assert.equal(resolveConfig({ internal_probe_ms: 0 }).internal_probe_ms, 200);
  assert.equal(resolveConfig({ internal_probe_ms: 99999 }).internal_probe_ms, 10000);
  assert.equal(resolveConfig({ external_origin: "https://HA.prowlah.net/" }).external_origin, "https://ha.prowlah.net");
});

test("pageOriginOf tolerates a window without a location", () => {
  assert.equal(pageOriginOf(null), "");
  assert.equal(pageOriginOf({}), "");
  assert.equal(pageOriginOf({ location: { origin: "https://ha.prowlah.net" } }), "https://ha.prowlah.net");
});

test("detectPlatform keys on the Companion bridge, not the user agent", () => {
  assert.strictEqual(detectPlatform({ externalApp: {}, document: {} }), "android_app");
  assert.strictEqual(detectPlatform({ webkit: { messageHandlers: { externalBus: {} } }, document: {} }), "ios_app");
  assert.strictEqual(detectPlatform({ document: {} }), "browser");
  assert.strictEqual(detectPlatform(null), "unknown");
});

test("detectPlatform is not fooled by a WebView reporting a browser UA", () => {
  // The Android app's WebView sends Chrome's user agent; only the bridge tells
  // the truth, which is why nothing here looks at navigator.
  const androidWebView = {
    document: {},
    externalApp: {},
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) Chrome/140.0" },
  };
  assert.strictEqual(detectPlatform(androidWebView), "android_app");
});

test("detectPlatform falls back to the Companion user-agent token", () => {
  // The bridge is installed after the page starts loading, so a run that fires
  // early would otherwise be filed as a browser. Both apps stamp the UA.
  assert.strictEqual(
    detectPlatform({
      document: {},
      navigator: { userAgent: "Mozilla/5.0 (Linux; Android 10; K) Home Assistant/2026.8" },
    }),
    "android_app"
  );
  assert.strictEqual(
    detectPlatform({
      document: {},
      navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Home Assistant/2026.8" },
    }),
    "ios_app"
  );
});

/* ---------------------------------------------------------- device identity */

test("realModel rejects the values Chrome's UA reduction substitutes", () => {
  // This is the whole reason describeDevice needs Client Hints: modern Chrome
  // on Android reports every device on earth as "K".
  assert.strictEqual(realModel("K"), "");
  assert.strictEqual(realModel("Android"), "");
  assert.strictEqual(realModel(""), "");
  assert.strictEqual(realModel("Pixel 9 Pro"), "Pixel 9 Pro");
  // WebViews append the build fingerprint.
  assert.strictEqual(realModel("Pixel Tablet Build/AP4A.241205.013"), "Pixel Tablet");
});

test("parseUserAgent reads OS and form factor off the classic strings", () => {
  const linux = parseUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0", {});
  assert.strictEqual(linux.os, "Linux");
  assert.strictEqual(linux.formFactor, "desktop");

  const phone = parseUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) Chrome/140 Mobile Safari", {});
  assert.deepStrictEqual([phone.os, phone.model, phone.formFactor], ["Android 15", "Pixel 9 Pro", "phone"]);

  // Chrome omits the "Mobile" token on tablets. That is the only signal in the
  // string, so it decides.
  const tablet = parseUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel Tablet) Chrome/140 Safari", {});
  assert.strictEqual(tablet.formFactor, "tablet");

  const iphone = parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", {});
  assert.deepStrictEqual([iphone.model, iphone.formFactor], ["iPhone", "phone"]);
});

test("parseUserAgent separates an iPad in desktop mode from a real Mac", () => {
  // iPadOS Safari requests desktop pages and calls itself a Macintosh. Only
  // the touch-point count tells them apart.
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15";
  assert.strictEqual(parseUserAgent(ua, { navigator: { maxTouchPoints: 0 } }).model, "Mac");
  assert.strictEqual(parseUserAgent(ua, { navigator: { maxTouchPoints: 5 } }).model, "iPad");
  assert.strictEqual(parseUserAgent(ua, { navigator: { maxTouchPoints: 5 } }).formFactor, "tablet");
});

test("parseBrowser prefers a named brand over Chromium and drops the padding", () => {
  const brands = [
    { brand: "Not)A;Brand", version: "24" },
    { brand: "Chromium", version: "141" },
    { brand: "Google Chrome", version: "141" },
  ];
  assert.strictEqual(parseBrowser("", { brands }), "Google Chrome 141");
  // No hints: fall back to the string. Chrome's UA also contains "Safari/", so
  // order decides and is pinned here.
  assert.strictEqual(parseBrowser("Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36", null), "Chrome 140");
  assert.strictEqual(parseBrowser("Mozilla/5.0 Firefox/130.0", null), "Firefox 130");
});

test("describeDevice lets Client Hints beat a reduced user agent", () => {
  const win = {
    document: {},
    navigator: {
      // What Chrome on Android actually sends now: no model, frozen version.
      userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36",
      maxTouchPoints: 5,
    },
    screen: { width: 412, height: 915 },
    devicePixelRatio: 2.6,
  };
  const hints = {
    platform: "Android",
    platformVersion: "16.0.0",
    model: "Pixel 9 Pro",
    mobile: true,
    brands: [{ brand: "Google Chrome", version: "141" }],
  };
  const device = describeDevice(win, hints);
  assert.strictEqual(device.model, "Pixel 9 Pro");
  assert.strictEqual(device.os, "Android 16");
  assert.strictEqual(device.form_factor, "phone");
  assert.strictEqual(deviceLabel(device), "Pixel 9 Pro · Google Chrome 141");

  // Without hints the same device is anonymous — which is exactly the bug
  // that made two different devices both report themselves as "Chrome".
  assert.strictEqual(describeDevice(win, null).model, "");
});

test("describeDevice never demotes a tablet to a desktop", () => {
  // `mobile: false` means "does not want a mobile page", which is true of both
  // tablets and desktops. It must not overrule a tablet already identified.
  const win = {
    document: {},
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 10; K) Chrome/141.0.0.0 Safari/537.36" },
  };
  const device = describeDevice(win, {
    platform: "Android",
    platformVersion: "16",
    model: "Pixel Tablet",
    mobile: false,
  });
  assert.strictEqual(device.form_factor, "tablet");
  // Hints carrying no `brands` still fall back to the user agent for the
  // browser name, so the label stays complete.
  assert.strictEqual(deviceLabel(device), "Pixel Tablet · Chrome 141");
});

test("deviceLabel names a desktop by its OS when there is no model", () => {
  // The reported complaint: every machine in the house called itself "Chrome
  // browser". A desktop has no model, so the OS has to carry the name.
  const win = {
    document: {},
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36" },
  };
  const device = describeDevice(win, {
    platform: "Linux",
    platformVersion: "6.12.0",
    mobile: false,
    brands: [{ brand: "Google Chrome", version: "141" }],
  });
  assert.strictEqual(deviceLabel(device), "Linux desktop · Google Chrome 141");
});

test("deviceLabel puts the Companion app after the device, not instead of it", () => {
  const win = {
    document: {},
    externalApp: {},
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 10; K; wv) Chrome/141.0.0.0 Mobile Safari/537.36" },
  };
  const device = describeDevice(win, {
    platform: "Android",
    platformVersion: "16",
    model: "Pixel 9 Pro",
    mobile: true,
  });
  assert.strictEqual(device.platform, "android_app");
  assert.strictEqual(deviceLabel(device), "Pixel 9 Pro · HA app");
});

/* ------------------------------------------------------------- the network */

test("readNetwork tolerates browsers without navigator.connection", () => {
  // Safari and Firefox implement none of it; desktop Chromium implements it
  // without `type`. Neither may throw.
  assert.deepStrictEqual(readNetwork({ navigator: {} }), {
    type: "",
    effectiveType: "",
    downlink: null,
    rtt: null,
    saveData: false,
  });
  const chromeAndroid = readNetwork({
    navigator: { connection: { type: "cellular", effectiveType: "4g", downlink: 10, rtt: 50, saveData: false } },
  });
  assert.strictEqual(chromeAndroid.type, "cellular");
  assert.strictEqual(chromeAndroid.downlink, 10);
});

test("classifyConnection: the scope half comes from the server, the medium from the browser", () => {
  assert.strictEqual(classifyConnection("wifi", true), "local_wifi");
  assert.strictEqual(classifyConnection("ethernet", true), "local_wired");
  // The common case: no browser support for `type`, but the address is known.
  assert.strictEqual(classifyConnection("", true), "local");
  assert.strictEqual(classifyConnection("", false), "remote");
  // The case that prompted all this — on the house Wi-Fi, but loaded over the
  // external URL, so the traffic really did leave the building.
  assert.strictEqual(classifyConnection("wifi", false), "wifi");
  // Nothing known at all.
  assert.strictEqual(classifyConnection("", null), "unknown");
  assert.strictEqual(classifyConnection("wifi", null), "wifi");
});

test("classifyConnection: cellular is never local", () => {
  // A carrier NAT can hand out an RFC1918 address, so the address alone would
  // call a phone on 5G "local". The medium overrules it.
  assert.strictEqual(classifyConnection("cellular", true), "cellular");
  assert.strictEqual(classifyConnection("cellular", false), "cellular");
});

test("classifyConnection ignores effectiveType by construction", () => {
  // effectiveType grades speed, not medium: congested Wi-Fi reports "3g".
  // It is not a parameter, and this test exists so it does not become one.
  assert.strictEqual(classifyConnection.length, 2);
  assert.strictEqual(classifyConnection("unknown", true), "local");
  assert.strictEqual(classifyConnection("none", false), "remote");
});

test("connectionLabel calls out the round trip rather than hiding it", () => {
  assert.strictEqual(connectionLabel("local_wifi"), "Local Wi-Fi");
  assert.match(connectionLabel("wifi"), /via internet/);
  assert.strictEqual(connectionLabel("nonsense"), "Unknown network");
});

test("clientId persists, and survives storage being unavailable", () => {
  const store = new Map();
  const win = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
    crypto: { randomUUID: () => "uuid-1" },
  };
  assert.strictEqual(clientId(win), "uuid-1");
  win.crypto.randomUUID = () => "uuid-2";
  assert.strictEqual(clientId(win), "uuid-1", "second call must reuse the stored id");

  // Private browsing: localStorage throws. The run must still work, and the id
  // must at least be stable for the life of the page.
  const blocked = {
    localStorage: {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    },
    crypto: { randomUUID: () => "uuid-3" },
  };
  assert.strictEqual(clientId(blocked), "uuid-3");
  assert.strictEqual(clientId(blocked), "uuid-3");
});

/* ------------------------------------------------------------- formatting */

test("fmtRate keeps precision where it matters", () => {
  assert.strictEqual(fmtRate(940), "940");
  assert.strictEqual(fmtRate(94.2), "94.2");
  assert.strictEqual(fmtRate(1.234), "1.23");
  assert.strictEqual(fmtRate(null), "—");
  assert.strictEqual(fmtRate("x"), "—");
});

test("fmtMs and fmtBytes degrade to an em dash, never to zero", () => {
  assert.strictEqual(fmtMs(8.42), "8.4");
  assert.strictEqual(fmtMs(1234), "1234");
  assert.strictEqual(fmtMs(null), "—");
  assert.strictEqual(fmtBytes(0), "—");
  assert.strictEqual(fmtBytes(1024), "1.0 KiB");
  assert.strictEqual(fmtBytes(33554432), "32 MiB");
});

/* ----------------------------------------------------------------- config */

test("resolveConfig fills defaults and clamps hostile values", () => {
  assert.deepStrictEqual(resolveConfig({}).ping_count, DEFAULTS.ping_count);
  assert.strictEqual(resolveConfig({ ping_count: 100000 }).ping_count, 100);
  assert.strictEqual(resolveConfig({ ping_count: 0 }).ping_count, 3);
  assert.strictEqual(resolveConfig({ ping_count: "banana" }).ping_count, DEFAULTS.ping_count);
  assert.strictEqual(resolveConfig({ download_streams: 99 }).download_streams, 8);
  // The server clamps too; this keeps the card from asking for the impossible.
  assert.strictEqual(resolveConfig({ max_download_mb: 99999 }).max_download_mb, 512);
});

test("resolveConfig tolerates internal_origins being the wrong shape", () => {
  assert.deepStrictEqual(resolveConfig({ internal_origins: "https://x" }).internal_origins, []);
  assert.deepStrictEqual(resolveConfig({ internal_origins: ["https://x"] }).internal_origins, ["https://x"]);
});

/* ------------------------------------------------------------ upload body */

test("makeUploadBody fills the exact requested size", () => {
  // crypto.getRandomValues refuses more than 65536 bytes per call, which is
  // why the body is tiled rather than filled in one go.
  const calls = [];
  const fake = {
    getRandomValues: (block) => {
      calls.push(block.length);
      block.fill(calls.length);
      return block;
    },
  };
  const body = makeUploadBody(200000, fake);
  assert.strictEqual(body.length, 200000);
  assert.ok(Math.max(...calls) <= 65536, "no call may exceed the 65536-byte quota");
});

test("makeUploadBody works with no crypto at all", () => {
  const body = makeUploadBody(1000, null);
  assert.strictEqual(body.length, 1000);
});
