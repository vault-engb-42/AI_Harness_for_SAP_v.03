# SAP ABAP Harness

A Claude Code harness for **ABAP SDLC against a live (or mock) SAP system** — the engineering harness `claude_harness_eng_v5` retargeted for ABAP Cloud / RAP / CDS. Same anatomy (generator/evaluator separation, the Karpathy ratchet, lanes, "the human merges"), but with its **own local substrate**: a ported MCP-ADT sidecar/bridge and a standalone `@abaplint/core` analyser (TALOS is reference-only, never called at runtime).

**The core substrate is the MCP-ADT server** (ABAP Developer Tools — 17 `aws_abap_cb_*` tools). Grounding, quality gates, and delivery ride those tools; the standalone **analyser** adds an offline/local code graph on top. `CLAUDE.md` is the always-loaded spine (prime directives P1–P8); this README carries the roster and reference tables (kept out of `CLAUDE.md` for prompt-cache stability).

## The MCP-ADT sidecar (`sap-adt-sidecar/`) + bridge (`mcp-adt-bridge/`)

The harness ships its **own Node ADT sidecar** — the TALOS `docker/sap-adt` adapter ported to real working code (no mock mode). It is a FastAPI-compatible REST service (`POST /mcp` with `{tool, params}` + `X-SAP-*` credential headers, `GET /health`) bound to `127.0.0.1:8090`. All 17 tools make real ADT calls; the reference's fake-success write handlers are replaced with real lock→PUT→activate flows, and quality-tool errors propagate instead of collapsing to empty/fabricated results (P6 fail-closed).

- `sap-adt-sidecar/lib/` — `session.js` (real ADT auth: discovery + basic auth + CSRF fetch + manual cookie jar), `adt-xml.js` (namespace-agnostic parse/build), `adt-uris.js`, `security.js` (credential-scrubbing error sanitizer).
- `sap-adt-sidecar/handlers/` — `read.js`, `quality.js`, `write.js` (the 17 tools).
- `mcp-adt-bridge/` — the thin **MCP stdio → ADT REST bridge**: `server.js` (JSON-RPC 2.0), `adt-tools.js` (17-tool registry + read/write classification), `adt-client.js` (forwards to the sidecar).
- All tests are **real-path — no mocks, no stubs, no fakes**: offline tests spawn the real processes and exercise real failure paths (bad input, closed ports); the SAP round-trip lives in the live suites (below).

### Read vs write (P5 fail-closed)

12 tools are read-only and run freely. The **5 write tools** (`create_object`, `update_source`, `activate_object`, `activate_objects_batch`, `create_or_update_test_class`) are **blocked at the bridge by default** and only run when `HARNESS_ADT_ALLOW_WRITE=1` — set that only against a DEV connection. There is no PRD connection.

### Running it

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

`NODE_TLS_REJECT_UNAUTHORIZED=0` is needed only for a self-signed (trial) SAP certificate. `.mcp.json` wires three servers — `sap-adt` (bridge; `ADT_MCP_URL` defaults to the sidecar at `127.0.0.1:8090`, writes fail-closed), `abap-analyser` (the standalone analyser), and `greenfield` (the greenfield grounding + ABAP-Cloud linter).

## Build status

**Built and verified** — `npm test` → **441/441 green**, all TDD red→green (6 check-library + 14 hooks + 6 model-tier + 5 lane-contracts + 5 bridge + 296 analyser + 91 greenfield + 18 sidecar):
- `CLAUDE.md` spine (P1–P8), `.claude/.claude-plugin/plugin.json`, `.mcp.json`, `package.json`
- **Standalone analyser** (`analyser/`) — `@abaplint/core` code property graph + 16 rule packs at full TALOS parity → S/4 readiness + blast radius + `analyser-findings.json`; its own `abap-analyser` MCP (analyse_bundle / analyse_source_system / analyse_via_adt / get_report)
- **Greenfield pipeline** (`greenfield/`) — pre-generation released-API grounding over the bundled cloudification registry + a **58-rule parser-based ABAP-Cloud linter** (`@abaplint/core`); its own `greenfield` MCP (`ground_released_apis` / `lint_abap_cloud`); wired into the design/implement/validate lanes with a lint→regenerate loop, a `/greenfield` entry-point, and an offline dry-run
- **MCP-ADT bridge** (`mcp-adt-bridge/`) + **ported ADT sidecar** (`sap-adt-sidecar/`) — MCP stdio to ADT REST, 17 tools, real writes fail-closed (P5)
- **9 agents** (`.claude/agents/`) — planner, abap-generator, abap-evaluator, abap-design-critic, abap-security-reviewer, abap-diff-reviewer, clean-core-reviewer, abap-explorer, transport-manager
- **23 skills/lanes** (`.claude/skills/`) — greenfield (net-new entry), abap-analyser (analyser producer), fit-to-standard, abap-brownfield, readiness, seam-finder, abap-spec, abap-design, abap-implement, abap-validate, abap-transport, abap-auto, abap-build, abap-change, abap-vibe, abap-refactor, abap-test, clarify + behaviour-preservation sub-skills
- **Enforcement hooks + settings** (`.claude/hooks/`, `.claude/settings.json`) — pre-write-gate, adt-write-guard, artifact-guard over a unit-tested check library
- **model-tier.js** (cost/balanced/max-quality), **templates** (RAP BO, CDS view entity, ABAP Unit, ATC variant, transport-evidence + claude-md/mcp-config stamps), **scaffold-abap** command, **state seeds**

**Not yet built:**
- Advisory/telemetry hooks — `record-run`, `verify-on-save`, `review-on-stop`, `atc-on-activate`, `ratchet-guard` (then wired into `settings.json`).
- Reconcile: `abap-generator` cites `specs/brownfield/{symbol-map,test-map}.md`, which `abap-brownfield` does not emit (it writes `architecture-map.md` / `risk-map.md` / `change-strategy.md`).

Nothing under `claude_harness_eng_v5/demos` (the pKYC demo, its port block, etc.) is copied — only the reusable harness anatomy.
