# SAP ABAP Harness

An LLM will happily write ABAP that looks correct and fails on a real SAP system. This harness builds the full ABAP Cloud stack — **RAP business objects, CDS data models, Fiori Elements apps, and the ABAP classes and unit tests behind them** — and modernises brownfield ABAP to the same bar. What makes the output trustworthy is that it splits writing from judging: one agent writes the code, a separate fresh-context agent grades it by activating it on a live SAP system and running ATC and ABAP Unit against it. The writer never signs off on its own work, the accepted quality bar only ratchets up, and the pipeline stops at activated, proven objects in DEV — a human reads the proof bundle and releases the transport.

It runs on its **own local substrate** — a Node MCP-ADT sidecar/bridge to a real SAP system, a standalone `@abaplint/core` analyser, and an offline Clean-Core grounding + linting engine — so the analysis and generation happen with no cloud service in the loop. `CLAUDE.md` is the always-loaded spine (the prime directives **P1–P8**); this README is the map.

## How it works — one object's journey

Follow a single CDS view or RAP business object from request to release:

1. **Fit-to-standard** — if SAP already delivers it, build nothing. Only a real gap proceeds.
2. **Grounding** — before a line is written, every API, table, and CDS entity the object needs is checked against SAP's *released* contracts (the offline greenfield grounder over the bundled cloudification registry). Unreleased APIs never reach the generator.
3. **Generation** — the generator writes the RAP behaviour, CDS entities, ABAP class, and ABAP Unit tests, and self-checks **syntax only**. It cannot render its own quality verdict, mark its own ATC clean, or merge.
4. **Independent judgment** — a fresh-context evaluator takes the *unchanged* source, pushes it to a live SAP DEV tier it does not control, activates it, and runs ATC (variant `ABAP_CLEAN_CORE_DEVELOPMENT`) and ABAP Unit. It returns **PASS / WARN / BLOCK**. A check that could not run is a BLOCK, never a skip.
5. **The ratchet** — every clean run tightens the bar: accepted-WARN findings can only shrink and test coverage can only grow. You cannot ratchet down by deleting a gate.
6. **Proof, then stop** — the harness assembles a proof bundle (activation log, ATC findings with priorities, ABAP Unit results, Clean-Core level, invariant diff) and releases nothing. A human reads the proof and releases the transport DEV→QAS→PRD.

The same engines run **offline at scale** — the analyser and modernisation engine reach a real verdict with zero credentials — and **live for proof**, where the evaluator confirms it on a real system. One set of engines, two ways to work.

## See it work

Two committed demo bundles, each a real customer FICO package rather than a toy:

- **[`demos/abap_fico-e2e-2026-07-14/`](demos/abap_fico-e2e-2026-07-14/)** — a brownfield package modernised end to end. In this run, S/4 readiness went **36 → 100**, Clean-Core grade **D → A**, and analyser findings **879 → 646** ([`comparison.json`](demos/abap_fico-e2e-2026-07-14/comparison.json)); the before/after source and a rendered walkthrough are in the bundle.
- **[`demos/abap_fico-verdict-arc-2026-07-22/`](demos/abap_fico-verdict-arc-2026-07-22/)** — the independent judge pointed at those modernised drafts. It does **not** rubber-stamp: the offline verdict is **`BLOCK`**, with four independent reasons (`atc-p1-nonzero`, `atc-p2-nonzero`, `auth-delta-unattested`, `parity-not-equivalent:needs_review`), and the driver loops back to regenerate ([`offline-verdict.json`](demos/abap_fico-verdict-arc-2026-07-22/offline-verdict.json)). The grader is real enough to fail the harness's own output until it is actually clean.

## What's inside

