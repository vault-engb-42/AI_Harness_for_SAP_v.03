import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The clean-core ORACLE (arch spec §2 / §15.1) — the single, standalone,
 * conservative lower-bound classifier shared by analyser, greenfield, moderniser
 * and planner. It maps SAP's two published registries onto the A/B/C/D level
 * spine. It is NOT ground truth; the live ATC is authoritative (§8).
 *
 * Registries (bundled, Apache-2.0; content-SHA recorded in data/registry-provenance.json,
 * exposed via provenance.js — O4):
 *   - objectReleaseInfoLatest.json   -> released | deprecated | notToBeReleased
 *   - objectClassifications_SAP.json -> classicAPI | noAPI
 *
 * BLIND SPOT (O3, arch spec §15.1 / C5): a single A/B/C/D level collapses THREE
 * orthogonal SAP axes — release STATE (released/deprecated/notToBeReleased),
 * release CONTRACT (C0 Extend / C1 Use-internally / C2 Remote-API / C3 config /
 * C4 AMDP), and clean-core LEVEL. The bundled registries carry the STATE but NO
 * contract/visibility field, so a "released" row can over-grant Level A to an
 * object released only under C2/C3/C4 (e.g. remote-API-only, not on-stack-usable).
 * The oracle is therefore a deliberately CONSERVATIVE lower bound, explicitly
 * SUBORDINATE to the live ATC variant ABAP_CLOUD_READINESS, which is the
 * contract-aware reconciler (§8). Never read a Level-A verdict here as a contract
 * guarantee — ground the specific usage (extend vs consume vs expose) against ATC.
 *
 * classifyName is a TOTAL function (conv #3). The registries are NOT
 * one-state-per-object and their vocabularies are DISJOINT (release-info =
 * released|deprecated|notToBeReleased; classifications = classicAPI|noAPI), so
 * every cross-registry object "conflicts". Resolution (operator policy 2026-07-09,
 * "release-info wins"): the AUTHORITATIVE objectReleaseInfo file wins — its states
 * are used whenever present; the classifications file is a fallback used only when
 * release-info has no row for the object. WEAKEST-wins (lowest level by D<C<B<A)
 * still applies WITHIN the winning source, for intra-file conflicts. This stops the
 * classic-API list from demoting a released foundational API (e.g. CX_STATIC_CHECK,
 * CL_ABAP_CHAR_UTILITIES) to classicAPI. Lazy-loaded once; fail-open.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

const SOURCES = [
  { file: "objectReleaseInfoLatest.json", key: "objectReleaseInfo", authoritative: true },
  { file: "objectClassifications_SAP.json", key: "objectClassifications", authoritative: false },
];

/** registry state -> clean-core level. */
const STATE_LEVEL = {
  released: "A",
  classicAPI: "B",
  deprecated: "C",
  notToBeReleased: "D",
  noAPI: "D",
};

/** weakness rank: lower = weaker. Weakest-wins = min rank (conv #3). */
const LEVEL_RANK = { D: 0, C: 1, B: 2, A: 3 };
/** level -> per-finding grade (null for A: a clean object has no finding grade). */
const LEVEL_GRADE = { A: null, B: "advisory", C: "warning", D: "blocker" };
/** level -> ATC priority. */
const LEVEL_PRIORITY = { A: "none", B: "P3", C: "P2", D: "P1" };

/** O5: a STATE-derived lifecycle warning, distinct from the clean-core LEVEL judgement,
 * so a consumer reads `deprecated -> C` as "released but scheduled for removal" rather
 * than as a structural clean-core defect. Released (level A) carries no warning. */
const STATE_WARNING = {
  classicAPI: "classic API: usable on S/4 on-prem, NOT released for ABAP Cloud",
  deprecated: "deprecated: released but scheduled for removal — migrate to the successor",
  notToBeReleased: "not released for ABAP Cloud / on-stack use",
  noAPI: "no released API — not intended for direct use",
};

/** @type {{full: Map<string, OracleRec>, byName: Map<string, OracleRec>}|null}
 * @typedef {{authStates: Set<string>, fallbackStates: Set<string>, successors: Array<{name: string, type: string}>, mapping_kind: string|null, successor_concept: string|null}} OracleRec */
let _index = null;

function loadIndex() {
  if (_index) return _index;
  const full = new Map();
  const byName = new Map();
  for (const src of SOURCES) ingest(full, byName, src);
  _index = { full, byName };
  return _index;
}

/** @param {Map} full @param {Map} byName @param {{file: string, key: string}} src */
function ingest(full, byName, src) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(join(DATA_DIR, src.file), "utf8"))[src.key] ?? [];
  } catch {
    return; // fail-open
  }
  for (const e of entries) {
    const name = String(e.tadirObjName ?? "").toUpperCase();
    const type = String(e.tadirObject ?? e.objectType ?? "").toUpperCase();
    const state = String(e.state ?? "");
    if (!name || !state) continue;
    const successors = Array.isArray(e.successors)
      ? e.successors
          .map((s) => ({ name: String(s.tadirObjName ?? "").toUpperCase(), type: String(s.objectType ?? s.tadirObject ?? "") }))
          .filter((s) => s.name)
      : [];
    // O2: the mapping kind (oneObject | multipleObjects | concept) and — for the
    // concept case, which carries no discrete successor — the concept name.
    const mappingKind = String(e.successorClassification ?? "");
    const conceptName = String(e.successorConceptName ?? "");
    const succ = { successors, mappingKind, conceptName };
    addEntry(full, `${type}|${name}`, state, succ, src.authoritative);
    addEntry(byName, name, state, succ, src.authoritative);
  }
}

