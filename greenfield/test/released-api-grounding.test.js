import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRef, harvestRefs, groundReleasedApis, renderGroundingPack } from "../src/released-api-grounding.js";

// GF-1 — the greenfield pre-generation grounding rail. A deterministic offline
// lookup over the bundled SAP cloudification dataset: given the SAP objects a
// design/spec intends to use, it returns each object's release state + released
// successor so the generator writes against released APIs only. Real data, real
// code path (no mocks). This is a released-API registry lookup — NOT the
// analyser (no parse, no CPG, no rule packs).

test("classifyRef reads real release state from the bundled cloudification registry", () => {
  assert.equal(classifyRef("ACTVT").state, "released");
  const dep = classifyRef("CL_A4C_BC_FACTORY");
  assert.equal(dep.state, "deprecated");
  assert.equal(dep.successor, "CL_BCFG_CD_REUSE_API_FACTORY");
  assert.equal(classifyRef("CI_DCLS_CHK").state, "notToBeReleased");
  assert.equal(classifyRef("ZCL_TOTALLY_CUSTOM_XYZ").state, "unknown");
});

test("harvestRefs extracts SAP object refs, skipping customer Z/Y names and ABAP keywords", () => {
  const refs = harvestRefs("The handler SELECTs from BAPIRET1 and uses CL_A4C_BC_FACTORY, but ZCL_MINE and YIF_LOCAL are custom.");
  assert.ok(refs.includes("CL_A4C_BC_FACTORY"), "SAP class harvested");
  assert.ok(refs.includes("BAPIRET1"), "SAP structure (no underscore) harvested");
  assert.ok(!refs.includes("ZCL_MINE"), "customer Z name skipped");
  assert.ok(!refs.includes("YIF_LOCAL"), "customer Y name skipped");
  assert.ok(!refs.includes("SELECT"), "ABAP keyword skipped");
});

test("groundReleasedApis classifies a ref list with counts and successors", () => {
  const g = groundReleasedApis(["ACTVT", "CL_A4C_BC_FACTORY", "CI_DCLS_CHK", "ZCL_NEW"]);
  assert.equal(g.counts.released, 1);
  assert.equal(g.counts.deprecated, 1);
  assert.equal(g.counts.notToBeReleased, 1);
  assert.equal(g.counts.unknown, 1);
  assert.equal(g.refs.find((r) => r.name === "CL_A4C_BC_FACTORY").successor, "CL_BCFG_CD_REUSE_API_FACTORY");
});

test("renderGroundingPack surfaces deprecated successors and not-to-be-released as actionable", () => {
  const pack = renderGroundingPack(groundReleasedApis(["CL_A4C_BC_FACTORY", "CI_DCLS_CHK", "ACTVT"]));
  assert.match(pack, /Released-API Grounding/);
  assert.match(pack, /CL_A4C_BC_FACTORY/);
  assert.match(pack, /CL_BCFG_CD_REUSE_API_FACTORY/, "renders the released successor");
  assert.match(pack, /deprecated/i);
  assert.match(pack, /CI_DCLS_CHK/);
  assert.match(pack, /not[ -]?to[ -]?be[ -]?released/i);
});

test("an empty ref list renders a valid, benign pack", () => {
  const pack = renderGroundingPack(groundReleasedApis([]));
  assert.match(pack, /Released-API Grounding/);
});
