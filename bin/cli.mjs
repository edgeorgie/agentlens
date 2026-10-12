#!/usr/bin/env node
// agentlens CLI: render a trace.json into a waterfall HTML, or print summary stats.
import { loadTrace } from "../dist/index.js";
import { renderHtml } from "../dist/render.js";
import { writeFile } from "node:fs/promises";

function usage() {
  console.log(`agentlens — tracing + waterfall visualizer for AI agent runs

Usage:
  agentlens view <trace.json> [-o out.html]   Render a trace to a self-contained HTML waterfall
  agentlens stats <trace.json>                Print summary stats (duration, tokens, cost, errors)
  agentlens compare <a.json> <b.json>         Compare two traces (duration/token/cost delta, new errors)
`);
}

/**
 * Render a trace to a self-contained HTML waterfall.
 * @param {string[]} args Positional args after `view`: `<trace.json> [-o out.html]`.
 * @returns {Promise<void>}
 */
async function cmdView(args) {
  const inPath = args[0];
  if (!inPath) return usage();
  const outFlagIdx = args.indexOf("-o");
  const outPath = outFlagIdx >= 0 ? args[outFlagIdx + 1] : inPath.replace(/\.json$/, "") + ".html";
  const trace = await loadTrace(inPath);
  const html = renderHtml(trace);
  await writeFile(outPath, html, "utf8");
  console.log(`agentlens: wrote ${outPath} (${trace.spans.length} spans, ${trace.durationMs}ms total)`);
}

/**
 * Print summary stats for one trace: duration, span count, tokens, cost, errors,
 * and a per-kind breakdown.
 * @param {string[]} args Positional args after `stats`: `<trace.json>`.
 * @returns {Promise<void>}
 */
async function cmdStats(args) {
  const inPath = args[0];
  if (!inPath) return usage();
  const trace = await loadTrace(inPath);
  const errors = trace.spans.filter((s) => s.status === "error").length;
  /**
   * Accumulator keyed by `SpanKind`. Declared as a `Partial` record rather than a
   * bare `{}` so indexing it with `s.kind` is checked against the real union —
   * a typo like `byKind[s.knid]` is a compile error, not a silent `undefined`.
   * @type {Partial<Record<import("../dist/index.js").SpanKind, { count: number, totalMs: number }>>}
   */
  const byKind = {};
  for (const s of trace.spans) {
    const bucket = (byKind[s.kind] ??= { count: 0, totalMs: 0 });
    bucket.count++;
    bucket.totalMs += s.durationMs ?? 0;
  }
  console.log(`agentlens stats — ${trace.name} (${trace.traceId})`);
  console.log(`  total duration : ${trace.durationMs}ms`);
  console.log(`  spans          : ${trace.spans.length}`);
  console.log(`  tokens         : ${trace.totalTokens}`);
  console.log(`  cost           : $${trace.totalCostUsd.toFixed(5)}`);
  console.log(`  errors         : ${errors}`);
  console.log(`  by kind:`);
  for (const [k, v] of Object.entries(byKind)) {
    console.log(`    ${k.padEnd(10)} count=${v.count} totalMs=${v.totalMs}`);
  }
}

/**
 * Compare two traces and report duration/token/cost deltas plus error-count change.
 * Sets a non-zero exit code when the error count regressed, so this is usable as a
 * CI gate.
 * @param {string[]} args Positional args after `compare`: `<a.json> <b.json>`.
 * @returns {Promise<void>}
 */
async function cmdCompare(args) {
  const [aPath, bPath] = args;
  if (!aPath || !bPath) return usage();
  const [a, b] = await Promise.all([loadTrace(aPath), loadTrace(bPath)]);
  const aErr = a.spans.filter((s) => s.status === "error").length;
  const bErr = b.spans.filter((s) => s.status === "error").length;
  const durDelta = (b.durationMs ?? 0) - (a.durationMs ?? 0);
  const tokDelta = b.totalTokens - a.totalTokens;
  const costDelta = b.totalCostUsd - a.totalCostUsd;
  console.log(`agentlens compare: ${a.name} -> ${b.name}`);
  console.log(`  duration: ${a.durationMs}ms -> ${b.durationMs}ms (${durDelta >= 0 ? "+" : ""}${durDelta}ms)`);
  console.log(`  tokens  : ${a.totalTokens} -> ${b.totalTokens} (${tokDelta >= 0 ? "+" : ""}${tokDelta})`);
  console.log(`  cost    : $${a.totalCostUsd.toFixed(5)} -> $${b.totalCostUsd.toFixed(5)} (${costDelta >= 0 ? "+" : ""}${costDelta.toFixed(5)})`);
  console.log(`  errors  : ${aErr} -> ${bErr}`);
  if (bErr > aErr) {
    console.log(`  REGRESSION: error count increased`);
    process.exitCode = 1;
  }
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "view":
    await cmdView(rest);
    break;
  case "stats":
    await cmdStats(rest);
    break;
  case "compare":
    await cmdCompare(rest);
    break;
  default:
    usage();
}