/** Accumulate a state (and the successor block) into an index bucket, kept per source
 * so the authoritative release-info can win over the classifications fallback. The
 * successor block (successors + mapping_kind + concept) is captured once, from the
 * first row carrying any successor signal — release-info is ingested first, so its
 * richer data (with successorClassification) wins over the classifications fallback.
 * @param {Map} map @param {string} key @param {string} state
 * @param {{successors: Array, mappingKind: string, conceptName: string}} succ @param {boolean} authoritative */
function addEntry(map, key, state, succ, authoritative) {
  let rec = map.get(key);
  if (!rec) {
    rec = { authStates: new Set(), fallbackStates: new Set(), successors: [], mapping_kind: null, successor_concept: null };
    map.set(key, rec);
  }
  (authoritative ? rec.authStates : rec.fallbackStates).add(state);
  const captured = rec.successors.length || rec.mapping_kind || rec.successor_concept;
  if (!captured && (succ.successors.length || succ.mappingKind || succ.conceptName)) {
    rec.successors = succ.successors;
    rec.mapping_kind = succ.mappingKind || null;
    rec.successor_concept = succ.conceptName || null;
  }
}

/** Weakest level across a set of raw states (conv #3). Unknown states are ignored. */
function weakestLevel(states) {
  let best = null;
  for (const s of states) {
    const lvl = STATE_LEVEL[s];
    if (lvl === undefined) continue;
    if (best === null || LEVEL_RANK[lvl] < LEVEL_RANK[best]) best = lvl;
  }
  return best; // null if no recognized state
}

/** The raw state that produced the weakest level; ties broken lexicographically (determinism). */
function winningState(states, level) {
  const at = [...states].filter((s) => STATE_LEVEL[s] === level).sort();
  return at[0];
}

/**
 * Classify an SAP object name to its clean-core level (§15.1). Total function.
 *
 * C5: the returned `state` is release STATE, NOT release CONTRACT — the registry carries no
 * C0 (Extend) / C1 (Use System-Internally) / C2 (Use as Remote API) / C3 / C4 field, so a Level-A
 * result is a conservative LOWER BOUND, not a guarantee the object is released for the usage kind
 * the caller intends. Ground the specific usage (extend vs on-stack vs remote) against live ATC
 * (variant ABAP_CLOUD_READINESS), which is the contract-aware reconciler (§8).
 * @param {string|null|undefined} name
 * @param {string} [tadirType] optional TADIR object type; when omitted, a
 *   name-ambiguous object resolves to the weakest across ALL rows carrying the name.
 * @returns {{level: 'A'|'B'|'C'|'D'|'unknown', state: string|null, grade: string|null, atc_priority: string, state_warning: string|null, successors: Array<{name: string, type: string}>, mapping_kind: string|null, successor_concept: string|null}}
 */
