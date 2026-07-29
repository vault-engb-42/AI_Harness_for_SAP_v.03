import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "../state/canonical-json.js";

/**
 * Immutable plan artifact + content hash + REPLAN diff + persistence
 * (MODERNISER_DESIGN §3.1, §3.3, §6.3, L6.3). At run start the condensed DAG + wave
 * assignment are frozen into a content-hashed `plan.json`; the hash covers a
 * canonicalised node set + waves, so an equivalent plan produced in any discovery
 * order — or with a node's set-like fields in any order — hashes identically. The
 * artifact is deep-frozen and holds independent (deep-cloned) copies, so a later
 * mutation of the caller's inputs can never desync `plan_hash`. Node ids are canonical
 * signatures (see `node-id.js`), never positional indices.
 */

export const PLAN_SCHEMA_VERSION = "1.4.0";

/**
 * Freeze a plan into the immutable, content-hashed, deep-frozen artifact.
 * @param {{nodes: Array<{id: string, wave: number}>, session_budget?: number|null, generator_team_size?: number|null, edges_ref?: unknown[], edges_conflict?: unknown[], seams?: unknown[], park_register?: unknown[]}} input
 * @returns {object} the frozen PlanArtifact
 */
export function freezePlan(input) {
  const nodes = canonicalNodes(input.nodes);
  const waves = deriveWaves(nodes);
  return deepFreeze({
    schema_version: PLAN_SCHEMA_VERSION,
    plan_hash: hashPlan(nodes, waves),
    session_budget: input.session_budget ?? null,
    generator_team_size: input.generator_team_size ?? null,
    nodes,
    waves,
    edges_ref: structuredClone(input.edges_ref ?? []),
    edges_conflict: structuredClone(input.edges_conflict ?? []),
    seams: structuredClone(input.seams ?? []),
    park_register: structuredClone(input.park_register ?? []),
  });
}

/**
 * The content hash of a node set (§6.3) — equals `freezePlan({nodes}).plan_hash` for
 * the same nodes. Exposed so callers can re-hash without re-freezing.
 * @param {Array<{id: string, wave: number}>} nodes
 * @returns {string} 64-char sha256 hex
 */
export function planHash(nodes) {
  const c = canonicalNodes(nodes);
  return hashPlan(c, deriveWaves(c));
}

/**
 * REPLAN diff (§6.3, resolves audit-open #6). A REPLAN gate (human sign-off) is
 * required when a COMMITTED node (`isCommitted(id)` — status ∈ {GATED, GREEN, PARK})
 * either has a different wave in `next` vs `prev` OR is dropped entirely (discarding
 * gated work). New nodes and non-committed wave shifts are silent re-parses.
 * @param {{nodes: Array<{id: string, wave: number}>}} prev
 * @param {{nodes: Array<{id: string, wave: number}>}} next
 * @param {(id: string) => boolean} isCommitted predicate over the CURRENT node-state
 * @returns {{replan_required: boolean, moved_committed: string[], removed_committed: string[], added: string[], removed: string[]}}
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
  const removed_committed = removed.filter((id) => isCommitted(id));
  return {
    replan_required: moved_committed.length > 0 || removed_committed.length > 0,
    moved_committed: moved_committed.sort(),
    removed_committed,
    added,
    removed,
  };
}

/**
 * Persist a frozen plan durably (write-temp + fsync + atomic-rename) under the state dir
 * (§6.5, §3.3 "commit = fsync → atomic-rename → git add"). The git-add of the explicit
 * path is the SHELL's step — this library never runs VCS commands. NB `plan_hash` covers
 * {nodes, waves} only (§6.3): the resource knobs (`session_budget`, `generator_team_size`)
 * are deliberately outside the hash — they tune parallelism, never ordering or independence
 * (the frontier re-enforces both-graph independence live).
 * @param {string} runId
 * @param {object} plan a `freezePlan()` artifact
 * @param {string} [stateDir]
 * @returns {string} the path written
 */
export function savePlan(runId, plan, stateDir = ".claude/state") {
  const dir = join(stateDir, "plan");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.plan.json`);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(plan, null, 2));
    fsyncSync(fd); // durable before the swap — a crash can never leave a torn plan
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path); // atomic swap on the same filesystem
  return path;
}

/**
 * Read a persisted plan and fail closed (§3.3): reject an unknown `schema_version`
 * major, then re-hash the nodes/waves and reject a `plan_hash` mismatch (corruption
 * or tamper). A resume can only proceed on a verified plan.
 * @param {string} runId
 * @param {string} [stateDir]
 * @returns {object} the verified PlanArtifact
 */
export function loadPlan(runId, stateDir = ".claude/state") {
  const path = join(stateDir, "plan", `${runId}.plan.json`);
  const plan = JSON.parse(readFileSync(path, "utf8"));
  const major = String(plan.schema_version ?? "").split(".")[0];
  if (major !== PLAN_SCHEMA_VERSION.split(".")[0]) {
    throw new Error(`loadPlan: unknown plan schema_version major '${plan.schema_version}' (built for ${PLAN_SCHEMA_VERSION})`);
  }
  // hash with the STORED waves as input (L7 review): re-deriving waves from the nodes let a
  // tampered stored `waves` array load as verified — feeding the stored value makes any
  // waves tamper a hash mismatch (a legit file's waves ARE the derived ones, so it matches).
  if (plan.plan_hash !== hashPlan(canonicalNodes(plan.nodes), plan.waves)) {
    throw new Error(`loadPlan: plan_hash mismatch for run '${runId}' — corrupt or tampered plan`);
  }
  return plan;
}

function hashPlan(nodes, waves) {
  return createHash("sha256").update(canonicalJSON({ nodes, waves })).digest("hex");
}

/**
 * Validate + deep-clone + canonicalise the node set: every node needs a non-empty
 * string `id` and a non-negative integer `wave` (fail-closed, matching node-id's
 * rigor); set-like fields (`dependencies`) are sorted so their order never leaks into
 * the hash; the array is ordered by `id` so discovery order never leaks in.
 * @param {Array<{id: string, wave: number}>} nodes
 * @returns {object[]}
 */
function canonicalNodes(nodes) {
  return (nodes ?? [])
    .map((n) => {
      if (typeof n?.id !== "string" || n.id.length === 0) {
        throw new Error("plan: every node needs a non-empty string id");
      }
      if (!Number.isInteger(n.wave) || n.wave < 0) {
        throw new Error(`plan: node '${n.id}' needs a non-negative integer wave (got ${n.wave})`);
      }
      const c = structuredClone(n);
      // set-like: dedupe + sort — a duplicate dependency would desync the loop's counter
      // (init counts entries; a GREEN decrements once per dependency) and leak into the hash.
      if (Array.isArray(c.dependencies)) c.dependencies = [...new Set(c.dependencies)].sort();
      return c;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n, i, arr) => {
      // duplicate ids collapse to ONE status/indegree entry in initRun while the frontier
      // emits the sig once per node — a batch violating its own independence contract (L8)
      if (i > 0 && arr[i - 1].id === n.id) throw new Error(`plan: duplicate node id '${n.id}'`);
      return n;
    });
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

/** Recursively freeze so the returned artifact is immutable per run (§3.3). */
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
