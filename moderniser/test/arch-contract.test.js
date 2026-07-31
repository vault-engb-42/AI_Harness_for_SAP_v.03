import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildArchContract, contractHash, bindArchContract, isArchRatified } from "../src/plan/arch-contract.js";
import { loadPatternCorpus, PATTERN_IDS } from "../src/plan/patterns/match.js";
import { canonicalJSON } from "../src/state/canonical-json.js";
import { checkConformance } from "../src/sched/conformance.js";
import { initRun } from "../src/sched/loop.js";

// B3.5a wiring seam 1 (BUILD_PLAN S6/S12 / §4c "Finish B3.5a"): the Architecture Contract builder +
// run-state binding. buildArchContract freezes a reasoned node into the COARSE contract the CONFORMANCE
// gate later checks against — target_shape + one object per pattern component + the shape's invariants.
// It is coarse by design: `spec` (field-level) + real grounded_apis are filled by the PLANNER design pass;
// `grounded_apis` seeds from `pattern.grounding_refs` ([] for build shapes — reviewer F5). arch_contracts
// is RUN STATE (bindArchContract/isArchRatified), so plan_hash is unaffected (S6).

const node = (o = {}) => ({ id: "sigA", object: "ZFOO", disposition: "re_architect", ...o });
const rec = (o = {}) => ({ sig: "sigA", target_shape: "rap_bo_headless", source: "deterministic", ...o });

// ---- buildArchContract: the coarse contract ----

test("buildArchContract freezes the coarse contract from node + recommendation + corpus", () => {
  const c = buildArchContract(node(), rec());
  assert.equal(c.node_sig, "sigA");
  assert.equal(c.disposition, "re_architect");
  assert.equal(c.target, "rap_bo_headless");
  assert.equal(c.grounded_at, null, "coarse: not yet grounded — the planner design pass grounds it");
  assert.deepEqual(c.object_dag, []);
  assert.deepEqual(c.acceptance, []);
  assert.deepEqual(c.dropped, []);
  assert.ok(typeof c.contract_hash === "string" && c.contract_hash.length === 64);
});

test("buildArchContract emits one contract object per pattern component, id `${object}.${component}`", () => {
  const corpus = loadPatternCorpus();
  const pattern = corpus.patterns.find((p) => p.id === "rap_bo_headless");
  const c = buildArchContract(node(), rec());
  assert.equal(c.objects.length, pattern.components.length);
  assert.deepEqual(c.objects.map((o) => o.id), pattern.components.map((comp) => `ZFOO.${comp}`));
  for (const o of c.objects) {
    assert.equal(o.spec, null, "coarse: no field-level spec yet (planner fills it before ratify)");
    assert.deepEqual(o.depends_on, []);
    assert.deepEqual(o.invariants_required, pattern.invariants, "invariants_required = the shape's invariants");
  }
});

test("buildArchContract seeds grounded_apis from pattern.grounding_refs (reviewer F5), NOT from the recommendation", () => {
  // The real build patterns carry grounding_refs [] — the planner grounds them later.
  const built = buildArchContract(node(), rec());
  for (const o of built.objects) assert.deepEqual(o.grounded_apis, [], "build shape → [] (planner + oracle fill it)");
  // A synthetic corpus pattern WITH grounding_refs proves the seed actually copies them.
  const synthetic = { patterns: [{ id: "synthetic_shape", name: "syn", components: ["x", "y"], grounding_refs: ["I_ReleasedApi", "I_Other"], invariants: ["inv1"] }] };
  const c = buildArchContract(node(), rec({ target_shape: "synthetic_shape" }), synthetic);
  for (const o of c.objects) assert.deepEqual(o.grounded_apis, ["I_ReleasedApi", "I_Other"]);
  // Provenance is the PATTERN: a grounded_apis on the recommendation is ignored, so a judge (or a tampered
  // verdict cache) can never inject APIs into the contract that the corpus did not sanction.
  const injected = buildArchContract(node(), { ...rec(), grounded_apis: ["I_Injected"] });
  for (const o of injected.objects) assert.ok(!o.grounded_apis.includes("I_Injected"), "the recommendation cannot supply grounded_apis");
});

test("buildArchContract throws on a target_shape outside the corpus (closed vocabulary, fail-closed)", () => {
  assert.throws(() => buildArchContract(node(), rec({ target_shape: "cap_side_by_side" })), /not in the patterns corpus/i);
  assert.throws(() => buildArchContract(node(), rec({ target_shape: undefined })), /not in the patterns corpus/i);
});

