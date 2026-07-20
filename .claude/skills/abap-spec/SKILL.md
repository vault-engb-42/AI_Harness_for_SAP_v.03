---
name: abap-spec
description: Decompose a gap or BRD into epics, stories, one-object-group-per-story breakdown, and a dependency-ordered wave graph for the SAP agent team. Disposable planning lane.
argument-hint: "[path-to-BRD-or-gap]"
context: fork
agent: planner
---

# ABAP Spec Skill — Story Decomposition & Sprint Contract

> **Effort tip:** decomposition benefits from broad parallel exploration of stories and dependency edges — `/effort ultracode` fits here. Drop back to `/effort high` before the execution lanes (`/abap-implement`, `/abap-validate`).

## Usage

```
/abap-spec specs/brd/brd.md
```

Pass the path to the approved BRD (or a raw gap / fit-to-standard finding). Produces epics, ready stories, a dependency-ordered wave graph, and the sprint contract `features.json` the evaluator later checks the generated ABAP against.

---

## Overview

This is the story-decomposition gate in the ABAP SDLC pipeline. The `planner` agent (opus, read-only against SAP) reads an approved BRD — or an existing story set — and normalizes it into structured, independently buildable units of work. Every implementation-ready story gets ATC/ABAP-Unit-shaped acceptance criteria, an **object layer**, a dependency group, and a readiness marker. A machine-readable root `features.json` is generated from those criteria so `abap-evaluator` can track PASS/WARN/BLOCK state across sessions.

This is a **DISPOSABLE planning lane** (like `/fit-to-standard`, `/abap-brownfield`, and `/abap-design --doc-only`). Its Markdown/JSON artifacts are NOT graded by the eight GAN ratchet gates — there is no ATC, no ABAP Unit, and no activation on a spec document. `artifact-guard` fences these docs off the pipeline. The gates fire later, on the ABAP the generator writes against this contract. What this lane defines is the contract; it never renders a code verdict.

---

## Steps

### Step 1 — Read the BRD / gap

Read the file at the path provided as the argument. Confirm it is an approved BRD or a concrete gap statement. If missing, halt and ask the human to run `/fit-to-standard` first (it writes `specs/brd/brd.md`), or supply the fit-to-standard finding directly. Read every existing file under `specs/` to avoid duplicating scope. If `specs/brownfield/{architecture-map.md,risk-map.md}` exists, read it — treat any Level-B/C source it names as **diagnosis, not failure** (P1); the *target* is Level A, the brownfield origin only tells you what to wrap or retire.

### Step 2 — Decompose or normalize into epics

Spawn the planner (see Step 3 invocation) to group related functionality into epics:

- Each epic is a coherent vertical slice (e.g. "Sales Order Extension", "Custom Approval BO", "Released-API Reporting").
- 3–5 stories per epic. Never fewer than 2, never more than 5. More than 5 signals the epic is too broad — split it.
- Epic IDs `E1`, `E2`, `E3` … Write the index to `specs/stories/epics.md`.
- If the input already contains epics/stories, preserve their intent but normalize IDs, acceptance criteria, dependencies, object layers, groups, and readiness to this harness format.

### Step 3 — Spawn the planner to write stories (one object group per story)

Spawn Agent with `subagent_type="planner"` and a prompt that hands it the BRD path, the `specs/` context, any `specs/brownfield/` maps, and the directives P1–P4. The planner owns the decomposition; it is read-only against SAP (no `create_object`, no `activate_object`). Instruct it to produce, per ready story:

- `title` — short imperative phrase.
- `user_story` — "As a `<persona>`, I want `<capability>` so that `<value>`."
- `description` — 2–4 sentences of context.
- `acceptance_criteria` — **3+ items, each ATC- or ABAP-Unit-shaped**, testable and specific:
  - "ATC variant `ABAP_CLEAN_CORE_DEVELOPMENT` returns zero priority-1 findings on the object."
  - "ABAP Unit class `LTCL_SALES_ORDER` is green."
  - "Projection `ZC_SalesOrderTP` exposes `OrderId` as read-only (`@ObjectModel.readOnly`)."
  - "The behaviour's `AUTHORITY-CHECK` gate is present and `SY-SUBRC` is checked after it" (P4).
  - Vague criteria ("works properly", "loads fast") are rejected — rewrite as an observable RAP/CDS/ATC behaviour.
- `object_layer` — one of `CDS` | `Behavior` | `Class` | `Service Binding` | `ATC-fixture` | `Test`.
- `group` — dependency group letter (`A`, `B`, `C` …) — see Step 4.
- `depends_on` — story IDs this story depends on (empty for group A).
- `readiness` — `ready` | `needs_breakdown`.
- `breakdown_reason` — required when `needs_breakdown`; otherwise `null`.

