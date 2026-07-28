# abap_fico — offline modernisation E2E demo (2026-07-14)

A full run of the **offline pipeline** (`docs/OFFLINE_PIPELINE.md`) over the `abap_fico`
brownfield corpus: **analyser → moderniser (grounding on the oracle) → analyser**, engine-to-engine,
no MCP, no DEV credentials.

## The before → after headline

| Metric | BEFORE (classic) | AFTER (modernised drafts) |
|---|---|---|
| **S/4 readiness** | **36%** | **100%** |
| **Cloud readiness** | **27%** | **82%** |
| Clean-Core grade | **D** | **A** |
| Total findings | 879 | 646 |
| Priority-1 findings | 42 | 11 |
| S/4 blocker findings | 28 | **0** |
| Cloud blocker findings | 63 | 5 |
| `notToBeReleased` API hits | 10 | **0** |
| Customer LOC | 2,011 | 2,325 |

**What moved the needle:** every classic Cloud blocker the analyser found — `CALL FUNCTION`,
`CL_SALV_TABLE=>factory`, `SELECT *`, and the `notToBeReleased` DDIC reads (T001→`I_CompanyCode`,
SKB1→`I_GLAccountInCompanyCode`, TBSL→`I_PostingKey`, BSEG→`I_OperationalAcctgDocItem`, …) —
was replaced with the released successor the **oracle** named, or, where no released successor
exists offline, isolated behind a named `NEEDS_MANUAL_SEAM` stub (never invented). S/4 readiness
reaches 100% because zero deprecated / notToBeReleased references remain.

**What the AFTER analyser still flags (honest residuals — this is why offline never GREENs):**
the 11 remaining priority-1 findings are all RAP-modelling refinements in the *new* code, not
classic debt — `talos-rap-modify-*` (behaviour-handler discipline) and `talos-select-in-loop`.
They are exactly what the live gate (ATC + ABAP Unit) and a human reviewer resolve after DEV
activation. The drafts are **provisional**: lint-clean (0 errors across all 11 objects), never
activated, `blocked_on: DEV-CREDS`.

## The run

- **Corpus**: `C:/Users/panag/tmp/security-scan-abap-fico/src` (77 files, 11 modernisable objects).
- **Plan**: frozen, content-hashed `run-afd4f3d719be`, 3 waves, bottom-up. The Stage-1 dynamic
  scan (`plan --bundle`) **sealed 2 objects** (`ZFICO_FUNCTIONS`, `ZFI_RGGBR000`) whose source
  carries dynamic dispatch — they went to the draft sweep behind human-seam confirmation.
- **Gated pass**: 7 objects driven to `SYNTAX_OK` (grounded on the oracle, gated by the real
  59-rule Clean-Core linter engine-direct). **Draft sweep**: the remaining 4 (2 sealed + the
  entry object `ZFICO_BTC_CSV_GL` with 44 transformations + `ZFI_RGGBS000`).
- **Self-check gate**: all 11 objects, **0 lint errors** (see `proof/selfcheck-gates.json`);
  residual warnings are Clean-Core style (Hungarian notation, standalone DATA) only.
- **P4 invariants held**: two SM30 objects relocated their `S_TABU_NAM` check into RAP
  `get_instance_authorizations`; two objects added `F_BKPF_BUK`/`F_ANLA_BUK` gates the classic
  code lacked; every `AUTHORITY-CHECK` is followed by an immediate `SY-SUBRC` check.

## Folder layout

```
before/
  (source/ + analyser-findings.json are NOT vendored — third-party, unlicensed; see ../FETCH.md)
  abap_fico-BEFORE.html   ← open in a browser: 11-tab interactive report (D grade, 36% S/4)
after/
  (modernised-source/ + analyser-findings.json are NOT vendored; see ../FETCH.md)
  abap_fico-AFTER.html    ← open in a browser: (A grade, 100% S/4)
proof/
  frozen-plan.json        the content-hashed bottom-up plan (seals, waves, deps, artifacts)
  run-log.jsonl           the §6.6 observability log (one P8-scrubbed row per mutation)
  selfcheck-gates.json    per-object lint gate results (0 errors × 11)
comparison.json           the before/after metric deltas (machine-readable)
```

## Packaging note (why filenames matter)

The analyser types every file by its **abapGit filename convention** — a class must be
`<name>.clas.abap`. Four generator outputs (the RAP behaviour-implementation + test classes
for `ZFI_C0001`/`ZFI_C0002`) were first written as bare `*.abap`; abaplint then silently
**skips** them (it cannot type a bare `.abap`), which drops ~100 findings and understates
cloud readiness (77% instead of 82%). They have been renamed to `*.clas.abap` here, so the
`after/` numbers are stable and complete. **Actionable follow-up for the moderniser's TRANSFORM
step: emit abapGit-conventional filenames** (`.clas.abap`, `.clas.testclasses.abap`) so a
downstream analyser/abapGit import never silently drops a class.

## How to reproduce

```
node analyser/cli.js <bundle> --out before/analyser-findings.json --html before/BEFORE.html
node moderniser/src/cli.js plan before/analyser-findings.json --bundle <bundle> --team-size 4
# → factory loop per .claude/skills/modernise/SKILL.md (frontier → GROUND→TRANSFORM→SELF_CHECK
#   → SYNTAX_OK ceiling → draft sweep), grounding engine-direct on oracle/, lint engine-direct
#   on greenfield/src/cloud-linter.js
node analyser/cli.js after/modernised-source --out after/analyser-findings.json --html after/AFTER.html
```
