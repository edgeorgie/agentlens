import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// Branch protection on `main` requires a list of literal status-check CONTEXT
// names. For a matrix job, a context name is `<job name template, expanded>`.
// Renaming the job or changing the matrix therefore renames every context,
// while protection goes on requiring names nothing can produce — which wedges
// `main` permanently, from an edit whose own CI was green.
//
// This module is the single place that derives those names from `ci.yml`. Two
// consumers import it: the unit test (which compares against the committed
// mirror) and `check-live-protection.mjs` (which compares against the live
// ruleset).
//
// ---------------------------------------------------------------------------
// WHY THIS PARSES YAML INSTEAD OF SCANNING LINES
// ---------------------------------------------------------------------------
//
// Five earlier versions of this file derived the matrix by scanning ci.yml line
// by line with indentation and regex heuristics. Each was bypassed, and each
// fix closed only the one spelling that had just been demonstrated:
//
//   #13  protection required a context the matrix no longer produced
//   #15  `exclude:` searched only in the text after `node:`
//   #16  the same stanza moved ABOVE `node:` walked straight through
//   #17  `'exclude':` (quoted) above `node:` was silently discarded, because
//        the key regex was anchored to [A-Za-z_] and the non-matching line
//        fell into an `if (current)` branch that dropped it on the floor
//
// The through-line is not that the regexes were too narrow. It is that a line
// scanner models TEXT, while GitHub acts on the PARSED DOCUMENT. Every bypass
// was a pair of files that differ as text and are identical as YAML. The
// decisive case is a merge key:
//
//     x-extra: &extra
//       exclude:
//         - node: 22
//     ...
//           matrix:
//             <<: *extra
//             node: [20, 22, 24]
//
// `jobs.test.strategy.matrix` here really contains `exclude`, and GitHub drops
// Node 22 — but the token `exclude` never appears anywhere under `matrix:`. No
// regex over lines can see a key that is not in the lines. That is a proof, not
// an anecdote: the heuristic approach cannot be made correct, only narrower.
//
// So this module parses the workflow with a real YAML parser and reads
// `jobs.test.strategy.matrix` off the resulting object. Quoting, key order,
// flow vs block style, explicit `? key` form, anchors, aliases, merge keys,
// block scalars and non-ASCII lookalike characters all stop being special
// cases: either the parser resolves them to the key `node` and nothing else, or
// this module throws. `test/ci-contexts-mutations.test.mjs` applies every one of
// those mutation classes, in both placements relative to `node:`, and asserts
// each one fails closed.
//
// The cost is one devDependency (`yaml`, zero transitive runtime deps). It is
// not a dependency of the published package: `package.json#files` ships only
// `dist/`, `bin/` and `README.md`, and `dependencies` stays empty. The price of
// avoiding it was six bypasses.

const WORKFLOW_PATH = new URL("../.github/workflows/ci.yml", import.meta.url);
const MIRROR_PATH = new URL(
  "../.github/required-status-checks.txt",
  import.meta.url,
);

// The id of the job whose contexts are the merge gate.
const GATED_JOB_ID = "test";

// The only matrix key this module knows how to expand. Anything else under
// `matrix:` makes the derived set wrong, so it is rejected, not ignored.
// `include:`/`exclude:` change which jobs run without changing this list, and a
// second dimension multiplies (and can collide) every name — both are verified
// behaviours, see the mutation test.
const SUPPORTED_MATRIX_KEYS = new Set(["node"]);

/**
 * Reads the committed list of required status-check context names.
 *
 * The file is line-oriented so it stays reviewable in a diff: `#` comments and
 * blank lines are ignored, everything else is one context name verbatim
 * (context names may contain spaces, so the line is not tokenised).
 *
 * @returns {string[]} context names in file order
 */
