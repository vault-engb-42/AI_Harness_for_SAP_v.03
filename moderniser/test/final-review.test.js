import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  triage,
  triageAll,
  artifactContext,
  applyFinalReview,
  ACTIONS,
  ARTIFACT_CONTEXTS,
  TRIAGE_TABLE,
  RETIRED_RULE_IDS,
  FIX_REASON_PREFIX,
  ENGINE_ERROR_RULE_ID,
  UNANALYSABLE_REASON_PREFIX,
} from "../src/node/final-review.js";

// Arc C / C2 — the final-output self-review triage table.
//
// The load-bearing property is NOT that the seeded rules classify as seeded — it is that the table can
// never key on a rule the analyser cannot emit. Three "inert mechanism" defects shipped in Arc B (built,
// tested, reachable from no real input); a triage table keyed on ids that never arrive is the same defect
// wearing a different hat. `the table keys only on rule_ids the analyser can actually emit` below is that
// guard, and it reads the analyser's real rule sources rather than trusting this file's own list.

// ---------------------------------------------------------------------------------------------------
// artifact_context — derived from the analyser's `file`, never invented.
// Suffixes verified 2026-08-07 against the real generated corpora:
//   demos/zapcommander-rearchitected-2026-07-29/src → .asddls .asdcls .asddlx .asbdef .asdbtab
//                                                     .srvd .srvb .clas.abap .clas.testclasses.abap
// ---------------------------------------------------------------------------------------------------

test("artifactContext derives the RAP_SURFACE token from every real generated suffix", () => {
  const cases = [
    ["zi_apcnode.ddls.asddls", "cds"],
    ["zi_apcnode.dcls.asdcls", "dcls"],
    ["zc_apcnode.ddlx.asddlx", "ddlx"],
    ["zc_apcnode.bdef.asbdef", "bdef"],
    ["zui_apcnode.srvd", "srvd"],
    ["zui_apcnode.srvb", "srvb"],
    ["zapc_node.tabl.asdbtab", "dbtab"],
    ["zbp_apcnode.clas.abap", "class"],
    ["zif_apcnode.intf.abap", "intf"],
    ["zfico_btc_csv_gl.prog.abap", "prog"],
  ];
  for (const [file, expected] of cases) assert.equal(artifactContext(file), expected, file);
});

test("a test-class file resolves to test_class, never to class", () => {
  // The two suffixes do not currently overlap (`.clas.abap` does not match `…clas.testclasses.abap`), so
  // this is not pinning an ordering bug — it pins the DISTINCTION, so that adding a broader suffix later
  // (a bare `.abap`, say) fails here instead of silently relabelling every generated test artifact as
  // production code and sending test-only findings into the production fix path.
  assert.equal(artifactContext("zbp_apcnode.clas.testclasses.abap"), "test_class");
  assert.equal(artifactContext("zbp_apcnode.clas.abap"), "class");
});

test("artifactContext is total — an absent or unrecognised file yields `unknown`, never a throw", () => {
  for (const bad of [undefined, null, "", "no-suffix", "README.md", 42, {}]) {
    assert.equal(artifactContext(bad), "unknown", String(bad));
  }
});

test("every context artifactContext can return is a declared member of ARTIFACT_CONTEXTS", () => {
  const produced = [
    "zi.ddls.asddls", "zi.dcls.asdcls", "zc.ddlx.asddlx", "zc.bdef.asbdef", "z.srvd", "z.srvb",
    "z.tabl.asdbtab", "z.clas.abap", "z.clas.testclasses.abap", "z.intf.abap", "z.prog.abap",
    "z.fugr.abap", "nonsense",
  ].map(artifactContext);
  for (const c of produced) assert.ok(ARTIFACT_CONTEXTS.includes(c), `${c} is undeclared`);
});

// ---------------------------------------------------------------------------------------------------
// The seeded actions. Ids are the REAL emitted forms (BUILD_PLAN records them bare; the analyser emits
// them `talos-`-prefixed, several with an infix) — resolved 2026-08-07 against analyser/rules/.
// ---------------------------------------------------------------------------------------------------

test("mechanically-repairable findings triage to `fix`", () => {
  for (const rule_id of [
    "talos-cc-001-obsolete-arithmetic",      // MOVE/COMPUTE/ADD → modern operators
    "talos-duplicate-block",                 // extract the clone
    "talos-cloud-005-class-final-abstract",  // add FINAL / ABSTRACT
    "talos-rap-draft-action-no-optimized",   // add the `optimized` addition
  ]) {
    assert.equal(triage({ rule_id, file: "z.clas.abap" }).action, "fix", rule_id);
  }
});

