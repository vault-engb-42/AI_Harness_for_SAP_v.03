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

// GF-3d: the /greenfield entry-point must exist and stay a thin router over
// /abap-build (delegation, not a duplicated pipeline).
test("the /greenfield entry-point exists and delegates to /abap-build", () => {
  const skill = readFileSync(join(CLAUDE, "skills", "greenfield", "SKILL.md"), "utf8");
  assert.match(skill, /^name:\s*greenfield\s*$/m, "greenfield SKILL.md must declare name: greenfield");
  assert.match(skill, /\/abap-build/, "greenfield must delegate to /abap-build (thin router)");
  assert.match(skill, /lint_abap_cloud/, "greenfield must document the offline cloud-lint path");
  assert.match(skill, /ground_released_apis/, "greenfield must document the offline grounding path");
});
