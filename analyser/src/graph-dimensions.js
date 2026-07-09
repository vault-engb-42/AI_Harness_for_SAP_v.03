/**
 * Graph-topology dimensions (arch spec §3.C), derived deterministically from the
 * CPG graph JSON ({nodes, edges}).
 *
 * - layers(): each node -> entry (no incoming dependency edge) / internal (called
 *   by something) / data (tables). A coarse topological layering.
 * - boundaries(): compilation-unit objects that are called INTO from a DIFFERENT
 *   object — the inbound interface surfaces. A finding on a member resolves to its
 *   owning object via node.object, so a call to ZCL_X=>m makes ZCL_X the boundary.
 */

/** Edge kinds that mean "something depends on / calls the target". */
const INCOMING_DEP_KINDS = new Set(["calls", "call-function", "call-method", "inherits", "consumes-cds", "get-badi"]);
/** Node kinds that are compilation units (candidate interface surfaces). */
const COMPILATION_UNIT_KINDS = new Set(["class", "interface", "function", "report", "cds", "behavior", "form"]);

const sorted = (arr) => [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * @param {{nodes?: object[], edges?: object[]}} g graph JSON
 * @returns {{entry: string[], internal: string[], data: string[]}}
 */
export function layers(g) {
  const nodes = g?.nodes ?? [];
  const edges = g?.edges ?? [];
  const called = new Set(edges.filter((e) => INCOMING_DEP_KINDS.has(e.kind)).map((e) => e.target));
  const out = { entry: [], internal: [], data: [] };
  for (const n of nodes) {
    const layer = n.kind === "table" ? "data" : called.has(n.id) ? "internal" : "entry";
    out[layer].push(n.id);
  }
  return { entry: sorted(out.entry), internal: sorted(out.internal), data: sorted(out.data) };
}

/**
 * @param {{nodes?: object[], edges?: object[]}} g graph JSON
 * @returns {Array<{name: string, kind: string, direction: string}>}
 */
export function boundaries(g) {
  const nodes = g?.nodes ?? [];
  const edges = g?.edges ?? [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const objectKind = new Map();
  for (const n of nodes) {
    if (COMPILATION_UNIT_KINDS.has(n.kind) && !objectKind.has(n.object)) objectKind.set(n.object, n.kind);
  }
  const inbound = new Set();
  for (const e of edges) {
    if (!INCOMING_DEP_KINDS.has(e.kind)) continue;
    const srcOwner = nodeById.get(e.source)?.object ?? e.source;
    const tgtOwner = nodeById.get(e.target)?.object ?? e.target;
    if (tgtOwner && srcOwner && tgtOwner !== srcOwner && objectKind.has(tgtOwner)) inbound.add(tgtOwner);
  }
  return sorted([...inbound]).map((name) => ({ name, kind: objectKind.get(name), direction: "inbound" }));
}
