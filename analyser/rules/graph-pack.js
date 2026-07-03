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
 * Objects that belong to a strongly-connected component of size >= 2.
 * Iterative Tarjan (explicit frame stack): a deep dependency chain must not
 * overflow the JS call stack — a crash here would silently degrade ALL
 * graph-pack findings to one engine diagnostic.
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

  const visit = (root) => {
    const frames = [{ v: root, it: (out.get(root) ?? new Set())[Symbol.iterator]() }];
    idx.set(root, index);
    low.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const next = frame.it.next();
      if (!next.done) {
        const w = next.value;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          frames.push({ v: w, it: (out.get(w) ?? new Set())[Symbol.iterator]() });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), idx.get(w)));
        }
        continue;
      }
      // frame exhausted: close the SCC root and propagate lowlink upward
      frames.pop();
      const v = frame.v;
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
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v), low.get(v)));
    }
  };

  for (const v of out.keys()) if (!idx.has(v)) visit(v);
  return cyclic;
}
