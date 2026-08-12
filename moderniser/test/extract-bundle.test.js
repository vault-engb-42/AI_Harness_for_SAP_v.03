import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBundle, invariantInput, createBundleCache } from "../src/extract/bundle.js";

// gap-2b B4 — bundle assembly. Merges engine 1 (ast-reader) + engine 2 (bdef-dcl) + the analyser's
// CPG graph into ONE per-side feature bundle: the 4-field `invariantDiff` input, the parity
// classify/deduction signals, and the CPG nodes/edges the diff keys on. Hash-keyed by the
// analyser's `source_hash` so a revisit is O(1), not a re-parse (devepos R2 / the 100K-LOC NFR).

const clazz = (body) => `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_x IMPLEMENTATION. METHOD m.
${body}
ENDMETHOD. ENDCLASS.`;

const FILES = [
  { filename: "zcl_x.clas.abap", source: clazz(`  AUTHORITY-CHECK OBJECT 'S_DEVELOP' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  DATA lv_amount TYPE dmbtr.
  COMMIT WORK.`) },
  { filename: "zc_x.dcls.asdcls", source: `@EndUserText.label: 'x'
define role zc_x { grant select on zi_x where (carrid) = aspect pfcg_auth( S_CARRID, ACTVT ); }` },
  { filename: "zbp_x.bdef.asbdef", source: `managed implementation in class zbp_x unique;
define behavior for ZI_X alias X lock master { association _Item; }
define behavior for ZI_Item alias Item lock dependent by _X { }` },
];

test("assembles the 4-field invariantDiff input from BOTH engines", () => {
  const b = assembleBundle(FILES);
  assert.deepEqual(b.auth_checks, [{ object: "S_DEVELOP", field: "ACTVT", dummy: false, subrc_checked: true }]);
  assert.deepEqual(b.dcl_restrictions, [{ object: "S_CARRID", entity: "ZI_X" }]);
  assert.equal(b.commit_work, 2, "the COMMIT WORK statement PLUS the managed BDEF save boundary (F9)");
  assert.deepEqual(b.privileged_cds, []);
  assert.deepEqual(Object.keys(invariantInput(b)).sort(),
    ["auth_bdef", "auth_checks", "commit_work", "dcl_grants", "dcl_restrictions", "privileged_cds", "unreadable"]);
});

test("carries the parity signals: money operands, statement kinds, RAP edges, deduction counters", () => {
  const b = assembleBundle(FILES);
  assert.deepEqual(b.money_operands, [{ field: "LV_AMOUNT", type: "CURR" }]);
  assert.deepEqual(b.rap_edges, [
    { kind: "composition", source: "ZI_X", target: "_ITEM" },
    { kind: "lock", source: "ZI_ITEM", target: "ZI_X" },
  ]);
  assert.equal(b.cfg_branches, 1, "the IF is one CFG branch");
  assert.equal(b.max_nesting, 1);
  assert.equal(b.exception_paths, 0);
  assert.equal(b.client_specified, 0);
});

test("source_hash is the analyser's, and the cache makes a revisit O(1) — same frozen object back", () => {
  const cache = createBundleCache();
  const first = assembleBundle(FILES, { cache });
  const second = assembleBundle([...FILES].reverse(), { cache });
  assert.match(first.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(second, first, "order-independent hash → cache HIT returns the identical object");
  assert.equal(cache.size, 1);

  const changed = assembleBundle([{ ...FILES[0], source: clazz("  COMMIT WORK. COMMIT WORK.") }, FILES[1], FILES[2]], { cache });
  assert.notEqual(changed.source_hash, first.source_hash, "a changed source set MISSES");
  assert.equal(changed.commit_work, 3, "two COMMIT WORK statements plus the managed BDEF boundary");
  assert.equal(cache.size, 2);
});

test("file_hashes are per-file (the reassembly-veto input) and stable", () => {
  const b = assembleBundle(FILES);
  assert.deepEqual(Object.keys(b.file_hashes).sort(), ["zbp_x.bdef.asbdef", "zc_x.dcls.asdcls", "zcl_x.clas.abap"]);
  for (const h of Object.values(b.file_hashes)) assert.match(h, /^[0-9a-f]{64}$/);
  assert.deepEqual(assembleBundle(FILES).file_hashes, b.file_hashes);
});

test("CPG nodes/edges + blast radius come from a supplied analysis doc; absent → empty, never throws", () => {
  const analysis = {
    graph: { nodes: [{ id: "ZCREATE_ASSET", kind: "report" }], edges: [{ source: "ZCREATE_ASSET", target: "LFB1", kind: "uses-table", evidence: "a.prog.abap:9" }] },
    blast_radius: [{ object: "LFB1", successor_kind: "CDS_STOB" }],
    modernization_plan: { objects: [{ transformations: [{ kind: "clean-core", released_successor: null }] }] },
  };
  const withDoc = assembleBundle(FILES, { analysis });
  assert.deepEqual(withDoc.cpg_edges, [{ source: "ZCREATE_ASSET", target: "LFB1", kind: "uses-table" }],
    "evidence (file:line) is DROPPED — CPG-node granularity, so a comment shift is not an edge change");
  assert.deepEqual(withDoc.cpg_nodes, ["ZCREATE_ASSET"]);
  assert.deepEqual(withDoc.blast_radius, [{ object: "LFB1", successor_kind: "CDS_STOB" }]);

  const bare = assembleBundle(FILES);
  assert.deepEqual(bare.cpg_edges, []);
  assert.deepEqual(bare.cpg_nodes, []);
  assert.deepEqual(bare.blast_radius, []);
  assert.doesNotThrow(() => assembleBundle(FILES, { analysis: { graph: null, blast_radius: "nope" } }));
});

test("total: empty / malformed file sets yield an inert bundle", () => {
  const b = assembleBundle([]);
  assert.deepEqual(b.auth_checks, []);
  assert.equal(b.commit_work, 0);
  assert.equal(b.max_nesting, 0);
  assert.doesNotThrow(() => assembleBundle(null));
});

test("F-1: `access` survives the projection — a write and a read to the same table are not the same fact", () => {
  const analysis = {
    graph: {
      nodes: [{ id: "ZR_ORD", kind: "report" }],
      edges: [{ source: "ZR_ORD", target: "ZORDERS", kind: "uses-table", access: "write", evidence: "z.prog.abap:12" }],
    },
  };
  const out = assembleBundle(FILES, { analysis });
  assert.deepEqual(out.cpg_edges, [{ source: "ZR_ORD", target: "ZORDERS", kind: "uses-table", access: "write" }],
    "evidence is still dropped (node granularity) but the ACCESS MODE is evidence, not noise");
});
