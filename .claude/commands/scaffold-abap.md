---
name: scaffold-abap
description: Stamp the SAP ABAP Harness conventions into a target ABAP project (CLAUDE.md spine, .mcp.json, ATC variant, RAP/CDS/ABAP-Unit templates, state seeds, specs/ layout).
---

# /scaffold-abap — ABAP Project Initialization

Stamp the SAP ABAP Harness into a target ABAP delivery project: the always-loaded `CLAUDE.md` spine (P1–P8), the `.mcp.json` that wires the single `sap-adt` substrate, the pinned ATC variant, the RAP/CDS/ABAP-Unit fill-in templates, the `.claude/state/` ratchet ledgers, and the `specs/` directory layout the lanes read and write. The output is a project where `/fit-to-standard`, `/abap-brownfield`, `/abap-design`, `/abap-implement`, `/abap-validate`, and `/abap-transport` all run against the harness contract.

When the user runs this command, follow these steps exactly.

## Step 1: Gather Project Info — Infer + Confirm

> **MANDATORY: Q1 + confirmation card always shown.** Even if the session carries a "don't pause for clarifications" / "make the reasonable call and continue" directive, you MUST ask the free-text Q1 below AND show the confirmation card. The user invoked `/scaffold-abap` to configure a project — that is an explicit request for input gathering, not an ambiguous instruction to clarify.
>
> Silently defaulting locks in choices the user can't easily reverse (delivery shape, the DEV connection identity that goes into the cached spine, the design-critic posture).

### Step 1.A — Ask the description (Q1, free text)

Ask exactly this question with a normal prompt (no `AskUserQuestion`):

> "What are you building on SAP? In 1–3 sentences, include: the ABAP delivery shape (new RAP/Fiori app · a change to existing custom ABAP · a brownfield readiness/assessment only), the SAP target (S/4HANA Cloud Public / Private, or on-prem ABAP Platform), whether a DEV connection is available now or you'll work offline in mock mode, and any transport/landscape detail that matters (the DEV tier you push against, gCTS vs CTS)."

Wait for the answer. It goes verbatim into the stamped `CLAUDE.md` and drives the inference in 1.B. **This harness never contacts a production tier — no PRD connection is ever registered (P5); do not accept one here.**

### Step 1.B — Infer a draft profile from Q1

Apply these rules. Be explicit and conservative — when the description is ambiguous, pick the safer middle option (the user sees and can change everything in 1.C).

**Delivery shape (drives which lane leads and the design-critic posture):**
- "new" · "greenfield" · "RAP app" · "Fiori app" · "build a … from scratch" → **A New RAP build** — lead with `/greenfield` (the net-new entry over the full pipeline: `/fit-to-standard` → `/abap-design` → `/abap-implement` → `/abap-validate` → `/abap-transport`; grounds + lints OFFLINE until the live gate).
- "change" · "fix" · "add a field/action" · "modify existing Z…" · names an existing custom object → **B Brownfield change** (`/abap-brownfield` → `/abap-change` → `/abap-validate` → `/abap-transport`).
- "readiness" · "assessment" · "S/4 conversion scan" · "how clean-core is …" · "custom-code analysis" → **C Readiness-only** (`/abap-brownfield` + `/readiness` — a disposable lane, no build pipeline).
- Otherwise → **A New RAP build** (most common).

**SAP edition (drives the released-API/extension expectation, not a hard toggle):**
- "S/4HANA Cloud Public" / "Public Cloud" / "SAP BTP ABAP Environment" / "Steampunk" → **Public** (strictest Clean Core; ABAP for Cloud Development only, released APIs only — the default posture).
- "Private Cloud" / "RISE Private" / "on-prem" / "ABAP Platform 2023+" → **Private/on-prem** (ABAP Cloud still the target model per P3, but a wider released-API set is reachable; the extension ladder still applies).
- Otherwise → **Public** (the strictest posture is the safe default; the target artifact must be Level A either way).

**Connection mode (drives what the user can do immediately):**
- "mock" · "offline" · "no SAP yet" · "no DEV" · "just scaffolding" → **A Mock/offline** (run the sidecar with `S4_TRIAL_URL` unset; every `aws_abap_cb_*` call is served from fixtures; writes stay fail-closed).
- "DEV available" · "connected" · "I have a sandbox/DEV tier" · names a DEV system → **B DEV-ready** (still ships with `HARNESS_ADT_ALLOW_WRITE=0`; the human flips it to `1` against the DEV tier only when ready — never a shared or prod context).
- Otherwise → **A Mock/offline** (safe default: nothing writes to a real system until a human deliberately enables it).