test("every corpus target_shape is buildable (the builder covers the whole closed vocabulary)", () => {
  for (const id of PATTERN_IDS) {
    const c = buildArchContract(node(), rec({ target_shape: id }));
    assert.equal(c.target, id);
    assert.ok(c.objects.length >= 1, `${id} yields at least one contract object`);
  }
});

// ---- contractHash: deterministic + self-excluding ----

test("contractHash is deterministic and EXCLUDES the contract_hash field (matches plan_hash method)", () => {
  const c = buildArchContract(node(), rec());
  assert.equal(buildArchContract(node(), rec()).contract_hash, c.contract_hash, "same inputs → same hash");
  const { contract_hash, ...rest } = c;
  const expected = createHash("sha256").update(canonicalJSON(rest)).digest("hex");
  assert.equal(contract_hash, expected, "hash is sha256(canonicalJSON(contract without contract_hash))");
  // recomputing over the full contract (which now carries the hash) yields the SAME value → self-excluding.
  assert.equal(contractHash(c), contract_hash);
});

test("contractHash changes when a load-bearing field changes (target / objects)", () => {
  const base = buildArchContract(node(), rec());
  const other = buildArchContract(node(), rec({ target_shape: "rap_bo_odata" }));
  assert.notEqual(base.contract_hash, other.contract_hash);
});

// ---- run-state binding: bindArchContract / isArchRatified ----

test("bindArchContract records {ref,hash,ratified_by,reviewer_verdict} per sig (copy-on-write)", () => {
  const s0 = initRun({ plan_hash: "h", nodes: [{ id: "sigA", object: "ZFOO", dependencies: [], members: ["ZFOO"], wave: 0 }] });
  const s1 = bindArchContract(s0, "sigA", { ref: "specs/runs/r1/arch-contract-sigA.json", hash: "abc", ratified_by: null, reviewer_verdict: { verdict: "pass" } });
  assert.deepEqual(s0.arch_contracts, {}, "the input state is unmutated");
  assert.deepEqual(s1.arch_contracts.sigA, { ref: "specs/runs/r1/arch-contract-sigA.json", hash: "abc", ratified_by: null, reviewer_verdict: { verdict: "pass" } });
});

test("bindArchContract preserves other sigs' bindings", () => {
  let s = bindArchContract({ arch_contracts: {} }, "sigA", { ref: "a", hash: "h1" });
  s = bindArchContract(s, "sigB", { ref: "b", hash: "h2" });
  assert.deepEqual(Object.keys(s.arch_contracts).sort(), ["sigA", "sigB"]);
});

test("isArchRatified: false with no contract, false with a bound-but-unratified contract, true once ratified", () => {
  assert.equal(isArchRatified({ arch_contracts: {} }, "sigA"), false, "no binding");
  const bound = bindArchContract({ arch_contracts: {} }, "sigA", { ref: "a", hash: "h1", ratified_by: null });
  assert.equal(isArchRatified(bound, "sigA"), false, "bound but no human ratification");
  const ratified = bindArchContract({ arch_contracts: {} }, "sigA", { ref: "a", hash: "h1", ratified_by: "eng" });
  assert.equal(isArchRatified(ratified, "sigA"), true, "hash + ratified_by ⇒ ratified");
});

// ---- initRun seeds the arch_contracts run-state map (S6) ----

test("initRun seeds an empty arch_contracts map (arch_contracts is run state, not the frozen node)", () => {
  const st = initRun({ plan_hash: "h", nodes: [{ id: "N1", object: "ZFOO", dependencies: [], members: ["ZFOO"], wave: 0 }] });
  assert.deepEqual(st.arch_contracts, {});
});

// ---- integration: a coarse contract is CONFORMANCE-ready (consumable by the shipped gate) ----

test("INTEGRATION a coarse contract is accepted by checkConformance when the generated set matches its objects + invariants", () => {
  const contract = buildArchContract(node(), rec());
  // A generated set that produces exactly the pinned objects and declares the required invariants.
  const generated = {
    objects: contract.objects.map((o) => ({ id: o.id, kind: o.kind, declared_invariants: [...o.invariants_required], source: "" })),
  };
  const res = checkConformance(generated, contract);
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});
