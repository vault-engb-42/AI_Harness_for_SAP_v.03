import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * GF-1 — greenfield PRE-generation grounding. A deterministic offline lookup
 * over the bundled SAP cloudification dataset (released-API state + released
 * successor per object). The greenfield lanes harvest the SAP objects a design
 * intends to use, ground them here, and inject the rendered pack into the
 * generator's context so it writes against RELEASED APIs only — before a line
 * of ABAP is generated (the TALOS Forge `ground_for_phase` analogue).
 *
 * This is a released-API REGISTRY lookup — NOT the analyser: no @abaplint parse,
 * no code property graph, no rule packs. It only reuses the shared SAP
 * cloudification reference DATASET (foundational released-API data, Apache-2.0),
 * with greenfield's own lightweight loader.
 */

// Shared SAP cloudification reference dataset (released-API state) in the neutral
// top-level `data/` dir — foundational data used by both the analyser (readiness)
// and greenfield grounding, owned by neither. Read here with greenfield's own
// loader, not via analyser code (greenfield no longer reaches into analyser/data/).
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

const SOURCES = [
  { file: "objectReleaseInfoLatest.json", key: "objectReleaseInfo", authoritative: true },
  { file: "objectClassifications_SAP.json", key: "objectClassifications", authoritative: false },
];

// ABAP keywords a naive harvest would otherwise mistake for SAP object refs.
const ABAP_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "INTO", "TABLE", "DATA", "TYPES", "CLASS", "METHOD", "METHODS",
  "ENDCLASS", "ENDMETHOD", "PUBLIC", "PRIVATE", "PROTECTED", "SECTION", "RETURNING", "IMPORTING",
  "EXPORTING", "CHANGING", "VALUE", "ABAP_TRUE", "ABAP_FALSE", "ABAP_BOOL", "ENDIF", "ENDLOOP",
  "WHILE", "CASE", "WHEN", "RAISE", "EXCEPTION", "CREATE", "OBJECT", "CALL", "FUNCTION", "PERFORM",
  "REPORT", "DEFINE", "VIEW", "ENTITY", "ASSOCIATION", "COMPOSITION", "MANAGED", "UNMANAGED",
  "IMPLEMENTATION", "BEHAVIOR", "DEFINITION", "FINAL", "ABSTRACT", "INHERITING", "INTERFACE",
  "CONSTANTS", "BEGIN", "APPEND", "INSERT", "UPDATE", "MODIFY", "DELETE", "COMMIT", "ROLLBACK",
]);

const REF_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g;

let _index = null;

/** @returns {Map<string, {objectType: string, state: string, successor: string|undefined}>} */
function loadIndex() {
  if (_index) return _index;
  const map = new Map();
  for (const src of SOURCES) {
    let entries;
    try {
      entries = JSON.parse(readFileSync(join(DATA_DIR, src.file), "utf8"))[src.key] ?? [];
    } catch {
      continue; // fail-open: a missing dataset degrades grounding to "unknown", never throws
    }
    for (const e of entries) {
      const name = String(e.tadirObjName ?? "").toUpperCase();
      if (!name || (!src.authoritative && map.has(name))) continue; // release info wins
      const successor = Array.isArray(e.successors) && e.successors.length
        ? String(e.successors[0].tadirObjName ?? "").toUpperCase() || undefined
        : undefined;
      map.set(name, { objectType: e.objectType, state: e.state, successor });
    }
  }
  _index = map;
  return map;
}

/**
 * @param {string} name SAP object name
 * @returns {{name: string, state: string, successor: string|undefined, object_type: string|undefined}}
 *   state ∈ released | deprecated | notToBeReleased | classicAPI | noAPI | unknown
 */
export function classifyRef(name) {
  const key = String(name ?? "").toUpperCase();
  const rec = loadIndex().get(key);
  if (!rec) return { name: key, state: "unknown", successor: undefined, object_type: undefined };
  return { name: key, state: rec.state, successor: rec.successor, object_type: rec.objectType };
}

/**
 * Extract candidate SAP object refs from free text (design/spec). Customer Z/Y
 * names and common ABAP keywords are skipped; the registry lookup filters the
 * rest. Over-harvesting is safe — a non-registry token grounds as "unknown".
 * @param {string} text
 * @returns {string[]} unique candidate SAP refs, uppercased
 */
export function harvestRefs(text) {
  const out = new Set();
  for (const m of String(text ?? "").toUpperCase().matchAll(REF_RE)) {
    const name = m[0];
    if (name.length < 4 || /^[ZY]/.test(name) || ABAP_KEYWORDS.has(name)) continue;
    out.add(name);
  }
  return [...out];
}

/**
 * Ground a list of SAP refs against the released-API registry.
 * @param {string[]} refs
 * @returns {{refs: Array<{name, state, successor}>, counts: {released, deprecated, notToBeReleased, unknown}}}
 */
export function groundReleasedApis(refs) {
  const counts = { released: 0, deprecated: 0, notToBeReleased: 0, classicAPI: 0, noAPI: 0, unknown: 0 };
  const classified = [...new Set((refs ?? []).map((r) => String(r ?? "").toUpperCase()))].filter(Boolean).map((name) => {
    const c = classifyRef(name);
    counts[c.state in counts ? c.state : "unknown"]++;
    return { name: c.name, state: c.state, successor: c.successor };
  });
  return { refs: classified, counts };
}

/**
 * Render the grounding pack as a prompt section for injection into the
 * generator's context. Actionable verdicts (deprecated → successor, notTo
 * BeReleased, unknown) are listed explicitly; released objects are summarised.
 * @param {{refs: Array<{name, state, successor}>, counts: object}} grounded
 * @returns {string}
 */
export function renderGroundingPack(grounded) {
  const lines = ["=== Released-API Grounding (offline, SAP cloudification registry) ===",
    "Generate against RELEASED APIs only. Verdicts for the cited SAP objects:"];
  for (const r of grounded.refs) {
    if (r.state === "released") continue;
    if (r.state === "deprecated") {
      lines.push(`- ${r.name} — DEPRECATED → replace with released successor ${r.successor ?? "(none published — find a released alternative)"}`);
    } else if (r.state === "notToBeReleased") {
      lines.push(`- ${r.name} — NOT TO BE RELEASED → do not use; model a released alternative`);
    } else if (r.state === "noAPI") {
      lines.push(`- ${r.name} — NO released API (noAPI) → there is no Cloud-released way to consume this; model a released alternative`);
    } else if (r.state === "classicAPI") {
      lines.push(`- ${r.name} — CLASSIC API (Level B, not Clean-Core Level A)${r.successor ? ` → prefer released successor ${r.successor}` : " → prefer a released successor"}`);
    } else {
      lines.push(`- ${r.name} — not in the released registry (custom/new, or an unlisted SAP object — do NOT assume released)`);
    }
  }
  lines.push(`(${grounded.counts.released} cited object(s) are released and safe to use.)`);
  lines.push("Rule: use only released objects; replace every deprecated one with the successor above; never assume a not-found SAP object is released.");
  return lines.join("\n");
}

/** Test seam: drop the lazy cache so a fresh load can be forced. */
export function _resetCache() {
  _index = null;
}
