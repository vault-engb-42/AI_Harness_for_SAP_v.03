import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// /modernise CLI (§6.5) — the deterministic imperative shell over the pure reducer, driven
// by the skill via Bash. REAL code path: subprocess + real fs against a temp state dir with
// the golden ZFICO fixture (no mocks). GREEN is EARNED: outcome GREEN requires a recorded
// green verdict at GATED (the reducer decides, never the orchestrator's prose).

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

const GREEN_CP = {
  activated: true, reconciled: true, atc_p1: 0, unit: { green: true },
  invariants: { intact: true }, auth_coverage: { lost: false }, parity: { verdict: "PASS_STRUCTURAL" },
};
const GREEN_EV = { atc_p1: 0, atc_warns: [], coverage: { pct: 0.55, bite_proven: true } };

function run(args, opts = {}) {
  const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });
  return JSON.parse(out);
}

function freshDirs() {
  const base = mkdtempSync(join(tmpdir(), "modernise-cli-"));
  writeFileSync(join(base, "cp.json"), JSON.stringify(GREEN_CP), "utf8");
  writeFileSync(join(base, "ev.json"), JSON.stringify(GREEN_EV), "utf8");
  return { base, state: join(base, "state"), runs: join(base, "runs") };
}

const mkCli = ({ base, state, runs }) => {
  const cli = (...a) => run([...a, "--state-dir", state, "--runs-dir", runs]);
  const walk = (rid, sig) => {
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    cli("verdict", rid, sig, "--checkpoint", join(base, "cp.json"), "--evidence", join(base, "ev.json"), "--record");
    cli("outcome", rid, sig, "GREEN");
  };
  return { cli, walk };
};

test("plan → next → dispatch → FSM walk → verdict → GREEN runs the golden fixture to complete", () => {
  const dirs = freshDirs();
  const { cli, walk } = mkCli(dirs);
  try {
    const planned = cli("plan", FIXTURE);
    assert.match(planned.run_id, /^run-[0-9a-f]{12}$/, "deterministic run id from the plan hash");
    assert.equal(planned.nodes.length, 3);
    assert.ok(existsSync(join(dirs.state, "plan", `${planned.run_id}.plan.json`)), "plan persisted");
    const rid = planned.run_id;

    for (const expected of ["ZFICO_BTC_CSV_SCR", "ZFICO_BTC_CSV_TOP", "ZFICO_BTC_CSV_GL"]) {
      const r = cli("next", rid);
      assert.equal(r.ready[0].object, expected, "bottom-up order");
      cli("dispatch", rid, r.ready[0].sig);
      walk(rid, r.ready[0].sig);
    }

    const st = cli("status", rid);
    assert.equal(st.complete, true);
    assert.deepEqual(st.counts, { GREEN: 3 });

    const log = readFileSync(join(dirs.runs, rid, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(log.length >= 20, "one row per mutation");
    assert.ok(log.every((r) => r.run_id === rid && typeof r.event === "string"), "structured rows");
    assert.ok(!JSON.stringify(log).includes("CALL FUNCTION"), "P8: no ABAP source in the log");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("outcome GREEN without a green verdict is REFUSED through the CLI (gate not bypassable)", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    const { run_id: rid } = cli("plan", FIXTURE);
    const r1 = cli("next", rid);
    cli("dispatch", rid, r1.ready[0].sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, r1.ready[0].sig, s);
    assert.throws(() => cli("outcome", rid, r1.ready[0].sig, "GREEN"), /verdict|Command failed/i);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("verdict is refused unless the node is at GATED (no out-of-lifecycle baseline moves)", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = cli("plan", FIXTURE);
    const sig = nodes.find((n) => n.object === "ZFICO_BTC_CSV_SCR").sig;
    assert.throws(
      () => cli("verdict", rid, sig, "--checkpoint", join(dirs.base, "cp.json"), "--evidence", join(dirs.base, "ev.json"), "--record"),
      /GATED|Command failed/i,
    );
    assert.ok(!existsSync(join(dirs.state, "atc-baseline.json")), "no baseline moved");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("a green verdict at GATED records baselines once (--record) and GREEN completes", () => {
  const dirs = freshDirs();
  const { cli, walk } = mkCli(dirs);
  try {
    const { run_id: rid } = cli("plan", FIXTURE);
    const r1 = cli("next", rid);
    cli("dispatch", rid, r1.ready[0].sig);
    walk(rid, r1.ready[0].sig);
    const atc = JSON.parse(readFileSync(join(dirs.state, "atc-baseline.json"), "utf8"));
    assert.equal(atc.per_object[r1.ready[0].sig], 0, "baseline established via onPass");
    assert.equal(cli("status", rid).counts.GREEN, 1);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("resume verifies both hashes; a tampered state fails CLOSED", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    const { run_id: rid } = cli("plan", FIXTURE);
    const r1 = cli("next", rid);
    cli("dispatch", rid, r1.ready[0].sig);
    const resumed = cli("resume", rid);
    assert.equal(resumed.verified, true);
    assert.equal(resumed.status.counts.GROUNDED, 1);

    const statePath = join(dirs.state, "runs", `${rid}.state.json`);
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    st.plan_hash = "f".repeat(64);
    writeFileSync(statePath, JSON.stringify(st), "utf8");
    assert.throws(() => cli("resume", rid), /plan_hash|Command failed/i);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("guards: run-id traversal, non-positive team-size, un-ready dispatch, existing run", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    assert.throws(() => cli("plan", FIXTURE, "--run-id", "../../evil/pwn"), /run-id|Command failed/i, "path traversal rejected");
    assert.ok(!existsSync(join(dirs.base, "evil")), "nothing written outside containment");
    assert.throws(() => cli("plan", FIXTURE, "--team-size", "0"), /team-size|Command failed/i);
    assert.throws(() => cli("plan", FIXTURE, "--team-size", "abc"), /team-size|Command failed/i);

    const { run_id: rid, nodes } = cli("plan", FIXTURE);
    const gl = nodes.find((n) => n.object === "ZFICO_BTC_CSV_GL").sig;
    assert.throws(() => cli("dispatch", rid, gl), /ready|Command failed/i, "GL's closure is not green");
    assert.throws(() => cli("plan", FIXTURE), /exists|resume|Command failed/i, "re-planning a live run refused");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("repeating a mutating command after a half-commit is an idempotent no-op, never a wedge", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    const { run_id: rid } = cli("plan", FIXTURE);
    const r1 = cli("next", rid);
    const sig = r1.ready[0].sig;
    cli("dispatch", rid, sig);
    const again = cli("dispatch", rid, sig); // retry after a crash-between-state-and-log
    assert.deepEqual(again.dispatched, [sig], "no illegal GROUNDED→GROUNDED wedge");
    cli("progress", rid, sig, "GENERATED");
    const rep = cli("progress", rid, sig, "GENERATED"); // same-status repeat is a no-op
    assert.equal(rep.status, "GENERATED");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});
