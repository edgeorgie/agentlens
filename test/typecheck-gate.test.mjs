import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGatedJobRunCommands } from "../scripts/ci-contexts.mjs";

// ---------------------------------------------------------------------------
// THE GATE THAT TESTS THE GATE
// ---------------------------------------------------------------------------
//
// `npm run typecheck:bin` typechecks the published entrypoint and the
// merge-gate scripts. It is a required status check. Nothing tested it.
//
// That is the repo's recurring wound, not a one-off: six separate merge-gate
// bypasses have shipped here, every one of them a check that looked correct and
// passed vacuously. The specific hole measured on the previous revision:
// deleting the single word `"checkJs"` from tsconfig.check.json left
// `typecheck:bin` exiting 0 on a file containing a real type error, with all
// three required contexts still green and no test or drift guard noticing.
// (Asymmetric, and worth recording: deleting `"allowJs"` did NOT hide it — the
// file still failed with TS2551. `checkJs` was the one load-bearing word.)
//
// Patching that one hole — "assert checkJs is present" — would be round eight
// of the same mistake: a guard that only catches the failure someone already
// demonstrated. So this file asserts in two layers:
//
//   1. CONFIG SHAPE (fast, precise failure messages). Every compiler option the
//      gate's teeth depend on, plus the include actually resolving to the file
//      package.json#bin names — derived FROM the bin field, so renaming the
//      entrypoint without updating the include fails here.
//
//   2. BEHAVIOUR (the real backstop). Compile a fixture carrying a planted type
//      defect under the committed config and assert the compiler REPORTS it.
//      This one does not care WHY the gate broke. Delete checkJs, delete
//      allowJs, narrow the include, swap the whole config for `{}`, downgrade
//      strict, point the script at a different file — every one of those makes
//      this test red, including the ways nobody has thought of yet.
//
// Layer 2 is the point. Layer 1 exists for the error message.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const CONFIG_PATH = join(REPO, "tsconfig.check.json");
const RAW_CONFIG = readFileSync(CONFIG_PATH, "utf8");
const CONFIG = JSON.parse(RAW_CONFIG);
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

test("the typecheck gate's config enables every option its teeth depend on", () => {
  const opts = CONFIG.compilerOptions ?? {};

  // `checkJs` first and alone in its own assertion, because it is the measured
  // single point of failure: without it the files stay in the PROGRAM
  // (`--listFiles` still lists them) and all checking silently stops, so no
  // "is the file included?" assertion can see its absence.
  assert.equal(
    opts.checkJs,
    true,
    "tsconfig.check.json must set `checkJs: true`. Without it tsc still " +
      "RESOLVES bin/cli.mjs into the program and still exits 0 — measured: a " +
      "deliberate TS2551 typo in the published entrypoint passed with exit 0 " +
      "when this one word was removed. It is the single word that empties " +
      "this gate while leaving every required context green.",
  );

  for (const [option, expected, why] of [
    ["allowJs", true, "without it the .mjs entrypoint is not a program input at all"],
    ["strict", true, "most of the gate's diagnostics (TS18047, TS7006, TS2345) are strict-only"],
    ["noEmit", true, "bin/cli.mjs is published verbatim; a compile step must not write to it"],
    [
      "noUncheckedIndexedAccess",
      true,
      "this is what makes `args[i + 1]` type as `string | undefined`. It is " +
        "not a style preference: with it off, `agentlens view t.json -o` " +
        "(flag with no value) typechecked clean and crashed the published " +
        "CLI with a raw ERR_INVALID_ARG_TYPE stack trace",
    ],
  ]) {
    assert.equal(
      opts[option],
      expected,
      `tsconfig.check.json must set \`${option}: ${expected}\` — ${why}`,
    );
  }
});

