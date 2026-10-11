// Product analytics for the static viewer (PostHog). Only the viewer reports;
// the tracer library and the CLI never do, because code embedded in someone
// else's agent must never phone home.
//
// - Without a key (analytics-config.js) this file does nothing: no script is
//   injected, no request is made, nothing is logged.
// - With a key the SDK is fetched from this origin (/ingest/static/array.js,
//   rewritten to PostHog by vercel.json), so tracking blockers that filter by
//   domain do not drop it and a CSP can stay at 'self'.
// - Cookieless, no person profiles, no autocapture, no session replay: the
//   only events are the explicit ones app.js sends through agentlensTrack(),
//   and they never carry anything from a trace.
(function () {
  var key = typeof window.AGENTLENS_POSTHOG_KEY === "string" ? window.AGENTLENS_POSTHOG_KEY.trim() : "";

  if (!key) {
    window.agentlensTrack = function () {};
    return;
  }

  var client = null;
  // Events sent before the SDK has loaded wait here; null once the SDK is
  // ready or has failed to load, after which calls are dropped silently.
  var queue = [];

  window.agentlensTrack = function (event, props) {
    if (client) client.capture(event, props);
    else if (queue) queue.push([event, props]);
  };

  var script = document.createElement("script");
  script.async = true;
  script.src = "/ingest/static/array.js";
  script.onload = function () {
    var posthog = window.posthog;
    if (!posthog || typeof posthog.init !== "function") {
      queue = null;
      return;
    }
    posthog.init(key, {
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      defaults: "2026-08-30",
      cookieless_mode: "always",
      person_profiles: "never",
      autocapture: false,
      capture_pageview: true,
      disable_session_recording: true,
      respect_dnt: true,
    });
    posthog.register({ app: "agentlens", surface: "web" });
    client = posthog;
    var pending = queue;
    queue = null;
    for (var i = 0; i < pending.length; i++) client.capture(pending[i][0], pending[i][1]);
  };
  script.onerror = function () {
    queue = null;
  };
  document.head.appendChild(script);
})();
