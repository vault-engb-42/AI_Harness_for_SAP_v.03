import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildObjectGraph } from "../src/graph/build.js";
import { scopeNodes, scopeMeta, scopeConflictNodes } from "../src/node/scope.js";
import { tarjanCondense } from "../src/graph/condense.js";
import { kahnLevels } from "../src/sched/levels.js";
import { buildConflictGraph } from "../src/graph/conflict.js";
import { nextFrontier } from "../src/sched/frontier.js";

// END-TO-END: the whole offline scheduler spine wired on REAL ZFICO analyser output —
// analyser-findings.json → build (object graph) → scope (JOIN) → condense → levels →
// conflict → frontier. Proves the pure modules compose on real data, not just synthetic.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));
const PLAN = new Set(DOC.modernization_plan.objects.map((o) => o.object)); // the modernization targets

function wire() {
  const og = buildObjectGraph(DOC);
  const scoped = scopeNodes(DOC, og);
  const cond = tarjanCondense(og.nodes.map((n) => n.id), og.edges.map((e) => [e.source, e.target]));
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

test("levels place the entry report at level 0 (top-down §3.1) — the OPPOSITE of the plan's bottom-up wave", () => {
  const { scoped, levels } = wire();
  assert.equal(levels.levelOf.ZFICO_BTC_CSV_GL, 0, "GL is in-degree-0 root → scheduler level 0");
  assert.equal(levels.levelOf.ZFICO_BTC_CSV_SCR, 1);
  assert.equal(levels.levelOf.ZFICO_BTC_CSV_TOP, 1);
  assert.equal(levels.levelOf.KD_GET_FILENAME_ON_F4, 2, "reached via SCR");
  // Documented direction relationship: the analyser's plan wave is bottom-up; the scheduler
  // re-derives its own top-down level and does not use `wave`.
  const gl = scoped.find((s) => s.object === "ZFICO_BTC_CSV_GL");
  assert.equal(gl.wave, 1, "analyser plan wave = 1 (bottom-up: after its deps)");
  assert.notEqual(gl.wave, levels.levelOf.ZFICO_BTC_CSV_GL, "wave (1) != scheduler level (0) — top-down vs bottom-up");
});

test("the conflict graph clusters GL/SCR/TOP via the shared program pool (includes co-tenancy)", () => {
  const { conflict } = wire();
  assert.deepEqual(conflict.groups, [["ZFICO_BTC_CSV_GL", "ZFICO_BTC_CSV_SCR", "ZFICO_BTC_CSV_TOP"]]);
});

test("the resumable frontier schedules the real plan: GL, then SCR, then TOP (co-tenants serialized)", () => {
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
  const markGreen = (id) => {
    state.status[id] = "GREEN";
    for (const [u, v] of cond.edges) if (u === id) state.indegree[v] -= 1;
  };

  const r1 = nextFrontier(state);
  assert.deepEqual(r1, ["ZFICO_BTC_CSV_GL"], "only the entry report is ready first (top-down)");
  markGreen("ZFICO_BTC_CSV_GL");

  const r2 = nextFrontier(state);
  assert.deepEqual(r2, ["ZFICO_BTC_CSV_SCR"], "SCR and TOP are both freed but co-tenant → only the worst-first one this round");
  markGreen("ZFICO_BTC_CSV_SCR");

  const r3 = nextFrontier(state);
  assert.deepEqual(r3, ["ZFICO_BTC_CSV_TOP"], "TOP now schedules — its co-tenant SCR is green, no longer in the batch");
  markGreen("ZFICO_BTC_CSV_TOP");

  assert.deepEqual(nextFrontier(state), [], "all modernization targets scheduled");
});

test("the whole wiring is deterministic", () => {
  assert.equal(JSON.stringify(wire()), JSON.stringify(wire()));
});