export function readMirroredContexts() {
  return readFileSync(MIRROR_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Parses workflow YAML into a plain object.
 *
 * `merge: true` resolves `<<:` merge keys, so a key injected through an anchor
 * is present in the result exactly as GitHub sees it — this is the setting that
 * makes the merge-key bypass visible rather than invisible. Verified against
 * `yaml@2`: without it, `<<` is returned as a literal key and the merged
 * content never appears.
 *
 * `uniqueKeys: true` makes a duplicate mapping key a parse error instead of a
 * silent last-wins overwrite. The old line scanner overwrote silently, which is
 * one more place it diverged from the document GitHub reads.
 *
 * @param {string} source workflow YAML
 * @returns {Record<string, unknown>} the parsed workflow document
 * @throws {Error} if the source is not valid YAML or not a mapping
 */
function parseWorkflow(source) {
  let doc;
  try {
    doc = parseYaml(source, { merge: true, uniqueKeys: true });
  } catch (error) {
    throw new Error(
      `ci.yml is not valid YAML, so the contexts it produces cannot be ` +
        `derived: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(
      `ci.yml did not parse to a mapping (got ${Array.isArray(doc) ? "a sequence" : typeof doc}), ` +
        "so it is not a workflow this guard can read",
    );
  }
  return doc;
}

/**
 * Renders one matrix value the way GitHub renders it into a job name.
 *
 * GitHub interpolates the value's string form, so the YAML scalar TYPE does not
 * reach the context name: `node: [20]` and `node: ["20"]` both produce
 * `Node 20`. Confirmed empirically, not assumed — a probe workflow with
 * `name: Node ${{ matrix.node }}` over `[20, 24]` and
 * `name: NodeQ ${{ matrix.node }}` over `["20", "24"]` reported
 * `Node 20 / Node 24` and `NodeQ 20 / NodeQ 24`
 * (edgeorgie/qa-injection-test-repo run 38235526774; the same four names appear
 * in `GET /commits/{sha}/check-runs`, which is what branch protection matches
 * against). The same run also pinned the edge cases this function must not get
 * wrong: bare `20.0` renders as `20`, the quoted string `"20.0"` renders as
 * `20.0`, `0o20` renders as `16`, and `true` renders as `true` — all four
 * identical to `String()` on the parsed JS value.
 *
 * Only scalars are accepted. A mapping or sequence as a matrix value renders as
 * an object GitHub stringifies in a shape this module does not model, so it
 * throws rather than guessing.
 *
 * @param {unknown} value one entry of the `node:` list
 * @returns {string}
 * @throws {Error} if the value is not a scalar
 */
function renderMatrixValue(value) {
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return String(value);
  }
  throw new Error(
    `ci.yml's \`node:\` matrix contains a non-scalar entry ` +
      `(${JSON.stringify(value)}). A context name is the job name with the ` +
      "matrix value interpolated as text; this guard models scalars only and " +
      "will not guess how GitHub stringifies a collection.",
  );
}

/**
 * Narrows an arbitrary parsed-YAML value to a plain mapping.
 *
 * Used at every step of the walk down `jobs.test.strategy.matrix` so each level
 * is both runtime-checked and type-narrowed by the SAME expression. Previously
 * the runtime checks were written out inline (`=== null || typeof !== "object"
 * || Array.isArray`) while the reads that followed them were untyped, which is
 * why `checkJs` reported `Property 'jobs' does not exist on type 'object'` —
 * the guard narrowed to `object`, which has no properties.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Derives the status-check context names a CI workflow produces, by reading the
 * parsed workflow document rather than restating it.
 *
 * Narrow by design: it understands one matrix job (`jobs.test`) keyed solely on
 * `node`. Anything outside that shape throws, because a parser that returned a
 * stale or empty set on an unrecognised workflow would let the assertion pass
 * vacuously — the exact failure this guard exists to prevent, and the one it
 * has already failed at six times.
 *
 * Takes the YAML as a STRING rather than reading the file itself, so the
 * mutation suite in `test/ci-contexts-mutations.test.mjs` can exercise the real
 * code path on a mutated workflow in-process. A guard whose tests can only run
 * against one file on disk is a guard whose failure modes are untested, and
 * that is how six bypasses shipped green.
 *
 * @param {string} source workflow YAML
 * @returns {string[]} expanded context names, in matrix order
 * @throws {Error} if the workflow no longer matches the expected shape
 */
export function deriveContextsFromSource(source) {
  const workflow = parseWorkflow(source);

  const jobs = workflow.jobs;
  if (!isMapping(jobs)) {
    throw new Error(
      "ci.yml has no `jobs:` mapping — the workflow shape changed and this " +
        "guard's parser needs updating",
    );
  }

  const job = jobs[GATED_JOB_ID];
  if (!isMapping(job)) {
    throw new Error(
      `ci.yml has no \`${GATED_JOB_ID}:\` job (jobs present: ` +
        `${Object.keys(jobs).join(", ") || "none"}). That job's matrix is ` +
        "what the required contexts are derived from, so this guard cannot " +
        "proceed. Note this is read from the PARSED document, so a stray " +
        `\`${GATED_JOB_ID}:\` elsewhere in the file — in a block scalar, an ` +
        "input default, another job's `with:` — can no longer be mistaken " +
        "for it.",
    );
  }

  assertJobCanFail(job);

  const strategy = job.strategy;
  if (!isMapping(strategy)) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}:\` job has no \`strategy:\` mapping, so it ` +
        "is no longer a matrix job and produces a single context this guard " +
        "would mis-expand into several",
    );
  }

  const matrix = strategy.matrix;
  if (!isMapping(matrix)) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}.strategy\` has no \`matrix:\` mapping ` +
        `(got ${Array.isArray(matrix) ? "a sequence" : typeof matrix}) — the ` +
        "workflow shape changed and this guard's parser needs updating",
    );
  }

  // Fail closed on ANY key that is not `node`, in any position, spelling or
  // style. This is an allowlist over the PARSED keys, which is what makes the
  // whole mutation class inert: `'exclude'`, `"exclude"`, `? exclude`,
  // `exclud\u0435` (Cyrillic е), a flow mapping, and `<<: *anchor` all arrive
  // here as an ordinary string key that is not in the allowlist.
  //
  // Why these keys are rejected rather than modelled:
  //   exclude:  removes a combination, so a version in the `node:` list
  //             produces no context at all (verified: a matrix of [20, 22, 24]
  //             with `exclude: [{node: 22}]` reported only `Excl 20`/`Excl 24`)
  //   include:  adds a combination not in the list
  //   second
  //   dimension: multiplies every name, and with a name template that
  //             interpolates only `matrix.node` the names COLLIDE — verified:
  //             `node: [20]` x `os: [ubuntu-latest, ubuntu-24.04]` reported two
  //             jobs both named `Two 20`, so protection cannot distinguish them
  // Hand-modelling GitHub's expansion would be its own source of wrongness.
  const unsupported = Object.keys(matrix).filter(
    (key) => !SUPPORTED_MATRIX_KEYS.has(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `ci.yml's matrix defines ${unsupported.map((k) => `\`${k}\``).join(", ")}, ` +
        "which this guard cannot expand. Those keys change which contexts are " +
        "produced without changing the `node:` list, so the derived set would " +
        "be wrong while this check reported green — wedging `main` on a " +
        "context no run can report. Teach this guard the expansion, or drop " +
        "the key. (Read from the parsed document: quoting, ordering, flow " +
        "style and `<<:` merge keys do not hide a key from this check.)",
    );
  }

  const nodeValue = matrix.node;
  if (nodeValue === undefined) {
    throw new Error(
      "ci.yml's matrix has no `node:` key — the workflow shape changed and " +
        "this guard's parser needs updating",
    );
  }
  if (!Array.isArray(nodeValue)) {
    throw new Error(
      `ci.yml's \`node:\` matrix is not a sequence (got ${typeof nodeValue}). ` +
        "A matrix dimension must be a list of values for one context to be " +
        "produced per value.",
    );
  }
  if (nodeValue.length === 0) {
    throw new Error(
      "ci.yml's `node:` matrix is an empty sequence, so the gated job " +
        "produces no contexts at all and every required check would be " +
        "unreportable",
    );
  }

  const versions = nodeValue.map(renderMatrixValue);
  const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `ci.yml's \`node:\` matrix renders duplicate values ` +
        `[${[...new Set(duplicates)].join(", ")}], so two matrix jobs would ` +
        "report the same context name and protection could not tell them " +
        "apart. (Note the YAML type does not disambiguate: `20` and `\"20\"` " +
        "both render as `20`.)",
    );
  }

  const nameTemplate = resolveJobNameTemplate(job);
  return versions.map((v) =>
    nameTemplate.replace(MATRIX_NODE_EXPRESSION_ALL, () => v),
  );
}

