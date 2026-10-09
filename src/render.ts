// Renders a Trace JSON object into a single self-contained HTML file
// (inline CSS/JS, no external assets, no network calls, no deps).
import type { Trace, Span } from "./index.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "running";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function kindColor(kind: string): string {
  switch (kind) {
    case "llm":
      return "#8b5cf6"; // purple
    case "tool":
      return "#22c55e"; // green
    case "retrieval":
      return "#38bdf8"; // blue
    case "agent":
      return "#f59e0b"; // amber
    default:
      return "#94a3b8"; // slate
  }
}

function depthOf(span: Span, byId: Map<string, Span>): number {
  let depth = 0;
  let cur: Span | undefined = span;
  while (cur && cur.parentId) {
    cur = byId.get(cur.parentId);
    depth++;
    if (depth > 50) break; // safety against cycles
  }
  return depth;
}

export function renderHtml(trace: Trace): string {
  const byId = new Map(trace.spans.map((s) => [s.id, s]));
  const traceStart = trace.startTime;
  const totalDuration = Math.max(1, trace.durationMs ?? 1);

  const rows = trace.spans
    .map((s) => {
      const depth = depthOf(s, byId);
      const offsetPct = ((s.startTime - traceStart) / totalDuration) * 100;
      const widthPct = Math.max(
        0.4,
        ((s.durationMs ?? Date.now() - s.startTime) / totalDuration) * 100
      );
      const color = kindColor(s.kind);
      const statusBadge =
        s.status === "error" ? "⚠ error" : s.status === "running" ? "… running" : "ok";
      const tokenStr =
        (s.attributes.tokensIn || s.attributes.tokensOut)
          ? `${s.attributes.tokensIn ?? 0}→${s.attributes.tokensOut ?? 0} tok`
          : "";
      const costStr = s.attributes.costUsd ? `$${s.attributes.costUsd.toFixed(5)}` : "";
      const meta = [tokenStr, costStr, s.attributes.model].filter(Boolean).join(" · ");
      const inputPreview = s.attributes.input !== undefined
        ? esc(JSON.stringify(s.attributes.input).slice(0, 300))
        : "";
      const outputPreview = s.attributes.output !== undefined
        ? esc(JSON.stringify(s.attributes.output).slice(0, 300))
        : "";
      const errorLine = s.attributes.error
        ? `<div class="err">error: ${esc(String(s.attributes.error))}</div>`
        : "";

      return `
      <div class="row" style="--depth:${depth}">
        <div class="label" title="${esc(s.name)}">
          <span class="dot" style="background:${color}"></span>
          <span class="name">${esc(s.name)}</span>
          <span class="kind">${esc(s.kind)}</span>
        </div>
        <div class="track">
          <div class="bar ${s.status}" style="left:${offsetPct}%;width:${widthPct}%;background:${color}" title="${fmtMs(s.durationMs)}"></div>
        </div>
        <div class="dur">${fmtMs(s.durationMs)}</div>
        <div class="status ${s.status}">${statusBadge}</div>
        <div class="meta">${esc(meta)}</div>
        <div class="io">
          ${inputPreview ? `<div class="io-row"><b>in:</b> <code>${inputPreview}</code></div>` : ""}
          ${outputPreview ? `<div class="io-row"><b>out:</b> <code>${outputPreview}</code></div>` : ""}
          ${errorLine}
        </div>
      </div>`;
    })
    .join("\n");

  const kindCounts: Record<string, number> = {};
  for (const s of trace.spans) kindCounts[s.kind] = (kindCounts[s.kind] ?? 0) + 1;
  const kindSummary = Object.entries(kindCounts)
    .map(([k, c]) => `<span class="pill" style="border-color:${kindColor(k)}">${esc(k)}: ${c}</span>`)
    .join(" ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>agentlens — ${esc(trace.name)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: #0b0f14; color: #e2e8f0;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #94a3b8; font-size: 13px; margin-bottom: 16px; }
  .summary { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat { background: #111826; border: 1px solid #1f2937; border-radius: 8px; padding: 10px 14px; min-width: 110px; }
  .stat .v { font-size: 20px; font-weight: 700; }
  .stat .k { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: .04em; }
  .pill { display: inline-block; border: 1px solid #334155; border-radius: 999px; padding: 2px 9px; font-size: 12px; margin-right: 6px; }
  .waterfall { border: 1px solid #1f2937; border-radius: 10px; overflow: hidden; }
  .row {
    display: grid;
    grid-template-columns: 260px 1fr 70px 80px 180px;
    grid-template-areas: "label track dur status meta" "io io io io io";
    align-items: center;
    gap: 6px 10px;
    padding: 6px 12px;
    padding-left: calc(12px + var(--depth) * 18px);
    border-bottom: 1px solid #141b26;
    font-size: 12.5px;
  }
  .row:nth-child(odd) { background: #0e141c; }
  .label { grid-area: label; display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .kind { color: #64748b; font-size: 10.5px; text-transform: uppercase; }
  .track { grid-area: track; position: relative; height: 16px; background: #0a0e14; border-radius: 4px; }
  .bar { position: absolute; top: 2px; height: 12px; border-radius: 3px; min-width: 2px; opacity: .9; }
  .bar.error { outline: 1px solid #ef4444; }
  .bar.running { opacity: .5; background-image: repeating-linear-gradient(45deg, rgba(255,255,255,.25) 0 4px, transparent 4px 8px); }
  .dur { grid-area: dur; text-align: right; color: #cbd5e1; font-variant-numeric: tabular-nums; }
  .status { grid-area: status; font-size: 11px; }
  .status.ok { color: #34d399; }
  .status.error { color: #f87171; }
  .status.running { color: #fbbf24; }
  .meta { grid-area: meta; color: #94a3b8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .io { grid-area: io; display: none; color: #cbd5e1; font-size: 11.5px; padding: 2px 0 6px; }
  .row:hover .io { display: block; }
  .io-row { white-space: pre-wrap; word-break: break-all; margin-top: 2px; }
  .io code { color: #a7f3d0; }
  .err { color: #f87171; margin-top: 2px; }
  footer { margin-top: 18px; color: #475569; font-size: 11px; }
  footer a { color: #64748b; }
</style>
</head>
<body>
  <h1>agentlens trace — ${esc(trace.name)}</h1>
  <div class="sub">traceId ${esc(trace.traceId)} · started ${new Date(trace.startTime).toISOString()}</div>
  <div class="summary">
    <div class="stat"><div class="v">${fmtMs(trace.durationMs)}</div><div class="k">total duration</div></div>
    <div class="stat"><div class="v">${trace.spans.length}</div><div class="k">spans</div></div>
    <div class="stat"><div class="v">${trace.totalTokens}</div><div class="k">tokens</div></div>
    <div class="stat"><div class="v">$${trace.totalCostUsd.toFixed(5)}</div><div class="k">est. cost</div></div>
    <div class="stat"><div class="v">${trace.spans.filter((s) => s.status === "error").length}</div><div class="k">errors</div></div>
  </div>
  <div style="margin-bottom:12px">${kindSummary}</div>
  <div class="waterfall">
    ${rows}
  </div>
  <footer>Generated by <a href="https://github.com/edgeorgie/agentlens">agentlens</a> — hover a row to see input/output. Static HTML, no network calls, nothing leaves this file.</footer>
</body>
</html>`;
}