**Design-critic posture (Gate 6, SOFT/WARN — sets the RAP/CDS modelling bar, never the hard gates):**
- Delivery shape = C Readiness-only → **Light** (no build, so Gate 6 is advisory only; readiness output is disposable).
- Delivery shape = A New RAP build → **Standard** (full RAP/CDS modelling critique against S/4 readiness).
- Delivery shape = B Brownfield change → **Standard** (modelling critique on the changed objects; brownfield source is diagnosed, not graded).

**Model cost posture (`.claude/scripts/model-tier.js` preset):** Always default to **balanced** (Sonnet generation, Opus judgment). Only pick `max-quality` if Q1 explicitly asks for the highest generation quality; only pick `cost` if it explicitly asks to minimise spend. The three hard gates (ATC, ABAP Unit, invariants) do not change with the tier — only which model writes vs judges.

### Step 1.C — Show the confirmation card

Call `AskUserQuestion` ONCE with the inferred profile rendered as the `preview` of option A. Single-select, three options:

- **A) Scaffold with these choices** — accept the inferred profile as-is.
- **B) Change connection mode only** — quick edit for the field with the biggest safety blast radius (mock vs DEV-ready).
- **C) Use the full configuration wizard** — for unusual deliveries or full control.

The `preview` for option A must be a markdown block in this exact shape (substitute inferred values):

```
## Inferred profile

  Description      {first 120 chars of Q1}

  Delivery shape   {A / B / C — display name}
  SAP edition      {Public | Private/on-prem}
  Connection mode  {A Mock/offline | B DEV-ready}  (writes fail-closed either way — P5)
  Design-critic    {Light | Standard}  (Gate 6, SOFT/WARN)
  Model tier       balanced (Sonnet generation · Opus judgment)
  ATC variant      ABAP_CLEAN_CORE_DEVELOPMENT (pinned, priority-1 zero — P6)
  Write gate       HARNESS_ADT_ALLOW_WRITE=0  (human enables on a DEV tier only)
```

For option B's `preview`, show the same block but emphasise the Connection mode line ("← will change"). For option C, the preview can just say "Falls through to the full configuration wizard. Inferred values become the defaults."

### Step 1.D — Branch on the user's choice

1. **"Scaffold with these choices"** → record all inferred answers as final. Proceed to Step 2.
2. **"Change connection mode only"** → call `AskUserQuestion` with a single question listing the two connection modes (Mock/offline vs DEV-ready — see wizard Q4 in Step 1.E). Record the answer, then proceed to Step 2. Do NOT loop back to the confirmation card.
3. **"Use the full configuration wizard"** → fall through to Step 1.E. Pre-pend the inferred answer to each question's description ("Inferred: A — change if needed") so the user sees what would have been picked.

If the user refuses to engage with the confirmation card ("just pick something", "use defaults"), treat that as informed consent for the inferred profile and proceed with option 1.

### Step 1.E — Wizard fallback (only if user picked option C)

Ask the following one at a time, using `AskUserQuestion` for each multi-choice question. Pre-pend the inferred answer in each question's description.

1. "What are you building on SAP?" — skip; already captured in Step 1.A.
2. "What is the delivery shape?"
   - A) New RAP/Fiori build (full pipeline)
   - B) Change to existing custom ABAP (brownfield-aware)
   - C) Readiness / assessment only (disposable, no build)
3. "Which SAP edition is the target?"
   - A) S/4HANA Cloud Public / BTP ABAP Environment (strictest Clean Core)
   - B) Private Cloud / on-prem ABAP Platform
4. "How will the harness reach the SAP system?"
   - A) Mock / offline — run the MCP-ADT sidecar with `S4_TRIAL_URL` unset; no SAP contacted
   - B) DEV connection available — still ships write-disabled; human flips `HARNESS_ADT_ALLOW_WRITE=1` on the DEV tier only
5. "Design-critic posture (Gate 6, SOFT/WARN — modelling bar only)?"
   - A) Standard (full RAP/CDS modelling critique)
   - B) Light (advisory only — for readiness/assessment work)