test("findings needing a human judgement triage to `document`, never `fix`", () => {
  // Each of these asks a question the generator cannot answer by rewriting code: is this bypass intended,
  // is this input attacker-controlled, is this data non-sensitive. Auto-"fixing" them would either destroy
  // intent or fabricate a justification.
  const cases = [
    ["talos-perf-73-eml-local-mode", "zbp_x.clas.abap"],
    // R6: the analyser has TWO rules for the same EML-IN-LOCAL-MODE auth bypass and the real generated
    // corpus fires both 9x each (demos/zapcommander-rearchitected-2026-07-29). Seeding one and not the
    // other triaged identical facts two different ways — `document` for one, the `recommend` default for
    // the other — purely by which rule pack noticed first.
    ["talos-eml-local-mode-outside-test", "zbp_x.clas.abap"],
    ["talos-dynamic-where-subquery", "zi_x.dcls.asdcls"],
    ["talos-cds-auth-not-required", "zi_x.ddls.asddls"],
  ];
  for (const [rule_id, file] of cases) {
    assert.equal(triage({ rule_id, file }).action, "document", rule_id);
  }
});

test("an unknown rule defaults to `recommend` — surfaced to the human, never silently dropped", () => {
  // The load-bearing default. The analyser emits 137 distinct rule_ids across the two fixture baselines
  // and the table seeds 7; the overwhelming majority of real findings land here by design.
  for (const rule_id of ["check_subrc", "7bit_ascii", "talos-select-in-loop", "brand-new-rule"]) {
    assert.equal(triage({ rule_id, file: "z.clas.abap" }).action, "recommend", rule_id);
  }
});

test("a finding with no rule_id is recommended, not dropped and not a throw", () => {
  for (const f of [{}, { file: "z.clas.abap" }, { rule_id: null }, { rule_id: "" }]) {
    assert.equal(triage(f).action, "recommend");
  }
  assert.equal(triage(undefined).action, "recommend");
});

test("a triage result always carries the full four-field contract", () => {
  const r = triage({ rule_id: "talos-duplicate-block", file: "zbp_x.clas.abap" });
  assert.deepEqual(Object.keys(r).sort(), ["action", "artifact_context", "reason", "rule_id"]);
  assert.equal(r.rule_id, "talos-duplicate-block");
  assert.equal(r.artifact_context, "class");
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, "a reason is always stated");
});

test("triage is deterministic — the same finding always yields an identical verdict", () => {
  const f = { rule_id: "talos-perf-73-eml-local-mode", file: "zbp_x.clas.abap", line: 42 };
  assert.deepEqual(triage(f), triage({ ...f }));
  assert.deepEqual(triage({ rule_id: "unknown-x" }), triage({ rule_id: "unknown-x" }));
});

// ---------------------------------------------------------------------------------------------------
// triageAll — the partition must conserve every finding. A dropped finding is an unreported defect.
// ---------------------------------------------------------------------------------------------------

test("triageAll partitions into exactly the three action buckets and conserves every finding", () => {
  const findings = [
    { rule_id: "talos-duplicate-block", file: "a.clas.abap" },
    { rule_id: "talos-cc-001-obsolete-arithmetic", file: "b.prog.abap" },
    { rule_id: "talos-cds-auth-not-required", file: "c.ddls.asddls" },
    { rule_id: "check_subrc", file: "d.clas.abap" },
    { rule_id: "7bit_ascii", file: "e.clas.abap" },
    {},
  ];
  const out = triageAll(findings);
  assert.deepEqual(Object.keys(out).sort(), ["document", "fix", "recommend"]);
  const total = out.fix.length + out.document.length + out.recommend.length;
  assert.equal(total, findings.length, "no finding may be dropped by the partition");
  assert.equal(out.fix.length, 2);
  assert.equal(out.document.length, 1);
  assert.equal(out.recommend.length, 3);
});

test("triageAll tolerates an absent or empty finding list", () => {
  for (const input of [undefined, null, []]) {
    assert.deepEqual(triageAll(input), { fix: [], document: [], recommend: [] });
  }
});

// ---------------------------------------------------------------------------------------------------
// Invariant nets (§3.8) — a guard resting on a structural premise must have that premise under test.
// ---------------------------------------------------------------------------------------------------

