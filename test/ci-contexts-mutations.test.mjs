import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { deriveContextsFromSource } from "../scripts/ci-contexts.mjs";

// ---------------------------------------------------------------------------
// THE MUTATION SUITE
// ---------------------------------------------------------------------------
//
// `scripts/ci-contexts.mjs` derives the required status-check context names
// from ci.yml. It has been bypassed SIX times, and every bypass had the same
// root cause: the derivation modelled the workflow as TEXT (lines, indentation,
// a key regex) while GitHub acts on the PARSED DOCUMENT. Each of the five
// previous fixes closed exactly the one spelling that had just been
// demonstrated, and was broken by the next variant:
//
//   #13  protection required a context the matrix no longer produced
//   #15  `exclude:` was searched for only AFTER the `node:` line
//   #16  the identical stanza moved ABOVE `node:` walked through
//   #17  `'exclude':` — quoted — above `node:` was silently discarded
//
// Round seven replaced the scanner with a real YAML parse. This file is the
// evidence that the replacement is a different KIND of fix and not a seventh
// refinement. For every mutation class the review enumerated it asserts two
// things, and the second is what the previous rounds never had:
//
//   1. the guard FAILS CLOSED, with a message naming what it refused; and
//   2. the mutation is VALID YAML whose `jobs.test.strategy.matrix` really
//      contains the injected key — independently re-parsed here, so a mutation
//      that merely breaks the file cannot be miscounted as a closed bypass.
//
// Each spatial mutation is applied in BOTH placements, above and below the
// `node:` key. Placement was the entire mechanism of #16 and #17, so a suite
// that tested one side would be reproducing the original mistake.
//
// If you are reading this because you are about to change the derivation:
// run this file. If a mutation starts PASSING, that is bypass number seven.

const WORKFLOW = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

// The real matrix line in ci.yml. Every spatial mutation is expressed relative
// to it, so the suite tracks the real file instead of a copy that can rot.
const NODE_LINE = "        node: [20, 22, 24]";

assert.ok(
  WORKFLOW.includes(`\n${NODE_LINE}\n`),
  "the mutation suite anchors on the literal line " +
    `${JSON.stringify(NODE_LINE)} in ci.yml and can no longer find it. The ` +
    "matrix was reformatted; re-anchor the suite rather than deleting it.",
);

/** Inserts `block` immediately BEFORE the real `node:` line. */
function above(block) {
  return WORKFLOW.replace(`${NODE_LINE}\n`, `${block}\n${NODE_LINE}\n`);
}

/** Inserts `block` immediately AFTER the real `node:` line. */
function below(block) {
  return WORKFLOW.replace(`${NODE_LINE}\n`, `${NODE_LINE}\n${block}\n`);
}

/**
 * What a real YAML parser says `jobs.test.strategy.matrix` is for a source.
 * This is the independent oracle: it is NOT the code under test.
 */
function realMatrix(source) {
  return parseYaml(source, { merge: true }).jobs.test.strategy.matrix;
}

/** What a real YAML parser says the gated job is. */
function realJob(source) {
  return parseYaml(source, { merge: true }).jobs.test;
}

// ---------------------------------------------------------------------------
// Baseline: the guard must still work on the real, unmutated file.
// ---------------------------------------------------------------------------

test("baseline: the real ci.yml derives exactly the three Node contexts", () => {
  assert.deepEqual(deriveContextsFromSource(WORKFLOW), [
    "Node 20",
    "Node 22",
    "Node 24",
  ]);
});

// ---------------------------------------------------------------------------
// Class 1 — an extra matrix key, in every spelling, in both placements.
//
// These are the six bypasses. Each injects a key under `matrix:` that changes
// which jobs GitHub runs (or what they are called) while the `node:` list
// itself is untouched. A text scanner has to recognise the spelling; a parser
// just sees a key that is not `node`.
// ---------------------------------------------------------------------------

