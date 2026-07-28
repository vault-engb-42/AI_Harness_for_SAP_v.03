# abap_fico — the offline VERDICT ARC demo (2026-07-22)

A companion to [`abap_fico-e2e-2026-07-14`](../abap_fico-e2e-2026-07-14/), not a replacement.

That demo showed the **generator**: classic ABAP in, modernised RAP drafts out, S/4 readiness
36% → 100%. This one shows the **judge** that was missing underneath it — the offline verdict arc
built in gap-2b — and what it does when pointed at those same modernised drafts.

Same corpus. Same generated source. Different question.

**The corpus is not vendored here.** The ABAP it analyses is third-party and carries no licence,
so this repository ships the analysis and the proof — not the source. Fetch the corpus and
reproduce every number below with `npm run test:corpus`; see [FETCH.md](../FETCH.md). The corpus
`source_hash` is recorded in `offline-verdict.json` (`3f615aea…` before, `06f6c627…` after) so you
can confirm you are analysing the same bytes this run did.

> **Why the source is copied, not regenerated.** All 14 defects closed in gap-2b live in the extraction and
> verdict layer. **None are in the generator.** Holding the corpus and the generated artifacts
> fixed is what isolates the change: every number below moved because the *judge* changed, not
> because the code under judgement did.

---

## The headline

The 2026-07-14 demo ended with an honest admission: *"the 11 remaining priority-1 findings are all
RAP-modelling refinements in the new code."* Those residuals were **visible in a report** but
**nothing gated on them** — the offline SELF_CHECK ran the greenfield 59-rule linter, which carries
no structural RAP rules, and no offline verdict existed at all.

Point the finished arc at the same artifacts and it blocks:

| | Result |
|---|---|
| **Verdict** | `BLOCK` — `provisional: false` |
| **Ratchet gate** | `BLOCK` |
| **Driver action** | `generate` with `retry: true` — **self-correction**, cycle-gated |
| **Reasons** | `atc-p1-nonzero`, `atc-p2-nonzero`, `auth-delta-unattested`, `parity-not-equivalent:needs_review` |

Four independent gates fire, each for a different real reason:

- **`atc-p1-nonzero` / `atc-p2-nonzero`** — 11 priority-1 and 618 priority-2 residuals in the
  generated artifacts. Under C3 both hard-block, because SAP blocks transport on both.
- **`auth-delta-unattested`** — the classic→RAP rewrite MOVED the authorization footprint
  (0 → 10 `AUTHORITY-CHECK`s, 0 → 3 BDEF `authorization` clauses). Not a loss, but L7 says a
  security reviewer signs before it passes.
- **`parity-not-equivalent:needs_review`** — an imperative→declarative rewrite cannot be scored
  structurally, so it goes to a human rather than being asserted equivalent or falsely blocked.

And it **self-corrects**: the driver classifies the ATC residuals as defects, regenerates with the
findings threaded in, and bumps the cycle counter so the loop is bounded. The owed attestations do
not stall it — a defect outranks an attestation, so the artifact is fixed first and attested after.

---

## What the arc extracted

Real numbers, both sides, from `offline-verdict.json`:

| Feature | BEFORE (classic) | AFTER (modernised RAP) |
|---|---|---|
| `AUTHORITY-CHECK` statements | 0 | 10 |
| BDEF `authorization` clauses | 0 | **3** |
| Save boundaries (`commit_work`) | 0 | **4** |
| Declarative artifacts | 0 | 7 |
| Exception paths | 5 | 14 |
| CFG branches | 117 | 77 |
| Max nesting | 4 | 3 |
| Unreadable files | 0 | 0 |

The CFG and nesting drops are exactly the trap: on the old arc they read as *lost structure* and
scored the rewrite `scope_reduced` — a non-attestable BLOCK that regenerates to a ceiling. They are
now recognised as a paradigm shift and routed to review instead.

---

## The 14 defects this arc had, and the evidence each is closed

Every row is a probe I ran against the real code before and after the fix. None is a claim from a
report.

