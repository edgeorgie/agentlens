import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  deriveContextsFromSource,
  deriveGatedJobRunCommands,
} from "../scripts/ci-contexts.mjs";

// ---------------------------------------------------------------------------
// ROUND EIGHT: DISARMING A STEP WITHOUT RENAMING A CONTEXT
// ---------------------------------------------------------------------------
//
// `test/ci-contexts-mutations.test.mjs` proves the MATRIX derivation cannot be
// fooled by reformatting, and `test/typecheck-gate.test.mjs` proves the
// typecheck gate is armed and that its step is still present in ci.yml. Both
// were green against the mutations in this file.
//
// The hole: a step can be left in the file, with its `run:` text untouched, and
// still never execute. `if:` on a STEP does not skip the job — the job runs,
// SUCCEEDS, and reports every required context green with that step's work
// never performed. Measured against the previous revision (all four with the
// full suite passing and the derived contexts byte-identical):
//
//   - if: false                       on `npm run typecheck:bin`
//   - if: github.event_name == 'schedule'   on the same step
//   - if: false                       on `npm test`  ← disarms the layer that
//                                                      tests the gate itself
//   - <<: *anchor  carrying `if: false`                (invisible to any grep)
//
// Plus two shell spellings that need no YAML key at all:
//
//   - run: npm run typecheck:bin || true
//   - run: |
//       npm run typecheck:bin
//       exit 0
//
// ci.yml's own audit-step comment already asserted `|| true` is "deliberately
// NOT used", which made it a convention with nothing enforcing it.
//
// This is the same root cause as rounds 1-7 one level down. Those asked "do the
// context NAMES still match?". This asks "can the job still FAIL?" — and a
// presence check ("is the command in the list?") answers neither, because the
// command is in the list either way.
//
// STRUCTURE, and why it is not a seventh refinement: the assertions below are
// not "reject `if: false`". `assertJobCanFail` rejects a conditional step with
// ANY condition, in any spelling, including one arriving through a merge key,
// because the question is never what the condition says — a step whose
// execution is conditional cannot be part of an unconditional gate. The shell
// patterns ARE a narrower, text-based detector, and the implementation says so
// explicitly rather than claiming exhaustiveness: see the negative-control test
// at the bottom, which documents a suppression this guard does NOT catch.

const WORKFLOW = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

// Anchors in the real file, so this suite tracks ci.yml rather than a copy.
const TYPECHECK_STEP = "      - run: npm run typecheck:bin";
const TEST_STEP = "      - run: npm test";

for (const anchor of [TYPECHECK_STEP, TEST_STEP]) {
  assert.ok(
    WORKFLOW.includes(`\n${anchor}\n`),
    `this suite anchors on the literal line ${JSON.stringify(anchor)} in ` +
      "ci.yml and can no longer find it. The workflow was reformatted; " +
      "re-anchor the suite rather than deleting it.",
  );
}

/**
 * Confirms a mutation really is the thing it claims to be, so a mutation that
 * merely breaks the YAML cannot be miscounted as a closed bypass. Same
 * discipline as the matrix suite: assert the attack is real BEFORE asserting
 * the guard refuses it.
 *
 * @param {string} source mutated workflow YAML
 * @param {(step: Record<string, unknown>) => boolean} predicate
 * @param {string} what human description, used in the failure message
 */
function assertGatedJobHasStep(source, predicate, what) {
  const doc = parseYaml(source, { merge: true, uniqueKeys: true });
  const steps = doc?.jobs?.test?.steps;
  assert.ok(
    Array.isArray(steps),
    `mutation is not a valid workflow with a readable \`test.steps\`, so it ` +
      `cannot demonstrate ${what}`,
  );
  assert.ok(
    steps.some((s) => s !== null && typeof s === "object" && predicate(s)),
    `mutation's parsed \`test.steps\` does not actually contain ${what} — ` +
      "the probe is invalid, not the guard",
  );
}

