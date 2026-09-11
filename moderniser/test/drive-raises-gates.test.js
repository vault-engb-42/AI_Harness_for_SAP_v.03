import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ratifyArch } from "./support/ratify-arch.js";

// THE DRIVER'S ESCALATION INTENT NEVER REACHED THE REGISTER.
//
// Found by the surface census (surface-census.test.js): of the eleven kinds in the §3.4 closed taxonomy,
// five had no production path at all. `PARITY_REVIEW` was one of them, and it is the gate that guards the
// parity gray band the design says "offline never auto-passes".
//
// The mechanism was complete on both sides and joined in the middle by nothing. `driveOfflineVerdict`
// computes the escalation and returns it — "Escalations are RETURNED as intent, never raised here — raising
// touches the durable register, which is the CLI's job" (sched/drive.js). The CLI never did that job:
// `cli-drive.js` contained no reference to the register at all. So:
//
//   - the node rests at PROVISIONAL_GATED with a FALSE verdict, correctly awaiting a human (F8);
//   - no row of that kind is ever created, so `escalations`/`packets` show the operator nothing;
//   - `decide` has no id to take a decision against;
//   - `registerAttestation` joins the attestation FROM THE AUDITED REGISTER ONLY (cli-attest.js), so with
//     no row there is nothing to join and the node can never clear.
//
// A permanent deadlock on every gray-band parity node and every auth-footprint move — the same shape as
// F-8.2, where an unplaceable node awaited a ratification against a gate that did not exist.
//
// These tests drive the REAL CLI over REAL artifacts and assert on the durable register, because the defect
// lived precisely in the step between the pure driver (well tested) and the persisted state (well tested).

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "drive-gates-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  const cli = (...a) =>
    JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" }));
  cli.stateDir = state;
  const writeDir = (name, files) => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, src] of Object.entries(files)) writeFileSync(join(dir, f), src, "utf8");
    return dir;
  };
  return { cli, writeDir };
}

function atSyntaxOk(cli) {
  const planned = cli("plan", FIXTURE);
  ratifyArch(cli.stateDir, planned.run_id);
  const sig = cli("drive", planned.run_id).packets[0].sig;
  cli("drive", planned.run_id, "--report", `${sig}=syntax_ok`);
  return { runId: planned.run_id, sig };
}

const GUARDED = `    AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    COMMIT WORK.`;

const CLEAN_CLASS = `CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS m.
ENDCLASS.

CLASS zcl_x IMPLEMENTATION.
  METHOD m.
${GUARDED}
  ENDMETHOD.
ENDCLASS.`;

// Relocating the classic AUTHORITY-CHECK into a DCL role + RAP `authorization master` is what sets
// `auth_delta` — the canonical owed attestation, and the reason every classic-to-managed-RAP node hits.
const RELOCATED_AUTH = {
  "zc_x.dcls.asdcls": `define role zc_x { grant select on zi_x where (c) = aspect pfcg_auth( S_CARRID, ACTVT ); }`,
  "zbp_x.bdef.asbdef": `managed implementation in class zbp_x unique;\ndefine behavior for ZI_X alias X authorization master ( global ) lock master { }`,
};

/** Drive one node to an owed AUTH_EQUIVALENCE attestation and return the run + the verdict output. */
function toOwedAttestation(cli, writeDir) {
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", { "zcl_x.clas.abap": CLEAN_CLASS });
  const after = writeDir("after", RELOCATED_AUTH);
  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.ok(out.verdict.reasons.includes("auth-delta-unattested"), `the fixture must owe an attestation: ${JSON.stringify(out.verdict.reasons)}`);
  assert.equal(out.action, "await_human", "and route to the human");
  return { runId, sig, before, after };
}

const openRows = (cli, runId, kind) =>
  cli("escalations", runId, "--max", "99").surfaced.filter((e) => e.kind === kind && e.status === "OPEN");

test("an owed attestation RAISES its gate into the durable register, not just into stdout", () => {
  const { cli, writeDir } = mkCli();
  const { runId, sig } = toOwedAttestation(cli, writeDir);

  const rows = openRows(cli, runId, "AUTH_EQUIVALENCE");
  assert.equal(rows.length, 1, "the driver's escalation intent must become exactly one audited row");
  assert.deepEqual(rows[0].node_ids, [sig], "naming the node whose attestation is owed");
});

