# Fetching the demo corpora

The demos in this directory analyse **real, third-party brownfield ABAP corpora**. Those corpora are
**not vendored here** — each demo directory ships the *analysis, the metrics, and the proof bundles*,
but **not the source they were computed from**. Fetch the source yourself with the per-corpus steps
below; the analysis *about* the code (findings counts, readiness %, verdicts, object names) is this
project's own work and stays.

## Why the source is never vendored

Each corpus is public but carries a licence that makes committing its files into *this* (MIT) repo the
wrong thing to do — either it has **no licence** (all-rights-reserved by default) or a **copyleft**
licence (GPL) whose obligations we do not want to spread into the harness. In every case the rule is
the same and mechanical (`.gitignore`): the corpus **source** (`before/source/`) and the **modernised
output** (`after/modernised-source/`) live locally and are git-ignored; only the analysis + proof are
committed.

---

## Corpus 1 — `abap_fico` (mid-size; the acceptance suite)

- **Repo:** <https://github.com/PON-HANNES/abap_fico> — "FICO Support Functions".
- **Licence:** **NONE** (no `LICENSE`, no header) ⇒ all-rights-reserved by default. Not redistributable,
  so not vendored.
- **Used by:** `demos/abap_fico-e2e-2026-07-14/`, `demos/abap_fico-verdict-arc-2026-07-22/`,
  `demos/abap_fico-acceptance-2026-07-27/`, and the **B7 offline acceptance suite**
  (`moderniser/test/corpus/abap-fico.corpus.test.js`).

```bash
git clone https://github.com/PON-HANNES/abap_fico.git ~/abap_fico-upstream
```

Layout the acceptance suite expects:

```
$ABAP_FICO_CORPUS/
  before/source/               the classic corpus  (upstream `src/`)
  after/modernised-source/     the modernised RAP output (regenerate via /modernise, or keep your run)
  after/analyser-findings.json optional — regenerated if absent
```

Run the acceptance:

```bash
ABAP_FICO_CORPUS=~/abap_fico-corpus-local npm run test:corpus
```

This is the B7 offline E2E acceptance: it asserts the modernised residuals BLOCK (not rest
provisionally), the driver self-corrects, the imperative→declarative paradigm shift + the authorization
relocation are both detected, and two passes are byte-identical. It is deliberately **not** part of
`npm test` (its input cannot be shipped) and **fails loudly** when the corpus is missing — never
skipped, never faked.

---

## Corpus 2 — `zapcommander` (the scale fixture)

- **Repo:** <https://github.com/tricktresor/zapcommander> — "zAP Commander" / "SAP Commander", a classic
  SAP-GUI dual-pane file & object manager (dynpro/module-pool). ~47 ABAP sources, ~7,686 LOC, ~39
  modernisable plan nodes across 6 waves — the **tier-3 scale-path** fixture (SCC condensation, frontier,
  min-FAS).
- **Licence:** **GPLv3** (viral copyleft). Redistributable, but any redistributed/derived source must
  itself be GPLv3 — so, to keep the harness repo clean of copyleft obligations, **both the source AND the
  modernised output stay local + git-ignored**; only the analysis + proof are committed.
- **Used by:** `demos/zapcommander-acceptance-2026-07-28/`.

```bash
git clone https://github.com/tricktresor/zapcommander.git ~/zapcommander-upstream
```

Layout:

```
$ZAPCOMMANDER_CORPUS/
  before/source/               the classic corpus  (upstream `src/`)
  after/modernised-source/     the modernised output (git-ignored — GPLv3 derivative)
  after/analyser-findings.json optional — regenerated if absent
```

> **Honest note on this corpus:** zapcommander is a SAP-GUI/OS file manager — dynpro screens, OS command
> execution, frontend file I/O, RFC directory listing, dynamic ABAP execution. Most of that has **no ABAP
> Cloud equivalent**, so the demo's value is showing the harness handle the *scale* (39 nodes / 6 waves)
> and **honestly seal / park / NEEDS_MANUAL_SEAM** the un-modernisable objects rather than fabricating a
> RAP rewrite. See the demo's `README.md`.

---

## What runs without any corpus

`npm test` — the full suite, including every unit/integration test for the extraction engines, the
judges, the ratchet, the driver and the CLI. The corpus suites (`test:corpus`) add the one thing the
shipped suite cannot: the assertion that all of it holds against genuine customer ABAP rather than
fixtures written by the same hand that wrote the code under test.