6. "Model cost posture?"
   - A) balanced — Sonnet generation, Opus judgment (recommended default)
   - B) cost — cheapest that still keeps Opus on the hard-gate judgments
   - C) max-quality — Opus generation as well

The hard gates (ATC priority-1 zero, ABAP Unit green, P4 invariants) and the write fail-closed default are **not** wizard options — they are contract (P4/P5/P6) and cannot be toggled off here.

## Step 2: Locate the harness plugin source

First, locate the plugin source directory. `${CLAUDE_PLUGIN_ROOT}` is the authoritative answer — Claude Code sets it to this plugin's own root for every session that loaded the plugin (marketplace install or `--plugin-dir` alike), so it never points at a stale clone or a renamed checkout. Only fall back to searching when it is unset.

```bash
# Authoritative: the running plugin's own root.
PLUGIN_SOURCE="${CLAUDE_PLUGIN_ROOT}"

# Fallback 1: newest local marketplace cache for this plugin.
if [ -z "$PLUGIN_SOURCE" ] || [ ! -f "$PLUGIN_SOURCE/.claude-plugin/plugin.json" ]; then
  PLUGIN_SOURCE=$(find ~/.claude/plugins/cache -maxdepth 5 -path "*/.claude-plugin/plugin.json" -exec grep -l '"name": "sap-abap-harness"' {} + 2>/dev/null | sort -V | tail -1 | sed 's|/.claude-plugin/plugin.json||')
fi

# Fallback 2: conventional clone location for --plugin-dir development sessions.
if [ -z "$PLUGIN_SOURCE" ]; then
  PLUGIN_SOURCE=$(find ~/AI_HARNESS_FOR_SAP/.claude -maxdepth 3 -path "*/.claude-plugin/plugin.json" -exec grep -l '"name": "sap-abap-harness"' {} \; 2>/dev/null | head -1 | sed 's|/.claude-plugin/plugin.json||')
fi

echo "Found plugin at: $PLUGIN_SOURCE"
```

If `$PLUGIN_SOURCE` is empty, ask the user: "Where is the SAP ABAP Harness (`AI_HARNESS_FOR_SAP/.claude`) cloned? I need the path to copy scaffold files." Then set `PLUGIN_SOURCE=/path/they/give/.claude`.

Resolve the harness root (one level above `.claude/`) before validation:

```bash
HARNESS_ROOT=$(dirname "$PLUGIN_SOURCE")
```

Before copying, validate the source. The load-bearing pieces are the plugin manifest, the MCP-ADT bridge, the agent roster, the skills/lanes, the hooks, the model-tier script, and the templates:

```bash
test -f "$PLUGIN_SOURCE/.claude-plugin/plugin.json"
test -f "$HARNESS_ROOT/mcp-adt-bridge/server.js"
test -f "$HARNESS_ROOT/mcp-adt-bridge/adt-tools.js"
test -f "$HARNESS_ROOT/mcp-adt-bridge/adt-client.js"
test -f "$PLUGIN_SOURCE/scripts/model-tier.js"
test -f "$PLUGIN_SOURCE/hooks/pre-write-gate.js"
test -f "$PLUGIN_SOURCE/hooks/adt-write-guard.js"
test -f "$PLUGIN_SOURCE/hooks/artifact-guard.js"
test -f "$PLUGIN_SOURCE/settings.json"
# ABAP templates the generator fills in (assert existence, not an exact count —
# the count changes when a template is added/split; existence checks don't).
for t in claude-md mcp-config atc-variant rap-bo cds-view-entity abap-unit-test transport-evidence; do
  ls "$PLUGIN_SOURCE/templates/$t".* >/dev/null 2>&1
done
# Assert the load-bearing lanes exist (agents + skills).
for a in planner abap-generator abap-evaluator abap-security-reviewer clean-core-reviewer \
         abap-design-critic abap-diff-reviewer abap-explorer transport-manager; do
  test -f "$PLUGIN_SOURCE/agents/$a.md"
done
for s in fit-to-standard abap-design abap-implement abap-validate abap-transport \
         abap-brownfield readiness abap-change abap-vibe abap-auto; do
  test -f "$PLUGIN_SOURCE/skills/$s/SKILL.md"
done
SKILL_COUNT=$(find "$PLUGIN_SOURCE/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')
test "$SKILL_COUNT" -ge 15   # sanity floor, not an exact pin
```

