import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// /modernise CLI (§6.5) — the deterministic imperative shell over the pure reducer, driven
// by the skill via Bash. REAL code path: subprocess + real fs against a temp state dir with
// the golden ZFICO fixture (no mocks). Every mutating command persists state durably and
// appends a P8-scrubbed observability row (§6.6, sigs/statuses only — never ABAP source).

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

function run(args, opts = {}) {
  const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });
  return JSON.parse(out);
}

function freshDirs() {
  const base = mkdtempSync(join(tmpdir(), "modernise-cli-"));
  return { base, state: join(base, "state"), runs: join(base, "runs") };
}

test("plan → next → dispatch → FSM walk → outcome → status runs the golden fixture to complete", () => {
  const { base, state, runs } = freshDirs();
  try {
    const planned = run(["plan", FIXTURE, "--state-dir", state, "--runs-dir", runs]);
    assert.match(planned.run_id, /^run-[0-9a-f]{12}$/, "deterministic run id from the plan hash");
    assert.match(planned.plan_hash, /^[0-9a-f]{64}$/);
    assert.equal(planned.nodes.length, 3);
    assert.ok(existsSync(join(state, "plan", `${planned.run_id}.plan.json`)), "plan persisted");
    assert.ok(existsSync(join(state, "runs", `${planned.run_id}.state.json`)), "state persisted");

    const rid = planned.run_id;
    const cli = (...a) => run([...a, "--state-dir", state, "--runs-dir", runs]);
    const walk = (sig) => {
      for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
      cli("outcome", rid, sig, "GREEN");
    };

    const r1 = cli("next", rid);
    assert.equal(r1.ready.length, 1);
    assert.equal(r1.ready[0].object, "ZFICO_BTC_CSV_SCR", "bottom-up: SCR first");
    cli("dispatch", rid, r1.ready[0].sig);
    walk(r1.ready[0].sig);

    const r2 = cli("next", rid);
    assert.equal(r2.ready[0].object, "ZFICO_BTC_CSV_TOP");
    cli("dispatch", rid, r2.ready[0].sig);
    walk(r2.ready[0].sig);

    const r3 = cli("next", rid);
    assert.equal(r3.ready[0].object, "ZFICO_BTC_CSV_GL", "the entry report schedules LAST");
    cli("dispatch", rid, r3.ready[0].sig);
    walk(r3.ready[0].sig);

    const st = cli("status", rid);
    assert.equal(st.complete, true);
    assert.deepEqual(st.counts, { GREEN: 3 });
    assert.deepEqual(st.ready_now, []);

    const log = readFileSync(join(runs, rid, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(log.length >= 20, "one row per mutation");
    assert.ok(log.every((r) => r.run_id === rid && typeof r.event === "string"), "structured rows");
    assert.ok(!JSON.stringify(log).includes("CALL FUNCTION"), "P8: no ABAP source in the log");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resume verifies both hashes and reports where the run stands", () => {
  const { base, state, runs } = freshDirs();
  try {
    const cli = (...a) => run([...a, "--state-dir", state, "--runs-dir", runs]);
    const { run_id: rid } = cli("plan", FIXTURE);
    const r1 = cli("next", rid);
    cli("dispatch", rid, r1.ready[0].sig);

    const resumed = cli("resume", rid);
    assert.equal(resumed.verified, true, "plan_hash re-verified + state bound");
    assert.equal(resumed.status.counts.GROUNDED, 1, "the dispatched node is in flight");
    assert.ok(resumed.status.ready_now.length >= 1, "what to do next is reported");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a tampered state file fails CLOSED on resume", () => {
  const { base, state, runs } = freshDirs();
  try {
    const cli = (...a) => run([...a, "--state-dir", state, "--runs-dir", runs]);
    const { run_id: rid } = cli("plan", FIXTURE);
    const statePath = join(state, "runs", `${rid}.state.json`);
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    st.plan_hash = "f".repeat(64); // bind to a different plan
    writeFileSync(statePath, JSON.stringify(st), "utf8");
    assert.throws(() => cli("resume", rid), /plan_hash|Command failed/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("verdict composes gate+verdict from evidence files; --record persists baselines only on green", () => {
  const { base, state, runs } = freshDirs();
  try {
    const cli = (...a) => run([...a, "--state-dir", state, "--runs-dir", runs]);
    const { run_id: rid, nodes } = cli("plan", FIXTURE);
    const sig = nodes.find((n) => n.object === "ZFICO_BTC_CSV_SCR").sig;
    const checkpoint = {
      activated: true, reconciled: true, atc_p1: 0, unit: { green: true },
      invariants: { intact: true }, auth_coverage: { lost: false }, parity: { verdict: "PASS_STRUCTURAL" },
    };
    // SCR is parity_required (it has transformations) → the bite must be PROVEN (L6(1))
    const evidence = { atc_p1: 0, atc_warns: [], coverage: { pct: 0.55, bite_proven: true } };
    writeFileSync(join(base, "cp.json"), JSON.stringify(checkpoint), "utf8");
    writeFileSync(join(base, "ev.json"), JSON.stringify(evidence), "utf8");

    const v = cli("verdict", rid, sig, "--checkpoint", join(base, "cp.json"), "--evidence", join(base, "ev.json"), "--record");
    assert.equal(v.green, true);
    assert.equal(v.gate.verdict, "PASS");
    const atc = JSON.parse(readFileSync(join(state, "atc-baseline.json"), "utf8"));
    assert.equal(atc.per_object[sig], 0, "baseline established via onPass copy-on-write");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("dispatching an un-ready node fails closed through the CLI too", () => {
  const { base, state, runs } = freshDirs();
  try {
    const cli = (...a) => run([...a, "--state-dir", state, "--runs-dir", runs]);
    const { run_id: rid, nodes } = cli("plan", FIXTURE);
    const gl = nodes.find((n) => n.object === "ZFICO_BTC_CSV_GL").sig;
    assert.throws(() => cli("dispatch", rid, gl), /ready|Command failed/i, "GL's closure is not green");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
