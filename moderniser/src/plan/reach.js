/**
 * The shared CPG REACHABILITY core: per-object facts with provenance, propagated through the corpus's own
 * wrappers. Both fact dimensions ride it — `consumption-facts.js` (what surface an object presents) and
 * `persistence-facts.js` (what state it owns) — so the walk, the wrapper propagation, the cycle guard, the
 * owner seeding and the absence marker are defined once and behave identically for both.
 *
 * What each dimension supplies is only the classifier: given a CPG edge (or node), which closed-enum facts
 * does it contribute. Everything structural is here.
 *
 * `direct` and `reached` stay separate because they are different claims implying different dispositions:
 * the wrapper that IS the grid retires, while the callers that USE it re-architect. `via` names the immediate
 * callee a reached fact came through, so the path is auditable rather than asserted.
 *
 * Reachability is computed over the graph's STRONGLY CONNECTED COMPONENTS (see `componentFacts`), so a set
 * of mutually recursive wrappers is one unit and every member gets the same answer regardless of which one
 * the walk enters first. O(V+E) in one pass — the 100K+ LOC NFR makes a per-object traversal untenable —
 * and iterative, so a deep call chain is bounded by the heap rather than the stack.
 */

/**
 * Edge kinds that describe an object's own STRUCTURE rather than anything it reaches. A function group's
 * INCLUDEs are parts of the object, not something it talks to; the included unit's own edges are attributed
 * to that unit separately.
 *
 * `inherits` is deliberately NOT here: a subclass of an SAP framework class genuinely adopts its surface
 * (TALV's `ZCL_GUI_ALV_GRID inherits CL_GUI_ALV_GRID` is classic UI), and excluding it cost that corpus its
 * only UI-shaped node.
 */
const STRUCTURAL_EDGE_KINDS = new Set(["includes", "contains"]);

/**
 * @param {object} doc analyser-findings.json (read-only, P8)
 * @param {{factsOfEdge: (edge: object) => string[], factsOfNode?: (node: object) => string[]}} classify
 * @returns {Record<string, {direct: string[], reached: Array<{fact: string, via: string}>}>}
 */
export function reachableEvidence(doc, classify) {
  const direct = directFacts(doc, classify);
  const callees = calleeMap(doc);
  // Every object the CPG contains is an object the detector READ, and a read object owes an answer. Built
  // from the fact and callee maps alone, this set left out precisely the objects with nothing to say — a
  // function group whose only edges are its own INCLUDEs entered neither, so it had no entry, so no absence
  // marker was ever emitted for it and a `none:` guard passed vacuously on the empty list.
  const owners = new Set((doc?.graph?.nodes ?? []).map(ownerOfNode).filter(Boolean));
  for (const key of direct.keys()) owners.add(key);
  for (const key of callees.keys()) owners.add(key);
  for (const set of callees.values()) for (const c of set) owners.add(c);

  const factsOf = componentFacts(owners, callees, direct);

  const out = {};
  for (const owner of [...owners].sort()) {
    const own = direct.get(owner) ?? new Set();
    const reached = [];
    for (const callee of [...(callees.get(owner) ?? [])].sort()) {
      for (const fact of [...factsOf(callee)].sort()) {
        if (own.has(fact) || reached.some((r) => r.fact === fact)) continue;
        reached.push({ fact, via: callee });
      }
    }
    out[owner] = { direct: [...own].sort(), reached };
  }
  return out;
}

/**
 * The flat per-object fact set, with the dimension's ABSENCE marker when nothing was found. Silence is an
 * explicit answer, never an empty list: a shape rule can then require evidence instead of quiet.
 */
export function reachableFacts(doc, { absence, propagate = true, ...classify }) {
  const out = {};
  for (const [owner, ev] of Object.entries(reachableEvidence(doc, classify))) {
    const reached = propagate ? ev.reached.map((r) => r.fact) : [];
    const facts = [...new Set([...ev.direct, ...reached])].sort();
    out[owner] = facts.length > 0 ? facts : [absence];
  }
  return out;
}