test("the gate's include resolves to the entrypoint package.json actually ships", () => {
  const include = CONFIG.include;
  assert.ok(Array.isArray(include) && include.length > 0, "`include` must be a non-empty array");

  // Derived from the `bin` field rather than hardcoded: renaming or moving the
  // published entrypoint without updating the include is exactly the drift this
  // assertion exists to catch, and a hardcoded "bin/cli.mjs" here would go on
  // passing through that rename.
  const binTargets = Object.values(
    typeof PKG.bin === "string" ? { [PKG.name]: PKG.bin } : PKG.bin,
  ).map((p) => String(p).replace(/^\.\//, ""));
  assert.ok(binTargets.length > 0, "package.json must declare a `bin` entry");

  // Ask the compiler which files it actually resolved, rather than reimplementing
  // glob semantics and asserting against our own model of them. `--listFiles`
  // through an npm script: direct node_modules/.bin invocation is blocked in
  // some environments, and npm scripts put tsc on PATH anyway.
  const listed = execFileSync(
    process.execPath,
    [npmCli(), "run", "--silent", "typecheck:bin", "--", "--listFiles", "--noEmit"],
    { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  for (const target of binTargets) {
    assert.ok(
      listed.split("\n").some((line) => line.trim().endsWith("/" + target)),
      `tsconfig.check.json's include [${include.join(", ")}] does not resolve ` +
        `to ${target}, the file package.json#bin publishes. The gate would ` +
        "run green over a program that does not contain the entrypoint it " +
        `claims to check. Files resolved outside node_modules: ` +
        listed
          .split("\n")
          .filter((l) => l.trim() && !l.includes("node_modules"))
          .join(", "),
    );
  }

  // The merge-gate scripts are in scope too, and for a stronger reason than
  // bin/: they decide whether `main` is protected. Measured at the commit that
  // added them to this config: 16 checkJs errors lived there unchecked,
  // including a TS2339 one line above an `Array.isArray(steps)` guard that
  // failed open.
  assert.ok(
    listed.includes("/scripts/ci-contexts.mjs"),
    "scripts/ci-contexts.mjs must be inside the typecheck gate: it derives " +
      "the required status-check context names, so a type error there is a " +
      "defect in the merge gate itself, not in a dev-only fixture",
  );
});

test("the gate REPORTS a planted type defect — the backstop that does not care why it broke", () => {
  // The real assertion. Compile a fixture with a known defect under the
  // COMMITTED config and require a non-zero exit with the expected diagnostic.
  //
  // Done out-of-tree: the fixture lives in a temp dir with its own tsconfig
  // that `extends` the committed one, so the committed config's options are
  // exercised for real while the repo tree is never mutated (a test that edits
  // tracked files can leave a dirty worktree when it fails).
  const dir = mkdtempSync(join(tmpdir(), "agentlens-gate-"));
  try {
    writeFileSync(
      join(dir, "fixture.mjs"),
      // Two independent defects, so this stays red if a future TS release
      // changes how one of them is reported:
      //   - a property typo against the imported Span type  (TS2551/TS2339)
      //   - an unchecked index read                         (noUncheckedIndexedAccess)
      `import { loadTrace } from ${JSON.stringify(join(REPO, "dist/index.js"))};\n` +
        `const trace = await loadTrace("x.json");\n` +
        `console.log(trace.spans[0].duratoinMs);\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          extends: CONFIG_PATH,
          compilerOptions: {
            types: ["node"],
            // The fixture lives outside the repo tree, so the default
            // node_modules walk from its own directory finds no @types. Point
            // typeRoots at the repo's, and nothing else: every other option
            // comes from the committed config via `extends`, which is what
            // makes this a test of THAT config rather than of a copy.
            typeRoots: [join(REPO, "node_modules/@types")],
          },
          include: ["fixture.mjs"],
        },
        null,
        2,
      ),
      "utf8",
    );

    assert.ok(
      existsSync(join(REPO, "dist/index.d.ts")),
      "dist/ must be built before this test runs (package.json `pretest` does " +
        "that). The gate checks bin/cli.mjs against the BUILT declarations, " +
        "so without dist/ this fixture would fail on TS2307 and prove nothing " +
        "about whether type checking is armed.",
    );

    const result = runTsc(dir);

    assert.notEqual(
      result.status,
      0,
      "THE TYPECHECK GATE IS NOT ARMED. A fixture containing a deliberate " +
        "property typo and an unchecked index read compiled CLEAN under the " +
        "committed tsconfig.check.json. Whatever the immediate cause — a " +
        "deleted `checkJs`, a narrowed `include`, a relaxed `strict`, a " +
        "changed compiler default — `npm run typecheck:bin` is currently " +
        "incapable of failing, so the required status check that runs it is " +
        "decorative. Do not ship this.\n\ncompiler output:\n" +
        result.output,
    );
    assert.match(
      result.output,
      /duratoinMs/,
      "the gate failed, but not on the planted defect — so this test is no " +
        "longer measuring what it claims to. Compiler output:\n" + result.output,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci.yml's gated job still RUNS the typecheck, and runs it after the build", () => {
  // Deleting `- run: npm run typecheck:bin` from ci.yml changes no context
  // name, so the context-derivation guard and the live-protection script both
  // stay silent and all three required checks stay green with the gate gone.
  // This reads the PARSED workflow (same machinery, same reason: a grep would
  // match the string in this very comment and would miss a step injected
  // through a YAML anchor).
  const commands = readGatedJobRunCommands();

  const typecheckAt = commands.findIndex((c) => c.includes("typecheck:bin"));
  assert.notEqual(
    typecheckAt,
    -1,
    "ci.yml's gated job no longer runs `npm run typecheck:bin`. Removing " +
      "that step renames no status-check context, so every required check " +
      `stays green while the gate is simply absent. Steps found: ${commands.join(" | ")}`,
  );

  const buildAt = commands.findIndex((c) => c.trim() === "npm run build");
  assert.notEqual(buildAt, -1, "ci.yml's gated job no longer runs `npm run build`");
  assert.ok(
    buildAt < typecheckAt,
    "`npm run typecheck:bin` must run AFTER `npm run build`: it checks " +
      "bin/cli.mjs against the BUILT dist/ declarations, and with dist/ " +
      "absent it fails with three TS2307s plus five lines of implicit-any " +
      "noise that point at the wrong problem. Current order: " +
      commands.join(" | "),
  );

  assert.ok(
    commands.some((c) => c.trim() === "npm test"),
    "ci.yml's gated job must run `npm test` — this file is part of that suite, " +
      "so without it the gate-testing layer is itself ungated",
  );
});

/** Path to npm's CLI, so npm scripts can be run via `process.execPath`. */
function npmCli() {
  const bin = process.env.npm_execpath;
  if (bin && bin.endsWith(".js")) return bin;
  // Fall back to resolving npm from the PATH-independent location Node ships
  // alongside itself.
  return join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
}

/**
 * Runs the TypeScript compiler over a project directory.
 *
 * Invoked through the repo's own npm script with `-p <dir>` appended rather
 * than by spawning node_modules/.bin/tsc directly: a direct binary invocation
 * is blocked by some sandboxes, and going through the script also means this
 * test exercises the SAME entrypoint CI exercises.
 */
function runTsc(projectDir) {
  try {
    const output = execFileSync(
      process.execPath,
      [npmCli(), "run", "--silent", "typecheck:bin", "--", "-p", projectDir],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, output };
  } catch (error) {
    const e = /** @type {{status?: number, stdout?: string, stderr?: string}} */ (error);
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}