const EXTRA_KEY_MUTATIONS = [
  {
    label: "bare exclude (the #16 bypass)",
    block: "        exclude: [{node: 22}]",
    key: "exclude",
  },
  {
    label: "single-quoted exclude (the #17 bypass)",
    block: "        'exclude': [{node: 22}]",
    key: "exclude",
  },
  {
    label: "double-quoted include",
    block: '        "include": [{node: 23}]',
    key: "include",
  },
  {
    label: "explicit-key form (? key / : value)",
    block: "        ? exclude\n        : [{node: 22}]",
    key: "exclude",
  },
  {
    label: "non-ASCII lookalike (Cyrillic е, U+0435)",
    block: "        exclud\u0435: [{node: 22}]",
    key: "exclud\u0435",
  },
  {
    label: "a second dimension (os), quoted",
    block: "        'os': [ubuntu-latest]",
    key: "os",
  },
  {
    label: "a second dimension (os), bare",
    block: "        os: [ubuntu-latest, ubuntu-24.04]",
    key: "os",
  },
  {
    label: "block-sequence exclude rather than flow",
    block: "        exclude:\n          - node: 22",
    key: "exclude",
  },
  {
    label: "quoted block-sequence exclude",
    block: "        'exclude':\n          - node: 22",
    key: "exclude",
  },
  {
    label: "three extra keys at once",
    block:
      "        'exclude': [{node: 22}]\n" +
      '        "include": [{node: 23}]\n' +
      "        os: [ubuntu-latest]",
    key: "exclude",
  },
  {
    label: "folded block scalar as a key's value",
    block: "        'exclude': >-\n          [{node: 22}]",
    key: "exclude",
  },
  {
    label: "an anchored extra key referenced nowhere",
    block: "        exclude: &ex [{node: 22}]",
    key: "exclude",
  },
];

