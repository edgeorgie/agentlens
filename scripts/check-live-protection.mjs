#!/usr/bin/env node
//
// Asserts that the LIVE branch protection on `main` requires exactly the status
// checks `ci.yml` actually produces.
//
// WHY THIS EXISTS, AND WHAT IT REPLACES
//
// `test/required-status-checks.test.mjs` compares `ci.yml` against a committed
// mirror file. That catches a matrix edit that forgets to update the mirror —
// but it can only ever prove `mirror == workflow`. It cannot prove
// `mirror == live protection`, and live protection is the thing that actually
// wedges `main`: if protection requires `Node 22` and no run produces that
// context, every PR waits forever on a check that will never report.
//
// Historically this gap was unavoidable. Classic branch protection is readable
// only with `administration` permission, which `GITHUB_TOKEN` does not have and
// cannot be granted, so a workflow could not see the live state at all.
//
// Rulesets changed that. `GET /repos/{owner}/{repo}/rules/branches/{branch}`
// requires only `metadata: read` and, on a public repository, answers
// unauthenticated. So the live required-context list is now readable from inside
// a workflow run, and the drift can be asserted directly instead of guarded by
// proxy. That is why `main`'s protection was migrated from classic protection to
// a ruleset: not cosmetics, but to make the real state observable.
//
// WHAT THIS CANNOT SEE (stated so the check is not over-trusted)
//
//   - Rulesets whose enforcement is `evaluate` or `disabled` are omitted from
//     the response entirely (documented behaviour). This check therefore cannot
//     distinguish "no ruleset exists" from "a ruleset exists but is switched
//     off" — both surface as a missing rule, and both mean `main` is
//     unprotected, so both fail here. That conflation is safe in this
//     direction; it would not be if the check reported "protected".
//
// `bypass_actors` used to be listed here as a second blind spot, on the grounds
// that this endpoint does not return it. That was true but not a limitation: the
// response carries `ruleset_id`, and GET /repos/{o}/{r}/rulesets/{id} returns
// bypass_actors under the same `metadata: read`. The check now follows that id,
// because a ruleset requiring every context with a bypass actor attached is a
// gate the listed actor merges straight past — the same shape as
// `enforce_admins: false`.
//
// WHY THIS IS NOT ITSELF A REQUIRED STATUS CHECK
//
// It calls api.github.com, so a GitHub API incident would turn it red. Making a
// network-dependent job a required context means an outage blocks merging —
// exactly the deadlock this file exists to detect. It runs on `main` pushes and
// on a daily schedule instead, where it reports drift without holding the merge
// gate hostage. Drift here is also not introduced by a PR: it comes from
// someone changing repository settings, which no PR-time check could observe.

import { deriveContextsFromWorkflow } from "./ci-contexts.mjs";

const REPO = process.env.GITHUB_REPOSITORY ?? "edgeorgie/agentlens";
const BRANCH = "main";
// `?per_page=100`: this endpoint paginates at 30 by default, and a truncated
// page would silently drop a rule — making an absent `deletion` rule, or a
// second ruleset's bypass actors, read as "not present" rather than "not shown".
const API = `https://api.github.com/repos/${REPO}/rules/branches/${BRANCH}?per_page=100`;


/**
 * Fetches the rules that apply to `main`, with a short retry on transient
 * failures so a single blip does not produce a misleading report.
 *
 * @returns {Promise<Array<{type: string, parameters?: object}>>}
 * @throws {Error} if the API cannot be read after retries
 */
async function fetchLiveRules() {
  const headers = { Accept: "application/vnd.github+json" };
  // Authenticate when a token is present (private repos, and a far higher rate
  // limit), but do not require one: on a public repo this endpoint is readable
  // anonymously, so the check still works in a fork or a local run.
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API, { headers });
      if (!res.ok) {
        throw new Error(`${API} responded HTTP ${res.status} ${res.statusText}`);
      }
      const body = await res.json();
      if (!Array.isArray(body)) {
        throw new Error(
          `expected a JSON array of rules, got ${typeof body}: ` +
            JSON.stringify(body).slice(0, 200),
        );
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
  }
  throw new Error(
    `could not read live branch rules after 3 attempts: ${lastError?.message}`,
  );
}

