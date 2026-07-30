# Security scan — `TALV` ingestion gate

External Code Ingestion 4-layer scan (security.md), run in an isolated sub-agent over a sandbox clone
**outside** the project root before any source entered `before/source/`.

- **Repo / SHA scanned:** `AES0P/TALV` @ `427c1bd7b389dca76e839d58c35e6001bc0afe18`
- **Date:** 2026-07-29 · **Sandbox retained:** `~/tmp/security-scan-talv/` (for re-probe)
- **Corpus:** 147 files / 877 KB — 64 `.abap`, 81 UTF-8-BOM `.xml`, LICENSE/README/.abapgit.xml

## GATE VERDICT: **CLEAN** (worst finding LOW, informational) — ingest permitted

- **Layer 1 — Prompt injection:** CLEAN. Zero injection phrases / model-vendor mentions / template markers.
  Byte-level Unicode scan: no RTL/LTR overrides, no bidi isolates, no zero-width chars; the only U+FEFF is a
  legit BOM at offset 0 of each XML. Non-ASCII limited to Chinese author comments + CJK punctuation + German
  umlauts in text/comments; **all identifiers ASCII `Z*`** → no homoglyph attack. No ≥200-char base64/hex.
- **Layer 2 — Malicious ABAP:** CLEAN (one LOW informational). Three dynamic-code constructs, all standard
  classic-ALV framework patterns with **internal / config-driven** inputs (not external):
  - `src/.../zcl_dynamic_tool.clas.abap:911` — `GENERATE SUBROUTINE POOL` + `:932/934` `PERFORM (form) IN
    PROGRAM (report)`; `source_code` assembled from hardcoded CONSTANTS + ALV field-catalog metadata; both
    callers traced (`create_dynamic_table:254`, `:505`) pass no external strings; `#EC CI_GENERATE` pragma.
    The canonical SAP dynamic-table-from-fieldcat idiom. **NB: Clean-Core-forbidden → a modernisation target
    the analyser/greenfield gates will flag — expected, and useful for a fixture; not a security risk.**
  - `zcl_talv_factory.clas.abap:32` — `CREATE OBJECT TYPE (service)`, `service` = `SELECT clsname FROM
    ztalv_service` (customizing registry), typed to `zif_talv_generate_imp`. Registry factory.
  - `zcl_talv_event_handler.clas.abap` — `PERFORM (talv->key-*) IN PROGRAM (talv->key-program) … IF FOUND`,
    form/program from the design-time `zstalv_key` config struct. Standard ALV callback registration.
  - No `CALL 'SYSTEM'`/`SXPG_*`/shell/`EXEC SQL`/dynamic `CALL FUNCTION (var)`/file I/O/outbound HTTP-RFC/
    suspicious paths. No `AUTHORITY-CHECK` (pure UI framework — none to swallow).
- **Layer 3 — Supply chain:** CLEAN. MIT LICENSE (© 2021 AES0P). No `.gitmodules`/`.gitattributes`/submodules/
  LFS, no binaries/executables, 147 files (within limits). Single known abapGit-community maintainer.
- **Layer 4 — Secrets:** CLEAN. No keys/tokens/PEM/JWT/passwords/PII; URLs limited to sap.com (XML ns),
  abapgit.org, the repo, and README screenshot links.

**Re-scan by SHA on every fresh pull.**
