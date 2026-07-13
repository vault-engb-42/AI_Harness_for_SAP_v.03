/**
 * Escalation verbs for the /modernise CLI — the executable path into the exception-module
 * family (§3.4). The skill raises taxonomy escalations, lists the rate-limited surfaceable
 * set, and records TYPED human decisions; every mutation lands durably in the §3.4 #6
 * `escalations.json` register and a §6.6 log row.
 *
 *   escalate    <run_id> --kind K --nodes sig[,sig...] [--root-signature r]
 *   escalations <run_id> [--max N] [--critical sig[,sig...]]
 *   decide      <run_id> <esc_id> <DECISION> --by <name>
 */
import { raiseEscalation, surfaceable } from "./exception/escalation-bus.js";
import { recordDecision } from "./exception/gate-ui.js";
import { loadRun, readEscalations, saveEscalations, log } from "./cli-io.js";

const DEFAULT_SURFACE_MAX = 5; // MAX_ESC_PER_HUMAN_PER_WINDOW default until the manifest pins it

export function cmdEscalate(io, pos, flags) {
  const [runId] = pos;
  const { plan } = loadRun(io, runId); // escalations must belong to a verified run
  const node_ids = String(flags.nodes ?? "").split(",").filter(Boolean);
  const known = new Set(plan.nodes.map((n) => n.id));
  for (const s of node_ids) {
    if (!known.has(s)) throw new Error(`escalate: '${s}' is not a plan node — a typo'd sig would silently fail to void/join`);
  }
  const reg = readEscalations(io);
  const next = raiseEscalation(
    reg,
    { kind: flags.kind, node_ids, ...(flags["root-signature"] ? { root_signature: flags["root-signature"] } : {}) },
    { ts: new Date().toISOString() },
  );
  const sorted = [...new Set(node_ids)].sort();
  const row = next.escalations.find(
    (e) => e.kind === flags.kind && e.status === "OPEN" && JSON.stringify(e.node_ids) === JSON.stringify(sorted),
  );
  if (next !== reg) {
    saveEscalations(io, next);
    log(io, runId, "escalate", { id: row.id, kind: row.kind, node_ids: row.node_ids });
  }
  return row; // idempotent repeat returns the already-open row
}

export function cmdEscalations(io, pos, flags) {
  const [runId] = pos;
  loadRun(io, runId);
  const max = flags.max === undefined ? DEFAULT_SURFACE_MAX : Number(flags.max);
  const criticalSigs = new Set(String(flags.critical ?? "").split(",").filter(Boolean));
  const { surfaced, queued } = surfaceable(readEscalations(io), { max, criticalSigs });
  return { surfaced, queued };
}

export function cmdDecide(io, pos, flags) {
  const [runId, id, decision] = pos;
  const { state } = loadRun(io, runId);
  const reg = readEscalations(io);
  const target = reg.escalations.find((e) => e.id === id && e.status === "OPEN");
  // Temporal binding (ratified 2026-07-13): stamp the run + each node's CURRENT refinement
  // cycle into the audited row — the verdict join requires both, so this decision can never
  // bless a regenerated artifact or leak into another run.
  const decided_cycles = Object.fromEntries((target?.node_ids ?? []).map((s) => [s, state.cycle?.[s] ?? 0]));
  const ts = new Date().toISOString();
  const next = recordDecision(reg, id, decision, { decided_by: flags.by, ts, run_id: runId, decided_cycles });
  saveEscalations(io, next);
  const row = next.escalations.find((e) => e.id === id && e.status === "RESOLVED" && e.resolved_at === ts);
  log(io, runId, "decide", { id, decision, decided_by: flags.by });
  return row; // the row THIS call resolved — never an earlier same-id row
}
