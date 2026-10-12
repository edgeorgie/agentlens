import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Branch protection on `main` requires a list of literal status-check CONTEXT
// names. For a matrix job, a context name is `<job name template, expanded>`.
// Renaming the job or changing the matrix therefore renames every context,
// while protection goes on requiring names nothing can produce — which wedges
// `main` permanently, from an edit whose own CI was green.
//
// These tests derive the context names `ci.yml` actually produces and assert
// the committed mirror in `.github/required-status-checks.txt` matches. The
// drift becomes a red check in the PR that caused it.

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
function readMirroredContexts() {
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
function deriveContextsFromWorkflow() {
  const yaml = readFileSync(WORKFLOW_PATH, "utf8");

  const nameMatch = yaml.match(/^\s{4}name:\s*(.+?)\s*$/m);
  if (!nameMatch) {
    throw new Error(
      "could not find a job-level `name:` in ci.yml — the workflow shape " +
        "changed and this guard's parser needs updating",
    );
  }
  const nameTemplate = nameMatch[1];

  const matrixMatch = yaml.match(/^\s*node:\s*\[([^\]]+)\]\s*$/m);
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

  return versions.map((v) =>
    nameTemplate.replaceAll("${{ matrix.node }}", v),
  );
}

test("required-status-checks mirror matches the contexts ci.yml produces", () => {
  const derived = deriveContextsFromWorkflow();
  const mirrored = readMirroredContexts();

  assert.deepEqual(
    mirrored,
    derived,
    "`.github/required-status-checks.txt` is out of sync with ci.yml. " +
      `ci.yml now produces [${derived.join(", ")}] but the mirror lists ` +
      `[${mirrored.join(", ")}]. Update the mirror, then update branch ` +
      "protection with the `gh api` call documented at the top of that file " +
      "— otherwise protection will require contexts no run can produce and " +
      "`main` becomes unmergeable.",
  );
});

test("every required context is a Node version the package claims to support", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const declared = pkg.engines?.node;
  assert.ok(declared, "package.json must declare `engines.node`");

  const floor = declared.match(/>=\s*(\d+)/);
  assert.ok(
    floor,
    `expected engines.node to be a \`>=N\` range, got ${JSON.stringify(declared)}`,
  );
  const minSupported = Number(floor[1]);

  const tested = deriveContextsFromWorkflow().map((ctx) => {
    const major = ctx.match(/(\d+)/);
    assert.ok(major, `context ${JSON.stringify(ctx)} has no version number`);
    return Number(major[1]);
  });

  for (const version of tested) {
    assert.ok(
      version >= minSupported,
      `CI tests Node ${version} but package.json declares ` +
        `${declared} — a matrix entry below the declared floor tests a ` +
        "runtime the package does not claim to support",
    );
  }

  // The lower bound is the half that rots silently: the matrix drifts upward as
  // versions reach end-of-life while `engines` keeps advertising the old floor,
  // so the package claims support for a version nothing has ever run.
  assert.ok(
    tested.includes(minSupported),
    `package.json declares \`engines.node: ${declared}\` but the CI matrix ` +
      `tests [${tested.join(", ")}] — nothing verifies the declared floor ` +
      `(Node ${minSupported}). Either add it to the matrix or raise ` +
      "`engines.node` to the lowest version actually tested. Advertising a " +
      "floor no run exercises is an untested compatibility claim on a " +
      "published package.",
  );
});
