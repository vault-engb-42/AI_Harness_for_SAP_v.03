---
name: keeping-refactors-pure
description: Use when committing any change that includes structural work (rename, move, extract, reorder, collapse a projection) in an existing ABAP object — keeps refactor commits behavior-free and behavior commits refactor-free so every regression stays attributable to exactly one commit. Invoked by /abap-refactor.
---

# Keeping Refactors Pure

Tangled commits are how agents break brownfield ABAP: a structural move (rename a method, split a class, collapse a pass-through projection) mixed into a behavior change makes a red ABAP Unit test or a new ATC finding un-attributable — you cannot tell whether the rename broke a call site or the "small fix" broke the logic. Purity makes every regression trace to one commit, and it is the sub-skill `/abap-refactor` Step 5 requires before every structural commit.

## The Iron Law

```
A REFACTOR COMMIT CHANGES NO BEHAVIOR; A BEHAVIOR COMMIT REFACTORS NOTHING
```

Behavior, in ABAP terms, is the evidence pair: **ABAP Unit** (every `LTCL_*` verdict) and **ATC** (variant `ABAP_CLEAN_CORE_DEVELOPMENT` — priority-1 count and the accepted-WARN set). A refactor commit leaves both unchanged: green stays green, coverage does not fall, and the WARN count does not rise. Any delta in that pair is behavior and moves to its own `/abap-change` commit.

## Process

1. **Classify every hunk** before committing: *structural* (rename a private member, move a method, extract a helper class or CDS view entity, decompose an over-long method against the same public interface, collapse a re-alias-only projection, remove dead `DATA`/`TYPES`/orphan view) or *behavioral* (any observable difference — a field a consumer reads, a RAP action's effect, an association a projection exposes, a released-API choice, a `SELECT` result). Mixed staging → split into two commits, **structural first**. A behavioral bug discovered mid-refactor does **not** get folded in "while I'm here" — it escalates to `/abap-change` (a story/issue cited) so the fix ships on the smallest review while the refactor stays pure. A P4-invariant change (`AUTHORITY-CHECK` / `COMMIT WORK` / post-`AUTHORITY-CHECK` `SY-SUBRC`) is never a refactor at all — stop and escalate.

2. **In a refactor commit:**
   - All existing `LTCL_*` test classes are **byte-identical** — no assertion edits, no new/removed test methods, no test-data changes. The pinned oracle from `checking-coverage-before-change` is untouched.
   - ABAP Unit stays **green on live DEV** and coverage is `≥ .claude/state/abapunit-baseline.json`; the ATC accepted-WARN set is a subset of `.claude/state/atc-baseline.json` and the priority-1 count stays **zero**. Warnings only fall.
   - Every renamed/moved/deleted symbol: enumerate its consumers from `specs/brownfield/architecture-map.md` (the `abap-explorer` map) and verify each call site is updated — CDS `association`s, RAP compositions, class references, dynamic `CALL METHOD` / BAdI / RAP determination-validation bindings. No orphaned reference, no dead copy left behind. ADT fails activation on a stale reference; it does not compile silently.
   - **Grounding is unchanged:** the refactor references no released API the pre-refactor object did not already use. Re-confirm against `get_migration_analysis` (via `clean-core-reviewer`) — a refactor that pulls in a new API is behavior. `clean_core_level` held-at-or-improved-to A, never regressed (P1/P2).

3. **In a behavior commit:** an `LTCL_*` test may be *updated* (never deleted to make red go away) only with the authorizing story/issue cited in the commit message. A new released-API reference, a new ATC WARN, or a coverage move all belong here, not in a refactor commit.

4. **Ratchet:** ABAP Unit coverage and the ATC WARN floor may only tighten across either commit type (P6). A refactor that *drops* coverage is a regression even with every test green; a refactor that *adds* an ATC finding failed its own purpose.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "I'll fix that little bug while I'm in here" | That converts an attributable refactor into an unattributable mixed change. Separate `/abap-change` commit, structural first. |
| "The `LTCL_*` needed a tiny update for the rename" | A pure rename never changes an assertion. If it did, behavior moved — that is `/abap-change`. |
| "I re-baselined ATC because the WARN is equivalent" | An equivalent-but-different ATC finding IS a behavior delta. Prove it in a behavior commit; the refactor's WARN set must be a subset of the old one. |
| "Splitting commits is ceremony" | Bisecting a tangled regression across a RAP BO + its CDS stack costs hours; splitting costs seconds. |
| "Collapsing that `TRY`/`CATCH` around the `AUTHORITY-CHECK` is just cleanup" | Touching a P4 invariant is never a refactor. The evaluator BLOCKs it and the diff-reviewer catches it. Surface it, do not apply it. |
| "The transport history is full of mixed commits and nobody complained" | Survivorship bias — nobody complains until the first tangled bisect on a posting path. Precedent is not justification. |
| "The bug is urgent, splitting delays the fix" | Urgency argues FOR splitting: an urgent behavior fix belongs on the smallest, fastest-reviewed `/abap-change`, not bolted to a multi-object structural refactor. |

## Red Flags — STOP

- A commit subject saying "refactor" with a diff that touches an `LTCL_*` test class, `atc-baseline.json`, or `abapunit-baseline.json`.
- A rename or delete where the `abap-explorer` architecture-map still shows a consumer of the old name (CDS association, RAP composition, dynamic binding).
- ABAP Unit coverage falling, or a new ATC WARN appearing, across the commit.
- A new `get_migration_analysis` released-API reference the pre-refactor object did not use.
- Any `AUTHORITY-CHECK` / `COMMIT WORK` / post-`AUTHORITY-CHECK` `SY-SUBRC` line in the structural diff.
- "and" in your commit subject joining structural + behavioral work.

## Checklist

- [ ] Every hunk classified; mixed work split (structural commit first), behavior escalated to `/abap-change`
- [ ] Refactor commit made with `HARNESS_COMMIT_KIND=refactor git commit …` — this env var arms the pre-commit purity gate (staged `LTCL_*` / baseline edits get blocked); without it the gate is inert
- [ ] Refactor commit: `LTCL_*` byte-identical; ABAP Unit green on DEV; coverage `≥ abapunit-baseline.json`; ATC WARN set ⊆ `atc-baseline.json`, priority-1 zero
- [ ] Renames/deletes: every consumer in `architecture-map.md` verified updated, no dead copy, no orphaned binding
- [ ] No new released-API reference (`get_migration_analysis` re-confirmed); `clean_core_level` held-at/improved-to A
- [ ] Behavior commit: `LTCL_*` updates cite the authorizing story/issue
- [ ] Ratchet held (coverage only up, ATC WARN only down)
- [ ] Stage explicit paths only — never `git add -A` / `git add .`

One commit, one kind of change. Green stays green, warnings only fall. No exceptions without your human partner's permission.
