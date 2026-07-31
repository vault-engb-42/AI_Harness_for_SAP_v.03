import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlan } from "../../src/sched/plan.js";
import { consumptionFacts } from "../../src/plan/consumption-facts.js";
import { factStream, factHash } from "../../src/plan/arch-facts.js";
import { matchTargetShapes } from "../../src/plan/patterns/match.js";
import { putEntry } from "../../src/state/arch-verdict-cache.js";

/**
 * Test support (B4): ratify every re_architect/rebuild node's architecture so the driver's isArchRatified
 * precondition passes and `drive` dispatches. No mocks — real modules + the real `arch` verb:
 *   1. seed the judge verdict cache (the fulfiller's output) with each node's TOP structural candidate, so
 *      `arch` RESOLVES the node as cached and BINDS a real Architecture Contract;
 *   2. run the real `arch` verb (builds + binds the contracts, raises the ARCH_REVIEWs);
 *   3. stamp the human ratification (ratified_by) directly into run state — a FIXTURE, not a mock: the real
 *      `decide approve` verb is exercised end to end in cli-arch.test.js; the driver reads only
 *      arch_contracts[sig].ratified_by, and seeding it directly keeps these driver-mechanics tests fast
 *      (one subprocess, not one-per-ARCH_REVIEW — the CI wall-clock budget, testing.md).
 *
 * @param {(...args: string[]) => any} cli a JSON-returning CLI runner bound to a --state-dir/--runs-dir
 * @param {string} stateDir the run's state dir @param {string} runId @param {string} fixturePath the findings doc
 */
export function ratifyArch(cli, stateDir, runId, fixturePath, { model = "opus", promptHash = "ph1" } = {}) {
  const doc = JSON.parse(readFileSync(fixturePath, "utf8"));
  const cons = consumptionFacts(doc);
  const plan = loadPlan(runId, stateDir);

  let cache = { entries: {} };
  for (const n of plan.nodes) {
    if (n.disposition !== "re_architect" && n.disposition !== "rebuild") continue;
    const cands = matchTargetShapes(factStream(n, cons));
    if (cands.length === 0) continue; // no structural candidate → stays await_arch, not ratified here
    const rec = { sig: n.id, target_shape: cands[0].id, components: cands[0].components, invariants: cands[0].invariants, candidates: cands.map((c) => ({ id: c.id, score: c.score })), source: "judge" };
    cache = putEntry(cache, factHash(n, cons), model, promptHash, rec);
  }
  writeFileSync(join(stateDir, "arch-verdict-cache.json"), JSON.stringify(cache, null, 2));

  cli("arch", runId, fixturePath, "--model", model, "--prompt-hash", promptHash);

  const statePath = join(stateDir, "runs", `${runId}.state.json`);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const arch_contracts = { ...(state.arch_contracts ?? {}) };
  for (const sig of Object.keys(arch_contracts)) arch_contracts[sig] = { ...arch_contracts[sig], ratified_by: "test" };
  writeFileSync(statePath, JSON.stringify({ ...state, arch_contracts }, null, 2), "utf8");
}
