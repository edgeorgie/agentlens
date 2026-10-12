#!/usr/bin/env node
// agentlens CLI: render a trace.json into a waterfall HTML, or print summary stats.
import { loadTrace, summarizeByKind } from "../dist/index.js";
import { renderHtml } from "../dist/render.js";
import { writeFile } from "node:fs/promises";

// Exit codes are part of this CLI's contract, because `agentlens compare` is
// documented as usable as a CI gate and anything scripting it has to be able to
// tell the three outcomes apart:
//
//   0  success (and, for `compare`, no regression)
//   1  the command ran and reported a regression / a trace failed to load
//   2  the INVOCATION was wrong: unknown command, missing argument, flag
//      without its value
//
// Code 2 is new. Previously every bad invocation printed usage and exited 0,
// so `agentlens vieww t.json || echo failed` printed nothing and a typo in a
// CI script was indistinguishable from success. A CLI that cannot report "you
// called me wrong" is the same defect class as a required check that cannot
// report red.
const EXIT_USAGE = 2;
const EXIT_ERROR = 1;

/**
 * @typedef {(args: string[]) => Promise<void>} CommandHandler
 */

/**
 * The command names this CLI accepts.
 *
 * This union plus the `Record<Command, CommandHandler>` annotation on
 * `COMMANDS` below is what makes argv dispatch typecheckable: a misspelled key
 * in the table is an excess-property error AND a missing-property error, and a
 * command added here without a handler is a missing-property error. See the
 * HONEST LIMITS note at the bottom of this file for what types still cannot
 * catch here.
 *
 * @typedef {"view" | "stats" | "compare"} Command
 */

/**
 * Prints the usage block.
 *
 * @param {boolean} [toStderr] write to stderr (for an invocation error) rather
 *   than stdout (for an explicit `--help`)
 * @returns {void}
 */
function usage(toStderr = false) {
  const text = `agentlens — tracing + waterfall visualizer for AI agent runs

Usage:
  agentlens view <trace.json> [-o out.html]   Render a trace to a self-contained HTML waterfall
  agentlens stats <trace.json>                Print summary stats (duration, tokens, cost, errors)
  agentlens compare <a.json> <b.json>         Compare two traces (duration/token/cost delta, new errors)

Exit codes: 0 ok, 1 regression or unreadable trace, 2 bad invocation.
`;
  if (toStderr) console.error(text);
  else console.log(text);
}

/**
 * Reports a bad invocation: message on stderr, usage on stderr, exit 2.
 *
 * `process.exitCode` rather than `process.exit()` so buffered stderr is
 * flushed before the process ends.
 *
 * @param {string} message
 * @returns {void}
 */
function usageError(message) {
  console.error(`agentlens: ${message}`);
  usage(true);
  process.exitCode = EXIT_USAGE;
}

/**
 * Reads the value of a `-o`/`--out` flag, if present.
 *
 * Returns `null` when the flag is absent and `undefined` when it is present
 * with no value after it — two cases the caller must treat differently. The
 * second one used to reach `writeFile(undefined, …)` and die with a raw
 * `ERR_INVALID_ARG_TYPE` stack trace from node:internal (verified against the
 * published entrypoint: `agentlens view t.json -o` → unhandled TypeError,
 * exit 1). `noUncheckedIndexedAccess` in tsconfig.check.json is what makes
 * that `undefined` visible to the compiler rather than typed away as `string`.
 *
 * @param {string[]} args
 * @returns {string | null | undefined}
 */
function readOutFlag(args) {
  const idx = args.findIndex((a) => a === "-o" || a === "--out");
  if (idx < 0) return null;
  return args[idx + 1];
}

/**
 * Render a trace to a self-contained HTML waterfall.
 * @param {string[]} args Positional args after `view`: `<trace.json> [-o out.html]`.
 * @returns {Promise<void>}
 */
