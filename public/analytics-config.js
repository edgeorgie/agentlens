// PostHog project token for the live viewer. Empty means analytics is a complete
// no-op: nothing is downloaded, requested or logged. A PostHog project token is
// public by design, so it lives here rather than in a build-time environment
// variable (the viewer has no build step). See README, "Viewer analytics".
window.AGENTLENS_POSTHOG_KEY = "";
