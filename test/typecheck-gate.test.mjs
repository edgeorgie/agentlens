import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readGatedJobRunCommands } from "../scripts/ci-contexts.mjs";

// ---------------------------------------------------------------------------
// THE GATE THAT TESTS THE GATE
// ---------------------------------------------------------------------------
//
// `npm run typecheck:bin` typechecks the published entrypoint and the
// merge-gate scripts. It is a required status check. Nothing tested it.
//
// That is the repo's recurring wound, not a one-off: seven separate merge-gate
// bypasses have shipped here, every one of them a check that looked correct and
// passed vacuously. The specific hole measured on revision one of this file:
// deleting the single word `"checkJs"` from tsconfig.check.json left
// `typecheck:bin` exiting 0 on a file containing a real type error, with all
// three required contexts still green and no test or drift guard noticing.
// (Asymmetric, and worth recording: deleting `"allowJs"` did NOT hide it — the
// file still failed with TS2551. `checkJs` was the one load-bearing word.)
//
// Revision one closed that and then shipped three bypasses of its own, all
// found by a reviewer in under an hour, all traceable to ONE design mistake:
// layer 2 compiled a SYNTHETIC FIXTURE in a temp dir under a tsconfig that
// merely `extends` the committed one. So it tested the committed CONFIG FILE
// and never the real entrypoint or the real script. Measured on that revision,
// each of these left `typecheck:bin` at exit 0 AND this file passing 4/4:
//
//   - `// @ts-nocheck` on line 2 of bin/cli.mjs (the fixture has no such
//     comment, so the fixture still errored, so this file still passed)
//   - `// @ts-ignore` above the defective line (same reason)
//   - repointing `scripts["typecheck:bin"]` at a `checkJs: false` config
//     (`-p <tmpdir>` overrode the project the script names, so the permissive
//     config never participated)
//   - a `bin/helper.js` with two real type errors (`include` globbed .mjs only
//     while `files: ["bin"]` publishes the directory whole)
//
// The lesson, stated once: THE ARTIFACT UNDER TEST MUST BE THE ARTIFACT CI
// INVOKES. So the layers are now:
//
//   1. CONFIG SHAPE (fast, precise failure messages). Every compiler option the
//      gate's teeth depend on, plus the include actually resolving to the file
//      package.json#bin names — derived FROM the bin field, so renaming the
//      entrypoint without updating the include fails here.
//
//   2. SCRIPT IDENTITY. `package.json#scripts["typecheck:bin"]` must point
//      `tsc -p` at tsconfig.check.json and nothing else, because layer 1 proves
//      only that a correct config exists on disk.
//
//   3. NO SUPPRESSION IN SCOPE. Every file the gate resolves is scanned for
//      `@ts-nocheck` and `@ts-ignore`. There is no linter in this repo, so
//      nothing else in CI objects to either. (`@ts-expect-error` is NOT banned:
//      it fails when the error disappears, so it cannot hide a live defect.)
//
//   4. BEHAVIOUR, against the real tree (the backstop). Copy the repo into a
//      sandbox, plant type defects into the REAL bin/cli.mjs and into new
//      bin/*.js + bin/*.cjs siblings, then run the repo's OWN unmodified
//      `npm run typecheck:bin` there and require each defect to be reported by
//      diagnostic name. This layer does not care WHY the gate broke: deleted
//      checkJs, relaxed strict, narrowed include, swapped config, repointed
//      script, suppression comment copied along with the file — all of them
//      turn it red, because it runs the real script over the real files.
//
// Layer 4 is the point. Layers 1–3 exist for the error message and for speed.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const CONFIG_PATH = join(REPO, "tsconfig.check.json");
const CONFIG_BASENAME = "tsconfig.check.json";
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
  // glob semantics and asserting against our own model of them.
  const listed = listGateFiles();

  for (const target of binTargets) {
    assert.ok(
      listed.some((line) => line.endsWith("/" + target)),
      `tsconfig.check.json's include [${include.join(", ")}] does not resolve ` +
        `to ${target}, the file package.json#bin publishes. The gate would ` +
        "run green over a program that does not contain the entrypoint it " +
        `claims to check. Files resolved outside node_modules: ` +
        listed.filter((l) => !l.includes("node_modules")).join(", "),
    );
  }

  // The merge-gate scripts are in scope too, and for a stronger reason than
  // bin/: they decide whether `main` is protected. Measured at the commit that
  // added them to this config: 16 checkJs errors lived there unchecked,
  // including a TS2339 one line above an `Array.isArray(steps)` guard that
  // failed open.
  assert.ok(
    listed.some((l) => l.endsWith("/scripts/ci-contexts.mjs")),
    "scripts/ci-contexts.mjs must be inside the typecheck gate: it derives " +
      "the required status-check context names, so a type error there is a " +
      "defect in the merge gate itself, not in a dev-only fixture",
  );
});

