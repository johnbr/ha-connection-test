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
  detectPlatform,
  defaultClientName,
  clientId,
  fmtRate,
  fmtMs,
  fmtBytes,
  resolveConfig,
  makeUploadBody,
  DEFAULTS,
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

test("detectPlatform keys on the Companion bridge, not the user agent", () => {
  assert.strictEqual(detectPlatform({ externalApp: {}, document: {} }), "android_app");
  assert.strictEqual(
    detectPlatform({ webkit: { messageHandlers: { externalBus: {} } }, document: {} }),
    "ios_app"
  );
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

test("defaultClientName names a device before anyone has", () => {
  assert.strictEqual(
    defaultClientName({
      document: {},
      externalApp: {},
      navigator: { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit" },
    }),
    "Pixel 9 Pro (Android app)"
  );
  assert.strictEqual(
    defaultClientName({
      document: {},
      webkit: { messageHandlers: { externalBus: {} } },
      navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" },
    }),
    "iPhone app"
  );
  assert.strictEqual(
    defaultClientName({ document: {}, navigator: { userAgent: "Mozilla/5.0 Firefox/130.0" } }),
    "Firefox browser"
  );
  // Chrome's UA also contains "Safari/"; order decides, so pin it.
  assert.strictEqual(
    defaultClientName({ document: {}, navigator: { userAgent: "Mozilla/5.0 Chrome/140 Safari/537.36" } }),
    "Chrome browser"
  );
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
