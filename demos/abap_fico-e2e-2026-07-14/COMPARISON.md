# abap_fico — before → after, read correctly

Companion to `before/abap_fico-BEFORE.html` and `after/abap_fico-AFTER.html`. Read this
alongside the two reports: **some sub-metrics decrease even though the modernisation
succeeded**, and the decreases are measurement artifacts, not regressions. This document
explains every movement so the numbers can't mislead.

## The headline

| | Before (classic) | After (modernised) | Reading |
|---|---|---|---|
| **Clean-Core grade** | **D** | **A** | ✅ the objective — released-API compliance, weakest-node tier |
| **S/4HANA-ready** | 36% | **100%** | ✅ zero deprecated / notToBeReleased references remain |
| **ABAP Cloud-ready** | 27% | **82%** | ✅ classic Cloud blockers replaced with released successors |

The grade and readiness are the point of modernisation, and they leapt. Everything below is
the *maintainability* axis — a different question ("is the new code well-structured?"), and
the honest answer is **"mostly better, with one real refactor hint."**

## Code Health — why some bars went down

| Sub-metric | Before | After | What actually happened |
|---|---|---|---|
| Cyclomatic | 83% | **100%** | ✅ new code decomposed into small methods |
| Routine length | 62% | **100%** | ✅ no more monolith routines |
| Nesting | 96% | **100%** | ✅ flatter control flow |
| **Cohesion (LCOM\*)** | **100%** | **44%** | ⚠️ **measurement-scope shift — see below** |
| Clarity (worst-attribute mean) | 61% | 53% | ⚠️ dragged by the cohesion axis (below) |
| Stability | 5% | 17% | ✅ better-placed on the dependency main sequence |
| Performance | 53% | 56% | ✅ slightly fewer perf findings |
| Compound (maintainability) | 40% | 42% | ➖ ~flat — maintainability preserved |

### The cohesion "100 → 44" is not degradation

LCOM\* (lack-of-cohesion) is **defined for classes only**. The two codebases have completely
different class populations:

- **Before** is procedural — reports, function groups, includes. Of 19 objects, **exactly one
  is a class** (`ZFICO_FUNCTIONS`, LCOM 0). Every other object is *N/A* and excluded. So the
  "100%" is computed from **one perfectly-cohesive class** — a *not-applicable → defaults to
  perfect* artifact, **not a cohesion score of the old code.**
- **After**, the modernisation converted that procedural code into **10 measurable classes.**
  Mean LCOM penalty `0.561` → `100 × (1 − 0.561) = 44%`. The metric now measures something real.

So cohesion didn't fall because code got worse — it fell because **there were finally classes to
measure.** The class boundary made a *pre-existing* structural property visible for the first time.

### The low cohesion is inherited, and it's a useful hint

The three lowest-cohesion classes (LCOM 1 = methods share no state) are:

| Class | Why LCOM = 1 | Origin |
|---|---|---|
| `ZCL_FI_BTE` | 3 unrelated stateless BTE handlers in one class | a function group of 3 independent BTE modules |
| `ZCL_FI_RGGBR000` | many independent validation exits (u100, u200…) | classic RGGBR validation form-pool |
| `ZCL_ZFI_RGGBS000` | many independent substitution exits | classic RGGBS substitution form-pool |

These were **grab-bags of unrelated routines in the original code** that the generators wrapped
1:1 into a class. **Actionable refactor hint** (not a blocker): a reviewer should split these into
cohesive units (e.g. `ZCL_FI_BTE` → 3 handler classes or a strategy). This is exactly the kind of
design issue the **linter passed at 0 errors** but the **analyser caught** — the maintainability
signal a lint-only gate misses.

### Why clarity dropped 61 → 53 while three of its four axes hit 100%

Clarity scores each object by its **worst attribute** (max penalty of cyclomatic / length /
nesting / cohesion). The new code aced cyclomatic/length/nesting (→ 0 penalty), but for the six
low-cohesion classes, **cohesion is now the binding worst attribute**, pulling the per-object mean
down. Not a contradiction — the "worst-attribute" rule made cohesion the limiting factor.

## Verdict

The modernisation **achieved its objective** (Clean-Core Level A, S/4 100%, cloud 82%, zero
blockers) and **improved per-routine complexity**. It **did not degrade existing code.** The
cohesion drop is a *measurement-scope shift* (unmeasurable → measured) plus **one real, actionable
signal**: three generated classes are inherited grab-bags a reviewer should split. Maintainability
overall (compound) is flat-to-slightly-up.

> **Reporting caveat this demo exposed:** the analyser shows scores without their *coverage*, so an
> axis measured from 1 object (before cohesion) looks as confident as one from 15. A proposed fix
> shows per-axis coverage and renders below-threshold axes as "N/A · classes only" instead of a
> misleading percentage — so a future before/after is legible without this companion doc.
