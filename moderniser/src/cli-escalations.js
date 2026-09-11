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
import { recordDispositionDecision, raiseDispositionReviews, droppedDependencies, raiseDroppedDependencies } from "./plan/disposition-gate.js";
import { recordArchDecision, parseArchDecision, recordNoTargetShapeDecision } from "./plan/arch-gate.js";
import { bindArchContract, isArchRatified, ARCH_GATED_DISPOSITIONS } from "./plan/arch-contract.js";
import { assertReviewed } from "./cli-arch-review.js";
import { buildDispositionManifest } from "./plan/manifest.js";
import { readFileSync } from "node:fs";
import { consumptionFacts } from "./plan/consumption-facts.js";
import { persistenceFacts } from "./plan/persistence-facts.js";
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
  const ts = new Date().toISOString();
  // §7.4: raised HERE rather than in `replan` so it covers every producer of a `retire` node, not just the
  // operator override that produces them today. A dropped object whose dependents are still being built is
  // a consequence the human must see while the plan gate is still open.
  const dropped = droppedDependencies(plan);
  const reg = raiseDroppedDependencies(raiseDispositionReviews(readEscalations(io), manifest, { ts }), plan, { ts });
  saveEscalations(io, reg);
  log(io, runId, "disposition", { rows: manifest.rows.length, prompt: manifest.summary.prompt_count, auto: manifest.summary.auto_count, dropped_dependencies: dropped.length });
  return { run_id: runId, summary: manifest.summary, dropped_dependencies: dropped };
}

export function cmdEscalations(io, pos, flags) {
  const [runId] = pos;
  const { plan, state } = loadRun(io, runId);
  const { surfaced, queued } = surfaceForRun(io, plan, state, flags);
  return { surfaced, queued };
}

/**
 * The surfacing window for ONE run (GAP 6). Two defects, both measured on a real talv run against the
 * shared register: 89 OPEN escalations of which only 60 belonged to the run the operator asked about, and a
 * default window of 5 that was entirely routine prompts while 18 blocking gates sat unseen at positions
 * 62-89.
 *
 * SCOPED. `escalations.json` is a SHARED cross-run register and `surfaceable` never consulted a run —
 * `run_id` is stamped by `resolveEscalation` at decide time and never read back here. So the window could
 * show gates for objects that are not in this plan at all. `collectOverrides` is run-scoped for exactly
 * this reason; the surfacing read simply never got the same treatment. An escalation belongs to this run
 * if it names at least one of its plan nodes.
 *
 * ORDERED BY WHAT IS STUCK. Gate 1 runs before gate 2, so DISPOSITION_REVIEW rows always hold the earliest
 * `opened_at` and always won the window: recency is not urgency. `criticalSigs` already existed on
 * `surfaceable` and was reachable only from a manual `--critical` flag that nothing ever computed. It is
 * now computed from the DRIVER'S OWN blocking predicate — a node is stuck when it is arch-gated and not
 * ratified, which is precisely what makes `drive` return await_human — so the window leads with the gates
 * that are actually holding the run up. An explicit `--critical` still wins, for an operator who knows
 * better than the predicate.
 */
function surfaceForRun(io, plan, state, flags) {
  const max = flags.max === undefined ? DEFAULT_SURFACE_MAX : Number(flags.max);
  const mine = new Set(plan.nodes.map((n) => n.id));
  const register = readEscalations(io);
  const scoped = { ...register, escalations: register.escalations.filter((e) => (e.node_ids ?? []).some((n) => mine.has(n))) };

  const explicit = String(flags.critical ?? "").split(",").filter(Boolean);
  const criticalSigs = explicit.length
    ? new Set(explicit)
    : new Set(plan.nodes.filter((n) => ARCH_GATED_DISPOSITIONS.has(n.disposition) && !isArchRatified(state, n.id)).map((n) => n.id));

  // The kinds that actually hold a run up. `drive` returns await_human for an arch-gated node without a
  // ratified contract; ARCH_REVIEW and NO_TARGET_SHAPE are the two gates that clear that state. A
  // DISPOSITION_REVIEW never makes the driver stop — approving one changes nothing until a `replan`.
  return surfaceable(scoped, { max, criticalSigs, criticalKinds: new Set(["NO_TARGET_SHAPE", "ARCH_REVIEW"]) });
}

