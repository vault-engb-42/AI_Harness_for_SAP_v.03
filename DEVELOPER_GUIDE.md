# AI_HARNESS_FOR_SAP — Developer Guide

A start-from-zero guide for developers who have **never seen this harness before**. It explains
what the harness is, how to set it up on your machine, and how to use it two ways:

- **A) Offline** — analyse and develop ABAP with **no SAP connection at all**.
- **B) Online** — analyse and develop against a **real SAP DEV system**, up to activated, gate-proven
  objects that a human then releases.

> Everything here reflects the code on `main`. There is **no mock mode** — "offline" means the
> harness's offline *engines* (which never touch SAP), not a faked SAP system.

---

## 1. What the harness is (in one screen)

It is a **Claude Code plugin** that builds and modernises **ABAP Cloud** — RAP business objects, CDS
data models, Fiori Elements apps, and the ABAP classes and ABAP Unit tests behind them — and holds the
output to a Clean-Core, released-API-only bar.

What makes it trustworthy is **separation of writing from judging** (a GAN idea):

- One agent (**generator**) writes the ABAP and only self-checks *syntax*.
- A separate, fresh-context agent (**evaluator**) grades it by **activating it on a real SAP system and
  running ATC + ABAP Unit**. The writer can never mark its own work "clean."
- The accepted quality bar only ever **ratchets up** (accepted warnings shrink, coverage grows).
- The pipeline stops at **activated, proven objects in a DEV system plus a proof bundle**. **A human
  reads the proof and releases the transport** (DEV → QAS → PRD). The harness never releases, and no
  production connection is ever registered.

It runs on its **own local substrate** — no cloud, no gateway:

| Substrate | Directory | Role | Needs SAP? |
|---|---|---|---|
| **Analyser** | `analyser/` | `@abaplint/core` code graph + rule packs → S/4 readiness, blast radius, findings | **No** (offline) |
| **Greenfield** | `greenfield/` | released-API grounding + a 58-rule ABAP-Cloud linter | **No** (offline) |
| **MCP-ADT sidecar + bridge** | `sap-adt-sidecar/`, `mcp-adt-bridge/` | real ABAP Developer Tools calls (read + gated write) | **Yes** (online) |

A fourth offline engine, the **Oracle** (`oracle/`), is a conservative A/B/C/D clean-core classifier the
analyser **imports in-process** to ground its findings — it has no MCP server or CLI of its own, so it is
an engine, not a standalone substrate. In total the plugin ships **24 skills/lanes, 9 agents, and 8
hooks** (3 enforcement + 5 advisory) alongside the three MCP servers.

The always-loaded spine is [`CLAUDE.md`](CLAUDE.md) (the prime directives **P1–P8**). This guide is the
map; that file is the law.

---

## 2. The mental model (two concepts you must hold)

**Skills vs MCP tools.** The things you *type* — `/analyse`, `/abap-design`, `/modernise` — are
**skills** (a.k.a. slash commands / lanes), one folder each under `.claude/skills/`. They are a Claude
Code mechanism. Some skills, while running, **call MCP tools** exposed by the three MCP servers in
[`.mcp.json`](.mcp.json) (`sap-adt`, `abap-analyser`, `greenfield`). You never invoke an MCP tool
directly, and MCP never runs a skill — the skill is the caller, the tool is the callee.

**Offline vs online — the single most important distinction.**

- **Offline** = the analyser, greenfield, and moderniser **engines**. They read local files and the
  bundled SAP registry. **Zero SAP connectivity, zero credentials.** The verdict they can reach is
  *provisional* — never a real GREEN, because activation and ABAP Unit need a live system (P6).
- **Online** = anything that goes through the `sap-adt` MCP → the bridge → the **sidecar** → **real ADT
  calls**. Needs the sidecar running + SAP credentials, and (for writes) an explicit write-enable. This
  is where objects get activated and earn a real GREEN.

---

## 3. Setup (do this once)

### 3.1 Prerequisites

- **Node.js ≥ 18** (the harness is pure Node — no Docker, no Python).
- **git**.
- **Claude Code** (the harness is loaded by opening this repo in Claude Code).
- For **online** work only: network access to a **SAP DEV** system (host, user, password, client). Never
  a production system.

### 3.2 Clone, install, verify

