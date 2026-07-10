import { esc, num, round } from "./html-util.js";

/**
 * §3.E Graph tab — a readable dependency VISUAL. The raw CPG is method-level (a
 * 223-node hairball on zapcommander); this collapses methods into their owning
 * OBJECT (~67 nodes) and lays them out HIERARCHICALLY: x = dependency depth
 * (entry points left → data right, like an architecture diagram), y = importance
 * within a layer, edge thickness = number of underlying dependencies. Rendered as
 * inline SVG; the client (html-assets GRAPH_JS) adds pan/zoom/drag/focus and an
 * optional force animation. A Dependency Structure Matrix (DSM) is the SECONDARY
 * view (cycle-spotting + the moderniser's SCC primitive). Deterministic; no lib.
 */

const NS_COLOR = { Z: "#0ea5a4", Y: "#0ea5a4", sap: "#94a3b8", registered: "#d97706" };
const COL_W = 210; // px between dependency layers
const ROW_H = 46; // px between nodes within a layer
const SVG_CAP = 200; // objects; beyond this the SVG is unwieldy — the matrix takes over
const MATRIX_CAP = 120; // objects shown in the DSM grid

export function graphTab(doc) {
  const og = objectLevelGraph(doc);
  const total = og.objects.length;
  const rawNodes = doc.graph?.nodes?.length ?? 0;
  // The hierarchy is the default VISUAL; only fall back to the matrix when the SVG
  // is truly unwieldy (beyond the top-SVG_CAP objects it can't show them all anyway).
  const bigApp = total > SVG_CAP;

  // Hierarchical layout: layer = longest dependency chain from an entry point.
  const svgObjects = total > SVG_CAP ? topByRank(og, SVG_CAP) : og.objects;
  const svgSet = new Set(svgObjects);
  const layer = computeLayers(svgObjects, og.adj);
  const groups = new Map();
  for (const o of svgObjects) {
    const L = layer.get(o) ?? 0;
    if (!groups.has(L)) groups.set(L, []);
    groups.get(L).push(o);
  }
  const pos = new Map();
  let maxRows = 1;
  let maxLayer = 0;
  for (const [L, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => (og.rankOf.get(b) ?? 0) - (og.rankOf.get(a) ?? 0) || (a < b ? -1 : 1));
    list.forEach((o, i) => pos.set(o, { x: 80 + L * COL_W, y: 50 + i * ROW_H }));
    maxRows = Math.max(maxRows, list.length);
    maxLayer = Math.max(maxLayer, L);
  }
  const w = 160 + maxLayer * COL_W + 120;
  const h = Math.max(420, 50 + maxRows * ROW_H + 30);

  const lines = [];
  for (const [s, targets] of og.adj) {
    if (!svgSet.has(s)) continue;
    for (const [t, cnt] of targets) {
      if (!svgSet.has(t)) continue;
      const a = pos.get(s), b = pos.get(t);
      if (a && b) lines.push(`<line class="ge" data-src="${esc(s)}" data-tgt="${esc(t)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${1 + Math.min(cnt, 6) * 0.4}"/>`);
    }
  }
  const dots = svgObjects.map((o) => {
    const p = pos.get(o);
    const r = 6 + Math.round((og.rankOf.get(o) ?? 0) * 10);
    return `<g class="gn" data-id="${esc(o)}" data-x="${p.x}" data-y="${p.y}" transform="translate(${p.x} ${p.y})"><circle r="${r}" fill="${NS_COLOR[og.nsOf.get(o)] ?? "#64748b"}"><title>${esc(o)} (${esc(og.kindOf.get(o) ?? "")} · rank ${round(og.rankOf.get(o))})</title></circle><text y="${r + 12}" text-anchor="middle">${esc(String(o).slice(0, 20))}</text></g>`;
  }).join("");
  const svgTrunc = total > SVG_CAP ? `<b>Showing the top ${SVG_CAP} of ${total} objects.</b> ` : "";

  return `<h2>Dependency Graph — ${rawNodes} methods in ${total} objects / ${(doc.graph?.edges ?? []).length} edges</h2>
<p class="muted">${svgTrunc}Object-level (methods collapsed). Left → right = dependency depth (entry points on the left, data on the right). Node size = importance · edge thickness = dependency count · teal = customer · grey = SAP · amber = vendor. Click a node to focus its dependencies; drag to rearrange.</p>
<div class="gbar"><b>View</b> <button type="button" data-g="layout" data-arg="layered">Hierarchy</button> <button type="button" data-g="layout" data-arg="force">Force</button> <button type="button" data-g="layout" data-arg="matrix">Matrix</button> <span class="sep">·</span> <span class="gzoom"><b>Zoom</b> <button type="button" data-g="zoom" data-arg="1.25">+</button> <button type="button" data-g="zoom" data-arg="0.8">−</button> <button type="button" data-g="fit">Fit</button> <button type="button" data-g="reset">Reset</button></span></div>
<div class="gwrap" id="gsvgwrap"${bigApp ? ' style="display:none"' : ""}><svg id="gsvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"><g id="gv">${lines.join("")}${dots}</g></svg></div>
<div id="gmatrix"${bigApp ? "" : ' style="display:none"'}>${dependencyMatrix(og)}</div>`;
}

