import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlan } from "../../src/sched/plan.js";
import { bindArchContract } from "../../src/plan/arch-contract.js";

/**
 * Test support (B4/M1): clear the ARCHITECTURE gate for a planned run so the reducer will dispatch its
 * `re_architect`/`rebuild` nodes. Both `dispatch()` and `driveDecision` refuse an arch-gated node whose
 * Architecture Contract is not human-ratified, and the golden abap_fico fixture is entirely re_architect —
 * so every CLI/FSM-mechanics test must enter past gate 2.
 *
 * This is a STATE FIXTURE, not a mock: it writes real bindings through the real `bindArchContract` reducer
 * into the run's real durable state, which the production code then reads unchanged — the same class of
 * setup as seeding a status map. It deliberately does NOT shell out to the `arch` + `decide` verbs, because
 * that costs a subprocess per test and would push the suite past its wall-clock budget (testing.md). The
 * REAL gate flow — arch → arch-verdict → arch → decide approve → drive dispatches — is covered end to end,
 * against the real verbs and real fs, in cli-arch.test.js.
 *
 * @param {string} stateDir the run's --state-dir @param {string} runId
 */
export function ratifyArch(stateDir, runId) {
  const plan = loadPlan(runId, stateDir);
  const archNodes = plan.nodes.filter((n) => n.disposition === "re_architect" || n.disposition === "rebuild");
  if (archNodes.length === 0) return; // nothing is arch-gated — no gate to clear

  const statePath = join(stateDir, "runs", `${runId}.state.json`);
  let state = JSON.parse(readFileSync(statePath, "utf8"));
  for (const n of archNodes) {
    state = bindArchContract(state, n.id, { ref: `arch-contract-${n.id}.json`, hash: `h-${n.id}`, ratified_by: "test" });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}
