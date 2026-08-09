/**
 * Arc C / C2 — the final-output self-review triage table (offline, pure).
 *
 * After a node reaches its terminal generated state, C1 runs the analyser over the node's OWN generated
 * artifacts and feeds the findings through here. Each finding is routed to one of three actions:
 *
 *   fix       — mechanically repairable by the generator; becomes repair-context on a cycle-capped
 *               `generate` retry. Only for findings where a rewrite is the whole answer.
 *   document  — real, but the answer is a human judgement the generator cannot make by rewriting code
 *               (is this bypass intended? is this input attacker-controlled? is this data non-sensitive?).
 *               Recorded against the node; never auto-"fixed", because a fabricated justification is worse
 *               than an open question.
 *   recommend — everything else, including every rule this table has never seen. Surfaced to the human at
 *               the gate. THE load-bearing default: the analyser emits 137 distinct rule_ids across the two
 *               fixture baselines and this table seeds 7, so most findings land here by design.
 *
 * GAN-safe: this file ROUTES, it never renders a verdict. The analyser grades, the generator regenerates.
 *
 * Placement — `node/`, alongside `rule-gate.js`, which is this file's true sibling: pure, no I/O, consumes
 * an `analyzePackage` findings doc, decides by rule_id. BUILD_PLAN says `sched/final-review.js`; `sched/`
 * holds the reducer and driver, and nothing here schedules.
 *
 * A gate may enumerate rule_ids; a CLASSIFIER may not. `node/disposition-hints.js:2-6` deliberately refuses
 * hand-picked id lists because a disposition must generalise to legacy archetypes it has never seen. This is
 * the other case: a fixed, auditable routing decision per known rule, with an explicit default for the
 * unknown — the same shape `rule-gate.js` already ships. The distinction is why both can be correct.
 *
 * BUILD_PLAN records its seed ids in a BARE form the analyser never emits (`obsolete-arithmetic`); the
 * analyser emits them `talos-`-prefixed, several with an infix. Resolved 2026-08-07 against
 * `analyser/rules/data/*.json` + `statement-pack.js` + `clone-pack.js`; `final-review.test.js` re-derives
 * the emittable set from those sources on every run, so a rename there fails this table rather than
 * silently making an entry unreachable.
 *
 * No `{rule_id, artifact_context}` compound key. BUILD_PLAN specifies one, but every seeded rule is
 * context-INVARIANT — the analyser already scopes each by `object_types`/`applies_to`, so the context would
 * never change the action. Shipping the second key now would add a branch no input can reach: the
 * "inert mechanism" defect this arc hit three times. `artifact_context` IS computed and returned (C1 reports
 * it, and a future rule may genuinely need it); add the key when a rule needs it, with a fixture-verified case.
 */

export const ACTIONS = Object.freeze(["fix", "document", "recommend"]);

/** The generated-artifact kinds, aligned to `sched/assemble.js` RAP_SURFACE obj_types. */
export const ARTIFACT_CONTEXTS = Object.freeze([
  "cds", "dcls", "ddlx", "bdef", "srvd", "srvb", "dbtab",
  "class", "test_class", "intf", "prog", "fugr", "unknown",
]);

/**
 * Filename suffix → artifact kind, most specific first. Suffixes verified 2026-08-07 against the real
 * generated corpus (`demos/zapcommander-rearchitected-2026-07-29/src`), not assumed from the RAP object
 * vocabulary: abapGit writes `.ddls.asddls`, `.dcls.asdcls`, `.bdef.asbdef`, `.tabl.asdbtab`.
 *
 * No current pair overlaps — `.clas.abap` does not match `…​.clas.testclasses.abap` (probed) — so the
 * ordering is a defensive convention, not an active requirement. It becomes load-bearing the moment anyone
 * adds a broader suffix such as a bare `.abap`; the test_class/class case in `final-review.test.js` pins
 * that distinction so such an addition fails rather than silently relabelling every generated test artifact
 * as production code.
 */
const SUFFIX_CONTEXTS = Object.freeze([
  [".testclasses.abap", "test_class"],
  [".asddls", "cds"],
  [".asdcls", "dcls"],
  [".asddlx", "ddlx"],
  [".asbdef", "bdef"],
  [".asdbtab", "dbtab"],
  [".srvd", "srvd"],
  [".srvb", "srvb"],
  [".clas.abap", "class"],
  [".intf.abap", "intf"],
  [".prog.abap", "prog"],
  [".fugr.abap", "fugr"],
]);

/**
 * Rules the analyser once had and DELETED. Declared rather than merely omitted, so the exclusion survives
 * someone re-reading BUILD_PLAN's seed list and "restoring" the entry.
 *
 * `talos-rap-draft-lock-no-timeout` demanded `@Locking.timeoutSeconds`, which does not exist in released
 * ABAP Cloud — a rule that can never be satisfied and that "induces a generator to fabricate one". Removed;
 * `analyser/test/metadata-pack.test.js:150-162` asserts it never fires. BUILD_PLAN seeds it anyway.
 */