test("the typecheck:bin SCRIPT points tsc at tsconfig.check.json, not merely at a config that exists", () => {
  // Layer 1 proves a correct config file is committed. It proves nothing about
  // which config CI compiles under, and those came apart in practice:
  // repointing this script at a `checkJs: false` copy left `typecheck:bin` at
  // exit 0 over a real TS2551 in the entrypoint while every assertion in this
  // file still passed, because the old layer 2 compiled with `-p <tmpdir>` and
  // so overrode the project the script names.
  //
  // Parsed rather than substring-matched: a script reading
  // `tsc -p tsconfig.sneaky.json # tsconfig.check.json` would satisfy
  // `includes("tsconfig.check.json")`, which is the shape of bypass this repo
  // keeps shipping.
  const script = PKG.scripts?.["typecheck:bin"];
  assert.equal(
    typeof script,
    "string",
    "package.json must define a `typecheck:bin` script — ci.yml runs it as part " +
      "of the gated job, and this whole file is about that script",
  );

  const tokens = script.trim().split(/\s+/);
  assert.equal(
    tokens[0],
    "tsc",
    `\`typecheck:bin\` must invoke tsc directly (got ${JSON.stringify(script)}). ` +
      "Wrapping it in a shell chain would let a `|| true` or a second command " +
      "swallow the exit code, which is the bypass class ci.yml's step guard " +
      "already covers for workflow steps.",
  );

  const projectAt = tokens.findIndex((t) => t === "-p" || t === "--project");
  assert.notEqual(
    projectAt,
    -1,
    `\`typecheck:bin\` must pass -p/--project (got ${JSON.stringify(script)}); ` +
      "without it tsc falls back to tsconfig.json, which is the BUILD config " +
      "and covers src/**/*.ts only — bin/ and scripts/ would be unchecked",
  );

  const project = tokens[projectAt + 1];
  assert.equal(
    project,
    CONFIG_BASENAME,
    `\`typecheck:bin\` compiles project ${JSON.stringify(project)}, not ` +
      `${JSON.stringify(CONFIG_BASENAME)}. Every option assertion above reads ` +
      `${CONFIG_BASENAME}, so pointing the script at any other config — ` +
      "a permissive copy, a config with `checkJs: false`, an empty `{}` — " +
      "leaves this file passing while the gate checks nothing. Measured: " +
      "exactly that edit produced exit 0 on a real TS2551 in bin/cli.mjs " +
      `with the gate's self-test at 4/4. Full script: ${JSON.stringify(script)}`,
  );

  assert.equal(
    tokens.length,
    projectAt + 2,
    `\`typecheck:bin\` has trailing arguments after the project ` +
      `(${JSON.stringify(script)}). Flags appended here can relax the config ` +
      "the assertions above verified — `--checkJs false` and `--noCheck` both " +
      "win over the file — so the script is required to be exactly " +
      `\`tsc -p ${CONFIG_BASENAME}\`.`,
  );
});

