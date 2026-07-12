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

test("offline draft sweep: sweep-order lists PENDING nodes topologically; sweep-mark ledgers OUTSIDE loop state", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    const { run_id: rid } = cli("plan", FIXTURE);
    // gated offline pass: SCR and TOP (depth-0) dispatch and stop at SYNTAX_OK; GL never greens
    for (let i = 0; i < 2; i += 1) {
      const r = cli("next", rid);
      cli("dispatch", rid, r.ready[0].sig);
      cli("progress", rid, r.ready[0].sig, "GENERATED");
      cli("progress", rid, r.ready[0].sig, "SYNTAX_OK");
    }
    assert.deepEqual(cli("next", rid).ready, [], "the offline gated ceiling");

    const order = cli("sweep-order", rid);
    assert.equal(order.remaining.length, 1, "only GL was unreachable by the gated pass");
    assert.equal(order.remaining[0].object, "ZFICO_BTC_CSV_GL");
    assert.deepEqual(
      order.remaining[0].dependencies.map((d) => d.status).sort(),
      ["SYNTAX_OK", "SYNTAX_OK"],
      "dep statuses tell the generator which drafts to ground against",
    );

    const glSig = order.remaining[0].sig;
    cli("sweep-mark", rid, glSig, "--result", "drafted");
    assert.deepEqual(cli("sweep-order", rid).remaining, [], "a swept node leaves the sweep queue");

    const ledger = JSON.parse(readFileSync(join(dirs.runs, rid, "sweep.json"), "utf8"));
    assert.equal(ledger.swept[glSig].result, "drafted");
    // C's core principle: the sweep NEVER touches the loop state
    const st = cli("status", rid);
    assert.equal(st.counts.PENDING, 1, "GL is still PENDING in the gated state — the ledger is separate");
    assert.equal(st.complete, false, "a swept draft is not GREEN");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("sweep-mark fails closed on unknown sigs and bogus results; re-mark is idempotent", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = cli("plan", FIXTURE);
    const sig = nodes[0].sig;
    assert.throws(() => cli("sweep-mark", rid, "9".repeat(64), "--result", "drafted"), /unknown|Command failed/i);
    assert.throws(() => cli("sweep-mark", rid, sig, "--result", "shiny"), /result|Command failed/i);
    cli("sweep-mark", rid, sig, "--result", "failed");
    const again = cli("sweep-mark", rid, sig, "--result", "failed"); // idempotent repeat
    assert.equal(again.result, "failed");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("escalation wiring: escalate → escalations (rate-limited) → decide writes the audited register", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = cli("plan", FIXTURE);
    const sig = nodes[0].sig;
    const raised = cli("escalate", rid, "--kind", "OSCILLATION", "--nodes", sig, "--root-signature", "talos-select-in-loop|SKB1");
    assert.match(raised.id, /^esc-[0-9a-f]{12}$/);
    const again = cli("escalate", rid, "--kind", "OSCILLATION", "--nodes", sig); // same (kind, nodes) → idempotent, anti-storm
    assert.equal(again.id, raised.id, "no duplicate escalation for one root cause");
    cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", sig); // different kind → a second escalation

    const list = cli("escalations", rid, "--max", "1");
    assert.equal(list.surfaced.length, 1, "rate-limited");
    assert.equal(list.queued.length, 1, "queued, not dropped");

    const decided = cli("decide", rid, raised.id, "RESEED_GENERATOR", "--by", "j.doe");
    assert.equal(decided.status, "RESOLVED");
    const reg = JSON.parse(readFileSync(join(dirs.state, "escalations.json"), "utf8"));
    const row = reg.escalations.find((e) => e.id === raised.id);
    assert.equal(row.decision, "RESEED_GENERATOR");
    assert.equal(row.resolved_by, "j.doe", "audited row persisted");

    assert.throws(() => cli("decide", rid, raised.id, "JUST_PASS_IT", "--by", "j.doe"), /decision|Command failed/i);
    assert.throws(() => cli("escalate", rid, "--kind", "RETRY_CEILING", "--nodes", sig), /kind|Command failed/i);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("PARK through the CLI enforces sign-off + justification and writes the audit register", () => {
  const dirs = freshDirs();
  const { cli } = mkCli(dirs);
  try {
    const { run_id: rid } = cli("plan", FIXTURE);
    const r1 = cli("next", rid);
    const sig = r1.ready[0].sig;
    cli("dispatch", rid, sig);
    cli("outcome", rid, sig, "BLOCK", "--reason", "NO_RELEASED_SUCCESSOR");
    assert.throws(
      () => cli("outcome", rid, sig, "PARK", "--reason", "NO_RELEASED_SUCCESSOR", "--signed-by", "j.doe"),
      /justif|Command failed/i,
      "no justification → refused at the executable path",
    );
    cli("outcome", rid, sig, "PARK", "--reason", "NO_RELEASED_SUCCESSOR", "--signed-by", "j.doe",
      "--justification", "no released successor", "--successor-probe", "i_journalentrytp");
    const park = JSON.parse(readFileSync(join(dirs.state, "park-register.json"), "utf8"));
    assert.equal(park.parked[0].node_id, sig);
    assert.equal(park.parked[0].signed_by, "j.doe");
    assert.equal(park.parked[0].successor_probe, "I_JOURNALENTRYTP", "probe canonicalised to registry case");
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