If any validation command fails, stop and report: "The resolved plugin source is stale or incomplete; refresh the harness plugin before scaffolding." Do not scaffold from a partial source — a missing hook or template silently disables a gate.

## Step 3: Copy Scaffold Files

**Important:** You MUST actually run these copy commands via Bash. Do NOT skip this step or try to generate the files from memory. The source files contain hooks, agent definitions, skill instructions, and the ADT bridge that must be copied exactly — a hand-written approximation loses the enforcement.

Create `.claude/` in the target project and copy the harness body:

```bash
mkdir -p .claude
cp -r "$PLUGIN_SOURCE/.claude-plugin/" .claude/.claude-plugin/
cp -r "$PLUGIN_SOURCE/agents/"        .claude/agents/
cp -r "$PLUGIN_SOURCE/skills/"        .claude/skills/
cp -r "$PLUGIN_SOURCE/hooks/"         .claude/hooks/
cp -r "$PLUGIN_SOURCE/scripts/"       .claude/scripts/
cp -r "$PLUGIN_SOURCE/templates/"     .claude/templates/
cp    "$PLUGIN_SOURCE/settings.json"  .claude/settings.json
```

Copy the MCP-ADT bridge — the harness's only engine. Without it, `.mcp.json` points at nothing and every `aws_abap_cb_*` call fails:

```bash
cp -r "$HARNESS_ROOT/mcp-adt-bridge/" ./mcp-adt-bridge/
cp    "$HARNESS_ROOT/package.json"    ./package.json   # the bridge's npm entry + test script
```

**Apply the cost-posture preset.** Stamp each agent's `model:` pin from the tier chosen in Step 1 (default `balanced` — Sonnet generation, Opus judgment). This is the one place a model is named; the agent prompt bodies stay model-agnostic.

```bash
node .claude/scripts/model-tier.js --apply balanced   # or cost | max-quality per Step 1
```

To change a project's cost posture later, re-run that command with a different preset. The hard gates never change with the tier — only which model writes vs judges.

### Generate `.mcp.json` (the single substrate wiring)

Copy the MCP config template to the project root. It wires exactly one server — `sap-adt` (the bridge) — with writes fail-closed. There is **no code graph, no browser, no gateway**; the ADT tools are the whole substrate:

```bash
cp "$PLUGIN_SOURCE/templates/mcp-config.template.json" .mcp.json
```

Then, if Step 1 chose **B DEV-ready**, leave `HARNESS_ADT_ALLOW_WRITE` at `"0"` anyway — the user flips it to `"1"` themselves against the DEV tier when they are ready (P5). Point `ADT_MCP_URL` at the live sidecar only when a DEV connection exists; the default `http://127.0.0.1:8090` (loopback only) is correct for a locally-run sidecar in either mode. Commit `.mcp.json` so the whole team shares the same substrate wiring, and settle it **before** any long `/abap-auto` run (P7 — editing `.mcp.json` mid-run busts the prompt cache).

## Step 4: Create the `specs/` directory layout

The lanes read and write these directories. Create them all so no lane fails on a missing path:

```bash
mkdir -p specs/brd specs/stories specs/design specs/abap specs/reviews specs/brownfield specs/readiness specs/delivery
```

- `specs/brd/` — the requirement / gap capture (`/fit-to-standard`, disposable lane).
- `specs/stories/` — one-object-group-per-story breakdown (`E{n}-S{n}.md`) with 3–6 acceptance criteria (`/abap-spec`).
- `specs/design/` — the CDS data model + RAP behaviour design, `object-contract.md`, `component-map.md` (`/abap-design`).
- `specs/abap/` — the generator's local ABAP source per object, each passing its `aws_abap_cb_check_syntax` self-check (`/abap-implement`).
- `specs/reviews/` — the gate verdict files (`sap-verdict.json`, `security-verdict.json`, `diff-review-verdict.json`) the human reads (`/abap-validate`).
- `specs/brownfield/` — the ADT-based discovery maps (`architecture-map.md`, `risk-map.md`) built from `get_objects`/`get_source`/`search_object` (`/abap-brownfield`).
- `specs/readiness/` — the S/4 / Clean-Core remediation backlog from `get_migration_analysis` (`/readiness`, disposable).
- `specs/delivery/` — the assembled transport plan + `transport-evidence.json`/`.md` proof pack the human releases against (`/abap-transport`).

## Step 5: Seed `.claude/state/` (the ratchet ledgers)

