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
//   - `bypass_actors` IS NOT READABLE by the credential this normally runs
//     under, and this check no longer pretends otherwise. An earlier version of
//     this file claimed `GET /repos/{o}/{r}/rulesets/{id}` returns
//     `bypass_actors` under the same `metadata: read`. That claim was wrong.
//     GitHub's REST reference for "Get a repository ruleset" states the
//     property "is only returned if the user making the API request has write
//     access to the ruleset" — i.e. `Administration: write`, which
//     `GITHUB_TOKEN` cannot be granted. Verified against this repository's own
//     ruleset 24916437: an admin PAT gets a body whose keys include
//     `bypass_actors`; the identical UNAUTHENTICATED request returns HTTP 200
//     with that key ABSENT from the body — withheld, not empty. The old code
//     read `ruleset.bypass_actors ?? []`, which maps "withheld because you may
//     not see it" onto "there are none", and then printed "no bypass actors".
//     That is fail-open on a gate-bypass check, and strictly worse than the
//     honest blind-spot disclosure it replaced: the reader was told the
//     all-clear instead of being told nothing was checked. It now reports
//     NOT VERIFIED and exits non-zero unless the operator accepts the blind
//     spot explicitly (`ALLOW_UNVERIFIED_BYPASS_ACTORS=1`). An unreadable
//     field is unverified, not clean — the same principle this file already
//     applied to an unreadable ruleset.
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
const API_ROOT = "https://api.github.com";

// When set, a WITHHELD `bypass_actors` is reported as a loud warning instead of
// failing the run. This exists so the daily cron stays useful under
// `GITHUB_TOKEN`, which structurally cannot read that field (see the header),
// while every drift assertion it CAN make keeps running. It never silently
// claims the gate is unbypassable: with this set the ✓ line reads "bypass
// actors NOT VERIFIED". The better fix is to run this step with a PAT or App
// token holding `Administration: write` and leave this unset, which makes the
// check real rather than disclosed.
const ALLOW_UNVERIFIED_BYPASS_ACTORS =
  process.env.ALLOW_UNVERIFIED_BYPASS_ACTORS === "1";

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

/**
 * Message text for a caught value.
 *
 * `catch (error)` binds `unknown` under `strict`, and the old `error?.message
 * ?? error` read a property off it unchecked — `checkJs` flagged three of
 * those (TS18046 / TS2339 on `{}`). Not pedantry: a thrown non-Error (a string,
 * or `undefined` from an aborted fetch) made that expression produce
 * `"undefined"` inside the body of a GitHub issue this script files
 * unattended.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Narrows an arbitrary JSON value to a plain object with readable properties.
 *
 * The API responses this script walks (`rules`, `parameters`, a ruleset) are
 * `unknown` by construction — they come off `res.json()`. The previous code
 * read `.parameters?.required_status_checks`, `.strict_required_status_checks_policy`,
 * `.name` and `.current_user_can_bypass` straight off values typed `object`,
 * which `checkJs` reports as TS2339 one by one. Narrowing once here keeps the
 * runtime behaviour and makes the reads honest.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads a string property off an unknown API object, or `undefined`.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {string | undefined}
 */
function readString(value, key) {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * GETs a GitHub API path, retrying transient failures so a single blip does not
 * produce a misleading report.
 *
 * This is deliberately the ONLY fetch in this file. The previous version had a
 * resilient 3-attempt loop for the rules endpoint and, 150 lines later, a bare
 * `await fetch(...)` with no retry and no `try/catch` for the per-ruleset
 * endpoint. On a daily cron that asymmetry meant a transient 502 on the second
 * endpoint produced a red run AND a filed GitHub issue, while the identical
 * blip on the first was retried away — and a DNS failure there REJECTED
 * unhandled, so a V8 stack trace became the body of that issue. One policy,
 * both call sites, one place to change it.
 *
 * Retries 5xx, 429 and network-level rejections. Does NOT retry other 4xx: a
 * 401/403/404 is an answer, not a blip, so retrying only delays the report.
 *
 * Returns a discriminated result instead of throwing, so a caller can tell
 * "could not read" apart from "read it, here is what it said" without a
 * `catch` that flattens both into one.
 *
 * @param {string} path API path beginning with `/`
 * @param {{attempts?: number}} [options]
 * @returns {Promise<{ok: true, body: unknown, link: string} | {ok: false, error: string}>}
 */
async function fetchJson(path, { attempts = 3 } = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/vnd.github+json" };
  // Authenticate when a token is present (private repos, and a far higher rate
  // limit), but do not require one: on a public repo these endpoints are
  // readable anonymously, so the check still works in a fork or a local run.
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(`${API_ROOT}${path}`, { headers });
    } catch (error) {
      // fetch REJECTS on a DNS failure or socket reset rather than resolving.
      // Caught so it becomes a curated message instead of an unhandled
      // rejection whose stack trace gets pasted into a GitHub issue.
      lastError = `network error contacting ${path}: ${errorMessage(error)}`;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        continue;
      }
      break;
    }

    if (res.ok) {
      try {
        return {
          ok: true,
          body: await res.json(),
          link: res.headers.get("link") ?? "",
        };
      } catch (error) {
        lastError = `${path} returned unparseable JSON: ${errorMessage(error)}`;
        break;
      }
    }

    lastError = `${path} responded HTTP ${res.status} ${res.statusText}`;
    const transient = res.status >= 500 || res.status === 429;
    if (!transient || attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  return { ok: false, error: `${lastError} (after ${attempts} attempt(s))` };
}

