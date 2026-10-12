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
// ruleset).

const WORKFLOW_PATH = new URL("../.github/workflows/ci.yml", import.meta.url);
const MIRROR_PATH = new URL(
  "../.github/required-status-checks.txt",
  import.meta.url,
);

// The only matrix key this module knows how to expand. Anything else under
// `matrix:` makes the derived set wrong, so it is rejected, not ignored.
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
 * Extracts a block-mapping key's lines by indentation: the following lines
 * indented deeper than the key, stopping at the first indented the same or
 * less. Blank and comment-only lines do not terminate a block.
 *
 * @param {string[]} lines source lines
 * @param {RegExp} keyPattern anchored pattern matching the key's own line
 * @param {string} description what was looked for, for the error message
 * @returns {{indent: number, body: string[]}}
 * @throws {Error} if the key is not found
 */
function extractBlock(lines, keyPattern, description) {
  const startIndex = lines.findIndex((line) => keyPattern.test(line));
  if (startIndex === -1) {
    throw new Error(
      `could not find ${description} in ci.yml — the workflow shape changed ` +
        "and this guard's parser needs updating",
    );
  }
  const header = lines[startIndex];
  const indent = header.length - header.trimStart().length;

  const body = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      body.push(line);
      continue;
    }
    if (line.length - line.trimStart().length <= indent) break;
    body.push(line);
  }
  return { indent, body };
}

/**
 * Lists every key defined directly under the `matrix:` block, with its value
 * lines.
 *
 * This is what makes the guard ordering-independent, and it exists because the
 * previous implementation was not. That version searched for
 * `exclude:`/`include:` only in the text FOLLOWING the `node:` line, so moving
 * the identical stanza above `node:` bypassed it completely: the guard derived
 * [Node 20, Node 22, Node 24] and exited 0 while GitHub produced only
 * [Node 20, Node 24], leaving `main` wedged on a required context no run
 * reports. YAML mappings are unordered — a check that depends on where a
 * sibling key sits in the text is not a check.
 *
 * @param {string[]} matrixBody lines inside the `matrix:` block
 * @param {number} matrixIndent indentation of the `matrix:` key itself
 * @returns {Map<string, string[]>} key -> its value lines
 */
function readMatrixKeys(matrixBody, matrixIndent) {
  const keys = new Map();
  let current = null;

  for (const line of matrixBody) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    const keyMatch = line.match(/^\s*([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (keyMatch && indent === matrixIndent + 2) {
      current = keyMatch[1];
      keys.set(current, [keyMatch[2]]);
      continue;
    }
    // Deeper lines are part of the current key's value — e.g. the `- node: 22`
    // items of a block sequence.
    if (current) keys.get(current).push(line);
  }
  return keys;
}

/**
 * Derives the status-check context names the CI workflow produces, by reading
 * the workflow definition rather than restating it.
 *
 * Narrow by design: it understands one matrix job keyed solely on `node`, named
 * `Node ${{ matrix.node }}`. Anything outside that shape throws, because a
 * parser that returned a stale or empty set on an unrecognised workflow would
 * let the assertion pass vacuously — the exact failure this guard exists to
 * prevent, and the one it has already failed at twice.
 *
 * @returns {string[]} expanded context names, in matrix order
 * @throws {Error} if the workflow no longer matches the expected shape
 */
export function deriveContextsFromWorkflow() {
  const lines = readFileSync(WORKFLOW_PATH, "utf8").split("\n");

  // Scoped to the `test:` job, not the first 4-space `name:` in the file:
  // ci.yml has more than one job, so a bare first-match would read whichever
  // appears first in the source, making mere job reordering change the result.
  const job = extractBlock(lines, /^ {2}test:\s*$/, "a `test:` job");

  const nameLine = job.body.find((line) => /^ {4}name:\s*\S/.test(line));
  if (!nameLine) {
    throw new Error(
      "could not find a job-level `name:` in ci.yml's `test:` job — the " +
        "workflow shape changed and this guard's parser needs updating",
    );
  }
  const nameTemplate = nameLine.replace(/^\s*name:\s*/, "").trim();

  if (!nameTemplate.includes("${{ matrix.node }}")) {
    throw new Error(
      `job name ${JSON.stringify(nameTemplate)} does not interpolate ` +
        "`matrix.node`, so contexts are no longer one-per-matrix-value — " +
        "this guard's parser needs updating",
    );
  }

  const matrix = extractBlock(
    job.body,
    /^ {6}matrix:\s*$/,
    "a `matrix:` block in the `test:` job",
  );
  const matrixKeys = readMatrixKeys(matrix.body, matrix.indent);

  // Fail closed on ANY key that is not `node`, in any position or style.
  // `exclude:` removes a combination so a listed version produces no context;
  // `include:` adds an unlisted one; a second dimension (`os:`, `ts:`)
  // multiplies every name. Each silently invalidates the derived set, and
  // hand-modelling GitHub's expansion would be its own source of wrongness.
  const unsupported = [...matrixKeys.keys()].filter(
    (key) => !SUPPORTED_MATRIX_KEYS.has(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `ci.yml's matrix defines ${unsupported.map((k) => `\`${k}:\``).join(", ")}, ` +
        "which this guard cannot expand. Those keys change which contexts are " +
        "produced without changing the `node:` list, so the derived set would " +
        "be wrong while this check reported green — wedging `main` on a " +
        "context no run can report. Teach this guard the expansion, or drop " +
        "the key.",
    );
  }

  const nodeValue = matrixKeys.get("node");
  if (!nodeValue) {
    throw new Error(
      "ci.yml's matrix has no `node:` key — the workflow shape changed and " +
        "this guard's parser needs updating",
    );
  }

  // Flow sequence only (`node: [20, 22, 24]`). A block sequence needs
  // different parsing, so it is rejected rather than mis-read.
  const flow = nodeValue.join(" ").match(/^\s*\[([^\]]*)\]\s*$/);
  if (!flow) {
    throw new Error(
      "ci.yml's `node:` matrix is not a flow sequence (`node: [20, 22]`). " +
        "This guard reads only that form; convert it back, or teach the guard " +
        "the other form — it must not guess at the values.",
    );
  }
  const versions = flow[1]
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  if (versions.length === 0) {
    throw new Error("parsed an empty `node:` matrix from ci.yml");
  }

  return versions.map((v) => nameTemplate.replaceAll("${{ matrix.node }}", v));
}