async function cmdView(args) {
  const inPath = args[0];
  if (inPath === undefined) {
    return usageError("`view` needs a trace file: agentlens view <trace.json> [-o out.html]");
  }
  const outFlag = readOutFlag(args);
  if (outFlag === undefined) {
    return usageError("`-o` was given with no filename after it");
  }
  const outPath = outFlag ?? inPath.replace(/\.json$/, "") + ".html";
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
  if (inPath === undefined) {
    return usageError("`stats` needs a trace file: agentlens stats <trace.json>");
  }
  const trace = await loadTrace(inPath);
  const errors = trace.spans.filter((s) => s.status === "error").length;
  // Aggregation lives in `src/` (`summarizeByKind`) rather than inline here,
  // deliberately. Inline, it was untestable except through the CLI, and the
  // CLI path is now guarded earlier by `loadTrace`'s validation — so a
  // regression in the accumulator itself (the `??=`-on-an-object-literal bug
  // that silently dropped spans whose kind collided with `Object.prototype`)
  // would have had no test that could reach it. See the function's own
  // comment, and test/agentlens.test.mjs for the direct unit test.
  const byKind = summarizeByKind(trace.spans);
  console.log(`agentlens stats — ${trace.name} (${trace.traceId})`);
  console.log(`  total duration : ${trace.durationMs}ms`);
  console.log(`  spans          : ${trace.spans.length}`);
  console.log(`  tokens         : ${trace.totalTokens}`);
  console.log(`  cost           : $${trace.totalCostUsd.toFixed(5)}`);
  console.log(`  errors         : ${errors}`);
  console.log(`  by kind:`);
  for (const [k, v] of byKind) {
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
  if (aPath === undefined || bPath === undefined) {
    return usageError("`compare` needs two trace files: agentlens compare <a.json> <b.json>");
  }
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
    process.exitCode = EXIT_ERROR;
  }
}

/**
 * The command table. `Record<Command, CommandHandler>` is load-bearing:
 *
 *   - a misspelled key (`vieww`) is TS2353 (object literal may only specify
 *     known properties) AND TS2741 (property 'view' is missing)
 *   - a command listed in `Command` with no entry here is TS2741
 *   - an entry whose handler has the wrong signature is TS2322
 *
 * Before this table existed, dispatch was a `switch (cmd)` over a plain
 * `string`, which carries no exhaustiveness obligation at all: a misspelled
 * `case` is just a branch that never runs.
 *
 * @type {Record<Command, CommandHandler>}
 */
const COMMANDS = {
  view: cmdView,
  stats: cmdStats,
  compare: cmdCompare,
};

/**
 * Narrows an arbitrary argv string to a `Command`.
 *
 * Sound because `COMMANDS` is annotated `Record<Command, CommandHandler>` and
 * built from an object literal, so its own-property set is exactly `Command` —
 * the compiler enforces both directions.
 *
 * @param {string | undefined} value
 * @returns {value is Command}
 */
function isCommand(value) {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}

const [, , cmd, ...rest] = process.argv;

if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
  // An explicit help request is a successful invocation, so stdout and exit 0.
  usage();
} else if (!isCommand(cmd)) {
  usageError(
    `unknown command ${JSON.stringify(cmd)} ` +
      `(expected one of: ${Object.keys(COMMANDS).join(", ")})`,
  );
} else {
  try {
    await COMMANDS[cmd](rest);
  } catch (error) {
    // A malformed or missing trace.json is a user-input problem, not a bug, so
    // it gets a one-line message and exit 1 rather than a V8 stack trace from
    // node:internal. `loadTrace` throws curated messages for both.
    console.error(`agentlens: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_ERROR;
  }
}

// ---------------------------------------------------------------------------
// HONEST LIMITS of `npm run typecheck:bin` over this file
// ---------------------------------------------------------------------------
//
// What it genuinely catches (measured by injecting each defect and running the
// gate, not assumed): property typos against the imported `Trace`/`Span` types
// (TS2551/TS2339), wrong arity in both directions (TS2554), wrong-typed
// arguments to imported and builtin functions (TS2345), a missing `await`
// (TS2345), dereferencing the genuinely-nullable `durationMs` (TS18047), bad
// module specifiers and bad named imports (TS2307/TS2724), undeclared
// identifiers (TS2304), comparisons against a string union with no overlap
// (TS2367), and — since this revision — a misspelled or unhandled command name
// in the table above (TS2353/TS2741) and an out-of-range index read
// (noUncheckedIndexedAccess, which is what surfaced the `-o`-with-no-value
// crash).
//
// What it still does NOT catch, stated plainly because the previous version of
// this comment claimed the opposite:
//
//   - Wiring the WRONG handler to a correct command name. `cmdView`, `cmdStats`
//     and `cmdCompare` are all `(string[]) => Promise<void>`; they are
//     structurally identical, so `{ view: cmdStats }` typechecks. Only a test
//     that runs each subcommand and asserts on ITS OWN output can see that —
//     test/cli.test.mjs does exactly that.
//   - Misspelled FLAG literals (`-0` for `-o`). Any string is a valid argument
//     to `findIndex`/`===`. Same answer: the CLI tests assert that `-o <path>`
//     actually writes to `<path>`.
//   - Node-version-inappropriate APIs. `@types/node` is a single version while
//     `engines.node` is `>=20`, so an API added in 22 typechecks clean and
//     crashes on the declared floor. The matrix job running the CLI on Node 20
//     is what covers that, not the compiler.
//
// The rule this comment is trying to obey: a gate's documentation must describe
// what it measured, not what would have been nice. Every claim above was
// injected and observed.