/**
 * `deriveContextsFromSource` applied to the repository's own `ci.yml`.
 *
 * @returns {string[]} expanded context names, in matrix order
 * @throws {Error} if the workflow no longer matches the expected shape
 */
export function deriveContextsFromWorkflow() {
  return deriveContextsFromSource(readFileSync(WORKFLOW_PATH, "utf8"));
}

// `${{ matrix.node }}` with any internal whitespace, which YAML preserves and
// GitHub tolerates.
//
// Deliberately TWO regexes rather than one shared `/g` literal: `.test()` on a
// global regex advances `lastIndex` and the next call starts mid-string, so a
// shared literal would return a different answer on its second invocation. That
// is precisely the kind of stateful subtlety that produced the previous six
// bypasses, so the matching one is non-global and the replacing one is global.
const MATRIX_NODE_EXPRESSION = /\$\{\{\s*matrix\.node\s*\}\}/;
const MATRIX_NODE_EXPRESSION_ALL = /\$\{\{\s*matrix\.node\s*\}\}/g;
// Any expression at all, used to reject templates containing an interpolation
// this guard cannot evaluate.
const ANY_EXPRESSION = /\$\{\{[^}]*\}\}/g;

/**
 * Works out the name template GitHub will report the gated job's checks under.
 *
 * Two cases, both verified against a real run rather than assumed
 * (edgeorgie/qa-injection-test-repo run 38235526774):
 *
 *   - job-level `name:` present → that template, expanded. A job named
 *     `Node ${{ matrix.node }}` reported `Node 20` / `Node 24`.
 *   - job-level `name:` ABSENT → GitHub falls back to `<job id> (<values>)`.
 *     A job with id `unnamed` and `node: [20, 24]` reported
 *     `unnamed (20)` / `unnamed (24)` — note the job id verbatim and the
 *     parenthesised value, NOT the id alone. The previous version of this file
 *     threw when `name:` was missing, which is safe but wrong: removing the
 *     `name:` line is a plausible edit and the derived set is knowable.
 *
 * @param {Record<string, unknown>} job the parsed gated job
 * @returns {string} a template containing `${{ matrix.node }}`
 * @throws {Error} if the name cannot be expanded by this guard
 */
