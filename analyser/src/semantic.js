import { ABAPObject } from "@abaplint/core";
import { loadRegistry, objectsOf } from "./abaplint-loader.js";
import { collectReferences } from "./references.js";
import { collectStatementEdges } from "./statement-edges.js";
import { collectInheritEdges, collectCdsEdges } from "./metadata-edges.js";
import { collectRapEdges } from "./rap-edges.js";
import { edgeKindForReference } from "./edge-kinds.js";
import { nodeKindForObjectType } from "./node-kinds.js";
import { classifyNamespace } from "./namespace.js";
import { DependencyGraph } from "./cpg.js";

/** Routine ScopeType -> the CPG node kind of that routine (the edge source). */
const ROUTINE_KIND = { method: "method", form: "form", function: "function" };

/**
 * Build the CPG for a set of ABAP source files by loading them into abaplint,
 * walking each object's resolved references, and mapping them onto the
 * analyser-findings schema's node/edge model.
 *
 * This is the C1 core: call-method, form calls (PERFORM), and uses-table
 * edges derived from the SyntaxLogic reference stream. Statement-level and
 * DDIC edges (call-function, get-badi, authority-check, inherits,
 * consumes-cds, includes) are added by the C1 gap-fillers.
 *
 * @param {Array<{filename: string, source: string}>} files
 * @returns {DependencyGraph}
 */
export function analyzeObjects(files) {
  return analyzeRegistry(loadRegistry(files));
}

/**
 * Build the CPG from an already-parsed registry. Lets a caller (the
 * orchestrator) load the registry once and share it with the rule engine
 * rather than parsing twice.
 * @param {import("@abaplint/core").Registry} reg
 * @param {{maxNodes?: number}} [opts] forwarded to the graph store (§10.2 cap)
 * @returns {DependencyGraph}
 */
export function analyzeRegistry(reg, opts = {}) {
  const graph = new DependencyGraph(opts);

  // First pass: register EVERY object node before any edge extraction, so
  // authoritative kinds always win over edge-target guesses (a SELECT on an
  // in-bundle CDS entity must never leave it kinded "table" just because the
  // consuming class parsed first — node kind is first-write-wins).
  const objects = [];
  for (const obj of objectsOf(reg)) {
    const objName = obj.getName();
    const objKind = nodeKindForObjectType(obj.getType());
    if (!objKind) continue;
    graph.addNode({ id: objName, kind: objKind, object: objName, namespace: classifyNamespace(objName) });
    objects.push({ obj, objName });
  }

  for (const { obj, objName } of objects) {

    // Metadata edges work on non-ABAP objects too (CDS consumes-cds, class
    // inherits, RAP behavior). BDEF is opaque to abaplint, so RAP edges come
    // from a raw-source scan.
    for (const e of collectInheritEdges(obj)) addDescribedEdge(objName, e, graph);
    for (const e of collectCdsEdges(obj)) addDescribedEdge(objName, e, graph);
    for (const e of collectRapEdges(obj)) addDescribedEdge(objName, e, graph);

    // SyntaxLogic (the reference walk) and statement extraction only support
    // ABAP-code objects. CDS/DDIC nodes still exist (added above); their edges
    // come from the metadata extractors, not the spaghetti stream.
    if (!(obj instanceof ABAPObject)) continue;
    for (const ref of collectReferences(reg, obj)) {
      addEdgeFromRef(ref, objName, graph);
    }
    for (const e of collectStatementEdges(obj)) addDescribedEdge(objName, e, graph);
  }

  return graph;
}

/**
 * Add an object-level edge from a gap-filler descriptor. Materializes a target
 * node only when its kind is known with confidence (descriptor.targetKind);
 * otherwise the edge is recorded without a node (auth object, include, handle).
 * @param {string} objName
 * @param {import("./statement-edges.js").EdgeDescriptor} e
 * @param {DependencyGraph} graph
 */
function addDescribedEdge(objName, e, graph) {
  if (e.targetKind) {
    graph.addNode({
      id: e.target,
      kind: e.targetKind,
      object: e.target,
      namespace: classifyNamespace(e.target),
    });
  }
  // `access` rides through when the descriptor carries one (R3a table read/write). This projection used to
  // be a fixed field set, which silently dropped it: the unit test on collectStatementEdges passed while
  // every emitted document carried table edges with no access at all.
  graph.addEdge({
    source: objName, target: e.target, kind: e.kind, evidence: e.evidence,
    ...(e.access ? { access: e.access } : {}),
  });
}

/**
 * @param {import("./references.js").ReferenceRecord} ref
 * @param {string} objName
 * @param {DependencyGraph} graph
 */
function addEdgeFromRef(ref, objName, graph) {
  const kind = edgeKindForReference(ref.referenceType);
  if (!kind) return;
  const target = targetNodeFor(kind, ref, objName);
  if (!target) return;

  const sourceId = ref.routine ? `${objName}.${ref.routine.toUpperCase()}` : objName;
  if (ref.routine) {
    graph.addNode({
      id: sourceId,
      kind: ROUTINE_KIND[ref.routineType] ?? "method",
      object: objName,
      namespace: classifyNamespace(objName),
    });
  }
  graph.addNode({
    id: target.id,
    kind: target.kind,
    object: target.object,
    namespace: classifyNamespace(target.object),
  });
  graph.addEdge({ source: sourceId, target: target.id, kind, evidence: `${ref.filename}:${ref.row}` });
}

/**
 * Derive the target node identity for an edge. Data-flow edges point at local
 * variables, which are not CPG nodes in C1, so they return null (skipped).
 * @returns {{id: string, kind: string, object: string}|null}
 */
function targetNodeFor(kind, ref, objName) {
  const name = (ref.targetName ?? "").toUpperCase();
  if (!name) return null;
  // abaplint's ref.extra.ooName is the target's true owning object; without
  // it a cross-object call would fabricate a wrong-owner method node and
  // leave blast radius blind to method-level dependees.
  const owner = ref.targetOwner ?? objName;
  switch (kind) {
    case "call-method":
      return { id: `${owner}.${name}`, kind: "method", object: owner };
    case "calls":
      return { id: `${owner}.${name}`, kind: "form", object: owner };
    default:
      return null; // data-flow-def / data-flow-use target locals — not C1 nodes
  }
}
