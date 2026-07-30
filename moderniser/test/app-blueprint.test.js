import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAppBlueprint } from "../src/plan/app-blueprint.js";
import { checkBlueprint } from "../src/plan/blueprint-conformance.js";

// B3.5 seam 3 (BUILD_PLAN S11 two-level reasoning / §6.13): the PURE app-level decomposer + the
// pre-freeze conformance check. `app-blueprint.js` turns an app-level VERDICT (the fulfiller/judge
// artifact — per-object target_shape + cross-object structure) into per-object contract stubs with a
// flat object→pattern map. `blueprint-conformance.js` proves the blueprint is internally consistent
// BEFORE any Architecture Contract freezes (S12 build order): every object mapped, every cross-object
// ref resolves, every shape ∈ the corpus.

const verdict = (o = {}) => ({
  app_id: "APP1",
  assignments: [
    { sig: "sigA", target_shape: "rap_bo_odata" },
    { sig: "sigB", target_shape: "rap_bo_odata" },
  ],
  shared: { services: [{ id: "svc_orders", members: ["sigA", "sigB"] }], projections: [], fiori_apps: [] },
  ...o,
});

test("buildAppBlueprint decomposes a verdict → flat object_to_pattern + per-object contract stubs + shared structure", () => {
  const bp = buildAppBlueprint(verdict());
  assert.equal(bp.app_id, "APP1");
  assert.deepEqual(bp.object_to_pattern, { sigA: "rap_bo_odata", sigB: "rap_bo_odata" });
  assert.equal(bp.objects.length, 2);
  const a = bp.objects.find((o) => o.sig === "sigA");
  assert.equal(a.target_shape, "rap_bo_odata");
  assert.ok(a.components.includes("service_def"), "components resolved from the corpus pattern");
  assert.deepEqual(a.shared_refs, ["svc_orders"], "the object carries the shared services it belongs to");
  assert.equal(bp.shared.services[0].id, "svc_orders");
});

test("buildAppBlueprint is deterministic and canonically ordered (objects sorted by sig; runs byte-identical)", () => {
  const scrambled = verdict({ assignments: [
    { sig: "sigB", target_shape: "rap_bo_odata" }, { sig: "sigA", target_shape: "rap_bo_odata" },
  ] });
  const bp = buildAppBlueprint(scrambled);
  assert.deepEqual(bp.objects.map((o) => o.sig), ["sigA", "sigB"], "objects sorted by sig");
  assert.equal(JSON.stringify(buildAppBlueprint(scrambled)), JSON.stringify(bp), "deterministic");
});

test("buildAppBlueprint fails closed on a target_shape outside the corpus", () => {
  assert.throws(() => buildAppBlueprint(verdict({ assignments: [{ sig: "sigA", target_shape: "cap_side_by_side" }] })), /not a corpus target_shape|unknown target_shape/i);
});

test("buildAppBlueprint fails closed on a duplicate sig in the verdict", () => {
  assert.throws(() => buildAppBlueprint(verdict({ assignments: [
    { sig: "sigA", target_shape: "rap_bo_odata" }, { sig: "sigA", target_shape: "rap_bo_fiori" },
  ] })), /duplicate sig/i);
});

// ---- conformance (run BEFORE contracts freeze) ----

test("checkBlueprint passes a well-formed blueprint (every object mapped, refs resolve, shapes ∈ corpus)", () => {
  const res = checkBlueprint(buildAppBlueprint(verdict()));
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
});

test("checkBlueprint FAILS when a contract object is absent from the object→pattern map (S4b TDD)", () => {
  const bp = buildAppBlueprint(verdict());
  bp.objects.push({ sig: "sigGHOST", target_shape: "rap_bo_odata", components: ["cds_interface"], shared_refs: [] });
  const res = checkBlueprint(bp);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /sigGHOST/.test(v) && /map/i.test(v)), "flags the unmapped object");
});

test("checkBlueprint FAILS on a dangling shared-service member ref (S4b TDD)", () => {
  const bp = buildAppBlueprint(verdict());
  bp.shared.services[0].members.push("sigMISSING"); // a member that is not an object in the blueprint
  const res = checkBlueprint(bp);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /sigMISSING/.test(v)), "flags the dangling cross-object ref");
});

test("checkBlueprint FAILS when a mapped shape is not a corpus pattern (pattern-match rule)", () => {
  const bp = buildAppBlueprint(verdict());
  bp.object_to_pattern.sigA = "made_up_shape";
  const res = checkBlueprint(bp);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /made_up_shape/.test(v)));
});

test("checkBlueprint FAILS when an object's shared_ref points to no declared shared group", () => {
  const bp = buildAppBlueprint(verdict());
  bp.objects[0].shared_refs.push("svc_phantom");
  const res = checkBlueprint(bp);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /svc_phantom/.test(v)));
});
