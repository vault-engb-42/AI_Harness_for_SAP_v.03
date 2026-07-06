import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Business-function reference data (bundled from the TALOS curation of SAP
 * Notes 2240359/2240360 + the SFW_DELIVERY_BF cross-walk): which business
 * functions are ALWAYS OFF in S/4HANA (cannot be activated) and which
 * repository objects they own. Lazy-loaded, fail-open (unreadable data
 * degrades to empty sets — a missing dataset must never break a scan).
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "business-functions");

let _cache = null;

function load() {
  if (_cache) return _cache;
  let off = new Set();
  const ownedByOff = new Map();
  try {
    const offDoc = JSON.parse(readFileSync(join(DATA_DIR, "always_off_2240359.json"), "utf8"));
    off = new Set(Object.values(offDoc.target_releases ?? {}).flat().map((b) => String(b).toUpperCase()));
    const map = JSON.parse(readFileSync(join(DATA_DIR, "bf_object_map.json"), "utf8"));
    for (const m of map.mappings ?? []) {
      const bf = String(m.bf_name ?? "").toUpperCase();
      const obj = String(m.object_name ?? "").toUpperCase();
      if (bf && obj && off.has(bf)) ownedByOff.set(obj, bf);
    }
  } catch {
    // fail-open
  }
  _cache = { off, ownedByOff };
  return _cache;
}

/** @param {string} bfName @returns {boolean} the BF can never be active in S/4 */
export function isAlwaysOff(bfName) {
  return load().off.has(String(bfName ?? "").toUpperCase());
}

/** @param {string} objectName @returns {string|undefined} owning always-off BF */
export function offOwnerOf(objectName) {
  return load().ownedByOff.get(String(objectName ?? "").toUpperCase());
}

/** Test seam. */
export function _resetCache() {
  _cache = null;
}
