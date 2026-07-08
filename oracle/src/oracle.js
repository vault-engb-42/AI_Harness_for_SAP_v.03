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
 * classifyName is a TOTAL function (conv #3): the registries are NOT
 * one-state-per-object (266 cross-registry + 12/47 intra-registry conflicts), so
 * a key resolving to multiple states takes the WEAKEST (lowest) level by the
 * total order D < C < B < A — deterministic worst-wins, the conservative proxy.
 * Lazy-loaded once; fail-open (an unreadable file degrades entries to absent).
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

const SOURCES = [
  { file: "objectReleaseInfoLatest.json", key: "objectReleaseInfo" },
  { file: "objectClassifications_SAP.json", key: "objectClassifications" },
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
    addEntry(full, `${type}|${name}`, state, successors);
    addEntry(byName, name, state, successors);
  }
}

/** Accumulate a state (and successors) into an index bucket. */
function addEntry(map, key, state, successors) {
  let rec = map.get(key);
  if (!rec) {
    rec = { states: new Set(), successors: [] };
    map.set(key, rec);
  }
  rec.states.add(state);
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
  if (!rec || rec.states.size === 0) return unknown;
  const level = weakestLevel(rec.states);
  if (level === null) return unknown;
  return {
    level,
    state: winningState(rec.states, level),
    grade: LEVEL_GRADE[level],
    atc_priority: LEVEL_PRIORITY[level],
    successor: rec.successors[0]?.name ?? null,
  };
}

/** Test seam: drop the lazy cache so a fresh load can be forced. */
export function _resetCache() {
  _index = null;
}