test("the raised gate reaches the operator as a GatePacket with its typed decisions", () => {
  const { cli, writeDir } = mkCli();
  const { runId } = toOwedAttestation(cli, writeDir);

  const packet = cli("packets", runId, "--max", "99").packets.find((p) => p.kind === "AUTH_EQUIVALENCE");
  assert.ok(packet, "a gate the operator cannot see is a gate that does not exist");
  assert.deepEqual(packet.decisions, ["ATTEST", "REJECT"], "with the verbs that can actually clear it");
  assert.ok(packet.plan_fields?.object, "and naming the object, not just its 64-char signature");
});

test("raise -> decide -> re-verdict: the owed attestation can now actually be cleared", () => {
  // The whole point. Before this, `registerAttestation` joined against a register that held no row of the
  // kind, so no sequence of operator actions could ever clear the node — it rested at PROVISIONAL_GATED
  // forever while the run reported await_human against a gate nobody could find.
  const { cli, writeDir } = mkCli();
  const { runId, sig, before, after } = toOwedAttestation(cli, writeDir);

  const [row] = openRows(cli, runId, "AUTH_EQUIVALENCE");
  cli("decide", runId, row.id, "ATTEST", "--by", "sec-reviewer");

  const again = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.ok(
    !again.verdict.reasons.includes("auth-delta-unattested"),
    `the named human's attestation must clear its own reason: ${JSON.stringify(again.verdict.reasons)}`,
  );
});

test("ONE verdict step raises EVERY gate it owes, not just the first", () => {
  // Measured 2026-09-11: this fixture owes BOTH auth-delta-unattested AND
  // parity-not-equivalent:needs_review from a single step. `raiseOwedGates` loops the driver's whole
  // intent list, and a fold that stopped at the first would leave the operator clearing one gate, being
  // told the node is still blocked, and having no second gate to find.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = toOwedAttestation(cli, writeDir);
  for (const kind of ["AUTH_EQUIVALENCE", "PARITY_REVIEW"]) {
    const rows = openRows(cli, runId, kind);
    assert.equal(rows.length, 1, `${kind}: one step owes two gates and must raise both`);
    assert.deepEqual(rows[0].node_ids, [sig]);
  }
});

test("attesting ONE owed gate does not void it when the OTHER is still open", () => {
  // PROBED, not reasoned (2026-09-11). `latestEvent` says the latest EVENT governs and a re-raise voids a
  // prior attestation — so if a later verdict step re-raised the gate a human had just resolved, the
  // attestation would silently evaporate and the node could never clear. It does not: the attested reason
  // is removed from the reason list BEFORE the driver derives its escalation intents, so the resolved kind
  // is never re-raised. This test is that probe, kept.
  const { cli, writeDir } = mkCli();
  const { runId, sig, before, after } = toOwedAttestation(cli, writeDir);
  const [auth] = openRows(cli, runId, "AUTH_EQUIVALENCE");
  cli("decide", runId, auth.id, "ATTEST", "--by", "sec-reviewer");

  // TWICE — a single re-run could pass while the void happens on the step after it.
  cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  const third = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);

  assert.ok(
    !third.verdict.reasons.includes("auth-delta-unattested"),
    `the attestation must survive repeated verdict steps: ${JSON.stringify(third.verdict.reasons)}`,
  );
  assert.equal(openRows(cli, runId, "AUTH_EQUIVALENCE").length, 0, "and its gate must not re-open");
  assert.equal(openRows(cli, runId, "PARITY_REVIEW").length, 1, "while the gate still genuinely owed stays open");
});

test("re-running the verdict step does not storm the register with duplicate gates", () => {
  // The bus dedupes an already-OPEN (kind, node-set), and the lane re-runs `drive --verdict` on every
  // resume. A gate that re-raised per step would also VOID its own prior attestation on every tick
  // (cli-attest.js: the latest EVENT governs), so the node could never clear.
  const { cli, writeDir } = mkCli();
  const { runId, sig, before, after } = toOwedAttestation(cli, writeDir);
  cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.equal(openRows(cli, runId, "AUTH_EQUIVALENCE").length, 1, "one root cause never storms the human");
});

