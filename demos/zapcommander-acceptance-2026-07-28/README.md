# zapcommander - offline modernisation demo (2026-07-28)

A **fresh, end-to-end** run of the offline pipeline (`docs/OFFLINE_PIPELINE.md`) over the **zapcommander**
brownfield corpus - the **scale / honest-sealing** fixture: **analyser -> moderniser -> analyser -> the
gap-2b offline verdict arc**, engine-to-engine, **no MCP, no DEV credentials**.

zapcommander is a classic **SAP-GUI / OS / RFC dual-pane file manager** (dynpro screens, `CALL 'SYSTEM'`,
`OPEN DATASET`, RFC directory listing, frontend file I/O). The demo's whole point is **honesty at scale**:
the harness ports the pure logic that *has* a Cloud form and **honestly seals** the boundary code that
does not - it never fabricates a Cloud API. The companion
[`../zapcommander-rearchitected-2026-07-29/`](../zapcommander-rearchitected-2026-07-29/) is what the
sealed part *should become* (a Level-A RAP+Fiori rebuild, 0 seams).

## The before -> after headline

| Metric | BEFORE (classic) | AFTER (modernised drafts) |
|---|---|---|
| **S/4HANA readiness** | **67%** | **100%** |
| **ABAP Cloud readiness** | **41%** | **77%** |
| Clean-Core grade | A | A |
| **Priority-1 findings** | **102** | **1** |
| S/4 blocker findings | 83 | 0 |
| Cloud blocker findings | 267 | 13 |
| Total findings | 3224 | 2728 |
| Clarity | 57% | 74% |
| Stability | 21% | 38% |

The single residual **P1** is honest: it is a `CALL FUNCTION 'POPUP_GET_VALUES'` **inside a documented
`NEEDS_MANUAL_SEAM`** method (a classic dialog with no released successor) - the analyser truthfully
reports the sealed residual rather than the harness hiding it. 102 -> 1, with the last one explicitly
sealed.

## Ported vs sealed - the honest measure (not "34/39")

Counting *objects that touch a seam* (34 of 39) overstates what is undone. Measured at method level:

| | Count | Share |
|---|---|---|
| **Ported to real ABAP Cloud logic** | 197 methods (1,835 body-LOC) | **~60%** |
| **Sealed (`NEEDS_MANUAL_SEAM`)** | 136 methods (1,223 body-LOC) | ~40% |

**~60% of the code became real, lint-clean, unit-tested Cloud ABAP.** The seams concentrate in the
file-access boundary (`ZAPCMD_CL_SERVER_DIR` 4:14, `FRONTEND_DIR` 6:13, `RFC_FILE` 5:12); the
model/orchestration classes are mostly ported (`COMMANDER` 28:6, `CMDLINE` 20:5, `KNOTLIST` 14:0). Five
objects (interfaces, exception, list model) port with **zero** seams.

The honest read: for a GUI/OS file manager the sealed 40% *is* the app's reason to exist, so the correct
real-world verdict is **re-architect or retire** - which the companion demo does. The seam ratio is a
property of *this corpus* (contrast [`../abap_fico-acceptance-2026-07-27/`](../abap_fico-acceptance-2026-07-27/):
a business app, 85% ported, full RAP BOs).

## The seams are a driveable backlog, not a dead end (`seam-manifest.json`)

Every one of the 160 seam methods is categorized and assigned the **modernisation disposition** it would
receive under the interactive-advisor model (`MODERNISER_DESIGN` L11/sec 6.11):

| Disposition | Count | Meaning |
|---|---|---|
| **retire** | 94 | OS exec / arbitrary server-FS - no released Cloud form (grounded) |
| **re-architect** | 41 | GUI/dynpro / persistence -> RAP+CDS+OData+Fiori |
| **refactor** | 13 | dynamic dispatch -> static factory (in-stack) |
| **rebuild** | 7 | RFC -> released outbound / side-by-side BTP |
| **seal** | 5 | genuinely manual, last resort |

