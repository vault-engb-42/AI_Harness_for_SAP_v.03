# Fetching the `equalize-idoc` corpus — cross-system integration generalisation fixture

A **generalisation fixture** (operator directive 2026-07-29): a real, third-party legacy ABAP app that
exercises an archetype the two acceptance corpora do **not** — a **UI-less cross-system integration /
IDoc / ALE / tRFC framework**. It validates, on genuine customer-style code, the classifier's
`rfc_rebuild → re_architect` routing (in-stack released-communication re-architecture; `rebuild`-promotion
deferred to the app-blueprint at B3.5). Complements:

- **abap_fico** — FICO batch business logic → managed **RAP BO** (data model + behaviour + auth relocation).
- **zapcommander** — classic SAP-GUI/OS/RFC **file manager** → ABAP Cloud **classes** + honest sealing.

Neither is a pure integration/interface component. This one is.

## Source (not vendored — fetch locally)

Per `demos/FETCH.md`, the corpus **source** is git-ignored (`demos/*/before/source/`); only the analysis +
proof (once run) are committed.

- **Repo:** <https://github.com/engswee/equalize-idoc-framework> — "Custom IDoc framework based on ABAP
  Objects" (Eng Swee Yeoh, a well-known SAP PI/PO/CPI integration author; repo mirrors his SAP Community
  blog series).
- **Pinned SHA:** `0d08659a9633d7c54be5da959d7839ce4c38fb8f` (default branch; repo archived / read-only
  since Sept 2023 — a stable SHA for a fixture).
- **Licence:** **MIT** (permissive; `LICENSE` present, © 2019). Redistributable in principle, but kept
  local + git-ignored for consistency with the other corpora.
- **Size:** ~88 files / ~536 KB — a coherent single framework (10 processing classes, ~6 `zcx_*`
  exception classes, 3 function groups incl. `zbc_fg_idoc_fw`, 4 tables, data elements/domains/views).

```bash
git clone https://github.com/engswee/equalize-idoc-framework.git ~/equalize-idoc-upstream
git -C ~/equalize-idoc-upstream checkout 0d08659a9633d7c54be5da959d7839ce4c38fb8f
```

Layout the behaviour test expects (mirrors the other corpora):

```
$EQUALIZE_IDOC_CORPUS/
  before/source/               the classic corpus (upstream src/)
  after/modernised-source/     the modernised output (git-ignored)
  after/analyser-findings.json optional — regenerated if absent
```

## Archetype evidence (why it complements)

Verified against source (read as untrusted data, P8):
- `zcl_idoc_output.clas.abap`: `CALL FUNCTION 'IDOC_INBOUND_ASYNCHRONOUS' IN BACKGROUND TASK DESTINATION lv_rfc_dest`
  — textbook remote-RFC + IDoc distribution; plus `EDI_DOCUMENT_OPEN_FOR_PROCESS`, `EDI_SEGMENTS_GET_ALL`,
  `EDI_DOCUMENT_STATUS_SET`, `IDOC_ERROR_WORKFLOW_START`; `EDIDC`/`EDIDD`/`EDIDS` segment structures.
- `zcl_idoc_input.clas.abap`: inbound handlers over `EDIDC_TT`/`EDIDD_TT` + `E1BPPAREX`, BAPI posting.
- **No UI** — no `WRITE` / `CALL SCREEN` / dynpro / ALV. This is the `rfc_rebuild` archetype end-to-end:
  it modernises to released communication scenarios / RAP inbound / event consumption (or, where genuinely
  off-stack, an app-level `rebuild` decision at B3.5), NOT to a RAP BO (abap_fico) or sealed GUI classes
  (zapcommander).

## Ingestion gate (security.md — External Code Ingestion)

External code enters the workspace only after the **mandatory 4-layer security scan** (isolated sub-agent,
sandbox outside the project root). **Status: scanned 2026-07-29 @ SHA `0d08659` → GATE VERDICT: CLEAN**
(worst finding LOW, design-intent; full record in `security-scan.md`). `before/source/` ingested
(git-ignored). A new pull ⇒ re-scan by SHA.
