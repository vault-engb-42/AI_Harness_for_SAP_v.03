# Demo runbook — what you can run, and what needs a real SAP system

Every command here works on a **clean checkout**: no SAP, no credentials, no MCP server, and **no corpus
fetch**. That constraint is the point. The customer corpora are third-party and cannot be redistributed
(see [`FETCH.md`](FETCH.md)), so a demo that depended on them was a claim rather than a demonstration —
which is exactly what `npm test` became for a while, red on any fresh clone.

## The one-command version

```bash
npm run demo:offline
```

Runs the whole offline pipeline over a **hand-written MIT bundle** committed to this repository, and prints
what each stage produced. It writes only to a temp directory. Roughly:

```
 1. analyse the classic package        102 findings · 15 nodes · S/4 25% · grade D
 2. freeze a content-hashed plan       run-6c20f9b5d674 · 5 nodes · 2 waves
 3. disposition gate                   5 prompted · 0 auto
 4. architecture gate                  0 resolved · 1 awaiting a judge · 3 unplaceable
 5. surface the human gates            8 packet(s): DISPOSITION_REVIEW, NO_TARGET_SHAPE
 6. before/after on a real corpus      S/4 67% -> 100% · findings 1879 -> 57
```

Your numbers for steps 1–5 should match exactly — the plan is content-hashed, so a differing `run_id` means
an input changed. Step 6 reads committed evidence and is likewise fixed.

## Step by step

Set a scratch dir first: `S=$(mktemp -d)`.

**1 — Analyse.** Builds an `@abaplint/core` code property graph over classic ABAP and emits findings plus an
interactive HTML report.

```bash
node analyser/cli.js moderniser/test/fixtures/seam-bundle/before \
  --package ZSM_SEAM --out "$S/findings.json" --html "$S/report.html"
```

**2 — Plan.** Freezes a bottom-up, content-hashed dependency plan. Deterministic: same input, same
`plan_hash`, same `run_id`.

```bash
node moderniser/src/cli.js plan "$S/findings.json" --state-dir "$S/state" --runs-dir "$S/runs"
```

**3 — Gate 1, disposition.** What should happen to each object — refactor, re-architect, replace, retire,
seal — and which need a human.

```bash
node moderniser/src/cli.js disposition <run_id> --state-dir "$S/state" --runs-dir "$S/runs"
```

**4 — Gate 2, architecture.** A target shape per re-architected object. Objects the evidence cannot place
come back as `unplaceable` rather than being given a shape.

```bash
node moderniser/src/cli.js arch <run_id> "$S/findings.json" --state-dir "$S/state" --runs-dir "$S/runs"
```

**5 — The human gates.** Rendered exactly as an operator sees them: kind, one-line cause, and a typed
decision set. `NO_TARGET_SHAPE` appearing here is the harness declining to invent an architecture.

```bash
node moderniser/src/cli.js packets <run_id> --max 50 --state-dir "$S/state" --runs-dir "$S/runs"
```

**6 — Before/after on a real corpus.** Recomputed from the committed findings docs — no source needed.

```bash
node analyser/cli.js compare \
  demos/equalize-idoc-2026-07-29/before/analyser-findings.json \
  demos/equalize-idoc-2026-07-29/after/analyser-findings.json --html "$S/compare.html"
```

## Tests

```bash
npm test          # clean-checkout gate: everything it runs is tracked
npm run test:all  # adds the deep corpus lane — needs the fetch in FETCH.md, fails loudly without it
```

## What this does NOT show, and will not fake

Push, activate, ATC, ABAP Unit, and a GREEN verdict all need a live DEV tier. They are refused rather than
simulated. **Offline never reaches GREEN by design** (P6): it reaches a *provisional* verdict plus a proof
bundle a human reads before releasing a transport.

## The committed bundles

| bundle | ships | note |
|---|---|---|
| `abap_fico-acceptance-2026-07-27` | full set incl. `proof/` | the reference run; see its README for a documented proof/findings skew |
| `zapcommander-acceptance-2026-07-28` | full set incl. `proof/` | the contrasting corpus — honest partial modernisation |
| `equalize-idoc-2026-07-29` | before + after + comparison | ALE/IDoc archetype; no `proof/` (analysis halves only) |
| `talv-2026-07-29` | before only | AFTER half needs a real `/modernise` run — not yet produced |
| `abap_fico-e2e-2026-07-14`, `abap_fico-verdict-arc-2026-07-22`, `zapcommander-rearchitected-2026-07-29` | partial | earlier arcs, kept as history |

`analyser/test/demo-bundle-integrity.test.js` recomputes every shipped `comparison.json` from the findings
committed beside it, and checks the proof sets agree with themselves. It runs inside `npm test`.
