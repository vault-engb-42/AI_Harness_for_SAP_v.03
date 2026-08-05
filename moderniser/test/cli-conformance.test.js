import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlan } from "../src/sched/plan.js";
import { consumptionFacts } from "../src/plan/consumption-facts.js";
import { factHash } from "../src/plan/arch-facts.js";
import { putEntry } from "../src/state/arch-verdict-cache.js";

// H (adversarial pass #2, CONFIRMED): the ratified Architecture Contract was INERT. checkConformance had no
// production caller anywhere, and the S6 `loadContract` read seam existed only as two JSDoc references — so
// a contract could be frozen, independently reviewed and human-ratified, and then nothing on earth checked
// that the generated output was the thing that had been ratified.
//
// `conformance <run_id> <sig> --generated <file>` closes it: it loads the contract through the S6 seam
// (hash-verified against the ratified binding, fail-closed on drift), refuses an UNRATIFIED contract, and
// runs the shipped checkConformance. Exit 2 on a violation, exactly like the gap-2a rule gate.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

function mk() {
  const base = mkdtempSync(join(tmpdir(), "conf-cli-"));
  const stateDir = join(base, "state");
  const runsDir = join(base, "runs");
  const run = (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", stateDir, "--runs-dir", runsDir], { encoding: "utf8" }));
  return { base, stateDir, runsDir, run };
}

const consOf = () => consumptionFacts(JSON.parse(readFileSync(FIXTURE, "utf8")));
const statePath = (stateDir, runId) => join(stateDir, "runs", `${runId}.state.json`);
const stateOf = (stateDir, runId) => JSON.parse(readFileSync(statePath(stateDir, runId), "utf8"));

/** Plan → seed the judge cache → arch → independent review → ratify. Returns the ratified node + contract. */
function ratifiedRun() {
  const ctx = mk();
  const planned = ctx.run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, ctx.stateDir).nodes[0];
  const rec = { sig: target.id, target_shape: "rap_bo_headless", components: [], invariants: [], candidates: [{ id: "rap_bo_headless", score: 1 }], source: "judge" };
  writeFileSync(join(ctx.stateDir, "arch-verdict-cache.json"), JSON.stringify(putEntry({ entries: {} }, factHash(target, consOf()), "opus", "ph1", rec), null, 2));
  ctx.run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");

  const verdictFile = join(ctx.base, "review.json");
  writeFileSync(verdictFile, JSON.stringify({ verdict: "pass", flags: [] }));
  ctx.run("arch-review", planned.run_id, target.id, "--verdict", verdictFile, "--by", "abap-arch-reviewer");
  const esc = ctx.run("escalations", planned.run_id, "--max", "50");
  const id = [...esc.surfaced, ...esc.queued].find((e) => e.kind === "ARCH_REVIEW").id;
  ctx.run("decide", planned.run_id, id, "approve", "--by", "eng");

  const contract = JSON.parse(readFileSync(join(ctx.runsDir, planned.run_id, `arch-contract-${target.id}.json`), "utf8"));
  return { ...ctx, runId: planned.run_id, sig: target.id, contract };
}

/** A generated set that matches the contract exactly (ids + declared invariants). */
const matching = (contract) => ({
  objects: contract.objects.map((o) => ({ id: o.id, kind: o.kind, declared_invariants: [...o.invariants_required], source: "" })),
});
const writeGen = (base, name, doc) => {
  const p = join(base, name);
  writeFileSync(p, JSON.stringify(doc));
  return p;
};

test("H conformance PASSES when the generated set is exactly what was ratified", () => {
  const { base, run, runId, sig, contract } = ratifiedRun();
  const out = run("conformance", runId, sig, "--generated", writeGen(base, "gen-ok.json", matching(contract)));
  assert.equal(out.ok, true, JSON.stringify(out.violations));
  assert.equal(out.blocked, undefined);
  assert.equal(out.contract_hash, contract.contract_hash, "it checked against the RATIFIED contract");
});

test("H conformance BLOCKS on an object outside the contract (closed world — no over-generation)", () => {
  const { base, run, runId, sig, contract } = ratifiedRun();
  const gen = matching(contract);
  gen.objects.push({ id: "ZI_Sneaky", kind: "cds", declared_invariants: [], source: "" });
  assert.throws(
    () => run("conformance", runId, sig, "--generated", writeGen(base, "gen-extra.json", gen)),
    "a violation must exit non-zero, like the gap-2a rule gate",
  );
});

test("H conformance BLOCKS when a pinned object is missing from the generated set", () => {
  const { base, run, runId, sig, contract } = ratifiedRun();
  const gen = matching(contract);
  gen.objects.pop();
  assert.throws(() => run("conformance", runId, sig, "--generated", writeGen(base, "gen-missing.json", gen)));
});

// ---- the S6 read seam: hash-verified, ratification-required, fail-closed ----

test("H the read seam FAILS CLOSED when the on-disk contract drifts from the ratified hash", () => {
  const { base, runsDir, run, runId, sig, contract } = ratifiedRun();
  const onDisk = join(runsDir, runId, `arch-contract-${sig}.json`);
  const edited = JSON.parse(readFileSync(onDisk, "utf8"));
  edited.objects.push({ id: "ZI_SnuckIn", kind: "cds", spec: null, grounded_apis: [], invariants_required: [], depends_on: [] });
  writeFileSync(onDisk, JSON.stringify(edited, null, 2)); // contract edited AFTER ratification
  assert.throws(
    () => run("conformance", runId, sig, "--generated", writeGen(base, "gen-drift.json", matching(contract))),
    /hash|ratified|drift/i,
    "an edited contract must not be silently enforced — it re-opens ARCH_REVIEW",
  );
});

test("H the read seam REFUSES an unratified contract (checking against unapproved architecture proves nothing)", () => {
  const { base, stateDir, run, runId, sig, contract } = ratifiedRun();
  const st = stateOf(stateDir, runId);
  st.arch_contracts[sig].ratified_by = null; // the human has not approved this
  writeFileSync(statePath(stateDir, runId), JSON.stringify(st, null, 2));
  assert.throws(
    () => run("conformance", runId, sig, "--generated", writeGen(base, "gen-unratified.json", matching(contract))),
    /ratif/i,
  );
});

test("H conformance refuses an unknown sig, a node with no bound contract, and a missing --generated", () => {
  const { base, run, runId, sig, contract } = ratifiedRun();
  assert.throws(() => run("conformance", runId, "0".repeat(64), "--generated", writeGen(base, "g1.json", matching(contract))));
  assert.throws(() => run("conformance", runId, sig), /--generated/i);
});
