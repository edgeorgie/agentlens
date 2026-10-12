import test from "node:test";
import assert from "node:assert/strict";
import { Tracer, summarizeByKind, validateTrace } from "../dist/index.js";
import { renderHtml } from "../dist/render.js";

// ---------------------------------------------------------------------------
// summarizeByKind — prototype safety
//
// This is a direct unit test of the aggregation the CLI's `stats` command
// prints, and it exists because that aggregation used to be inline in
// bin/cli.mjs where nothing could reach it. The bug it guards is real and
// shipped: with an object-literal accumulator and `byKind[k] ??= {…}`, a span
// whose `kind` collides with an `Object.prototype` member silently disappeared
// from the breakdown while the span count printed above it still counted it.
// ---------------------------------------------------------------------------

for (const hostile of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
  test(`summarizeByKind counts a span whose kind is "${hostile}"`, () => {
    const spans = [
      { id: "a", parentId: null, name: "ok", kind: "tool", startTime: 0, endTime: 10, durationMs: 10, status: "ok", attributes: {} },
      { id: "b", parentId: null, name: "hostile", kind: hostile, startTime: 0, endTime: 25, durationMs: 25, status: "ok", attributes: {} },
    ];
    const byKind = summarizeByKind(spans);

    assert.equal(
      byKind.size,
      2,
      `a span with kind "${hostile}" was dropped from the breakdown entirely. ` +
        "That is the silent-data-loss bug this test exists for: the span count " +
        "elsewhere in the report would still include it, so the report " +
        "contradicts itself.",
    );
    assert.deepEqual(byKind.get(hostile), { count: 1, totalMs: 25 });
    assert.deepEqual(byKind.get("tool"), { count: 1, totalMs: 10 });

    // The counts must be real numbers, not the NaN the pre-`??=` revision
    // produced by incrementing a property read off `Object.prototype`.
    for (const [, v] of byKind) {
      assert.ok(Number.isFinite(v.count) && Number.isFinite(v.totalMs), "NaN in the breakdown");
    }
  });
}

test("summarizeByKind does not write to Object.prototype", () => {
  summarizeByKind([
    { id: "a", parentId: null, name: "x", kind: "constructor", startTime: 0, endTime: 1, durationMs: 1, status: "ok", attributes: {} },
  ]);
  assert.ok(!Object.hasOwn(Object.prototype, "count"), "Object.prototype.count was created");
  assert.ok(!Object.hasOwn(Object.prototype, "totalMs"), "Object.prototype.totalMs was created");
});

test("summarizeByKind treats a null durationMs as zero, not NaN", () => {
  const byKind = summarizeByKind([
    { id: "a", parentId: null, name: "running", kind: "llm", startTime: 0, endTime: null, durationMs: null, status: "running", attributes: {} },
  ]);
  assert.deepEqual(byKind.get("llm"), { count: 1, totalMs: 0 });
});

// ---------------------------------------------------------------------------
// validateTrace — loadTrace's `as Trace` was a cast over untrusted input
// ---------------------------------------------------------------------------

test("validateTrace accepts a well-formed trace unchanged", () => {
  const ok = {
    traceId: "t", name: "n", startTime: 0, endTime: 5, durationMs: 5,
    totalTokens: 0, totalCostUsd: 0, meta: {},
    spans: [{ id: "a", parentId: null, name: "s", kind: "tool", startTime: 0, endTime: 5, durationMs: 5, status: "ok", attributes: {} }],
  };
  assert.equal(validateTrace(ok), ok);
});

for (const [label, value, pattern] of /** @type {[string, unknown, RegExp][]} */ ([
  ["a non-object", 42, /expected a JSON object/],
  ["an array", [], /expected a JSON object/],
  ["a missing traceId", { name: "n", startTime: 0, endTime: 1, durationMs: 1, totalTokens: 0, totalCostUsd: 0, spans: [] }, /`traceId` must be a string/],
  ["spans not an array", { traceId: "t", name: "n", startTime: 0, endTime: 1, durationMs: 1, totalTokens: 0, totalCostUsd: 0, spans: {} }, /`spans` must be an array/],
  [
    "an out-of-union span kind",
    { traceId: "t", name: "n", startTime: 0, endTime: 1, durationMs: 1, totalTokens: 0, totalCostUsd: 0, spans: [{ id: "a", parentId: null, name: "s", kind: "constructor", startTime: 0, endTime: 1, durationMs: 1, status: "ok", attributes: {} }] },
    /spans\[0\]\.kind is "constructor"/,
  ],
  [
    "an out-of-union span status",
    { traceId: "t", name: "n", startTime: 0, endTime: 1, durationMs: 1, totalTokens: 0, totalCostUsd: 0, spans: [{ id: "a", parentId: null, name: "s", kind: "tool", startTime: 0, endTime: 1, durationMs: 1, status: "eror", attributes: {} }] },
    /spans\[0\]\.status is "eror"/,
  ],
])) {
  test(`validateTrace rejects ${label}`, () => {
    // RegExp, never a bare string: `assert.throws(fn, "text")` treats the
    // string as the assertion's OWN message and accepts any error at all.
    assert.throws(() => validateTrace(value), pattern);
  });
}

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