test("every action the table declares is a member of the closed ACTIONS set", () => {
  // Catches a typo'd action (`"fixed"`, `"documnet"`) at edit time rather than at the gate, where it would
  // silently fall through to the default and look like a correct `recommend`.
  assert.deepEqual([...ACTIONS].sort(), ["document", "fix", "recommend"]);
  for (const [rule_id, entry] of Object.entries(TRIAGE_TABLE)) {
    assert.ok(ACTIONS.includes(entry.action), `${rule_id} → ${entry.action} is not a declared action`);
    assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, `${rule_id} states no reason`);
  }
});

/** every rule_id the analyser could emit: the two data-driven rule files + the literals in its rule packs. */
function emittableRuleIds() {
  const dir = new URL("../../analyser/rules/", import.meta.url);
  const ids = new Set();
  for (const f of ["data/regex-rules.json", "data/metadata-rules.json"]) {
    const doc = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    for (const r of Array.isArray(doc) ? doc : (doc.rules ?? [])) if (r.id) ids.add(r.id);
  }
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/"(talos-[a-z0-9-]+)"/g)) ids.add(m[1]);
  }
  return ids;
}

test("the table keys only on rule_ids the analyser can actually emit", () => {
  // THE guard against an inert table. Reads the analyser's real rule sources — if a rule is renamed or
  // retired there, this goes red, which is the correct outcome: the entry would otherwise never match.
  const emittable = emittableRuleIds();
  assert.ok(emittable.size > 60, `sanity: only ${emittable.size} ids found — the scan itself is broken`);
  for (const rule_id of Object.keys(TRIAGE_TABLE)) {
    assert.ok(emittable.has(rule_id), `${rule_id} is not emittable by the analyser — the entry is inert`);
  }
});

test("a rule the analyser retired is excluded from the table and named as retired", () => {
  // BUILD_PLAN seeds `draft-lock-no-timeout`. The analyser DELETED that rule: it demanded
  // @Locking.timeoutSeconds, which does not exist in released ABAP Cloud, and "induces a generator to
  // fabricate one" — see analyser/test/metadata-pack.test.js:150-162, which asserts it never fires.
  // Seeding it would be an entry that can never match. Recorded here so the exclusion is deliberate and
  // survives someone re-reading BUILD_PLAN and "restoring" it.
  const retired = "talos-rap-draft-lock-no-timeout";
  assert.ok(RETIRED_RULE_IDS.includes(retired), "the exclusion must be declared, not merely omitted");
  assert.equal(TRIAGE_TABLE[retired], undefined, "a retired rule may not hold a table entry");
  assert.equal(triage({ rule_id: retired, file: "z.bdef.asbdef" }).action, "recommend");
});

test("no retired rule is emittable — the exclusion list itself stays honest", () => {
  // The mirror of the guard above: if the analyser ever re-introduces one of these, the exclusion is stale
  // and the rule deserves a real triage decision rather than silent absence.
  const emittable = emittableRuleIds();
  for (const rule_id of RETIRED_RULE_IDS) {
    assert.ok(!emittable.has(rule_id), `${rule_id} is emittable again — re-triage it instead of excluding it`);
  }
});

// ---------------------------------------------------------------------------------------------------
// C1 fold — the triage of a node's own generated artifacts, folded into the offline verdict.
//
// The load-bearing rule: ONLY `fix` items may become verdict reasons. `driveOfflineVerdict` routes a node
// whose reasons are ALL attestable to the human with its retry budget untouched (drive.js:187-188); a
// `document` or `recommend` reason leaking into that list would defeat the test, send an owed attestation
// through the regenerate loop, and land a false ceiling BLOCK on every classic→managed-RAP node. The
// "an owed attestation still routes to the human" test below is the one that catches that.
// ---------------------------------------------------------------------------------------------------

const clean = { fix: [], document: [], recommend: [] };
const withFix = (rule_id, file = "z.clas.abap", line = 7) =>
  triageAll([{ rule_id, file, line }]);

test("with nothing to fix, the verdict passes through untouched", () => {
  for (const provisional of [true, false]) {
    const out = applyFinalReview({ provisional, reasons: ["atc-p1-nonzero"] }, clean);
    assert.equal(out.provisional, provisional);
    assert.deepEqual(out.reasons, ["atc-p1-nonzero"]);
  }
});