| # | Defect | Probe | Before | After |
|---|---|---|---|---|
| 1 | Only the first `ID` captured; `DUMMY` unmodelled | `ID 'BUKRS' FIELD lv_b` vs `ID 'BUKRS' DUMMY` | **identical** | differs; coverage loss |
| 2 | Comment scanner deleted real grants | grant between `//`-with-opener and a later terminator | `[]` | grant extracted |
| 3 | …and was quadratic | 234 KB of block-comment openers | **2705 ms** | **1 ms** |
| 4 | BDEF `authorization` clause never read | clause present vs deleted | **identical** | deletion = coverage loss |
| 5 | ATC zeros fabricated from absent evidence | `offlineEvidence({findings:{error:…}})` | `{atc_p1:0,atc_p2:0}` | `{}` — fails closed |
| 6 | SY-SUBRC window blind to clobbering | `SELECT` between gate and `IF sy-subrc` | `true` | `false` |
| 7 | Privileged-access branch dead on real code | `with privileged access` in DCL | matched nothing real | both real bypasses detected |
| 8 | Owed attestation evaporated | second `drive` step | `provisional_complete` | `await_human` |
| 9 | RAP save boundary uncounted | classic `COMMIT WORK` → managed RAP | `["P4b:commit-suppressed"]` | `[]` |
| 10 | Parity deductions imperative-only | declarative rewrite | `0.25 scope_reduced` | `needs_review` |
| 11 | Untypeable `.abap` passed vacuously | `zcl_x.abap` | silent zeros | `P4:extraction-incomplete` |
| 12 | No executable entry point | caller for the arc | none | `drive --verdict` |
| 13 | `.asdcls` dropped at the loader | dir with a `.dcls.asdcls` | file dropped | file loaded |
| 14 | Bare `.asbdef` names skipped | real `ZR_ZASSETCOPYCC.asbdef` | zero features | `save_boundaries: 1` |

**Eight of the fourteen were false PASSES** — an authorization loss reaching a human labelled
clean. Two (#9, #10) were the inverse: the single most canonical rewrite this harness exists to
perform, classic-with-`COMMIT WORK` → managed RAP, could not pass offline at all.

### Where they came from

- **1–11** — a 5-lens adversarial review of the arc (123 agents, 39 raw findings, 12 after
  dedupe). 11 survived verification; each was then re-probed by hand before any code changed.
  One was **rejected**: `changedLines` being a positional-blind multiset is a documented design
  choice, not a defect — a moved-but-identical line's warn is carried debt and must not count.
- **12** — found by asking what actually calls the arc. Nothing did.
- **13** — found the moment #12 was wired end-to-end and a real directory was loaded.
- **14** — found by this demo's own run, against real corpus filenames.

The last two share a root cause worth keeping: **every DCL/BDEF fixture in the suite was hand-named
in memory.** The tests agreed with each other about a filename convention the real corpus does not
follow. A green suite could not have caught either; only loading from disk did.

Two others deserve naming too — #1 and #6 were the exact risk surfaces recorded in the handoff for
an adversarial pass that was skipped. Skipping it let two false-pass defects propagate through two
further boxes into the verdict.

---

## Files

| Path | What |
|---|---|
| `offline-verdict.json` | The run: corpus hashes, both extractions, verdict, driver decision |
| `proof/checkpoint.json` | The checkpoint `offlineVerdict` consumed — note `auth_coverage` is a TOP-LEVEL sibling, not nested under `invariants` |
| `proof/evidence.json` | Ratchet evidence: ATC counts, priority-3 warns, changed-line join |
| `proof/parity-diff.json` | All 12 parity fields, including `paradigm_shift` |

## Reproducing

```bash
ABAP_FICO_CORPUS=<your corpus> npm run test:corpus
```

The acceptance suite asserts this exact outcome — the block, the four reasons, the self-correction,
and byte-identical determinism across runs — so it cannot regress silently.

## Honest limits

- **Offline never GREENs (P6).** The best outcome available here is `PROVISIONAL_GATED`, a
  provisional-pass floor. Activation, reconciliation and ABAP Unit need a live DEV tier.
- **No `.asdcls` in the corpus.** The DCL engine's own path is still exercised only by synthetic
  fixtures. Defect #13 was found by construction and probe, not by this corpus. A corpus gap,
  recorded rather than papered over.
- **The generator is not re-run.** By design — see the note at the top.