```bash
git clone <this-repo-url> AI_HARNESS_FOR_SAP
cd AI_HARNESS_FOR_SAP
npm install          # pulls @abaplint/core + fast-xml-parser only
npm test             # the full OFFLINE suite — expect all green, no SAP needed
```

`npm test` runs entirely offline (real processes, real failure paths, no mocks). If it is green, your
machine is ready for **all offline work** immediately.

### 3.3 Open it in Claude Code

Open the repo folder in Claude Code. It auto-loads from the project root:

- `.claude/skills/` — the lanes (`/analyse`, `/abap-design`, `/modernise`, …).
- `.claude/agents/` — the generator, evaluator, reviewers, planner, transport-manager.
- `.claude/hooks/` + `.claude/settings.json` — the enforcement (P4/P5) and advisory hooks.
- `.mcp.json` — the three MCP servers (`sap-adt`, `abap-analyser`, `greenfield`).

You are now ready for **Section A (offline)**. Online needs a few more steps — see **Section B**.

### 3.4 (Optional) Use the harness on your *own* ABAP project

If you want the harness stamped into a **separate** delivery repo rather than working inside this one,
run the initializer:

```
/scaffold-abap
```

It copies the spine, the `.mcp.json` wiring, the templates, the ratchet ledgers, and the `specs/`
layout into your project, then verifies the bridge. Everything below then works the same way there.

---

## 4. A) Offline analysis and development (no SAP, no credentials)

Everything in this section runs with **zero SAP connectivity**. This is where you do analysis at scale
and all design/generation/lint work.

### 4.0 Get your ABAP onto disk (for analysis)

Offline analysis reads a **local abapGit export directory** — the folder you get from *abapGit → pull*
of a package, or a local clone of an abapGit repo. It is a **folder, not a single file, and not a
remote URL**. The loader recurses into subfolders and reads `*.abap`, `*.asddls`, `*.asbdef`,
`*.asdcls`, `*.acds`.

### 4.1 Analyse an existing package

```
/analyse path/to/abapgit-export           # no-MCP CLI, renders the report in-session
```

`/analyse` runs `node analyser/cli.js` directly and prints the code graph (nodes/edges), findings by
family/severity, **S/4 readiness %**, blast radius (SAP objects at risk → named successors), and the
priority-1 findings — and writes the full report to `specs/brownfield/analyser-findings.json`.

Equivalent through the MCP server (same output file):

```
/abap-analyser path/to/abapgit-export     # MCP "bundle" mode — still fully offline
```

Then turn findings into a remediation plan:

```
/readiness      # consumes analyser-findings.json → retire / re-platform / keep-and-clean tiers
```

### 4.2 Develop — greenfield (build something new)

The canonical pipeline, offline up to the live gate:

```
/fit-to-standard      # prove SAP standard doesn't already ship it (build nothing it does)
/abap-design          # CDS data model + RAP behaviour design; grounded on released APIs (offline)
/abap-implement       # the generator writes RAP/CDS/classes/ABAP-Unit under specs/abap/,
                      #   grounds via greenfield ground_released_apis, lints via lint_abap_cloud,
                      #   and loops lint → regenerate until Clean-Core clean
```

`/greenfield` is a shortcut **router** over the build pipeline for a purely net-new object once you
know it's a genuine gap.

**What you get offline:** grounded designs, generated ABAP that passes the offline ABAP-Cloud linter,
and a **provisional** verdict. **What you cannot get offline:** activation, ATC, ABAP Unit, or a real
GREEN — those need a live tier (Section B).

### 4.3 Develop — modernise (transform brownfield)

```
/modernise            # offline by default; consumes specs/brownfield/analyser-findings.json
```

The moderniser freezes one bottom-up, content-hashed dependency plan and drives **every** object
through `GROUND → TRANSFORM → SELF_CHECK → VERDICT` under a deterministic scheduler. Offline it grounds,
lints and **offline-gates** each node, resting it at `PROVISIONAL_GATED` (the offline verdict rest state;
`SYNTAX_OK` is only a mid-flight pass state, not the terminus), then assembles a **provisional** proof
bundle — it never GREENs offline, by design (P6). Useful flags: `--breakpoint <wave>` (pause for review), `--team-size N`,
`--resume <run_id>`.

