# Fetching the `abap_fico` corpus

The demos in this directory analyse a real brownfield ABAP corpus. **That corpus is not vendored
here**, and the demo directories therefore contain the analysis, the metrics and the proof
bundles, but not the source they were computed from.

## Why

The corpus is <https://github.com/PON-HANNES/abap_fico> — "FICO Support Functions". It is public,
but it carries **no licence**: no `LICENSE` file, nothing in the README, no copyright header in any
file. Under GitHub's Terms of Service, publishing a repository publicly grants others the right to
view and fork it *on GitHub*; it grants nothing else. Absent a licence, the work is
all-rights-reserved by default.

So copying its files into this repository and publishing them under this repository's MIT licence
would be two distinct mistakes: redistributing without permission, and implying an ownership claim
that is not ours. Neither is fixed by a licence carve-out — a carve-out disclaims ownership, it
does not grant a right to redistribute.

The analysis *about* that code — findings counts, readiness percentages, the verdict, the object
names — is our own work and stays. The code itself is fetched by you.

## Fetch it

```bash
git clone https://github.com/PON-HANNES/abap_fico.git ~/abap_fico-upstream
```

## Layout the corpus suite expects

```
$ABAP_FICO_CORPUS/
  before/source/               the classic corpus  (upstream `src/`)
  after/modernised-source/     the modernised RAP output
  after/analyser-findings.json optional — regenerated if absent
```

`before/source/` is the upstream clone's `src/`. `after/modernised-source/` is what the moderniser
produced from it — regenerate it by running the `/modernise` lane over the before-side, or keep the
copy from your own earlier run.

## Run the acceptance suite

```bash
ABAP_FICO_CORPUS=~/abap_fico-corpus-local npm run test:corpus
```

This is the **B7 offline E2E acceptance**: it asserts that the modernised artifacts' residuals
BLOCK rather than resting provisionally, that the driver self-corrects by regenerating with the
findings threaded in, that the imperative→declarative paradigm shift and the authorization
relocation are both detected, and that two passes over the same corpus are byte-identical.

It is deliberately **not** part of `npm test`, for the same reason `npm run test:live` is not: its
input cannot be shipped. And like `test:live`, it **fails loudly** when its input is missing —
never skipped, never faked. A suite that quietly skips is indistinguishable from one that passes.

## What still runs without the corpus

`npm test` — the full 1300+ test suite, including every unit and integration test for the
extraction engines, the judges, the ratchet, the driver and the CLI. The corpus suite adds one
thing the shipped suite cannot: the assertion that all of it holds against genuine customer ABAP
rather than fixtures written by the same hand that wrote the code under test.