/**
 * Fetches every rule applying to `BRANCH`, following `Link` pagination.
 *
 * The previous version appended `?per_page=100` and commented that this closed
 * a truncation hole. It did not — it raised the cap from GitHub's documented
 * default of 30 to 100 and still never requested page 2, so at 101+ applicable
 * rules a rule would be silently dropped and an absent `deletion` rule would
 * read as "not present" rather than "not shown": the exact failure mode the
 * comment claimed to have eliminated, mitigated by a factor of 3.3. This
 * follows `Link: rel="next"` to exhaustion, so the set is complete at any size.
 * (This repository has 3 rules, so the practical effect today is nil. The point
 * is that the comment is now true.)
 *
 * @returns {Promise<Array<Record<string, unknown>>>}
 * @throws {Error} if the rules cannot be read
 */
async function fetchLiveRules() {
  /** @type {Array<Record<string, unknown>>} */
  const rules = [];
  const seen = new Set();
  /** @type {string | null} */
  let path = `/repos/${REPO}/rules/branches/${BRANCH}?per_page=100`;

  while (path) {
    // Defensive: a self-referential or cyclic Link header must not spin.
    if (seen.has(path)) break;
    seen.add(path);

    const result = await fetchJson(path);
    if (!result.ok) {
      throw new Error(`could not read live branch rules: ${result.error}`);
    }
    if (!Array.isArray(result.body)) {
      throw new Error(
        `expected a JSON array of rules, got ${typeof result.body}: ` +
          JSON.stringify(result.body).slice(0, 200),
      );
    }
    // Each rule must be a readable object; a non-object entry is a response
    // shape this guard does not model, so it is rejected rather than skipped.
    for (const rule of result.body) {
      if (!isRecord(rule)) {
        throw new Error(
          `the rules list contains a non-object entry (${typeof rule}); the ` +
            "API response shape changed and this guard needs updating",
        );
      }
      rules.push(rule);
    }

    const next = result.link
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.endsWith('rel="next"'));
    path = next
      ? next.slice(next.indexOf("<") + 1, next.indexOf(">")).replace(API_ROOT, "")
      : null;
  }

  return rules;
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

const live = (() => {
  const params = statusCheckRule.parameters;
  const checks = isRecord(params) ? params.required_status_checks : undefined;
  if (checks === undefined) return [];
  if (!Array.isArray(checks)) {
    fail(
      "the `required_status_checks` rule's `required_status_checks` " +
        `parameter is ${typeof checks}, not an array; the API response shape ` +
        "changed and this guard cannot read the required contexts. That is a " +
        "failure rather than an empty list, because an empty list would read " +
        "as \"protection requires nothing\" and produce a confidently wrong " +
        "report.",
    );
  }
  return /** @type {unknown[]} */ (checks).map((c) => readString(c, "context") ?? String(c));
})();

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

const strictPolicy = isRecord(statusCheckRule.parameters)
  ? statusCheckRule.parameters.strict_required_status_checks_policy
  : undefined;
