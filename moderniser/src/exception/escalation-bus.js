/**
 * Escalation bus (MODERNISER_DESIGN §3.4 #1/#3/#6, L2/L7). The human is an exception
 * handler + attester, never a volume gate: only the 7 taxonomy kinds exist (everything
 * else is a machine BLOCK), raising is idempotent per (kind, node-id set) so one root
 * cause never storms the human, and surfacing is rate-limited — critical-path escalations
 * first, the rest QUEUED, never dropped.
 *
 * NB the §3.4 #7 sketch's `scheduler.ts` (eligibleNodes/quarantine) maps to the BUILT
 * scheduler: `sched/loop.nextDispatch` is eligibility, `applyOutcome(BLOCK)` +
 * `deferral_track` is quarantine — deliberately not re-implemented here (no divergent
 * duplication). Of the §3.4 #6 quarantine.json fields, `refinement_cycles` lives in the
 * loop's `state.cycle`; `re_eligible_when` is DELIBERATELY absent — a quarantined node
 * has no auto-re-eligibility clock, it re-enters only through a human decision
 * (RESEED_GENERATOR / MANUAL_SEAM / re-entry), the stricter reading of L7.
 *
 * Pure copy-on-write over the escalations register (§3.4 #6 `escalations.json` shape);
 * timestamps are injected by the shell.
 */
import { createHash } from "node:crypto";

export const ESCALATION_KINDS = Object.freeze([
  "BREAK_CYCLE",
  "AUTH_EQUIVALENCE",
  "NO_RELEASED_SUCCESSOR",
  "OSCILLATION",
  "REPLAN_WAVE_MOVE",
  "RISK_LEVEL_REVIEW",
  "PARITY_REVIEW",
  "DISPOSITION_REVIEW", // plan-time disposition gate (B3, S2) — one per prompted node
]);

const KIND_SET = new Set(ESCALATION_KINDS);

/**
 * @param {{escalations: object[]}} register
 * @param {{kind: string, node_ids: string[], root_signature?: string, seam_candidates?: object[], confidence?: number}} e
 * @param {{ts: string}} meta
 * @returns {{escalations: object[]}} new register (idempotent while an identical escalation is OPEN)
 */
export function raiseEscalation(register, e, { ts }) {
  if (!KIND_SET.has(e.kind)) throw new Error(`escalation: unknown kind '${e.kind}' — the §3.4 taxonomy is closed`);
  if (!Array.isArray(e.node_ids) || e.node_ids.length === 0) throw new Error("escalation: node_ids must be non-empty");
  const node_ids = [...new Set(e.node_ids)].sort();
  const id = `esc-${createHash("sha256").update(JSON.stringify([e.kind, node_ids])).digest("hex").slice(0, 12)}`;
  if (register.escalations.some((x) => x.id === id && x.status === "OPEN")) return register; // no storm
  const row = {
    id,
    kind: e.kind,
    node_ids,
    ...(e.root_signature !== undefined ? { root_signature: e.root_signature } : {}),
    ...(e.seam_candidates !== undefined ? { seam_candidates: e.seam_candidates } : {}),
    ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
    status: "OPEN",
    opened_at: ts,
  };
  return { ...register, escalations: [...register.escalations, row] };
}

/**
 * Mark an OPEN escalation resolved (audited). Fails closed on unknown/already-resolved.
 * `run_id` + `decided_generations` (sig → the node's artifact generation at decide time)
 * TEMPORALLY BIND the decision to the artifact the human actually saw — the verdict join
 * requires both to match, so a regenerated artifact (retry OR re-entry re-walk) or another
 * run can never inherit an attestation, and a pre-artifact decision (generation 0) never
 * blesses generation ≥ 1.
 */
export function resolveEscalation(register, id, { resolved_by, ts, decision, run_id, decided_generations, decided_epoch }) {
  const idx = register.escalations.findIndex((x) => x.id === id && x.status === "OPEN");
  if (idx < 0) throw new Error(`escalation: '${id}' is unknown or already resolved`);
  const escalations = register.escalations.map((x, i) =>
    i === idx
      ? {
          ...x,
          status: "RESOLVED",
          resolved_by,
          resolved_at: ts,
          ...(decision !== undefined ? { decision } : {}),
          ...(run_id !== undefined ? { run_id } : {}),
          ...(decided_generations !== undefined ? { decided_generations } : {}),
          ...(decided_epoch !== undefined ? { decided_epoch } : {}),
        }
      : x,
  );
  return { ...register, escalations };
}

/**
 * Rate-limited surfacing (§3.4 #3): at most `max` OPEN escalations reach the human this
 * window — critical-path ones (any node in `criticalSigs`) first, then by opened_at + id;
 * the rest are returned as `queued`, never dropped.
 * @param {{escalations: object[]}} register
 * @param {{max: number, criticalSigs?: Set<string>}} opts
 * @returns {{surfaced: object[], queued: object[]}}
 */
export function surfaceable(register, { max, criticalSigs = new Set() }) {
  if (!Number.isInteger(max) || max < 0) {
    throw new Error(`escalation: max must be a non-negative integer (got ${max}) — an unguarded slice would invert the rate limit`);
  }
  const open = register.escalations
    .filter((x) => x.status === "OPEN")
    .map((x) => ({ e: x, critical: x.node_ids.some((n) => criticalSigs.has(n)) }))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || cmp(a.e.opened_at, b.e.opened_at) || cmp(a.e.id, b.e.id));
  return { surfaced: open.slice(0, max).map((x) => x.e), queued: open.slice(max).map((x) => x.e) };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
