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
  const matrixBlock = yaml.slice(
    yaml.indexOf(matrixMatch[0]) + matrixMatch[0].length,
  );
  const afterMatrix = matrixBlock.slice(0, matrixBlock.indexOf("\n    steps:"));

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

  return versions.map((v) =>
    nameTemplate.replaceAll("${{ matrix.node }}", v),
  );
}

test("required-status-checks mirror matches the contexts ci.yml produces", () => {
  const derived = deriveContextsFromWorkflow();
  const mirrored = readMirroredContexts();

  // Compared as SETS, not sequences. Branch protection stores required
  // contexts as an unordered collection — reordering the matrix changes
  // nothing about what protection needs — so an order-sensitive assertion here
  // would fail on a reorder that carries no risk at all, and send the reader
  // to run a `gh api` call that was never necessary. A guard that cries wolf
  // on a safe edit gets disabled, which costs more than the check is worth.
  assert.deepEqual(
    [...mirrored].sort(),
    [...derived].sort(),
    "`.github/required-status-checks.txt` is out of sync with ci.yml. " +
      `ci.yml now produces [${derived.join(", ")}] but the mirror lists ` +
      `[${mirrored.join(", ")}]. Update the mirror, then update branch ` +
      "protection with the `gh api` call documented at the top of that file " +
      "— otherwise protection will require contexts no run can produce and " +
      "`main` becomes unmergeable.",
  );

  assert.equal(
    new Set(mirrored).size,
    mirrored.length,
    `the mirror lists a duplicate context: [${mirrored.join(", ")}]. ` +
      "Protection treats contexts as a set, so a duplicate is always a typo " +
      "and would mask a genuine mismatch once the lists are sorted.",
  );
});

test("every required context is a Node version the package claims to support", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const declared = pkg.engines?.node;
  assert.ok(declared, "package.json must declare `engines.node`");

  // Only a bare `>=N` / `>=N.N.N` range is understood. A compound range
  // (`>=20 <23`), a caret/tilde range, or an `||` union all have an upper bound
  // or a shape this check does not model: `/>=\s*(\d+)/` would find the floor
  // and silently ignore the ceiling, so a matrix testing Node 24 against a
  // declared `>=20 <23` would pass while advertising support it contradicts.
  // Refusing to interpret is the honest behaviour — a guard that silently
  // accepts a range it does not understand is worse than no guard.
  assert.match(
    declared,
    /^>=\s*\d+(\.\d+)*$/,
    `engines.node is ${JSON.stringify(declared)}, which this check does ` +
      "not model. It understands only a bare `>=N` lower bound; a compound " +
      "or upper-bounded range needs this guard extended rather than " +
      "silently half-parsed.",
  );

  const floor = declared.match(/>=\s*(\d+)/);
  assert.ok(
    floor,
    `expected engines.node to be a \`>=N\` range, got ${JSON.stringify(declared)}`,
  );
  const minSupported = Number(floor[1]);

  const tested = deriveContextsFromWorkflow().map((ctx) => {
    // Anchored to the END of the context name: the name is
    // `<prefix> <version>`, and an unanchored `/(\d+)/` would read the first
    // digit anywhere in the prefix instead (a job named `CI2 Node 20` parses
    // as major version 2).
    const major = ctx.match(/(\d+)(?:\.\d+)*\s*$/);
    assert.ok(
      major,
      `context ${JSON.stringify(ctx)} does not end in a version number, so ` +
        "the Node version it tests cannot be read from its name",
    );
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
