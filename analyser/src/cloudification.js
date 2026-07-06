import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeS4Status, effortTierForStatus } from "./s4-status.js";

/**
 * Cloudification Registry adapter — O(1) S/4HANA readiness lookup over the
 * bundled TALOS dataset (analyser/data/, Apache-2.0). Two source files are
 * merged into one name-keyed index:
 *   - objectReleaseInfoLatest.json  (authoritative release state; wins on conflict)
 *   - objectClassifications_SAP.json (classic-API classification; fills gaps)
 *
 * Lazy-loaded once. Fail-open: an unreadable/corrupt file degrades its entries
 * to absent (=> classify -> unknown), never throws mid-analysis.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

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
  if (!rec) return { release_state: "unknown", raw_state: undefined, successors: [], object_type: undefined };
  return {
    release_state: normalizeS4Status(rec.state),
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

/** @param {string} name @returns {string} schema effort_tier for the object's state */
export function effortTier(name) {
  return effortTierForStatus(classify(name).raw_state);
}

/** @returns {number} indexed object count (diagnostics) */
export function indexSize() {
  return loadIndex().size;
}

/** Test seam: drop the lazy cache so a fresh load can be forced. */
export function _resetCache() {
  _index = null;
}