if (strictPolicy !== true) {
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

// ---------------------------------------------------------------------------
// bypass_actors
// ---------------------------------------------------------------------------
//
// bypass_actors is the ruleset analogue of `enforce_admins: false`: a ruleset
// requiring every context with a bypass actor attached is a gate that actor
// merges straight past, which makes this script's ✓ misleading rather than
// wrong. It is NOT returned by /rules/branches/{branch} — that endpoint lists
// the rules that apply, not who may ignore them — so the check follows each
// distinct ruleset_id (rules can come from more than one ruleset, including
// org-level ones).
//
// Three outcomes, all explicit, none of them silent:
//   readable + empty       → verified unbypassable
//   readable + non-empty   → FAIL, listing the actors
//   withheld / unreadable  → NOT VERIFIED: fails, or warns loudly when the
//                            operator has set ALLOW_UNVERIFIED_BYPASS_ACTORS=1
//
// The third case is the one that was fail-open. See the header for the API
// evidence; the short version is that `?? []` cannot tell "you may not see
// this" from "there are none", and only one of those is good news.
const rulesetIds = [
  ...new Set(rules.map((r) => r.ruleset_id).filter((id) => id != null)),
];

// An empty id list used to make the loop below iterate zero times, leaving
// `bypassFindings` empty so the ✓ printed "no bypass actors on 0 ruleset(s)" —
// a vacuous pass in a file whose central design claim is refusing to pass
// vacuously. Rules DO apply (asserted above), so all of them lacking a
// `ruleset_id` means the response shape changed and nothing was inspected.
if (rulesetIds.length === 0) {
  fail(
    `rules apply to \`${BRANCH}\` but NONE of them carries a \`ruleset_id\`, ` +
      "so there is no ruleset to inspect for bypass actors and that half of " +
      "this check verified nothing. It previously printed a ✓ reading " +
      '"no bypass actors on 0 ruleset(s)", which asserted a clean result from ' +
      "zero observations. The API response shape has changed; this guard " +
      `needs updating.\n\nRules returned: [${rules.map((r) => r.type).join(", ")}]`,
  );
}

const bypassFindings = [];
const unverified = [];
for (const id of rulesetIds) {
  const result = await fetchJson(`/repos/${REPO}/rulesets/${id}`);
  if (!result.ok) {
    unverified.push(
      `ruleset ${id}: NOT VERIFIED — ${result.error}, so its bypass actors ` +
        "are unknown",
    );
    continue;
  }
  const ruleset = result.body;
  if (!isRecord(ruleset)) {
    unverified.push(
      `ruleset ${id}: NOT VERIFIED — expected a ruleset object, got ` +
        `${typeof ruleset}`,
    );
    continue;
  }
  const rulesetName = readString(ruleset, "name");

  // The load-bearing distinction, and the whole of F2: `in` separates "the
  // field is absent because this caller may not see it" from "the field is
  // present and empty". `?? []` collapsed both into "clean".
  if (!("bypass_actors" in ruleset)) {
    unverified.push(
      `ruleset ${id}${rulesetName ? ` ("${rulesetName}")` : ""}: NOT ` +
        "VERIFIED — the API WITHHELD `bypass_actors`. GitHub returns that " +
        "property only to callers with write access to the ruleset " +
        "(`Administration: write`), which `GITHUB_TOKEN` cannot be granted, " +
        "so this check cannot confirm the gate is unbypassable. Either run " +
        "this step with a PAT/App token that has that access, or accept the " +
        "blind spot explicitly with ALLOW_UNVERIFIED_BYPASS_ACTORS=1." +
        (readString(ruleset, "current_user_can_bypass")
          ? ` (\`current_user_can_bypass\` for THIS token is ` +
            `"${readString(ruleset, "current_user_can_bypass")}" — that is a statement about ` +
            "this caller only, not about other actors, so it is a partial " +
            "substitute and not a drop-in.)"
          : ""),
    );
    continue;
  }

  const actors = ruleset.bypass_actors;
  if (!Array.isArray(actors)) {
    unverified.push(
      `ruleset ${id}: NOT VERIFIED — \`bypass_actors\` was present but is ` +
        `${typeof actors}, not an array; the response shape changed`,
    );
    continue;
  }
  if (actors.length > 0) {
    bypassFindings.push(
      `ruleset ${id} ("${rulesetName ?? "unnamed"}") grants ${actors.length} bypass ` +
        `actor(s): ${/** @type {unknown[]} */ (actors)
          .map(
            (a) =>
              `${readString(a, "actor_type") ?? "?"}#${
                isRecord(a) ? String(a.actor_id ?? "?") : "?"
              } (${readString(a, "bypass_mode") ?? "?"})`,
          )
          .join(", ")}`,
    );
  }
}

if (bypassFindings.length > 0) {
  fail(
    "the required contexts match, but the gate is BYPASSABLE:\n\n" +
      `${bypassFindings.map((f) => `  ${f}`).join("\n")}\n\n` +
      "A bypass actor merges past every required check above, which makes " +
      "this check's ✓ misleading rather than wrong. Remove the actors, or " +
      "add them to an explicit allowlist in this script with a stated reason.",
  );
}

if (unverified.length > 0 && !ALLOW_UNVERIFIED_BYPASS_ACTORS) {
  fail(
    "the required contexts match, but whether the gate is BYPASSABLE could " +
      `not be determined:\n\n${unverified.map((f) => `  ${f}`).join("\n")}\n\n` +
      "This is a failure rather than something passed over because an " +
      "unreadable field is unverified, not clean — the previous version of " +
      'this check printed "no bypass actors" here, which was a claim it had ' +
      "not established and structurally could not. Set " +
      "ALLOW_UNVERIFIED_BYPASS_ACTORS=1 to downgrade it to a warning if the " +
      "credential genuinely cannot be upgraded.",
  );
}

for (const line of unverified) {
  console.warn(`⚠ ${line}`);
}

const bypassVerdict =
  unverified.length > 0
    ? `bypass actors NOT VERIFIED on ${unverified.length} of ` +
      `${rulesetIds.length} ruleset(s) — see the warning(s) above`
    : `no bypass actors on ${rulesetIds.length} ruleset(s)`;

console.log(
  `✓ live ruleset on ${REPO}@${BRANCH} requires exactly the contexts ci.yml ` +
    `produces: [${[...live].sort().join(", ")}] (strict base policy on, ` +
    `${requiredRuleTypes.join(" + ")} active, ${bypassVerdict})`,
);