function resolveJobNameTemplate(job) {
  if (!("name" in job) || job.name === null || job.name === undefined) {
    return `${GATED_JOB_ID} (\${{ matrix.node }})`;
  }

  if (typeof job.name !== "string") {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}.name\` is not a string ` +
        `(${JSON.stringify(job.name)}), so the reported context name cannot ` +
        "be derived",
    );
  }
  const template = job.name.trim();
  if (template.length === 0) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}.name\` is empty, so what GitHub reports as ` +
        "the context name is not something this guard will guess at",
    );
  }

  if (!MATRIX_NODE_EXPRESSION.test(template)) {
    throw new Error(
      `job name ${JSON.stringify(template)} does not interpolate ` +
        "`matrix.node`, so every matrix job would report the SAME context " +
        "name and protection could not distinguish them — this guard's " +
        "parser needs updating",
    );
  }

  // Anything else interpolated into the name is a value this guard cannot
  // evaluate (`github.*`, `env.*`, another matrix key), so the derived names
  // would be wrong in a way that looks right.
  const foreign = template
    .replace(MATRIX_NODE_EXPRESSION_ALL, "")
    .match(ANY_EXPRESSION);
  if (foreign) {
    throw new Error(
      `job name ${JSON.stringify(template)} interpolates ` +
        `${foreign.join(", ")}, which this guard cannot evaluate. The derived ` +
        "context names would not be the ones GitHub reports. Remove the " +
        "expression, or teach this guard to evaluate it.",
    );
  }

  return template;
}

