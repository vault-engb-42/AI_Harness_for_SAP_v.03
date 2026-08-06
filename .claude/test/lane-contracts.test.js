import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

// Lane artifact-contract guard. The greenfield/wave lanes hand off through
// Markdown design artifacts under specs/design/; there is no compiler to catch a
// producer/consumer name mismatch, so this test IS the contract check. It scans
// every skill/agent/command definition and fails if a lane references a design
// artifact that NO lane produces — the exact silent drift that once broke the
// design->implement handoff (implement/generator read object-map.md +
// cds-contracts.md + rap-contracts.md + data-model.md, none of which any lane
// wrote; the produced set is component-map.md + object-contract.md +
// api-grounding.md). Real files, no mocks.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE = join(HERE, "..");
const REPO = join(HERE, "..", "..");

// Design artifacts that were consumed but never produced — retired by the
// contract reconciliation. Their reappearance is a regression.
// `symbol-map.md` / `test-map.md` joined the retired set in the brownfield reconciliation:
// abap-generator instructed reading both, but NO lane emits them — abap-brownfield writes
// architecture-map / risk-map / change-strategy, and its SKILL states outright that "there is no
// separate coupling-report or symbol-map to invent". The navigation they were meant to provide
// already lives in architecture-map.md's traceable edge list.
const RETIRED_ARTIFACTS = ["object-map.md", "cds-contracts.md", "rap-contracts.md", "data-model.md", "symbol-map.md", "test-map.md"];

// The canonical produced set every consumer must code against.
const PRODUCED_ARTIFACTS = ["component-map.md", "object-contract.md", "api-grounding.md"];

/** @param {string} dir @param {RegExp} match @returns {string[]} absolute file paths */
function walk(dir, match) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, match));
    else if (match.test(name)) out.push(p);
  }
  return out;
}

/** @returns {Array<{path: string, text: string}>} every lane/agent/command definition */
function laneDefinitions() {
  const files = [
    ...walk(join(CLAUDE, "skills"), /^SKILL\.md$/),
    ...walk(join(CLAUDE, "agents"), /\.md$/),
    ...walk(join(CLAUDE, "commands"), /\.md$/),
  ];
  return files.map((path) => ({ path: relative(CLAUDE, path), text: readFileSync(path, "utf8") }));
}

test("no lane references a retired design artifact (producer/consumer drift guard)", () => {
  const defs = laneDefinitions();
  const offenders = [];
  for (const { path, text } of defs) {
    for (const artifact of RETIRED_ARTIFACTS) {
      if (text.includes(artifact)) offenders.push(`${path} references retired '${artifact}'`);
    }
  }
  assert.deepEqual(offenders, [], `retired design artifacts must not be referenced:\n${offenders.join("\n")}`);
});

test("the produced design artifacts are actually consumed by the realize lanes", () => {
  // Sanity anchor: the implement lane must read the canonical produced set, so a
  // future rename of the WRITE side cannot silently orphan the READ side again.
  const implement = laneDefinitions().find((d) => d.path.replace(/\\/g, "/") === "skills/abap-implement/SKILL.md");
  assert.ok(implement, "abap-implement/SKILL.md must exist");
  for (const artifact of PRODUCED_ARTIFACTS) {
    assert.ok(implement.text.includes(artifact), `abap-implement must consume produced artifact '${artifact}'`);
  }
});

// GF-3c: an agent can only call an MCP tool that its frontmatter grants. These
// assertions lock the greenfield grounding/lint wiring so a frontmatter edit can
// never silently strip an agent's ability to ground offline or run the cloud lint.
const GREENFIELD_WIRING = [
  { file: "agents/abap-generator.md", tools: ["mcp__greenfield__ground_released_apis", "mcp__greenfield__lint_abap_cloud"] },
  { file: "agents/planner.md", tools: ["mcp__greenfield__ground_released_apis"] },
  { file: "agents/abap-design-critic.md", tools: ["mcp__greenfield__ground_released_apis"] },
  { file: "agents/abap-arch-reviewer.md", tools: ["mcp__greenfield__ground_released_apis"] },
];

