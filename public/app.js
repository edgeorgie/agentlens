// agentlens static browser viewer — same rendering logic as src/render.ts,
// ported to vanilla JS so it runs with zero build step / zero backend.
// Nothing here ever makes a network request with the loaded trace data.

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "running";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function kindColor(kind) {
  switch (kind) {
    case "llm": return "#8b5cf6";
    case "tool": return "#22c55e";
    case "retrieval": return "#38bdf8";
    case "agent": return "#f59e0b";
    default: return "#94a3b8";
  }
}

function depthOf(span, byId) {
  let depth = 0;
  let cur = span;
  while (cur && cur.parentId) {
    cur = byId.get(cur.parentId);
    depth++;
    if (depth > 50) break;
  }
  return depth;
}

function renderTrace(trace) {
  const byId = new Map(trace.spans.map((s) => [s.id, s]));
  const traceStart = trace.startTime;
  const totalDuration = Math.max(1, trace.durationMs ?? 1);

  const rows = trace.spans.map((s) => {
    const depth = depthOf(s, byId);
    const offsetPct = ((s.startTime - traceStart) / totalDuration) * 100;
    const widthPct = Math.max(0.4, ((s.durationMs ?? 0) / totalDuration) * 100);
    const color = kindColor(s.kind);
    const statusBadge = s.status === "error" ? "⚠ error" : s.status === "running" ? "… running" : "ok";
    const tokenStr = (s.attributes.tokensIn || s.attributes.tokensOut)
      ? `${s.attributes.tokensIn ?? 0}→${s.attributes.tokensOut ?? 0} tok` : "";
    const costStr = s.attributes.costUsd ? `$${s.attributes.costUsd.toFixed(5)}` : "";
    const meta = [tokenStr, costStr, s.attributes.model].filter(Boolean).join(" · ");
    const inputPreview = s.attributes.input !== undefined ? esc(JSON.stringify(s.attributes.input).slice(0, 300)) : "";
    const outputPreview = s.attributes.output !== undefined ? esc(JSON.stringify(s.attributes.output).slice(0, 300)) : "";
    const errorLine = s.attributes.error ? `<div class="err">error: ${esc(s.attributes.error)}</div>` : "";

    return `
    <div class="row" style="padding-left:calc(12px + ${depth} * 18px)">
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
  }).join("\n");

  const kindCounts = {};
  for (const s of trace.spans) kindCounts[s.kind] = (kindCounts[s.kind] ?? 0) + 1;
  const kindSummary = Object.entries(kindCounts)
    .map(([k, c]) => `<span class="pill" style="border-color:${kindColor(k)}">${esc(k)}: ${c}</span>`)
    .join(" ");

  const errCount = trace.spans.filter((s) => s.status === "error").length;

  document.getElementById("result").innerHTML = `
    <h2 style="font-size:16px;margin:4px 0">${esc(trace.name)}</h2>
    <div class="sub">traceId ${esc(trace.traceId)} · started ${new Date(trace.startTime).toISOString()}</div>
    <div class="summary">
      <div class="stat"><div class="v">${fmtMs(trace.durationMs)}</div><div class="k">total duration</div></div>
      <div class="stat"><div class="v">${trace.spans.length}</div><div class="k">spans</div></div>
      <div class="stat"><div class="v">${trace.totalTokens}</div><div class="k">tokens</div></div>
      <div class="stat"><div class="v">$${trace.totalCostUsd.toFixed(5)}</div><div class="k">est. cost</div></div>
      <div class="stat"><div class="v">${errCount}</div><div class="k">errors</div></div>
    </div>
    <div style="margin-bottom:12px">${kindSummary}</div>
    <div class="waterfall">${rows}</div>
  `;
}

// Coarse size of a trace, so no exact count can single out a visitor. This is
// the only thing the viewer reports about a trace: span names, inputs, outputs,
// errors, models and file names never leave the browser.
function spanBucket(count) {
  if (count < 10) return "<10";
  if (count < 50) return "10-50";
  if (count < 200) return "50-200";
  return "200+";
}

function reportTraceLoaded(trace, source) {
  if (typeof window.agentlensTrack !== "function") return;
  window.agentlensTrack("trace_loaded", { source, span_bucket: spanBucket(trace.spans.length) });
}

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const trace = JSON.parse(reader.result);
      renderTrace(trace);
      reportTraceLoaded(trace, "upload");
    } catch (e) {
      document.getElementById("result").innerHTML = `<div style="color:#f87171">Could not parse trace.json: ${esc(e.message)}</div>`;
    }
  };
  reader.readAsText(file);
}

async function loadDemo() {
  const res = await fetch("demo-trace.json");
  const trace = await res.json();
  renderTrace(trace);
  reportTraceLoaded(trace, "example");
}

const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");

drop.addEventListener("click", (e) => {
  if (e.target.tagName !== "BUTTON") fileInput.click();
});
fileInput.addEventListener("change", (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});
["dragenter", "dragover"].forEach((evt) =>
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add("drag"); })
);
["dragleave", "drop"].forEach((evt) =>
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove("drag"); })
);
drop.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
