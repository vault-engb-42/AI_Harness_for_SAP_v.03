import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

// Design artifacts that were consumed but never produced — retired by the
// contract reconciliation. Their reappearance is a regression.
const RETIRED_ARTIFACTS = ["object-map.md", "cds-contracts.md", "rap-contracts.md", "data-model.md"];

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

// GF-3d: the /greenfield entry-point must exist and stay a thin router over
// /abap-build (delegation, not a duplicated pipeline).
test("the /greenfield entry-point exists and delegates to /abap-build", () => {
  const skill = readFileSync(join(CLAUDE, "skills", "greenfield", "SKILL.md"), "utf8");
  assert.match(skill, /^name:\s*greenfield\s*$/m, "greenfield SKILL.md must declare name: greenfield");
  assert.match(skill, /\/abap-build/, "greenfield must delegate to /abap-build (thin router)");
  assert.match(skill, /lint_abap_cloud/, "greenfield must document the offline cloud-lint path");
  assert.match(skill, /ground_released_apis/, "greenfield must document the offline grounding path");
});