The Karpathy ratchet lives in these files. Seed them so the **first** `/abap-validate` run does not fail on their absence, and so the ratchet has a starting floor to tighten from.

```bash
mkdir -p .claude/state
```

**`.claude/state/learned-rules.md`** — session learnings, applied between sessions (never mid-run, per P7). Write:

```markdown
# Learned rules — SAP ABAP Harness

> Durable, project-specific lessons the lanes apply between sessions (never mid-run — P7).
> The evaluator and reviewers append here on a confirmed, repeatable finding. One rule per line,
> each traceable to the run that produced it. This file is advice that tightens over time; it is
> NOT the ATC/ABAP-Unit ratchet (those are the JSON baselines below) and NOT the CLAUDE.md spine.

_(No rules learned yet — this is a fresh scaffold.)_
```

**`.claude/state/atc-baseline.json`** — the accepted priority-2/3 ATC WARN floor. It may only **shrink** across runs; priority-1 is never baselined (priority-1 is always a hard BLOCK — P6). Seed empty:

```json
{
  "_comment": "ATC ratchet floor — accepted priority-2/3 WARN findings under variant ABAP_CLEAN_CORE_DEVELOPMENT. Only SHRINKS across runs. Priority-1 is NEVER baselined (always a hard BLOCK, P6). Established/updated by abap-evaluator on a clean run; a BLOCK run never moves it.",
  "variant": "ABAP_CLEAN_CORE_DEVELOPMENT",
  "accepted_warnings": [],
  "priority1_count": 0
}
```

**`.claude/state/abapunit-baseline.json`** — the ABAP Unit coverage floor. It may only **grow** across runs. Seed at zero:

```json
{
  "_comment": "ABAP Unit coverage ratchet floor. Only GROWS across runs — never write a lower number. Established/updated by abap-evaluator on a clean run; a BLOCK run never moves it. 80% is the working floor once real objects exist.",
  "coverage_pct": 0,
  "objects": {}
}
```

## Step 6: Stamp `CLAUDE.md` (the always-loaded spine)

Read `.claude/templates/claude-md.template.md` and write the result to `CLAUDE.md` at the project root. Fill in exactly the two stamp placeholders, then leave the file alone (P7 prompt-cache discipline — never edit the spine per-session):

- `{{PROJECT_NAME}}` — a short name for the delivery, derived from Q1 (e.g. "ACME Sales RAP", "Custom-Code S/4 Readiness").
- `{{DEV_CONNECTION}}` — the registered DEV connection identity the write tools push against. If Step 1 chose **A Mock/offline**, write `mock (offline — no DEV connection registered yet)`. If **B DEV-ready**, write the DEV tier name/identity the user gave (NEVER a PRD tier — there is no PRD connection, P5).

Everything below the header in the template is the fixed spine (P1–P8, GAN separation, the ratchet, the lanes, "the human releases the transport"). Do not edit it. Dynamic values (dates, transport IDs, object names) live in messages, never in the spine.

## Step 7: Initialize Git and state markers

```bash
git init
mkdir -p .claude/runs
echo '[]' > features.json
```

Write `.gitignore` (ABAP-retargeted — no `node_modules` build for the project itself beyond the bridge, no Python/JS app tree; keep harness run-state and any local secrets out of VCS):

```
# Environment / secrets (SAP connection creds NEVER committed)
.env
.env.local
*.secret

# MCP-ADT bridge dependencies (if the bridge ever adds npm deps)
mcp-adt-bridge/node_modules/
node_modules/

# Harness run-state (not source)
.claude/runs/
.claude/state/archive/

# Local scratch corpora — ABAP pulled via ADT is UNTRUSTED data (P8),
# kept out of the prompt AND out of VCS
scratch/
*.abap.pulled

# OS / IDE
.idea/
.vscode/
*.swp
```

**Do not commit SAP connection credentials.** The bridge reads them from `X-SAP-*` headers / environment at runtime, never from a committed file. `.mcp.json` carries only the loopback URL and the write gate — both safe to commit.

## Step 8: Verify the bridge

Run the bridge's own end-to-end tests (real process, real HTTP to a stub sidecar fixture — no mocks) to confirm the substrate is wired correctly before any lane runs:

```bash
npm test   # from the project root — exercises initialize, the 17-tool tools/list, read forwarding, and write fail-closed on/off
```