/**
 * Asserts the gated job is still CAPABLE OF FAILING the merge gate.
 *
 * A required status check is only a gate if a broken commit can make it red.
 * Two one-line edits leave the matrix, the job name and every context name
 * completely untouched while disarming all of them:
 *
 *   continue-on-error: true   the job reports SUCCESS even when its steps fail,
 *                             so the required context is decorative
 *   if: <condition>            a skipped job's required context is treated by
 *                             branch protection as satisfied, so the gate is
 *                             simply absent for any commit the condition
 *                             excludes
 *
 * Neither is visible to a matrix parser, which is why they are checked here
 * explicitly rather than left as a documented blind spot. This is the same
 * defect class as the `npm audit --omit=dev` step that could not fail at any
 * severity, one level up: a gate that cannot report failure is not a gate.
 *
 * Step-level `continue-on-error: true` is rejected for the same reason — a
 * failing step that is excused does not fail the job. If one is ever genuinely
 * needed, the honest move is to split that work into a separate non-required
 * job, not to excuse it inside the gate.
 *
 * @param {Record<string, unknown>} job the parsed gated job
 * @throws {Error} if the job cannot fail
 */
function assertJobCanFail(job) {
  if ("continue-on-error" in job && job["continue-on-error"] !== false) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}:\` job sets \`continue-on-error: ` +
        `${JSON.stringify(job["continue-on-error"])}\`. The job then reports ` +
        "SUCCESS even when its steps fail, so every required context it " +
        "produces still reports — and reports green unconditionally. The " +
        "merge gate becomes decorative with the matrix, the job name and the " +
        "context names all unchanged, which is why no name-based check can " +
        "catch this.",
    );
  }

  if ("if" in job && job.if !== null && job.if !== undefined) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}:\` job is conditional ` +
        `(\`if: ${String(job.if)}\`). Branch protection treats a SKIPPED ` +
        "job's required context as satisfied, so for every commit the " +
        "condition excludes the gate is silently absent — with no change to " +
        "any context name. Gate the work inside the steps if it must be " +
        "conditional, or move it to a job that is not required.",
    );
  }

  const steps = job.steps;
  // Fail CLOSED on an unreadable step list. This used to be a bare
  // `if (Array.isArray(steps))` with no `else`: any shape other than an array —
  // including `steps:` deleted entirely, or replaced by an anchor this parser
  // does not resolve to a sequence — silently skipped the step-level
  // `continue-on-error` check and the function returned as if it had verified
  // something. That is the repo's recurring defect (a guard that passes
  // vacuously) sitting inside the guard that exists to catch it. `checkJs`
  // pointed straight at it: `TS2339: Property 'steps' does not exist on type
  // 'object'`, one line above the guard.
  if (!Array.isArray(steps)) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}:\` job has no \`steps:\` sequence (got ` +
        `${steps === undefined ? "nothing" : typeof steps}). The gated job's ` +
        "steps are where `continue-on-error` can disarm the gate without " +
        "changing a single context name, so an unreadable step list is " +
        "unverified, not clean.",
    );
  }

  const excused = steps.filter(
    (step) =>
      step !== null &&
      typeof step === "object" &&
      "continue-on-error" in step &&
      step["continue-on-error"] !== false,
  );
  if (excused.length > 0) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}:\` job has ${excused.length} step(s) ` +
        "with `continue-on-error` set. A failing step that is excused does " +
        "not fail the job, so that part of the gate cannot report red. " +
        "Move the work to a separate non-required job instead of excusing " +
        "it inside the gated one.",
    );
  }

  // Step-level `if:`, the eighth bypass of this guard's recurring class.
  //
  // The job-level `if:` check above exists because a SKIPPED job's required
  // context is treated as satisfied. The step-level spelling was missing, and
  // it is strictly easier to get wrong: a skipped step does not skip the job,
  // so the job runs, SUCCEEDS, and reports all three required contexts green
  // while the work behind one of them never executed. Nothing else in this
  // module or in `test/typecheck-gate.test.mjs` could see it — the context
  // names are untouched and `deriveGatedJobRunCommands` returned the step's
  // `run` string whether or not the step could ever run.
  //
  // Measured on the revision that added this check, with the then-current
  // guard and the full `npm test` suite:
  //
  //   `- if: false` on `npm run typecheck:bin`           → contexts identical,
  //                                                         gate test PASSES
  //   `- if: github.event_name == 'schedule'` on it      → same
  //   `- if: false` on `npm test`                        → same (and this one
  //                                                         disarms the layer
  //                                                         that tests the gate)
  //   `<<: *anchor` carrying `if: false`                 → same
  //
  // All four are rejected here. The discriminating controls, which already
  // worked and must keep working: deleting the step outright is caught by
  // `typecheck-gate.test.mjs` (the command disappears from the list), and
  // step-level `continue-on-error` is caught immediately above.
  //
  // Every step is covered, `uses:` as well as `run:`: a conditional
  // `setup-node` would silently run the whole matrix on the runner's default
  // Node while every context name still claimed a version.
  const conditional = steps.filter(
    (step) =>
      isMapping(step) &&
      "if" in step &&
      step.if !== null &&
      step.if !== undefined,
  );
  if (conditional.length > 0) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}:\` job has ${conditional.length} ` +
        `conditional step(s) (\`if: ${conditional
          .map((step) => String(/** @type {Record<string, unknown>} */ (step).if))
          .join("`, `if: ")}\`). A skipped step does NOT skip the job, so the ` +
        "job still succeeds and still reports every required context green " +
        "with that step's work never executed — no context name changes and " +
        "no presence check notices, because the step is still in the file. " +
        "If the work is genuinely conditional, put the condition inside the " +
        "command, or move the step to a job that is not required.",
    );
  }

  assertNoShellFailureSuppression(steps);
}