- `CLAUDE.md` spine (P1–P8), `.claude/.claude-plugin/plugin.json`, `.mcp.json`, `package.json`
- **Standalone analyser** (`analyser/`) — an `@abaplint/core` code property graph + 16 rule packs → S/4 readiness, blast radius, and `analyser-findings.json`; its own `abap-analyser` MCP (`analyse_bundle` / `analyse_source_system` / `analyse_via_adt` / `get_report`)
- **Oracle** (`oracle/`) — a standalone, conservative clean-core classifier: it maps SAP's released-object registries onto an A/B/C/D readiness level, a shared lower bound the analyser imports directly to ground its findings. No MCP server of its own; the live ATC is the authoritative reconciler.
- **Moderniser** (`moderniser/`) — the offline modernisation engine: it consumes the analyser's findings, freezes a content-hashed dependency plan, and drives each object GROUND → TRANSFORM → SELF-CHECK → VERDICT under a deterministic scheduler. Offline it reaches a *provisional* verdict (never GREEN, by design — activation and ABAP Unit need a live tier); a live mode pushes, activates, and gates on DEV to earn GREEN
- **Greenfield pipeline** (`greenfield/`) — pre-generation released-API grounding over the bundled cloudification registry + a **58-rule** parser-based ABAP-Cloud linter (`@abaplint/core`); its own `greenfield` MCP (`ground_released_apis` / `lint_abap_cloud`), wired into the design/implement/validate lanes with a lint→regenerate loop
- **MCP-ADT bridge** (`mcp-adt-bridge/`) + **ported ADT sidecar** (`sap-adt-sidecar/`) — MCP stdio to real ADT REST, **17 tools**, writes fail-closed (P5)
- **9 agents** (`.claude/agents/`) — planner, generator, evaluator, design-critic, security-reviewer, diff-reviewer, clean-core-reviewer, explorer, transport-manager
- **24 skills/lanes** (`.claude/skills/`) — effort scales to the stakes, from `/abap-vibe` (a ≤3-object quick fix) up to the full `/fit-to-standard → /abap-brownfield → /abap-design → /abap-implement → /abap-validate → /abap-transport` pipeline
- **Hooks + settings** (`.claude/hooks/`, `.claude/settings.json`) — two deliberately separate tiers. **Enforcement** (`pre-write-gate`, `adt-write-guard`, `artifact-guard`) runs at `PreToolUse`, exits 2, and fails closed. **Advisory** (`record-run`, `verify-on-save`, `atc-on-activate`, `ratchet-guard`, `review-on-stop`) observes and reports, always exit 0. Two paths that could both veto would be two sources of truth for "is this allowed"; a contract test asserts no advisory hook can block
- **Templates** (RAP BO, CDS view entity, ABAP Unit, DDIC table, DDLX metadata-extension, SRVD/SRVB service definition + binding, Fiori-Elements app-project, transport-evidence), **model-tier.js** (cost / balanced / max-quality), state seeds

## Running it

```bash
# Start the ported Node sidecar (no docker, no Python). Binds 127.0.0.1:8090:
node sap-adt-sidecar/server.js            # ADAPTER_PORT overrides the port

# Offline tests (no SAP needed) — real processes + real failure paths:
npm test

# LIVE end-to-end against a real SAP system (read-only). Fails LOUDLY if creds
# are missing — never skipped, never faked:
SAP_HOST=... SAP_USER=... SAP_PASSWORD=... \
  SAP_PORT=44300 SAP_CLIENT=100 SAP_TEST_PACKAGE=SABAPDEMOS \
  NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npm run test:live

# LIVE write-path E2E (create/update/test-class/activate/unit-test) — DEV ONLY (P5):
SAP_HOST=... SAP_USER=... SAP_PASSWORD=... LIVE_WRITE_PACKAGE='$TMP' \
  npm run test:live:write
```

## The MCP-ADT sidecar & bridge

The core substrate is the harness's own Node ADT sidecar — no Python, no docker. It is a REST service (`POST /mcp` with `{tool, params}` + `X-SAP-*` credential headers, `GET /health`) bound to `127.0.0.1:8090`. All 17 tools make real ADT calls; writes are real lock→PUT→activate flows, and quality-tool errors propagate instead of collapsing to empty or fabricated results (P6 fail-closed).

- `sap-adt-sidecar/lib/` — `session.js` (real ADT auth: discovery + basic auth + CSRF + cookie jar), `adt-xml.js` (namespace-agnostic parse/build), `adt-uris.js`, `security.js` (credential-scrubbing error sanitizer)
- `sap-adt-sidecar/handlers/` — `read.js`, `quality.js`, `write.js` (the 17 tools)
- `mcp-adt-bridge/` — the MCP stdio → ADT REST bridge: `server.js` (JSON-RPC 2.0), `adt-tools.js` (17-tool registry + read/write classification), `adt-client.js`
- All tests are **real-path — no mocks, no stubs, no fakes**: offline tests spawn the real processes and exercise real failure paths (bad input, closed ports); the SAP round-trip lives in the live suites above.

**Read vs write (P5 fail-closed).** 12 tools are read-only and run freely. The **5 write tools** (`create_object`, `update_source`, `activate_object`, `activate_objects_batch`, `create_or_update_test_class`) are blocked at the bridge by default and only run when `HARNESS_ADT_ALLOW_WRITE=1` — set that only against a DEV connection. There is no PRD connection.

## Notes

- `.mcp.json` wires the three **live** MCP servers — `sap-adt` (the bridge to SAP; `ADT_MCP_URL` defaults to the sidecar at `127.0.0.1:8090`), `abap-analyser`, and `greenfield`. That is only the live half: the **offline pipeline is engine-direct** — the analyser writes `analyser-findings.json`, the moderniser reads it, and the oracle is imported in-process — with no MCP server and no credentials. `NODE_TLS_REJECT_UNAUTHORIZED=0` is needed only for a self-signed (trial) SAP certificate.
- `docs/` is a local working-progress folder, deliberately not tracked here — design docs, build contracts, and specs live on the maintainer's machine only. Source comments that cite a `docs/…` path point at those local documents; the code does not read them at runtime. The durable, shipped record is the code, its tests, and the `demos/` bundles.
