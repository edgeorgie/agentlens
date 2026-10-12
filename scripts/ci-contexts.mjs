import { readFileSync } from "node:fs";

// Branch protection on `main` requires a list of literal status-check CONTEXT
// names. For a matrix job, a context name is `<job name template, expanded>`.
// Renaming the job or changing the matrix therefore renames every context,
// while protection goes on requiring names nothing can produce — which wedges
// `main` permanently, from an edit whose own CI was green.
//
// This module is the single place that derives those names from `ci.yml`. Two
// consumers import it: the unit test (which compares against the committed
// mirror) and `check-live-protection.mjs` (which compares against the live
// ruleset). A second hand-written copy of this parser would be one more thing
// to drift, which is the defect class being fixed — so there is exactly one.

const WORKFLOW_PATH = new URL("../.github/workflows/ci.yml", import.meta.url);
const MIRROR_PATH = new URL(
  "../.github/required-status-checks.txt",
  import.meta.url,
);

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
 * Derives the status-check context names the CI workflow produces, by reading
 * the workflow definition rather than restating it.
 *
 * Deliberately a narrow parser over this repo's one workflow shape — a single
 * matrix job keyed on `node`, named `Node ${{ matrix.node }}` — instead of a
 * YAML dependency. The parser is strict about that shape and throws when it no
 * longer holds, because a parser that silently returns `[]` on an unrecognised
 * workflow would let the assertion pass vacuously, which is the exact failure
 * this guard exists to prevent.
 *
 * @returns {string[]} expanded context names, in matrix order
 * @throws {Error} if the workflow no longer matches the expected shape
 */
export function deriveContextsFromWorkflow() {
  const yaml = readFileSync(WORKFLOW_PATH, "utf8");

  // Scoped to the `test:` job's block, NOT the first 4-space `name:` in the
  // file. ci.yml has more than one job, and a bare first-match would silently
  // read whichever job happens to appear first in the source — so merely
  // REORDERING the jobs would change the derived context names and this
  // guard's verdict. Slicing to the block makes the dependency on job identity
  // explicit instead of implicit in file order.
  const JOB = "  test:\n";
  const jobStart = yaml.indexOf(JOB);
  if (jobStart === -1) {
    throw new Error(
      "could not find a `test:` job in ci.yml — the matrix job was renamed " +
        "or removed and this guard's parser needs updating",
    );
  }
  const afterJobStart = yaml.slice(jobStart + JOB.length);
  // The job's block ends at the next job (a 2-space-indented key) or EOF.
  const nextJob = afterJobStart.search(/^ {2}\S/m);
  const jobBlock =
    nextJob === -1 ? afterJobStart : afterJobStart.slice(0, nextJob);

  const nameMatch = jobBlock.match(/^\s{4}name:\s*(.+?)\s*$/m);
  if (!nameMatch) {
    throw new Error(
      "could not find a job-level `name:` in ci.yml's `test:` job — the " +
        "workflow shape changed and this guard's parser needs updating",
    );
  }
  const nameTemplate = nameMatch[1];

  const matrixMatch = jobBlock.match(/^\s*node:\s*\[([^\]]+)\]\s*$/m);
  if (!matrixMatch) {
    throw new Error(
      "could not find a `node: [...]` matrix in ci.yml — the workflow shape " +
        "changed and this guard's parser needs updating",
    );
  }
  const versions = matrixMatch[1]
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  if (versions.length === 0) {
    throw new Error("parsed an empty `node:` matrix from ci.yml");
  }
  if (!nameTemplate.includes("${{ matrix.node }}")) {
    throw new Error(
      `job name ${JSON.stringify(nameTemplate)} does not interpolate ` +
        "`matrix.node`, so contexts are no longer one-per-matrix-value — " +
        "this guard's parser needs updating",
    );
  }

  // GitHub can change the SET of contexts without changing the `node:` line at
  // all, and those are the dangerous edits because this parser reads values,
  // not shape:
  //
  //   - `exclude:` removes a combination, so a listed version produces NO
  //     context. Protection keeps requiring it and `main` wedges — the exact
  //     #13 deadlock, straight through the guard meant to prevent it.
  //   - `include:` adds a combination, so an unlisted context appears.
  //   - a second matrix key (`os:`, `ts:`) multiplies every context name.
  //
  // Each is detected and throws, rather than being modelled. Modelling the
  // full matrix-expansion algorithm in a regex parser would be its own source
  // of silent wrongness; refusing to guess is the honest behaviour, and the
  // error says exactly what to do.
  // Sliced from `jobBlock`, not the whole file: with more than one job in
  // ci.yml, `indexOf("\n    steps:")` over the full source could land on
  // ANOTHER job's `steps:` and stretch this window across a job boundary,
  // making the stanza detection below read lines that are not part of this
  // matrix at all.
  const matrixBlock = jobBlock.slice(
    jobBlock.indexOf(matrixMatch[0]) + matrixMatch[0].length,
  );
  const stepsIndex = matrixBlock.indexOf("\n    steps:");
  if (stepsIndex === -1) {
    throw new Error(
      "could not find the `test:` job's `steps:` after its matrix in ci.yml " +
        "— the workflow shape changed and this guard's parser needs updating",
    );
  }
  const afterMatrix = matrixBlock.slice(0, stepsIndex);

  for (const stanza of ["include", "exclude"]) {
    if (new RegExp(`^\\s+${stanza}:`, "m").test(afterMatrix)) {
      throw new Error(
        `ci.yml's matrix now uses an \`${stanza}:\` stanza, which changes ` +
          "which contexts are produced without changing the `node:` list. " +
          "This parser reads the `node:` list only, so it can no longer " +
          "derive the real context set — it would pass while protection " +
          "requires a context no run produces (or misses a new one). Update " +
          "this guard to model the expansion, or drop the stanza.",
      );
    }
  }

  const extraKey = afterMatrix.match(/^\s+([a-zA-Z_][\w-]*):\s*\[/m);
  if (extraKey) {
    throw new Error(
      `ci.yml's matrix has a second dimension \`${extraKey[1]}:\`, so each ` +
        "context name is a combination of more than one matrix value. This " +
        "parser expands `node:` alone and would derive the wrong context " +
        "set. Update this guard to model the extra dimension.",
    );
  }

  return versions.map((v) => nameTemplate.replaceAll("${{ matrix.node }}", v));
}
