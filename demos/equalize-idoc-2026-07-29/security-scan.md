# Security scan — `equalize-idoc` ingestion gate

External Code Ingestion 4-layer scan (security.md), run in an isolated sub-agent over a sandbox clone
**outside** the project root before any source entered `before/source/`.

- **Repo / SHA scanned:** `engswee/equalize-idoc-framework` @ `0d08659a9633d7c54be5da959d7839ce4c38fb8f`
- **Date:** 2026-07-29 · **Sandbox retained:** `~/tmp/security-scan-equalize-idoc/` (for re-probe)
- **Corpus:** 88 files — 37 pure-ASCII `.abap`, 51 UTF-8-BOM `.xml`, LICENSE/README/.abapgit.xml

## GATE VERDICT: **CLEAN** (worst finding LOW, design-intent) — ingest permitted

- **Layer 1 — Prompt injection:** CLEAN. Zero injection phrases / model-vendor mentions / template markers;
  all `.abap` pure ASCII (no zero-width/RTL/homoglyph bytes possible); XML BOM only; no ≥200-char base64/hex.
- **Layer 2 — Malicious ABAP:** CLEAN. 30 `CALL FUNCTION` sites, all literal standard SAP FMs
  (IDOC_INBOUND_ASYNCHRONOUS, EDI_DOCUMENT_*, BAPI_*, …). No `GENERATE SUBROUTINE`/`INSERT REPORT`/`SUBMIT`/
  `CALL 'SYSTEM'`/`SXPG_*`/`EXEC SQL`/dynamic `FROM (var)`/suspicious paths. Two LOW design-intent dynamic
  constructs:
  - `src/zcl_idoc_base.clas.abap:293` — `CREATE OBJECT o_interface TYPE (lv_classname)` where `lv_classname`
    is `SELECT SINGLE idoc_class FROM zbc_idoc_cfg` (transport-controlled admin config, NOT IDoc payload) —
    standard strategy/factory pattern.
  - `src/zbc_v_idoc_opt.fugr.viewproc_zbc_v_idoc_opt.abap:26,43` — SAP-generated SE54 table-maintenance
    `PERFORM (X_HEADER-FRM_*) IN PROGRAM`; `X_HEADER` populated by the SVIM framework, no user-reachable var.
  - Posture note (not a finding): no `AUTHORITY-CHECK` — inbound IDoc auth is delegated to the ALE layer.
- **Layer 3 — Supply chain:** CLEAN. MIT LICENSE (© 2019). No `.gitmodules`/`.gitattributes`/submodules/LFS,
  no binaries, 88 files (well under limits). Maintainer = Eng Swee Yeoh (established SAP integration author).
- **Layer 4 — Secrets:** CLEAN. No keys/tokens/PEM/credentials; only URLs are the SAP XML namespace +
  blogs.sap.com; RFC destination is config-driven (`SELECT logdes FROM edipoa`), no literals.

**Re-scan by SHA on every fresh pull** (a repo clean today may change).
