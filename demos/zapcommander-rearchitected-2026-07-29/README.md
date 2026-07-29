# zapcommander -> Clean-Core re-architecture (2026-07-29)

A **greenfield rebuild** of the zapcommander dual-pane browser as a **100% Clean-Core (Level A) ABAP
Cloud** application: RAP + CDS + OData V4 + Fiori Elements, with **zero `NEEDS_MANUAL_SEAM`**.

This demo is the answer the **moderniser** demo pointed to. That run
([`../zapcommander-acceptance-2026-07-28/`](../zapcommander-acceptance-2026-07-28/)) tried to *port* the
classic app and honestly reported it **cannot** be ported — 60% of methods became Clean-Core ABAP, but
40% (the GUI / OS-exec / server-FS / RFC core) has no 1:1 Cloud form, so it was sealed. Verdict:
**re-architect or retire**. This demo **does the re-architecture** — and shows the honest cost.

## The headline

| | moderniser (port) | this demo (re-architect) |
|---|---|---|
| Approach | port classic ABAP in place | rebuild as a new Clean-Core app |
| `NEEDS_MANUAL_SEAM` | **136** | **0** |
| Clean-Core level | provisional drafts + seals | **A** |
| S/4 readiness (analyser AFTER) | mixed | **100%** (P1 = 0) |
| Greenfield Level-A lint | n/a | **0 errors** |
| Cost | keeps every feature (as seals) | **drops 2 feature categories** (prohibited in Cloud) |

**"100%" is precise:** the generated artifact is Level A — released APIs only, 0 seams, 0 lint errors —
for the **retained scope**. Activation + ATC + ABAP Unit still need a live DEV tier (P6: offline never
GREENs). It is *not* a claim that every classic feature survives; it is a claim that everything kept is
real Clean Core and everything dropped is documented.

## What it is: the same dual-pane UX, Cloud-legal substance

A RAP-based **object/file browser** — a node tree you navigate in a Fiori Elements dual-pane UI. Same
interaction paradigm as the classic commander; the panes browse what Clean Core actually permits.

**15 source objects / 1,275 LOC** — 2 CDS views + 2 custom entities, 1 DCL, 2 BDEF (managed, draft),
1 metadata extension, 1 service definition + 1 OData V4 binding, 1 table, 3 ABAP classes (behavior pool +
2 query providers), ABAP Unit via the released RAP test-double framework.

| Classic capability | Realised as (grounded released API) |
|---|---|
| Navigate an arbitrary-depth tree, two panes | managed **draft** RAP BO, **self-association + `@Hierarchy.parentChild`** (not composition) |
| Persist navigation state | RAP **draft** table (replaces `EXPORT/IMPORT indx`) |
| Browse repository objects | **XCO** custom entity + `IF_RAP_QUERY_PROVIDER` - **released + customer objects only** |
| Upload / download file content | RAP **stream** (`@Semantics.largeObject` + `mimeType`) over OData V4 |
| Read a remote system | **released outbound** (`CL_HTTP_DESTINATION_PROVIDER` + `IF_WEB_HTTP_CLIENT`) |
| Authorization | BDEF `authorization master` + CDS **DCL** `pfcg_auth` (P4) |
| Dual-pane UI, toolbar, actions | **Fiori Elements** via service def + OData V4 binding |

## What was dropped (grounded ledger, `dropped-features.json`)

Two feature categories are **prohibited in ABAP Cloud by design** - no released API exists, and inventing
one would be fabrication. They are **retired and documented**, not faked:

- **OS command execution** (`CALL 'SYSTEM'` / SXPG) - no released Cloud form (SXPG unreleased).
- **Arbitrary application-server file/dir browse** (`OPEN DATASET` / AL11) - no released Cloud API (SAP
  KBA 3648256). Content that matters is re-modelled as node entities + streams.
- Frontend OS-shell "execute file" - the browser sandbox has no shell-exec.

This is the honest cost of Clean Core for a GUI/OS file manager: some of its reason-to-exist can't come
along. The demo records exactly what and why.

## Two lenses on the same code (analyser vs greenfield gate)

The **greenfield Clean-Core lint** - the authoritative Level-A gate - passes at **0 errors**. The
**brownfield analyser**, a stricter and *different* lens, flags 4 findings that are actually correct RAP
idioms it was not built to recognise (documented, not defects):

1. `EML ... IN LOCAL MODE` inside behavior-pool actions - the standard same-BO RAP pattern, not an auth bypass.
2. DCL `where ( field )` read as "dynamic SQL" - that is DCL `pfcg_auth` grammar.
3. `@AccessControl.authorizationCheck: #NOT_REQUIRED` on the custom entities - auth is enforced in their query-provider classes.
4. `talos-rap-draft-lock-no-timeout` requires `@Locking.timeoutSeconds`, which **does not exist** in released ABAP Cloud - a **fabrication-inducing analyser bug**, logged for correction.

That contrast is itself a finding: the analyser needs **RAP-context awareness** and a **split
readiness/quality score** to review modern code cleanly (its brownfield diagnosis of *classic* ABAP is
accurate - the gap is only on forward/RAP code). Tracked as its own improvement arc.

## Folder layout

```
DESIGN.md               the re-architecture blueprint (the design-gate artifact)
src/                    the 15 generated Level-A objects (MIT, clean-room - committed)
dropped-features.json   the grounded retire ledger (3 capabilities)
analyser-findings.json  the analyser AFTER diagnosis (S/4 100%, P1 0, level A)
zapc_cloud.html         <- open in a browser: the interactive report
proof/gates.json        the gate ledger (greenfield lint 0, gap-2a 0, 0 seams, 100% S/4)
```

## Honest limits

- **Offline never GREENs (P6).** Level-A *artifact* + Level-A *lint*; activation, ATC
  (`ABAP_CLEAN_CORE_DEVELOPMENT`) and ABAP Unit need a live DEV tier.
- **Real functionality was dropped** - OS exec + arbitrary server-FS browse are gone. Recorded, not hidden.
- **XCO scope is a real limit** - the repository pane shows released + customer objects only, not the
  whole SAP repository (Clean Core does not permit that).

## How it was built

Clean-room, via the **greenfield lane**: designed from the capability blueprint (`DESIGN.md`) + released-API
grounding, **not** translated from zapcommander's GPLv3 source - so the output is original MIT work, not a
GPLv3 derivative, and is committed here. Generation self-checked with `ground_released_apis` +
`lint_abap_cloud`; graded by an independent analyser pass (GAN separation), which drove one self-correction
round to clear 5 clean-core nits.
