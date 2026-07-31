import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ratifyArch } from "./support/ratify-arch.js";

// /modernise CLI (§6.5) — the deterministic imperative shell over the pure reducer, driven
// by the skill via Bash. REAL code path: subprocess + real fs against a temp state dir with
// the golden ZFICO fixture (no mocks). GREEN is EARNED: outcome GREEN requires a recorded
// green verdict at GATED (the reducer decides, never the orchestrator's prose).

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

const GREEN_CP = {
  activated: true, reconciled: true, atc_p1: 0, atc_p2: 0, unit: { green: true },
  invariants: { intact: true }, auth_coverage: { lost: false }, parity: { verdict: "PASS_STRUCTURAL" },
};
// diff_changed_lines is REQUIRED evidence (F1): the gate fails closed without it
const GREEN_EV = { atc_p1: 0, atc_p2: 0, atc_warns: [], diff_changed_lines: [{ file: "zfico.abap", lines: [1] }], coverage: { pct: 0.55, bite_proven: true } };

function run(args, opts = {}) {
  const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });
  return JSON.parse(out);
}

/**
 * L11: execFileSync's thrown message ("Command failed: <full argv>") matches almost any
 * alternative regex, making `/reason|Command failed/` assertions vacuous. Assert on the
 * CLI's actual stderr so the refusal REASON is what the test verifies.
 */
function throwsWith(fn, re, msg) {
  assert.throws(fn, (e) => re.test(String(e.stderr ?? e.message)), msg);
}

function freshDirs() {
  const base = mkdtempSync(join(tmpdir(), "modernise-cli-"));
  writeFileSync(join(base, "cp.json"), JSON.stringify(GREEN_CP), "utf8");
  writeFileSync(join(base, "ev.json"), JSON.stringify(GREEN_EV), "utf8");
  return { base, state: join(base, "state"), runs: join(base, "runs") };
}

const mkCli = ({ base, state, runs }) => {
  const cli = (...a) => run([...a, "--state-dir", state, "--runs-dir", runs]);
  /**
   * plan + clear the ARCH gate. The golden fixture is entirely `re_architect`, and the reducer refuses to
   * dispatch an unratified arch node (M1), so these CLI/FSM-mechanics tests must enter past gate 2 exactly
   * as a real run does: `ratifyArch` seeds the judge verdict cache, runs the real `arch` verb, and stamps
   * the ratification. No-op for a plan with no arch-gated node.
   */
  const planRatified = (findings = FIXTURE, ...extra) => {
    const planned = cli("plan", findings, ...extra);
    ratifyArch(state, planned.run_id);
    return planned;
  };
  const walk = (rid, sig) => {
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    cli("verdict", rid, sig, "--checkpoint", join(base, "cp.json"), "--evidence", join(base, "ev.json"), "--record");
    cli("outcome", rid, sig, "GREEN");
  };
  return { cli, walk, planRatified };
};

