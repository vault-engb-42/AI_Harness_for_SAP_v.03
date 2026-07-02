---
name: checking-coverage-before-change
description: Use when about to edit any existing (brownfield) ABAP object — before the first Edit/Write to production source in /abap-refactor, /abap-change, or /abap-vibe — to learn which ABAP Unit tests cover the methods you will touch and route uncovered code to characterization pinning.
---

# Checking Coverage Before Change

The preflight router for behavior-preserving ABAP change. You cannot protect behavior you cannot observe; the first question before any edit to an existing class, RAP handler, or CDS-backed method is "which ABAP Unit tests will tell me if I break this?"

## The Iron Law

```
NO EDIT TO AN ABAP OBJECT UNTIL YOU KNOW WHICH ABAP UNIT TESTS COVER IT
```

## Process

1. **Get a coverage verdict from the evaluator — do not measure locally.** The only substrate is MCP-ADT (`sap-adt`) plus the SAP agents; there is no local coverage tool. Spawn `abap-evaluator` (Agent tool, `subagent_type: abap-evaluator`) in coverage mode over the objects in the planned diff. It pushes the *current, unchanged* brownfield source to a DEV tier, runs the existing LTCL_* ABAP Unit classes, and writes per-method coverage into `specs/reviews/sap-verdict.json`. Read the ratchet floor from `.claude/state/abapunit-baseline.json`. **Under time pressure, scope the run** — hand the evaluator only the affected class/behavior pool, not the whole package; the Iron Law needs this method's verdict, not the package's. A scoped run is compliance; a skipped one is not.
2. **Read the verdict for every method in the planned diff** from `specs/reviews/sap-verdict.json` — each changed class method, RAP behavior-definition handler method (`FOR MODIFY` / `FOR READ` / determination / validation), and any procedural unit you will touch. The verdict per method is COVERED, UNCOVERED, or UNMEASURABLE.
3. **Route on the verdict:**
   - **COVERED** → the listed LTCL_* test methods are your **fast regression oracle**. Have the evaluator run exactly them before the change (must pass) and after every edit (must still pass, and coverage must not drop below the `abapunit-baseline.json` ratchet — Gate 3, HARD).
   - **UNCOVERED** → STOP. `REQUIRED SUB-SKILL: pinning-down-behavior`. That skill writes characterization ABAP Unit tests at the nearest observable seam and watches them bite before any production edit; if the object is unpinnable, it owns the further escalation.
   - **UNMEASURABLE** (evaluator cannot instrument the object — e.g. a legacy function module, a procedural report with no callable seam, or a non-ABAP-Cloud object outside the DEV tier's coverage scope) → coverage is unavailable. Treat every method you plan to edit as UNCOVERED and route accordingly; do not read absence of data as coverage.
4. **Record the verdicts** in your impact assessment / story notes before the first edit, and append the coverage decision to `.claude/state/iteration-log.md`.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "It's a small change" | Small edits to uncovered ABAP are how regressions ship a transport. The evaluator run takes minutes. |
| "The 8 gates will catch it later" | `/abap-validate` checks the sprint contract and Clean Core, not the *legacy* behavior you just altered in place. Gate 3 only bites if a test reaches this method. |
| "Coverage data is stale, skip it" | Re-running the evaluator on the affected pool is one DEV push. Stale data is an instruction to re-run, not an excuse to skip. |
| "The package's ABAP Unit suite is green, so I'm safe" | Green proves the *covered* methods work. The verdict tells you whether *this* method is one of them. |
| "I'll honor the Iron Law with a cheaper check" | Grepping for LTCL_* classes and reading test method names is not a verdict. Violating the letter is violating the spirit — get the evaluator's per-method coverage on real (scoped is fine) execution. |
| "It's a RAP handler — the framework tests it" | RAP dispatches your determination/validation/action code; it does not assert your logic. An uncovered `FOR MODIFY` method is uncovered. |

## Red Flags — STOP

- About to Edit an existing ABAP source file with no per-method coverage verdict from `specs/reviews/sap-verdict.json`
- Treating a package- or class-level coverage % as a method-level answer
- Skipping the check because the diff "only touches one method" or "only one behavior handler"
- Substituting a grep for LTCL_* test classes in place of an evaluator coverage verdict
- Declaring the check "honored in substance" while the evaluator never ran

## Checklist

- [ ] `abap-evaluator` coverage run completed on the affected class/behavior pool (unchanged source, live DEV tier)
- [ ] Per-method verdict obtained for every method in the planned diff from `specs/reviews/sap-verdict.json`
- [ ] COVERED methods: oracle LTCL_* tests ran green before the first edit; coverage floor read from `.claude/state/abapunit-baseline.json`
- [ ] UNCOVERED / UNMEASURABLE methods: routed to `pinning-down-behavior`
- [ ] Verdicts recorded in impact notes and `.claude/state/iteration-log.md`

Method verdict first, edit second. This skill never edits source and renders no gate verdict of its own. No exceptions without your human partner's permission.