test("a fixable defect forces the verdict non-provisional and names itself in the reasons", () => {
  const out = applyFinalReview({ provisional: true, reasons: [] }, withFix("talos-duplicate-block"));
  assert.equal(out.provisional, false, "a defect in the generated artifact cannot pass provisionally");
  assert.equal(out.reasons.length, 1);
  assert.ok(out.reasons[0].startsWith(`${FIX_REASON_PREFIX}talos-duplicate-block`), out.reasons[0]);
  assert.ok(out.reasons[0].includes("z.clas.abap:7"), "the reason carries repair context");
});

test("document and recommend findings NEVER become verdict reasons", () => {
  // If they did, `onlyAttestable` at drive.js:187 goes false and an owed attestation is routed into the
  // regenerate loop — burning the whole cycle budget on something no rewrite can resolve.
  const triaged = triageAll([
    { rule_id: "talos-perf-73-eml-local-mode", file: "zbp_x.clas.abap", line: 3 },   // document
    { rule_id: "talos-cds-auth-not-required", file: "zi_x.ddls.asddls", line: 1 },   // document
    { rule_id: "check_subrc", file: "z.clas.abap", line: 9 },                        // recommend
  ]);
  const out = applyFinalReview({ provisional: true, reasons: [] }, triaged);
  assert.deepEqual(out.reasons, [], "no reason may be contributed");
  assert.equal(out.provisional, true, "and the verdict stays provisional");
  assert.equal(out.final_review.document.length, 2, "but they ARE carried, not dropped");
  assert.equal(out.final_review.recommend.length, 1);
});

test("an owed attestation still routes to the human when the artifact also has advisory findings", () => {
  // The regression this whole split exists to prevent. `auth-delta-unattested` is the only reason; adding
  // a document/recommend finding must not change that.
  const triaged = triageAll([
    { rule_id: "talos-perf-73-eml-local-mode", file: "zbp_x.clas.abap", line: 3 },
    { rule_id: "7bit_ascii", file: "zbp_x.clas.abap", line: 4 },
  ]);
  const out = applyFinalReview({ provisional: false, reasons: ["auth-delta-unattested"] }, triaged);
  assert.deepEqual(out.reasons, ["auth-delta-unattested"], "the reason list is unchanged — still all-attestable");
});

test("a real defect DOES outrank an owed attestation — fix first, attest the fixed thing", () => {
  const out = applyFinalReview({ provisional: false, reasons: ["auth-delta-unattested"] }, withFix("talos-duplicate-block"));
  assert.equal(out.reasons.length, 2);
  assert.ok(out.reasons.includes("auth-delta-unattested"), "the owed attestation is not lost");
  assert.ok(out.reasons.some((r) => r.startsWith(FIX_REASON_PREFIX)), "and the defect is added");
});

test("repeated hits of one rule collapse to a single reason carrying the hit count", () => {
  const triaged = triageAll([
    { rule_id: "talos-duplicate-block", file: "b.clas.abap", line: 20 },
    { rule_id: "talos-duplicate-block", file: "a.clas.abap", line: 10 },
    { rule_id: "talos-duplicate-block", file: "a.clas.abap", line: 5 },
  ]);
  const out = applyFinalReview({ provisional: true, reasons: [] }, triaged);
  assert.equal(out.reasons.length, 1, "one reason per rule, not per hit");
  assert.ok(out.reasons[0].includes("3"), `hit count stated: ${out.reasons[0]}`);
  assert.ok(out.reasons[0].includes("a.clas.abap:5"), `first hit is the lowest file/line: ${out.reasons[0]}`);
});

test("the folded reasons are deterministic regardless of finding order", () => {
  const findings = [
    { rule_id: "talos-duplicate-block", file: "b.clas.abap", line: 2 },
    { rule_id: "talos-cc-001-obsolete-arithmetic", file: "a.clas.abap", line: 1 },
    { rule_id: "talos-cloud-005-class-final-abstract", file: "c.clas.abap", line: 3 },
  ];
  const forward = applyFinalReview({ provisional: true, reasons: [] }, triageAll(findings));
  const reversed = applyFinalReview({ provisional: true, reasons: [] }, triageAll([...findings].reverse()));
  assert.deepEqual(forward.reasons, reversed.reasons);
  assert.deepEqual([...forward.reasons].sort(), forward.reasons, "and sorted, so a diff of two runs is readable");
});

test("an existing reason is never duplicated by the fold", () => {
  const already = `${FIX_REASON_PREFIX}talos-duplicate-block (1 hit, first z.clas.abap:7)`;
  const out = applyFinalReview({ provisional: false, reasons: [already] }, withFix("talos-duplicate-block"));
  assert.equal(out.reasons.length, 1, `duplicated: ${JSON.stringify(out.reasons)}`);
});

