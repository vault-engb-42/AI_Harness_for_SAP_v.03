import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { overApproximateEdges } from "../src/graph/augment.js";
import { tarjanCondense } from "../src/graph/condense.js";

// §3.1 Stage 1 (L5) — over-approximate the CPG with DYNAMIC edges BEFORE condensing.
// The analyser CPG carries only static code-reference edges (graph.edges). Dynamic
// indirection (CALL FUNCTION <var>, dynamic method/SELECT, PERFORM ON COMMIT, SET
// HANDLER, BTE/FQEVENTS, ENHO/ENHSPOT) is invisible to it. augment scans each node's
// `source` (populated by the later SCOPE/build phase — absent here for the analyser
// boundary artifact) and: resolvable target -> synthetic edge; unresolved dynamic
// target -> node.dynamic_seal = NEEDS_MANUAL_SEAM; a synthetic edge that closes a
// cycle over the code edges -> possible_cycle. Pure function; no I/O.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));
const SEAL = "NEEDS_MANUAL_SEAM";

const seal = (r, id) => r.nodes.find((n) => n.id === id)?.dynamic_seal;
const syn = (r) => r.edges.filter((e) => e.synthetic);

test("a dynamic CALL FUNCTION <var> seals the node and adds no edge", () => {
  const cpg = { nodes: [{ id: "A", source: "CALL FUNCTION lv_fm EXPORTING x = 1." }], edges: [] };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), SEAL);
  assert.equal(syn(r).length, 0, "unresolved target -> seal, not edge");
});

test("a literal CALL FUNCTION is NOT dynamic — no seal, no synthetic edge (analyser owns it)", () => {
  const cpg = { nodes: [{ id: "A", source: "CALL FUNCTION 'POPUP_TO_INFORM'." }], edges: [] };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), undefined);
  assert.equal(syn(r).length, 0);
});

test("PERFORM <form> ON COMMIT (literal) adds a synthetic edge, no seal", () => {
  const cpg = { nodes: [{ id: "A", source: "  PERFORM upd_db ON COMMIT." }, { id: "UPD_DB" }], edges: [] };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), undefined);
  const e = syn(r);
  assert.equal(e.length, 1);
  assert.equal(e[0].source, "A");
  assert.equal(e[0].target, "UPD_DB");
  assert.equal(e[0].kind, "perform-on-commit");
});

test("SET HANDLER m FOR obj (literal handler) adds a synthetic edge, no seal", () => {
  const cpg = { nodes: [{ id: "A", source: "SET HANDLER lcl_h=>on_changed FOR lo_bus." }], edges: [] };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), undefined);
  const e = syn(r);
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, "set-handler");
  assert.equal(e[0].target, "LCL_H=>ON_CHANGED");
});

test("a dynamic PERFORM (var) seals the node", () => {
  const cpg = { nodes: [{ id: "A", source: "PERFORM (lv_form) IN PROGRAM (lv_prog)." }], edges: [] };
  assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL);
});

test("a dynamic method call seals the node", () => {
  for (const src of ["r = lo_obj->(lv_meth).", "CALL METHOD (lv_cls)=>(lv_m).", "x = zcl=>(lv_m)."]) {
    const cpg = { nodes: [{ id: "A", source: src }], edges: [] };
    assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL, src);
  }
});

test("a dynamic SELECT ... FROM (var) seals the node", () => {
  const cpg = { nodes: [{ id: "A", source: "SELECT * FROM (lv_tab) INTO TABLE @lt." }], edges: [] };
  assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL);
});

test("a BTE / FQEVENTS dispatcher seals the node (target is customizing-table-driven)", () => {
  const cpg = { nodes: [{ id: "A", source: "CALL FUNCTION 'OPEN_FI_PERFORM_00001030_P'." }], edges: [] };
  assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL);
});

test("an enhancement construct (ENHANCEMENT / ENHO) seals the node", () => {
  const cpg = { nodes: [{ id: "A", source: "ENHANCEMENT 1 z_enh_impl. ENDENHANCEMENT." }], edges: [] };
  assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL);
});

test("commented-out dynamic constructs are ignored (comment stripping)", () => {
  const cpg = {
    nodes: [
      { id: "A", source: "* CALL FUNCTION lv_fm.\n\" CALL FUNCTION lv_fm2." },
      { id: "B", source: "lv = 'has a \" quote'. CALL FUNCTION lv_fm." },
    ],
    edges: [],
  };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), undefined, "both dynamic calls are inside comments");
  assert.equal(seal(r, "B"), SEAL, "the \" inside a '...' literal is not a comment");
});

