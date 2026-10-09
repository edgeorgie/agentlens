// Real demo: a tiny multi-step agent that plans and executes tool calls,
// fully instrumented with agentlens. No external API keys, no network cost —
// this demonstrates the TRACING library against a real (if simple) agent
// loop with genuine nested spans, variable latency, and one induced error
// so the waterfall shows what a failure looks like too.
import { Tracer, saveTrace } from "../dist/index.js";

// --- toy "tools" an agent might call -------------------------------------
async function searchDocs(query) {
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
  return [`doc:${query}#1`, `doc:${query}#2`];
}

async function readDoc(id) {
  await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
  if (id.endsWith("#2")) {
    // simulate a flaky tool on the second read to show error handling
    throw new Error(`fetch failed for ${id}: upstream 503`);
  }
  return `contents of ${id}`;
}

async function writeSummary(parts) {
  await new Promise((r) => setTimeout(r, 15 + Math.random() * 20));
  return `Summary of ${parts.length} doc(s): ${parts.join(" | ")}`;
}

// a fake "LLM planning call" with fake-but-plausible token counts, $0 cost
// (no real API key used — this is intentionally a stub so the demo runs
// for free; see README for how to wire a real LLM call into an `llm()` span).
async function planSteps(task) {
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 40));
  return { steps: ["search", "read", "summarize"], tokensIn: 180, tokensOut: 42 };
}

// --- the agent loop itself, fully traced ---------------------------------
async function runAgent(task) {
  const tracer = new Tracer(`demo-agent: ${task}`, { task });

  const plan = await tracer.llm(
    "plan",
    async (setAttrs) => {
      const result = await planSteps(task);
      setAttrs({
        input: { task },
        output: result.steps,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: (result.tokensIn * 0.25 + result.tokensOut * 1.25) / 1_000_000, // haiku-ish demo pricing
        model: "demo-planner-v1",
      });
      return result;
    }
  );

  return tracer.span("agent-run", "agent", async () => {
    const hits = await tracer.tool(
      "search_docs",
      async (setAttrs) => {
        const result = await searchDocs(task);
        setAttrs({ input: { query: task }, output: result });
        return result;
      }
    );

    const contents = [];
    for (const id of hits) {
      try {
        const content = await tracer.tool(
          "read_doc",
          async (setAttrs) => {
            const result = await readDoc(id);
            setAttrs({ input: { id }, output: result });
            return result;
          }
        );
        contents.push(content);
      } catch (err) {
        // agent keeps going even if one doc read fails — the trace
        // will show this span's status:"error" while the rest proceed.
        contents.push(`[skipped ${id}: ${err.message}]`);
      }
    }

    const summary = await tracer.tool(
      "write_summary",
      async (setAttrs) => {
        const result = await writeSummary(contents);
        setAttrs({ input: { parts: contents }, output: result });
        return result;
      }
    );

    return summary;
  }).finally(() => {}).then(async (summary) => {
    const trace = tracer.finish();
    await saveTrace(trace, new URL("./demo-trace.json", import.meta.url).pathname);
    console.log("agent result:", summary);
    console.log(`trace saved: examples/demo-trace.json (${trace.spans.length} spans, ${trace.durationMs}ms, $${trace.totalCostUsd.toFixed(5)})`);
    return summary;
  });
}

await runAgent("quarterly-report");