test("no file in the gate's scope suppresses type checking with @ts-nocheck or @ts-ignore", () => {
  // The cheapest total bypass this repo has had, and the one a reviewer waves
  // through: `// @ts-nocheck` on line 2 of bin/cli.mjs. The config stays
  // perfect, `--listFiles` still resolves the entrypoint, every option
  // assertion above still passes, and tsc reports nothing at all — measured,
  // over the author's own planted TS2551: exit 0, self-test 4/4.
  //
  // `@ts-ignore` is the same hole in innocent clothing: one noisy diagnostic
  // silenced under deadline. There is no ESLint in this repo and therefore no
  // `ban-ts-comment`, so nothing else in CI has an opinion.
  //
  // `@ts-expect-error` is deliberately NOT banned. It inverts: it errors when
  // the error it names goes away, so it cannot hide a live defect. Banning it
  // would push people toward `@ts-ignore`, which can.
  const files = listGateFiles()
    .filter((f) => !f.includes("node_modules") && f.startsWith(REPO + sep))
    .map((f) => relative(REPO, f));

  assert.ok(
    files.length > 0,
    "the gate resolved no in-repo files at all — see the include assertion above",
  );

  /** @type {string[]} */
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(join(REPO, file), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      // Match the directive form tsc honours: a comment whose content starts
      // with the directive. Prose mentioning it (this comment, for instance)
      // does not match, and the guard is proven against a real planted
      // directive rather than trusted — see the sandbox layer below.
      if (/^\s*(\/\/|\/\*)\s*@ts-(nocheck|ignore)\b/.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a type-checking suppression directive is inside the typecheck gate's " +
      "scope. `@ts-nocheck` switches checking off for an ENTIRE file and " +
      "`@ts-ignore` silences the next line unconditionally, so either one " +
      "leaves `npm run typecheck:bin` at exit 0 over real type errors while " +
      "all three required contexts stay green. If a diagnostic genuinely " +
      "needs suppressing, use `@ts-expect-error`: it fails when the error " +
      "disappears, so it cannot rot into a blind spot. Offenders:\n  " +
      offenders.join("\n  "),
  );
});

test("the gate REPORTS defects planted in the REAL entrypoint, via the REAL script — the backstop that does not care why it broke", () => {
  // The assertion that matters, and the one the previous revision got wrong.
  //
  // Old shape: write a synthetic fixture into a temp dir with its own tsconfig
  // that `extends` the committed one, then `npm run typecheck:bin -- -p
  // <tmpdir>`. That tests the committed config FILE. It cannot see anything
  // done to the entrypoint (a `@ts-nocheck` the fixture does not have) and it
  // cannot see anything done to the script (the `-p <tmpdir>` override is
  // exactly what neutralises a repointed `-p`).
  //
  // New shape: copy the whole repo into a sandbox, plant defects into the real
  // files there, and run the repo's own `npm run typecheck:bin` with NO extra
  // arguments. The artifact under test is now the artifact CI invokes —
  // same package.json, same script, same config, same entrypoint.
  //
  // Three defects, at three sites, because each covers a different hole:
  //   bin/cli.mjs  — a property typo on the imported Span type (TS2551). Dies
  //                  if checking is suppressed in that file or the config is
  //                  disarmed, which the old fixture could not see.
  //   bin/gate-probe.js  — same class, in a .js sibling. `files: ["bin"]`
  //   bin/gate-probe.cjs — publishes the directory whole, so the include has to
  //                        cover more than .mjs; it did not, and a planted
  //                        bin/helper.js compiled clean at exit 0.
  const dir = mkdtempSync(join(tmpdir(), "agentlens-gate-sandbox-"));
  try {
    // node_modules is symlinked rather than copied: it is the bulk of the tree
    // and npm resolves tsc through the link fine. .git is irrelevant here.
    cpSync(REPO, dir, {
      recursive: true,
      filter: (src) => {
        const rel = relative(REPO, src);
        return !(rel === "node_modules" || rel === ".git" || rel.startsWith("node_modules" + sep) || rel.startsWith(".git" + sep));
      },
    });
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");

    assert.ok(
      existsSync(join(dir, "bin/cli.mjs")) && existsSync(join(dir, "package.json")),
      "the sandbox copy is missing bin/cli.mjs or package.json, so nothing " +
        "below would be measuring the real tree",
    );

    // --- control: the untouched copy must be GREEN, or a red result below
    // proves nothing about the planted defects.
    const control = runGateScript(dir);
    assert.equal(
      control.status,
      0,
      "an UNMODIFIED copy of this repo fails `npm run typecheck:bin`, so the " +
        "red results this test relies on cannot be attributed to the planted " +
        "defects. Fix the tree (or this sandbox) before trusting the " +
        `assertions below.\n\n${control.output}`,
    );

    // --- defect 1: the real published entrypoint.
    const cliPath = join(dir, "bin/cli.mjs");
    const pristine = readFileSync(cliPath, "utf8");
    const NEEDLE = 'trace.spans.filter((s) => s.status === "error")';
    assert.ok(
      pristine.includes(NEEDLE),
      "this test plants its defect by rewriting a known expression in " +
        `bin/cli.mjs and that expression (${NEEDLE}) is gone. Update the ` +
        "needle rather than deleting the assertion: a mutation test that can " +
        "no longer mutate silently stops testing.",
    );
    writeFileSync(
      cliPath,
      pristine.replace(NEEDLE, 'trace.spans.filter((s) => s.staus === "error")'),
      "utf8",
    );

    const planted = runGateScript(dir);
    assert.notEqual(
      planted.status,
      0,
      "THE TYPECHECK GATE IS NOT ARMED. A deliberate property typo " +
        "(`s.staus` for `s.status`) planted in the REAL bin/cli.mjs compiled " +
        "CLEAN under the repo's own `npm run typecheck:bin`. Whatever the " +
        "immediate cause — a deleted `checkJs`, a narrowed `include`, a " +
        "relaxed `strict`, a `@ts-nocheck` in the entrypoint, a script " +
        "repointed at a permissive config — the required status check that " +
        "runs this command is currently incapable of failing. Do not ship " +
        `this.\n\ncompiler output:\n${planted.output}`,
    );
    assert.match(
      planted.output,
      /bin[\\/]cli\.mjs.*error TS2551/,
      "the gate failed, but not with a TS2551 against bin/cli.mjs — so this " +
        "test is no longer measuring what it claims to. Output:\n" + planted.output,
    );
    writeFileSync(cliPath, pristine, "utf8");

    // --- defect 2+3: .js and .cjs siblings inside the published bin/.
    for (const [name, label] of [
      ["gate-probe.js", ".js"],
      ["gate-probe.cjs", ".cjs"],
    ]) {
      const probePath = join(dir, "bin", name);
      writeFileSync(
        probePath,
        // Two independent errors so this stays red if a future TS release
        // changes how one of them is reported.
        "/** @param {{ a: number }} o */\n" +
          "function probe(o) {\n" +
          "  return o.nope.toUpperCase();\n" +
          "}\n" +
          "const bad = probe({ a: 1 }) * 2;\n" +
          "export { bad };\n",
        "utf8",
      );
      const sibling = runGateScript(dir);
      rmSync(probePath, { force: true });

      assert.notEqual(
        sibling.status,
        0,
        `a bin/${name} containing real type errors compiled CLEAN. ` +
          `package.json's files: ["dist","bin","README.md"] publishes the ` +
          `whole bin/ directory, so a ${label} helper next to the entrypoint ` +
          "ships to npm; if the gate's include does not cover it, it ships " +
          "unchecked. Measured on an earlier revision: exactly this file at " +
          `exit 0 with the self-test at 4/4.\n\n${sibling.output}`,
      );
      assert.match(
        sibling.output,
        new RegExp(`${name.replace(".", "\\.")}.*error TS`),
        `the gate failed but did not name bin/${name}, so the include may ` +
          "still not cover it. Output:\n" + sibling.output,
      );
    }

    // --- defect 4: a suppression directive travelling WITH the real file.
    // The layer-3 grep above is a static scan; this proves the thing the grep
    // is protecting against is genuinely a total bypass, so the grep is not
    // guarding a hypothetical.
    writeFileSync(
      cliPath,
      pristine
        .replace(NEEDLE, 'trace.spans.filter((s) => s.staus === "error")')
        .replace("#!/usr/bin/env node\n", "#!/usr/bin/env node\n// @ts-nocheck\n"),
      "utf8",
    );
    const suppressed = runGateScript(dir);
    writeFileSync(cliPath, pristine, "utf8");
    assert.equal(
      suppressed.status,
      0,
      "`@ts-nocheck` in bin/cli.mjs no longer hides a real TS2551 from tsc. " +
        "That is GOOD news, but it means the static scan in the test above is " +
        "now guarding something the compiler handles itself — re-measure and " +
        "simplify rather than leaving a comment that misstates why the scan " +
        `exists.\n\n${suppressed.output}`,
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
 * Runs the repo's OWN `npm run typecheck:bin` in `cwd`, with no extra
 * arguments, and returns status + combined output.
 *
 * No `-- -p <dir>` override, deliberately. The previous revision appended
 * `-p <tmpdir>`, and that single argument is what decoupled the test from
 * reality: it overrode the project the script names, so a script repointed at
 * a permissive config never participated and the bypass measured green. The
 * sandbox is a copy of the whole repo precisely so that no override is needed.
 *
 * @param {string} cwd
 * @returns {{ status: number, output: string }}
 */
function runGateScript(cwd) {
  try {
    const output = execFileSync(
      process.execPath,
      [npmCli(), "run", "--silent", "typecheck:bin"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
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

/**
 * The absolute paths tsc actually resolves for the gate, asked of the compiler
 * via `--listFiles` rather than modelled from the glob.
 *
 * Both callers need the same answer, and it costs a compile, so it is computed
 * once lazily.
 *
 * @returns {string[]}
 */
function listGateFiles() {
  if (listGateFiles.cache === undefined) {
    const result = execFileSync(
      process.execPath,
      [npmCli(), "run", "--silent", "typecheck:bin", "--", "--listFiles", "--noEmit"],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    listGateFiles.cache = result
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.includes(sep));
  }
  return listGateFiles.cache;
}
/** @type {string[] | undefined} */
listGateFiles.cache = undefined;