/**
 * Asserts BOTH entry points refuse a mutation.
 *
 * Both, because they are separately reachable and were separately wrong:
 * `deriveContextsFromSource` is what the drift script calls, and
 * `deriveGatedJobRunCommands` is what `typecheck-gate.test.mjs` calls. The
 * latter previously had no can-this-fail assertion at all, which is precisely
 * why the presence test passed on a step that could never run.
 *
 * @param {string} source mutated workflow YAML
 * @param {RegExp} expected pattern the refusal message must match
 */
function assertBothEntryPointsRefuse(source, expected) {
  assert.throws(
    () => deriveContextsFromSource(source),
    expected,
    "deriveContextsFromSource accepted a workflow whose gated job cannot fail",
  );
  assert.throws(
    () => deriveGatedJobRunCommands(source),
    expected,
    "deriveGatedJobRunCommands accepted a workflow whose gated job cannot " +
      "fail — this is the entry point typecheck-gate.test.mjs uses, so a " +
      "disarmed step would pass every presence assertion in that file",
  );
}

// ---------------------------------------------------------------------------
// Step-level `if:` — the four measured bypasses
// ---------------------------------------------------------------------------

// `if:` written BEFORE and AFTER `run:` within the same step. Mapping keys are
// unordered in YAML, and ordering was the entire mechanism of bypasses #16 and
// #17 — a suite testing one placement is how a bypassable guard looks verified.
const STEP_IF_CASES = [
  {
    name: "`if: false` after run:",
    mutate: (/** @type {string} */ s, /** @type {string} */ anchor, /** @type {string} */ cond) =>
      s.replace(anchor, `${anchor}\n        if: ${cond}`),
  },
  {
    name: "`if: false` before run:",
    mutate: (/** @type {string} */ s, /** @type {string} */ anchor, /** @type {string} */ cond) =>
      s.replace(anchor, `      - if: ${cond}\n        ${anchor.trim().replace(/^-\s*/, "")}`),
  },
];

for (const { name, mutate } of STEP_IF_CASES) {
  for (const [label, anchor] of [
    ["typecheck:bin", TYPECHECK_STEP],
    ["npm test", TEST_STEP],
  ]) {
    for (const cond of ["false", "github.event_name == 'schedule'"]) {
      test(`${name} on \`${label}\` (if: ${cond}) fails closed`, () => {
        const mutated = mutate(WORKFLOW, anchor, cond);
        assert.notEqual(mutated, WORKFLOW, "mutation did not apply");
        assertGatedJobHasStep(
          mutated,
          (step) => "if" in step && typeof step.run === "string",
          `a conditional \`${label}\` step`,
        );
        assertBothEntryPointsRefuse(mutated, /conditional step/i);
      });
    }
  }
}

test("a conditional step injected through a merge key fails closed", () => {
  // The decisive case for the same reason it was decisive for the matrix: the
  // token `if` never appears in the step's own lines, so no grep over ci.yml
  // can see it, while the parsed document — which is what GitHub acts on —
  // carries it.
  const mutated = WORKFLOW.replace(
    "jobs:\n  test:",
    "x-disarm: &disarm\n  if: false\njobs:\n  test:",
  ).replace(TYPECHECK_STEP, `      - <<: *disarm\n        run: npm run typecheck:bin`);
  assert.notEqual(mutated, WORKFLOW, "mutation did not apply");

  // The step's own text contains no `if:` — proving the grep-invisibility claim
  // rather than asserting it.
  const stepText = mutated
    .split("\n")
    .slice(
      mutated.split("\n").findIndex((l) => l.includes("<<: *disarm")),
      mutated.split("\n").findIndex((l) => l.includes("<<: *disarm")) + 2,
    )
    .join("\n");
  assert.ok(!/\bif\s*:/.test(stepText), "probe invalid: `if:` is visible in the step's own lines");

  assertGatedJobHasStep(
    mutated,
    (step) => step.if === false && typeof step.run === "string",
    "a step carrying `if: false` through a merge key",
  );
  assertBothEntryPointsRefuse(mutated, /conditional step/i);
});

// ---------------------------------------------------------------------------
// Shell-level suppression — no YAML key required
// ---------------------------------------------------------------------------

