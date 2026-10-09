import test from "node:test";
import assert from "node:assert/strict";
import { Tracer } from "../dist/index.js";
import { renderHtml } from "../dist/render.js";

test("captures nested spans with correct parent/child via AsyncLocalStorage", async () => {
  const tracer = new Tracer("test-trace");
  await tracer.span("outer", "agent", async () => {
    await tracer.tool("inner-a", async (set) => {
      set({ output: "a" });
      return "a";
    });
    await tracer.tool("inner-b", async (set) => {
      set({ output: "b" });
      return "b";
    });
  });
  const trace = tracer.finish();
  assert.equal(trace.spans.length, 3);
  const outer = trace.spans.find((s) => s.name === "outer");
  const a = trace.spans.find((s) => s.name === "inner-a");
  const b = trace.spans.find((s) => s.name === "inner-b");
  assert.equal(a.parentId, outer.id);
  assert.equal(b.parentId, outer.id);
  assert.equal(outer.parentId, null);
});

test("records error status and message when a span's fn throws, without losing the trace", async () => {
  const tracer = new Tracer("test-trace-error");
  await assert.rejects(
    tracer.tool("boom", async () => {
      throw new Error("kaboom");
    })
  );
  const trace = tracer.finish();
  assert.equal(trace.spans.length, 1);
  assert.equal(trace.spans[0].status, "error");
  assert.equal(trace.spans[0].attributes.error, "kaboom");
});

test("sums tokens and cost across spans into trace totals", async () => {
  const tracer = new Tracer("test-trace-cost");
  await tracer.llm("call-1", async (set) => {
    set({ tokensIn: 100, tokensOut: 20, costUsd: 0.001 });
    return "ok";
  });
  await tracer.llm("call-2", async (set) => {
    set({ tokensIn: 50, tokensOut: 10, costUsd: 0.0005 });
    return "ok";
  });
  const trace = tracer.finish();
  assert.equal(trace.totalTokens, 180);
  assert.ok(Math.abs(trace.totalCostUsd - 0.0015) < 1e-9);
});

test("concurrent sibling spans do not cross-contaminate parent context", async () => {
  const tracer = new Tracer("test-trace-concurrent");
  await tracer.span("root", "agent", async () => {
    await Promise.all([
      tracer.tool("concurrent-a", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return "a";
      }),
      tracer.tool("concurrent-b", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return "b";
      }),
    ]);
  });
  const trace = tracer.finish();
  const root = trace.spans.find((s) => s.name === "root");
  const a = trace.spans.find((s) => s.name === "concurrent-a");
  const b = trace.spans.find((s) => s.name === "concurrent-b");
  assert.equal(a.parentId, root.id);
  assert.equal(b.parentId, root.id);
});

test("renderHtml produces self-contained HTML with no external references", () => {
  const tracer = new Tracer("render-test");
  // synchronous-ish trace for a deterministic render
  const trace = {
    traceId: "t1",
    name: "render-test",
    startTime: Date.now(),
    endTime: Date.now() + 100,
    durationMs: 100,
    totalTokens: 10,
    totalCostUsd: 0.0001,
    meta: {},
    spans: [
      {
        id: "s1",
        parentId: null,
        name: "step-1",
        kind: "tool",
        startTime: Date.now(),
        endTime: Date.now() + 50,
        durationMs: 50,
        status: "ok",
        attributes: { input: { x: 1 }, output: "done" },
      },
    ],
  };
  const html = renderHtml(trace);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /step-1/);
  assert.doesNotMatch(html, /https?:\/\/(?!github\.com)/); // only the footer github link is allowed
});