test("plan → next → dispatch → FSM walk → verdict → GREEN runs the golden fixture to complete", () => {
  const dirs = freshDirs();
  const { cli, walk, planRatified } = mkCli(dirs);
  try {
    const planned = planRatified();
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
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const r1 = cli("next", rid);
    cli("dispatch", rid, r1.ready[0].sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, r1.ready[0].sig, s);
    throwsWith(() => cli("outcome", rid, r1.ready[0].sig, "GREEN"), /verdict/i);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("verdict is refused unless the node is at GATED (no out-of-lifecycle baseline moves)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = planRatified();
    const sig = nodes.find((n) => n.object === "ZFICO_BTC_CSV_SCR").sig;
    assert.throws(
      () => cli("verdict", rid, sig, "--checkpoint", join(dirs.base, "cp.json"), "--evidence", join(dirs.base, "ev.json"), "--record"),
      /GATED/i,
    );
    assert.ok(!existsSync(join(dirs.state, "atc-baseline.json")), "no baseline moved");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("a green verdict at GATED records baselines once (--record) and GREEN completes", () => {
  const dirs = freshDirs();
  const { cli, walk, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
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
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const r1 = cli("next", rid);
    cli("dispatch", rid, r1.ready[0].sig);
    const resumed = cli("resume", rid);
    assert.equal(resumed.verified, true);
    assert.equal(resumed.status.counts.GROUNDED, 1);

    const statePath = join(dirs.state, "runs", `${rid}.state.json`);
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    st.plan_hash = "f".repeat(64);
    writeFileSync(statePath, JSON.stringify(st), "utf8");
    throwsWith(() => cli("resume", rid), /plan_hash/i);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("guards: run-id traversal, non-positive team-size, un-ready dispatch, existing run", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    throwsWith(() => planRatified(FIXTURE, "--run-id", "../../evil/pwn"), /run.id/i, "path traversal rejected");
    assert.ok(!existsSync(join(dirs.base, "evil")), "nothing written outside containment");
    throwsWith(() => planRatified(FIXTURE, "--team-size", "0"), /team-size/i);
    throwsWith(() => planRatified(FIXTURE, "--team-size", "abc"), /team-size/i);

    const { run_id: rid, nodes } = planRatified();
    const gl = nodes.find((n) => n.object === "ZFICO_BTC_CSV_GL").sig;
    throwsWith(() => cli("dispatch", rid, gl), /ready/i, "GL's closure is not green");
    throwsWith(() => planRatified(), /exists|resume/i, "re-planning a live run refused");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("offline draft sweep: sweep-order lists PENDING nodes topologically; sweep-mark ledgers OUTSIDE loop state", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
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
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = planRatified();
    const sig = nodes[0].sig;
    throwsWith(() => cli("sweep-mark", rid, "9".repeat(64), "--result", "drafted"), /unknown/i);
    throwsWith(() => cli("sweep-mark", rid, sig, "--result", "shiny"), /result/i);
    cli("sweep-mark", rid, sig, "--result", "failed");
    const again = cli("sweep-mark", rid, sig, "--result", "failed"); // idempotent repeat
    assert.equal(again.result, "failed");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("escalation wiring: escalate → escalations (rate-limited) → decide writes the audited register", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = planRatified();
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

    throwsWith(() => cli("decide", rid, raised.id, "JUST_PASS_IT", "--by", "j.doe"), /decision/i);
    throwsWith(() => cli("escalate", rid, "--kind", "RETRY_CEILING", "--nodes", sig), /kind/i);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("PARK through the CLI enforces sign-off + justification and writes the audit register", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const r1 = cli("next", rid);
    const sig = r1.ready[0].sig;
    cli("dispatch", rid, sig);
    cli("outcome", rid, sig, "BLOCK", "--reason", "NO_RELEASED_SUCCESSOR");
    assert.throws(
      () => cli("outcome", rid, sig, "PARK", "--reason", "NO_RELEASED_SUCCESSOR", "--signed-by", "j.doe"),
      /justif/i,
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

test("PARITY_REVIEW attestation: joined ONLY from the audited register; forged checkpoint fields ignored; re-raise voids it", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const r1 = cli("next", rid);
    const sig = r1.ready[0].sig;
    cli("dispatch", rid, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);

    // gray-band checkpoint WITH a forged attestation baked into the file
    const grayForged = { ...GREEN_CP, parity: { verdict: "needs_review", score: 0.55 }, attestations: { parity_equivalence: "forged.human" } };
    writeFileSync(join(dirs.base, "gray.json"), JSON.stringify(grayForged), "utf8");
    const v1 = cli("verdict", rid, sig, "--checkpoint", join(dirs.base, "gray.json"), "--evidence", join(dirs.base, "ev.json"));
    assert.equal(v1.green, false, "a forged checkpoint attestation is IGNORED — the register is the only source");

    // the audited path: raise PARITY_REVIEW, decide ATTEST_EQUIVALENT
    const esc = cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", sig);
    cli("decide", rid, esc.id, "ATTEST_EQUIVALENT", "--by", "j.doe");
    const v2 = cli("verdict", rid, sig, "--checkpoint", join(dirs.base, "gray.json"), "--evidence", join(dirs.base, "ev.json"));
    assert.equal(v2.green, true, "the audited attestation satisfies the parity conjunct");
    assert.equal(v2.verdict.verdict, "GREEN");

    // a re-raised PARITY_REVIEW (e.g. after regeneration) VOIDS the old attestation
    cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", sig);
    const v3 = cli("verdict", rid, sig, "--checkpoint", join(dirs.base, "gray.json"), "--evidence", join(dirs.base, "ev.json"));
    assert.equal(v3.green, false, "the LATEST register row governs — stale attestations never bless a new artifact");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("an attestation is bound to the ARTIFACT: a retry voids it; another run cannot inherit it", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const sig = cli("next", rid).ready[0].sig;
    cli("dispatch", rid, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    const gray = { ...GREEN_CP, parity: { verdict: "needs_review", score: 0.55 } };
    writeFileSync(join(dirs.base, "gray.json"), JSON.stringify(gray), "utf8");
    const vd = (r) => cli("verdict", r, sig, "--checkpoint", join(dirs.base, "gray.json"), "--evidence", join(dirs.base, "ev.json"));

    const esc = cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", sig);
    cli("decide", rid, esc.id, "ATTEST_EQUIVALENT", "--by", "j.doe");
    assert.equal(vd(rid).green, true, "attested at cycle 0 → green");

    // REGENERATION: the checkpoint machine-BLOCKs → retry → walk back to GATED
    cli("progress", rid, sig, "GENERATED");
    for (const s of ["SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    assert.equal(vd(rid).green, false, "the human never saw THIS artifact — the cycle stamp voids the attestation");

    // ANOTHER RUN (same state dir, same sigs) can never inherit the attestation
    const { run_id: rid2 } = planRatified(FIXTURE, "--run-id", "run2");
    const sig2 = cli("next", rid2).ready[0].sig;
    cli("dispatch", rid2, sig2);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid2, sig2, s);
    assert.equal(vd(rid2).green, false, "run binding: r1's attestation never blesses r2");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("gap-1: plan --bundle wires the Stage-1 dynamic scan — seals land on plan nodes and gate dispatch", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  const BUNDLE = join(HERE, "fixtures", "bundle");
  try {
    const sealed = planRatified(FIXTURE, "--bundle", BUNDLE);
    const rid = sealed.run_id;
    // the SCR source carries CALL FUNCTION <var> → its plan node must be sealed
    const scr = sealed.nodes.find((n) => n.object === "ZFICO_BTC_CSV_SCR");
    assert.ok(scr, "SCR is planned");
    const next = cli("next", rid);
    assert.ok(!next.ready.some((r) => r.sig === scr.sig), "a sealed node never reaches the frontier (L5)");
    assert.throws(
      () => cli("dispatch", rid, scr.sig),
      (e) => /seal|caller|L5/i.test(String(e.stderr ?? e.message)),
      "direct dispatch of the sealed node is refused",
    );
    // without --bundle the same doc plans UNSEALED — and the plan hash records the difference
    const dirs2 = freshDirs();
    const { cli: cli2, planRatified: planRatified2 } = mkCli(dirs2);
    try {
      const plain = planRatified2();
      assert.notEqual(plain.plan_hash, sealed.plan_hash, "the augment is part of the frozen, hashed plan");
      const scr2 = plain.nodes.find((n) => n.object === "ZFICO_BTC_CSV_SCR");
      assert.deepEqual(cli2("next", plain.run_id).ready.map((r) => r.sig), [scr2.sig], "the plain plan schedules SCR first, unsealed");
    } finally {
      rmSync(dirs2.base, { recursive: true, force: true });
    }
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("gap-1: plan --bundle fails loud on a missing dir — never a silent unsealed plan", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    assert.throws(
      () => planRatified(FIXTURE, "--bundle", join(dirs.base, "no-such-bundle")),
      (e) => /bundle/i.test(String(e.stderr ?? e.message)),
    );
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("plan fails LOUD on a findings doc without modernization_plan — never a vacuous complete run (F25)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const doc = JSON.parse(readFileSync(FIXTURE, "utf8"));
    delete doc.modernization_plan; // schema-valid: the ADT-only analyser mode emits exactly this shape
    writeFileSync(join(dirs.base, "no-plan.json"), JSON.stringify(doc), "utf8");
    assert.throws(
      () => cli("plan", join(dirs.base, "no-plan.json")),
      (e) => /modernization_plan/i.test(String(e.stderr ?? e.message)),
      "absent section fails loud and names the producer",
    );
    doc.modernization_plan = { objects: [] };
    writeFileSync(join(dirs.base, "empty-plan.json"), JSON.stringify(doc), "utf8");
    assert.throws(
      () => cli("plan", join(dirs.base, "empty-plan.json")),
      (e) => /nothing to modernise|empty/i.test(String(e.stderr ?? e.message)),
      "a zero-node plan is refused, never complete:true",
    );
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("a re-park after re-entry REPLACES the audit row — the register reflects the LIVE park (F17/F26)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const sig = cli("next", rid).ready[0].sig;
    cli("dispatch", rid, sig);
    cli("outcome", rid, sig, "BLOCK", "--reason", "NO_RELEASED_SUCCESSOR");
    cli("outcome", rid, sig, "PARK", "--reason", "NO_RELEASED_SUCCESSOR",
      "--signed-by", "alice", "--justification", "registry gap v1", "--successor-probe", "i_first");
    cli("progress", rid, sig, "PENDING"); // successor rumoured → re-entry
    cli("dispatch", rid, sig);
    cli("outcome", rid, sig, "BLOCK", "--reason", "NO_RELEASED_SUCCESSOR");
    cli("outcome", rid, sig, "PARK", "--reason", "NO_RELEASED_SUCCESSOR",
      "--signed-by", "bob", "--justification", "successor does not cover cross-client", "--successor-probe", "i_second");
    const reg = JSON.parse(readFileSync(join(dirs.state, "park-register.json"), "utf8"));
    const rows = reg.parked.filter((p) => p.node_id === sig);
    assert.equal(rows.length, 1, "one CURRENT row per node — episode history lives in git + log.jsonl");
    assert.equal(rows[0].signed_by, "bob", "the second park's sign-off is the audited one");
    assert.equal(rows[0].justification, "successor does not cover cross-client");
    assert.equal(rows[0].successor_probe, "I_SECOND", "a future successor re-probe checks the CURRENT probe");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("sweep-order distinguishes drafted from failed deps; sweep-mark is PENDING-only (F16)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    // no gated pass at all: every node is PENDING and sweepable, deps sort first
    const order = cli("sweep-order", rid);
    assert.equal(order.remaining.length, 3);
    const [dep1, dep2, entry] = order.remaining.map((r) => r.sig);
    cli("sweep-mark", rid, dep1, "--result", "failed");
    cli("sweep-mark", rid, dep2, "--result", "drafted");
    const view = cli("sweep-order", rid).remaining.find((r) => r.sig === entry);
    const d1 = view.dependencies.find((d) => d.sig === dep1);
    const d2 = view.dependencies.find((d) => d.sig === dep2);
    assert.equal(d1.swept, false, "a FAILED sweep left no draft to ground against");
    assert.equal(d1.sweep_result, "failed", "…and the generator can see why");
    assert.equal(d2.swept, true);
    assert.equal(d2.sweep_result, "drafted");
    // a gated-pass node is not sweepable — the ledger stays clean of non-PENDING pollution
    const dirs2 = freshDirs();
    const { cli: cli2, planRatified: planRatified2 } = mkCli(dirs2);
    try {
      const { run_id: rid2 } = planRatified2();
      const sig2 = cli2("next", rid2).ready[0].sig;
      cli2("dispatch", rid2, sig2);
      cli2("progress", rid2, sig2, "GENERATED");
      cli2("progress", rid2, sig2, "SYNTAX_OK");
      assert.throws(
        () => cli2("sweep-mark", rid2, sig2, "--result", "drafted"),
        (e) => /PENDING/i.test(String(e.stderr ?? e.message)),
        "a SYNTAX_OK node was reached by the gated pass — not sweep territory",
      );
    } finally {
      rmSync(dirs2.base, { recursive: true, force: true });
    }
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("attestation is bound to the artifact GENERATION: pre-attestation and re-entry regeneration both void (F4)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const sig = cli("next", rid).ready[0].sig;
    const gray = { ...GREEN_CP, parity: { verdict: "needs_review", score: 0.55 } };
    writeFileSync(join(dirs.base, "gray.json"), JSON.stringify(gray), "utf8");
    const vd = (r) => cli("verdict", r, sig, "--checkpoint", join(dirs.base, "gray.json"), "--evidence", join(dirs.base, "ev.json"));

    // defeat 1 (probe C): decide while the node is still PENDING — NO artifact exists yet
    const esc = cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", sig);
    cli("decide", rid, esc.id, "ATTEST_EQUIVALENT", "--by", "j.doe");
    cli("dispatch", rid, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    assert.equal(vd(rid).green, false, "a decision made before ANY artifact existed cannot bless generation 1");

    // control: attesting THIS artifact (same generation) applies
    const esc2 = cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", sig);
    cli("decide", rid, esc2.id, "ATTEST_EQUIVALENT", "--by", "j.doe");
    assert.equal(vd(rid).green, true, "same-generation attestation applies");

    // defeat 2 (probe B): seam-out + re-entry regeneration — the CYCLE counter does not move,
    // the GENERATION does, so the stale attestation must void
    cli("outcome", rid, sig, "NEEDS_MANUAL_SEAM");
    cli("progress", rid, sig, "PENDING");
    cli("dispatch", rid, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    assert.equal(vd(rid).green, false, "re-entry regeneration voids the attestation — the human never saw THIS artifact");
    assert.throws(
      () => cli("outcome", rid, sig, "GREEN"),
      (e) => /verdict/i.test(String(e.stderr ?? e.message)),
      "and the regenerated artifact's GREEN must be re-earned (F3, CLI surface)",
    );
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("verdict evidence missing diff_changed_lines fails CLOSED through the CLI (F1 — no ?? [] erasure)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const sig = cli("next", rid).ready[0].sig;
    cli("dispatch", rid, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    const { diff_changed_lines: _omit, ...evNoDiff } = GREEN_EV;
    writeFileSync(join(dirs.base, "ev-nodiff.json"), JSON.stringify(evNoDiff), "utf8");
    const v = cli("verdict", rid, sig, "--checkpoint", join(dirs.base, "cp.json"), "--evidence", join(dirs.base, "ev-nodiff.json"));
    assert.equal(v.green, false, "absence must propagate to the gate, never read as an empty diff");
    assert.ok(v.reasons.includes("diff-changed-lines-missing"), JSON.stringify(v.reasons));
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("an attestation never survives plan --force — the recreated run cannot inherit it (F4 escape)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const sig = cli("next", rid).ready[0].sig;
    const gray = { ...GREEN_CP, parity: { verdict: "needs_review", score: 0.55 } };
    writeFileSync(join(dirs.base, "gray.json"), JSON.stringify(gray), "utf8");
    const vd = (r) => cli("verdict", r, sig, "--checkpoint", join(dirs.base, "gray.json"), "--evidence", join(dirs.base, "ev.json"));
    cli("dispatch", rid, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    const esc = cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", sig);
    cli("decide", rid, esc.id, "ATTEST_EQUIVALENT", "--by", "j.doe");
    assert.equal(vd(rid).green, true, "attested at this artifact → green");

    // --force discards the run but reuses the SAME plan-hash-derived run id; the register
    // survives in the state dir — the recreated walk re-reaches generation 1
    const { run_id: rid2 } = planRatified(FIXTURE, "--force");
    assert.equal(rid2, rid, "the collision the escape rides on");
    cli("dispatch", rid2, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid2, sig, s);
    assert.equal(vd(rid2).green, false, "the human never saw the recreated run's artifact — the attestation must not leak across --force");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

// D4 (operator-ratified): cycle-gate verbs over a minimal 2-object cycle doc
const CYCLE_DOC = {
  findings: [],
  graph: {
    nodes: [
      { id: "ZA", object: "ZA", kind: "report", namespace: "Z" },
      { id: "ZB", object: "ZB", kind: "report", namespace: "Z" },
    ],
    edges: [
      { source: "ZA", target: "ZB", kind: "calls" },
      { source: "ZB", target: "ZA", kind: "calls" },
    ],
  },
  modernization_plan: {
    objects: [
      { object: "ZA", kind: "report", transformation_count: 1, transformations: [{ rule_id: "r1" }], migration_complexity: 0 },
      { object: "ZB", kind: "report", transformation_count: 1, transformations: [{ rule_id: "r1" }], migration_complexity: 0 },
    ],
  },
};

test("D4: seams proposes cuts for a break_gate super-node; resolve-cycle learns + audits (F22)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    writeFileSync(join(dirs.base, "cycle.json"), JSON.stringify(CYCLE_DOC), "utf8");
    const { run_id: rid, nodes } = planRatified(join(dirs.base, "cycle.json"));
    assert.equal(nodes.length, 1, "the 2-cycle condenses to ONE break_gate super-node");
    const sig = nodes[0].sig;

    const prop = cli("seams", rid, sig, "--findings", join(dirs.base, "cycle.json"), "--budget", "1");
    assert.equal(prop.learned, null, "no prior for a first-seen cycle");
    assert.ok(Array.isArray(prop.seams) && prop.seams.length >= 1, "at least one cut candidate");
    assert.ok(prop.sub_components.every((c) => c.length <= 1), "budget 1 → singleton residuals");

    // the human approves a CUT — learned into seam-memory + audited BREAK_CYCLE decision
    const r1 = cli("resolve-cycle", rid, sig, "--kind", "CUT", "--edge", "ZA,ZB", "--by", "j.doe");
    assert.equal(r1.confidence, 0.6, "first confirmation is a strong prior, not certainty");
    const mem = JSON.parse(readFileSync(join(dirs.state, "seam-memory.json"), "utf8"));
    const entries = Object.values(mem.learned);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].resolution, { kind: "CUT", edge: ["ZA", "ZB"] });
    const reg = JSON.parse(readFileSync(join(dirs.state, "escalations.json"), "utf8"));
    const row = reg.escalations.find((e) => e.kind === "BREAK_CYCLE" && e.status === "RESOLVED");
    assert.equal(row.decision, "CUT");
    assert.equal(row.resolved_by, "j.doe", "audited: the named human, the typed decision");

    // an identical cycle later auto-proposes the prior with RAISED (never certain) confidence
    const r2 = cli("resolve-cycle", rid, sig, "--kind", "CUT", "--edge", "ZA,ZB", "--by", "j.doe");
    assert.equal(r2.confidence, 0.75);
    const prop2 = cli("seams", rid, sig, "--findings", join(dirs.base, "cycle.json"), "--budget", "1");
    assert.equal(prop2.learned.confidence, 0.75, "the learned prior leads the next proposal");

    // guards: free-form kind refused; missing signer refused; non-break_gate node refused
    assert.throws(() => cli("resolve-cycle", rid, sig, "--kind", "JUST_REORDER", "--edge", "ZA,ZB", "--by", "j"),
      (e) => /kind|CUT/i.test(String(e.stderr ?? e.message)));
    assert.throws(() => cli("resolve-cycle", rid, sig, "--kind", "CUT", "--edge", "ZA,ZB"),
      (e) => /by|human|decided/i.test(String(e.stderr ?? e.message)));
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("D1 residual: the temporally-FINAL decision governs across interleaved escalation rows", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = planRatified();
    const sigA = cli("next", rid).ready[0].sig;
    const sigB = nodes.find((n) => n.sig !== sigA).sig;
    cli("dispatch", rid, sigA);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sigA, s);
    const delta = { ...GREEN_CP, invariants: { intact: true, auth_delta: true } };
    writeFileSync(join(dirs.base, "delta.json"), JSON.stringify(delta), "utf8");
    const vd = () => cli("verdict", rid, sigA, "--checkpoint", join(dirs.base, "delta.json"), "--evidence", join(dirs.base, "ev.json"));
    // two OPEN rows for sigA (different node sets, so the anti-storm dedupe allows both)
    const e1 = cli("escalate", rid, "--kind", "AUTH_EQUIVALENCE", "--nodes", sigA);
    const e2 = cli("escalate", rid, "--kind", "AUTH_EQUIVALENCE", "--nodes", `${sigA},${sigB}`);
    cli("decide", rid, e2.id, "ATTEST", "--by", "s.reviewer");
    assert.equal(vd().green, true, "attested via the two-node row");
    cli("decide", rid, e1.id, "REJECT", "--by", "s.reviewer"); // the human's LAST word
    assert.equal(vd().green, false, "a temporally-final REJECT must not be shadowed by raise order");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("D4 residual: resolve-cycle refuses a resolution naming non-members — a typo is never learned", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    writeFileSync(join(dirs.base, "cycle.json"), JSON.stringify(CYCLE_DOC), "utf8");
    const { run_id: rid, nodes } = planRatified(join(dirs.base, "cycle.json"));
    const sig = nodes[0].sig;
    assert.throws(
      () => cli("resolve-cycle", rid, sig, "--kind", "CUT", "--edge", "ZFOO,ZBAR", "--by", "j.doe"),
      (e) => /member/i.test(String(e.stderr ?? e.message)),
      "a typo'd edge must fail loud, never become a 0.6-confidence prior",
    );
    assert.ok(!existsSync(join(dirs.state, "seam-memory.json")), "nothing was learned");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("D4: seams refuses a non-break_gate node — nothing to cut", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = planRatified();
    assert.throws(
      () => cli("seams", rid, nodes[0].sig, "--findings", FIXTURE),
      (e) => /break_gate|nothing to cut/i.test(String(e.stderr ?? e.message)),
    );
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("D1: AUTH_EQUIVALENCE attestation joined from the audited register only — forged fields ignored, regeneration voids (mirrors parity)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const sig = cli("next", rid).ready[0].sig;
    cli("dispatch", rid, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    // checkpoint with a changed auth footprint AND a forged attestation baked in
    const deltaForged = { ...GREEN_CP, invariants: { intact: true, auth_delta: true }, attestations: { auth_equivalence: "forged.human" } };
    writeFileSync(join(dirs.base, "authdelta.json"), JSON.stringify(deltaForged), "utf8");
    const vd = (r) => cli("verdict", r, sig, "--checkpoint", join(dirs.base, "authdelta.json"), "--evidence", join(dirs.base, "ev.json"));
    const v1 = vd(rid);
    assert.equal(v1.green, false, "a forged checkpoint attestation is IGNORED — the register is the only source");
    assert.ok(v1.reasons.includes("auth-delta-unattested"));

    // the audited path: raise AUTH_EQUIVALENCE, the named security reviewer decides ATTEST
    const esc = cli("escalate", rid, "--kind", "AUTH_EQUIVALENCE", "--nodes", sig);
    cli("decide", rid, esc.id, "ATTEST", "--by", "s.reviewer");
    assert.equal(vd(rid).green, true, "the audited attestation satisfies the auth conjunct");

    // regeneration voids it — same generation binding as parity
    cli("progress", rid, sig, "GENERATED");
    for (const s of ["SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    assert.equal(vd(rid).green, false, "the reviewer never saw THIS artifact");

    // REJECT never attests
    const esc2 = cli("escalate", rid, "--kind", "AUTH_EQUIVALENCE", "--nodes", sig);
    cli("decide", rid, esc2.id, "REJECT", "--by", "s.reviewer");
    assert.equal(vd(rid).green, false, "a REJECT decision leaves the node blocked");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("progress refuses terminal outcomes through the CLI — outcome is the only terminal verb (F2)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const sig = cli("next", rid).ready[0].sig;
    cli("dispatch", rid, sig);
    for (const s of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) cli("progress", rid, sig, s);
    for (const terminal of ["GREEN", "BLOCK", "NEEDS_MANUAL_SEAM"]) {
      assert.throws(
        () => cli("progress", rid, sig, terminal),
        (e) => /terminal|applyOutcome/i.test(String(e.stderr ?? e.message)),
        `progress ${terminal} refused with the routing message`,
      );
    }
    const st = cli("status", rid);
    assert.equal(st.counts.GATED, 1, "the node is untouched by the refused calls");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("reprobe re-enters parked nodes whose successor shipped — audited row released, node reschedulable (F18/F26)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
    const sig = cli("next", rid).ready[0].sig;
    cli("dispatch", rid, sig);
    cli("outcome", rid, sig, "BLOCK", "--reason", "NO_RELEASED_SUCCESSOR");
    cli("outcome", rid, sig, "PARK", "--reason", "NO_RELEASED_SUCCESSOR",
      "--signed-by", "j.doe", "--justification", "no successor", "--successor-probe", "i_journalentrytp");
    assert.throws(() => cli("reprobe", rid), (e) => /available/i.test(String(e.stderr ?? e.message)), "offline: the operator must supply the shipped names");
    const miss = cli("reprobe", rid, "--available", "I_OTHERAPI");
    assert.deepEqual(miss.reentered, [], "an unshipped successor re-enters nothing");
    assert.deepEqual(miss.still_parked, [sig]);
    const hit = cli("reprobe", rid, "--available", "i_journalentrytp"); // canonicalised like the park probe
    assert.deepEqual(hit.reentered, [sig]);
    assert.deepEqual(hit.still_parked, []);
    const reg = JSON.parse(readFileSync(join(dirs.state, "park-register.json"), "utf8"));
    assert.deepEqual(reg.parked, [], "the audited row is released WITH the re-entry — file and state never diverge");
    assert.deepEqual(cli("next", rid).ready.map((r) => r.sig), [sig], "the re-entered node schedules again");
    const again = cli("reprobe", rid, "--available", "i_journalentrytp"); // crash-retry is a no-op
    assert.deepEqual(again.reentered, []);
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("packets renders surfaced escalations as GatePackets — kind, cause, typed decisions (F18)", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = planRatified();
    const sig = nodes[0].sig;
    cli("escalate", rid, "--kind", "OSCILLATION", "--nodes", sig, "--root-signature", "talos-select-in-loop|SKB1");
    cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", sig);
    const p = cli("packets", rid);
    assert.equal(p.packets.length, 2);
    for (const pk of p.packets) {
      assert.ok(typeof pk.cause === "string" && pk.cause.length > 0, "one-line cause");
      assert.ok(Array.isArray(pk.decisions) && pk.decisions.length >= 2, "TYPED decision set — options are never invented");
    }
    const osc = p.packets.find((x) => x.kind === "OSCILLATION");
    assert.match(osc.cause, /thrash/i);
    assert.deepEqual(osc.decisions, ["RESEED_GENERATOR", "MANUAL_SEAM", "DEFER"]);
    const limited = cli("packets", rid, "--max", "1");
    assert.equal(limited.packets.length, 1, "rate-limit applies to packets too");
    assert.equal(limited.queued, 1, "the rest queue, never dropped");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("escalate validates sigs against the plan; decide's receipt names the CORRECT resolver after a re-raise", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid, nodes } = planRatified();
    const sig = nodes[0].sig;
    throwsWith(() => cli("escalate", rid, "--kind", "PARITY_REVIEW", "--nodes", "NOT_A_NODE"), /plan|unknown/i);

    const e1 = cli("escalate", rid, "--kind", "OSCILLATION", "--nodes", sig);
    cli("decide", rid, e1.id, "DEFER", "--by", "j.doe");
    cli("escalate", rid, "--kind", "OSCILLATION", "--nodes", sig); // recurs → same id, new OPEN row
    const receipt = cli("decide", rid, e1.id, "RESEED_GENERATOR", "--by", "k.new");
    assert.equal(receipt.resolved_by, "k.new", "the receipt is the row THIS decide resolved, not the first id match");
    assert.equal(receipt.decision, "RESEED_GENERATOR");
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("repeating a mutating command after a half-commit is an idempotent no-op, never a wedge", () => {
  const dirs = freshDirs();
  const { cli, planRatified } = mkCli(dirs);
  try {
    const { run_id: rid } = planRatified();
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