**One story per object group.** An object group is a cohesive RAP/CDS unit: one CDS view-entity stack (interface + projection), one RAP BO (behavior definition + implementation class + draft tables), or one released-API consumer class. Do not split at method level; do not merge two BOs into one story.

**Readiness rule:** a story is `ready` only when one developer can build the object group without further product decomposition and it has 3+ concrete ATC/ABAP-Unit criteria. Mark `needs_breakdown` when it combines unrelated workflows, has multiple independent user goals, lacks verifiable criteria, or needs an unresolved product decision. `needs_breakdown` stories go to `specs/stories/backlog-needs-breakdown.md` — never into a dependency group or `features.json`.

### Step 4 — Build the dependency graph (wave order)

Write `specs/stories/dependency-graph.md`:

- Group A: stories with no dependencies (build in parallel).
- Group B: stories depending only on Group A. Group C depends on B (and/or A). And so on.
- Format each group as a table: Story ID, Title, Object Layer, Dependencies.

Rules:
- **No circular dependencies.** Validate before writing — a CDS-A that consumes CDS-B while CDS-B consumes CDS-A means the view split is wrong; restructure.
- Stories in the same group must be independently buildable in parallel (disjoint object sets — no two share a DDIC object or class).
- **Respect ABAP build order:** CDS interface view → CDS projection → RAP behavior definition + implementation → service definition/binding → consumers. A projection cannot precede its interface; a behavior implementation cannot precede its BO's CDS root. Foundation layers (`CDS`, `Class`) appear in earlier groups; `Service Binding` and consumers appear later.

### Step 5 — Write individual story files

The planner writes each ready story to `specs/stories/E{n}-S{n}.md`. Shape:

```markdown
# E1-S1 — Sales order projection exposes OrderId read-only

## Metadata
- Epic: E1 — Sales Order Extension
- Object Layer: CDS
- Group: A
- Depends On: []
- Readiness: ready
- Breakdown Reason: null

## User Story
As an order clerk, I want the sales-order projection to expose OrderId as read-only so that keys cannot be edited through the Fiori app.

## Description
...

## Acceptance Criteria
- ATC variant ABAP_CLEAN_CORE_DEVELOPMENT returns zero priority-1 findings on ZC_SalesOrderTP.
- ABAP Unit class LTCL_SALES_ORDER is green.
- Projection field OrderId carries @ObjectModel.readOnly.
```

### Step 6 — Generate the sprint contract `features.json`

Transform every acceptance criterion into one or more testable feature entries. **Output file: `features.json` at the project root** — not `specs/features.json`. It is root-level because `/abap-auto`, `/abap-validate`, and session chaining read it there.

Each feature's `steps` must be executable checks the evaluator can run against a live DEV tier (activate + ATC + ABAP Unit), never prose:

```json
{
  "id": "F001",
  "category": "functional",
  "story": "E1-S1",
  "group": "A",
  "object": { "package": "ZCC_SALES", "type": "DDLS", "name": "ZC_SalesOrderTP" },
  "description": "Sales order projection activates clean and exposes OrderId as read-only",
  "steps": [
    "activate_object ZC_SalesOrderTP on DEV",
    "run_atc_check variant ABAP_CLEAN_CORE_DEVELOPMENT -> priority-1 and priority-2 findings == 0",
    "run_unit_tests for LTCL_SALES_ORDER -> all green",
    "Assert projection field OrderId carries @ObjectModel.readOnly"
  ],
  "passes": false,
  "last_evaluated": null,
  "failure_reason": null,
  "failure_layer": null
}
```

**Field rules:**
- `id` — sequential, zero-padded to 3 digits (`F001`, `F002` …).
- `category` — `functional` | `integration` | `invariant` | `clean-core` | `test`.
- `story` — the story ID this feature belongs to.
- `group` — inherited from the story's dependency group.
- `object` — `{ package, type (DDLS/BDEF/CLAS/SRVB/…), name }` the ADT object the check targets.
- `description` — single sentence, specific and observable.
- `steps` — ordered executable checks (at least 2); ATC steps name variant `ABAP_CLEAN_CORE_DEVELOPMENT`.
- `passes` / `last_evaluated` / `failure_reason` / `failure_layer` — always `false` / `null` at generation time.

Every acceptance criterion must map to at least one feature. **No criterion may be omitted.** Every story with a P4-invariant criterion must emit a `category: "invariant"` feature so the evaluator scores the authority/save gate explicitly.

### Step 6.5 — Phase evaluation gate (artifact mode)

Before human review, spawn `abap-evaluator` in **artifact mode** to score this decomposition against the BRD. Nothing is pushed to SAP — this grades the planning *documents* on the 5-criterion rubric (completeness, traceability, specificity, consistency, actionability).

