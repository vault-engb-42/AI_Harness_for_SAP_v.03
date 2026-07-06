# TALOS Rule-Parity Accounting

Status as of 2026-07-03. Source of truth for what is ported, how coverage is
measured, and why each remaining rule is deferred. The full catalog (352 rules,
extracted from the 13 TALOS rule files by a parallel-reader workflow and keyed
by TALOS rule code) lives in [talos-catalog.json](talos-catalog.json).

## Method

Rules are joined on the canonical TALOS code (`ABAP-PERF-NN`, `CLOUD-NN`,
`S4-NN`, `HARDY-NN`, `SEC-NN`, `CC-NN`, `ABAP-N1/OB1`), deduplicated across
catalog groups. A rule counts as covered only if a shipped pack implements it
(id or message carries the code, or a coded rule is hand-mapped).

## Coverage

| Bucket | Count |
|---|---|
| Distinct coded port-worthy rules | 154 |
| **Covered by shipped packs** | **154 (100%)** |
| No-code catalog rows | 8 — all covered (registry lookups = `released-api`; deprecated FM/table rows = regex data; CLEAN-015/019 = test-quality-pack) |
| **Total covered** | **162 / 162** — *full parity, with the approximations below stated openly* |

**2026-07-04: the final 25 deferrals were implemented** by building the missing
surfaces: DDIC XML (ddic-pack), cross-artifact RAP context (rap-context-pack),
flow/window analyses (flow-pack), clone detection (clone-pack), test-quality
mapping (test-quality-pack), INTF signatures (intf-pack), SRVB chain
(srvb-pack), and the bundled business-function datasets (bf-pack).

Where they live:
- **regex-pack** — 100 data rows ([data/regex-rules.json](data/regex-rules.json)): ABAP-Cloud forbidden constructs, S/4 simplification/field-length, security, deprecated APIs. Engine supports `when` file-gates (RAP-handler rules fire only inside behavior handler/saver classes) and `scan_comments` rows (modification markers); trailing/full-line `"` comments are stripped before matching, string literals stay inspectable. *(2026-07-03 audit remediation: 6 rows removed — cloud-005/cloud-021/perf-14 moved to statement-pack for multi-line safety, perf-33 diverged twin deleted, 2 TRANSPORTING-NO-FIELDS dupes deleted.)*
- **statement-pack** — 25 coded rules: in-loop cluster (N+1, DML, RAP, COMMIT, HTTP, scalar-fn, FREE, SORT, COLLECT, running-total, ASSIGN COMPONENT), guards (FAE incl. early-return polarity, RAP MODIFY), lookbacks (sort-after-select, binary-search-no-order-by), statement patterns (enqueue-no-wait, no-package-size, select-single-no-where, limit-no-filter, excessive keys, class-not-final CLOUD-005), coded DB-write check (CLOUD-021 with declared-itab exclusion), FAE non-PK WHERE prefix (PERF-14, PK-allowlist heuristic), file-level (repeated select-single, cds-join-candidate), blocks (data-in-block, bapi-in-enhancement).
- **metadata-pack** — 14 data rows with `when`/`unless` gates: draft locking/timeout, analytical annotations, virtualElement, expand caps, numbering, deep-create, mixed implementation, usage-type contract.
- **cds-structure-pack** — 10 coded rules: join-graph size/cycles, serviceQuality mismatch, calc-fields in WHERE/JOIN, business logic, field order, VDM layering.
- **graph-pack** — god-object / fan-out / dependency cycles. **missing-test-class** (HARDY-10). **released-api** (CLOUD-23/24/25 + registry rows). **invariant-auth-check** (SEC-8, P4).
- **ddic-pack** — abapGit TABL/DTEL/DOMA XML: cluster/pool category p1 (PERF-53), client-only key (PERF-55), buffered-table writes (PERF-52), conversion-exit DTELs (PERF-49), Z-DTEL-on-SAP-domain (PERF-50), classic append on a SAP table (CLOUD-29). Also feeds the statement-pack's DDIC-aware FAE check (PERF-51: real keys + secondary-index leads; PERF-14 heuristic only as out-of-bundle fallback).
- **rap-context-pack** — BDEF joined to classes/tables: strict-mode CALL TRANSACTION / direct DB writes p1 (CC-3/CC-4), draft-child direct create p1 (PERF-71), late-numbering draft table without DRAFTUUID key p1 (PERF-72), unbounded SELECT in FOR READ methods p1 (PERF-10).
- **flow-pack** — statement-window analyses: lock held across external calls (PERF-34), dangling loop-assigned field symbols (HARDY-6), heavy per-row loop calculation advisory (PERF-5, threshold 8), unfiltered GET_ENTITYSET (PERF-31), legacy-UI app rollup (CLOUD-28, threshold 3).
- **clone-pack** — 6-line duplicate-block detection, one finding per file (HARDY-2).
- **test-quality-pack** — assert-less FOR TESTING methods p2 (CLEAN-015), public methods never referenced by the test include p3 (CLEAN-019).
- **intf-pack** — table-returning interface methods without paging params (PERF-47), per-row methods without batch siblings (PERF-48).
- **srvb-pack** — SRVB→SRVD→CDS chain joined by raw content: exposed entity without a paging policy p1 (PERF-21), large entity over OData V2 offset paging p2 (PERF-30). Fail-quiet when the chain is incomplete in the bundle.
- **bf-pack** — bundled business-function datasets ([data/business-functions/](../data/business-functions/), SAP Notes 2240359/2240360 cross-walk): probing an always-off BF p1, depending on an object owned by one p1 (CLOUD-34).

