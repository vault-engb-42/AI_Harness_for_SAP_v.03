import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdjacency, groupEvidence, groupHub } from "../src/plan/group-evidence.js";

// The independent review found the TALV blueprint's membership wrong in ways the harness had the facts to
// show and never showed:
//
//   - APP_TABLE_MAINTENANCE enrolled ZAESOP_LOG_DEMO, a logging demo with ZERO edges to any other member;
//   - its structural hub, ZCL_TALV_PARENT, is `disposition: seal` and therefore can never BE a member —
//     "the blueprint names the shell and structurally cannot name the core".
//
// Neither is a defect the harness can decide for the human: two independent screens can legitimately be one
// app, and a sealed hub is a correct disposition. What was wrong is that the human ratified the grouping
// with none of it in front of them. These helpers compute the evidence; the decision stays theirs.
//
// The adjacency comes from the plan's own `dependencies` (sig-level, already derived from the CPG), read
// UNDIRECTED: "is connected to" is symmetric, and a caller and its callee are equally each other's evidence.

const node = (id, deps = [], o = {}) => ({ id, object: id, disposition: "re_architect", dependencies: deps, ...o });
const plan = (nodes) => ({ nodes });

test("adjacency is undirected — a dependency links both ends", () => {
  const adj = buildAdjacency(plan([node("A", ["B"]), node("B")]));
  assert.deepEqual([...adj.get("A")], ["B"]);
  assert.deepEqual([...adj.get("B")], ["A"], "the callee is linked to its caller too");
});

test("adjacency names every plan node, including one with no edges at all", () => {
  const adj = buildAdjacency(plan([node("A", ["B"]), node("B"), node("LONELY")]));
  assert.deepEqual([...adj.get("LONELY")], [], "present with an empty set, never absent");
});

test("a member connected to nothing else in its group is reported isolated", () => {
  const adj = buildAdjacency(plan([node("A", ["B"]), node("B"), node("LOG")]));
  const ev = groupEvidence("LOG", { members: ["A", "B", "LOG"] }, adj);
  assert.deepEqual(ev, { members: 3, linked_members: 0, isolated: true });
});

test("a connected member is not isolated, and says how many members it reaches", () => {
  const adj = buildAdjacency(plan([node("A", ["B", "C"]), node("B"), node("C")]));
  assert.deepEqual(groupEvidence("A", { members: ["A", "B", "C"] }, adj), { members: 3, linked_members: 2, isolated: false });
  assert.deepEqual(groupEvidence("B", { members: ["A", "B", "C"] }, adj), { members: 3, linked_members: 1, isolated: false });
});

test("a one-member group is not isolated — there is nothing to be isolated FROM", () => {
  const adj = buildAdjacency(plan([node("A")]));
  assert.deepEqual(groupEvidence("A", { members: ["A"] }, adj), { members: 1, linked_members: 0, isolated: false });
});

// THE SEALED HUB. `validateShared` refuses a non-arch-gated member by design — a sealed object is not being
// re-architected, so it cannot be assigned a target shape. Correct, and it leaves the blueprint describing an
// application whose structural centre is missing. Naming that centre on the row is the whole remedy: the
// human sees what the app is organised around and why it is not in the list.
test("the hub names the strongest NON-member the group is organised around, with its disposition", () => {
  const p = plan([
    node("A", ["HUB"]), node("B", ["HUB"]), node("C", ["HUB"]), node("D"),
    node("HUB", [], { object: "ZCL_TALV_PARENT", disposition: "seal" }),
  ]);
  const hub = groupHub({ members: ["A", "B", "C", "D"] }, p, buildAdjacency(p));
  assert.deepEqual(hub, { sig: "HUB", object: "ZCL_TALV_PARENT", disposition: "seal", links: 3 });
});

test("no hub when the group's strongest neighbour is already a member", () => {
  const p = plan([node("A", ["B"]), node("B", ["C"]), node("C")]);
  assert.equal(groupHub({ members: ["A", "B", "C"] }, p, buildAdjacency(p)), null, "a member is not an absent core");
});

test("no hub when nothing outside the group touches it", () => {
  const p = plan([node("A", ["B"]), node("B"), node("FAR")]);
  assert.equal(groupHub({ members: ["A", "B"] }, p, buildAdjacency(p)), null);
});

test("the hub is deterministic when two outsiders tie — lowest sig wins", () => {
  const p = plan([node("A", ["X", "Y"]), node("B", ["X", "Y"]), node("X"), node("Y")]);
  const hub = groupHub({ members: ["A", "B"] }, p, buildAdjacency(p));
  assert.equal(hub.sig, "X", "a tie resolves by sig so two runs never disagree");
});

test("one shared neighbour is coincidence, not a hub", () => {
  const p = plan([node("A", ["X"]), node("B"), node("X")]);
  assert.equal(groupHub({ members: ["A", "B"] }, p, buildAdjacency(p)), null, "a centre is what SEVERAL members organise around");
});

test("a dependency on a sig outside this plan is not adjacency evidence within it", () => {
  const adj = buildAdjacency(plan([node("A", ["NOT_IN_PLAN"])]));
  assert.deepEqual([...adj.get("A")], []);
  assert.equal(adj.has("NOT_IN_PLAN"), false, "a foreign sig never becomes a node of this graph");
});