test("applyFinalReview tolerates an absent reason list and an absent triage", () => {
  assert.deepEqual(applyFinalReview({ provisional: true }, clean).reasons, []);
  const out = applyFinalReview({ provisional: true }, undefined);
  assert.deepEqual([out.final_review.fix, out.final_review.document, out.final_review.recommend], [[], [], []]);
  assert.equal(out.provisional, true);
});

test("the fold reports a count for every action, so a zero is visible rather than absent", () => {
  const out = applyFinalReview({ provisional: true, reasons: [] }, withFix("talos-duplicate-block"));
  assert.deepEqual(out.final_review.counts, { fix: 1, document: 0, recommend: 0 });
});

test("an object abaplint could not analyse blocks — a review that did not run is not a clean review", () => {
  // `abaplint_engine_error` means the object was analysed NOT AT ALL (analyser/src/abaplint-rules.js:38-54).
  // Reading the resulting empty finding list as a pass is the same fail-open the F5 `--findings` guard
  // exists to prevent: absence of evidence read as evidence of absence.
  const triaged = triageAll([
    { rule_id: "abaplint_engine_error", object: "ZCL_X", file: "zcl_x.clas.abap", severity: "info" },
  ]);
  const out = applyFinalReview({ provisional: true, reasons: [] }, triaged);
  assert.equal(out.provisional, false, "an unanalysable artifact cannot pass provisionally");
  assert.deepEqual(out.reasons, [`${UNANALYSABLE_REASON_PREFIX}ZCL_X`]);
});

test("the unanalysable guard reports each object once and stays deterministic", () => {
  const triaged = triageAll([
    { rule_id: "abaplint_engine_error", object: "ZCL_B", file: "b.clas.abap" },
    { rule_id: "abaplint_engine_error", object: "ZCL_A", file: "a.clas.abap" },
    { rule_id: "abaplint_engine_error", object: "ZCL_A", file: "a.clas.abap" },
  ]);
  const out = applyFinalReview({ provisional: true, reasons: [] }, triaged);
  assert.deepEqual(out.reasons, [
    `${UNANALYSABLE_REASON_PREFIX}ZCL_A`,
    `${UNANALYSABLE_REASON_PREFIX}ZCL_B`,
  ]);
});

test("the unanalysable guard survives the diagnostic being given a triage entry later", () => {
  // It scans every bucket, not just `recommend`, so a future table entry for the diagnostic cannot silently
  // disarm the guard by moving it out of the bucket the guard happened to look in.
  const asFix = { fix: [{ rule_id: ENGINE_ERROR_RULE_ID, finding: { object: "ZCL_X" } }], document: [], recommend: [] };
  const asDoc = { fix: [], document: [{ rule_id: ENGINE_ERROR_RULE_ID, finding: { object: "ZCL_X" } }], recommend: [] };
  for (const triaged of [asFix, asDoc]) {
    const out = applyFinalReview({ provisional: true, reasons: [] }, triaged);
    assert.ok(out.reasons.includes(`${UNANALYSABLE_REASON_PREFIX}ZCL_X`), JSON.stringify(out.reasons));
    assert.equal(out.provisional, false);
  }
});

test("a named human's ATTEST_REVIEWED clears the unanalysable reason — and is named for doing it", () => {
  // R5's gate, completed. No rewrite fixes an abaplint crash, so the only remedy is a human reading the
  // artifact the analyser could not. Identical asymmetry to parity and auth (§7.5): the attestation is
  // EVIDENCE the machine conjunction is re-evaluated with, never a human-granted PASS. Without this the
  // UNANALYSABLE_ARTIFACT gate would resolve and change nothing — a decision that decides nothing, which is
  // exactly the defect class the surface census exists to catch.
  const triaged = triageAll([
    { rule_id: "abaplint_engine_error", object: "ZCL_X", file: "zcl_x.clas.abap", severity: "info" },
  ]);
  const blocked = applyFinalReview({ provisional: true, reasons: [] }, triaged);
  assert.equal(blocked.provisional, false, "unattested, it must still block");

  const cleared = applyFinalReview({ provisional: true, reasons: [] }, triaged, { artifact_reviewed: "sec-reviewer" });
  assert.deepEqual(cleared.reasons, [], `the attested reason must be gone: ${JSON.stringify(cleared.reasons)}`);
  assert.equal(cleared.provisional, true, "and the node is free to rest");
  assert.equal(cleared.final_review.artifact_reviewed_by, "sec-reviewer", "the attester is named in the proof bundle");
  assert.equal(
    cleared.final_review.counts.recommend, blocked.final_review.counts.recommend,
    "clearing the REASON must not erase the DIAGNOSTIC — the record of why it was raised survives",
  );
});

