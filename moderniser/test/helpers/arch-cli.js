import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { consumptionFacts } from "../../src/plan/consumption-facts.js";
import { persistenceFacts } from "../../src/plan/persistence-facts.js";
import { factHash, factStream } from "../../src/plan/arch-facts.js";
import { matchTargetShapes } from "../../src/plan/patterns/match.js";
import { putEntry } from "../../src/state/arch-verdict-cache.js";

// Shared harness for the cli-arch suites (B3.5a wiring seam 2, §4c "cmdArch verb"): the plan-time
// ARCHITECTURE gate, end-to-end — real subprocess, real fs, real modules, no mocks.
//
// These suites were ONE 998-line file whose 57 tests ran serially at 400s, the largest single component
// of the gate. node:test runs FILES concurrently and tests within a file serially, so the cost was
// structure, not any one slow test: the distribution was flat at ~8s each, top-10 only 40% of the total.
// Splitting by concern buys parallelism without weakening a single assertion — every test body was moved
// verbatim, and this module exists so the harness is defined ONCE rather than copied four ways.

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, "..", "..", "src", "cli.js");
export const FIXTURE = join(HERE, "..", "fixtures", "analyser-findings.json");
// Cross-object grouping needs at least TWO nodes that resolve to a shape, and since RC-1 a shape requires
// table evidence — the real abap_fico fixture has exactly one such node. This fixture is that same real
// analyser output plus two customer objects that each own a customer table (ZORD_ORDER/ZTORDER,
// ZORD_ITEM/ZTORDERITEM) and call CL_SALV_TABLE, so both resolve to rap_bo_fiori and can legitimately be
// grouped into one app. Same schema and same hashes, so plan/arch verify it exactly as they do the original.
export const GROUPING_FIXTURE = join(HERE, "..", "fixtures", "analyser-findings-grouping.json");

