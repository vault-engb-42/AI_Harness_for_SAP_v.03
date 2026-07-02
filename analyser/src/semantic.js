import { ABAPObject } from "@abaplint/core";
import { loadRegistry, objectsOf } from "./abaplint-loader.js";
import { collectReferences } from "./references.js";
import { edgeKindForReference } from "./edge-kinds.js";
import { nodeKindForObjectType } from "./node-kinds.js";
import { classifyNamespace } from "./namespace.js";

/** Routine ScopeType -> the CPG node kind of that routine (the edge source). */
const ROUTINE_KIND = { method: "method", form: "form", function: "function" };

/**
 * Build the CPG ({nodes, edges}) for a set of ABAP source files by loading
 * them into abaplint, walking each object's resolved references, and mapping
 * them onto the analyser-findings schema's node/edge model.
 *
 * This is the C1 core: call-method, form calls (PERFORM), and uses-table
 * edges derived from the SyntaxLogic reference stream. Statement-level and
 * DDIC edges (call-function, get-badi, authority-check, inherits,
 * consumes-cds, includes) are added by the C1 gap-fillers.
 *
 * @param {Array<{filename: string, source: string}>} files
 * @returns {{nodes: Array<object>, edges: Array<object>}}
 */
export function analyzeObjects(files) {
  const reg = loadRegistry(files);
  /** @type {Map<string, object>} */
  const nodes = new Map();
  const edges = [];

  const addNode = (id, kind, object) => {
    if (id && kind && !nodes.has(id)) {
      nodes.set(id, { id, kind, object, namespace: classifyNamespace(object) });
    }
  };

  for (const obj of objectsOf(reg)) {
    const objName = obj.getName();
    const objKind = nodeKindForObjectType(obj.getType());
    if (!objKind) continue;
    addNode(objName, objKind, objName);
    // SyntaxLogic (the reference walk) only supports ABAP-code objects.
    // CDS (DDLS) and DDIC (TABL) nodes exist but their edges come from the
    // CDS/DDIC gap-fillers, not the spaghetti reference stream.
    if (!(obj instanceof ABAPObject)) continue;
    for (const ref of collectReferences(reg, obj)) {
      addEdgeFromRef(ref, objName, addNode, edges);
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * @param {import("./references.js").ReferenceRecord} ref
 * @param {string} objName
 * @param {(id: string, kind: string, object: string) => void} addNode
 * @param {Array<object>} edges
 */
function addEdgeFromRef(ref, objName, addNode, edges) {
  const kind = edgeKindForReference(ref.referenceType);
  if (!kind) return;
  const target = targetNodeFor(kind, ref, objName);
  if (!target) return;

  const sourceId = ref.routine ? `${objName}.${ref.routine.toUpperCase()}` : objName;
  if (ref.routine) {
    addNode(sourceId, ROUTINE_KIND[ref.routineType] ?? "method", objName);
  }
  addNode(target.id, target.kind, target.object);
  edges.push({ source: sourceId, target: target.id, kind, evidence: `${ref.filename}:${ref.row}` });
}

/**
 * Derive the target node identity for an edge. Data-flow edges point at local
 * variables, which are not CPG nodes in C1, so they return null (skipped).
 * @returns {{id: string, kind: string, object: string}|null}
 */
function targetNodeFor(kind, ref, objName) {
  const name = (ref.targetName ?? "").toUpperCase();
  if (!name) return null;
  switch (kind) {
    case "uses-table":
      return { id: name, kind: "table", object: name };
    case "call-method":
      // C1 assumes same-object resolution; cross-object linking is a gap-filler.
      return { id: `${objName}.${name}`, kind: "method", object: objName };
    case "calls":
      return { id: `${objName}.${name}`, kind: "form", object: objName };
    default:
      return null; // data-flow-def / data-flow-use target locals — not C1 nodes
  }
}