export const RETIRED_RULE_IDS = Object.freeze(["talos-rap-draft-lock-no-timeout"]);

const EML_LOCAL_MODE_REASON =
  "EML IN LOCAL MODE bypasses the authorization check. Outside test code this is a security bypass — " +
  "a human must confirm the bypass is intended; regenerating cannot answer that.";

/**
 * rule_id → {action, reason}. `reason` is carried into the verdict, so it is written for the human who
 * reads the gate, not for this file.
 */
export const TRIAGE_TABLE = Object.freeze({
  // --- fix: a rewrite is the whole answer -------------------------------------------------------------
  "talos-cc-001-obsolete-arithmetic": {
    action: "fix",
    reason: "Obsolete MOVE/COMPUTE/ADD/SUBTRACT/MULTIPLY/DIVIDE — replace with the modern operator form.",
  },
  "talos-duplicate-block": {
    action: "fix",
    reason: "Duplicated block — extract the clone into a single called unit.",
  },
  "talos-cloud-005-class-final-abstract": {
    action: "fix",
    reason: "ABAP Cloud requires a class definition to be FINAL or ABSTRACT — add the missing addition.",
  },
  "talos-rap-draft-action-no-optimized": {
    action: "fix",
    reason: "Draft action declared without `optimized` — add the addition to the behaviour definition.",
  },

  // --- document: the answer is a judgement, not a rewrite ----------------------------------------------
  // R6: the analyser carries TWO rules for this one construct, and the real generated corpus fires both
  // (9 hits each, demos/zapcommander-rearchitected-2026-07-29). Seeding one and not the other made the
  // same auth bypass land in `document` or in the `recommend` default depending only on which pack
  // reported it. They share a reason because they describe the same fact.
  "talos-perf-73-eml-local-mode": {
    action: "document",
    reason: EML_LOCAL_MODE_REASON,
  },
  "talos-eml-local-mode-outside-test": {
    action: "document",
    reason: EML_LOCAL_MODE_REASON,
  },
  "talos-dynamic-where-subquery": {
    action: "document",
    reason:
      "Dynamic WHERE built from a variable. Whether this is an injection depends on whether the input is " +
      "attacker-controlled — evidence a human supplies, not a rewrite.",
  },
  "talos-cds-auth-not-required": {
    action: "document",
    reason:
      "@AccessControl.authorizationCheck: #NOT_REQUIRED. Legitimate only if the view exposes no sensitive " +
      "data, or auth is enforced at the interface layer below — confirm before release.",
  },
});

const DEFAULT_ACTION = "recommend";
const DEFAULT_REASON =
  "No triage rule for this finding — surfaced for a human decision rather than actioned automatically.";

/**
 * The generated-artifact kind a finding sits in, derived from the analyser's own `file`. Total: anything
 * unrecognised is `unknown`, never a throw — a finding must never be lost to a filename the corpus has not
 * shown us yet.
 *
 * @param {unknown} file the finding's `file` field
 * @returns {string} a member of ARTIFACT_CONTEXTS
 */
export function artifactContext(file) {
  if (typeof file !== "string" || file === "") return "unknown";
  const name = file.toLowerCase();
  for (const [suffix, context] of SUFFIX_CONTEXTS) if (name.endsWith(suffix)) return context;
  return "unknown";
}

/**
 * Route one analyser finding to an action.
 *
 * @param {{rule_id?: string, file?: string}} [finding] an `analyzePackage` finding (only rule_id + file read)
 * @returns {{action: string, rule_id: string|null, artifact_context: string, reason: string}}
 */
export function triage(finding) {
  const rule_id = finding?.rule_id ? String(finding.rule_id) : null;
  const artifact_context = artifactContext(finding?.file);
  const entry = rule_id ? TRIAGE_TABLE[rule_id] : undefined;
  if (!entry) return { action: DEFAULT_ACTION, rule_id, artifact_context, reason: DEFAULT_REASON };
  return { action: entry.action, rule_id, artifact_context, reason: entry.reason };
}

/**
 * Route a finding list into the three action buckets. Every input finding lands in exactly one bucket — a
 * dropped finding is an unreported defect, so the partition conserves count by construction.
 *
 * @param {Array<{rule_id?: string, file?: string}>} [findings]
 * @returns {{fix: object[], document: object[], recommend: object[]}}
 */
export function triageAll(findings) {
  const out = { fix: [], document: [], recommend: [] };
  for (const finding of findings ?? []) {
    const verdict = triage(finding);
    out[verdict.action].push({ ...verdict, finding });
  }
  return out;
}

/** Marks a verdict reason contributed by the final review, so it can never collide with a gate reason. */
export const FIX_REASON_PREFIX = "final-review-fix:";