// Statement-packed ABAP trips abaplint's parser crash (`abaplint_engine_error`). No rewrite fixes an engine
// crash, so drive.js routes it to the human via ESCALATABLE — under the kind `UNANALYSABLE_ARTIFACT`, which
// the §3.4 taxonomy did not contain. Probed 2026-09-11: `raiseEscalation` threw "unknown kind ... the §3.4
// taxonomy is closed" and `renderPacket` threw "unknown escalation kind", so the intent could not be raised,
// rendered or decided. The driver emitted a gate the gate machinery refused.
const CLEAN_CDS = `@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Guarded posting item'
define view entity ZI_X as select from sflight
{
  key carrid as Carrid,
  key connid as Connid,
      fldate as Fldate
}`;

const PACKED_CLASS = `CLASS zcl_p DEFINITION PUBLIC FINAL CREATE PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_p IMPLEMENTATION. METHOD m. COMMIT WORK. ENDMETHOD. ENDCLASS.`;
const PACKED_TESTS = `CLASS ltcl_p DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS. PRIVATE SECTION. METHODS f FOR TESTING. ENDCLASS.
CLASS ltcl_p IMPLEMENTATION. METHOD f. cl_abap_unit_assert=>assert_true( abap_true ). ENDMETHOD. ENDCLASS.`;

test("an unanalysable artifact raises a gate the operator can actually see and decide", () => {
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  // A before side carrying NO authorization, deliberately. CLEAN_CLASS has an AUTHORITY-CHECK the packed
  // artifact does not, and `auth-coverage-lost` is NOT attestable — one unattestable reason flips
  // `onlyAttestable` false and the whole node routes to regeneration instead, so the gate under test would
  // never be reached and this test would be asserting the wrong thing.
  const before = writeDir("before", { "zi_x.ddls.asddls": CLEAN_CDS });
  const after = writeDir("after", { "zcl_p.clas.abap": PACKED_CLASS, "zcl_p.clas.testclasses.abap": PACKED_TESTS });

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.ok(
    out.verdict.reasons.some((r) => r.startsWith("final-review-unanalysable:")),
    `the fixture must trip the engine crash: ${JSON.stringify(out.verdict.reasons)}`,
  );

  const rows = openRows(cli, runId, "UNANALYSABLE_ARTIFACT");
  assert.equal(rows.length, 1, "the kind the driver emits must be one the register accepts");
  assert.deepEqual(rows[0].node_ids, [sig]);

  const packet = cli("packets", runId, "--max", "99").packets.find((p) => p.kind === "UNANALYSABLE_ARTIFACT");
  assert.ok(packet, "and the operator must be able to see it");
  assert.deepEqual(packet.decisions, ["ATTEST_REVIEWED", "REJECT"], "with something they can actually decide");
});

test("ATTEST_REVIEWED on the unanalysable gate actually clears the node, end to end", () => {
  // A gate that can be raised and decided but changes nothing would be this defect class all over again —
  // the human puts their name on a deadlock. The attestation joins from the AUDITED register with the same
  // run+epoch+generation binding as parity and auth, so it is bound to the artifact actually read.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", { "zi_x.ddls.asddls": CLEAN_CDS });
  const after = writeDir("after", { "zcl_p.clas.abap": PACKED_CLASS, "zcl_p.clas.testclasses.abap": PACKED_TESTS });
  cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);

  const [row] = openRows(cli, runId, "UNANALYSABLE_ARTIFACT");
  cli("decide", runId, row.id, "ATTEST_REVIEWED", "--by", "sec-reviewer");

  const again = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.ok(
    !again.verdict.reasons.some((r) => r.startsWith("final-review-unanalysable:")),
    `the attestation must clear its own reason: ${JSON.stringify(again.verdict.reasons)}`,
  );
  assert.equal(again.final_review.artifact_reviewed_by, "sec-reviewer", "and name who cleared it");
});