test("greenfield MCP tools are granted in the frontmatter of the agents that must call them", () => {
  for (const { file, tools } of GREENFIELD_WIRING) {
    const frontmatter = readFileSync(join(CLAUDE, file), "utf8").split(/^---$/m)[1] ?? "";
    for (const tool of tools) {
      assert.ok(frontmatter.includes(tool), `${file} frontmatter must grant ${tool}`);
    }
  }
});

test("the greenfield MCP server backing those tools is declared in .mcp.json", () => {
  const mcp = JSON.parse(readFileSync(join(CLAUDE, "..", ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers?.greenfield, ".mcp.json must declare the greenfield MCP server");
});

// B3.5 seam 5 (BUILD_PLAN S14 / the two Rule-11 reviewers): the reasoned-architecture GAN roles are FOUR
// distinct agents — judge (planner) ≠ judgment-correctness reviewer (abap-arch-reviewer) ≠ model-quality
// critic (abap-design-critic) ≠ writer (abap-generator). The arch-reviewer GRADES ONLY: it must hold no
// write / ATC / activate tool (P5 fail-closed, GAN separation), and it runs judgment on Opus.
test("the reasoned-architecture GAN roles are four distinct agents; the arch-reviewer is read-only", () => {
  const roles = ["planner", "abap-arch-reviewer", "abap-design-critic", "abap-generator"];
  assert.equal(new Set(roles).size, 4, "four distinct roles");
  for (const r of roles) assert.ok(statSync(join(CLAUDE, "agents", `${r}.md`)).isFile(), `${r}.md exists`);
  const frontmatter = readFileSync(join(CLAUDE, "agents", "abap-arch-reviewer.md"), "utf8").split(/^---$/m)[1] ?? "";
  for (const forbidden of ["create_object", "update_source", "activate_object", "activate_objects_batch", "create_or_update_test_class", "run_atc_check", "run_unit_tests"]) {
    assert.ok(!frontmatter.includes(forbidden), `arch-reviewer frontmatter must NOT grant ${forbidden} (grades only)`);
  }
  assert.match(frontmatter, /^model:\s*claude-opus-4-8\s*$/m, "arch-reviewer runs judgment on Opus");
});

// G1: the managed RAP-BO template must carry a saver-class skeleton for the
// additional-save / unmanaged-save modes. The old template declared `managed with
// additional save;` yet pointed at a save_modified that did not exist (a dangling
// contract). Its default is now plain `managed;` (framework owns the save); the saver
// is an opt-in variant in PART 2b. Real files, no mocks.
test("G1: the RAP-BO template carries a cl_abap_behavior_saver skeleton with save_modified REDEFINITION", () => {
  const tmpl = readFileSync(join(CLAUDE, "templates", "rap-bo.template.abap"), "utf8");
  assert.match(tmpl, /INHERITING FROM cl_abap_behavior_saver/i, "template must define a saver class");
  assert.match(tmpl, /\bsave_modified\b/i, "template must declare save_modified");
  assert.match(tmpl, /save_modified\s+REDEFINITION/i, "save_modified must be a REDEFINITION of the saver base");
});

test("G1: the RAP-BO template defaults to plain `managed;` and documents every save mode", () => {
  const tmpl = readFileSync(join(CLAUDE, "templates", "rap-bo.template.abap"), "utf8");
  assert.match(tmpl, /^\s*managed;/m, "the default ACTIVE impl-type must be plain `managed;` (no saver)");
  const lower = tmpl.toLowerCase();
  for (const mode of ["additional save", "unmanaged save", "unmanaged"]) {
    assert.ok(lower.includes(mode), `template must document the '${mode}' save mode`);
  }
});

test("G1: no dangling save_modified pointer — a 'see save_modified' note resolves to the declared method", () => {
  const tmpl = readFileSync(join(CLAUDE, "templates", "rap-bo.template.abap"), "utf8");
  if (/see save_modified/i.test(tmpl)) {
    assert.match(tmpl, /save_modified\s+REDEFINITION/i, "a save_modified pointer must resolve to the saver method");
  }
});

test("G1: abap-generator requires the saver class when the BDEF declares additional/unmanaged save", () => {
  const gen = readFileSync(join(CLAUDE, "agents", "abap-generator.md"), "utf8");
  assert.match(gen, /cl_abap_behavior_saver/i, "generator must require the saver base class");
  assert.match(gen, /save_modified/i, "generator must require redefining save_modified");
});

// G6: the generator must author the minimum @UI Fiori-Elements set (List Report + Object
// Page render with no hand-written UI), and S3 adds a DDLX template so @UI can be externalised.
test("G6: abap-generator carries the @UI Fiori-Elements readiness contract", () => {
  const gen = readFileSync(join(CLAUDE, "agents", "abap-generator.md"), "utf8");
  for (const ann of ["headerInfo", "lineItem", "selectionField"]) {
    assert.ok(gen.includes(ann), `generator must require @UI.${ann} on the ZC_ projection`);
  }
});

test("G6/S3: a DDLX metadata-extension template exists for externalised @UI", () => {
  const tmpl = readFileSync(join(CLAUDE, "templates", "metadata-extension.template.abap"), "utf8");
  assert.match(tmpl, /annotate\s+(?:view\s+)?(?:entity\s+)?/i, "must be an `annotate … view` metadata extension");
  assert.match(tmpl, /@Metadata\.layer/i, "must declare @Metadata.layer (e.g. #CUSTOMER)");
});

// G7: the RAP/CDS test-double contract must name the REAL SAP double classes (correct casing)
// and cover the three doubles + mock-EML, with a create/destroy/clear lifecycle.
test("G7: abap-test SKILL names the real test-double classes (correct casing) + mock-EML", () => {
  const skill = readFileSync(join(CLAUDE, "skills", "abap-test", "SKILL.md"), "utf8");
  for (const cls of ["cl_abap_behv_test_environment", "cl_cds_test_environment", "cl_osql_test_environment"]) {
    assert.ok(skill.includes(cls), `SKILL must name ${cls}`);
  }
  assert.ok(!/\bCDS_TEST_ENVIRONMENT\b/.test(skill.replace(/cl_cds_test_environment/gi, "")), "the mis-cased CDS_TEST_ENVIRONMENT must be gone");
  assert.match(skill, /clear_doubles|destroy\(/i, "must document the double lifecycle (clear_doubles / destroy)");
});

test("G7: abap-evaluator gates test hygiene — no COMMIT/raw DB write in a test, assertion presence, teardown", () => {
  const ev = readFileSync(join(CLAUDE, "agents", "abap-evaluator.md"), "utf8");
  assert.match(ev, /test double|cl_abap_behv_test_environment|cl_cds_test_environment/i, "evaluator must gate test-double usage");
  assert.match(ev, /assert/i, "evaluator must gate assertion presence");
});

// G2: the OData exposure layer. An SRVD service-definition template exposes ZC_*
// projections ONLY (never ZI_ interface views), and an SRVB service-binding template
// is binding *config* (not DDL) — default OData V4 UI for Fiori Elements, declaring a
// protocol version. Publish != activate: the live SRVB publish path is G10. Real files.

// Strip DDL/ABAP comments so a commented `expose …` never counts toward the contract
// — the keyword-vs-comment defect class: /* … */ block comments (valid CDS DDL), then
// *-prefixed banner lines, then // line comments.
const stripDdlComments = (s) =>
  String(s)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\*/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

// Strip XML comments so the SRVB header's documented options table (which lists example
// bindingType/protocol/category rows) can never satisfy the contract — only the ACTIVE
// <srvb:serviceBinding> config counts.
const stripXmlComments = (s) => String(s).replace(/<!--[\s\S]*?-->/g, "");

test("G2: a service-definition (SRVD) template exists and exposes a projection view", () => {
  const tmpl = readFileSync(join(CLAUDE, "templates", "service-definition.template.abap"), "utf8");
  assert.match(tmpl, /define\s+service\s+Z/i, "must be a `define service Z…` definition");
  assert.match(stripDdlComments(tmpl), /\bexpose\s+ZC_/i, "must expose a ZC_ projection entity");
});

test("G2: the SRVD template exposes ZC_ projections only — never a ZI_ interface view", () => {
  const src = stripDdlComments(readFileSync(join(CLAUDE, "templates", "service-definition.template.abap"), "utf8"));
  const exposed = [...src.matchAll(/\bexpose\s+([^\s;]+)/gi)].map((m) => m[1]);
  assert.ok(exposed.length > 0, "the SRVD template must expose at least one entity");
  const iface = exposed.filter((e) => /^ZI_/i.test(e));
  assert.deepEqual(iface, [], `SRVD must not expose interface (ZI_) views: ${iface.join(", ")}`);
});

test("G2: a service-binding (SRVB) template exists, defaults to OData V4 UI, and declares a protocol version", () => {
  // Assert against the ACTIVE binding (comments stripped) — the header's documented options
  // table also lists protocol="V4" category="UI", which must not satisfy the contract by itself.
  const active = stripXmlComments(readFileSync(join(CLAUDE, "templates", "service-binding.template.xml"), "utf8"));
  assert.match(active, /bindingType\s*=\s*"ODATA"/i, "SRVB binding type must be ODATA");
  assert.match(active, /protocol\s*=\s*"V4"/i, "SRVB must declare protocol version V4 (the Fiori Elements default)");
  assert.match(active, /category\s*=\s*"UI"/i, "SRVB must default to the UI category (Fiori Elements)");
});

test("G2: the SRVB template binds its SRVD service and documents publish != activate (G10)", () => {
  const raw = readFileSync(join(CLAUDE, "templates", "service-binding.template.xml"), "utf8");
  const active = stripXmlComments(raw);
  assert.match(active, /serviceDefinition\s*=/i, "the ACTIVE binding must reference the service definition (SRVD) it binds");
  assert.match(raw, /publish/i, "the SRVB template must document that its activation is a publish, not object activation");
});

// G2 adversarial remediation: the two contract guards must discriminate the ACTIVE
// config from documentation comments — the keyword-vs-comment defect class.
test("G2: the SRVD ZC_-only guard ignores a block-commented expose (no false positive)", () => {
  // A valid SRVD that retires a legacy ZI_ expose inside a /* … */ block comment must
  // still pass the 'no interface view' contract — block comments are valid CDS DDL.
  const valid = "define service ZTest {\n  expose ZC_Foo as Foo;\n  /* expose ZI_FooLegacy as FooLegacy; retired */\n}";
  const exposed = [...stripDdlComments(valid).matchAll(/\bexpose\s+([^\s;]+)/gi)].map((m) => m[1]);
  assert.deepEqual(exposed.filter((e) => /^ZI_/i.test(e)), [], "a block-commented ZI_ expose must not count as an interface exposure");
  assert.deepEqual(exposed, ["ZC_Foo"], "only the active ZC_ expose is extracted");
});

test("G2: the SRVB contract checks the ACTIVE binding, not the commented options table (no false negative)", () => {
  // A binding whose ACTIVE element is V2/WEBAPI must NOT satisfy the V4-UI contract, even
  // when the header options table (which lists protocol="V4" category="UI") is kept verbatim.
  const headerTable = '<!-- options: bindingType="ODATA" protocol="V4" category="UI" (default); protocol="V2"; category="WEBAPI" -->';
  const brokenActive = '<srvb:serviceBinding srvb:bindingType="ODATA" srvb:protocol="V2" srvb:category="WEBAPI">';
  const broken = stripXmlComments(`${headerTable}\n${brokenActive}`);
  assert.doesNotMatch(broken, /protocol\s*=\s*"V4"/i, "a V2 active binding must not read as V4 once comments are stripped");
  assert.doesNotMatch(broken, /category\s*=\s*"UI"/i, "a WEBAPI active binding must not read as UI once comments are stripped");
});

// G12: the Fiori Elements app-project template + the generator's contract to author it (S1).
test("G12: a Fiori Elements app-project template exists and is a valid FE descriptor skeleton", () => {
  const m = JSON.parse(readFileSync(join(CLAUDE, "templates", "fiori-elements-app.template.json"), "utf8"));
  const ds = m["sap.app"]?.dataSources ?? {};
  assert.ok(Object.values(ds).some((d) => String(d?.type).toUpperCase() === "ODATA"), "must bind an OData dataSource (the published SRVB service)");
  const targets = Object.values(m["sap.ui5"]?.routing?.targets ?? {}).map((t) => String(t?.name ?? ""));
  assert.ok(targets.some((n) => /sap\.fe\.templates\.ListReport/.test(n)), "List Report floorplan required");
  assert.ok(targets.some((n) => /sap\.fe\.templates\.ObjectPage/.test(n)), "Object Page floorplan required");
  const entitySets = Object.values(m["sap.ui5"].routing.targets).map((t) => t?.options?.settings?.entitySet).filter(Boolean);
  assert.ok(entitySets.length, "a main entitySet (the ZC_ projection entity)");
});

test("G11: a DDIC persistent-table template exists (ZT_ raw(16) UUID key + RAP admin/ETag fields)", () => {
  const tmpl = readFileSync(join(CLAUDE, "templates", "ddic-table.template.abap"), "utf8");
  assert.match(tmpl, /define\s+table\s+zt_/i, "must be a `define table zt_…` DDIC table");
  assert.match(tmpl, /sysuuid_x16/i, "raw(16) UUID key type");
  assert.match(tmpl, /abp_(?:lastchange|locinst_lastchange)_time/i, "RAP managed admin / ETag fields");
});

test("G12: abap-generator authors the Fiori Elements app project for a UI service", () => {
  const gen = readFileSync(join(CLAUDE, "agents", "abap-generator.md"), "utf8");
  assert.match(gen, /fiori-elements-app\.template\.json|Fiori Elements app project/i, "generator must author the FE app project");
  assert.match(gen, /sap\.fe\.templates|List Report/i, "generator must name the FE floorplans");
  assert.match(gen, /validate_fe_descriptor/, "generator must reference the descriptor gate");
});

// GF-3d: the /greenfield entry-point must exist and stay a thin router over
// /abap-build (delegation, not a duplicated pipeline).
test("the /greenfield entry-point exists and delegates to /abap-build", () => {
  const skill = readFileSync(join(CLAUDE, "skills", "greenfield", "SKILL.md"), "utf8");
  assert.match(skill, /^name:\s*greenfield\s*$/m, "greenfield SKILL.md must declare name: greenfield");
  assert.match(skill, /\/abap-build/, "greenfield must delegate to /abap-build (thin router)");
  assert.match(skill, /lint_abap_cloud/, "greenfield must document the offline cloud-lint path");
  assert.match(skill, /ground_released_apis/, "greenfield must document the offline grounding path");
});

// H3 (Rule-11 adversarial review, CONFIRMED): the driver hard-refuses to dispatch a re_architect/rebuild
// node whose Architecture Contract is not human-ratified, so a lane that runs `plan` then `drive` DEADLOCKS
// on real findings — every node sits at await_human forever. The /modernise skill must therefore invoke both
// plan-time gates AND the judge write seam that clears the escalated subset. This test is the guard: the
// gate machinery being reachable only from tests is exactly the defect the review found.
test("the /modernise skill wires both plan-time gates (disposition + arch) and the judge write seam", () => {
  const skill = readFileSync(join(CLAUDE, "skills", "modernise", "SKILL.md"), "utf8");
  for (const verb of ["disposition <R>", "replan <R>", "arch <R>", "arch-verdict <R>", "arch-review <R>"]) {
    assert.ok(skill.includes(verb), `modernise SKILL.md must invoke \`${verb}\` — without it the driver deadlocks`);
  }
  // P3: `decide … override:<disposition>` only changes what gets built if the lane then re-freezes the plan.
  // A lane that records the override and drives on leaves it inert — the frozen node keeps the classifier's
  // disposition and the run builds the object the human just said to drop.
  assert.match(skill, /new_run_id/, "the skill must carry the run forward under the replanned run id");
  // §7.4: an escalation kind with no fulfiller in the lane is a row nobody ever surfaces to the human.
  assert.match(skill, /DROPPED_DEPENDENCY/, "the skill must surface the dropped-dependency consequence gate");
  assert.match(skill, /ACCEPT_DROP/, "the skill must present its typed decisions, not invent its own");
  // B4: the retire step used to instruct the fulfiller to write a dropped-features ledger that no verb, file
  // or function could produce. The verb writes it now — so the lane must not claim the human does.
  assert.match(skill, /dropped-features\.json/, "the skill must name the ledger artifact the outcome verb writes");
  assert.doesNotMatch(skill, /record the drop in the run's dropped-features ledger/, "the lane must not instruct a step it has no mechanism for");
  assert.match(skill, /arch_ratification/, "the skill must explain the driver's fail-closed arch refusal");
  // S5: every action the driver can return needs a fulfiller, or the route is inert. `retire` and the
  // transform discriminator are the ones this range added.
  assert.match(skill, /RETIRED/, "the skill must fulfil the driver's `retire` action (dispatch → ledger → outcome RETIRED)");
  assert.match(skill, /transform/, "the skill must read the packet's transform discriminator — the transforms are not interchangeable");
  assert.match(skill, /arch_contract_ref/, "the skill must load the ratified contract the generator builds to");
  // H: a ratified contract that nothing checks against is inert — SELF_CHECK must run the conformance gate.
  assert.ok(skill.includes("conformance <R>"), "the skill must run the conformance gate for an arch-gated node");
  assert.match(skill, /ARCH_REVIEW/, "the skill must surface the ARCH_REVIEW ratification gate");
  assert.match(skill, /abap-arch-reviewer/, "the skill must spawn the independent arch reviewer (GAN counter-party)");
});

// Skills-review remediation (L2): /abap-brd never existed — abap-spec pointed the human at it; the
// real upstream BRD producer is /fit-to-standard (writes specs/brd/brd.md). A dangling slash-command
// leaves the human at a non-command; its reappearance is a regression (mirrors RETIRED_ARTIFACTS).
const NONEXISTENT_COMMANDS = ["/abap-brd"];
test("no lane references a nonexistent slash-command (dangling-command guard)", () => {
  const offenders = [];
  for (const { path, text } of laneDefinitions()) {
    for (const cmd of NONEXISTENT_COMMANDS) {
      if (text.includes(cmd)) offenders.push(`${path} references nonexistent '${cmd}'`);
    }
  }
  assert.deepEqual(offenders, [], `dangling slash-command references:\n${offenders.join("\n")}`);
});

// Skills-review remediation (L3): the scaffold/build baseline SEEDS must use the canonical ratchet
// field names the evaluator + moderniser CLI actually read (.claude/state/atc-baseline.json =
// accepted_priority_2_3; abapunit-baseline.json = coverage_floor_pct + per_object). Seeding the dead
// aliases accepted_warns / accepted_warnings / coverage_pct / objects ships fields nothing reads.
test("the baseline-seed docs use the canonical ratchet field names, not dead aliases", () => {
  const seeders = ["commands/scaffold-abap.md", "skills/abap-build/SKILL.md"];
  const DEAD = ["accepted_warns", "accepted_warnings", "coverage_pct"];
  const CANON = ["accepted_priority_2_3", "coverage_floor_pct", "per_object"];
  const offenders = [];
  for (const p of seeders) {
    const text = readFileSync(join(CLAUDE, p), "utf8");
    for (const dead of DEAD) if (text.includes(dead)) offenders.push(`${p} seeds dead ratchet field '${dead}'`);
    for (const canon of CANON) if (!text.includes(canon)) offenders.push(`${p} missing canonical ratchet field '${canon}'`);
  }
  assert.deepEqual(offenders, [], `baseline-seed schema drift:\n${offenders.join("\n")}`);
});

// Skills-review remediation (M1/L1, C3 propagation): priority-2 ATC is a hard BLOCK (C3/P6 — SAP's
// transport-blocking config blocks BOTH priority-1 and priority-2; only priority-3 is a WARN). No
// lane may present "priority-2/3" as a ratchetable/deliverable WARN (the ratchet FIELD is named
// accepted_priority_2_3 with an underscore — that legacy name is fine; the slash form is residue).
test("no lane presents ATC priority-2 as a deliverable/ratchetable WARN (C3 — priority-2 hard-blocks)", () => {
  const offenders = [];
  for (const { path, text } of laneDefinitions()) {
    if (/priority-?2\/3/i.test(text)) offenders.push(`${path}: stale 'priority-2/3' WARN residue (C3: priority-2 blocks, only priority-3 ratchets)`);
  }
  assert.deepEqual(offenders, [], `C3 priority-2 propagation residue:\n${offenders.join("\n")}`);
});

// (M1) The terminal delivery gate — the skill AND the transport-manager agent that executes it —
// must fail-closed on priority-2, not just priority-1.
test("abap-transport + transport-manager gate on ATC priority-2 (C3 terminal-gate guard)", () => {
  for (const p of ["skills/abap-transport/SKILL.md", "agents/transport-manager.md"]) {
    const t = readFileSync(join(CLAUDE, p), "utf8");
    assert.match(t, /atc\.priority2/, `${p} preconditions must check atc.priority2 empty`);
    assert.doesNotMatch(t, /priority-2\/3 ATC (finding )?within the/, `${p}: no 'priority-2/3 deliverable within the ratchet' residue`);
  }
});

// Skills-review remediation (transport:54): the terminal delivery gate must re-check the DEDICATED
// clean-core-verdict.json (Gate 2/4, HARD per abap-validate), not only the sap-verdict clean_core_level
// FIELD — an object can read Level A yet fail the clean-core gate (a modification / non-released extension).
test("abap-transport + transport-manager gate on clean-core-verdict.json (Gate 2/4 defense-in-depth)", () => {
  for (const p of ["skills/abap-transport/SKILL.md", "agents/transport-manager.md"]) {
    const t = readFileSync(join(CLAUDE, p), "utf8");
    assert.match(t, /clean-core-verdict\.json/, `${p} preconditions must re-check clean-core-verdict.json#pass`);
  }
});

// OPERATOR HARD RULE: `docs/` is a local working-progress folder and NEVER goes online. It is
// gitignored, and it was purged from history with `git filter-repo` — but `.gitignore` is
// advisory: `git add -f` bypasses it silently, and so does an explicit path in a commit. This
// test is the mechanical enforcement, because the rule is only as good as the thing that checks
// it. It runs on every `npm test`, which is the gate before every commit.
test("docs/ is never tracked — the local-only rule is enforced, not remembered", () => {
  const tracked = execFileSync("git", ["ls-files", "docs"], { cwd: REPO, encoding: "utf8" }).trim();
  assert.equal(tracked, "", `docs/ must never be tracked; found:\n${tracked}`);
});

test("docs/ is gitignored, so an accidental `git add docs/...` is refused", () => {
  const rules = readFileSync(join(REPO, ".gitignore"), "utf8");
  assert.match(rules, /^docs\/$/m, ".gitignore must carry a `docs/` rule");
});

// The brownfield counterpart of the produced-set anchor above: every artifact a downstream lane
// reads out of specs/brownfield/ must be one this lane actually writes. The drift this pins cost a
// live inconsistency — the generator told itself to navigate with a map nothing ever produced.
const BROWNFIELD_PRODUCED = ["architecture-map.md", "risk-map.md", "change-strategy.md"];

test("brownfield consumers only read maps the brownfield lane produces", () => {
  const brownfield = laneDefinitions().find((d) => d.path.replace(/\\/g, "/") === "skills/abap-brownfield/SKILL.md");
  assert.ok(brownfield, "abap-brownfield/SKILL.md must exist");
  for (const artifact of BROWNFIELD_PRODUCED) {
    assert.ok(brownfield.text.includes(artifact), `abap-brownfield must still emit '${artifact}'`);
  }
  const generator = laneDefinitions().find((d) => d.path.replace(/\\/g, "/") === "agents/abap-generator.md");
  assert.ok(generator, "abap-generator.md must exist");
  const readsBrownfield = [...generator.text.matchAll(/`([a-z-]+-(?:map|strategy|contract)\.md)`/g)].map((m) => m[1]);
  const orphans = [...new Set(readsBrownfield)].filter((a) => !BROWNFIELD_PRODUCED.includes(a) && !PRODUCED_ARTIFACTS.includes(a));
  assert.deepEqual(orphans, [], `abap-generator reads brownfield artifacts nothing produces: ${orphans.join(", ")}`);
});

// The hook layer has TWO tiers and the separation is load-bearing: enforcement hooks block
// (PreToolUse/UserPromptSubmit, exit 2, fail-closed), advisory hooks only observe. A second
// blocking path would be a second source of truth for "is this allowed" — the divergent-duplication
// class that already produced a real defect here. These tests pin both the wiring and the tiering.
const ENFORCEMENT_HOOKS = ["pre-write-gate", "adt-write-guard", "artifact-guard"];
const ADVISORY_HOOKS = ["record-run", "verify-on-save", "review-on-stop", "atc-on-activate", "ratchet-guard"];

function wiredHooks() {
  const settings = JSON.parse(readFileSync(join(CLAUDE, "settings.json"), "utf8"));
  const out = [];
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        const m = h.command.match(/hooks\/([a-z-]+)\.js/);
        if (m) out.push({ event, name: m[1], matcher: entry.matcher ?? null });
      }
    }
  }
  return out;
}

test("every hook file on disk is wired into settings.json (no orphaned hook)", () => {
  const wired = new Set(wiredHooks().map((h) => h.name));
  const onDisk = readdirSync(join(CLAUDE, "hooks")).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
  const orphans = onDisk.filter((n) => !wired.has(n));
  assert.deepEqual(orphans, [], `hook files exist but nothing invokes them: ${orphans.join(", ")}`);
});

test("all five advisory hooks are wired, on the events they own", () => {
  const wired = wiredHooks();
  for (const name of ADVISORY_HOOKS) {
    assert.ok(wired.some((h) => h.name === name), `advisory hook '${name}' is not wired into settings.json`);
  }
  const byName = (n) => wired.filter((h) => h.name === n).map((h) => h.event);
  assert.ok(byName("record-run").includes("SessionStart") && byName("record-run").includes("Stop"), "record-run spans both lifecycle ends");
  assert.deepEqual(byName("verify-on-save"), ["PostToolUse"], "verify-on-save observes writes AFTER they land");
  assert.deepEqual(byName("atc-on-activate"), ["PostToolUse"], "atc-on-activate observes activations");
  for (const n of ["ratchet-guard", "review-on-stop"]) assert.deepEqual(byName(n), ["Stop"], `${n} runs at Stop`);
});

test("ADVISORY hooks never run on a BLOCKING event — the tiers must not merge", () => {
  const blocking = new Set(["PreToolUse", "UserPromptSubmit"]);
  const offenders = wiredHooks().filter((h) => ADVISORY_HOOKS.includes(h.name) && blocking.has(h.event));
  assert.deepEqual(offenders, [], `advisory hooks wired to a blocking event: ${offenders.map((o) => `${o.name}@${o.event}`).join(", ")}`);
});

test("no advisory hook source can exit non-zero — the contract is in the code, not just the docs", () => {
  for (const name of ADVISORY_HOOKS) {
    const src = readFileSync(join(CLAUDE, "hooks", `${name}.js`), "utf8");
    const exits = [...src.matchAll(/process\.exit\((\d+)\)/g)].map((m) => m[1]);
    assert.deepEqual(exits, [], `${name}.js must exit only through advisory.finish(); found process.exit(${exits.join(", ")})`);
    assert.match(src, /\bfinish\(\)/, `${name}.js must terminate through advisory.finish()`);
  }
});

test("the enforcement hooks are still wired to blocking events (no accidental downgrade)", () => {
  const wired = wiredHooks();
  for (const name of ENFORCEMENT_HOOKS) {
    const events = wired.filter((h) => h.name === name).map((h) => h.event);
    assert.ok(events.length > 0, `enforcement hook '${name}' lost its wiring`);
    assert.ok(events.every((e) => ["PreToolUse", "UserPromptSubmit"].includes(e)), `${name} must stay on a blocking event, found ${events.join(", ")}`);
  }
});
