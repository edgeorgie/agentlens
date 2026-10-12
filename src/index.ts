// agentlens core tracing API.
// Zero runtime dependencies (uses only Node's AsyncLocalStorage from node:async_hooks).
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type SpanKind = "agent" | "llm" | "tool" | "retrieval" | "custom";
export type SpanStatus = "ok" | "error" | "running";

export interface SpanAttributes {
  /** Arbitrary JSON-serializable input to the step (e.g. tool args, prompt). */
  input?: unknown;
  /** Arbitrary JSON-serializable output of the step (e.g. tool result, completion). */
  output?: unknown;
  /** Prompt/input tokens, if this span represents an LLM call. */
  tokensIn?: number;
  /** Completion/output tokens, if this span represents an LLM call. */
  tokensOut?: number;
  /** Estimated USD cost of this span, if known. */
  costUsd?: number;
  /** Model name, if this span represents an LLM call. */
  model?: string;
  /** Error message, set automatically if the wrapped function throws. */
  error?: string;
  /** Free-form extra metadata. */
  [key: string]: unknown;
}

export interface Span {
  id: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  startTime: number; // epoch ms
  endTime: number | null; // epoch ms, null while running
  durationMs: number | null;
  status: SpanStatus;
  attributes: SpanAttributes;
}

export interface Trace {
  traceId: string;
  name: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  spans: Span[];
  /** Sum of attributes.tokensIn + tokensOut across all spans. */
  totalTokens: number;
  /** Sum of attributes.costUsd across all spans. */
  totalCostUsd: number;
  meta: Record<string, unknown>;
}

interface ActiveContext {
  spanId: string | null;
}

/**
 * Tracer captures a tree of nested spans for one agent run (one Trace).
 * Create one Tracer per agent invocation (e.g. per issue triaged, per task run).
 */
export class Tracer {
  readonly traceId: string;
  private readonly name: string;
  private readonly startTime: number;
  private endTime: number | null = null;
  private readonly spans: Map<string, Span> = new Map();
  private readonly order: string[] = [];
  private readonly als = new AsyncLocalStorage<ActiveContext>();
  private readonly meta: Record<string, unknown>;

  constructor(name: string, meta: Record<string, unknown> = {}) {
    this.traceId = randomUUID();
    this.name = name;
    this.startTime = Date.now();
    this.meta = meta;
  }

  private currentParentId(): string | null {
    return this.als.getStore()?.spanId ?? null;
  }

  /**
   * Wrap an async step as a traced span. Nesting is automatic: any span()
   * call made inside `fn` (even across awaits) becomes a child of this span,
   * via AsyncLocalStorage — no manual parent-id plumbing required.
   */
  async span<T>(
    name: string,
    kind: SpanKind,
    fn: (setAttrs: (attrs: Partial<SpanAttributes>) => void) => Promise<T>,
    attrs: Partial<SpanAttributes> = {}
  ): Promise<T> {
    const id = randomUUID();
    const parentId = this.currentParentId();
    const span: Span = {
      id,
      parentId,
      name,
      kind,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      status: "running",
      attributes: { ...attrs },
    };
    this.spans.set(id, span);
    this.order.push(id);

    const setAttrs = (more: Partial<SpanAttributes>) => {
      Object.assign(span.attributes, more);
    };

    return this.als.run({ spanId: id }, async () => {
      try {
        const result = await fn(setAttrs);
        span.status = "ok";
        return result;
      } catch (err) {
        span.status = "error";
        span.attributes.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        span.endTime = Date.now();
        span.durationMs = span.endTime - span.startTime;
      }
    });
  }

  /** Convenience for a tool-call span (the most common case for agent loops). */
  tool<T>(
    name: string,
    fn: (setAttrs: (attrs: Partial<SpanAttributes>) => void) => Promise<T>,
    attrs: Partial<SpanAttributes> = {}
  ): Promise<T> {
    return this.span(name, "tool", fn, attrs);
  }

  /** Convenience for an LLM-call span. Pass tokensIn/tokensOut/costUsd/model in attrs or via setAttrs. */
  llm<T>(
    name: string,
    fn: (setAttrs: (attrs: Partial<SpanAttributes>) => void) => Promise<T>,
    attrs: Partial<SpanAttributes> = {}
  ): Promise<T> {
    return this.span(name, "llm", fn, attrs);
  }

  /** Finalize the trace and return the exportable JSON object. Call once, after the agent run completes. */
  finish(): Trace {
    this.endTime = Date.now();
    const spans = this.order.map((id) => this.spans.get(id)!);
    let totalTokens = 0;
    let totalCostUsd = 0;
    for (const s of spans) {
      totalTokens += (s.attributes.tokensIn ?? 0) + (s.attributes.tokensOut ?? 0);
      totalCostUsd += s.attributes.costUsd ?? 0;
    }
    return {
      traceId: this.traceId,
      name: this.name,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.endTime - this.startTime,
      spans,
      totalTokens,
      totalCostUsd,
      meta: this.meta,
    };
  }
}

/** Write a Trace to a JSON file. */
export async function saveTrace(trace: Trace, path: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify(trace, null, 2), "utf8");
}

