# Transport Evidence — Release Proof Pack

> One-screen proof pack the human reads **before** releasing the transport.
> The harness assembles and attests; **the human releases (P5, segregation of duties).**
> Companion to `specs/delivery/transport-evidence.json` — every field below is transcribed
> verbatim from that pack and the upstream verdicts. Nothing here is re-graded.

---

## Bundle status: `<bundle_status>`

`<bundle_status>` is one of: **release-ready** · **binding-unverified** · **split-delivery** · **blocked-upstream**

- **release-ready** — every gate passed, binding verified, no split. Human may release.
- **binding-unverified** — every gate passed, but `get_transport_requests` is stubbed
  (`data_available:false`), so the transport binding could not be confirmed from the system.
  Human must confirm the binding manually before release. (This is the honest status today.)
- **split-delivery** — the dependency-group objects are spread across more than one transport.
  Consolidate into ONE transport before release — releasing a subset half-activates the feature.
- **blocked-upstream** — a gate failed or a verdict is missing. NOT releasable. See the blocker below.

| Field | Value |
|-------|-------|
| Timestamp (UTC) | `<timestamp>` |
| DEV tier validated on | `<connection>` |
| Clean-Core level (target) | **`<clean_core_level>`** — MUST be **A** (P1: released APIs + BAdI/RAP/CDS-extend only) |

---

## Transport

<!-- When get_transport_requests returned data_available:true, fill the id/description below.
     When data_available:false (current reality), the id is null — show the banner instead. -->

> ⚠️ **BINDING UNVERIFIED — `get_transport_requests` stub (`data_available:false`).**
> The transport binding could not be read from the system. Confirm manually that every object
> below is locked into ONE modifiable request before you release. (Delete this banner and fill
> the table only when the transport signal is live and `transport_binding.verified` is `true`.)

| Field | Value |
|-------|-------|
| Transport id | `<transport.id>`  *(or `null` — see banner above)* |
| Description | `<transport.description>` |
| Modifiable | `<transport.modifiable>` |

### Object list (the dependency group — ships as a unit or not at all)

<!-- A RAP feature is a SET: CDS view entity + projection + behavior definition +
     behavior implementation class + service definition/binding + ABAP Unit test class.
     Every object from sap-verdict.json objects[] MUST appear here. -->

| # | Object (type + name) | Bound to transport? |
|---|----------------------|---------------------|
| 1 | `<ZI_Entity>` (CDS view entity) | `<bound | expected — binding unverified>` |
| 2 | `<ZC_Entity>` (CDS projection view) | `<bound | expected — binding unverified>` |
| 3 | `<ZI_Entity>` (behavior definition) | `<bound | expected — binding unverified>` |
| 4 | `<ZBP_I_Entity>` (behavior implementation class) | `<bound | expected — binding unverified>` |
| 5 | `<Z_Entity_SRVD>` / `<Z_Entity_SRVB>` (service definition / binding) | `<bound | expected — binding unverified>` |
| 6 | `<ZCL_..._TEST>` (ABAP Unit test class) | `<bound | expected — binding unverified>` |

**Binding check:** `transport_binding.verified = <true | false>`
· reason: `<transport_binding.reason>`
· objects unbound or split: `<objects_unbound_or_split — MUST be empty for release-ready>`

---

## Gate evidence (transcribed from `specs/reviews/*.json` — not re-run)

### Gate 5 — Activation + ATC  (source: `specs/reviews/sap-verdict.json`)

| Metric | Value | Required |
|--------|-------|----------|
| Verdict | `<verdict>` | PASS or WARN (BLOCK ⇒ blocked-upstream) |
| ATC variant | `ABAP_CLEAN_CORE_DEVELOPMENT` | fixed (P6) |
| **ATC priority-1 count** | **`<atc.priority1.count>`** | **MUST be 0** (P6) |
| **ATC priority-2 count** | **`<atc.priority2.count>`** | **MUST be 0** (P6 — SAP blocks transport on priority-2) |
| ATC priority-3 (notify) count | `<atc.priority2_3.count>` | recorded for the human to weigh |
| Activation errors | `<activation.errors — MUST be empty>` | none |

<!-- If atc.priority1 or atc.priority2 is non-empty, bundle_status is blocked-upstream, not release-ready. -->

### Gate 5 — ABAP Unit + coverage ratchet

| Metric | Value | Required |
|--------|-------|----------|
| Failed tests | `<abap_unit.failed — MUST be empty>` | none |
| Coverage | `<abap_unit.coverage_pct>` % | ≥ baseline |
| Coverage baseline | `<abap_unit.coverage_baseline_pct>` % | ratchet floor (evaluator's ledger) |

### Gate 5 — Service delivery  (source: `specs/reviews/sap-verdict.json` `published_services[]`)

<!-- Only rows for objects that publish an OData service (SRVB). A CDS-/class-only change publishes
     nothing — omit this table. A published SRVB whose $metadata is unreachable is a BLOCK upstream. -->

| Service binding | Published OData URL | `$metadata` reachable |
|-----------------|---------------------|-----------------------|
| `<published_services[].service_binding>` | `<published_services[].service_url>` | `<published_services[].metadata_reachable>` — MUST be **true** |

### Gate 7 — Security / P4 invariants  (source: `specs/reviews/security-verdict.json`, `pass = <security_verdict.pass>`)

The immutable invariants — the invariant diff between brownfield source and the change.
**All four MUST be `false`** (no weakening):

| Invariant (P4) | Weakened / suppressed / dropped? |
|----------------|----------------------------------|
| `AUTHORITY-CHECK` weakened | `<invariant_diff.authority_check_weakened>` — MUST be **false** |
| `COMMIT WORK` suppressed (classic save) | `<invariant_diff.commit_work_suppressed>` — MUST be **false** |
| `COMMIT ENTITIES` suppressed (RAP save, P4b) | `<invariant_diff.commit_entities_suppressed>` — MUST be **false** |
| `SY-SUBRC` check dropped (after AUTHORITY-CHECK) | `<invariant_diff.sy_subrc_check_dropped>` — MUST be **false** |

### Gate 8 — Diff cold-read  (source: `specs/reviews/diff-review-verdict.json`, `pass = <diff_review_verdict.pass>`)

Zero BLOCK correctness findings required. `pass = <diff_review_verdict.pass>` (MUST be `true`).

---

## Release action

| | |
|-|-|
| Next action | `<release_gates.next_action>`  *(e.g. human releases transport DEV → QAS)* |
| Owner | **`<release_gates.owner>` — human** |
| Confirm first | `<release_gates.notes>`  *(e.g. transport binding is unverified because the signal is stubbed)* |

---

**Release action is yours (P5, segregation of duties).**
