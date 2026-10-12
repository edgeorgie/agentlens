import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CLI SURFACE TESTS — the half the typechecker structurally cannot do
// ---------------------------------------------------------------------------
//
// `npm run typecheck:bin` is a real gate, but it was sold on a claim it does
// not support: "a typo in an argv branch ships to npm while CI stays green".
// Measured on the previous revision, three argv defects passed the gate with
// exit 0 — a misspelled `case`, a misspelled `-o` flag literal, and the wrong
// handler wired to a correct branch.
//
// One of those three is now a compile error: dispatch goes through a
// `Record<Command, CommandHandler>` table, so a misspelled command key fails to
// build. The other two cannot be: the three handlers are structurally identical
// `(string[]) => Promise<void>`, and any string is a valid comparison operand.
// Types will never see them.
//
// So this file runs the ACTUAL built binary — the same file npm publishes —
// over the real command surface and asserts on exit codes and output. Each
// subcommand is asserted on ITS OWN distinctive output, which is what makes a
// swapped handler visible: `{ view: cmdStats }` produces stats text where the
// view test expects a written HTML file.
//
// Exit codes are part of the contract and are asserted everywhere: 0 ok,
// 1 regression / unreadable trace, 2 bad invocation. Before this change EVERY
// bad invocation exited 0, so `agentlens vieww t.json || echo failed` printed
// nothing — a CLI that cannot report "you called me wrong".
//
// That claim was itself overstated when first written, and the correction is
// the table below: asserting the contract for a hand-picked set of invocations
// is not asserting the contract. Four bad invocations went on exiting 0 and
// one exited 1, including `view t.json -0 out.html`, which wrote to the
// DEFAULT path and printed a success line. The table enumerates every row of
// the contract and checks that a rejected invocation also WROTE NOTHING.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CLI = join(REPO, "bin/cli.mjs");

/**
 * Runs the built CLI and captures status, stdout and stderr separately.
 * Never throws on a non-zero exit — the exit code IS the assertion target.
 */
