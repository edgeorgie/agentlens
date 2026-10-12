import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deriveContextsFromWorkflow,
  readMirroredContexts,
} from "../scripts/ci-contexts.mjs";

// The parser these tests exercise lives in `scripts/ci-contexts.mjs` because a
// second consumer needs it: `scripts/check-live-protection.mjs` compares the
// same derived names against the LIVE ruleset. See that file's header for why
// the live assertion is now possible (rulesets are readable with
// `metadata: read`, classic protection was not) and what it still cannot see.
//
// What each layer proves:
//   - this test:            mirror == workflow   (fails in the PR that drifts)
//   - check-live-protection: live ruleset == workflow (fails after a settings
//                            change, which no PR-time check can observe)

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
      `[${mirrored.join(", ")}]. Update the mirror, then update the ruleset ` +
      "with the `gh api` call documented at the top of that file " +
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