test("an attestation clears only the unanalysable reason, never a real defect", () => {
  // The asymmetry that keeps this from being a human-granted PASS. A `fix` finding is a defect the
  // generator can actually repair, so no attestation may launder it — attesting a defective artifact is
  // meaningless (drive.js:169-170), and a human who could clear a real ATC defect by signature would be a
  // hole straight through the ratchet.
  const triaged = triageAll([
    { rule_id: "abaplint_engine_error", object: "ZCL_X", file: "zcl_x.clas.abap", severity: "info" },
    { rule_id: "talos-cloud-005-class-final-abstract", object: "ZCL_Y", file: "zcl_y.clas.abap", severity: "error" },
  ]);
  const out = applyFinalReview({ provisional: true, reasons: [] }, triaged, { artifact_reviewed: "sec-reviewer" });
  assert.equal(out.provisional, false, "the real defect still blocks");
  assert.ok(
    out.reasons.some((r) => r.startsWith(FIX_REASON_PREFIX)),
    `the fix reason must survive the attestation: ${JSON.stringify(out.reasons)}`,
  );
  assert.ok(
    !out.reasons.some((r) => r.startsWith(UNANALYSABLE_REASON_PREFIX)),
    "while the attested one is cleared",
  );
});

test("a replayed verdict already carrying the review's reason still blocks", () => {
  // The block decision turns on whether the review found something, not on whether the reason string is new.
  // Deciding on novelty would let a replay pass provisionally with the defect still present.
  const already = `${FIX_REASON_PREFIX}talos-duplicate-block (1 hit, first z.clas.abap:7)`;
  const out = applyFinalReview({ provisional: true, reasons: [already] }, withFix("talos-duplicate-block"));
  assert.equal(out.provisional, false, "the defect is still there — a replay does not launder it");
  assert.deepEqual(out.reasons, [already], "and the reason is still not duplicated");
});


test("both of the analyser's EML-local-mode rules triage identically — one fact, one verdict", () => {
  // R6. They describe the same bypass; a caller must not get a different answer depending on which rule
  // pack reported it. Pinning the pair, not just their membership, so a future divergence fails here.
  const a = triage({ rule_id: "talos-perf-73-eml-local-mode", file: "zbp_x.clas.abap" });
  const b = triage({ rule_id: "talos-eml-local-mode-outside-test", file: "zbp_x.clas.abap" });
  assert.equal(a.action, b.action, "same fact, same action");
  assert.equal(a.action, "document", "and the action is a human judgement, never an automatic rewrite");
});

test("the suffixes the analyser's loader actually admits are pinned, so the review's blind spots are visible", () => {
  // Adversarial pass, confirmed by probe 2026-08-09: `filesFromBundle` admits only .asddls / .asdcls /
  // .asbdef / .clas.abap / .clas.testclasses.abap. The real generated corpus ALSO contains .asddlx (metadata
  // extension), .asdbtab (DB table), .srvd (service definition) and .srvb (service binding) — the analyser
  // never reads them, so the final review never grades them. That is an analyser coverage gap, not a triage
  // gap, and this test exists so it cannot stay invisible: when the loader learns those suffixes, this fails
  // and whoever fixes it sees that the mappings below were waiting for them.
  const ADMITTED = ["cds", "dcls", "bdef", "class", "test_class"];
  const NOT_YET_LOADED = ["ddlx", "dbtab", "srvd", "srvb"];
  for (const c of [...ADMITTED, ...NOT_YET_LOADED]) {
    assert.ok(ARTIFACT_CONTEXTS.includes(c), `${c} must stay in the declared vocabulary`);
  }
  // The mapping is a pure lookup, so keeping the not-yet-loaded entries costs nothing and is correct the
  // moment the loader admits them. What must not happen is anyone reading a passing suite as proof that
  // every RAP artifact is being reviewed.
  assert.equal(artifactContext("z.srvd"), "srvd");
  assert.equal(artifactContext("zc_x.ddlx.asddlx"), "ddlx");
});