const SHELL_CASES = [
  { name: "`|| true`", run: "npm run typecheck:bin || true" },
  // Quoted, because `|| :` unquoted is not valid YAML — `: ` opens a nested
  // mapping and `yaml@2` rejects it (`BLOCK_AS_IMPLICIT_KEY`). An author
  // writing this idiom must quote it, so the quoted form is the real attack and
  // the unquoted one is not a reachable state.
  { name: "`|| :` (quoted)", run: '"npm run typecheck:bin || :"' },
  { name: "`|| echo`", run: "npm run typecheck:bin || echo 'typecheck failed, continuing'" },
  { name: "trailing `exit 0`", run: "|\n          npm run typecheck:bin\n          exit 0" },
  { name: "`set +e`", run: "|\n          set +e\n          npm run typecheck:bin" },
];

for (const { name, run } of SHELL_CASES) {
  test(`shell suppression via ${name} fails closed`, () => {
    const mutated = WORKFLOW.replace(TYPECHECK_STEP, `      - run: ${run}`);
    assert.notEqual(mutated, WORKFLOW, "mutation did not apply");
    assertGatedJobHasStep(
      mutated,
      (step) => typeof step.run === "string" && step.run.includes("typecheck:bin"),
      `a typecheck step whose shell uses ${name}`,
    );
    assertBothEntryPointsRefuse(mutated, /discards failure/i);
  });
}

// ---------------------------------------------------------------------------
// Controls — these must keep PASSING, or the guard is just noisy
// ---------------------------------------------------------------------------

test("the repository's own unmodified ci.yml still passes both entry points", () => {
  const contexts = deriveContextsFromSource(WORKFLOW);
  assert.deepEqual(contexts, ["Node 20", "Node 22", "Node 24"]);
  const commands = deriveGatedJobRunCommands(WORKFLOW);
  assert.ok(
    commands.some((c) => c.includes("typecheck:bin")),
    "the real workflow must still be readable by the presence check",
  );
});

test("`||` used for a legitimate fallback VALUE is not flagged", () => {
  // A false positive here would be worse than the hole: it would push authors
  // to delete the guard. `${VAR:-default}`-style fallbacks and a `||` whose
  // right side is a real command that can itself fail are not suppression.
  const mutated = WORKFLOW.replace(
    TYPECHECK_STEP,
    "      - run: npm run typecheck:bin || exit 1",
  );
  assert.notEqual(mutated, WORKFLOW, "mutation did not apply");
  assert.doesNotThrow(
    () => deriveGatedJobRunCommands(mutated),
    "`|| exit 1` preserves failure and must not be flagged as suppression",
  );
});

test("a conditional step in a NON-gated job is not flagged", () => {
  // `protection-drift` is deliberately conditional (`if: github.event_name !=
  // 'pull_request'`) and deliberately not a required check. A guard that
  // refused that would be wrong about the repo's own documented design.
  assert.ok(
    /if: github\.event_name != 'pull_request'/.test(WORKFLOW),
    "probe invalid: ci.yml no longer has the conditional protection-drift job",
  );
  assert.doesNotThrow(() => deriveContextsFromSource(WORKFLOW));
});

test("the shell detector's limits are stated, not implied", () => {
  // NEGATIVE CONTROL, recorded deliberately. The shell patterns are a detector
  // for idioms seen in practice, not a proof. This mutation DOES suppress
  // failure and this guard does NOT catch it:
  const evasive = WORKFLOW.replace(
    TYPECHECK_STEP,
    "      - run: sh -c 'npm run typecheck:bin; true'",
  );
  assert.notEqual(evasive, WORKFLOW, "mutation did not apply");
  assert.doesNotThrow(
    () => deriveGatedJobRunCommands(evasive),
    "if this now THROWS the detector was improved — good: move this case up " +
      "into SHELL_CASES and find the next evasion to document here. This " +
      "assertion exists so the guard's real coverage is written down rather " +
      "than overstated, which is the mistake every previous round made.",
  );
});