// Shell idioms that discard a command's exit status. Unlike everything else in
// this module these are matched against TEXT, and that is a deliberate,
// narrower claim: a `run:` block is a shell script, so there is no parsed
// representation to assert on the way there is for YAML. The guard is therefore
// a detector for the idioms that appear in practice, NOT a proof of
// unsuppressability — `sh -c 'cmd; true'`, a wrapper script, or a trap can all
// still swallow a failure. Saying so is the point: six of this file's bypasses
// came from a check that was sold as exhaustive and was not.
//
// `ci.yml`'s own audit-step comment already states `|| true` is "deliberately
// NOT used ... a gate that cannot fail is the defect being fixed". Nothing
// enforced it, so it was a convention, not a guard.
const SHELL_SUPPRESSION_PATTERNS = [
  // `cmd || true`, `|| :`, `|| echo ...` — the status becomes the right-hand
  // side's.
  { re: /\|\|\s*(true|:|echo\b)/, why: "`|| true` / `|| :` / `|| echo` discards the exit status" },
  // A trailing `exit 0` in a multi-line block: the script's status is the last
  // command's, so everything above it is advisory.
  { re: /(^|\n)\s*exit\s+0\s*(\n|$)/, why: "a trailing `exit 0` makes every preceding command advisory" },
  // `set +e` turns off the default `bash -e` abort for the rest of the block.
  { re: /(^|\n|;)\s*set\s+\+e\b/, why: "`set +e` disables the shell's abort-on-error for the rest of the block" },
];