/** Collapse the method-level CPG to an object-level graph with aggregated edges. */
function objectLevelGraph(doc) {
  const nodes = doc.graph?.nodes ?? [];
  const objOf = new Map(nodes.map((n) => [n.id, n.object]));
  const rankOf = new Map();
  const kindOf = new Map();
  const nsOf = new Map();
  for (const n of nodes) {
    rankOf.set(n.object, Math.max(rankOf.get(n.object) ?? 0, num(n.rank)));
    if (!kindOf.has(n.object)) {
      kindOf.set(n.object, n.kind);
      nsOf.set(n.object, n.namespace);
    }
  }
  const adj = new Map(); // src -> Map(tgt -> dependency count)
  const objSet = new Set();
  for (const e of doc.graph?.edges ?? []) {
    const s = objOf.get(e.source) ?? e.source;
    const t = objOf.get(e.target) ?? e.target;
    if (s === t) continue;
    if (!adj.has(s)) adj.set(s, new Map());
    adj.get(s).set(t, (adj.get(s).get(t) ?? 0) + 1);
    objSet.add(s);
    objSet.add(t);
  }
  return { objects: [...objSet], adj, rankOf, kindOf, nsOf };
}

/** @returns {string[]} the top-n objects by importance (for capping large graphs). */
function topByRank(og, n) {
  return [...og.objects].sort((a, b) => (og.rankOf.get(b) ?? 0) - (og.rankOf.get(a) ?? 0)).slice(0, n);
}

/**
 * Layer = longest dependency chain from an entry point (an object nothing depends
 * on). Memoised over the "dependents" (reverse) adjacency; a cycle back-edge
 * degrades to 0 rather than looping. Entry points land at layer 0 (left).
 */
function computeLayers(objects, adj) {
  const set = new Set(objects);
  const parents = new Map(objects.map((o) => [o, new Set()])); // o -> objects that depend on o
  for (const s of objects) for (const t of adj.get(s)?.keys() ?? []) if (parents.has(t)) parents.get(t).add(s);
  const layer = new Map();
  const visiting = new Set();
  const compute = (o) => {
    if (layer.has(o)) return layer.get(o);
    if (visiting.has(o)) return 0;
    visiting.add(o);
    let best = 0;
    for (const p of parents.get(o) ?? []) if (set.has(p)) best = Math.max(best, compute(p) + 1);
    visiting.delete(o);
    layer.set(o, best);
    return best;
  };
  for (const o of objects) compute(o);
  return layer;
}

/**
 * Dependency Structure Matrix (secondary view): object×object grid, cell = row
 * depends on column, ordered by topological wave so clean deps fall below the
 * diagonal and a filled cell ABOVE it is a circular dependency (red). Scales as a
 * plain grid; the moderniser's SCC/cycle primitive.
 */