/** Every object's OWN facts — what it touches directly, with no propagation. */
function directFacts(doc, { factsOfEdge, factsOfNode }) {
  const byObject = new Map();
  const add = (owner, fact) => {
    if (!owner || !fact) return;
    if (!byObject.has(owner)) byObject.set(owner, new Set());
    byObject.get(owner).add(fact);
  };
  for (const n of doc?.graph?.nodes ?? []) for (const f of factsOfNode?.(n) ?? []) add(ownerOfNode(n), f);
  for (const e of doc?.graph?.edges ?? []) {
    const owner = ownerOf(e.source);
    if (!isReachEdge(e, owner)) continue;
    for (const f of factsOfEdge(e) ?? []) add(owner, f);
  }
  return byObject;
}

/** owner → the distinct owners it CALLS (structural edges and self-calls excluded). */
function calleeMap(doc) {
  const out = new Map();
  for (const e of doc?.graph?.edges ?? []) {
    const owner = ownerOf(e.source);
    if (!isReachEdge(e, owner)) continue;
    const callee = ownerOf(e.target);
    if (!owner || !callee) continue;
    if (!out.has(owner)) out.set(owner, new Set());
    out.get(owner).add(callee);
  }
  return out;
}

/**
 * Does this edge describe something the object reaches OUTSIDE itself? Structural edges never do, and neither
 * does a call an object makes to itself — a private helper call is not an external relationship, however the
 * callee happens to be named.
 */
function isReachEdge(edge, owner) {
  if (STRUCTURAL_EDGE_KINDS.has(String(edge?.kind ?? "").toLowerCase())) return false;
  return ownerOf(edge?.target) !== owner;
}

/** The owning object of a construct: the id segment before the first dot (`OWNER.method` → OWNER). */
export function ownerOf(id) {
  return String(id ?? "").split(".")[0];
}

/** A CPG node's owner: its explicit `object`, else the id's owner segment. */
export function ownerOfNode(n) {
  return n.object || ownerOf(n.id);
}

/**
 * Facts of the component an owner belongs to. Every member of a strongly connected component reaches
 * exactly the same set — they are mutually reachable — so the component is the natural unit.
 *
 * This replaced a memoised depth-first walk with an in-progress guard. That walk was UNSOUND on cycles: a
 * member reached while the walk was still inside the cycle got its (incomplete) set written to the memo,
 * and every later caller was served the short answer. With `AY <-> BZ` and `DW -> AY`, DW lost a fact AY
 * demonstrably had. The guard terminated the walk correctly and cached a wrong result — which is the
 * absence-as-evidence failure this module exists to prevent, sitting in the module itself. It was also
 * recursive, so a call chain past ~20k frames threw RangeError rather than answering.
 *
 * Tarjan emits components in reverse topological order, so every cross-edge points at a component already
 * computed and one pass suffices — still O(V+E), which the 100K+ LOC NFR requires, and iterative, so depth
 * is bounded by the heap rather than the stack.
 */
function componentFacts(owners, callees, direct) {
  const { comps, compOf } = stronglyConnected(owners, callees);
  const factsByComp = comps.map(() => new Set());
  for (let i = 0; i < comps.length; i += 1) {
    const set = factsByComp[i];
    for (const member of comps[i]) {
      for (const f of direct.get(member) ?? []) set.add(f);
      for (const callee of callees.get(member) ?? []) {
        const j = compOf.get(callee);
        if (j === undefined || j === i) continue; // same component: its facts are being built here
        for (const f of factsByComp[j]) set.add(f);
      }
    }
  }
  return (owner) => factsByComp[compOf.get(owner)] ?? new Set();
}

/** Tarjan's SCC, iterative. Returns components in reverse topological order plus each owner's index. */
function stronglyConnected(owners, callees) {
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const comps = [], compOf = new Map();
  let next = 0;
  for (const root of owners) {
    if (index.has(root)) continue;
    const work = [{ v: root, it: null }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.it === null) {
        index.set(v, next); low.set(v, next); next += 1;
        stack.push(v); onStack.add(v);
        frame.it = [...(callees.get(v) ?? [])][Symbol.iterator]();
      }
      const step = frame.it.next();
      if (!step.done) {
        const w = step.value;
        if (!index.has(w)) work.push({ v: w, it: null });
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          comp.push(w);
          compOf.set(w, comps.length);
          if (w === v) break;
        }
        comps.push(comp);
      }
    }
  }
  return { comps, compOf };
}