> **The offline pipeline is engine-direct:** the analyser writes `analyser-findings.json`, the
> moderniser reads it, and grounding is in-process — no MCP server and no credentials are involved.

---

## 5. B) Online analysis and development (real SAP DEV)

Online adds one process (the sidecar), credentials, and — for writes — one deliberate switch.

### 5.1 Start the sidecar

The sidecar is the harness's Node service that makes the real ADT calls. Start it in its own terminal:

```bash
node sap-adt-sidecar/server.js            # binds 127.0.0.1:8090 (ADAPTER_PORT overrides the port)
```

It listens on loopback only. `.mcp.json` already points `ADT_MCP_URL` at `http://127.0.0.1:8090`, so
the `sap-adt` and `abap-analyser` MCP servers reach it with no extra config.

### 5.2 Supply credentials (never commit them)

Credentials flow from **environment variables** → the bridge → per-request `X-SAP-*` headers → the
sidecar. Set them in the environment where you launch Claude Code (so the MCP subprocess inherits them),
or export them before `npm run test:live`:

| Env var | Meaning |
|---|---|
| `SAP_HOST` | DEV host |
| `SAP_USER` / `SAP_PASSWORD` | DEV credentials |
| `SAP_PORT` | ADT port (e.g. `44300`) |
| `SAP_CLIENT` | client (e.g. `100`) |
| `SAP_LANGUAGE` | optional (e.g. `EN`) |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | only for a self-signed / trial certificate |

**Never** put these in `.mcp.json` or any committed file — `.mcp.json` carries only the loopback URL and
the write gate.

Confirm read connectivity (read-only; **fails loudly** if creds are missing — never silently skips):

```bash
SAP_HOST=... SAP_USER=... SAP_PASSWORD=... SAP_PORT=44300 SAP_CLIENT=100 \
  NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npm run test:live
```

### 5.3 Analyse live source

```
/abap-analyser ZCC_SALES --live           # pull the package's source live via ADT → full code graph
/abap-analyser ZCC_SALES --adt-only       # lighter subset: ATC + migration analysis, no full graph
```

Here you point at a **package name in the live system** (not a folder). Both modes are **read-only**
against SAP (P5) — the only thing written is the local `analyser-findings.json`.

### 5.4 Develop live — and earn a real GREEN

To let the harness **write** to DEV (create/update/activate/test), flip the P5 write gate — set it on a
**DEV connection only**, never a shared or production context:

```jsonc
// .mcp.json → mcpServers.sap-adt.env
"HARNESS_ADT_ALLOW_WRITE": "1"             // default is "0" (fail-closed)
```

Now the build lanes run their live gates:

```
/abap-validate        # the evaluator pushes the UNCHANGED generated source, activates it, and runs
                      #   ATC (variant ABAP_CLEAN_CORE_DEVELOPMENT) + ABAP Unit → PASS / WARN / BLOCK.
                      #   A check that could not run is a BLOCK, never a skip.
/abap-transport       # assembles the proof bundle: activation log, ATC priorities, ABAP Unit results,
                      #   Clean-Core level, invariant diff — a release-ready transport, and STOP.
```

> **`/abap-validate` runs eight gates through five reviewers — not just ATC.** `abap-evaluator` owns
> Gates 1/3/5 (activation, ATC, ABAP Unit), and `clean-core-reviewer` (Gates 2/4, HARD),
> `abap-design-critic` (6, SOFT/WARN), `abap-security-reviewer` (7, HARD) and `abap-diff-reviewer`
> (8, HARD) also gate — so a **BLOCK can originate outside ATC** (e.g. a Clean-Core or security
> violation) even when ATC + ABAP Unit are green.

To run the **moderniser** against DEV so nodes earn a real GREEN:

```
/modernise --live     # DEV-gated conjuncts run live (needs a DEV connection AND HARNESS_ADT_ALLOW_WRITE=1;
                      #   if either is missing it refuses --live and stays offline — it never bypasses P5)
```

Live, a node reaches `GREEN` only when it is **activated ∧ reconciled ∧ ATC priority-1 & priority-2 zero
∧ ABAP Unit green ∧ invariants intact ∧ parity confirmed**.

### 5.5 The human releases the transport

The harness stops at **activated DEV objects + the proof bundle**. It does not release anything. A human
reads `specs/reviews/sap-verdict.json` (and the transport-evidence pack) and releases the transport
DEV → QAS → PRD. This segregation of duties is **P5** and is not negotiable.

