import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyName } from "../../oracle/src/oracle.js";

// §3.F oracle-adoption: the ORACLE Level (weakest-wins over both registries) is
// the classification authority. release_state + effort_tier are derived from it,
// replacing s4-status.js normalizeS4Status/effortTierForStatus. This is an
// INTENDED migration — it changes s4_readiness_pct, node.effort_tier and the
// released-api finding set for the conflict objects (see the before/after fixture).
const RELEASE_STATE_FOR_LEVEL = { A: "released", B: "deprecated", C: "deprecated", D: "removed", unknown: "unknown" };
const TIER_FOR_LEVEL = { A: "keep-and-clean", B: "re-platform", C: "re-platform", D: "retire", unknown: "unknown" };

/**
 * Cloudification Registry adapter — O(1) S/4HANA readiness lookup over the
 * bundled TALOS dataset (the neutral top-level `data/`, Apache-2.0 — shared
 * reference material for the analyser and greenfield, owned by neither). Two
 * source files are merged into one name-keyed index:
 *   - objectReleaseInfoLatest.json  (authoritative release state; wins on conflict)
 *   - objectClassifications_SAP.json (classic-API classification; fills gaps)
 *
 * Lazy-loaded once. Fail-open: an unreadable/corrupt file degrades its entries
 * to absent (=> classify -> unknown), never throws mid-analysis.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

const SOURCES = [
  { file: "objectReleaseInfoLatest.json", key: "objectReleaseInfo", authoritative: true },
  { file: "objectClassifications_SAP.json", key: "objectClassifications", authoritative: false },
];

/** @type {Map<string, {objectType: string, state: string, successors: string[]}>|null} */
let _index = null;

/** @returns {Map<string, {objectType: string, state: string, successors: string[]}>} */
function loadIndex() {
  if (_index) return _index;
  const map = new Map();
  for (const src of SOURCES) ingest(map, src);
  _index = map;
  return map;
}

/**
 * @param {Map} map
 * @param {{file: string, key: string, authoritative: boolean}} src
 */
function ingest(map, src) {
  let entries;
  try {
    const raw = readFileSync(join(DATA_DIR, src.file), "utf8");
    entries = JSON.parse(raw)[src.key] ?? [];
  } catch {
    return; // fail-open
  }
  for (const e of entries) {
    const name = String(e.tadirObjName ?? "").toUpperCase();
    if (!name) continue;
    if (!src.authoritative && map.has(name)) continue; // release info wins
    // Keep both the successor's name and its TADIR type: consumers need the
    // name for suggestions and the type for blast_radius.successor_kind.
    const successors = Array.isArray(e.successors)
      ? e.successors
          .map((s) => ({ name: String(s.tadirObjName ?? "").toUpperCase(), type: String(s.objectType ?? s.tadirObject ?? "") }))
          .filter((s) => s.name)
      : [];
    map.set(name, { objectType: e.objectType, state: e.state, successors });
  }
}

/**
 * @param {string|null|undefined} name object name
 * @returns {{release_state: string, raw_state: string|undefined, successors: Array<{name: string, type: string}>, object_type: string|undefined}}
 */
export function classify(name) {
  const rec = loadIndex().get(String(name ?? "").toUpperCase());
  // §3.F: release_state from the oracle Level (weakest-wins), not the single
  // release-wins state; successors + object_type stay from the registry read.
  const release_state = RELEASE_STATE_FOR_LEVEL[classifyName(name).level];
  if (!rec) return { release_state, raw_state: undefined, successors: [], object_type: undefined };
  return {
    release_state,
    raw_state: rec.state,
    successors: rec.successors,
    object_type: rec.objectType,
  };
}

/** @param {string} name @returns {boolean} true only if classified released */
export function isReleased(name) {
  return classify(name).release_state === "released";
}

/** @param {string} name @returns {string|undefined} first released successor name */
export function getSuccessor(name) {
  return classify(name).successors[0]?.name;
}

/** @param {string} name @returns {string} schema effort_tier from the oracle Level (§3.F) */
export function effortTier(name) {
  return TIER_FOR_LEVEL[classifyName(name).level];
}

/** @returns {number} indexed object count (diagnostics) */
export function indexSize() {
  return loadIndex().size;
}

/** Test seam: drop the lazy cache so a fresh load can be forced. */
export function _resetCache() {
  _index = null;
}
