/**
 * Cycle-gate verbs for the /modernise CLI (MODERNISER_DESIGN §3.4 #4, L5; operator-ratified
 * 2026-07-13 — D4): the executable path into `exception/cycle-gate`. The human approves a
 * CUT / COGEN_RAP_BO / SPROUT_DEFER — never an ordering; approvals are LEARNED in the
 * audited `seam-memory.json` (member-signature-set keyed, confidence raised on
 * re-confirmation, never to certainty) AND recorded as a typed BREAK_CYCLE decision in the
 * escalations register.
 *
 *   seams         <run_id> <sig> [--findings f] [--budget N]
 *   resolve-cycle <run_id> <sig> --kind CUT|COGEN_RAP_BO|SPROUT_DEFER
 *                 [--edge a,b] [--members a,b] [--member a] --by <name>
 */
import { readFileSync } from "node:fs";
import { proposeSeams, applyResolution, memberSigSetKey } from "./exception/cycle-gate.js";
import { raiseEscalation } from "./exception/escalation-bus.js";
import { recordDecision } from "./exception/gate-ui.js";
import { buildObjectGraph, precedenceEdges } from "./graph/build.js";
import { loadRun, readEscalations, saveEscalations, readSeamMemory, saveSeamMemory, log } from "./cli-io.js";

/** The break_gate super-node's intra-SCC precedence edges, rebuilt from the findings doc. */
function breakGateNode(io, pos, flags) {
  const [runId, sig] = pos;
  const { plan, state } = loadRun(io, runId);
  const node = plan.nodes.find((n) => n.id === sig);
  if (!node) throw new Error(`cycle: unknown node ${sig}`);
  if (node.break_gate !== true) throw new Error(`cycle: ${sig} is not a break_gate super-node — nothing to cut`);
  return { runId, sig, plan, state, node };
}

export function cmdSeams(io, pos, flags) {
  const { runId, sig, plan, node } = breakGateNode(io, pos, flags);
  const doc = JSON.parse(readFileSync(flags.findings ?? "specs/brownfield/analyser-findings.json", "utf8"));
  const members = new Set(node.members);
  const edges = precedenceEdges(buildObjectGraph(doc).edges).filter(([u, v]) => members.has(u) && members.has(v));
  // budget: how large a residual sub-component may stay atomic. Default forces ≥ 1 cut.
  const budget = flags.budget !== undefined ? Number(flags.budget) : plan.session_budget ?? Math.max(1, node.members.length - 1);
  if (!Number.isInteger(budget) || budget < 1) throw new Error(`seams: --budget must be an integer >= 1 (got '${flags.budget}')`);
  const proposal = proposeSeams({ members: node.members, edges }, budget, readSeamMemory(io));
  return { sig, members: node.members, budget, ...proposal };
}

export function cmdResolveCycle(io, pos, flags) {
  const { runId, sig, state, node } = breakGateNode(io, pos, flags);
  const resolution = { kind: flags.kind };
  if (flags.edge !== undefined) resolution.edge = String(flags.edge).split(",").map((s) => s.trim()).filter(Boolean);
  if (flags.members !== undefined) resolution.members = String(flags.members).split(",").map((s) => s.trim()).filter(Boolean);
  if (flags.member !== undefined) resolution.member = flags.member;
  const ts = new Date().toISOString();
  // 1. LEARN (validates kind + required field; throws before anything persists)
  const memory = applyResolution(readSeamMemory(io), node.members, resolution, { ts });
  // 2. AUDIT: idempotent BREAK_CYCLE raise + the typed decision (decided_by required),
  //    stamped with the same run/epoch/generation binding every decision carries
  const raised = raiseEscalation(readEscalations(io), { kind: "BREAK_CYCLE", node_ids: [sig] }, { ts });
  const row = raised.escalations.find((e) => e.kind === "BREAK_CYCLE" && e.status === "OPEN" && e.node_ids.length === 1 && e.node_ids[0] === sig);
  const decided = recordDecision(raised, row.id, flags.kind, {
    decided_by: flags.by,
    ts,
    run_id: runId,
    decided_generations: { [sig]: state.generation?.[sig] ?? 0 },
    decided_epoch: state.run_epoch ?? null,
  });
  saveSeamMemory(io, memory);
  saveEscalations(io, decided);
  log(io, runId, "resolve-cycle", { sig, kind: flags.kind, decided_by: flags.by, escalation_id: row.id });
  const learned = memory.learned[memberSigSetKey(node.members)];
  return { sig, resolution: learned.resolution, confidence: learned.confidence, escalation_id: row.id };
}
