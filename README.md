# SAP ABAP Harness

A Claude Code harness for **ABAP SDLC against a live (or mock) SAP system**, built for ABAP Cloud / RAP / CDS. Generator/evaluator separation, the Karpathy ratchet, lanes, and "the human merges", over its **own local substrate**: a Node MCP-ADT sidecar/bridge and a standalone `@abaplint/core` analyser.

**The core substrate is the MCP-ADT server** (ABAP Developer Tools — 17 `aws_abap_cb_*` tools). Grounding, quality gates, and delivery ride those tools; the standalone **analyser** adds an offline/local code graph on top. `CLAUDE.md` is the always-loaded spine (prime directives P1–P8); this README carries the roster and reference tables (kept out of `CLAUDE.md` for prompt-cache stability).

> **`docs/` is a local working-progress folder and is deliberately not tracked in this repository.** Design docs, build contracts, architecture specs and reference material live there on the maintainer's machine only. Source comments and schema descriptions that cite a `docs/…` path are pointing at those local working documents — the code does not read them at runtime, so nothing here depends on their presence. The durable, shipped record is the code, its tests, and the `demos/` bundles.

## The MCP-ADT sidecar (`sap-adt-sidecar/`) + bridge (`mcp-adt-bridge/`)

The harness ships its **own Node ADT sidecar** — no mock mode, no Python, no docker. It is a REST service (`POST /mcp` with `{tool, params}` + `X-SAP-*` credential headers, `GET /health`) bound to `127.0.0.1:8090`. All 17 tools make real ADT calls; writes are real lock→PUT→activate flows, and quality-tool errors propagate instead of collapsing to empty or fabricated results (P6 fail-closed).

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

## What's inside

- `CLAUDE.md` spine (P1–P8), `.claude/.claude-plugin/plugin.json`, `.mcp.json`, `package.json`
- **Standalone analyser** (`analyser/`) — `@abaplint/core` code property graph + 16 rule packs → S/4 readiness + blast radius + `analyser-findings.json`; its own `abap-analyser` MCP (analyse_bundle / analyse_source_system / analyse_via_adt / get_report)
- **Greenfield pipeline** (`greenfield/`) — pre-generation released-API grounding over the bundled cloudification registry + a **58-rule parser-based ABAP-Cloud linter** (`@abaplint/core`); its own `greenfield` MCP (`ground_released_apis` / `lint_abap_cloud`); wired into the design/implement/validate lanes with a lint→regenerate loop, a `/greenfield` entry-point, and an offline dry-run
- **MCP-ADT bridge** (`mcp-adt-bridge/`) + **ported ADT sidecar** (`sap-adt-sidecar/`) — MCP stdio to ADT REST, 17 tools, real writes fail-closed (P5)
- **9 agents** (`.claude/agents/`) — planner, abap-generator, abap-evaluator, abap-design-critic, abap-security-reviewer, abap-diff-reviewer, clean-core-reviewer, abap-explorer, transport-manager
- **24 skills/lanes** (`.claude/skills/`) — greenfield (net-new entry), abap-analyser (analyser producer), fit-to-standard, abap-brownfield, readiness, seam-finder, abap-spec, abap-design, abap-implement, abap-validate, abap-transport, abap-auto, abap-build, abap-change, abap-vibe, abap-refactor, abap-test, clarify + behaviour-preservation sub-skills
- **Hooks + settings** (`.claude/hooks/`, `.claude/settings.json`) — 3 enforcement + 5 advisory over a unit-tested check library
- **model-tier.js** (cost/balanced/max-quality), **templates** (RAP BO, CDS view entity, ABAP Unit, ATC variant, DDLX metadata-extension, SRVD service-definition, SRVB service-binding, Fiori-Elements app-project, transport-evidence + claude-md/mcp-config stamps), **scaffold-abap** command, **state seeds**

**Hook layer — two tiers, deliberately separate:**
- **Enforcement** (`PreToolUse` / `UserPromptSubmit`, exit 2, fail-closed) — `pre-write-gate`, `adt-write-guard`, `artifact-guard`
- **Advisory** (observe and report, always exit 0) — `record-run`, `verify-on-save`, `atc-on-activate`, `ratchet-guard`, `review-on-stop`

An advisory hook never blocks. Two independent paths that can both veto would be two sources of truth for "is this allowed"; a contract test asserts no advisory hook is wired to a blocking event and none can exit non-zero.
