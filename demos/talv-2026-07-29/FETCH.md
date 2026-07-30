# Fetching the `TALV` corpus — classic-ALV reporting generalisation fixture

A **generalisation fixture** (operator directive 2026-07-29): a real, third-party legacy ABAP codebase that
exercises an archetype the two acceptance corpora do **not** — a **classic SAP-GUI ALV / selection-screen**
application. It validates, on genuine code, the classifier's `ui_rearch`-via-ALV → `re_architect` routing
(the ALV report → Fiori Elements List Report + consumption CDS re-architecture path). Complements:

- **abap_fico** — FICO batch business logic → managed **RAP BO** (data model + behaviour + auth relocation).
- **zapcommander** — classic SAP-GUI/OS/RFC **file manager** → ABAP Cloud **classes** + honest sealing.
- **equalize-idoc** — UI-less **IDoc/ALE/tRFC integration** → released comm scenarios / RAP inbound.

Neither abap_fico nor zapcommander is an ALV-grid / selection-screen reporting app. This one is.

## Why TALV (over the alternatives)

Public ABAP GitHub has no coherent *medium-sized business ALV report app* (they are proprietary); the field
is frameworks, large dev-tools, and samples. Against the operator's constraints (real · medium · complementary
· permissive), `AES0P/TALV` is the best fit:
- **`DevEpos/abap-db-browser`** — real/active/MIT, but ~65–80K LOC / 200+ objects (violates "medium"), needs 2
  external repos, and its dynamic/RTTI/generic-SQL core is seal-heavy → overlaps zapcommander.
- **`SAP-samples/abap-alv-google-upload-sheet`** — Apache-2.0 but too small (<15 objects), export-narrow.
- **`AES0P/TALV`** — right-sized, self-contained, MIT, genuinely ALV-dense → chosen.

## Source (not vendored — fetch locally)

Per `demos/FETCH.md`, the corpus **source** is git-ignored (`demos/*/before/source/`); only analysis + proof
(once run) are committed.

- **Repo:** <https://github.com/AES0P/TALV> — a table-maintenance / ALV grid framework (SAP-GUI, dynpro,
  `cl_gui_alv_grid` / `cl_salv_table`, editable ALV, selection screens).
- **Pinned SHA:** `427c1bd7b389dca76e839d58c35e6001bc0afe18` (default branch; last active 2021 — a stable SHA
  for a frozen fixture; staleness is irrelevant to a pinned corpus).
- **Licence:** **MIT** (`LICENSE` present). Kept local + git-ignored for consistency with the other corpora.
- **Size:** ~147 files / ~877 KB / **64 `.abap`** — coherent, self-contained (no `.gitmodules`, no external
  deps), squarely in the medium band.

```bash
git clone https://github.com/AES0P/TALV.git ~/talv-upstream
git -C ~/talv-upstream checkout 427c1bd7b389dca76e839d58c35e6001bc0afe18
```

Layout the behaviour test expects (mirrors the other corpora):

```
$TALV_CORPUS/
  before/source/               the classic corpus (upstream src/)
  after/modernised-source/     the modernised output (git-ignored)
  after/analyser-findings.json optional — regenerated if absent
```

## Archetype evidence (why it complements)

Verified by construct-match count over `src/` (read as untrusted data, P8): **74** matches of
`cl_gui_alv_grid | cl_salv_table | reuse_alv_grid_display | CALL SCREEN | SELECTION-SCREEN`. This is the
classic ALV/dynpro reporting archetype end-to-end — it modernises to a Fiori Elements List Report + a
consumption CDS view, NOT to a RAP BO (abap_fico), sealed GUI classes (zapcommander), or released comm
scenarios (equalize-idoc).

## Ingestion gate (security.md — External Code Ingestion)

External code enters the workspace only after the **mandatory 4-layer security scan** (isolated sub-agent,
sandbox outside the project root). **Status: scanned 2026-07-29 @ SHA `427c1bd` → GATE VERDICT: CLEAN**
(worst finding LOW/informational — the framework's own `GENERATE SUBROUTINE POOL` is a Clean-Core
modernisation target, not an ingestion risk; full record in `security-scan.md`). `before/source/` ingested
(git-ignored). A new pull ⇒ re-scan by SHA.
