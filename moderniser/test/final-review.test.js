import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  triage,
  triageAll,
  artifactContext,
  ACTIONS,
  ARTIFACT_CONTEXTS,
  TRIAGE_TABLE,
  RETIRED_RULE_IDS,
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
