# abap_fico — offline acceptance E2E demo (2026-07-27)

A **fresh, end-to-end** run of the offline pipeline (`docs/OFFLINE_PIPELINE.md`) over the `abap_fico`
brownfield corpus: **analyser → moderniser (grounding on the oracle) → analyser → the gap-2b offline
verdict arc**, engine-to-engine, **no MCP, no DEV credentials**. Unlike the two earlier demos (which
reused fixed artifacts), this one was regenerated from nothing but an upstream clone — and in doing
so it **surfaced and fixed two real gap-2b defects** (see the last section).

## The before → after headline

| Metric | BEFORE (classic) | AFTER (modernised drafts) |
|---|---|---|
| **S/4HANA readiness** | **36%** | **100%** |
| **ABAP Cloud readiness** | **27%** | **91%** |
| Clean-Core grade | **D** | **A** |
| Total findings | 879 | 660 |
| **Priority-1 findings** | **42** | **0** |
| Priority-2 findings | 821 | 643 |
| Clarity | 61% | 74% |
| Stability | 5% | 75% |

**What moved the needle:** every classic Cloud/S4 blocker the analyser found — `CALL FUNCTION`,
`CL_SALV_TABLE=>factory`, `SELECT *`, and the `notToBeReleased` DDIC reads (T001→`I_CompanyCode`,
SKB1→`I_GLAccountInCompanyCode`, TBSL→`I_PostingKey`, KNA1→`I_Customer`, BSEG→`I_OperationalAcctgDocItem`,
…) — was replaced with the released successor the **oracle** named, or, where no released successor
exists offline, isolated behind a named `NEEDS_MANUAL_SEAM` stub (never invented).

**Priority-1 reaches 0** because the gap-2a structural gate (`talos-rap-modify-*`, `talos-select-in-loop`)
now runs inside SELF_CHECK — so the generated RAP never ships the handler-discipline residuals the
2026-07-14 demo still carried (11 P1). This is a *cleaner* generation than before.

## Why this corpus modernises to real RAP — and why some corpora can't

abap_fico is a **FICO business application** — its substance is *data logic*: G/L postings, document
validations, field-status checks, CDS-shaped reads of released business objects. That logic maps
almost 1:1 onto the ABAP Cloud model, so the port is deep and mostly complete:

| | abap_fico (this demo) | zapcommander (the scale/GUI demo) |
|---|---|---|
| Nature | FICO **business logic** | SAP-GUI/OS/RFC **file manager** |
| Methods **ported to real Cloud code** | **85%** (44 of 52 methods, 90% of body-LOC) | 60% (197 of 333, 60% of body-LOC) |
| `NEEDS_MANUAL_SEAM` methods | **8** (thin — BAPI/print/field-status residuals) | 136 (the entire I/O boundary) |
| Full **managed RAP BOs** produced | **3** (`ZFI_C0001`, `ZFI_C0002`, `ZCREATE_ASSET`) + 5 BDEF / 7 CDS / 3 DCL | **0** (class-only — no Cloud form for its core) |
| Honest verdict | **modernise** — it became Clean-Core RAP | **re-architect or retire** — its core is prohibited in ABAP Cloud |

The difference is a property of the **corpus, not the harness**. A business app is mostly portable
logic, so the seams are a handful of leaf residuals (a BAPI with no released successor, a print-params
call) and the result is genuine Clean-Core RAP. A GUI/OS file manager is *mostly boundary code*
(dynpro, `OPEN DATASET`, `CALL 'SYSTEM'`, RFC directory listing) that SAP deliberately removed from the
Cloud language — so the harness ports the ~60% that is real logic and **honestly seals** the rest
rather than fabricating Cloud APIs that don't exist. See
[`../zapcommander-acceptance-2026-07-28/`](../zapcommander-acceptance-2026-07-28/) for that contrasting
run: same pipeline, opposite corpus, honest opposite outcome.

## The run

- **Corpus:** `PON-HANNES/abap_fico` @ `ebd429a1` — 77 source files, 11 modernisable objects. Fetched
  fresh to a scratch dir outside the project root and **4-layer security-scanned** before ingest
  (clean on every safety layer; the only flag was the absent licence — see below).
- **Plan:** frozen, content-hashed `run-afd4f3d719be`, **11 nodes, 3 waves**, bottom-up. The Stage-1
  dynamic scan **sealed 2 objects** (`ZFICO_FUNCTIONS`, `ZFI_RGGBR000`) whose source carries dynamic
  dispatch — runtime-generated substitution user-exits and a dynamic `SELECT FROM (tabname)`. The
  operator **confirmed both as manual seams** at the `await_human` gate (they can't be statically
  resolved offline).
- **Gated pass:** 7 objects driven to `SYNTAX_OK` — 3 full managed RAP BOs (`ZFI_C0001`, `ZFI_C0002`,
  `ZCREATE_ASSET`, each with `authorization master` + a bare-`.asbdef` BDEF + a save) and 4 released-API
  classes/CDS. All 7 re-verified at `0` gap-2a hits.
- **Draft sweep:** the remaining 4 (2 sealed + the starved validation sibling `ZFI_RGGBS000` + the
  wave-2 entry `ZFICO_BTC_CSV_GL`) drafted provisionally, each with its dynamic dispatch isolated
  behind a named `NEEDS_MANUAL_SEAM` (dynamic-table read, substitution/validation exits → BAdI,
  classic batch-input GL posting).
