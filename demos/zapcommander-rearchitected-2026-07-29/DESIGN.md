# zapcommander → Clean-Core re-architecture — DESIGN blueprint (design gate)

**Status:** awaiting operator approval at the design gate (CLAUDE.md: "Human gates … after design …").
Nothing is generated until this blueprint is approved.

**Lane:** greenfield (`/abap-design` → `/abap-implement` → `/abap-validate`) — this is a **rebuild**, not a
port. The moderniser demo (`../zapcommander-acceptance-2026-07-28/`) already proved *why* the classic app
cannot be ported (60% ported / 40% sealed, verdict = re-architect/retire). This demo is the re-architecture
it pointed to.

---

## 1. The honest target

Deliver the **Cloud-legal capability** of a dual-pane object/file browser as a **100% Clean-Core (Level A)
ABAP Cloud app** — measurably **zero `NEEDS_MANUAL_SEAM`** (the moderniser output had 136) — and **retire**
the two capabilities SAP prohibits in ABAP Cloud, recording each in a **dropped-features ledger** rather than
faking a Cloud API for it.

**"100%" means:** the generated artifact is Level A — released APIs only, 0 seams, 0 greenfield-lint errors,
0 gap-2a hits — for the **retained scope**. Activation + ATC + ABAP Unit remain DEV-creds-gated (P6: offline
never GREENs). This is *not* a claim that every classic feature survives; it is a claim that everything we
*keep* is real Clean Core, and everything we *drop* is honestly documented.

**Same UX paradigm, Cloud-legal substance:** the dual-pane tree-navigation interaction survives; what the
panes browse changes from "OS/server files" to the entities Clean Core actually permits.

---

## 2. Capability disposition — every classic feature, mapped

| Classic capability | Disposition | Clean-Core realization (grounded) |
|---|---|---|
| Navigate a hierarchical tree (folders/items), two panes | **RETAINED** | Managed draft RAP BO, node entity with **self-association + `@Hierarchy.parentChild` recursive hierarchy** (grounding: composition ≠ tree) |
| Persist navigation/session state | **RETAINED** | RAP **draft** table (replaces `EXPORT/IMPORT … indx` cluster) |
| Browse SAP repository objects (packages/classes/CDS) | **RETAINED, scoped** | **XCO** (`XCO_CP_ABAP_REPOSITORY`) via a RAP **custom entity + `IF_RAP_QUERY_PROVIDER`** — **released + customer objects only** (XCO cannot see arbitrary SAP repo — scoped honestly) |
| Upload / download file content | **RETAINED** | RAP **stream / large object** (`@Semantics.largeObject` + `@Semantics.mimeType`) over OData V4; the file dialog lives in Fiori, not ABAP |
| Read a remote system | **RETAINED, re-scoped** | **Released outbound**: communication arrangement + `CL_HTTP_DESTINATION_PROVIDER` + `IF_WEB_HTTP_CLIENT` (NOT the unreleased `IF_HTTP_CLIENT`) — reads a remote **released HTTP/OData surface**, not a remote OS directory |
| Authorization | **RETAINED** | BDEF `authorization master` + `GET_GLOBAL_/GET_INSTANCE_AUTHORIZATIONS` + CDS **DCL** `pfcg_auth` (P4) |
| Dynamic factory dispatch (`CREATE OBJECT (var)`) | **RETAINED** | Static released factory / sealed enum |
| Dual-pane UI, toolbar, context menu | **RETAINED, re-platformed** | **Fiori Elements** (List Report + Object Page) via `service definition` + `service binding` (OData V4); actions/menus are RAP actions surfaced as FE buttons |
| **Execute an OS command** (`CALL 'SYSTEM'`, SXPG) | **🔴 RETIRED** | **No Cloud form** — SXPG unreleased, prohibited by design (KBA/SXPG doc). Dropped; recorded in the ledger |
| **Browse an arbitrary application-server directory** (`OPEN DATASET`, AL11) | **🔴 RETIRED** | **No Cloud form** — `OPEN DATASET` not allowed in ABAP Cloud (KBA 3648256), AL11 absent. Dropped; recorded in the ledger. (Content that matters is re-modelled as node entities + streams.) |
| Frontend OS-shell "execute file" (`gui_execute_file`) | **🔴 RETIRED** | Client-side shell exec has no Cloud form. Dropped |

---

## 3. Object set to generate (the build plan)

**Package:** `ZAPC_CLOUD` (proposed). All names `Z…`, released-API-only.