test("a synthetic edge that closes a cycle over code edges is tagged possible_cycle", () => {
  const cpg = {
    nodes: [{ id: "A", source: "PERFORM b_form ON COMMIT." }, { id: "B_FORM" }],
    edges: [{ source: "B_FORM", target: "A", kind: "calls" }],
  };
  const e = syn(overApproximateEdges(cpg));
  assert.equal(e.length, 1);
  assert.equal(e[0].possible_cycle, true, "B_FORM already reaches A, so A->B_FORM closes a cycle");
});

test("a synthetic edge NOT closing a cycle is not tagged", () => {
  const cpg = { nodes: [{ id: "A", source: "PERFORM b_form ON COMMIT." }, { id: "B_FORM" }], edges: [] };
  const e = syn(overApproximateEdges(cpg));
  assert.notEqual(e[0].possible_cycle, true);
});

test("a node with no source is an identity — no seal, no synthetic edge", () => {
  const cpg = { nodes: [{ id: "A" }, { id: "B", source: "" }], edges: [{ source: "A", target: "B", kind: "calls" }] };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), undefined);
  assert.equal(seal(r, "B"), undefined);
  assert.equal(syn(r).length, 0);
  assert.equal(r.edges.length, 1, "code edges pass through unchanged");
});

test("code edges pass through preserving their fields alongside synthetic ones", () => {
  const cpg = {
    nodes: [{ id: "A", source: "SET HANDLER lcl=>m FOR o." }, { id: "B" }],
    edges: [{ source: "A", target: "B", kind: "calls", evidence: "f:1" }],
  };
  const r = overApproximateEdges(cpg);
  const code = r.edges.find((e) => !e.synthetic);
  assert.deepEqual(code, { source: "A", target: "B", kind: "calls", evidence: "f:1" });
  assert.equal(r.edges.length, 2);
});

test("the real golden CPG (nodes carry no source) augments to a safe identity", () => {
  const cpg = { nodes: DOC.graph.nodes, edges: DOC.graph.edges };
  const r = overApproximateEdges(cpg);
  assert.equal(syn(r).length, 0, "no source -> no dynamic edges discovered");
  assert.ok(r.nodes.every((n) => n.dynamic_seal === undefined), "no node sealed");
  assert.equal(r.edges.length, DOC.graph.edges.length, "edge set unchanged");
  // augment must not mutate the caller's CPG
  assert.ok(DOC.graph.nodes.every((n) => !("dynamic_seal" in n)), "input nodes untouched");
});

test("augment is deterministic (byte-stable across runs)", () => {
  const mk = () => ({
    nodes: [{ id: "A", source: "SET HANDLER h1 FOR o.\nSET HANDLER h2 FOR o.\nCALL FUNCTION lv_x." }, { id: "H1" }, { id: "H2" }],
    edges: [{ source: "H1", target: "A", kind: "calls" }],
  });
  assert.equal(JSON.stringify(overApproximateEdges(mk())), JSON.stringify(overApproximateEdges(mk())));
});

test("duplicate identical dynamic constructs yield a single synthetic edge", () => {
  const cpg = { nodes: [{ id: "A", source: "SET HANDLER h FOR o.\nSET HANDLER h FOR o." }, { id: "H" }], edges: [] };
  assert.equal(syn(overApproximateEdges(cpg)).length, 1);
});

test("augment output composes with condense into a DAG", () => {
  const cpg = { nodes: DOC.graph.nodes, edges: DOC.graph.edges };
  const g = overApproximateEdges(cpg);
  const c = tarjanCondense(g.nodes.map((n) => n.id), g.edges.map((e) => [e.source, e.target]));
  assert.ok(c.superNodes.length > 0);
  assert.ok(hasNoCycle(c.superNodes.map((s) => s.id), c.edges), "condensation of augmented graph is acyclic");
});

// --- Rule-11 review remediations: under-approximation fixes (the direction L5 forbids) ---

test("enhancement markers woven as abapGit comments still seal (scanned pre-strip)", () => {
  const cpg = {
    nodes: [
      { id: "A", source: "*ENHANCEMENT-POINT RGGBR000_01 SPOTS ES_RGGBR000." },
      { id: "B", source: '"{ Begin ENHO DIMP_GENERAL_RGGBR000 }' },
    ],
    edges: [],
  };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), SEAL, "*-comment ENHANCEMENT-POINT");
  assert.equal(seal(r, "B"), SEAL, '"-comment Begin ENHO');
});

