import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filesFromBundle } from "../../analyser/src/modes.js";
import { analyzePackage } from "../../analyser/src/orchestrator.js";
import { assembleBundle } from "../src/extract/bundle.js";
import { assemblePlan } from "../src/sched/assemble.js";
import { consumptionFacts } from "../src/plan/consumption-facts.js";
import { persistenceFacts } from "../src/plan/persistence-facts.js";

/**
 * THE ANALYSER → MODERNISER SEAM, on a corpus this repository can actually ship.
 *
 * `npm test` is the command README calls "offline tests (no SAP needed)", and it was RED on a clean
 * checkout: commit 0d3ca2b appended the four corpus suites to it, and their input is git-ignored
 * third-party ABAP (86 tracked files under demos/ against 622 on disk). demos/FETCH.md had already
 * stated the correct rule — the corpus lane is "deliberately not part of `npm test` (its input cannot be
 * shipped)" — and that commit contradicted a reasoned decision without updating the doc that carried it.
 *
 * Reverting alone would have reopened the hole 0d3ca2b closed: `npm test`'s glob is non-recursive, so the
 * only suites exercising this seam never ran, and RC-2 shipped a disposition regression through a green
 * gate. So the coverage moves rather than disappears. This bundle is HAND-WRITTEN for this repository and
 * carries its MIT licence: vendoring abap_fico (no licence) or zapcommander (GPLv3) to make the gate green
 * would trade a broken command for a licence violation.
 *
 * The acid test for whether this is honest coverage rather than a fig leaf: WOULD IT HAVE CAUGHT RC-2?
 * That regression sealed objects that had ample evidence. So this suite asserts a disposition PER OBJECT
 * against objects chosen to have unambiguous ones — a classifier that starts sealing them fails here.
 *
 * The deep lane still exists and still fails loudly: `npm run test:corpus`, over real customer packages,
 * is where scale, archetype variety and the offline-verdict acceptance are proven. This is the join, not
 * a replacement for it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "fixtures", "seam-bundle");
const BEFORE = join(BUNDLE, "before");
const AFTER = join(BUNDLE, "after");

const beforeFiles = filesFromBundle(BEFORE);
const afterFiles = filesFromBundle(AFTER);
const doc = analyzePackage(beforeFiles, { package: "ZSM_SEAM", source_system: "fixture:seam-bundle" });
const { plan } = assemblePlan(doc, {});
const cons = consumptionFacts(doc);
const pers = persistenceFacts(doc);

const nodeFor = (object) => plan.nodes.find((n) => (n.members ?? [n.object]).some((m) => String(m).toUpperCase() === object));
const factsFor = (map, object) => map[Object.keys(map).find((k) => k.toUpperCase() === object) ?? ""] ?? [];

test("SEAM: the bundle loads and BOTH engines extract from it on a clean checkout", () => {
  assert.ok(beforeFiles.length >= 3, `before side too small to prove anything: ${beforeFiles.length}`);
  assert.ok(afterFiles.length >= 4, `after side too small: ${afterFiles.length}`);
  assert.ok((doc.findings ?? []).length > 0, "the analyser must find real defects in deliberately classic ABAP");
  assert.ok(plan.nodes.length >= 3, `the moderniser must plan real nodes from them: ${plan.nodes.length}`);
  assert.ok(typeof plan.plan_hash === "string" && plan.plan_hash.length > 0, "the plan is content-hashed");
});

// The RC-2 detector. That regression sealed objects carrying ample evidence, and `npm test` stayed green
// because the only suites that would have noticed were excluded from it. These objects have unambiguous
// dispositions by construction, so a classifier that starts sealing them cannot hide here.
test("SEAM: every object gets a disposition, and NONE of them is sealed — they all carry evidence", () => {
  for (const object of ["ZSM_ORDER_LIST", "ZCL_SM_ORDER_STORE", "ZCL_SM_PRICING", "ZSM_ORDER_POST"]) {
    const node = nodeFor(object);
    assert.ok(node, `${object} must reach the plan — an object that vanishes is the silent-drop defect`);
    assert.ok(node.disposition, `${object} has no disposition`);
    assert.notEqual(node.disposition, "seal", `${object} has clear evidence; sealing it is the RC-2 regression`);
  }
});

// The two persistence dimensions must not collapse into each other. Owning your own table is what earns a
// RAP BO root; reading SAP's data is not, and writing through a BAPI is a third thing carried by a
// different producer (a CALL FUNCTION target, not a uses-table edge).
test("SEAM: persistence distinguishes OWNING your data from READING SAP's from WRITING via an API", () => {
  const store = factsFor(pers, "ZCL_SM_ORDER_STORE");
  assert.ok(store.includes("owns_customer_table"), `the store writes its own ZSM_ORDER: ${JSON.stringify(store)}`);

  const pricing = factsFor(pers, "ZCL_SM_PRICING");
  assert.ok(
    pricing.length === 0 || pricing.includes("no_persistence_evidence"),
    `pure arithmetic touches no data, and that absence must be REPORTED as absence: ${JSON.stringify(pricing)}`,
  );

  const poster = factsFor(pers, "ZSM_ORDER_POST");
  assert.ok(
    poster.includes("writes_via_sap_api"),
    `a BAPI_*_CREATEFROMDAT2 caller writes through an SAP API — a fact no uses-table edge carries: ${JSON.stringify(poster)}`,
  );
  assert.ok(!poster.includes("owns_customer_table"), "posting through a BAPI is not owning a table");
});

test("SEAM: consumption sees the classic surfaces the analyser is pointed at", () => {
  const list = factsFor(cons, "ZSM_ORDER_LIST");
  assert.ok(list.length > 0, "a classic report with a popup and WRITE output has a surface");
  assert.ok(!list.includes("no_surface_evidence"), `evidence present, so absence must not be claimed: ${JSON.stringify(list)}`);
});

// P4 lives on the modernised side. The classic AUTHORITY-CHECK relocated into the BDEF clause plus the
// handlers plus DCL; the save became the framework's. This is the extraction the offline verdict grades,
// so if it silently stops finding either, the verdict grades nothing and says PASS.
test("SEAM: the modernised side yields the P4 evidence the offline verdict is built on", () => {
  const after = assembleBundle(afterFiles);
  assert.ok(after.auth_bdef.length > 0, "no BDEF authorization clause extracted from the modernised RAP");
  assert.ok(
    after.commit_work > 0 || (after.auth_handlers ?? []).length > 0 || after.auth_dcl?.length > 0,
    "the RAP save boundary / auth handlers / DCL grant must be visible to the extractor",
  );
});

test("SEAM: the join is deterministic — a second pass produces the identical plan", () => {
  const again = assemblePlan(analyzePackage(filesFromBundle(BEFORE), { package: "ZSM_SEAM", source_system: "fixture:seam-bundle" }), {});
  assert.equal(again.plan.plan_hash, plan.plan_hash, "same input, same content-hashed plan");
});
