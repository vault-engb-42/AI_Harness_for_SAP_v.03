import { SyntaxLogic } from "@abaplint/core";

/**
 * ScopeType values (abaplint `_scope_type.js`) that represent a callable
 * routine — the "source" end of a CPG edge. A reference found inside one of
 * these scopes is attributed to that routine; references above them (program
 * main body, function-group top) attribute to the object itself.
 */
const ROUTINE_SCOPE_TYPES = new Set(["method", "form", "function"]);

/**
 * @typedef {object} ReferenceRecord
 * @property {string|null} routine   enclosing routine name (method/form/fm) or null
 * @property {string|null} routineType  the ScopeType of the routine, or null
 * @property {string} referenceType  abaplint ReferenceType value string
 * @property {string|null} targetName  resolved name, else the reference-site token
 * @property {boolean} resolved  true if abaplint resolved the target locally
 * @property {string} filename
 * @property {number} row
 * @property {number} col
 */

/**
 * Walk one object's spaghetti scope tree and yield normalized reference
 * records with the enclosing routine attributed. Void targets (external SAP
 * objects abaplint can't resolve) fall back to the reference-site token text
 * (e.g. `t000`), which is how external table/OO names are recovered.
 *
 * @param {import("@abaplint/core").Registry} reg
 * @param {import("@abaplint/core").IObject} obj
 * @returns {ReferenceRecord[]}
 */
export function collectReferences(reg, obj) {
  const { spaghetti } = new SyntaxLogic(reg, obj).run();
  /** @type {ReferenceRecord[]} */
  const out = [];

  const visit = (node, routine, routineType) => {
    const id = node.getIdentifier();
    if (ROUTINE_SCOPE_TYPES.has(id.stype)) {
      routine = id.sname;
      routineType = id.stype;
    }
    for (const ref of node.getData().references) {
      out.push(normalizeRef(ref, id.filename, routine, routineType));
    }
    for (const child of node.getChildren()) {
      visit(child, routine, routineType);
    }
  };

  visit(spaghetti.getTop(), null, null);
  return out;
}

/**
 * @param {*} ref an abaplint reference entry {position, resolved, referenceType, extra}
 * @param {string} filename
 * @param {string|null} routine
 * @param {string|null} routineType
 * @returns {ReferenceRecord}
 */
function normalizeRef(ref, filename, routine, routineType) {
  const resolvedName = ref.resolved?.getName?.() ?? null;
  const token = ref.position?.getToken?.();
  const targetName = resolvedName ?? token?.getStr?.() ?? null;
  const start = ref.position?.getStart?.();
  return {
    routine,
    routineType,
    referenceType: ref.referenceType,
    targetName,
    resolved: resolvedName !== null,
    filename,
    row: start?.getRow?.() ?? 0,
    col: start?.getCol?.() ?? 0,
  };
}
