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
| **Covered by shipped packs** | **131 (85%)** |
| No-code catalog rows | 8 (6 covered — registry lookups = `released-api`; deprecated FM/table rows = regex data) |
| **Total covered** | **137 / 162** |

Where they live:
- **regex-pack** — 106 data rows ([data/regex-rules.json](data/regex-rules.json)): ABAP-Cloud forbidden constructs, S/4 simplification/field-length, security, deprecated APIs.
- **statement-pack** — 22 coded rules: in-loop cluster (N+1, DML, RAP, COMMIT, HTTP, scalar-fn, FREE, SORT, COLLECT, running-total, ASSIGN COMPONENT), guards (FAE, RAP MODIFY), lookbacks (sort-after-select, binary-search-no-order-by), statement patterns (enqueue-no-wait, no-package-size, select-single-no-where, limit-no-filter, excessive keys), file-level (repeated select-single, cds-join-candidate), blocks (data-in-block, bapi-in-enhancement).
- **metadata-pack** — 14 data rows with `when`/`unless` gates: draft locking/timeout, analytical annotations, virtualElement, expand caps, numbering, deep-create, mixed implementation, usage-type contract.
- **cds-structure-pack** — 10 coded rules: join-graph size/cycles, serviceQuality mismatch, calc-fields in WHERE/JOIN, business logic, field order, VDM layering.
- **graph-pack** — god-object / fan-out / dependency cycles. **missing-test-class** (HARDY-10). **released-api** (CLOUD-23/24/25 + registry rows). **invariant-auth-check** (SEC-8, P4).

## Deferred (25) — each needs a surface the analyser does not parse yet

| Needs | Rules | What unblocks |
|---|---|---|
| DDIC XML (TABL/DTEL via abapGit `*.tabl.xml`, `*.dtel.xml`) | PERF-49, 50, 51, 52, 53, 55 | parse abapGit XML into table/element metadata (abaplint supports the file type) |
| Service-binding (SRVB) artifacts | PERF-21, 30 | SRVB parsing — not in scope of source bundles today |
| INTF signature analysis | PERF-47, 48 | method-signature model over `getObjectsByType("INTF")` |
| Cross-artifact joins (BDEF↔CDS↔table) | PERF-71, 72 | child-entity resolution across the bundle |
| Business-function ownership data | CLOUD-34 | bundled SFW ownership map (dataset not in the cloudification bundle) |
| CFG/DFG | PERF-34, HARDY-6 (PERF-1 has a shipped regex approximation) | the deferred data-flow layer (arch doc §9) |
| Clone detection | HARDY-2 | dedicated duplicate-block algorithm (TALOS used clone_detector.py) |
| Strict-mode cross-object context | CC-3, CC-4 | BDEF strict-level propagated to handler classes |
| FP-prone heuristics (need semantic judgment) | PERF-5, 10, 31 | better modeled as evaluator/LLM review than regex — flagging every loop calc would drown the report |
| Test-coverage mapping | CLEAN-015, CLEAN-019 | test-method↔method association model |
| App-level UI aggregation | CLOUD-28 | line-level variants shipped (CLOUD-006/014/015); the app-level rollup needs object grouping |

## Regression protocol

When adding rules: extend the relevant pack's data file (regex/metadata) or add
a coded rule module; every rule carries its TALOS code in the finding message;
re-run the code-keyed gap analysis to update this table. Extracted patterns are
never trusted raw — validate compile + positive/negative examples in Node
before writing (the pipeline caught both hallucinated-shape and shell-mangling
failures).
