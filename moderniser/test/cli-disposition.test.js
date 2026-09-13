import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// `disposition <run_id>` + parametrized `decide` end-to-end (real subprocess, real fs, golden fixture — no
// mocks). B3: the plan-time DISPOSITION gate emits the manifest and raises one DISPOSITION_REVIEW per prompted
// node; `decide` routes the parametrized form (approve | override:<disposition> | other:<freeform>).

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");
const GROUPING_FIXTURE = join(HERE, "fixtures", "analyser-findings-grouping.json");

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "disp-cli-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  const cli = (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" }));
  cli.planOf = (runId) => JSON.parse(readFileSync(join(state, "plan", `${runId}.plan.json`), "utf8"));
  return cli;
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

// GAP 6 — the surfacing window showed the wrong gates, in the wrong order.
//
// Measured on a real talv run sharing the default register: 89 OPEN escalations, of which only 60 belonged
// to the run the operator asked about. `surfaceable` has no run scoping — `run_id` is stamped by
// `resolveEscalation` at decide time and never consulted when reading — so `packets <run>` surfaced gates
// for objects that are not in that run's plan at all. `collectOverrides` is run-scoped for exactly this
// reason ("an unscoped read would let a decision made against a discarded run silently re-plan this one");
// the surfacing read never got the same treatment.
//
// Ordering compounded it. Gate 1 runs before gate 2, so DISPOSITION_REVIEW rows always have the earliest
// `opened_at` and always win the window. At the DEFAULT --max 5 the operator saw five routine prompts while
// the gates the driver is actually stuck on sat at positions 62-89, invisible. Recency is not urgency.
//
// `criticalSigs` already exists on `surfaceable` and was reachable ONLY from a manual `--critical` flag —
// nothing ever computed it. The driver's own blocking predicate supplies it: a node is stuck when it is
// arch-gated and not ratified, which is precisely what makes `drive` return await_human.

test("GAP6 every surfaced packet names a node of the run asked about", () => {
  const cli = mkCli();
  const a = cli("plan", FIXTURE);
  cli("disposition", a.run_id);

  // A second run in the same state dir, sharing escalations.json — the real cross-run condition.
  const b = cli("plan", GROUPING_FIXTURE);
  cli("disposition", b.run_id);

  // NOTE the fixtures OVERLAP by design (the grouping fixture is the abap_fico one plus two objects), so a
  // shared object legitimately carries the SAME content-hashed sig in both plans. "Did run A's sigs appear"
  // is therefore not the invariant — the invariant is that every surfaced packet belongs to the run asked
  // about. An unscoped read fails this because it returns rows whose nodes are in NEITHER of those plans.
  const bNodes = new Set(cli.planOf(b.run_id).nodes.map((n) => n.id));
  const bPackets = cli("packets", b.run_id, "--max", "99").packets;
  assert.ok(bPackets.length > 0, "run B must raise gates for this test to mean anything");
  const foreign = bPackets.filter((p) => !p.node_ids.some((n) => bNodes.has(n)));
  assert.deepEqual(foreign.map((p) => p.id), [], `every packet must name a node of run B: ${foreign.length} foreign`);

  // And the converse, so the scoping cannot pass by surfacing nothing: run A still gets its own.
  const aNodes = new Set(cli.planOf(a.run_id).nodes.map((n) => n.id));
  const aPackets = cli("packets", a.run_id, "--max", "99").packets;
  assert.ok(aPackets.length > 0 && aPackets.every((p) => p.node_ids.some((n) => aNodes.has(n))), "run A keeps its own gates");
});

test("GAP6 the gates the driver is STUCK on outrank routine prompts in a TIGHT window", () => {
  const cli = mkCli();
  const planned = cli("plan", GROUPING_FIXTURE);   // 5 nodes -> 5 routine prompts, raised FIRST
  cli("disposition", planned.run_id);
  cli("arch", planned.run_id, GROUPING_FIXTURE);   // then the blocking ones, with LATER opened_at

  const blockingKinds = new Set(["NO_TARGET_SHAPE", "ARCH_REVIEW"]);
  const all = cli("packets", planned.run_id, "--max", "99").packets;
  assert.ok(all.some((p) => blockingKinds.has(p.kind)), "the fixture must produce a blocking gate");
  assert.ok(all.filter((p) => p.kind === "DISPOSITION_REVIEW").length >= 3, "and enough routine prompts to crowd a tight window");

  // A window far SMALLER than the routine-prompt count. Under opened_at ordering this is all
  // DISPOSITION_REVIEW and the operator never learns the run is blocked.
  const window = cli("packets", planned.run_id, "--max", "2").packets;
  assert.ok(
    window.some((p) => blockingKinds.has(p.kind)),
    `a tight window must still surface what the run is stuck on, got: ${JSON.stringify(window.map((p) => p.kind))}`,
  );
});