/**
 * The §3.4 #8 GatePacket presentation, made executable (review F18): each SURFACED
 * escalation rendered with its kind, one-line cause, and TYPED decision set — the skill
 * presents these verbatim and never invents decision options.
 */
export function cmdPackets(io, pos, flags) {
  const [runId] = pos;
  const { plan, state } = loadRun(io, runId);
  const { surfaced, queued } = surfaceForRun(io, plan, state, flags);
  const context = packetContext(plan, pos[1] ?? flags.findings);
  return { packets: surfaced.map((e) => renderPacket(e, context(e))), queued: queued.length };
}

/**
 * The EVIDENCE a GatePacket carries, per escalation (GAP 2b).
 *
 * `renderPacket` has always accepted `evidence` and `plan_fields`; `cmdPackets` passed neither, so every
 * packet reached the operator as a 64-char sig, a one-line cause and a verb list. For NO_TARGET_SHAPE that
 * is close to unusable: to decide they had to map the sig to the architecture manifest, find the object,
 * and go read its ABAP — measured on talv, 70 of 92 re_architect nodes reach no shape, so 70 times.
 *
 * FACTS ONLY, deliberately. This names the object and states what was observed; it does NOT recommend a
 * disposition. A recommendation would anchor a human who would otherwise read the code, and this gate
 * exists precisely because the harness declines to choose. Same idiom as `no_successor_refs`, which the
 * classifier gathers as "evidence for a human decision, not the decision".
 *
 * Everything comes from the FROZEN PLAN, so it needs no extra input and cannot drift from what was
 * planned. The consumption/persistence axes — the ones every BO shape gates on, and therefore the ones
 * that explain an unplaceable node — live in the findings doc, so they are added only when a doc is
 * supplied (`packets <run> <findings>`), and reported as an explicit absence when it is not.
 */
export function packetContext(plan, findingsPath) {
  const bySig = new Map(plan.nodes.map((n) => [n.id, n]));
  let cons = null;
  let pers = null;
  if (findingsPath) {
    const doc = JSON.parse(readFileSync(findingsPath, "utf8"));
    cons = consumptionFacts(doc);
    pers = persistenceFacts(doc);
  }
  const factsFor = (node, map) => {
    if (!map) return null;
    const out = new Set();
    for (const m of node.members ?? [node.object]) for (const f of map[String(m)] ?? []) out.add(f);
    return [...out].sort();
  };
  return (e) => {
    const node = bySig.get(e.node_ids?.[0]);
    if (!node) return {};
    return {
      plan_fields: {
        object: node.object,
        object_kind: node.object_kind ?? null,
        members: node.members ?? [node.object],
        wave: node.wave,
        disposition: node.disposition,
        disposition_rationale: node.disposition_rationale ?? null,
        disposition_confidence: node.disposition_confidence ?? null,
        modernization_target: node.modernization_target ?? null,
      },
      evidence: {
        // An absent doc is reported as absent, never as an empty fact set — "no surface observed" and
        // "nobody looked" are different claims, and conflating them is how a gate lies quietly.
        consumption: factsFor(node, cons) ?? "(not computed — re-run with `packets <run> <findings>`)",
        persistence: factsFor(node, pers) ?? "(not computed — re-run with `packets <run> <findings>`)",
        // `driving_rule_ids` is deliberately NOT carried. On a real object it is ~23 entries of
        // formatting lint (indentation, keyword_case, abapdoc) that answer neither "what is this" nor
        // "why can it not be placed", and burying the three decisive facts under them makes the packet
        // worse than the bare sig it replaced. `finding_families` is their summarised form and IS carried.
        finding_families: node.finding_families ?? [],
        disposition_hints: node.disposition_hints ?? [],
        ...(node.disposition_evidence ?? {}),
      },
    };
  };
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
    // GAN separation (D): ratifying requires an INDEPENDENT review of the contract being ratified. Only
    // approve is gated — refine/reject ratify nothing, so they need no reviewer.
    if (parseArchDecision(decision).verb === "approve") assertReviewed(state, sig);
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
  } else if (target?.kind === "NO_TARGET_SHAPE") {
    // S14 unplaceable gate: also a plan-time decision, also parametrized, and also a DISPOSITION — the only
    // remedy for an object no shape fits is to re-disposition it, which `replan` reads back via
    // collectOverrides. `approve` is refused by the recorder; there is nothing here to approve.
    next = recordNoTargetShapeDecision(reg, id, decision, { decided_by: flags.by, ts, run_id: runId });
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