for (const { label, block, key } of EXTRA_KEY_MUTATIONS) {
  for (const [placement, apply] of [
    ["above node:", above],
    ["below node:", below],
  ]) {
    test(`extra matrix key — ${label} — ${placement}`, () => {
      const mutated = apply(block);

      // Oracle first: if this is not a real matrix change, the assertion
      // below would be meaningless.
      const matrix = realMatrix(mutated);
      assert.ok(
        Object.prototype.hasOwnProperty.call(matrix, key),
        `the mutation is supposed to inject \`${key}\` into ` +
          `jobs.test.strategy.matrix, but a real YAML parse says the matrix ` +
          `is ${JSON.stringify(matrix)}. The mutation is broken, not the guard.`,
      );

      assert.throws(
        () => deriveContextsFromSource(mutated),
        (error) => {
          assert.match(error.message, /matrix defines/);
          assert.ok(
            error.message.includes(key),
            `the guard refused the workflow but did not name \`${key}\`: ` +
              error.message,
          );
          return true;
        },
        `the guard ACCEPTED a matrix containing \`${key}\` placed ` +
          `${placement}. This is a bypass: GitHub would run a different set ` +
          "of jobs than the contexts this guard derived.",
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Class 2 — the merge key.
//
// This is the mutation that proves the point. `<<: *anchor` injects `exclude`
// into the matrix without the string `exclude` appearing anywhere under
// `matrix:`, so NO regex over lines can see it, however many quote forms it
// learns. It is the reason this guard parses instead of scanning.
// ---------------------------------------------------------------------------

const MERGE_ANCHOR = "x-extra: &extra\n  exclude:\n    - node: 22\n";

for (const [placement, apply] of [
  ["above node:", above],
  ["below node:", below],
]) {
  test(`merge key (<<: *anchor) injects exclude — ${placement}`, () => {
    const mutated = MERGE_ANCHOR + apply("        <<: *extra");

    const matrix = realMatrix(mutated);
    assert.deepEqual(
      matrix.exclude,
      [{ node: 22 }],
      "the merge key is supposed to pull `exclude` into the matrix; a real " +
        `parse says the matrix is ${JSON.stringify(matrix)}`,
    );
    // And the decisive property: the token never appears under `matrix:`.
    const afterMatrix = mutated.slice(mutated.indexOf("      matrix:"));
    assert.ok(
      !afterMatrix.slice(0, afterMatrix.indexOf("    steps:")).includes("exclude"),
      "this mutation is only interesting because `exclude` does not appear " +
        "literally under `matrix:`; if it does, the test no longer proves " +
        "that a line scanner is structurally blind to it",
    );

    assert.throws(
      () => deriveContextsFromSource(mutated),
      /matrix defines .*exclude/,
      `the guard ACCEPTED a merge-key-injected \`exclude\` ${placement}. ` +
        "A line scanner cannot catch this; if the parse-based guard does not " +
        "either, the structural fix has regressed.",
    );
  });
}

// ---------------------------------------------------------------------------
// Class 3 — flow / inline style for the matrix itself.
//
// The previous scanner required `matrix:` to be a block mapping on its own
// line and threw `could not find a 'matrix:' block` on the flow form. That was
// a fail-closed accident of the anchor, not a decision. A parser sees the same
// mapping either way, so the extra key is caught on its merits.
// ---------------------------------------------------------------------------

test("flow mapping matrix with an extra key fails closed", () => {
  const mutated = WORKFLOW.replace(
    /^ {6}matrix:\n(?: {8}.*\n| *\n)*/m,
    "      matrix: {node: [20, 22, 24], exclude: [{node: 22}]}\n",
  );
  assert.deepEqual(realMatrix(mutated), {
    node: [20, 22, 24],
    exclude: [{ node: 22 }],
  });
  assert.throws(
    () => deriveContextsFromSource(mutated),
    /matrix defines .*exclude/,
  );
});

test("flow mapping matrix WITHOUT an extra key still derives correctly", () => {
  // Style must not change the verdict in either direction: a legitimate
  // reformat has to keep working, or the guard cries wolf and gets disabled.
  const mutated = WORKFLOW.replace(
    /^ {6}matrix:\n(?: {8}.*\n| *\n)*/m,
    "      matrix: {node: [20, 22, 24]}\n",
  );
  assert.deepEqual(deriveContextsFromSource(mutated), [
    "Node 20",
    "Node 22",
    "Node 24",
  ]);
});

test("block-sequence node list (not flow) still derives correctly", () => {
  // The old guard hard-required a flow sequence and threw on the block form.
  // That is a false positive on a pure reformat; the parser handles both.
  const mutated = WORKFLOW.replace(
    `${NODE_LINE}\n`,
    "        node:\n          - 20\n          - 22\n          - 24\n",
  );
  assert.deepEqual(realMatrix(mutated), { node: [20, 22, 24] });
  assert.deepEqual(deriveContextsFromSource(mutated), [
    "Node 20",
    "Node 22",
    "Node 24",
  ]);
});

// ---------------------------------------------------------------------------
// Class 4 — block scalars containing text that LOOKS like matrix keys.
//
// The mirror image of class 1: text that a scanner would see as a key but
// which a parser knows is inert string content. A guard that fails here is
// crying wolf, which is how guards get deleted.
// ---------------------------------------------------------------------------

for (const [label, style] of [
  ["literal (|)", "|"],
  ["folded (>)", ">"],
]) {
  test(`a ${label} block scalar that merely MENTIONS exclude: is not a key`, () => {
    const mutated = WORKFLOW.replace(
      "    steps:\n",
      `    env:\n      NOTE: ${style}-\n        exclude: [{node: 22}]\n        os: [ubuntu-latest]\n    steps:\n`,
    );
    const matrix = realMatrix(mutated);
    assert.deepEqual(
      matrix,
      { node: [20, 22, 24] },
      "the block scalar must not actually add a matrix key, or this test is " +
        "asserting the wrong thing",
    );
    assert.ok(
      typeof realJob(mutated).env.NOTE === "string",
      "the lookalike text must parse as a string value",
    );
    assert.deepEqual(deriveContextsFromSource(mutated), [
      "Node 20",
      "Node 22",
      "Node 24",
    ]);
  });
}

// ---------------------------------------------------------------------------
// Class 5 — a decoy `test:` / `strategy:` / `matrix:` elsewhere in the file.
//
// The old `extractBlock` ran `findIndex` over EVERY line in the file looking
// for `^ {2}test:`, unscoped to `jobs:`. A decoy earlier in the file hijacked
// the scan and the guard reported a fabricated fourth context (`Node 99`).
// Reading `jobs.test` off the parsed object makes position irrelevant.
// ---------------------------------------------------------------------------

test("a decoy test:/matrix: in a workflow_dispatch input is ignored", () => {
  const mutated = WORKFLOW.replace(
    "  workflow_dispatch:\n",
    "  workflow_dispatch:\n" +
      "    inputs:\n" +
      "      note:\n" +
      "        description: |\n" +
      "          test:\n" +
      "            strategy:\n" +
      "              matrix:\n" +
      "                node: [99]\n" +
      "        required: false\n",
  );
  assert.deepEqual(realMatrix(mutated), { node: [20, 22, 24] });
  assert.deepEqual(deriveContextsFromSource(mutated), [
    "Node 20",
    "Node 22",
    "Node 24",
  ]);
});

test("a SECOND real job with its own matrix does not affect the gated job", () => {
  const mutated = WORKFLOW.replace(
    "jobs:\n",
    "jobs:\n" +
      "  decoy:\n" +
      "    name: Decoy ${{ matrix.node }}\n" +
      "    runs-on: ubuntu-latest\n" +
      "    strategy:\n" +
      "      matrix:\n" +
      "        node: [99]\n" +
      "        exclude: [{node: 99}]\n" +
      "    steps:\n" +
      "      - run: 'true'\n",
  );
  assert.deepEqual(realMatrix(mutated), { node: [20, 22, 24] });
  // Job ORDER is now irrelevant, which is the property the old comment
  // claimed and the old code did not have.
  assert.deepEqual(deriveContextsFromSource(mutated), [
    "Node 20",
    "Node 22",
    "Node 24",
  ]);
});

test("renaming the gated job away fails closed rather than silently", () => {
  const mutated = WORKFLOW.replace("\n  test:\n", "\n  tests:\n");
  assert.throws(
    () => deriveContextsFromSource(mutated),
    /has no `test:` job/,
    "if the gated job id disappears the guard must refuse, not derive an " +
      "empty or stale set",
  );
});

// ---------------------------------------------------------------------------
// Class 6 — matrix VALUE types.
//
// GitHub interpolates a matrix value's string form, so the YAML scalar type
// does not reach the context name. Verified on a real run, not assumed:
// edgeorgie/qa-injection-test-repo run 38235526774 reported `Node 20`/`Node 24`
// for `node: [20, 24]` and `NodeQ 20`/`NodeQ 24` for `node: ["20", "24"]`, and
// the same names appear in `GET /commits/{sha}/check-runs`, which is what
// branch protection matches on.
// ---------------------------------------------------------------------------

test("quoted matrix values produce the same contexts as bare ones", () => {
  const mutated = WORKFLOW.replace(
    NODE_LINE,
    '        node: ["20", "22", "24"]',
  );
  assert.deepEqual(realMatrix(mutated), { node: ["20", "22", "24"] });
  assert.deepEqual(deriveContextsFromSource(mutated), [
    "Node 20",
    "Node 22",
    "Node 24",
  ]);
});

test("values that render to the same string fail closed as colliding", () => {
  // `20` and `"20"` are different YAML scalars that GitHub renders to the same
  // text, so two matrix jobs would report ONE context name and protection
  // could not distinguish them. Deriving three names here would be wrong.
  const mutated = WORKFLOW.replace(NODE_LINE, '        node: [20, "20", 24]');
  assert.deepEqual(realMatrix(mutated), { node: [20, "20", 24] });
  assert.throws(() => deriveContextsFromSource(mutated), /duplicate values/);
});

test("a non-scalar matrix value fails closed", () => {
  const mutated = WORKFLOW.replace(
    NODE_LINE,
    "        node: [20, {version: 22}, 24]",
  );
  assert.throws(() => deriveContextsFromSource(mutated), /non-scalar entry/);
});

test("an empty node list fails closed instead of deriving nothing", () => {
  const mutated = WORKFLOW.replace(NODE_LINE, "        node: []");
  assert.deepEqual(realMatrix(mutated), { node: [] });
  assert.throws(() => deriveContextsFromSource(mutated), /empty sequence/);
});

test("a scalar node value (not a list) fails closed", () => {
  const mutated = WORKFLOW.replace(NODE_LINE, "        node: 20");
  assert.throws(() => deriveContextsFromSource(mutated), /is not a sequence/);
});

test("a missing node key fails closed", () => {
  const mutated = WORKFLOW.replace(NODE_LINE, "        nodes: [20, 22, 24]");
  assert.throws(() => deriveContextsFromSource(mutated), /matrix defines/);
});

// ---------------------------------------------------------------------------
// Class 7 — the job NAME, which is what a context name literally is.
// ---------------------------------------------------------------------------

test("a job-level name override is tracked, not assumed away", () => {
  const mutated = WORKFLOW.replace(
    "    name: Node ${{ matrix.node }}\n",
    "    name: Node ${{ matrix.node }} (linux)\n",
  );
  assert.deepEqual(deriveContextsFromSource(mutated), [
    "Node 20 (linux)",
    "Node 22 (linux)",
    "Node 24 (linux)",
  ]);
});

test("removing the job-level name derives GitHub's documented default", () => {
  // Verified on run 38235526774: a matrix job with id `unnamed` and no
  // `name:` reported `unnamed (20)` / `unnamed (24)` — the job id plus the
  // parenthesised value, not the bare id. The previous guard threw here,
  // which was safe but needlessly brittle on a plausible edit.
  const mutated = WORKFLOW.replace("    name: Node ${{ matrix.node }}\n", "");
  assert.ok(!("name" in realJob(mutated)));
  assert.deepEqual(deriveContextsFromSource(mutated), [
    "test (20)",
    "test (22)",
    "test (24)",
  ]);
});

test("a name that does not interpolate matrix.node fails closed", () => {
  const mutated = WORKFLOW.replace(
    "    name: Node ${{ matrix.node }}\n",
    "    name: Tests\n",
  );
  assert.throws(
    () => deriveContextsFromSource(mutated),
    /does not interpolate/,
    "without the matrix value in the name every matrix job reports the same " +
      "context, which this guard must not model as three distinct ones",
  );
});

test("a name interpolating something this guard cannot evaluate fails closed", () => {
  const mutated = WORKFLOW.replace(
    "    name: Node ${{ matrix.node }}\n",
    "    name: Node ${{ matrix.node }} on ${{ github.ref_name }}\n",
  );
  assert.throws(() => deriveContextsFromSource(mutated), /cannot evaluate/);
});

// ---------------------------------------------------------------------------
// Class 8 — disarming the gate without touching a single context name.
//
// `continue-on-error` and a job-level `if:` leave the matrix, the job name and
// every derived context identical, while making the required check unable to
// report failure at all. No name-comparison check can see these, which is why
// they are asserted structurally here.
// ---------------------------------------------------------------------------

test("continue-on-error on the gated job fails closed", () => {
  const mutated = WORKFLOW.replace(
    "    runs-on: ubuntu-latest\n    strategy:\n",
    "    continue-on-error: true\n    runs-on: ubuntu-latest\n    strategy:\n",
  );
  assert.equal(realJob(mutated)["continue-on-error"], true);
  assert.throws(
    () => deriveContextsFromSource(mutated),
    /continue-on-error/,
    "the context names are unchanged, so only a structural check catches " +
      "this — the required gate would report green unconditionally",
  );
});

test("a job-level if: on the gated job fails closed", () => {
  const mutated = WORKFLOW.replace(
    "    runs-on: ubuntu-latest\n    strategy:\n",
    "    if: github.event_name != 'push'\n    runs-on: ubuntu-latest\n    strategy:\n",
  );
  assert.throws(
    () => deriveContextsFromSource(mutated),
    /is conditional/,
    "branch protection treats a skipped job's context as satisfied, so an " +
      "`if:` silently disarms every required check with no name change",
  );
});

test("continue-on-error on a STEP of the gated job fails closed", () => {
  const mutated = WORKFLOW.replace(
    "      - run: npm test\n",
    "      - run: npm test\n        continue-on-error: true\n",
  );
  assert.throws(
    () => deriveContextsFromSource(mutated),
    /step\(s\) with `continue-on-error`/,
  );
});

// ---------------------------------------------------------------------------
// Class 9 — degenerate documents. None may pass vacuously.
//
// The `steps:` stanza in the hand-built fixtures below is load-bearing, not
// boilerplate: `assertJobCanFail` now REJECTS a gated job with no readable
// `steps:` sequence (it used to skip its step-level `continue-on-error` check
// silently in that case). Without the stanza these fixtures would fail closed
// on the wrong assertion and stop testing the shape each one names — a passing
// test that proves something other than its own title.
// ---------------------------------------------------------------------------

/** A minimal `steps:` stanza, so a fixture reaches the assertion it targets. */
const MINIMAL_STEPS = "    steps:\n      - run: npm test\n";

for (const [label, source, pattern] of /** @type {[string, string, RegExp][]} */ ([
  ["not valid YAML", "jobs:\n  test:\n   - [unclosed\n", /not valid YAML/],
  ["an empty document", "", /did not parse to a mapping/],
  ["a sequence document", "- a\n- b\n", /did not parse to a mapping/],
  ["no jobs: key", "name: CI\non: push\n", /no `jobs:` mapping/],
  ["jobs: is a sequence", "jobs:\n  - test\n", /no `jobs:` mapping/],
  [
    "the gated job has no steps:",
    "jobs:\n  test:\n    name: Node ${{ matrix.node }}\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20]\n",
    /no `steps:` sequence/,
  ],
  [
    "the gated job's steps: is not a sequence",
    "jobs:\n  test:\n    name: Node ${{ matrix.node }}\n    runs-on: ubuntu-latest\n    steps: nope\n    strategy:\n      matrix:\n        node: [20]\n",
    /no `steps:` sequence/,
  ],
  [
    "the gated job has no strategy:",
    `jobs:\n  test:\n    name: Node \${{ matrix.node }}\n    runs-on: ubuntu-latest\n${MINIMAL_STEPS}`,
    /no `strategy:` mapping/,
  ],
  [
    "the gated job has no matrix:",
    `jobs:\n  test:\n    runs-on: ubuntu-latest\n${MINIMAL_STEPS}    strategy:\n      fail-fast: false\n`,
    /has no `matrix:` mapping/,
  ],
  [
    "duplicate keys (YAML forbids, the old scanner overwrote silently)",
    WORKFLOW.replace(`${NODE_LINE}\n`, `${NODE_LINE}\n${NODE_LINE.replace("[20, 22, 24]", "[99]")}\n`),
    /not valid YAML/,
  ],
])) {
  test(`degenerate input — ${label} — fails closed`, () => {
    // `pattern` is annotated RegExp above, and that annotation is the whole
    // point. It was previously inferred `string | RegExp` from the table, and
    // `checkJs` flagged it (TS2769) precisely because Node's
    // `assert.throws(fn, "some string")` treats the string as the ASSERTION'S
    // OWN MESSAGE, not as a matcher — such a call accepts ANY error thrown,
    // including one from a completely different failure path. Verified: swap
    // one entry's /not valid YAML/ for "not valid YAML" and the whole suite
    // still reports green with that guard accepting anything. In the suite
    // whose job is catching merge-gate bypasses, that is the worst possible
    // place for a vacuous assertion.
    assert.throws(() => deriveContextsFromSource(source), pattern);
  });
}