function run(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

const TRACE = {
  traceId: "11111111-1111-4111-8111-111111111111",
  name: "fixture-run",
  startTime: 1000,
  endTime: 1300,
  durationMs: 300,
  totalTokens: 42,
  totalCostUsd: 0.00125,
  meta: {},
  spans: [
    { id: "a", parentId: null, name: "root", kind: "agent", startTime: 1000, endTime: 1300, durationMs: 300, status: "ok", attributes: {} },
    { id: "b", parentId: "a", name: "search", kind: "tool", startTime: 1010, endTime: 1110, durationMs: 100, status: "ok", attributes: {} },
    { id: "c", parentId: "a", name: "answer", kind: "llm", startTime: 1120, endTime: 1290, durationMs: 170, status: "error", attributes: { error: "boom" } },
  ],
};

/** A temp dir with `trace.json` written into it, cleaned up by the caller. */
function fixtureDir(trace = TRACE) {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-cli-"));
  writeFileSync(join(dir, "trace.json"), JSON.stringify(trace), "utf8");
  return dir;
}

test("dist/ is built before these tests run", () => {
  assert.ok(
    existsSync(join(REPO, "dist/index.js")),
    "bin/cli.mjs imports ../dist/index.js at runtime; package.json `pretest` " +
      "runs the build, so an absent dist/ here means the test entrypoint changed",
  );
});

// --- the three subcommands, each asserted on its OWN output -----------------

test("`stats` prints the stats report and exits 0", () => {
  const dir = fixtureDir();
  try {
    const r = run(["stats", join(dir, "trace.json")]);
    assert.equal(r.status, 0, r.stderr);
    // Distinctive to stats, and absent from view/compare output — this is what
    // catches a swapped handler, which no type can see.
    assert.match(r.stdout, /agentlens stats — fixture-run/);
    assert.match(r.stdout, /spans\s+: 3/);
    assert.match(r.stdout, /errors\s+: 1/);
    assert.match(r.stdout, /by kind:/);
    assert.match(r.stdout, /tool\s+count=1 totalMs=100/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`view` writes an HTML file and exits 0", () => {
  const dir = fixtureDir();
  try {
    const r = run(["view", join(dir, "trace.json")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /agentlens: wrote .*trace\.html \(3 spans/);
    const html = readFileSync(join(dir, "trace.html"), "utf8");
    assert.match(html, /<html/i);
    assert.match(html, /fixture-run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`compare` reports deltas and exits 1 only on an error-count regression", () => {
  const dir = fixtureDir();
  try {
    const clean = structuredClone(TRACE);
    clean.spans[2].status = "ok";
    writeFileSync(join(dir, "clean.json"), JSON.stringify(clean), "utf8");

    // clean -> fixture: errors 0 -> 1, a regression.
    const worse = run(["compare", join(dir, "clean.json"), join(dir, "trace.json")]);
    assert.match(worse.stdout, /agentlens compare: fixture-run -> fixture-run/);
    assert.match(worse.stdout, /errors\s+: 0 -> 1/);
    assert.match(worse.stdout, /REGRESSION/);
    assert.equal(
      worse.status,
      1,
      "`compare` is documented as usable as a CI gate, so a regression must " +
        "set a non-zero exit code or every pipeline using it passes silently",
    );

    // fixture -> clean: errors 1 -> 0, an improvement, exit 0.
    const better = run(["compare", join(dir, "trace.json"), join(dir, "clean.json")]);
    assert.match(better.stdout, /errors\s+: 1 -> 0/);
    assert.doesNotMatch(better.stdout, /REGRESSION/);
    assert.equal(better.status, 0, better.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the `-o` flag, whose literal spelling no type can check ----------------

test("`view -o <path>` writes to exactly that path", () => {
  const dir = fixtureDir();
  try {
    const out = join(dir, "custom-name.html");
    const r = run(["view", join(dir, "trace.json"), "-o", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      existsSync(out),
      "`-o` did not write to the requested path. A misspelled flag literal " +
        "(`-0` for `-o`) typechecks perfectly — any string is a valid " +
        "comparison operand — so this assertion is the only thing that sees it.",
    );
    assert.ok(
      !existsSync(join(dir, "trace.html")),
      "`-o` was given but the default output path was written instead, which " +
        "means the flag was not recognised",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`view -o` with NO filename prints usage and exits 2 instead of crashing", () => {
  // The live crash this replaces, on the published entrypoint:
  //   $ agentlens view t.json -o
  //   TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type
  //   string ... at cmdView (bin/cli.mjs:29:9)   exit=1
  // A raw V8 stack trace from node:internal, for a plausible typo.
  const dir = fixtureDir();
  try {
    const r = run(["view", join(dir, "trace.json"), "-o"]);
    assert.equal(
      r.status,
      2,
      `expected exit 2 (bad invocation), got ${r.status}. stderr:\n${r.stderr}`,
    );
    assert.doesNotMatch(
      r.stderr,
      /ERR_INVALID_ARG_TYPE|at .*node:internal/,
      "a missing flag value must produce a message, not an unhandled " +
        `TypeError from inside node. stderr:\n${r.stderr}`,
    );
    assert.match(r.stderr, /-o.*no filename/i);
    assert.match(r.stderr, /Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- invocation errors -----------------------------------------------------

test("no arguments prints usage on stdout and exits 0", () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /agentlens view <trace\.json>/);
});

// The exit-code contract, table-driven rather than hand-picked.
//
// The previous revision asserted this contract for the six invocations its
// author thought of, and a reviewer falsified it with the first five he tried.
// Measured against the published entrypoint at that revision:
//
//   view t.json --unknown-flag        exit 0, flag ignored, wrote output
//   view t.json -0 out.html           exit 0, wrote the DEFAULT path, "wrote …"
//   stats t.json extra-positional     exit 0, arg ignored
//   compare a.json b.json third-arg   exit 0, arg ignored
//   view t.json -o ""                 exit 1, raw `ENOENT: … open ''`
//
// Four invocation errors reported SUCCESS and one reported an I/O failure for
// a usage mistake. The `-0` row is the one that matters most: it is a
// silent-wrong-output bug in a published CLI, and it is the exact defect class
// the comment at the top of this file says these tests exist to catch — a
// misspelled flag literal that no type can see.
//
// A table, so adding a flag or a positional to any subcommand means adding its
// rows here rather than remembering to. Every row below was executed against
// the fixed binary; the four that previously exited 0 are the ones marked
// "was 0" and each was re-run against the pre-fix binary to confirm the
// assertion is not vacuous.
for (const row of [
  {
    name: "an unrecognised long flag is rejected, not ignored (was 0)",
    args: ["view", "<trace>", "--unknown-flag"],
    status: 2,
    stderr: /unrecognised option "--unknown-flag"/,
    noDefaultOutput: true,
  },
  {
    name: "`-0` (zero) is rejected and hints at `-o`, instead of writing to the default path (was 0, and wrote the wrong file)",
    args: ["view", "<trace>", "-0", "<out>"],
    status: 2,
    stderr: /unrecognised option "-0".*did you mean `-o`/s,
    noDefaultOutput: true,
    noNamedOutput: true,
  },
  {
    name: "an unrecognised short flag on `stats` is rejected (was 0)",
    args: ["stats", "<trace>", "-x"],
    status: 2,
    stderr: /unrecognised option "-x"/,
  },
  {
    name: "`-o` is rejected on `stats`, which does not write files",
    args: ["stats", "<trace>", "-o", "<out>"],
    status: 2,
    stderr: /unrecognised option "-o"/,
  },
  {
    name: "a surplus positional on `stats` is rejected, not ignored (was 0)",
    args: ["stats", "<trace>", "extra-positional-arg"],
    status: 2,
    stderr: /`stats` takes at most 1 argument but got 2/,
  },
  {
    name: "a surplus positional on `view` is rejected, not ignored (was 0)",
    args: ["view", "<trace>", "extra-positional-arg"],
    status: 2,
    stderr: /`view` takes at most 1 argument but got 2/,
    noDefaultOutput: true,
  },
  {
    name: "a third positional on `compare` is rejected, not ignored (was 0)",
    args: ["compare", "<trace>", "<trace>", "third-arg"],
    status: 2,
    stderr: /`compare` takes at most 2 arguments but got 3/,
  },
  {
    name: "`-o ''` is a usage error, not a raw ENOENT (was 1)",
    args: ["view", "<trace>", "-o", ""],
    status: 2,
    stderr: /`-o` was given an empty filename/,
    stderrNot: /ENOENT|at .*node:internal/,
    noDefaultOutput: true,
  },
  {
    name: "`--out` with no value stays exit 2",
    args: ["view", "<trace>", "--out"],
    status: 2,
    stderr: /`-o` was given with no filename after it/,
  },
  {
    name: "a wrong-case command stays exit 2",
    args: ["VIEW", "<trace>"],
    status: 2,
    stderr: /unknown command "VIEW"/,
  },
  {
    name: "an unknown top-level flag stays exit 2",
    args: ["--version"],
    status: 2,
    stderr: /unknown command "--version"/,
  },
]) {
  test(`exit-code contract: ${row.name}`, () => {
    const dir = fixtureDir();
    try {
      const out = join(dir, "named-output.html");
      const args = row.args.map((a) =>
        a === "<trace>" ? join(dir, "trace.json") : a === "<out>" ? out : a,
      );
      const r = run(args);

      assert.equal(
        r.status,
        row.status,
        `expected exit ${row.status}, got ${r.status}. ` +
          `A bad invocation that exits 0 makes \`agentlens … || echo failed\` ` +
          `print nothing.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
      assert.match(r.stderr, row.stderr);
      if (row.stderrNot) assert.doesNotMatch(r.stderr, row.stderrNot);

      // Rejecting the invocation is only half of it: the command must also not
      // have done any of the work. This is the half that was actually broken.
      if (row.noDefaultOutput) {
        assert.ok(
          !existsSync(join(dir, "trace.html")),
          "the invocation was rejected but the DEFAULT output path was " +
            "written anyway. This is the `-0 out.html` bug: the file lands " +
            "somewhere the user never named while the CLI reports success.",
        );
      }
      if (row.noNamedOutput) {
        assert.ok(
          !existsSync(out),
          "the invocation was rejected but the named output path was written",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("an unknown command names the command, lists the valid ones, and exits 2", () => {
  const r = run(["vieww", "trace.json"]);
  assert.equal(
    r.status,
    2,
    "an unknown command used to print usage and exit 0, so `agentlens vieww " +
      "t.json || echo failed` reported success for a typo",
  );
  assert.match(r.stderr, /unknown command "vieww"/);
  assert.match(r.stderr, /view, stats, compare/);
});

for (const [cmd, needed] of [
  ["view", /`view` needs a trace file/],
  ["stats", /`stats` needs a trace file/],
  ["compare", /`compare` needs two trace files/],
]) {
  test(`\`${cmd}\` with no arguments explains what is missing and exits 2`, () => {
    const r = run([cmd]);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
    assert.match(r.stderr, needed);
  });
}

test("`compare` with only one path exits 2 rather than comparing against undefined", () => {
  const dir = fixtureDir();
  try {
    const r = run(["compare", join(dir, "trace.json")]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /needs two trace files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- bad input is a message, not a stack trace -----------------------------

test("a missing trace file exits 1 with a message, not a raw ENOENT stack", () => {
  const r = run(["stats", join(tmpdir(), "definitely-not-here-9d2f.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^agentlens: /m);
  assert.doesNotMatch(r.stderr, /at .*node:internal/);
});

test("a malformed trace.json exits 1 naming the file, not a JSON.parse stack", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-cli-"));
  try {
    writeFileSync(join(dir, "bad.json"), "{not json", "utf8");
    const r = run(["stats", join(dir, "bad.json")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not valid JSON/);
    assert.doesNotMatch(r.stderr, /at JSON\.parse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the prototype-collision bug, end to end -------------------------------

test("a span whose kind collides with Object.prototype cannot silently vanish", () => {
  // Regression test for a real correctness bug in the product. The by-kind
  // accumulator was an object literal written with `byKind[k] ??= {…}`. For
  // `k = "constructor"` the lookup returns the INHERITED `Object` function,
  // which is not nullish, so `??=` assigned nothing, no own property was
  // created, and `Object.entries` omitted the bucket entirely — the span
  // disappeared from the latency breakdown while the `spans :` count two lines
  // above still included it. Verified against the published binary before the
  // fix: a 4-span trace printed `spans : 4` and exactly ONE by-kind row.
  //
  // (The preceding revision printed a visible `count=NaN` row for the same
  // input — garbage, but not silent. The `??=` rewrite was described in its PR
  // as "incidental: one lookup instead of four". It was not.)
  //
  // Two layers now stop this: `loadTrace` validates `kind` against the real
  // union and rejects an out-of-union value with a readable error, and the
  // accumulator is a Map with no prototype chain to collide with.
  const dir = mkdtempSync(join(tmpdir(), "agentlens-cli-"));
  try {
    const hostile = structuredClone(TRACE);
    hostile.spans[1].kind = "constructor";
    writeFileSync(join(dir, "hostile.json"), JSON.stringify(hostile), "utf8");

    const r = run(["stats", join(dir, "hostile.json")]);
    assert.equal(
      r.status,
      1,
      "an out-of-union span kind must be REPORTED. Exit 0 here would mean it " +
        `was silently accepted again. stdout:\n${r.stdout}`,
    );
    assert.match(r.stderr, /spans\[1\]\.kind is "constructor"/);
    assert.doesNotMatch(
      r.stdout,
      /spans\s+: 3/,
      "the trace must not be summarised at all when a span kind is invalid — " +
        "a report whose span count disagrees with its own breakdown is worse " +
        "than an error",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every valid span kind appears in the by-kind breakdown", () => {
  // The positive half: the Map must still bucket all five documented kinds, so
  // the fix above cannot be satisfied by simply dropping the breakdown.
  const kinds = ["agent", "llm", "tool", "retrieval", "custom"];
  const trace = structuredClone(TRACE);
  trace.spans = kinds.map((kind, i) => ({
    id: `s${i}`,
    parentId: null,
    name: kind,
    kind,
    startTime: 1000,
    endTime: 1010 + i,
    durationMs: 10 + i,
    status: "ok",
    attributes: {},
  }));
  const dir = fixtureDir(trace);
  try {
    const r = run(["stats", join(dir, "trace.json")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /spans\s+: 5/);
    for (const kind of kinds) {
      assert.match(
        r.stdout,
        new RegExp(`${kind}\\s+count=1`),
        `kind ${kind} is missing from the by-kind breakdown, so the span count ` +
          "above it disagrees with the rows below it",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
