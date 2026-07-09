import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The clean-core ORACLE (arch spec §2 / §15.1) — the single, standalone,
 * conservative lower-bound classifier shared by analyser, greenfield, moderniser
 * and planner. It maps SAP's two published registries onto the A/B/C/D level
 * spine. It is NOT ground truth; the live ATC is authoritative (§8).
 *
 * Registries (bundled, Apache-2.0, SHA-pinned in data/):
 *   - objectReleaseInfoLatest.json   -> released | deprecated | notToBeReleased
 *   - objectClassifications_SAP.json -> classicAPI | noAPI
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

/** @type {{full: Map<string, {states: Set<string>, successors: Array<{name: string, type: string}>}>, byName: Map<string, {states: Set<string>, successors: Array<{name: string, type: string}>}>}|null} */
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
    addEntry(full, `${type}|${name}`, state, successors, src.authoritative);
    addEntry(byName, name, state, successors, src.authoritative);
  }
}

/** Accumulate a state (and successors) into an index bucket, kept per source so the
 * authoritative release-info can win over the classifications fallback. */
function addEntry(map, key, state, successors, authoritative) {
  let rec = map.get(key);
  if (!rec) {
    rec = { authStates: new Set(), fallbackStates: new Set(), successors: [] };
    map.set(key, rec);
  }
  (authoritative ? rec.authStates : rec.fallbackStates).add(state);
  if (rec.successors.length === 0 && successors.length) rec.successors = successors;
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
 * @param {string|null|undefined} name
 * @param {string} [tadirType] optional TADIR object type; when omitted, a
 *   name-ambiguous object resolves to the weakest across ALL rows carrying the name.
 * @returns {{level: 'A'|'B'|'C'|'D'|'unknown', state: string|null, grade: string|null, atc_priority: string, successor: string|null}}
 */
export function classifyName(name, tadirType) {
  const norm = String(name ?? "").toUpperCase();
  const unknown = { level: "unknown", state: null, grade: "needs_review", atc_priority: "none", successor: null };
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
  return {
    level,
    state: winningState(states, level),
    grade: LEVEL_GRADE[level],
    atc_priority: LEVEL_PRIORITY[level],
    successor: rec.successors[0]?.name ?? null,
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
 * First registry successor for a deprecated/removed object (§15.1). `mapping_kind`
 * stays null until the net-new CURATED successor registry (§2) is bundled — the
 * shipped registries carry the successor name + TADIR type, not the mapping kind.
 * @param {string} name
 * @param {string} [tadirType]
 * @returns {{successor: string, successor_kind: string, mapping_kind: string|null}|null}
 */
export function successorOf(name, tadirType) {
  const norm = String(name ?? "").toUpperCase();
  if (!norm) return null;
  const { full, byName } = loadIndex();
  const rec = tadirType ? full.get(`${String(tadirType).toUpperCase()}|${norm}`) : byName.get(norm);
  const s = rec?.successors[0];
  if (!s) return null;
  return { successor: s.name, successor_kind: s.type, mapping_kind: null };
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
