import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// `disposition <run_id>` + parametrized `decide` end-to-end (real subprocess, real fs, golden fixture — no
// mocks). B3: the plan-time DISPOSITION gate emits the manifest and raises one DISPOSITION_REVIEW per prompted
// node; `decide` routes the parametrized form (approve | override:<disposition> | other:<freeform>).

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "disp-cli-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  return (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" }));
}

test("disposition emits the manifest summary + raises one DISPOSITION_REVIEW per prompt row", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  const out = cli("disposition", planned.run_id);
  assert.equal(out.summary.prompt_count, planned.nodes.length, "abap_fico: every node prompts");
  assert.equal(out.summary.auto_count, 0);
  const escs = cli("escalations", planned.run_id, "--max", "50");
  const raised = [...escs.surfaced, ...escs.queued];
  assert.equal(raised.length, out.summary.prompt_count);
  assert.ok(raised.every((e) => e.kind === "DISPOSITION_REVIEW" && e.status === "OPEN"));
});

test("disposition is idempotent — a re-run raises no duplicate reviews", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  cli("disposition", planned.run_id);
  const escs = cli("escalations", planned.run_id, "--max", "50");
  assert.equal([...escs.surfaced, ...escs.queued].length, planned.nodes.length, "the bus dedupes an already-open review");
});

test("packets renders the DISPOSITION_REVIEW typed decision set", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  const p = cli("packets", planned.run_id, "--max", "50").packets.find((x) => x.kind === "DISPOSITION_REVIEW");
  assert.ok(p, "a DISPOSITION_REVIEW packet is rendered");
  assert.deepEqual(p.decisions, ["approve", "override", "other"]);
});

test("decide routes a parametrized DISPOSITION_REVIEW (override:<disposition>) end-to-end", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  const id = cli("escalations", planned.run_id, "--max", "50").surfaced[0].id;
  const row = cli("decide", planned.run_id, id, "override:refactor", "--by", "alice");
  assert.equal(row.status, "RESOLVED");
  assert.equal(row.resolved_by, "alice");
  assert.deepEqual(row.decision, { verb: "override", disposition: "refactor" });
});

test("decide refuses an invalid parametrized override target on a DISPOSITION_REVIEW", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  const id = cli("escalations", planned.run_id, "--max", "50").surfaced[0].id;
  assert.throws(() => cli("decide", planned.run_id, id, "override:port", "--by", "alice"));
});

// GAP 2b — the gate must carry the EVIDENCE the human decides on, not just a hash.
//
// NO_TARGET_SHAPE was built (F-8.2) so an unplaceable object has an id its documented remedy can name. It
// shipped with `evidence: {}` and `plan_fields: {}` — both fields renderPacket already supports — so the
// operator was handed a 64-char sig, a generic sentence and two verbs. To decide they had to cross-
// reference the sig against the architecture manifest, find the object, then read its ABAP. Measured on
// talv: 70 of 92 re_architect nodes reach no shape, so that is 70 manual cross-references.
//
// Deliberately FACTS ONLY. The packet names the object and states what was observed — it does NOT name a
// recommended disposition. A summary that recommends would anchor a human who would otherwise read the
// code, and the whole point of this gate is that the harness declines to choose. Same idiom as
// `no_successor_refs`, which the classifier collects as "evidence for a human decision, not the decision".
test("GAP2b a NO_TARGET_SHAPE packet names the object and carries its evidence", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  cli("arch", planned.run_id, FIXTURE);
  const p = cli("packets", planned.run_id, "--max", "99").packets.find((x) => x.kind === "NO_TARGET_SHAPE");
  assert.ok(p, "the fixture must produce an unplaceable node for this test to mean anything");

  assert.ok(p.plan_fields?.object, `the packet must NAME the object, not just its sig: ${JSON.stringify(p.plan_fields)}`);
  assert.ok(p.plan_fields.object_kind, "and its kind");
  assert.equal(p.plan_fields.disposition, "re_architect", "and what it was classified as");
  assert.ok(p.plan_fields.disposition_rationale, "and WHY — the rationale that produced the classification");

  // The evidence channel: what the shape matcher actually looked at and found wanting.
  assert.ok(p.evidence && typeof p.evidence === "object", "evidence must be populated");
  assert.ok("consumption" in p.evidence, `the surface facts: ${JSON.stringify(p.evidence)}`);
  assert.ok("persistence" in p.evidence, `the data facts — the axis every BO shape gates on: ${JSON.stringify(p.evidence)}`);

  // FACTS ONLY — no disposition is recommended, so the packet informs without anchoring.
  const blob = JSON.stringify(p.evidence) + JSON.stringify(p.plan_fields);
  assert.ok(!/recommend|suggest/i.test(blob), `the gate states evidence, it does not advise: ${blob}`);
});
