# SAP ABAP Harness

A Claude Code harness for **ABAP SDLC against a live (or mock) SAP system** — the engineering harness `claude_harness_eng_v5` retargeted for ABAP Cloud / RAP / CDS. Same anatomy (generator/evaluator separation, the Karpathy ratchet, lanes, "the human merges"), same "no backend of its own" philosophy.

**The only external substrate is the MCP-ADT server** (ABAP Developer Tools — 17 `aws_abap_cb_*` tools). Everything — grounding, quality gates, delivery — rides those tools. There is no code graph, analyser, or gateway. `CLAUDE.md` is the always-loaded spine (prime directives P1–P8); this README carries the roster and reference tables (kept out of `CLAUDE.md` for prompt-cache stability).

## The MCP-ADT bridge (`mcp-adt-bridge/`)

The ADT sidecar (`docker/sap-adt/adapter.py`) is a **FastAPI REST** service (`POST /mcp`, port 8090), **not** a native MCP server — a Claude Code `.mcp.json` cannot connect to it directly. This harness ships a thin **MCP stdio → ADT REST bridge** so the agents can call the ADT tools as normal MCP tools. It is the harness's only new engine.

- `server.js` — MCP stdio server (JSON-RPC 2.0). Handles `initialize`, `tools/list`, `tools/call`.
- `adt-tools.js` — the 17-tool registry with input schemas and the read/write classification.
- `adt-client.js` — forwards a call to the sidecar's `POST /mcp` with `X-SAP-*` credential headers.
- `test/` — end-to-end tests (real process, real HTTP to a stub sidecar fixture — no mocks).

### Read vs write (P5 fail-closed)

12 tools are read-only and run freely. The **5 write tools** (`create_object`, `update_source`, `activate_object`, `activate_objects_batch`, `create_or_update_test_class`) are **blocked at the bridge by default** and only run when `HARNESS_ADT_ALLOW_WRITE=1` — set that only against a DEV connection. There is no PRD connection.

### Running it

```bash
# 1. Start the ADT sidecar (from the TALOS repo). Mock mode = fully offline (no SAP):
#    S4_TRIAL_URL unset  -> MockToolHandlers ; set -> live SAP.
#    uvicorn adapter:app --host 127.0.0.1 --port 8090   (or via its docker compose)
# 2. The harness reaches it through .mcp.json (server "sap-adt"); override the target with:
#      ADT_MCP_URL=http://127.0.0.1:8090
# 3. Tests:
npm test
```

`.mcp.json` wires exactly one server, `sap-adt`, pointing at `127.0.0.1:8090` with writes disabled by default.

## Build status

**Built and verified** — `npm test` → **31/31 green**, all TDD red→green (6 check-library + 14 hooks + 6 model-tier + 5 bridge):
- `CLAUDE.md` spine (P1–P8), `.claude/.claude-plugin/plugin.json`, `.mcp.json`, `package.json`
- **MCP-ADT bridge** (`mcp-adt-bridge/`) — MCP stdio to ADT REST, 17 tools, writes fail-closed (P5)
- **9 agents** (`.claude/agents/`) — planner, abap-generator, abap-evaluator, abap-design-critic, abap-security-reviewer, abap-diff-reviewer, clean-core-reviewer, abap-explorer, transport-manager
- **21 skills/lanes** (`.claude/skills/`) — fit-to-standard, abap-brownfield, readiness, abap-spec, abap-design, abap-implement, abap-validate, abap-transport, abap-auto, abap-build, abap-change, abap-vibe, abap-refactor, abap-test, clarify + 6 behaviour-preservation sub-skills
- **Enforcement hooks + settings** (`.claude/hooks/`, `.claude/settings.json`) — pre-write-gate, adt-write-guard, artifact-guard over a unit-tested check library
- **model-tier.js** (cost/balanced/max-quality), **templates** (RAP BO, CDS view entity, ABAP Unit, ATC variant, transport-evidence + claude-md/mcp-config stamps), **scaffold-abap** command, **state seeds**

**Not yet built:**
- Advisory/telemetry hooks — `record-run`, `verify-on-save`, `review-on-stop`, `atc-on-activate`, `ratchet-guard` (then wired into `settings.json`).
- Reconcile: `abap-generator` cites `specs/brownfield/{symbol-map,test-map}.md`, which `abap-brownfield` does not emit (it writes `architecture-map.md` / `risk-map.md` / `change-strategy.md`).

Nothing under `claude_harness_eng_v5/demos` (the pKYC demo, its port block, etc.) is copied — only the reusable harness anatomy.