/**
 * Exits non-zero with an explanation. Collected into one place so every failure
 * path says what drifted and what to run, rather than printing a bare diff.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`✗ live branch protection check FAILED\n\n${message}\n`);
  process.exit(1);
}

const [rules, expected] = await Promise.all([
  fetchLiveRules(),
  Promise.resolve(deriveContextsFromWorkflow()),
]);

const statusCheckRule = rules.find((r) => r.type === "required_status_checks");

if (!statusCheckRule) {
  fail(
    `no active \`required_status_checks\` rule applies to \`${BRANCH}\` in ` +
      `${REPO}.\n\n` +
      `Rules currently returned: ${
        rules.length === 0
          ? "(none — the branch is unprotected)"
          : rules.map((r) => r.type).join(", ")
      }\n\n` +
      "Either no ruleset covers this branch, or the ruleset's enforcement is " +
      "set to `evaluate`/`disabled` (those are omitted from this endpoint). " +
      "Both leave `main` mergeable with no passing CI. Expected contexts " +
      `derived from ci.yml: [${expected.join(", ")}].`,
  );
}

const live = (statusCheckRule.parameters?.required_status_checks ?? []).map(
  (c) => c.context,
);

if (live.length === 0) {
  fail(
    "a `required_status_checks` rule applies but its context list is EMPTY, " +
      "so it requires nothing and any commit can merge. Expected " +
      `[${expected.join(", ")}].`,
  );
}

// Compared as SETS: protection stores required contexts as an unordered
// collection, so a reorder carries no risk and must not fail the check. A guard
// that cries wolf on a safe edit gets ignored.
const liveSet = new Set(live);
const expectedSet = new Set(expected);
const missing = expected.filter((c) => !liveSet.has(c));
const extra = live.filter((c) => !expectedSet.has(c));

if (missing.length > 0 || extra.length > 0) {
  const parts = [];
  if (extra.length > 0) {
    parts.push(
      `REQUIRED BUT NEVER PRODUCED: [${extra.join(", ")}]\n` +
        "  These contexts are required by the live ruleset but no job in " +
        "ci.yml emits them. Every PR will wait on them forever — `main` is " +
        "WEDGED right now. This is the deadlock this check exists to find.",
    );
  }
  if (missing.length > 0) {
    parts.push(
      `PRODUCED BUT NOT REQUIRED: [${missing.join(", ")}]\n` +
        "  ci.yml runs these jobs but the ruleset does not require them, so a " +
        "commit failing them can still merge. The gate is weaker than it looks.",
    );
  }

  fail(
    `${parts.join("\n\n")}\n\n` +
      `live ruleset requires: [${live.join(", ")}]\n` +
      `ci.yml produces:       [${expected.join(", ")}]\n\n` +
      "Fix by updating the ruleset to match ci.yml (needs admin, so it cannot " +
      "be done from a workflow run):\n\n" +
      `  gh api repos/${REPO}/rulesets --jq '.[] | select(.target=="branch") | .id'\n` +
      `  gh api -X PUT repos/${REPO}/rulesets/<id> --input <edited-ruleset.json>\n`,
  );
}

if (statusCheckRule.parameters?.strict_required_status_checks_policy !== true) {
  fail(
    "the required contexts match, but `strict_required_status_checks_policy` " +
      "is false, so a PR can merge on a CI result from a stale base. The " +
      "checks passed against code that is not what lands on `main`.",
  );
}

// The deletion and non-fast-forward rules are asserted too, because the
// contexts matching says nothing about them: delete both and this check would
// have stayed green while `main` became force-pushable and deletable.
const requiredRuleTypes = ["deletion", "non_fast_forward"];
const presentTypes = new Set(rules.map((r) => r.type));
const absentRules = requiredRuleTypes.filter((t) => !presentTypes.has(t));
if (absentRules.length > 0) {
  fail(
    `the required contexts match, but these rules are no longer active on ` +
      `\`${BRANCH}\`: [${absentRules.join(", ")}].\n\n` +
      "Without `deletion` the branch can be deleted; without " +
      "`non_fast_forward` it can be force-pushed, which rewrites merged " +
      "history and discards the CI results this check just validated.\n\n" +
      `Rules currently active: [${[...presentTypes].join(", ")}]`,
  );
}

// bypass_actors is the ruleset analogue of `enforce_admins: false`, and it is
// NOT returned by /rules/branches/{branch} — that endpoint lists the rules that
// apply, not who may ignore them. So the check followed the ruleset_id here: a
// ruleset requiring all three contexts with a bypass actor attached is a gate
// that the listed actor merges straight past, and without this the script would
// print its ✓ while `main` was effectively open to them.
//
// Fetched per distinct ruleset_id (rules can come from more than one ruleset,
// including org-level ones). A failure to read a ruleset is reported rather
// than ignored — an unreadable ruleset is an unverified one, not a clean one.
const rulesetIds = [
  ...new Set(rules.map((r) => r.ruleset_id).filter((id) => id != null)),
];
const bypassFindings = [];
for (const id of rulesetIds) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/rulesets/${id}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });
  if (!res.ok) {
    bypassFindings.push(
      `  ruleset ${id}: NOT VERIFIED — HTTP ${res.status} reading ` +
        `/rulesets/${id}, so its bypass actors are unknown`,
    );
    continue;
  }
  const ruleset = await res.json();
  const actors = ruleset.bypass_actors ?? [];
  if (actors.length > 0) {
    bypassFindings.push(
      `  ruleset ${id} ("${ruleset.name}") grants ${actors.length} bypass ` +
        `actor(s): ${actors
          .map((a) => `${a.actor_type}#${a.actor_id} (${a.bypass_mode})`)
          .join(", ")}`,
    );
  }
}

if (bypassFindings.length > 0) {
  fail(
    "the required contexts match, but the gate is bypassable (or could not " +
      `be confirmed otherwise):\n\n${bypassFindings.join("\n")}\n\n` +
      "A bypass actor merges past every required check above, which makes " +
      "this check's ✓ misleading rather than wrong. Remove the actors, or " +
      "add them to an explicit allowlist in this script with a stated reason.",
  );
}

console.log(
  `✓ live ruleset on ${REPO}@${BRANCH} requires exactly the contexts ci.yml ` +
    `produces: [${[...live].sort().join(", ")}] (strict base policy on, ` +
    `${requiredRuleTypes.join(" + ")} active, no bypass actors on ` +
    `${rulesetIds.length} ruleset(s))`,
);

