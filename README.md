# agentlens

> Zero-dependency tracing + waterfall visualizer for AI agent tool calls.

Most agent demos show you the final answer. **agentlens shows you the path there**: every tool call, every LLM call, how long each took, how they nested, what tokens/cost they burned, and exactly where things failed — rendered as an interactive waterfall, like a browser's network panel but for an agent's reasoning loop.

**Live demo (drop your own trace.json, nothing leaves your browser):** https://agentlens.vercel.app

This exists to fill a real gap: [triage-desk](https://github.com/edgeorgie/triage-desk), [eval-lab](https://github.com/edgeorgie/eval-lab) and [repoask-mcp](https://github.com/edgeorgie/repoask-mcp) are all retrieval/Q&A or pass-fail-eval shaped. None of them show *how* an agent got to an answer, step by step, with latency/cost broken out per step. agentlens is the observability layer: instrument any agent loop with a few lines, get a trace.json, render it as a real waterfall.

## Why this, why now

PostHog's own product is "capture all the context agents need to diagnose problems" — session replay, traces, latency, cost, for products in general. agentlens applies the same idea one layer up: to the agent itself, not just the app it's acting on. This is a minimal, honest v1 of that idea — not a claim to compete with PostHog's actual product — built to demonstrate the capability and the instinct for it.

## Install

```bash
npm install agentlens
```

No dependencies beyond Node's built-in `node:async_hooks` and `node:crypto`. Works in any Node 18+ environment.

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

Or drop the trace.json straight into the [live viewer](https://agentlens.vercel.app) — same renderer, runs fully client-side, nothing uploaded.

## Real, verified output (not a mockup)

`npm run demo` runs a small but genuine multi-step agent (plan → search_docs → read_doc ×2 → write_summary, one read deliberately fails to show error handling) fully instrumented with agentlens, and renders it. Actual output from a real run:

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

5/5 unit tests pass locally (`npm test`): nested span parent/child correctness, concurrent-sibling isolation (two tool calls in `Promise.all` don't cross-contaminate each other's parent context), error capture without losing the trace, token/cost summation, and HTML self-containment (no external network calls baked into the rendered file).

## Design choices, stated plainly

- **Zero runtime dependencies.** No OpenTelemetry SDK, no vendor lock-in, no server required. A trace is just JSON; the renderer is a single HTML file.
- **Cost/tokens are optional fields you set yourself** (`setAttrs({ tokensIn, tokensOut, costUsd, model })`) — agentlens doesn't call any LLM API or know your provider's pricing; it just sums whatever you report. This keeps the library itself at exactly $0 marginal cost — the demo above uses a stubbed "planner" with fabricated-but-labeled-as-demo token counts, specifically so `npm run demo` never spends a cent or needs an API key.
- **Not OpenTelemetry-compatible (yet).** This is a minimal, dependency-free v1 built in one session to prove the capability — not a claim to replace OTel. A real next step (documented, not built) would be an OTel exporter so traces can also land in an existing observability backend.
- **Nesting via `AsyncLocalStorage`**, not manual span-id threading — the ergonomics PostHog's own SDKs use for request context, applied here to agent tool-call context.

## What I'd build next (honest scope line)

- OTel-compatible span export (OTLP/JSON) so traces can flow into a real backend (e.g. PostHog itself, Honeycomb, Jaeger) instead of only the bundled static viewer.
- A live/streaming mode (spans pushed to the viewer as they happen, not just post-hoc JSON).
- Real LLM-call auto-instrumentation wrappers for the Anthropic/OpenAI SDKs (today you set tokens/cost yourself after the call).

## Repo

MIT licensed. `src/index.ts` (tracer), `src/render.ts` (HTML waterfall renderer), `bin/cli.mjs` (CLI), `public/` (static browser viewer, deployed as-is to Vercel), `examples/demo-agent.mjs` (the real traced demo agent above), `test/` (5 passing node:test cases).