/**
 * Asserts no gated step discards its own exit status in the shell.
 *
 * @param {unknown[]} steps the gated job's parsed steps
 * @throws {Error} if a `run:` block suppresses failure
 */
function assertNoShellFailureSuppression(steps) {
  for (const step of steps) {
    if (!isMapping(step) || typeof step.run !== "string") continue;
    for (const { re, why } of SHELL_SUPPRESSION_PATTERNS) {
      if (re.test(step.run)) {
        throw new Error(
          `ci.yml's \`${GATED_JOB_ID}:\` job has a step whose shell discards ` +
            `failure — ${why}:\n\n    ${step.run.split("\n").join("\n    ")}\n\n` +
            "The step then reports success regardless of the command's " +
            "result, so the required context it contributes to is " +
            "decorative, with no change to any context name. Let the command " +
            "fail, or move it to a job that is not required.",
        );
      }
    }
  }
}

/**
 * Returns every `run:` command in the gated job, in order.
 *
 * WHY THIS EXISTS
 *
 * `deriveContextsFromSource` derives CONTEXT NAMES. Deleting a whole step from
 * the gated job — say `- run: npm run typecheck:bin` — changes no context name,
 * so the context derivation reports no drift, the three required checks stay
 * green, and a merge gate silently disappears. That is the same shape as the
 * six bypasses this file documents, one level down: not "the names drifted" but
 * "the work behind the names vanished".
 *
 * `test/typecheck-gate.test.mjs` asserts the commands that constitute the gate
 * are present in this list. It reads the PARSED document for the same reason
 * everything else here does: a `grep` over ci.yml would match the string inside
 * this very comment, and would miss a step injected through an anchor.
 *
 * @param {string} source workflow YAML
 * @returns {string[]} the `run:` command strings of the gated job, in order
 * @throws {Error} if the gated job cannot be read
 */
export function deriveGatedJobRunCommands(source) {
  const workflow = parseWorkflow(source);
  const jobs = workflow.jobs;
  if (!isMapping(jobs)) {
    throw new Error("ci.yml has no `jobs:` mapping");
  }
  const job = jobs[GATED_JOB_ID];
  if (!isMapping(job)) {
    throw new Error(`ci.yml has no \`${GATED_JOB_ID}:\` job`);
  }
  const steps = job.steps;
  if (!Array.isArray(steps)) {
    throw new Error(
      `ci.yml's \`${GATED_JOB_ID}:\` job has no \`steps:\` sequence, so the ` +
        "commands the gate runs cannot be read",
    );
  }

  // Run the same can-this-job-fail assertions here, not only in
  // `deriveContextsFromSource`. This function answers "which commands does the
  // gate run?", and a command in a step that is conditional, excused, or
  // shell-suppressed is in the FILE without being in the GATE. Returning it
  // regardless is what let `- if: false` pass every presence assertion in
  // `test/typecheck-gate.test.mjs` while the step never executed.
  assertJobCanFail(job);

  return steps
    .filter((step) => isMapping(step) && typeof step.run === "string")
    .map((step) => String(step.run));
}

/**
 * `deriveGatedJobRunCommands` applied to the repository's own `ci.yml`.
 *
 * @returns {string[]}
 */
export function readGatedJobRunCommands() {
  return deriveGatedJobRunCommands(readFileSync(WORKFLOW_PATH, "utf8"));
}
