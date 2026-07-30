/**
 * The Architecture Contract builder + run-state binding (BUILD_PLAN S6/S12 / MODERNISER_DESIGN §6.13).
 *
 * `buildArchContract(node, recommendation, corpus)` freezes a reasoned re-architecture into the COARSE
 * contract the CONFORMANCE gate (sched/conformance.js) later checks `output ⊨ contract` against: the
 * target_shape, one contract object per pattern component, and the invariants that shape must preserve.
 * It is COARSE by design — the field-level `spec` (keys/fields/associations) and the real `grounded_apis`
 * are filled by the PLANNER design pass before ratify. The corpus build patterns expose `grounding_refs`
 * (empty for a bespoke build), NOT `grounded_apis`, and the recommendation carries neither, so
 * `grounded_apis` seeds from `pattern.grounding_refs` with `grounded_at: null` (reviewer F5).
 *
 * `contract_hash = sha256(canonicalJSON(contract without contract_hash))` — the same content-hash method
 * as plan_hash; it is what the ARCH_REVIEW gate ratifies and what `loadContract` verifies fail-closed.
 *
 * The run-state binding (`bindArchContract` / `isArchRatified`) records the ratified contract per node sig
 * in `state.arch_contracts` — RUN STATE, never the frozen plan node, so `plan_hash` stays {nodes,waves}
 * (S6). Pure: no I/O, copy-on-write. The durable read/save + the file-hydrating `loadContract` are the
 * imperative CLI's job (cli-drive).
 */
import { createHash } from "node:crypto";
import { canonicalJSON } from "../state/canonical-json.js";
import { loadPatternCorpus } from "./patterns/match.js";

/** The content hash of a contract, EXCLUDING its own `contract_hash` field (self-excluding, deterministic). */
export function contractHash(contract) {
  const { contract_hash, ...rest } = contract ?? {};
  return createHash("sha256").update(canonicalJSON(rest)).digest("hex");
}

/**
 * Build the COARSE Architecture Contract for one reasoned node.
 * @param {{id: string, object: string, disposition: string}} node the frozen plan node
 * @param {{target_shape: string}} recommendation the arch-reason / judge recommendation (target_shape only)
 * @param {{patterns: Array<object>}} [corpus] the target-shape patterns corpus (injectable for tests)
 * @returns {object} the contract, carrying a self-excluding `contract_hash`
 */
export function buildArchContract(node, recommendation, corpus = loadPatternCorpus()) {
  const shape = recommendation?.target_shape;
  const pattern = (corpus?.patterns ?? []).find((p) => p.id === shape);
  if (!pattern) {
    throw new Error(`buildArchContract: target_shape '${shape}' is not in the patterns corpus (closed vocabulary)`);
  }
  const groundedApis = [...(pattern.grounding_refs ?? [])]; // build patterns → [] (planner + oracle fill it)
  const objects = (pattern.components ?? []).map((comp) => ({
    id: `${node.object}.${comp}`,
    kind: comp,
    generates: comp,
    spec: null, // the field-level spec is filled by the planner design pass before ratify
    grounded_apis: [...groundedApis],
    invariants_required: [...(pattern.invariants ?? [])],
    depends_on: [],
  }));
  const base = {
    node_sig: node.id,
    disposition: node.disposition,
    target: shape,
    grounded_at: null,
    objects,
    object_dag: [],
    acceptance: [],
    dropped: [],
  };
  return { ...base, contract_hash: contractHash(base) };
}

/**
 * Bind a reviewed / ratified contract to a node sig in RUN STATE (copy-on-write). arch_contracts is run
 * state, not the frozen node — `plan_hash` is unaffected (S6).
 * @param {object} state the SchedulerState
 * @param {string} sig the node sig
 * @param {{ref: string, hash: string, ratified_by?: string|null, reviewer_verdict?: object|null}} binding
 * @returns {object} the next state
 */
export function bindArchContract(state, sig, { ref, hash, ratified_by = null, reviewer_verdict = null }) {
  return {
    ...state,
    arch_contracts: {
      ...(state?.arch_contracts ?? {}),
      [sig]: { ref, hash, ratified_by, reviewer_verdict },
    },
  };
}

/** A node is arch-ratified iff a contract is bound AND a human ratified it (the fail-closed drive precondition). */
export function isArchRatified(state, sig) {
  const c = state?.arch_contracts?.[sig];
  return !!(c && c.hash && c.ratified_by);
}
