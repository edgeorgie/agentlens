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

async function cmdStats(args) {
  const inPath = args[0];
  if (!inPath) return usage();
  const trace = await loadTrace(inPath);
  const errors = trace.spans.filter((s) => s.status === "error").length;
  const byKind = {};
  for (const s of trace.spans) {
    byKind[s.kind] = byKind[s.kind] ?? { count: 0, totalMs: 0 };
    byKind[s.kind].count++;
    byKind[s.kind].totalMs += s.durationMs ?? 0;
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