// ---- APPROVING AN UNPLACEABLE NODE RE-CREATES THE DEADLOCK THE GATE EXISTS TO BREAK ----
//
// Found in the first real GAP 5 run (2026-09-13, abap_fico). A node can be gated TWICE: DISPOSITION_REVIEW
// asks "is re_architect right?", NO_TARGET_SHAPE says "nothing can be built from that". Approving the
// first while the second stands is not a change of mind - it is an UNBUILDABLE answer, and it puts the
// node straight back at await_human/arch_ratification with no shape to ratify. That is F-8.2 exactly.
//
// Narrow ON PURPOSE. Refusing every approve that follows an override would break the temporally-final rule
// the register is built on, which deliberately lets a human revert. The refusal fires only where the two
// answers genuinely contradict: an OPEN unplaceable gate on the same node.

test("approve is REFUSED while the same node has an open NO_TARGET_SHAPE gate", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  cli("arch", planned.run_id, FIXTURE);

  const all = cli("escalations", planned.run_id, "--max", "99");
  const rows = [...all.surfaced, ...(all.queued ?? [])].filter((r) => r.status === "OPEN");
  const nts = rows.find((r) => r.kind === "NO_TARGET_SHAPE");
  assert.ok(nts, "the fixture must produce an unplaceable node for this test to mean anything");
  const sig = nts.node_ids[0];
  const review = rows.find((r) => r.kind === "DISPOSITION_REVIEW" && r.node_ids.includes(sig));
  assert.ok(review, "and that node must also carry its disposition review");

  assert.throws(
    () => cli("decide", planned.run_id, review.id, "approve", "--by", "eng"),
    /unplaceable|NO_TARGET_SHAPE/i,
    "approving the classified disposition of an object no shape fits must be refused, not recorded",
  );
});

test("...and is ALLOWED once the unplaceable gate is resolved - the refusal is not a permanent ban", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  cli("arch", planned.run_id, FIXTURE);
  const all = cli("escalations", planned.run_id, "--max", "99");
  const rows = [...all.surfaced, ...(all.queued ?? [])].filter((r) => r.status === "OPEN");
  const nts = rows.find((r) => r.kind === "NO_TARGET_SHAPE");
  const sig = nts.node_ids[0];
  const review = rows.find((r) => r.kind === "DISPOSITION_REVIEW" && r.node_ids.includes(sig));

  // the human answers the unplaceable gate FIRST, which is the order the remedy prescribes
  cli("decide", planned.run_id, nts.id, "other:the patterns corpus is missing a shape for this", "--by", "eng");
  const row = cli("decide", planned.run_id, review.id, "approve", "--by", "eng");
  assert.equal(row.status, "RESOLVED", "with the contradiction gone, the approval is a legitimate answer");
});

test("END-TO-END: the exact sequence that silently ate six decisions is now REPORTED", () => {
  // The GAP 5 run, reproduced. Override the unplaceable gate (which RESOLVES it, so the approve below is
  // legitimately allowed - fix 2 only refuses while it is OPEN), then approve the same node's disposition.
  // The temporally-final rule still makes approve win; what changed is that replan now SAYS SO.
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  cli("arch", planned.run_id, FIXTURE);
  const rows = (() => {
    const all = cli("escalations", planned.run_id, "--max", "99");
    return [...all.surfaced, ...(all.queued ?? [])].filter((r) => r.status === "OPEN");
  })();
  const nts = rows.find((r) => r.kind === "NO_TARGET_SHAPE");
  const sig = nts.node_ids[0];
  const review = rows.find((r) => r.kind === "DISPOSITION_REVIEW" && r.node_ids.includes(sig));

  cli("decide", planned.run_id, nts.id, "override:refactor", "--by", "eng");
  cli("decide", planned.run_id, review.id, "approve", "--by", "eng");

  const out = cli("replan", planned.run_id, FIXTURE, "--by", "eng");
  const lost = out.superseded ?? [];
  assert.equal(lost.length, 1, `the discarded decision must be reported: ${JSON.stringify(out)}`);
  assert.equal(lost[0].sig, sig);
  assert.equal(lost[0].disposition, "refactor", "what the human actually asked for");
  assert.equal(lost[0].superseded_by, "DISPOSITION_REVIEW", "and which gate took it away");
  assert.match(String(out.note ?? ""), /SUPERSEDED/i, "with a note naming the remedy, not a bare field");
});
