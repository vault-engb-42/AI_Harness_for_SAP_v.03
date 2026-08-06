import { test } from "node:test";
import assert from "node:assert/strict";
import { groundCandidates } from "../src/plan/ground-candidates.js";
import { classifyDisposition } from "../src/plan/disposition.js";
import { buildDispositionManifest } from "../src/plan/manifest.js";

// P1 — REGISTRY-GROUNDED DISPOSITION EVIDENCE.
//
// The design withheld `retire`/`replace` from the classifier because both "demand a basis a per-object token
// cannot supply", deferring them to "source grounding" that did not exist. That premise EXPIRED: the harness
// bundles the SAP cloudification registry (34,675 entries — 653 notToBeReleased, 519 deprecated, 702 carrying
// named successors), already loaded by analyser/src/cloudification.js, and ground-candidates.js's own comment
// named exactly that asset as the missing piece.
//
// What the registry CAN answer, grounded: "does this object depend on SAP APIs that are not coming to the
// cloud, and is there a released successor?" A ref that is notToBeReleased with NO successor is precisely the
// "grounded no-released-successor basis" the design asks a retire to rest on.
//
// What it CANNOT answer: "should this capability be dropped" (a business call) or "does SAP already deliver
// this custom capability" (a semantic bridge, which is why fit-to-standard is advisory). So the evidence
// upgrades the OPTIONS the human chooses from — it never changes the recommendation and never auto-applies.

const doc = (edges, objects) => ({
  findings: objects.map((o) => ({ object: o, family: "clean-core", atc_priority: "P2" })),
  graph: { nodes: [], edges },
  modernization_plan: { objects: objects.map((object) => ({ object })) },
});

test("P1 the grounding cache carries registry evidence for the APIs an object depends on", () => {
  // CL_GUI_ALV_GRID is a real registry entry: classicAPI (not coming to the cloud), no named successor.
  const cache = groundCandidates(doc([{ source: "ZFOO.main", target: "CL_GUI_ALV_GRID", kind: "calls" }], ["ZFOO"]));
  const g = cache.ZFOO;
  assert.ok(Array.isArray(g.no_successor_refs), "the cache exposes the no-released-successor basis");
  assert.ok(g.no_successor_refs.includes("CL_GUI_ALV_GRID"), `expected CL_GUI_ALV_GRID, got ${JSON.stringify(g.no_successor_refs)}`);
});

test("P1 a released dependency yields NO no-successor evidence (absence is not fabricated)", () => {
  const cache = groundCandidates(doc([{ source: "ZOK.main", target: "ZSOME_CUSTOM_THING", kind: "calls" }], ["ZOK"]));
  assert.deepEqual(cache.ZOK.no_successor_refs, [], "an unknown/custom ref is not evidence of anything");
});

test("P1 standard-domain reads are grounded per object (the replace bridge's evidence)", () => {
  const cache = groundCandidates(doc([{ source: "ZFI.main", target: "SKA1", kind: "uses-table" }], ["ZFI"]));
  assert.ok(cache.ZFI.standard_domains.includes("G/L Account"), `got ${JSON.stringify(cache.ZFI.standard_domains)}`);
});

test("P1 the evidence rides the classified node (so the gate can show the human what it rests on)", () => {
  const cache = groundCandidates(doc([{ source: "ZFOO.main", target: "CL_GUI_ALV_GRID", kind: "calls" }], ["ZFOO"]));
  const node = { object: "ZFOO", kind: "report", object_kind: "report", disposition_hints: ["ui_rearch"], modernization_target: "Fiori Elements App" };
  const classified = classifyDisposition(node, cache);
  assert.equal(classified.disposition, "re_architect", "the RECOMMENDATION is unchanged — evidence informs, it does not decide");
  assert.ok(classified.disposition_evidence.no_successor_refs.includes("CL_GUI_ALV_GRID"));
});

test("P1 the retire OPTION is grounded when evidence exists, and honest when it does not", () => {
  const withEvidence = groundCandidates(doc([{ source: "ZFOO.main", target: "CL_GUI_ALV_GRID", kind: "calls" }], ["ZFOO"]));
  const bare = groundCandidates(doc([], ["ZBARE"]));
  const mk = (object, cache, hints) => ({
    id: `sig-${object}`, object,
    ...classifyDisposition({ object, kind: "report", object_kind: "report", disposition_hints: hints, modernization_target: "Fiori Elements App" }, cache),
  });
  const plan = { plan_hash: "h", nodes: [mk("ZFOO", withEvidence, ["ui_rearch"]), mk("ZBARE", bare, ["ui_rearch"])] };
  const rows = buildDispositionManifest(plan, { run_id: "r1" }).rows;

  const grounded = rows.find((r) => r.object === "ZFOO").options.find((o) => o.disposition === "retire");
  assert.match(grounded.rationale, /CL_GUI_ALV_GRID/, "the operator sees WHICH dependency has no forward path");
  assert.match(grounded.rationale, /no released successor/i);

  const ungrounded = rows.find((r) => r.object === "ZBARE").options.find((o) => o.disposition === "retire");
  assert.ok(!/no released successor/i.test(ungrounded.rationale), "with no evidence the option must not claim a basis it lacks");
});

test("P1 the replace OPTION names the standard domain when one is detected", () => {
  const cache = groundCandidates(doc([{ source: "ZFI.main", target: "SKA1", kind: "uses-table" }], ["ZFI"]));
  const node = { id: "sig-ZFI", object: "ZFI", ...classifyDisposition({ object: "ZFI", kind: "report", object_kind: "report", disposition_hints: ["ui_rearch"], modernization_target: "Fiori Elements App" }, cache) };
  const row = buildDispositionManifest({ plan_hash: "h", nodes: [node] }, { run_id: "r1" }).rows[0];
  const replace = row.options.find((o) => o.disposition === "replace") ?? row.options.find((o) => /standard/i.test(o.rationale));
  assert.ok(replace, `a grounded replace option should be offered; got ${JSON.stringify(row.options.map((o) => o.disposition))}`);
  assert.match(replace.rationale, /G\/L Account/, "the operator sees WHICH standard domain was detected");
});

