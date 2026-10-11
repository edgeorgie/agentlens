import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/analytics.js", import.meta.url), "utf8");

// A minimal stand-in for the browser: it records every script the file injects
// and every console call it makes, so the no-op guarantee can be asserted
// without a DOM library.
function runViewerAnalytics(key) {
  const injected = [];
  const logged = [];
  const window = { AGENTLENS_POSTHOG_KEY: key };
  const document = {
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => injected.push(el) },
  };
  const console = new Proxy({}, { get: () => (...args) => logged.push(args) });
  vm.runInContext(source, vm.createContext({ window, document, console }), { filename: "analytics.js" });
  return { window, injected, logged };
}

test("viewer analytics with an empty key injects nothing, requests nothing and logs nothing", () => {
  const { window, injected, logged } = runViewerAnalytics("");
  assert.equal(typeof window.agentlensTrack, "function");
  assert.equal(window.agentlensTrack("trace_loaded", { source: "upload", span_bucket: "<10" }), undefined);
  assert.equal(injected.length, 0);
  assert.equal(logged.length, 0);
  assert.equal(window.posthog, undefined);
});

test("viewer analytics with a key loads the SDK from this origin and flushes queued events after init", () => {
  const { window, injected, logged } = runViewerAnalytics("phc_test");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].tag, "script");
  assert.equal(injected[0].src, "/ingest/static/array.js");

  // Sent before the SDK has loaded: must be queued, not dropped.
  window.agentlensTrack("trace_loaded", { source: "example", span_bucket: "<10" });

  const calls = [];
  window.posthog = {
    init: (key, config) => calls.push(["init", key, config]),
    register: (props) => calls.push(["register", props]),
    capture: (event, props) => calls.push(["capture", event, props]),
  };
  injected[0].onload();

  const [initCall, registerCall, captureCall] = calls;
  assert.equal(initCall[0], "init");
  assert.equal(initCall[1], "phc_test");
  assert.equal(initCall[2].api_host, "/ingest");
  assert.equal(initCall[2].cookieless_mode, "always");
  assert.equal(initCall[2].person_profiles, "never");
  assert.equal(initCall[2].autocapture, false);
  assert.equal(initCall[2].disable_session_recording, true);
  assert.equal(initCall[2].respect_dnt, true);
  assert.equal(registerCall[0], "register");
  // Copied into this realm: the object was built inside the vm context, whose
  // Object.prototype is a different one and would fail a strict deep equal.
  assert.deepEqual({ ...registerCall[1] }, { app: "agentlens", surface: "web" });
  assert.deepEqual(captureCall, ["capture", "trace_loaded", { source: "example", span_bucket: "<10" }]);
  assert.equal(logged.length, 0);
});

// The proxy is a server-side route, so it exists whether or not the viewer ever
// calls it: with the rules in vercel.json and no key, the deployment would relay
// whatever is posted to /ingest/* to PostHog's public ingestion API. This site
// has no build step to switch the rules on, so the checked-in key and the
// checked-in rules must agree. Reading both files is the only check there is.
const configKey = (() => {
  const text = readFileSync(new URL("../public/analytics-config.js", import.meta.url), "utf8");
  const match = text.match(/^window\.AGENTLENS_POSTHOG_KEY\s*=\s*"([^"]*)";/m);
  assert.ok(match, "analytics-config.js must assign window.AGENTLENS_POSTHOG_KEY a string literal");
  return match[1].trim();
})();
const rewrites = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).rewrites ?? [];

test("vercel.json registers no /ingest route while the key is empty", () => {
  if (configKey) return;
  assert.deepEqual(rewrites, []);
});

test("vercel.json proxies /ingest to PostHog's own hosts, and only while a key is set", () => {
  if (!configKey) return;
  assert.deepEqual(
    rewrites.map((r) => r.source),
    ["/ingest/static/:path*", "/ingest/array/:path*", "/ingest/:path*"],
  );
  for (const r of rewrites) assert.match(new URL(r.destination).hostname, /\.i\.posthog\.com$/);
});