If the tests fail, stop and report — a broken bridge means every `aws_abap_cb_*` call fails and no lane can ground, validate, or deliver. Do not proceed to the report with a red bridge.

## Step 9: Report

Tailor the "Next steps" ordering to the delivery shape chosen in Step 1:

- **A New RAP build** → lead with `/fit-to-standard`.
- **B Brownfield change** → lead with `/abap-brownfield`, then `/abap-change`.
- **C Readiness-only** → lead with `/abap-brownfield` then `/readiness`, and note the build lanes are out of scope until a gap becomes a story.

```
✓ SAP ABAP Harness scaffolded successfully.

Installed:
  agents        → .claude/agents/        (9 — planner, abap-generator, abap-evaluator, clean-core-reviewer,
                                          abap-security-reviewer, abap-design-critic, abap-diff-reviewer,
                                          abap-explorer, transport-manager; model pins per the balanced preset)
  skills/lanes  → .claude/skills/         (fit-to-standard → design → implement → validate → transport,
                                          + brownfield, readiness, change, vibe, auto, and the behaviour-preservation sub-skills)
  hooks         → .claude/hooks/          (pre-write-gate · adt-write-guard · artifact-guard — P4/P5 enforced in real time)
  scripts       → .claude/scripts/model-tier.js   (re-tune cost/balanced/max-quality with one command)
  templates     → .claude/templates/      (claude-md · mcp-config · atc-variant · rap-bo · cds-view-entity · abap-unit-test · transport-evidence)
  bridge        → mcp-adt-bridge/          (MCP stdio → ADT REST — the only engine; 5/5 e2e tests)
  spine         → CLAUDE.md                (P1–P8, stamped for {{PROJECT_NAME}}, DEV connection = {{DEV_CONNECTION}})
  substrate     → .mcp.json                (server "sap-adt" only; writes fail-closed, HARNESS_ADT_ALLOW_WRITE=0)
  state seeds   → .claude/state/           (learned-rules.md · atc-baseline.json · abapunit-baseline.json — ratchet floors)
  specs layout  → specs/{brd,stories,design,abap,reviews,brownfield,readiness,delivery}/

Prerequisites (do these before a lane needs the SAP system):
  1. Run the MCP-ADT sidecar. MOCK MODE = fully offline (no SAP contacted):
       S4_TRIAL_URL unset  →  the sidecar serves every aws_abap_cb_* call from mock fixtures.
       Set S4_TRIAL_URL     →  live SAP reads. Start it on loopback: 127.0.0.1:8090 (matches ADT_MCP_URL).
  2. Keep HARNESS_ADT_ALLOW_WRITE=0 until a DEV connection is ready (P5). The 5 write tools
     (create_object, update_source, activate_object, activate_objects_batch, create_or_update_test_class)
     fail closed until a human sets it to "1" — on a non-prod DEV tier only, never a shared/prod context.
  3. The ATC variant ABAP_CLEAN_CORE_DEVELOPMENT is pinned (P6). If the target system does not carry it,
     a human imports it from .claude/templates/atc-variant.template.xml (transaction ATC/SATC or ADT import)
     before the first /abap-validate — the gate refuses a laxer/renamed variant.

Next steps:
  {ordered per the delivery shape — see above}
  A) /fit-to-standard  → prove SAP standard doesn't already deliver it, then /abap-design → /abap-implement → /abap-validate → /abap-transport
  B) /abap-brownfield  → map the existing objects (ADT reads), then /abap-change → /abap-validate → /abap-transport
  C) /abap-brownfield → /readiness  → produce the Clean-Core remediation backlog (disposable — no build pipeline)
  · For a tiny, safe edit (≤3 objects, no invariant/released-API/transport-DDIC touch), use /abap-vibe.
  · The human releases the transport — the harness produces activated DEV objects + a proof bundle, never a PRD write (P5).
```

**Mock-mode reminder (print when Step 1 chose A Mock/offline):** add one line after `Prerequisites:` —
"You are in mock/offline mode: /fit-to-standard, /abap-brownfield, /abap-design, and /abap-spec all work with zero SAP connectivity (sidecar serves fixtures). /abap-implement can author source, but activation and the /abap-validate hard gates (ATC + ABAP Unit on a live tier) need a real DEV connection — they will report failure_layer: 'infrastructure' (a BLOCK, not a workaround) until one is registered."