test('a " inside a |...| template or `...` backtick literal is not a comment (no under-strip)', () => {
  const cpg = {
    nodes: [
      { id: "A", source: 'msg = |He said "hi"|. CALL FUNCTION lv_fm.' },
      { id: "B", source: "x = `a\"b`. CALL FUNCTION lv_fm." },
    ],
    edges: [],
  };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), SEAL, "template");
  assert.equal(seal(r, "B"), SEAL, "backtick");
});

test("a genuine inline comment after code is still stripped (no over-seal regression)", () => {
  const cpg = { nodes: [{ id: "A", source: "CALL FUNCTION 'X'. \" CALL FUNCTION lv_y" }], edges: [] };
  assert.equal(seal(overApproximateEdges(cpg), "A"), undefined, "commented dynamic call ignored");
});

test("the '' char-literal escape does not swallow trailing real code", () => {
  const cpg = { nodes: [{ id: "A", source: "x = 'don''t'. CALL FUNCTION lv_fm." }], edges: [] };
  assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL);
});

test("multi-handler SET HANDLER h1 h2 h3 FOR o adds one synthetic edge per handler", () => {
  const cpg = {
    nodes: [{ id: "A", source: "SET HANDLER h1 h2 h3 FOR lo." }, { id: "H1" }, { id: "H2" }, { id: "H3" }],
    edges: [],
  };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), undefined);
  assert.deepEqual(syn(r).map((e) => e.target).sort(), ["H1", "H2", "H3"]);
  assert.ok(syn(r).every((e) => e.kind === "set-handler"));
});

test("a dynamic SET HANDLER (var) seals rather than emitting a malformed edge", () => {
  const cpg = { nodes: [{ id: "A", source: "SET HANDLER (lv_h) FOR lo." }], edges: [] };
  const r = overApproximateEdges(cpg);
  assert.equal(seal(r, "A"), SEAL);
  assert.equal(syn(r).length, 0);
});

test("runtime-codegen and dynamic-dispatch families all seal (taxonomy completeness)", () => {
  const cases = {
    submit: "SUBMIT (lv_rep) AND RETURN.",
    genpool: "GENERATE SUBROUTINE POOL lt_src NAME lv_nm.",
    insrep: "INSERT REPORT lv_nm FROM lt_src.",
    transf: "CALL TRANSFORMATION (lv_x) SOURCE tab = lt.",
    custfn: "CALL CUSTOMER-FUNCTION '001'.",
    swe: "CALL FUNCTION 'SWE_EVENT_CREATE'.",
  };
  for (const [name, src] of Object.entries(cases)) {
    const cpg = { nodes: [{ id: "A", source: src }], edges: [] };
    assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL, name);
  }
});

test("round-2 taxonomy (F8): dynamic write-DML, dynamic transaction, dynamic CREATE OBJECT, kernel BAdI, PERFORM form(prog) ON COMMIT all seal", () => {
  const cases = {
    updDyn: "UPDATE (lv_tab) SET amount = 0.",
    insDyn: "INSERT (lv_tab) FROM @ls_row.",
    modDyn: "MODIFY (lv_tab) FROM TABLE @lt.",
    delDyn: "DELETE (lv_tab) FROM TABLE @lt.",
    callTx: "CALL TRANSACTION lv_tcode.",
    leaveTx: "LEAVE TO TRANSACTION lv_tcode.",
    createDyn: "CREATE OBJECT lo TYPE (lv_class).",
    getBadi: "GET BADI lr_badi.",
    callBadi: "CALL BADI lr_badi->process.",
    performProgCommit: "PERFORM upd_db(zprog) ON COMMIT.",
  };
  for (const [name, src] of Object.entries(cases)) {
    const cpg = { nodes: [{ id: "A", source: src }], edges: [] };
    assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL, name);
  }
});

