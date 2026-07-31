/**
 * Escalation verbs for the /modernise CLI — the executable path into the exception-module
 * family (§3.4). The skill raises taxonomy escalations, lists the rate-limited surfaceable
 * set, renders GatePackets, and records TYPED human decisions; every mutation lands durably
 * in the §3.4 #6 `escalations.json` register and a §6.6 log row.
 *
 *   escalate    <run_id> --kind K --nodes sig[,sig...] [--root-signature r]
 *   escalations <run_id> [--max N] [--critical sig[,sig...]]
 *   packets     <run_id> [--max N] [--critical sig[,sig...]]
 *   decide      <run_id> <esc_id> <DECISION> --by <name>
 */
import { raiseEscalation, surfaceable } from "./exception/escalation-bus.js";
import { recordDecision, renderPacket } from "./exception/gate-ui.js";
import { recordDispositionDecision, raiseDispositionReviews } from "./plan/disposition-gate.js";
import { recordArchDecision, parseArchDecision } from "./plan/arch-gate.js";
import { bindArchContract } from "./plan/arch-contract.js";
import { buildDispositionManifest } from "./plan/manifest.js";
import { loadRun, readEscalations, saveEscalations, saveDispositionManifest, saveState, log } from "./cli-io.js";

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

/**
 * The plan-time DISPOSITION gate (B3, S1): emit `disposition-manifest.json` from the classified plan and
 * raise one DISPOSITION_REVIEW per prompted node. Runs after `plan`, before the first `drive`. Idempotent —
 * the manifest is a deterministic view of the frozen plan, and the bus dedupes an already-open review.
 */
export function cmdDisposition(io, pos) {
  const [runId] = pos;
  const { plan } = loadRun(io, runId); // a verified plan (hash-checked)
  const manifest = buildDispositionManifest(plan, { run_id: runId });
  saveDispositionManifest(io, runId, manifest);
  const reg = raiseDispositionReviews(readEscalations(io), manifest, { ts: new Date().toISOString() });
  saveEscalations(io, reg);
  log(io, runId, "disposition", { rows: manifest.rows.length, prompt: manifest.summary.prompt_count, auto: manifest.summary.auto_count });
  return { run_id: runId, summary: manifest.summary };
}

export function cmdEscalations(io, pos, flags) {
  const [runId] = pos;
  loadRun(io, runId);
  const max = flags.max === undefined ? DEFAULT_SURFACE_MAX : Number(flags.max);
  const criticalSigs = new Set(String(flags.critical ?? "").split(",").filter(Boolean));
  const { surfaced, queued } = surfaceable(readEscalations(io), { max, criticalSigs });
  return { surfaced, queued };
}

/**
 * The §3.4 #8 GatePacket presentation, made executable (review F18): each SURFACED
 * escalation rendered with its kind, one-line cause, and TYPED decision set — the skill
 * presents these verbatim and never invents decision options.
 */
export function cmdPackets(io, pos, flags) {
  const [runId] = pos;
  loadRun(io, runId);
  const max = flags.max === undefined ? DEFAULT_SURFACE_MAX : Number(flags.max);
  const criticalSigs = new Set(String(flags.critical ?? "").split(",").filter(Boolean));
  const { surfaced, queued } = surfaceable(readEscalations(io), { max, criticalSigs });
  return { packets: surfaced.map((e) => renderPacket(e)), queued: queued.length };
}

export function cmdDecide(io, pos, flags) {
  const [runId, id, decision] = pos;
  const { state } = loadRun(io, runId);
  const reg = readEscalations(io);
  const target = reg.escalations.find((e) => e.id === id && e.status === "OPEN");
  const ts = new Date().toISOString();
  let next;
  if (target?.kind === "ARCH_REVIEW") {
    // Plan-time architecture ratification (B3.5a, S12): the decision precedes any artifact, so there is NO
    // generation to bind. Bind the ratified contract_hash + reviewer verdict from run state onto the row; on
    // approve, also stamp ratified_by into state.arch_contracts so isArchRatified passes for the driver. State
    // is saved BEFORE the escalation resolves (below): a crash residue is a ratified-but-still-OPEN review,
    // healed by the idempotent retry — the reverse order would resolve the review yet leave the driver blocked.
    const sig = target.node_ids[0];
    const binding = state.arch_contracts?.[sig];
    next = recordArchDecision(reg, id, decision, { decided_by: flags.by, ts, run_id: runId, contract_hash: binding?.hash, reviewer_verdict: binding?.reviewer_verdict });
    // approve RATIFIES; refine/reject actively VOID any prior ratification. The clear is not merely the
    // absence of a stamp: cmdArch PRESERVES a ratification across a re-run with an unchanged contract, so an
    // approve → (re-raised review) → reject sequence would otherwise leave the node ratified and still
    // dispatchable — the driver would keep building architecture the human has just rejected.
    if (binding) {
      const verb = parseArchDecision(decision).verb;
      saveState(io, runId, bindArchContract(state, sig, {
        ref: binding.ref,
        hash: binding.hash,
        ratified_by: verb === "approve" ? flags.by : null,
        reviewer_verdict: binding.reviewer_verdict,
      }));
    }
  } else if (target?.kind === "DISPOSITION_REVIEW") {
    // Plan-time gate (B3): the decision precedes any artifact, so there is NO generation to bind —
    // route to the parametrized recorder (approve | override:<disposition> | other:<freeform>), S2.
    next = recordDispositionDecision(reg, id, decision, { decided_by: flags.by, ts, run_id: runId });
  } else {
    // Temporal binding (ratified 2026-07-13; re-keyed per branch-review F4): stamp the run +
    // each node's CURRENT artifact GENERATION into the audited row — the generation bumps on
    // EVERY entry to GENERATED (retry AND re-entry regeneration; a pre-artifact decision
    // stamps 0 and can never match generation ≥ 1), so this decision can never bless an
    // artifact the human did not see, nor leak into another run.
    const decided_generations = Object.fromEntries((target?.node_ids ?? []).map((s) => [s, state.generation?.[s] ?? 0]));
    // decided_epoch: run_id alone cannot discriminate a --force-recreated run (same plan-hash
    // id); the epoch stamped at plan time can (F4-escape review)
    next = recordDecision(reg, id, decision, { decided_by: flags.by, ts, run_id: runId, decided_generations, decided_epoch: state.run_epoch ?? null });
  }
  saveEscalations(io, next);
  const row = next.escalations.find((e) => e.id === id && e.status === "RESOLVED" && e.resolved_at === ts);
  log(io, runId, "decide", { id, decision, decided_by: flags.by });
  return row; // the row THIS call resolved — never an earlier same-id row
}