/**
 * Aggregates spans by kind: `{ count, totalMs }` per kind, insertion-ordered.
 *
 * A `Map`, NOT an object literal, and that is the whole point of this function
 * existing in `src/` rather than inline in the CLI.
 *
 * The CLI previously accumulated into a `{}` with
 * `byKind[s.kind] ??= { count: 0, totalMs: 0 }`. For a span whose `kind`
 * collides with an `Object.prototype` member (`constructor`, `toString`), that
 * lookup returns the INHERITED value, which is not nullish, so `??=` assigned
 * nothing, no own property was created, and `Object.entries` omitted the
 * bucket: the span VANISHED from the latency breakdown while the span count
 * printed above it still included it. (The revision before that printed a
 * visible `count=NaN` row for the same input — garbage, but not silent. The
 * `??=` rewrite was described in its PR as "incidental: one lookup instead of
 * four". It was not behaviour-preserving.)
 *
 * `loadTrace` now validates `kind` against the real union, so a hostile kind
 * does not survive the file boundary. This is the second layer, for any caller
 * that constructs a Trace itself — and the layer that is directly unit
 * testable, which the inline version was not.
 */
export function summarizeByKind(
  spans: readonly Span[],
): Map<string, { count: number; totalMs: number }> {
  const byKind = new Map<string, { count: number; totalMs: number }>();
  for (const s of spans) {
    let bucket = byKind.get(s.kind);
    if (bucket === undefined) {
      bucket = { count: 0, totalMs: 0 };
      byKind.set(s.kind, bucket);
    }
    bucket.count++;
    bucket.totalMs += s.durationMs ?? 0;
  }
  return byKind;
}

const SPAN_KINDS: readonly SpanKind[] = [
  "agent",
  "llm",
  "tool",
  "retrieval",
  "custom",
];
const SPAN_STATUSES: readonly SpanStatus[] = ["ok", "error", "running"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a parsed JSON value as a Trace.
 *
 * This exists because `loadTrace` used to be `JSON.parse(raw) as Trace` — an
 * unchecked assertion about data the library does not produce. A trace.json is
 * attacker-influenceable (span names and kinds come from whatever agent loop
 * was instrumented), so every downstream `kind: SpanKind` annotation was a type
 * assertion the compiler believed and the data need not satisfy. That lie had a
 * concrete cost: the CLI's by-kind accumulator silently DROPPED any span whose
 * `kind` collided with an `Object.prototype` member, and `tsc` could not see it
 * because the type said such a kind was impossible.
 *
 * The honest fix is to make the assertion true at the boundary. Checks are
 * structural and shallow-but-real: enough that every field the renderer and the
 * CLI dereference exists with the right type, and that `kind`/`status` are
 * actually in their unions. `attributes` and `meta` stay open by design — they
 * are documented as free-form.
 *
 * @throws {TypeError} with a message naming the offending path, not a stack
 *   trace from deep inside the renderer
 */
export function validateTrace(value: unknown, source = "trace"): Trace {
  const fail = (message: string): never => {
    throw new TypeError(`${source} is not a valid agentlens trace: ${message}`);
  };

  if (!isRecord(value)) {
    return fail(
      `expected a JSON object, got ${Array.isArray(value) ? "an array" : typeof value}`,
    );
  }
  for (const key of ["traceId", "name"] as const) {
    if (typeof value[key] !== "string") fail(`\`${key}\` must be a string`);
  }
  for (const key of ["startTime", "totalTokens", "totalCostUsd"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      fail(`\`${key}\` must be a finite number`);
    }
  }
  for (const key of ["endTime", "durationMs"] as const) {
    const v = value[key];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
      fail(`\`${key}\` must be a finite number or null`);
    }
  }
  if (!Array.isArray(value.spans)) fail("`spans` must be an array");
  if (value.meta !== undefined && !isRecord(value.meta)) {
    fail("`meta` must be an object when present");
  }

  const spans = value.spans as unknown[];
  spans.forEach((span, i) => {
    const at = `spans[${i}]`;
    if (!isRecord(span)) return void fail(`${at} must be an object`);
    for (const key of ["id", "name"] as const) {
      if (typeof span[key] !== "string") fail(`${at}.${key} must be a string`);
    }
    if (span.parentId !== null && typeof span.parentId !== "string") {
      fail(`${at}.parentId must be a string or null`);
    }
    if (!SPAN_KINDS.includes(span.kind as SpanKind)) {
      fail(
        `${at}.kind is ${JSON.stringify(span.kind)}, which is not one of ` +
          `${SPAN_KINDS.join(", ")}. Reporting that here rather than ` +
          "accepting it is deliberate: an out-of-union kind used to survive " +
          "to the CLI's by-kind breakdown and silently vanish from it.",
      );
    }
    if (!SPAN_STATUSES.includes(span.status as SpanStatus)) {
      fail(
        `${at}.status is ${JSON.stringify(span.status)}, not one of ` +
          SPAN_STATUSES.join(", "),
      );
    }
    if (typeof span.startTime !== "number" || !Number.isFinite(span.startTime)) {
      fail(`${at}.startTime must be a finite number`);
    }
    for (const key of ["endTime", "durationMs"] as const) {
      const v = span[key];
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
        fail(`${at}.${key} must be a finite number or null`);
      }
    }
    if (span.attributes !== undefined && !isRecord(span.attributes)) {
      fail(`${at}.attributes must be an object when present`);
    }
  });

  return value as unknown as Trace;
}

/** Load a Trace from a JSON file (for the CLI / renderer). */
export async function loadTrace(path: string): Promise<Trace> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateTrace(parsed, path);
}