function dependencyMatrix(og) {
  const wave = topoWaves(og.objects, og.adj);
  let objects = [...og.objects].sort((a, b) => (wave.get(a) ?? 0) - (wave.get(b) ?? 0) || (og.rankOf.get(b) ?? 0) - (og.rankOf.get(a) ?? 0) || (a < b ? -1 : 1));
  const total = objects.length;
  if (!total) return `<p class="muted"><i>No inter-object dependencies to chart.</i></p>`;
  const capped = total > MATRIX_CAP;
  if (capped) {
    const keep = new Set(topByRank(og, MATRIX_CAP));
    objects = objects.filter((o) => keep.has(o));
  }
  // Definitive cycle marking: an edge is circular iff BOTH ends sit in the same
  // strongly-connected component of size > 1 (Tarjan) — independent of the row/col
  // ordering, so a clean DAG shows zero red cells and a real cycle always shows.
  const scc = stronglyConnected(objects, og.adj);
  let cycles = 0;
  const rowHtml = objects.map((o, i) => {
    const deps = og.adj.get(o);
    const cells = objects.map((t, j) => {
      if (i === j) return `<td class="mx-diag"></td>`;
      if (!deps || !deps.has(t)) return "<td></td>";
      const cyc = scc.has(o) && scc.get(o) === scc.get(t);
      if (cyc) cycles += 1;
      return `<td class="mx-dep${cyc ? " mx-cycle" : ""}" title="${esc(o)} → ${esc(t)}${cyc ? " (circular)" : ""}"></td>`;
    }).join("");
    return `<tr><th class="mx-row" title="${esc(og.kindOf.get(o) ?? "")}">${i + 1}. ${esc(o)}</th>${cells}</tr>`;
  }).join("");
  const header = `<tr><th class="mx-corner"></th>${objects.map((o, j) => `<th class="mx-col" title="${esc(o)}">${j + 1}</th>`).join("")}</tr>`;
  const capNote = capped ? `<b>Top ${objects.length} of ${total} objects.</b> ` : "";
  return `<p class="muted small">${capNote}Dependency matrix — rows depend on columns · <span class="mx-key mx-dep"></span> dependency (below the diagonal = clean layering) · <span class="mx-key mx-cycle"></span> circular dependency (${cycles}). Hover a cell for the pair. Best for spotting cycles + clusters at scale.</p>
<div class="mxwrap"><table class="mx"><thead>${header}</thead><tbody>${rowHtml}</tbody></table></div>`;
}

/**
 * Tarjan strongly-connected components over the object graph. Returns a Map of
 * object -> component id, populated ONLY for objects in a CYCLIC component (size
 * > 1) — the definitive "these objects are in a circular dependency" set, so a cell
 * is a cycle iff both its objects map to the same id. Deterministic (iteration order
 * follows the objects array). Depth-bounded by the matrix object cap.
 * @param {string[]} objects
 * @param {Map<string, Map<string, number>>} adj src -> (tgt -> count)
 * @returns {Map<string, number>}
 */
function stronglyConnected(objects, adj) {
  const set = new Set(objects);
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comp = new Map();
  let idx = 0;
  let compId = 0;
  const connect = (v) => {
    index.set(v, idx);
    low.set(v, idx);
    idx += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)?.keys() ?? []) {
      if (!set.has(w)) continue;
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const members = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        members.push(w);
      } while (w !== v);
      if (members.length > 1) {
        for (const m of members) comp.set(m, compId);
        compId += 1;
      }
    }
  };
  for (const v of objects) if (!index.has(v)) connect(v);
  return comp;
}

/** Topological depth from leaves (dependencies first); cycle back-edge -> 0, no loop. */
function topoWaves(objects, adj) {
  const set = new Set(objects);
  const wave = new Map();
  const visiting = new Set();
  const compute = (o) => {
    if (wave.has(o)) return wave.get(o);
    if (visiting.has(o)) return 0;
    visiting.add(o);
    let w = 0;
    for (const d of adj.get(o)?.keys() ?? []) if (set.has(d)) w = Math.max(w, compute(d) + 1);
    visiting.delete(o);
    wave.set(o, w);
    return w;
  };
  for (const o of objects) compute(o);
  return wave;
}