## Known approximations (updated 2026-07-04, documented rather than over-claimed)

- **PERF-58**: the base rule (`talos-select-single-no-where`) flags SELECT
  SINGLE with NO WHERE; the partial-key refinement
  (`talos-select-single-partial-key`) fires for in-bundle tables when the WHERE
  constrains at least one but not all non-client key fields. Out-of-bundle
  tables, single-field keys, and key-`.INCLUDE` tables stay silent (never guess).
- **PERF-14**: allowlist heuristic ONLY when the target table is not in the
  bundle; in-bundle tables get the precise PERF-51 key/index check.
- **PERF-41**: BDEF grammar has no payload-cap syntax; the rule flags
  deep-create *enablement* (association `{ create; }`) as priority-3 advisory.
- **PERF-23**: `total etag` / `@Semantics.systemDate.lastChangedAt` accepted
  as the concurrency guard alongside `lockingMode`.
- **PERF-1**: regex approximation (SELECT * projection); true consumed-fields
  analysis needs DFG.
- **PERF-49/50**: flag the DTEL itself (conversion-exit domain / SAP-domain
  reuse hint) — the "hot SELECT projection" and "same label" halves need
  usage/catalog data the bundle does not carry.
- **PERF-5**: threshold-calibrated (8 arithmetic assignments per loop) at
  priority-3 to avoid drowning the report; only *spaced* arithmetic operators
  count (an unspaced `struct-comp` field selector and `/`/`-` inside string
  literals do not). PERF-31 fires only on unfiltered SELECTs inside
  `*get_entityset*` methods. CLOUD-28 (legacy-UI rollup) aggregates per object
  across includes; the PERF-34 lock window and HARDY-6 dangling-field-symbol
  checks reset at method boundaries, and HARDY-6 treats `IS [NOT] ASSIGNED` /
  `IS BOUND` as a defensive guard.
- **PERF-21/30, CC-3/4, PERF-71/72, PERF-10**: cross-artifact rules judge only
  when the joined artifact is IN the bundle; incomplete chains stay silent
  rather than guessing. PERF-10 excludes inherently-bounded reads (SELECT SINGLE,
  FOR ALL ENTRIES); the SRVB→SRVD join matches the exact `<SRVD_NAME>` element
  (not a raw substring) and resolves the CDS by both DDLS source name and
  view-entity name; the BDEF identifier captures accept `/NS/` namespaced names.
- **PERF-55**: fires only when the whole primary key is client-only (MANDT); a
  key `.INCLUDE` hides the included structure's key fields, so the rule stays
  silent rather than mis-prove the key client-only.
- **PERF-47**: the paging-parameter test scans only the parameter region (the
  `METHODS <name>` keyword+name are stripped first) so a table reader named
  `*_top_*` / `*_max_*` is not falsely exempted; recall is still limited to bare
  `STANDARD/SORTED/HASHED TABLE` return types.
- **CLEAN-015/019**: driven off the parsed statement stream of the test include,
  so colon-chained `METHODS:` declarations are handled; an assertion delegated
  to a same-class helper counts (no false "assert-less"); CLEAN-019 uses
  abaplint's numeric `visibility` enum so only genuinely-public methods are
  reported.
- **CLOUD-34**: grounded on a community cross-walk of login-walled SAP Notes
  (see the dataset provenance headers) — refresh the JSONs when SAP updates
  the notes. Owned-object detection (`talos-bf-owned-object-ref`) fires only for
  cross-walk rows whose object name can appear as a dependency-edge target —
  TABL (uses-table), CDS (consumes-cds), classes (inherits/calls). The FUGR rows
  key on the function-GROUP program (SAPL…), which no edge target equals (a
  call-function edge carries the function-MODULE name), so function-group
  ownership is not yet edge-detectable; it needs an FM→function-group map the
  offline bundle does not carry. The rows are retained for that future path.

## Audit remediation (2026-07-06)

The 8 packs added 2026-07-04 (ddic, rap-context, flow, clone, intf,
test-quality, bf, srvb) were the least-vetted code in the build. An adversarial
audit (parallel-agent workflow + a Node validation gate, findings verified by a
default-refute pass) confirmed **16** real defects — 10 MEDIUM + 5 LOW accuracy
issues (false positives/negatives) plus **1 P8 crash**: malformed abapGit TABL
XML made abaplint's DDIC parser throw *outside* the rule-engine's isolation, so
`loadRegistry` now drops only the objects that fail to parse (surfaced as a
`coverage_note`) and never crashes the run. `schema-conformance` came back clean
(no pack emits an out-of-schema field), now locked by a golden additionalProperties
guard. All 16 are remediated with TDD; new golden coverage runs every new pack
end-to-end through `analyzePackage` and new robustness coverage feeds
malformed/hostile DDIC + service XML. See the accuracy refinements folded into
the approximations above.

## Regression protocol

When adding rules: extend the relevant pack's data file (regex/metadata) or add
a coded rule module; every rule carries its TALOS code in the finding message;
re-run the code-keyed gap analysis to update this table. Extracted patterns are
never trusted raw — validate compile + positive/negative examples in Node
before writing (the pipeline caught both hallucinated-shape and shell-mangling
failures).
