# agentlens

> Zero-dependency tracing + waterfall visualizer for AI agent tool calls.

Most agent demos show you the final answer. **agentlens shows you the path there**: every tool call, every LLM call, how long each took, how they nested, what tokens/cost they burned, and exactly where things failed — rendered as an interactive waterfall, like a browser's network panel but for an agent's reasoning loop.

**Live demo (drop your own trace.json, nothing leaves your browser):** https://agentlens-nine.vercel.app

This exists to fill a real gap: [triage-desk](https://github.com/edgeorgie/triage-desk), [eval-lab](https://github.com/edgeorgie/eval-lab) and [repoask-mcp](https://github.com/edgeorgie/repoask-mcp) are all retrieval/Q&A or pass-fail-eval shaped. None of them show *how* an agent got to an answer, step by step, with latency/cost broken out per step. agentlens is the observability layer: instrument any agent loop with a few lines, get a trace.json, render it as a waterfall.

## Why this, why now

I kept wanting this while building the other agent projects: a trace of what an
agent actually did, not just its final answer. Tracing/observability tools for
normal web requests are a solved problem (distributed tracing, APM, session
replay); agent tool-call loops don't usually get the same treatment. agentlens
is a minimal v1 of that idea, applied one layer up: to the agent's own
reasoning loop instead of the app it's acting on.

## Install

```bash
npm install github:edgeorgie/agentlens
```

No dependencies beyond Node's built-in `node:async_hooks` and `node:crypto`. Works in any Node 18+ environment. (Not yet on the npm registry under this name — see "npm publish status" below.)

## Usage

```ts
import { Tracer, saveTrace } from "agentlens";

const tracer = new Tracer("triage-issue-42");

const plan = await tracer.llm("plan", async (setAttrs) => {
  const result = await callYourLLM(prompt);
  setAttrs({ tokensIn: result.usage.input, tokensOut: result.usage.output, costUsd: result.cost, model: "claude-haiku-4-5" });
  return result;
});

const label = await tracer.tool("apply_label", async (setAttrs) => {
  const result = await github.addLabel(issue, plan.label);
  setAttrs({ input: { issue, label: plan.label }, output: result });
  return result;
});

const trace = tracer.finish();
await saveTrace(trace, "trace.json");
```

Spans nest automatically via `AsyncLocalStorage` — call `tracer.tool()`/`tracer.llm()`/`tracer.span()` inside another span's callback (even across `await`s) and it becomes a child, no manual parent-id plumbing.

Then render it:

```bash
npx agentlens view trace.json -o trace.html   # self-contained HTML waterfall, open in any browser
npx agentlens stats trace.json                # print duration/tokens/cost/errors to stdout
npx agentlens compare run-a.json run-b.json    # diff two traces, exit 1 if error count regressed
```

Or drop the trace.json straight into the [live viewer](https://agentlens-nine.vercel.app) — same renderer, runs fully client-side, nothing uploaded.

## Verified output

`npm run demo` runs a small multi-step agent (plan → search_docs → read_doc ×2 → write_summary, one read deliberately fails to show error handling) fully instrumented with agentlens, and renders it. Output from a run:

```
agent result: Summary of 2 doc(s): contents of doc:quarterly-report#1 | [skipped doc:quarterly-report#2: fetch failed for doc:quarterly-report#2: upstream 503]
trace saved: examples/demo-trace.json (6 spans, 286ms, $0.00010)
```

```
agentlens stats — demo-agent: quarterly-report
  total duration : 286ms
  spans          : 6
  tokens         : 222
  cost           : $0.00010
  errors         : 1
  by kind:
    llm        count=1 totalMs=112
    agent      count=1 totalMs=174
    tool       count=4 totalMs=173
```

The rendered waterfall ([examples/demo-trace.html](examples/demo-trace.html), also loadable via "Load example trace" on the live viewer) shows the `plan` LLM span, the `agent-run` span containing 4 nested tool spans, the failed `read_doc` call outlined in red, and hover-to-see input/output/error on every row.

7/7 unit tests pass locally (`npm test`, which runs a `pretest` hook invoking
`npm run build` first — so `npm install && npm test` works on a fresh clone
with no manual build step): nested span parent/child correctness, concurrent-sibling isolation (two tool calls in `Promise.all` don't cross-contaminate each other's parent context), error capture without losing the trace, token/cost summation, HTML self-containment (no external network calls baked into the rendered file), and two viewer checks: `public/analytics.js` is a complete no-op without a key, and with one it loads the SDK from `/ingest` and flushes queued events after init.

## Design choices, stated plainly

- **Zero runtime dependencies.** No OpenTelemetry SDK, no vendor lock-in, no server required. A trace is just JSON; the renderer is a single HTML file.
- **Cost/tokens are optional fields you set yourself** (`setAttrs({ tokensIn, tokensOut, costUsd, model })`) — agentlens doesn't call any LLM API or know your provider's pricing; it just sums whatever you report. This keeps the library itself at exactly $0 marginal cost — the demo above uses a stubbed "planner" with made-up, labeled-as-demo token counts, specifically so `npm run demo` never spends a cent or needs an API key.
- **Not OpenTelemetry-compatible (yet).** This is a minimal, dependency-free v1 — not a claim to replace OTel. A next step (documented, not built) would be an OTel exporter so traces can also land in an existing observability backend.
- **Nesting via `AsyncLocalStorage`**, not manual span-id threading.

## What I'd build next (honest scope line)

- OTel-compatible span export (OTLP/JSON) so traces can flow into a real backend (e.g. PostHog itself, Honeycomb, Jaeger) instead of only the bundled static viewer.
- A live/streaming mode (spans pushed to the viewer as they happen, not just post-hoc JSON).
- Real LLM-call auto-instrumentation wrappers for the Anthropic/OpenAI SDKs (today you set tokens/cost yourself after the call).

## Viewer analytics

The live viewer can report product analytics to PostHog. The tracer library and the CLI never do: a library embedded in someone else's agent must never phone home. The viewer's analytics are off until a key is configured, so a fork, a local copy or this repo as checked in sends nothing.

- **What is sent, in full:** a `$pageview` and one `trace_loaded` event per rendered trace, with `source` (`example` or `upload`) and `span_bucket` (`<10`, `10-50`, `50-200`, `200+`), plus the super properties `app: "agentlens"` and `surface: "web"`. Never span names, inputs, outputs, errors, models, file names or anything else from a trace. The trace itself still never leaves the browser.
- **How:** cookieless (`cookieless_mode: "always"`, `person_profiles: "never"`, no `identify()`), no autocapture, no session replay, Do Not Track honoured. Requests go to `/ingest/*` on this origin, which `vercel.json` rewrites to PostHog, so a tracking blocker that filters by domain does not drop them and a CSP can stay at `'self'`. The SDK is downloaded only when a key exists. Turn on "Discard client IP data" in the PostHog project settings; the SDK's `ip` option is deprecated and has no effect.
- **Enable:** put the PostHog project token in `public/analytics-config.js` (`window.AGENTLENS_POSTHOG_KEY = "phc_…";`) and deploy. The token is public by design; there is no build step and no environment variable.
- **Disable:** set it back to `""`. With an empty key `public/analytics.js` injects nothing, requests nothing and logs nothing; `test/viewer-analytics.test.mjs` checks that.

## Repo

MIT licensed. `src/index.ts` (tracer), `src/render.ts` (HTML waterfall renderer), `bin/cli.mjs` (CLI), `public/` (static browser viewer, deployed as-is to Vercel), `examples/demo-agent.mjs` (the real traced demo agent above), `test/` (7 passing node:test cases).

**npm publish status:** not done. Two independent blockers: (1) `npm whoami` returns `ENEEDAUTH` in this environment — no npm credentials, same as `eval-lab`'s unresolved npm-publish gap; (2) separately, the package name `agentlens` is already taken on the npm registry by an unrelated package, so `npm install agentlens` as written above would need a rename (e.g. `@edgeorgie/agentlens`) before a publish. Installing from GitHub directly works today: `npm install github:edgeorgie/agentlens`.
