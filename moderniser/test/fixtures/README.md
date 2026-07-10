# Moderniser test fixtures

## `analyser-findings.json` — the golden fixture

A real analyser output over a small package, used as the deterministic input for the
moderniser's pure step-1–4 modules (no DEV connection needed).

**Regenerate (read-only over the corpus, produces our derived JSON):**

```
node analyser/cli.js <abap_fico>/src/btc --package ZFICO_BTC \
  --out moderniser/test/fixtures/analyser-findings.json
```

Package `ZFICO_BTC` = 3 report programs (`ZFICO_BTC_CSV_GL/SCR/TOP`) + DDIC. Chosen
because it is small yet has a real dependency chain — `ZFICO_BTC_CSV_GL` (wave 1)
depends on the two wave-0 programs — which exercises `freezePlan` waves and the
REPLAN diff. Only the analyser's **derived findings JSON** is committed here, never
the external ABAP source.

`generated_at` is the sole volatile field; the fixture is frozen at commit time.

## Fixture-scaling strategy (operator decision, 2026-07-11)

Iterate the moderniser against fixtures of increasing size — see `MODERNISER_DESIGN.md` §6.2:

1. **toy** — `ZFICO_BTC` (this fixture): fast pure-module TDD.
2. **real** — full `abap_fico` (60 nodes / 11 plan objects): integration realism.
3. **scale** — `zapcommander` (~73 objects): scale-path (SCC condensation, frontier, min-FAS).

**Hard NFR:** the moderniser must scale to **hundreds of objects and 100K+ LOC**. The toy
fixture is a dev convenience, **not** the scale target — no module is "done" until it is
validated on the scale fixture.

