---
name: greenfield
description: Entry-point for a net-new ABAP Cloud build (RAP BO + CDS view entities + ABAP classes from scratch, Clean-Core Level A). Thin router over /abap-build in greenfield mode — skips brownfield discovery, grounds and lints OFFLINE, stops at a release-ready transport for the human.
argument-hint: "[path-to-BRD-or-gap | \"one-line description\"] [--lite] [--mode full|lean]"
context: fork
---

# Greenfield Skill

The **net-new** entry-point. Use `/greenfield` when there is no existing `Z*`/`Y*` package to extend — you are building a fresh RAP business object, CDS view-entity stack, and ABAP classes with ABAP Unit, Clean-Core **Level A** at the target, from a BRD or a one-line gap.

This is a **thin router over `/abap-build`**, not a second pipeline. It sets greenfield semantics and hands off; every phase, gate, and human checkpoint is `abap-build`'s. What `/greenfield` guarantees on top:

- **No brownfield discovery.** There is no existing package to map, so Phase 0 (`/readiness`, `/abap-brownfield`) is skipped. If the work actually extends an existing package, this is NOT greenfield — run `/abap-build` (with Phase 0) instead.
- **Offline-first grounding + validation.** The whole build runs with **no SAP connection** until the live gate:
  - Pre-generation grounding uses `mcp__greenfield__ground_released_apis` — a deterministic released / deprecated / notToBeReleased verdict + successor from the bundled SAP cloudification registry (not a live ADT call, not the analyser). Wired into `/abap-design` (planner + design-critic).
  - Post-generation validation uses `mcp__greenfield__lint_abap_cloud` — the offline ABAP-Cloud linter with the lint→regenerate loop in `/abap-implement`, and a fast-fail pre-flight in `/abap-validate`.
- **The live gate is the authority (P6), and the human releases (P5).** The offline lint never certifies a group. When a DEV connection is available, `/abap-validate` runs the eight SAP-native ratchet gates (ATC `ABAP_CLEAN_CORE_DEVELOPMENT` + activation + ABAP Unit) and `/abap-transport` assembles the proof; a human releases DEV→QAS→PRD. With no DEV tier reachable, the offline lint pre-flight is the only automated screen and the group **cannot** self-certify (the live gates fail closed) — the human runs the live proof later.

---

## Usage

```
/greenfield specs/brd/brd.md
/greenfield --lite "Custom approval BO on the released Purchase Requisition API"
/greenfield specs/brd/brd.md --mode lean
```

`--lite` and `--mode` pass straight through to `/abap-build` (see its `--lite` compressed lane and Mode Reference). Default mode: `full`.

---

## What it does

Delegate to `/abap-build` with the greenfield contract:

1. **Skip Phase 0.** Net-new package — no readiness scan, no brownfield maps. (If a `Z*`/`Y*` package to extend surfaces, stop and route to `/abap-build` with Phase 0.)
2. **Run the pipeline** from Phase 1: `/fit-to-standard` **[human gate]** → `/abap-spec` → `/abap-design` **[human gate]** → per wave-group `/abap-implement` → `/abap-validate` → `/abap-transport` **[human gate]**.
3. **Pass the argument through** — a BRD/gap path, or the `--lite` one-liner, plus `--mode`.

The eight ratchet gates, the Karpathy ratchet, the GAN generate→grade separation, and the three named human gates are all `abap-build`'s — `/greenfield` changes none of them. It only fixes the entry semantics (net-new, offline-first) so a fresh build does not have to know to "skip Phase 0" by hand.

---

## Gotchas

- **Not for brownfield.** `/greenfield` skips discovery by design. Extending or modernizing an existing package is `/abap-build` (Phase 0 on) or `/abap-change` — using `/greenfield` there builds blind to the existing objects and risks colliding with released interfaces.
- **Offline grounding is real, not a guess.** A registry `unknown` verdict is treated as *not proven released*, exactly like unreleased — never emit against it. The offline path is deterministic, not a placeholder for the live check.
- **A clean offline lint is not a pass (P6).** `lint_abap_cloud` errorCount 0 clears hand-off and the validate pre-flight — it never substitutes for the live ATC/activation/ABAP-Unit gates. Greenfield cannot self-certify without the live proof.
- **The pipeline never releases (P5).** `/greenfield` stops at a release-ready (or binding-unverified) transport with proof. Release DEV→QAS→PRD is the human's action.