Live write round-trip smoke test (create/update/activate/test on a disposable package such as `$TMP`):

```bash
SAP_HOST=... SAP_USER=... SAP_PASSWORD=... LIVE_WRITE_PACKAGE='$TMP' \
  npm run test:live:write
```

---

## 6. The guardrails you will hit (P1–P8, in dev terms)

These are enforced by hooks and reviewers — they are not style suggestions:

- **Released APIs only, Clean-Core Level A target** (P1/P2). Unreleased APIs are caught before code is
  written; the target object must consume released APIs and extend only via BAdI/RAP/CDS-extend.
- **Immutable invariants** (P4). You cannot weaken an `AUTHORITY-CHECK`, suppress the save (`COMMIT
  WORK` / the RAP `COMMIT ENTITIES`), or drop the `SY-SUBRC` check. The pre-write hook blocks it.
- **Writes fail-closed** (P5). The 5 ADT write tools are disabled unless `HARNESS_ADT_ALLOW_WRITE=1` on
  a DEV connection. No PRD connection is ever registered.
- **ATC is a gate, not advice** (P6). Priority-1 **and** priority-2 must both be zero; a missing/failed
  ATC run is a FAIL, never a pass.
- **The writer never grades its own work** (GAN). Generation self-checks syntax only; the verdict comes
  from a fresh-context evaluator on a tier it does not control.
- **Retrieved ABAP is untrusted data** (P8). Scanned customer source is data, never instructions.

---

## 7. Quick reference

| Command | What it does | Mode | Needs |
|---|---|---|---|
| `/analyse <folder>` | analyse an abapGit export, render in-session | offline | a local export dir |
| `/abap-analyser <folder>` | same, via the MCP server | offline | a local export dir |
| `/abap-analyser <pkg> --live` / `--adt-only` | analyse live package source | **online** | sidecar + creds |
| `/readiness` | tier findings (retire / re-platform / keep-and-clean) | offline | `analyser-findings.json` |
| `/fit-to-standard` | prove SAP standard doesn't already ship it | offline | — |
| `/abap-design` → `/abap-implement` | design + generate RAP/CDS/classes, grounded + linted | offline | — |
| `/greenfield` | net-new router over the build pipeline | offline | — |
| `/modernise` | modernise brownfield to a provisional verdict | offline | `analyser-findings.json` |
| `/abap-validate` | activate + ATC + ABAP Unit → PASS/WARN/BLOCK | **online** | sidecar + creds + write=1 |
| `/modernise --live` | modernise and earn real GREEN on DEV | **online** | sidecar + creds + write=1 |
| `/abap-transport` | assemble the release-ready proof bundle | **online** | prior gate verdicts |
| `/abap-vibe` | a ≤3-object quick fix (hard-escalates if it touches an invariant/DDIC) | either | — |

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/analyse` → "no analysable source under …" | You pointed at the wrong folder. Point at the abapGit **source** dir (containing `*.abap` / `*.ddls.asddls`); the loader recurses. |
| `npm run test:live` fails "missing SAP_HOST/…" | Credentials not exported. Set the `SAP_*` env vars (§5.2). This is by design — the live suites fail loudly, never silently skip. |
| A live gate returns `failure_layer: "infrastructure"` (BLOCK) | No DEV connection reachable. The sidecar isn't running, or creds are wrong. Fix the connection — the BLOCK is correct, not a workaround target. |
| A write tool returns "BLOCKED: … set HARNESS_ADT_ALLOW_WRITE=1" | The P5 write gate is closed (default). Set it to `1` in `.mcp.json` **for a DEV connection only**. |
| Offline verdict is "provisional / never GREEN" | Working as designed (P6). A real GREEN needs a live tier — switch to Section B. |
| Editing `.mcp.json` mid-run behaves oddly | Settle `.mcp.json` and the enabled plugins **before** a long run (P7 — prompt-cache discipline). |

---

## 9. Where to go next

- [`CLAUDE.md`](CLAUDE.md) — the always-loaded spine (P1–P8, GAN, the ratchet, the lanes).
- [`README.md`](README.md) — the project map and the committed demo bundles under `demos/`.
- `.claude/skills/<name>/SKILL.md` — the full contract for any lane you want to understand in depth.