// --- R2/R4/R6/R9 (adversarial pass, CONFIRMED): what P1 shipped could not see its own headline case ---

test("R2 a notToBeReleased object IS the no-successor basis — classify() calls that state 'removed'", () => {
  // The bug this pins: NO_FORWARD_PATH matched the RAW registry word `notToBeReleased`, but classify()
  // derives release_state from the oracle LEVEL (cloudification.js RELEASE_STATE_FOR_LEVEL: D -> "removed")
  // and never returns that word. So the entire class P1's own commit named as the retire basis was invisible
  // — all 81 zero-successor level-D objects, CL_HTTP_CLIENT among them.
  const cache = groundCandidates(doc([{ source: "ZFOO.main", target: "CL_HTTP_CLIENT", kind: "call-method" }], ["ZFOO"]));
  assert.ok(
    cache.ZFOO.no_successor_refs.includes("CL_HTTP_CLIENT"),
    `a level-D object with no successor is exactly 'no forward path as built'; got ${JSON.stringify(cache.ZFOO.no_successor_refs)}`,
  );
});

test("R2 a non-released object WITH a named successor is not a no-successor basis (there IS a forward path)", () => {
  const cache = groundCandidates(doc([{ source: "ZFI.main", target: "SKA1", kind: "uses-table" }], ["ZFI"]));
  assert.deepEqual(cache.ZFI.no_successor_refs, [], "SKA1 is level-D but carries a successor — that is a re-architect basis, not a retire one");
});

test("R4 a call-method reference resolves to the CLASS, not to CLASS.METHOD", () => {
  // Real edge from the golden fixture: ZFICO_BTC_CSV_GL.UPLOAD_FILE -> CL_GUI_FRONTEND_SERVICES.GUI_UPLOAD.
  // The target was classified whole, so it never matched the registry — and call-method is how ABAP
  // references SAP classes, which made the entire channel silent.
  const cache = groundCandidates(doc([{ source: "ZFOO.UPLOAD_FILE", target: "CL_GUI_FRONTEND_SERVICES.GUI_UPLOAD", kind: "call-method" }], ["ZFOO"]));
  assert.ok(cache.ZFOO.no_successor_refs.includes("CL_GUI_FRONTEND_SERVICES"), `got ${JSON.stringify(cache.ZFOO.no_successor_refs)}`);
});

test("R9 standard domains come from table READS only, matching the fit-to-standard sibling", () => {
  const reads = groundCandidates(doc([{ source: "ZFI.main", target: "SKA1", kind: "uses-table" }], ["ZFI"]));
  assert.ok(reads.ZFI.standard_domains.includes("G/L Account"));
  const notARead = groundCandidates(doc([{ source: "ZFI.main", target: "SKA1.SOMETHING", kind: "call-method" }], ["ZFI"]));
  assert.deepEqual(notARead.ZFI.standard_domains, [], "a symbol that merely shares a table's name is not a table read");
});

test("R6 a super-node's evidence unions EVERY member, not just the representative", () => {
  // A super-node ships as one unit, so a dead API reached through any member is the whole node's problem.
  const cache = groundCandidates(doc([
    { source: "ZA.m", target: "CL_GUI_ALV_GRID", kind: "call-method" },
    { source: "ZB.m", target: "CL_HTTP_CLIENT", kind: "call-method" },
  ], ["ZA", "ZB"]));
  const node = { object: "ZA", members: ["ZA", "ZB"], kind: "super", object_kind: "report", disposition_hints: ["ui_rearch"], modernization_target: "Fiori Elements App" };
  assert.deepEqual(
    classifyDisposition(node, cache).disposition_evidence.no_successor_refs,
    ["CL_GUI_ALV_GRID", "CL_HTTP_CLIENT"],
    "the representative's refs alone would hide ZB's dead dependency",
  );
});

test("R7 evidence NEVER becomes a recommendation, even at its strongest", () => {
  // The prior tests only pinned this for a node the ui_rearch branch decides FIRST, so a mutant that read
  // the registry evidence further down the ladder survived them all.
  const cache = groundCandidates(doc([{ source: "ZQ.m", target: "CL_HTTP_CLIENT", kind: "call-method" }], ["ZQ"]));
  const c = classifyDisposition({ object: "ZQ", kind: "class", object_kind: "class", disposition_hints: [], modernization_target: null }, cache);
  assert.ok(c.disposition_evidence.no_successor_refs.includes("CL_HTTP_CLIENT"), "the basis is present and complete");
  assert.notEqual(c.disposition, "retire", "the registry can say 'no forward path AS BUILT'; it cannot say the capability is unwanted");
  assert.notEqual(c.disposition, "replace", "nor that SAP already delivers it — that is the semantic bridge no registry crosses");
});

test("P1 never auto-applies: an evidence-carrying node still prompts", () => {
  const cache = groundCandidates(doc([{ source: "ZFOO.main", target: "CL_GUI_ALV_GRID", kind: "calls" }], ["ZFOO"]));
  const classified = classifyDisposition({ object: "ZFOO", kind: "report", object_kind: "report", disposition_hints: ["ui_rearch"], modernization_target: "Fiori Elements App" }, cache);
  assert.equal(classified.disposition_autonomy, "prompt", "grounded evidence widens the CHOICE, it never removes the human");
});