/**
 * The analyser's own degraded-mode diagnostic (`analyser/src/abaplint-rules.js:45`): abaplint crashed on
 * this object and analysed NONE of it. A clean review of an object that was never analysed is not evidence
 * of cleanliness, so it blocks rather than passing quietly — the same fail-closed rule as an absent
 * `--findings` doc (F5). It is not a `fix`: no rewrite addresses an engine crash, and routing it through the
 * retry loop would burn the cycle budget before quarantining anyway.
 *
 * Fires on none of the 4,059 findings across the three real corpora (probed 2026-08-07) — this is a guard
 * for a failure the analyser explicitly builds a fallback path for, not a routine outcome.
 */
export const ENGINE_ERROR_RULE_ID = "abaplint_engine_error";
export const UNANALYSABLE_REASON_PREFIX = "final-review-unanalysable:";

/**
 * C1 — fold the triage of a node's OWN generated artifacts into its offline verdict.
 *
 * ONLY `fix` items become verdict reasons, and that asymmetry is the whole point. `driveOfflineVerdict`
 * routes a node whose reasons are ALL attestable straight to the human with its retry budget untouched
 * (`sched/drive.js:187-188`). A `document` or `recommend` reason leaking into that list would flip
 * `onlyAttestable` false, push an owed attestation into the cycle-capped regenerate loop, and land a false
 * ceiling BLOCK on every classic→managed-RAP node — because relocating authorization to DCL always sets
 * auth_delta on the first pass. So advisory findings ride on `final_review` instead, where the gate and the
 * run log surface them without touching the retry budget.
 *
 * A `fix` finding DOES force the verdict non-provisional: a defect the analyser can see in the artifact we
 * just generated is exactly what regeneration exists for, and it outranks an owed attestation (attesting a
 * defective artifact is meaningless — `drive.js:169-170`).
 *
 * Pure: the caller runs `analyzePackage` and owns the I/O; this only folds the result.
 *
 * @param {{provisional?: boolean, reasons?: string[]}} result from `renderOfflineNodeVerdict`
 * @param {{fix?: object[], document?: object[], recommend?: object[]}} [triaged] from `triageAll`
 * @returns {{provisional: boolean, reasons: string[], final_review: object}}
 */
export function applyFinalReview(result, triaged) {
  const fix = triaged?.fix ?? [];
  const documented = triaged?.document ?? [];
  const recommended = triaged?.recommend ?? [];
  const final_review = {
    fix,
    document: documented,
    recommend: recommended,
    counts: { fix: fix.length, document: documented.length, recommend: recommended.length },
  };
  const reasons = [...(result?.reasons ?? [])];
  const contributed = [...fixReasons(fix), ...unanalysableReasons(fix, documented, recommended)];
  // The block turns on whether the review CONTRIBUTED anything, not on whether the reason is new. Deciding
  // on novelty would let a replayed verdict — one already carrying the reason — fall back to provisional.
  if (contributed.length === 0) return { provisional: result?.provisional === true, reasons, final_review };
  const added = contributed.filter((r) => !reasons.includes(r));
  return { provisional: false, reasons: [...reasons, ...added], final_review };
}

/**
 * One reason per object abaplint could not analyse. Drawn from EVERY bucket, not just `recommend`, so that
 * adding a triage entry for the diagnostic later cannot quietly disarm the guard.
 */
function unanalysableReasons(...buckets) {
  const objects = new Set();
  for (const bucket of buckets) {
    for (const item of bucket) {
      if (item?.rule_id !== ENGINE_ERROR_RULE_ID) continue;
      objects.add(item.finding?.object || item.finding?.file || "(unnamed object)");
    }
  }
  return [...objects].sort().map((o) => `${UNANALYSABLE_REASON_PREFIX}${o}`);
}

/** file then line, with a total order over absent values so the "first hit" is stable across runs. */
function byLocation(a, b) {
  const fa = String(a?.file ?? "");
  const fb = String(b?.file ?? "");
  if (fa !== fb) return fa < fb ? -1 : 1;
  return (a?.line ?? 0) - (b?.line ?? 0);
}

/**
 * One reason per DISTINCT rule — not per hit, or a single duplicated block would flood the retry packet
 * and crowd out the other defects. Carries the hit count and the first location as repair context.
 */
function fixReasons(fix) {
  const byRule = new Map();
  for (const item of fix) {
    const rule_id = item?.rule_id ?? "(unknown)";
    if (!byRule.has(rule_id)) byRule.set(rule_id, []);
    byRule.get(rule_id).push(item?.finding ?? {});
  }
  return [...byRule.keys()].sort().map((rule_id) => {
    const hits = [...byRule.get(rule_id)].sort(byLocation);
    const first = `${hits[0].file ?? "?"}:${hits[0].line ?? "?"}`;
    return `${FIX_REASON_PREFIX}${rule_id} (${hits.length} hit${hits.length === 1 ? "" : "s"}, first ${first})`;
  });
}
