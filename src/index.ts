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

/** Load a Trace from a JSON file (for the CLI / renderer). */
export async function loadTrace(path: string): Promise<Trace> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Trace;
}
