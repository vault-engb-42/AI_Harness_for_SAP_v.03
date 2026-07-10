import { createHash } from "node:crypto";
import { canonicalJSON } from "../state/canonical-json.js";

/**
 * Immutable plan artifact + content hash + REPLAN diff (MODERNISER_DESIGN §3.1, §6.3,
 * L6.3). At run start the condensed DAG + wave assignment are frozen into a
 * content-hashed `plan.json`; the hash covers nodes + waves via the canonical
 * sorted-key serializer, with nodes/waves normalised to a deterministic order first,
 * so an equivalent plan produced in any discovery order hashes identically. Node ids
 * are canonical signatures (see `node-id.js`), never positional indices.
 */

export const PLAN_SCHEMA_VERSION = "1.0.0";

/**
 * Freeze a plan into the immutable, content-hashed artifact.
 * @param {{nodes: Array<{id: string, wave: number}>, session_budget?: number|null, generator_team_size?: number|null, edges_ref?: unknown[], edges_conflict?: unknown[], seams?: unknown[], park_register?: unknown[]}} input
 * @returns {object} the frozen PlanArtifact
 */
export function freezePlan(input) {
  const nodes = sortById(input.nodes ?? []);
  const waves = deriveWaves(nodes);
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    plan_hash: hashPlan(nodes, waves),
    session_budget: input.session_budget ?? null,
    generator_team_size: input.generator_team_size ?? null,
    nodes,
    waves,
    edges_ref: input.edges_ref ?? [],
    edges_conflict: input.edges_conflict ?? [],
    seams: input.seams ?? [],
    park_register: input.park_register ?? [],
  };
}

/**
 * The content hash of a node set (§6.3) — matches `freezePlan(...).plan_hash` for the
 * same nodes. Exposed so callers can re-hash without re-freezing.
 * @param {Array<{id: string, wave: number}>} nodes
 * @returns {string} 64-char sha256 hex
 */
export function planHash(nodes) {
  const sorted = sortById(nodes ?? []);
  return hashPlan(sorted, deriveWaves(sorted));
}

/**
 * REPLAN diff (§6.3, resolves audit-open #6). A REPLAN gate (human sign-off) is
 * required **iff** a COMMITTED node (`isCommitted(id)` — status ∈ {GATED, GREEN, PARK})
 * has a different wave in `next` vs `prev`. New nodes, removed nodes, and non-committed
 * wave shifts are silent re-parses — no gate.
 * @param {{nodes: Array<{id: string, wave: number}>}} prev frozen PlanArtifact
 * @param {{nodes: Array<{id: string, wave: number}>}} next frozen PlanArtifact
 * @param {(id: string) => boolean} isCommitted predicate over the CURRENT node-state
 * @returns {{replan_required: boolean, moved_committed: string[], added: string[], removed: string[]}}
 */
export function replan(prev, next, isCommitted) {
  const p = waveByNodeId(prev);
  const q = waveByNodeId(next);
  const moved_committed = [];
  for (const [id, w] of p) {
    if (q.has(id) && q.get(id) !== w && isCommitted(id)) moved_committed.push(id);
  }
  const added = [...q.keys()].filter((id) => !p.has(id)).sort();
  const removed = [...p.keys()].filter((id) => !q.has(id)).sort();
  return {
    replan_required: moved_committed.length > 0,
    moved_committed: moved_committed.sort(),
    added,
    removed,
  };
}

function hashPlan(nodes, waves) {
  return createHash("sha256").update(canonicalJSON({ nodes, waves })).digest("hex");
}

/** Nodes ordered by canonical id — makes the hash independent of discovery order. */
function sortById(nodes) {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** waves[k] = the sorted node ids at the k-th distinct wave value (ascending). */
function deriveWaves(nodes) {
  const byWave = new Map();
  for (const n of nodes) {
    if (!byWave.has(n.wave)) byWave.set(n.wave, []);
    byWave.get(n.wave).push(n.id);
  }
  return [...byWave.keys()]
    .sort((a, b) => a - b)
    .map((w) => byWave.get(w).slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
}

/** Map node id -> its wave (read from the plan's authoritative node list). */
function waveByNodeId(plan) {
  const m = new Map();
  for (const n of plan?.nodes ?? []) m.set(n.id, n.wave);
  return m;
}