export function classifyName(name, tadirType) {
  const norm = String(name ?? "").toUpperCase();
  const unknown = { level: "unknown", state: null, grade: "needs_review", atc_priority: "none", state_warning: null, successors: [], mapping_kind: null, successor_concept: null };
  if (!norm) return unknown;
  const { full, byName } = loadIndex();
  const rec = tadirType ? full.get(`${String(tadirType).toUpperCase()}|${norm}`) : byName.get(norm);
  if (!rec) return unknown;
  // Release-info WINS: use the authoritative release-info states when present, else
  // fall back to the classifications file. Weakest-wins applies within the source.
  const states = rec.authStates.size ? rec.authStates : rec.fallbackStates;
  if (states.size === 0) return unknown;
  const level = weakestLevel(states);
  if (level === null) return unknown;
  const state = winningState(states, level);
  return {
    level,
    state,
    grade: LEVEL_GRADE[level],
    atc_priority: LEVEL_PRIORITY[level],
    state_warning: STATE_WARNING[state] ?? null, // O5: lifecycle warning, distinct from the level
    successors: rec.successors.map((s) => ({ name: s.name, type: s.type })), // O1: full 1:many list
    mapping_kind: rec.mapping_kind ?? null, // O2
    successor_concept: rec.successor_concept ?? null, // O2
  };
}

/**
 * Grade an SQL/RPC access to an object (§2 read/write split, §15.1). Released
 * objects carry no access penalty; a non-released access is graded C/P2 for a
 * read and D/P1 for a write (a write to non-released is the most conservative).
 * @param {string} name
 * @param {'read'|'write'} accessKind
 * @param {string} [tadirType]
 * @returns {{level: string, atc_priority: string}}
 */
export function gradeUsage(name, accessKind, tadirType) {
  const c = classifyName(name, tadirType);
  if (c.level === "A") return { level: "A", atc_priority: "none" };
  return accessKind === "write"
    ? { level: "D", atc_priority: "P1" }
    : { level: "C", atc_priority: "P2" };
}

/**
 * Registry successors for a deprecated/removed object (§15.1). Returns ALL successors
 * (O1 — a deprecated object may have >1; the consumer presents all, the human picks),
 * the mapping kind (O2 — `successorClassification`: oneObject | multipleObjects | concept,
 * ingested straight from the shipped release-info registry), and, for the `concept`
 * case (which carries no discrete successor), the `successorConceptName`. `successor` /
 * `successor_kind` are the primary (first) successor for convenience. Null only when the
 * object carries no successor signal at all.
 *
 * C5: like classifyName, the successor's release STATE is not its release CONTRACT (C0-C4) — the
 * value is a lower bound, and the successor's fitness for a given usage kind must be confirmed
 * against live ATC, not inferred from the registry alone.
 * @param {string} name
 * @param {string} [tadirType]
 * @returns {{successor: string|null, successor_kind: string|null, successors: Array<{name: string, type: string}>, mapping_kind: string|null, successor_concept: string|null}|null}
 */
export function successorOf(name, tadirType) {
  const norm = String(name ?? "").toUpperCase();
  if (!norm) return null;
  const { full, byName } = loadIndex();
  const rec = tadirType ? full.get(`${String(tadirType).toUpperCase()}|${norm}`) : byName.get(norm);
  if (!rec) return null;
  const successors = rec.successors ?? [];
  const primary = successors[0];
  if (!primary && !rec.mapping_kind && !rec.successor_concept) return null;
  return {
    successor: primary?.name ?? null,
    successor_kind: primary?.type ?? null,
    successors: successors.map((s) => ({ name: s.name, type: s.type })),
    mapping_kind: rec.mapping_kind ?? null,
    successor_concept: rec.successor_concept ?? null,
  };
}

/**
 * Clean-core debt score (§2/§12 — Clean Core Extensibility guide, Project
 * Kernseife weighting): 10·P1 + 5·P2 + 1·P3.
 * @param {{p1?: number, p2?: number, p3?: number}} [counts]
 * @returns {number}
 */
export function debtScore(counts = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return 10 * n(counts.p1) + 5 * n(counts.p2) + 1 * n(counts.p3);
}

/**
 * Remediation fixture for a rule (§15.1). The net-new curated bad->good fixtures
 * (§2) are not bundled yet, so this is null for every rule until that SHA-pinned
 * data file lands — total by construction.
 * @param {string} _ruleId
 * @returns {null}
 */
export function fixtureFor(_ruleId) {
  return null;
}

/** Test seam: drop the lazy cache so a fresh load can be forced. */
export function _resetCache() {
  _index = null;
}
