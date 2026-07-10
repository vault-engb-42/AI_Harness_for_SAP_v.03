import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildObjectGraph, precedenceEdges } from "../src/graph/build.js";
import { scopeNodes, scopeMeta, scopeConflictNodes } from "../src/node/scope.js";
import { tarjanCondense } from "../src/graph/condense.js";
import { kahnLevels } from "../src/sched/levels.js";
import { buildConflictGraph } from "../src/graph/conflict.js";
import { nextFrontier } from "../src/sched/frontier.js";

// END-TO-END: the whole offline scheduler spine wired on REAL ZFICO analyser output —
// analyser-findings.json → build (object graph) → scope (JOIN) → precedence-orient →
// condense → levels → conflict → frontier. BOTTOM-UP (ratified 2026-07-11): the scheduler
// consumes dependency→dependent edges, so leaves schedule first and the entry report lands
// in the LAST wave — matching the analyser's bottom-up modernization_plan.wave.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));
const PLAN = new Set(DOC.modernization_plan.objects.map((o) => o.object)); // the modernization targets

function wire() {
  const og = buildObjectGraph(DOC);
  const scoped = scopeNodes(DOC, og);
  const cond = tarjanCondense(og.nodes.map((n) => n.id), precedenceEdges(og.edges));
  const levels = kahnLevels(cond, scopeMeta(scoped));
  const conflict = buildConflictGraph(scopeConflictNodes(scoped));
  return { og, scoped, cond, levels, conflict };
}

test("the object graph + scope join produce a coherent, acyclic condensation on real data", () => {
  const { og, scoped, cond } = wire();
  assert.equal(og.nodes.length, 11);
  assert.equal(scoped.length, 3);
  assert.equal(cond.superNodes.length, 11, "ZFICO object graph is a DAG → all singleton super-nodes");
  assert.ok(cond.superNodes.every((s) => !s.break_gate), "no cycle super-nodes");
});

test("levels are BOTTOM-UP: dependencies first, the entry report LAST — same direction as the plan's wave", () => {
  const { scoped, levels } = wire();
  assert.equal(levels.levelOf.KD_GET_FILENAME_ON_F4, 0, "a SAP leaf dependency is level 0");
  assert.equal(levels.levelOf.ZFICO_BTC_CSV_TOP, 0, "an include with no further deps is level 0");
  assert.equal(levels.levelOf.ZFICO_BTC_CSV_SCR, 1, "SCR waits for its own dependency KD_GET");
  assert.equal(levels.levelOf.ZFICO_BTC_CSV_GL, 2, "the entry report is the LAST wave");
  // Ratified 2026-07-11: scheduler levels run the SAME direction as the analyser's
  // bottom-up modernization_plan.wave — every dependency levels (and waves) BEFORE its dependent.
  const wave = Object.fromEntries(scoped.map((s) => [s.object, s.wave]));
  for (const dep of ["ZFICO_BTC_CSV_SCR", "ZFICO_BTC_CSV_TOP"]) {
    assert.ok(levels.levelOf.ZFICO_BTC_CSV_GL > levels.levelOf[dep], `GL levels after ${dep}`);
    assert.ok(wave.ZFICO_BTC_CSV_GL > wave[dep], `…and the plan's wave agrees (${dep})`);
  }
});

test("the conflict graph clusters GL/SCR/TOP via the shared program pool (includes co-tenancy)", () => {
  const { conflict } = wire();
  assert.deepEqual(conflict.groups, [["ZFICO_BTC_CSV_GL", "ZFICO_BTC_CSV_SCR", "ZFICO_BTC_CSV_TOP"]]);
});

test("the resumable frontier runs the plan bottom-up: SCR → TOP → GL (co-tenants serialized, entry LAST)", () => {
  const { cond, levels, conflict, scoped } = wire();
  const state = {
    condensation: cond,
    conflict: { keysOf: conflict.keysOf },
    // modernization targets are PENDING; released SAP-standard leaves are GREEN (no work)
    status: Object.fromEntries(cond.superNodes.map((s) => [s.id, PLAN.has(s.id) ? "PENDING" : "GREEN"])),
    indegree: { ...levels.indegree },
    meta: scopeMeta(scoped),
    teamSize: Infinity,
  };
  // Loop-init contract (§3.1 Stage 6 adopt): discount precedence edges whose source is
  // already GREEN — SAP-standard / out-of-plan dependencies need no modernisation.
  for (const [u, v] of cond.edges) if (state.status[u] === "GREEN") state.indegree[v] -= 1;
  const markGreen = (id) => {
    state.status[id] = "GREEN";
    for (const [u, v] of cond.edges) if (u === id) state.indegree[v] -= 1;
  };

  const r1 = nextFrontier(state);
  assert.deepEqual(r1, ["ZFICO_BTC_CSV_SCR"], "GL's dependencies go first; TOP deferred this round (co-tenant of SCR)");
  markGreen("ZFICO_BTC_CSV_SCR");

  const r2 = nextFrontier(state);
  assert.deepEqual(r2, ["ZFICO_BTC_CSV_TOP"], "TOP next — its co-tenant SCR is green, no longer in the batch");
  markGreen("ZFICO_BTC_CSV_TOP");

  const r3 = nextFrontier(state);
  assert.deepEqual(r3, ["ZFICO_BTC_CSV_GL"], "the entry report schedules LAST — its whole closure is green");
  markGreen("ZFICO_BTC_CSV_GL");

  assert.deepEqual(nextFrontier(state), [], "all modernization targets scheduled");
});

test("the whole wiring is deterministic", () => {
  assert.equal(JSON.stringify(wire()), JSON.stringify(wire()));
});