- **43 artifacts**, all `0` lint errors. `proof/selfcheck-gates.json` has the per-object ledger.

## The offline verdict arc (gap-2b) — the judge

Pointed at the fresh modernised drafts, the offline verdict **BLOCKs** (`offline-verdict.json`):

| | Result |
|---|---|
| **Verdict** | `provisional: false` — **BLOCK** (offline never GREENs, P6) |
| **Reasons** | `atc-p2-nonzero`, `auth-coverage-lost`, `auth-delta-unattested`, `parity-not-equivalent:needs_review` |
| **Driver** | `generate` with `retry: true` — **self-correction**, cycle-gated |
| **Determinism** | two passes byte-identical |

- The classic→RAP rewrite MOVED the authorization footprint (0 → 3 BDEF `authorization` clauses,
  0 → 3 DCL grants, **0 → 3 save boundaries**) — a change a security reviewer signs before it passes,
  not a loss.
- The imperative→declarative paradigm shift (`parity.paradigm_shift: true`) is routed to a human, never
  scored as equivalent or falsely blocked.
- **It does NOT block on `atc-p1-nonzero`** — because there are zero P1 residuals. A cleaner generation,
  correctly, blocks on the P2 tier instead.

## Folder layout

```
before/
  source/                 the classic corpus (NOT vendored — third-party, unlicensed; see ../FETCH.md)
  analyser-findings.json  the analyser's BEFORE diagnosis (D grade, 36% S/4, 879 findings)
  abap_fico-BEFORE.html   ← open in a browser: the interactive report
after/
  modernised-source/      the moderniser's 43 Level-A draft artifacts, 11 objects (NOT vendored)
  analyser-findings.json  the analyser's AFTER diagnosis (A grade, 100% S/4, 660 findings)
  abap_fico-AFTER.html    ← open in a browser
comparison.json           machine-readable before/after deltas
before-after-comparison.html
offline-verdict.json      the gap-2b verdict: corpus hashes, both extractions, verdict, driver decision
proof/
  frozen-plan.json        the content-hashed bottom-up plan (11 nodes, 3 waves, seals)
  run-log.jsonl           the §6.6 observability log (one P8-scrubbed row per event)
  sweep.json              the draft-sweep ledger (4 nodes drafted)
  selfcheck-gates.json    per-object lint + gap-2a gate results (0 errors × 11)
  checkpoint.json         the checkpoint offlineVerdict consumed (auth_coverage is a TOP-LEVEL sibling)
  evidence.json           ratchet evidence: ATC counts, priority-3 warns, changed-line join
  parity-diff.json        all 12 parity fields, including paradigm_shift
```

## Two gap-2b defects this fresh run surfaced — and fixed (TDD)

Reusing fixed artifacts hides drift; regenerating from scratch exposed it. Both fixed red-first:

- **A — the save-boundary extractor was blind to a valid BDEF form.** `bdef-dcl.js` counted a RAP save
  only for the header-adjacent `managed implementation in class X unique;` (FORM X). But a bare
  `managed;` header with `implementation in class` placed per-entity after `define behavior` (FORM Y)
  is **equally valid RAP** — SAP's own TechEd DEV260 reference BDEF is character-for-character FORM Y,
  and the harness template emits FORM Y. So every generated managed BO read as `commit_work: 0` — a
  false `P4b:commit-suppressed`. Fixed by anchoring the impl-*type* token independent of the optional
  `implementation in class` clause.
- **B — the acceptance was over-fit to the pre-gap-2a artifacts.** `test:corpus` hardcoded
  `atc-p1-nonzero`, assuming dirty drafts. A gap-2a-enforced generation legitimately has 0 P1, so the
  assertion punished the *better* output. Relaxed to "blocks + ≥1 ATC-priority reason (p1 **or** p2)".

`npm run test:corpus` now passes **7/7** on this fresh output.

## Honest limits

- **Offline never GREENs (P6).** The best outcome here is `provisional_complete` / a `BLOCK` verdict —
  a floor, not a release. Activation, ATC, and ABAP Unit need a live DEV tier (`blocked_on: DEV-CREDS`).
- **`auth-coverage-lost` is a real block reason**, not noise: the offline extractor cannot prove the RAP
  DCL fully re-covers every classic `AUTHORITY-CHECK` object, so it fails closed and asks for the live
  gate + a reviewer — exactly as intended.
- **The 4 draft-swept objects carry `NEEDS_MANUAL_SEAM` stubs.** Dynamic dispatch and classic batch-input
  have no static offline Cloud form; they are flagged for manual resolution at the live stage, not faked.
- **The generator is real, not perfect.** These are provisional drafts a human reviews, activates, and
  finishes — which is the whole point of the offline floor.

## How to reproduce

```
# 1. fetch + scan the corpus (see ../FETCH.md), lay it out as before/source
node analyser/cli.js before/source --package abap_fico --out before/analyser-findings.json --html before/abap_fico-BEFORE.html
node moderniser/src/cli.js plan before/analyser-findings.json --bundle before/source --team-size 4
#   → the /modernise factory loop (drive → generate → self-check → report; await_human on seals; draft sweep)
node analyser/cli.js after/modernised-source --package abap_fico --out after/analyser-findings.json --html after/abap_fico-AFTER.html
ABAP_FICO_CORPUS=<this dir> npm run test:corpus     # the B7 offline acceptance — 7/7
```
