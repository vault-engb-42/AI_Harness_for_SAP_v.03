import { classifyNamespace } from "../src/namespace.js";

/**
 * Graph rule pack — structural CPG-query rules the source/statement packs
 * cannot express. Operates on an object-level projection of the CPG (methods
 * roll up to their owning object):
 *   - talos-god-object      high fan-in (many objects depend on it)
 *   - talos-high-fan-out    high fan-out (it depends on many objects)
 *   - talos-dependency-cycle object participates in a dependency cycle (SCC)
 *
 * Only customer (Z/Y) objects are flagged; SAP standard hubs (e.g. a common
 * table) legitimately have high fan-in and are not actionable.
 */

const FAN_IN_THRESHOLD = 10;
const FAN_OUT_THRESHOLD = 20;

export const graphPack = {
  id: "graph-pack",
  family: "graph-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    const { out, inn, objects } = objectProjection(ctx.graph);

    for (const obj of objects) {
      if (!isCustomer(obj)) continue;
      const fanIn = inn.get(obj)?.size ?? 0;
      const fanOut = out.get(obj)?.size ?? 0;
      if (fanIn >= FAN_IN_THRESHOLD) {
        findings.push(mk("talos-god-object", "anti-pattern", "priority-3", obj, `high fan-in: ${fanIn} objects depend on ${obj} (change-risk hotspot)`));
      }
      if (fanOut >= FAN_OUT_THRESHOLD) {
        findings.push(mk("talos-high-fan-out", "anti-pattern", "priority-3", obj, `high fan-out: ${obj} depends on ${fanOut} objects (low cohesion)`));
      }
    }
    for (const obj of cyclicObjects(out)) {
      if (isCustomer(obj)) {
        findings.push(mk("talos-dependency-cycle", "anti-pattern", "priority-2", obj, `${obj} participates in a dependency cycle`));
      }
    }
    return findings;
  },
};

function isCustomer(obj) {
  const ns = classifyNamespace(obj);
  return ns === "Z" || ns === "Y";
}

function mk(id, family, severity, object, message) {
  return { rule_id: id, severity, object, message, family };
}

/**
 * Project the CPG to object-level adjacency (methods -> owning object), dropping
 * self-loops.
 * @param {import("../src/cpg.js").DependencyGraph} graph
 * @returns {{out: Map<string, Set<string>>, inn: Map<string, Set<string>>, objects: Set<string>}}
 */
function objectProjection(graph) {
  const gj = graph.toGraphJSON();
  const ownerOf = new Map();
  for (const n of gj.nodes) ownerOf.set(n.id, n.object ?? n.id);
  const out = new Map();
  const inn = new Map();
  const objects = new Set(ownerOf.values());
  const link = (map, a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  for (const e of gj.edges) {
    const s = ownerOf.get(e.source) ?? e.source;
    const t = ownerOf.get(e.target) ?? e.target;
    objects.add(s);
    objects.add(t);
    if (s === t) continue;
    link(out, s, t);
    link(inn, t, s);
  }
  return { out, inn, objects };
}

/**
 * Objects that belong to a strongly-connected component of size >= 2 (Tarjan).
 * @param {Map<string, Set<string>>} out
 * @returns {Set<string>}
 */
function cyclicObjects(out) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cyclic = new Set();

  const strongConnect = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length >= 2) for (const c of comp) cyclic.add(c);
    }
  };

  for (const v of out.keys()) if (!idx.has(v)) strongConnect(v);
  return cyclic;
}
