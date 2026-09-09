# equalize-idoc — ALE/IDoc archetype bundle (2026-07-29)

An **ALE / IDoc integration** package: inbound process-code handlers and outbound senders. It exists as an
archetype the other corpora do not cover — `abap_fico` is batch/FI, `zapcommander` is utility/reporting, and
neither exercises asynchronous cross-system integration. Every ALE direction defect the harness has found was
found here.

The corpus source is **not vendored** (third-party, see [`FETCH.md`](FETCH.md) and
[`security-scan.md`](security-scan.md)). The analysis *about* the code is this project's own work and is
tracked.

## Before → after

| Metric | BEFORE (classic) | AFTER (modernised drafts) |
|---|---|---|
| **S/4HANA readiness** | **67%** | **100%** |
| **ABAP Cloud readiness** | **44%** | **83%** |
| Clean-Core grade | **D** | **A** |
| Total findings | 1879 | 57 |
| **Priority-1 findings** | **61** | **0** |
| Priority-2 findings | 1796 | 57 |
| Graph nodes / edges | 129 / 151 | 7 / 6 |

Every figure above is recomputed from the two `analyser-findings.json` docs committed here, and
[`comparison.json`](comparison.json) is verified against them on every test run by
`analyser/test/demo-bundle-integrity.test.js`. A drift between the table and the evidence fails the gate.

## What is here

```
before/analyser-findings.json     the analyser's BEFORE diagnosis
before/equalize-idoc-BEFORE.html  ← open in a browser
before/planner-digest.json        the planner's view of the same run
after/analyser-findings.json      the AFTER diagnosis (A grade, 100% S/4, 57 findings)
after/equalize-idoc-AFTER.html    ← open in a browser
after/planner-digest.json
comparison.json                   machine-readable before/after deltas
before-after-comparison.html      ← the rendered delta
```

## What is deliberately NOT here

No `offline-verdict.json` and no `proof/` directory. Those are the output of a full `/modernise` driver run
(plan → disposition → arch → drive → verdict), and this bundle carries the **analysis** halves only. The
comparison above is a pure function of the two findings docs and needs no run; a verdict is not. See
`demos/abap_fico-acceptance-2026-07-27/` for a bundle that ships the full proof set.

## What this bundle has taught the harness

- **ALE direction is a real distinction.** `rap_bo_events` keyed on `consumption:remote_idoc`, which fires
  identically for an inbound process-code handler and an outbound sender, and prescribed
  `rap_business_events` to both. An inbound handler is a receiver: it raises nothing. The three
  `ZCL_IDOC_INPUT_*` objects here are what made that visible.
- **Direction is not always resolvable.** `ZCL_IDOC_OUTPUT`'s only ALE callee is `IDOC_INBOUND_ASYNCHRONOUS`,
  whose direction lives in the destination the CPG edge cannot see. The harness declines to guess, and the
  conservative shape is the one that omits an unjustifiable component.