That turns 136 scattered stubs into a categorized work-list by strategy.

## The run

- **Corpus:** `tricktresor/zapcommander` @ `3f66b751` - 47 ABAP sources / ~7,686 LOC. **GPLv3** (viral
  copyleft) - fetched to a scratch dir and **4-layer security-scanned** before ingest (clean; only flag
  = the copyleft licence). See [`../FETCH.md`](../FETCH.md).
- **Plan:** frozen, content-hashed `run-b2f93bd516bf` - **39 nodes, 6 waves**, 4 objects dynamic-sealed
  (operator-confirmed as manual seams at the `await_human` gate).
- **Gated pass:** 19 objects driven to `SYNTAX_OK`. **Draft sweep:** 20 objects drafted provisionally.
  Every object: greenfield lint 0 errors + gap-2a `lint-rules` 0 hits + NUL-clean.

## The offline verdict arc (gap-2b)

Pointed at the modernised drafts, the offline verdict **BLOCKs** (`offline-verdict.json`) - and does so
**honestly for a class-only port**:

| | Result |
|---|---|
| **Verdict** | `provisional: false` - **BLOCK** (offline never GREENs, P6) |
| **Reasons** | `atc-p1-nonzero`, `atc-p2-nonzero`, `parity-not-equivalent:needs_review` |
| **Driver** | `generate` + `retry: true` - self-correction, cycle-gated |
| **auth_bdef / commit_work / dcl / paradigm_shift** | **0 / 0 / 0 / false** |

Unlike a business app, zapcommander modernises to **classes, not RAP BOs** - no CDS/BDEF/DCL, no save
boundary, no paradigm shift, and (the classic source has no `AUTHORITY-CHECK`) no auth footprint to
relocate. The arc reports exactly that: it **does not fabricate** a RAP/auth story it cannot support
(no `auth-coverage-lost`, `auth_delta: false`). That honesty *is* the result.

## Folder layout

```
before/
  source/                 the classic corpus (NOT vendored - GPLv3; see ../FETCH.md)
  analyser-findings.json  the BEFORE diagnosis (67% S/4, 3224 findings, 102 P1)
  zapcommander-BEFORE.html
after/
  modernised-source/      the moderniser's 39-object drafts (NOT vendored - GPLv3 derivative)
  analyser-findings.json  the AFTER diagnosis (100% S/4, 2728 findings, 1 P1)
  zapcommander-AFTER.html
comparison.json / before-after-comparison.html
offline-verdict.json      the gap-2b verdict (both extractions, verdict, driver decision)
seam-manifest.json        the driveable backlog (160 seams -> dispositions)
proof/
  frozen-plan.json  run-log.jsonl  sweep.json  selfcheck-gates.json
  checkpoint.json   evidence.json  parity-diff.json
```

## Honest limits

- **Offline never GREENs (P6).** The floor here is a `BLOCK` verdict; activation + ATC + ABAP Unit are
  DEV-creds-gated.
- **Source + modernised output are NOT vendored** - both GPLv3; only the analysis + proof are committed.
- **Most objects carry `NEEDS_MANUAL_SEAM`** - a GUI/OS/RFC file manager is mostly boundary code with no
  Cloud form. That is honest, and the seam-manifest turns it into a work-list. The re-architecture demo
  shows what the biggest disposition (re-architect) actually generates.

## How to reproduce

```
# fetch + scan the corpus (see ../FETCH.md), lay it out as before/source
node analyser/cli.js before/source --package zapcommander --out before/analyser-findings.json --html before/zapcommander-BEFORE.html
node moderniser/src/cli.js plan before/analyser-findings.json --bundle before/source --team-size 4
#   -> the /modernise factory loop (drive -> generate -> self-check -> report; await_human on seals; draft sweep)
node analyser/cli.js after/modernised-source --package zapcommander --out after/analyser-findings.json --html after/zapcommander-AFTER.html
ZAPCOMMANDER_CORPUS=<this dir> npm run test:corpus     # the offline acceptance - 8/8
```