Spawn Agent with `subagent_type="abap-evaluator"` and prompt:
- `phase`: `spec` (planning-artifact scoring, not runtime)
- `artifact_paths`: `specs/stories/epics.md`, `specs/stories/dependency-graph.md`, all `specs/stories/E*-S*.md`, `features.json`
- `upstream_paths`: `specs/brd/brd.md`
- `iteration`: `1` (increment on retry)
- `previous_score`: `null` (or the prior iteration's `weighted_average`)
- Cross-phase traceability: verify every story traces to a BRD goal; flag orphan stories and uncovered goals.
- Writes the verdict to `specs/reviews/phase-spec-eval.json`.

**Ratchet loop (max 3 iterations):**
1. Verdict **PASS** (`weighted_average >= 7.0` AND every criterion `>= 5`) → proceed to Step 7.
2. Verdict **FAIL** → the planner revises stories to address ALL error-severity findings; re-run the evaluator with incremented iteration.
3. **Ratchet rule:** `weighted_average` must be `>=` the previous iteration. Revert on regression.
4. After 3 iterations without PASS → present the best version with findings to the human.

### Step 7 — Present for human review

Display:
1. Epic summary table (ID, title, story count, groups covered, readiness summary).
2. Dependency-graph overview (wave order).
3. Total story count and total feature count.
4. Traceability report: "X/Y BRD goals covered", orphan stories, uncovered goals.
5. Ask: "Does this decomposition look correct? Approve to proceed to `/abap-design`, or provide corrections."

Do not auto-advance to `/abap-design`. This is a human gate.

---

## Output

| File | Purpose |
|------|---------|
| `specs/stories/epics.md` | Epic index with story membership and readiness summary |
| `specs/stories/dependency-graph.md` | Parallel-execution wave groups with dependency mapping |
| `specs/stories/E{n}-S{n}.md` | One file per ready story |
| `specs/stories/backlog-needs-breakdown.md` | Optional list of oversized/ambiguous stories fenced out of implementation |
| `features.json` | Root sprint contract — machine-readable feature list the evaluator checks the generated ABAP against |
| `specs/reviews/phase-spec-eval.json` | Artifact-mode phase-eval verdict (rubric scores, traceability report) |

---

## Gate

**Phase evaluation gate runs before human review.** `abap-evaluator` (artifact mode) validates:
- Cross-phase traceability — every story traces to a BRD goal; no orphan stories, no uncovered goals.
- Acceptance-criteria quality — 3+ per story, ATC/ABAP-Unit-shaped, no vague language.
- Dependency-graph consistency — acyclic, valid groups, ABAP build order respected.
- Feature coverage — every acceptance criterion maps to `features.json`.

**Human review is still required before `/abap-design`.** The evaluator validates structure and traceability; the human validates product intent and releases the gate.

Pre-approval checklist (evaluator-verified, human-confirmed):
- [ ] Every story has 3+ specific, ATC/ABAP-Unit-shaped acceptance criteria
- [ ] Every story has an object-layer assignment
- [ ] Every story has a group assignment
- [ ] Every story is `Readiness: ready` before it appears in `dependency-graph.md`
- [ ] No circular dependencies; CDS/RAP build order respected
- [ ] Every acceptance criterion maps to at least one feature in `features.json`
- [ ] Every P4-invariant criterion emits a `category: "invariant"` feature
- [ ] All `passes` fields are `false`; all `last_evaluated`/`failure_*` are `null`
- [ ] Every story traces to a BRD goal (evaluator-enforced)

Do not auto-advance. Wait for explicit approval or correction.

---

## Gotchas

- **Vague criteria are rejected.** "The BO works properly" fails the gate. Rewrite as an observable ATC/activation/ABAP-Unit behaviour.
- **Missing object layer breaks agent routing.** Every story needs an `object_layer` so `/abap-implement` knows which generator team owns it (CDS vs Behavior vs Class).
- **`needs_breakdown` stories block implementation.** They must not appear in a dependency group or `features.json` — break them down first, or park them in the backlog for human review.
- **Circular dependencies deadlock the wave graph.** A CDS-A ↔ CDS-B cycle means the view split is wrong; restructure before writing the graph.
- **Over-decomposition.** Don't split a RAP BO into per-operation stories. One object group (one BO / one CDS stack / one consumer class) = one story.
- **This lane never grounds released APIs or renders a code verdict.** P2 grounding (`get_migration_analysis`) and the ATC/activation gates live in `/abap-design` and `/abap-validate` — this lane produces the contract those lanes check against.
- **`features.json` must cover all criteria.** The evaluator uses it to track PASS/WARN/BLOCK across sessions; a dropped criterion is an invisible gap.
- **Do not skip human review.** The wave graph must be confirmed before `/abap-design` begins.