export function mk() {
  const base = mkdtempSync(join(tmpdir(), "arch-cli-"));
  const stateDir = join(base, "state");
  const runsDir = join(base, "runs");
  const run = (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", stateDir, "--runs-dir", runsDir], { encoding: "utf8" }));
  return { base, stateDir, runsDir, run };
}

// Seed the CROSS-RUN verdict cache so a named node resolves as 'cached' — the real fulfiller flow (the judge
// writes the cache, cmdArch re-run hits it). A real cache file + the real fact hash; no mocks.
export function seedCache(stateDir, node, cons, pers, { model = "opus", promptHash = "ph1", shape, candidates, judgedBy, shared } = {}) {
  shape ??= topShape(node, cons, pers);
  // `judged_by` is what cli-arch-verdict.js:52 really stores alongside the recommendation (F-2).
  const rec = { sig: node.id, target_shape: shape, components: [], invariants: [], candidates: candidates ?? [{ id: shape, score: 1 }], source: "judge", ...(judgedBy ? { judged_by: judgedBy } : {}), ...(shared ? { shared } : {}) };
  const cache = putEntry({ entries: {} }, factHash(node, cons, pers), model, promptHash, rec);
  writeFileSync(join(stateDir, "arch-verdict-cache.json"), JSON.stringify(cache, null, 2));
  return rec;
}

/** Seed the cache with a judge verdict whose `shared` grouping names a sig from ANOTHER run. */
export function seedCacheWithForeignShared(stateDir, node, cons, pers, foreignSig, opts = {}) {
  const { model = "opus", promptHash = "ph1", shape = topShape(node, cons, pers) } = opts;
  const rec = {
    sig: node.id, target_shape: shape, components: [], invariants: [],
    candidates: [{ id: shape, score: 1 }], source: "judge",
    shared: { services: [{ id: "SRV_ORDER_MGMT", members: [foreignSig] }], projections: [], fiori_apps: [] },
  };
  writeFileSync(join(stateDir, "arch-verdict-cache.json"), JSON.stringify(putEntry({ entries: {} }, factHash(node, cons, pers), model, promptHash, rec), null, 2));
  return rec;
}

/** The shape this node's OWN facts offer — a seed the arch gate accepts rather than refuses. Derived from
 *  the real matcher so no test has to know which shape a fixture node resolves to, and so a future change
 *  to the corpus gating cannot silently invalidate every seeded cache entry. */
export const topShape = (node, cons, pers) => matchTargetShapes(factStream(node, cons, pers))[0]?.id;
export const consOf = (doc = FIXTURE) => consumptionFacts(JSON.parse(readFileSync(doc, "utf8")));
export const persOf = (doc = FIXTURE) => persistenceFacts(JSON.parse(readFileSync(doc, "utf8")));
// The fixture's only node that still RESOLVES to a target shape. Since RC-1 a managed RAP BO requires
// table evidence — the shape's whole point is an owned persistent root — and ZFICO_BTC_CSV_SCR / _TOP touch
// no table at all, so they are correctly `unplaceable` and a human re-dispositions them. Tests that need a
// node which resolves must name the one that does, rather than assume the first.
export const archNode = (plan) => plan.nodes.find((n) => n.object === "ZFICO_BTC_CSV_GL");
/** How many of the fixture's nodes a shape can actually be justified for (the rest are `unplaceable`). */
export const PLACEABLE = 1;
/** The grouping fixture adds two table-owning objects, so three of its nodes resolve. */
export const PLACEABLE_GROUPING = 3;
/** Its placeable nodes, in plan order — the ones a cross-object group can actually be built from. */
export const archNodes = (plan) => plan.nodes.filter((n) => /^(ZORD_ORDER|ZORD_ITEM|ZFICO_BTC_CSV_GL)$/.test(n.object));
export const stateOf = (stateDir, runId) => JSON.parse(readFileSync(join(stateDir, "runs", `${runId}.state.json`), "utf8"));
export const manifestOf = (runsDir, runId) => JSON.parse(readFileSync(join(runsDir, runId, "architecture-manifest.json"), "utf8"));
export const archEscs = (run, runId) => {
  const e = run("escalations", runId, "--max", "50");
  return [...e.surfaced, ...e.queued].filter((x) => x.kind === "ARCH_REVIEW");
};

export const writeShared = (base, name, shared) => {
  const p = join(base, name);
  writeFileSync(p, JSON.stringify(shared));
  return p;
};

/** Record a passing abap-arch-reviewer verdict for a sig — the fresh-context counter-party to the judge. */
export function reviewOk(run, runId, sig, payload = { verdict: "pass", flags: [] }) {
  const p = join(mkdtempSync(join(tmpdir(), "arch-rev-")), "verdict.json");
  writeFileSync(p, JSON.stringify(payload));
  return run("arch-review", runId, sig, "--verdict", p, "--by", "abap-arch-reviewer");
}

/**
 * Ratify every OPEN ARCH_REVIEW the way the lane does: independent review first, then the human IF one is
 * still required. Since GAP 3 a reviewer `pass` ratifies and resolves the gate itself, so the human step is
 * conditional — `decide` on an already-resolved escalation is refused, correctly. Keyed on the verb's own
 * `auto_ratified` flag rather than on a guess about which verdict was rendered.
 */
export const reviewAndApprove = (run, runId) => {
  for (const e of archEscs(run, runId)) {
    const res = reviewOk(run, runId, e.node_ids[0]);
    if (!res?.auto_ratified) run("decide", runId, e.id, "approve", "--by", "eng");
  }
};


/**
 * Ratify ONE contract through the HUMAN path, for tests whose subject is that path (or that simply need a
 * ratification stamped with a person's name). Since GAP 3 a reviewer `pass` ratifies by itself and resolves
 * the gate, so reaching a human decision means rendering `concerns` — "defensible, but something deserves
 * the human's eye" — which is precisely when a person is supposed to be asked.
 */
export const humanRatify = (run, runId, sig, by = "eng") => {
  const esc = archEscs(run, runId).find((e) => e.node_ids?.[0] === sig) ?? archEscs(run, runId)[0];
  reviewOk(run, runId, sig, { verdict: "concerns", flags: ["needs_human_eye"] });
  return run("decide", runId, esc.id, "approve", "--by", by);
};