test("round-2 escapes (F8 verifier): INSERT INTO (var) and PERFORM ... IN PROGRAM ... ON COMMIT seal", () => {
  const cases = {
    insInto: "INSERT INTO (lv_tab) VALUES @ls_row.",
    inProgramCommit: "PERFORM upd_db IN PROGRAM zprog ON COMMIT.",
    inProgramDyn: "PERFORM upd_db IN PROGRAM (lv_prog).", // dynamic program name → unknowable callee
  };
  for (const [name, src] of Object.entries(cases)) {
    const cpg = { nodes: [{ id: "A", source: src }], edges: [] };
    assert.equal(seal(overApproximateEdges(cpg), "A"), SEAL, name);
  }
  // static IN PROGRAM without ON COMMIT stays unsealed (statically resolvable cross-program call)
  const cpg = { nodes: [{ id: "A", source: "PERFORM init IN PROGRAM zstartup." }], edges: [] };
  assert.equal(seal(overApproximateEdges(cpg), "A"), undefined, "plain IN PROGRAM is not a late call");
});

test("round-2 taxonomy (F8): static forms of the same statements stay UNSEALED — no over-trigger", () => {
  const cases = {
    updStatic: "UPDATE ztab SET amount = 0.",
    insStatic: "INSERT ztab FROM @ls_row.",
    delItab: "DELETE lt_rows WHERE amount = 0.",
    modScreen: "MODIFY SCREEN.",
    callTxLit: "CALL TRANSACTION 'MM01' AND SKIP FIRST SCREEN.",
    createStatic: "CREATE OBJECT lo TYPE zcl_static.",
    performPlain: "PERFORM update_totals USING lv_x.",
    performCommitLocal: "PERFORM upd_db ON COMMIT.", // local form → RESOLVABLE synthetic edge, not a seal
  };
  for (const [name, src] of Object.entries(cases)) {
    const cpg = { nodes: [{ id: "A", source: src }], edges: [] };
    assert.equal(seal(overApproximateEdges(cpg), "A"), undefined, name);
  }
});

// --- Phase E verified LOWs (branch-review 2026-07-13, adversarially re-verified) ---

test("L4: an INDENTED '*' line is CODE, not a comment — ABAP comments require column 1", () => {
  // legal vector per the verifier: a chained SELECT whose '*' field list lands on an
  // indented continuation line carrying the dynamic FROM — erasing it under-seals
  const src = "SELECT SINGLE\n  * FROM (lv_tab) INTO @lv_data.";
  const r = overApproximateEdges({ nodes: [{ id: "A", source: src }], edges: [] });
  assert.equal(seal(r, "A"), SEAL, "the continuation line must reach the seal scan");
  // a genuine column-1 comment is still stripped
  const c = overApproximateEdges({ nodes: [{ id: "A", source: "* CALL TRANSACTION lv_tcode." }], edges: [] });
  assert.equal(seal(c, "A"), undefined, "column-1 comments never seal");
});

test("L5: chained resolvable statements on ONE line each emit their edge", () => {
  const src = "PERFORM f1 ON COMMIT. PERFORM f2 ON COMMIT.";
  const r = overApproximateEdges({ nodes: [{ id: "A", source: src }], edges: [] });
  assert.deepEqual(syn(r).map((e) => e.target).sort(), ["F1", "F2"], "the second statement's edge must not be lost");
});

test("L6: ENHANCEMENT raw-seal fires on real markers, not on prose comments", () => {
  const prose = [
    "* enhancement request 4711: rebate logic",
    '" small enhancement for the rebate case',
  ];
  for (const src of prose) {
    const r = overApproximateEdges({ nodes: [{ id: "A", source: src }], edges: [] });
    assert.equal(seal(r, "A"), undefined, src);
  }
  const markers = [
    "*ENHANCEMENT-POINT zep_1 SPOTS zes_1.", //  abapGit comment-serialized marker
    "ENHANCEMENT-SECTION zes_2 SPOTS zsp.", //   statement form
    "ENHANCEMENT 1 zx_impl.", //                 numbered implementation marker
    "END-ENHANCEMENT.",
    '"{ Begin ENHO zenho_impl }',
    "ENHANCEMENT-POINT zep_9.",
  ];
  for (const src of markers) {
    const r = overApproximateEdges({ nodes: [{ id: "A", source: src }], edges: [] });
    assert.equal(seal(r, "A"), SEAL, src);
  }
});

function hasNoCycle(nodes, edges) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [u, v] of edges) { adj.get(u).push(v); indeg.set(v, indeg.get(v) + 1); }
  const q = nodes.filter((n) => indeg.get(n) === 0);
  let seen = 0;
  while (q.length) {
    const n = q.pop();
    seen++;
    for (const w of adj.get(n)) { indeg.set(w, indeg.get(w) - 1); if (indeg.get(w) === 0) q.push(w); }
  }
  return seen === nodes.length;
}