**Data model (CDS):**
- `ztapc_node` — persisted node table (uuid, parent_uuid, name, node_type, byte_size, mime_type, content `RAWSTRING`, admin fields).
- `ZI_ApcNode` — interface view; self-assoc `_Parent`/`_Children`, `@Hierarchy.parentChild`, `@Semantics.largeObject` on `content`.
- `ZC_ApcNode` — projection (consumption) view + metadata extension (FE annotations: tree, object page, upload/download).
- `ZI_ApcRepoObject` (**custom entity**, read-only) — repository pane; typed to XCO output.
- `ZI_ApcRemoteItem` (**custom entity**, read-only) — remote pane; typed to the outbound read.

**Behavior (RAP):**
- `ZI_ApcNode` **managed, with draft**, `authorization master ( instance )`; standard `create/update/delete`, action `createChild`, action `attachContent` (stream); projection BDEF `ZC_ApcNode`.
- DCL `ZI_ApcNode` — `grant select … pfcg_auth( … )`.

**ABAP classes (behavior pools + query providers):**
- `ZBP_ApcNode` — managed behavior pool: `GET_INSTANCE_AUTHORIZATIONS`, `createChild`, `attachContent`, validations/determinations.
- `ZCL_ApcRepoQuery` — `IF_RAP_QUERY_PROVIDER`, calls XCO (`xco_cp_abap_repository`) for the repo pane.
- `ZCL_ApcRemoteQuery` — `IF_RAP_QUERY_PROVIDER`, released outbound (`CL_HTTP_DESTINATION_PROVIDER` + `IF_WEB_HTTP_CLIENT`) for the remote pane.

**Service:**
- `ZUI_ApcBrowser` service definition (exposes `ZC_ApcNode` + both custom entities).
- `ZUI_ApcBrowser_O4` service binding (OData V4 UI) → Fiori Elements.

**Tests (ABAP Unit, released `cl_abap_behv_test_*`):**
- `ZBP_ApcNode` handler tests (auth verdict, createChild, attachContent) via RAP BO test doubles — **real, no mocks**.
- `ZCL_ApcRepoQuery` / `ZCL_ApcRemoteQuery`: unit-test the pure request→XCO/HTTP-request mapping; the live XCO/HTTP round-trip is **documented DEV-gated** (tdd.md "not reachable without live service"), never mocked.

**Waves:** (0) table + `ZI_ApcNode` + DCL → (1) managed BDEF + `ZBP_ApcNode` + tests → (2) custom entities + query classes → (3) projection + service def/binding + FE metadata.

---

## 4. What proves the claim (acceptance)

- **0 `NEEDS_MANUAL_SEAM`** across the generated source (vs 136 in the moderniser output) — the headline metric.
- **0 greenfield-lint errors**, **0 gap-2a hits**, every referenced API grounded via `ground_released_apis`.
- Analyser AFTER → **Level A / 100% Cloud-ready**, and `validate_fe_descriptor` green on the FE binding.
- **Dropped-features ledger** committed (`dropped-features.json`) — the 3 retired capabilities, each with the grounding basis for *why* no Cloud form exists.
- Same demo shape as the others: README + before/after framing + proof bundle. Offline still BLOCKs at the live gate (P6) — the artifact is Level A, but activation/ATC/AUnit are DEV-gated.

---

## 5. Two decisions for the operator at this gate

1. **Retained-scope definition (§2).** Confirm the "same UX, Cloud-legal substance" reframe: the panes browse **released/customer repository objects + RAP-persisted content nodes + a remote released surface**, NOT the OS/AL11 filesystem. If you want a different retained scope (e.g. drop the remote pane, or add a specific released business-object browser), say so now.
2. **IP / clean-room — can the generated source be committed to the PUBLIC MIT repo?** The re-arch is designed from the **capability** (this blueprint) + **released SAP APIs**, generated **clean-room** (the generator works from this spec, not from zapcommander's GPLv3 source) → it is **original MIT work, not a GPLv3 derivative**, so it **can** be committed (and a greenfield demo's whole value is showing the generated code). Recommendation: **commit the re-arch source** (unlike the GPLv3 moderniser output). Confirm, or say "gitignore it too" and I'll ship analysis+proof only.

---

## 6. Honest limits (unchanged invariants)

- **Offline never GREENs (P6).** This produces a Level-A *artifact* + Level-A *lint*; activation, ATC (`ABAP_CLEAN_CORE_DEVELOPMENT`), and ABAP Unit need a live DEV tier.
- **We are dropping real functionality.** OS exec + arbitrary server-FS browse are gone — that is the honest cost of Clean Core for this app, recorded, not hidden.
- **XCO scope is a real limit.** The repository pane shows released + customer objects only; it is not an SE80 whole-repository browser, because Clean Core does not permit that.
