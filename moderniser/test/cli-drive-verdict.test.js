import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// gap-2b B6.5 F12 — the offline verdict arc had NO EXECUTABLE ENTRY POINT. `cli-drive.js` imported
// only `driveDecision` and `driveReport`; nothing in moderniser/src ever called
// `renderOfflineNodeVerdict` or `driveOfflineVerdict`, so B4+B5+B6 were unreachable from the CLI
// and the abap_fico offline E2E could not run at all.
//
// `drive <run_id> --verdict <sig> --before <dir> --after <dir> [--findings <path>]` closes it.
// Real subprocess, real fs, real artifacts on disk — no mocks.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

const clazz = (body) => `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_x IMPLEMENTATION. METHOD m.
${body}
ENDMETHOD. ENDCLASS.`;

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "drive-verdict-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  const cli = (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" }));
  const writeDir = (name, files) => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, src] of Object.entries(files)) writeFileSync(join(dir, f), src, "utf8");
    return dir;
  };
  const writeJson = (name, doc) => {
    const p = join(base, name);
    writeFileSync(p, JSON.stringify(doc), "utf8");
    return p;
  };
  return { cli, writeDir, writeJson };
}

/** Drive a freshly planned run's first node to SYNTAX_OK — the offline verdict's entry state. */
function atSyntaxOk(cli) {
  const planned = cli("plan", FIXTURE);
  const sig = cli("drive", planned.run_id).packets[0].sig;
  cli("drive", planned.run_id, "--report", `${sig}=syntax_ok`);
  return { runId: planned.run_id, sig };
}

test("drive --verdict runs the whole offline arc and rests the node PROVISIONAL_GATED", () => {
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const src = { "zcl_x.clas.abap": clazz(`  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  COMMIT WORK.`) };
  const before = writeDir("before", src);
  const after = writeDir("after", src);
  const findings = writeJson("findings.json", { findings: [] });

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after, "--findings", findings);
  assert.equal(out.verdict.provisional, true, `reasons: ${out.verdict.reasons}`);
  assert.equal(cli("status", runId).counts.PROVISIONAL_GATED, 1);
  assert.equal(out.action, "generate", "the frontier moves on to the next node");
});

test("drive --verdict BLOCKS and regenerates when the artifact carries a priority-1 finding", () => {
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const src = { "zcl_x.clas.abap": clazz("  COMMIT WORK.") };
  const dir = writeDir("src", src);
  const findings = writeJson("f.json", { findings: [{ severity: "priority-1", file: "zcl_x.clas.abap", line: 3 }] });

  const out = cli("drive", runId, "--verdict", sig, "--before", dir, "--after", dir, "--findings", findings);
  assert.equal(out.verdict.provisional, false);
  assert.ok(out.verdict.reasons.includes("atc-p1-nonzero"), `reasons: ${out.verdict.reasons}`);
  assert.equal(out.action, "generate");
  assert.equal(out.packets[0].retry, true, "regenerate-with-findings, not a fresh dispatch");
});

test("drive --verdict escalates an owed attestation to the human instead of burning the budget", () => {
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", { "zcl_x.clas.abap": clazz(`  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  COMMIT WORK.`) });
  // Auth RELOCATED to a DCL grant on the same object — no coverage loss, but the footprint moved.
  const after = writeDir("after", {
    "zc_x.dcls.asdcls": `define role zc_x { grant select on zi_x where (c) = aspect pfcg_auth( S_CARRID, ACTVT ); }`,
    "zbp_x.bdef.asbdef": `managed implementation in class zbp_x unique;\ndefine behavior for ZI_X alias X authorization master ( global ) lock master { }`,
  });
  const findings = writeJson("f.json", { findings: [] });

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after, "--findings", findings);
  assert.equal(out.verdict.provisional, false);
  assert.ok(out.verdict.reasons.includes("auth-delta-unattested"), `reasons: ${out.verdict.reasons}`);
  assert.equal(out.action, "await_human");
  assert.ok(out.escalations.some((e) => e.kind === "AUTH_EQUIVALENCE"), `escalations: ${JSON.stringify(out.escalations)}`);
  assert.equal(cli("status", runId).counts.PROVISIONAL_GATED, 1, "it rests awaiting the human, budget untouched");
});

test("drive --verdict fails CLOSED when the findings document is omitted (F5)", () => {
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const dir = writeDir("src", { "zcl_x.clas.abap": clazz("  COMMIT WORK.") });
  const out = cli("drive", runId, "--verdict", sig, "--before", dir, "--after", dir);
  assert.equal(out.verdict.provisional, false);
  assert.ok(out.verdict.reasons.includes("atc-p1-nonzero"), `reasons: ${out.verdict.reasons}`);
});

test("drive --verdict requires --before and --after, and rejects an unknown node", () => {
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const dir = writeDir("src", { "zcl_x.clas.abap": clazz("  COMMIT WORK.") });
  assert.throws(() => cli("drive", runId, "--verdict", sig, "--after", dir), /--before/);
  assert.throws(() => cli("drive", runId, "--verdict", sig, "--before", dir), /--after/);
  assert.throws(() => cli("drive", runId, "--verdict", "NOPE", "--before", dir, "--after", dir), /unknown node/);
});

test("the loader admits .asdcls — without it engine 2 never sees a DCL and auth reads as VANISHED", () => {
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("b", { "zcl_x.clas.abap": clazz(`  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  COMMIT WORK.`) });
  const after = writeDir("a", {
    "zc_x.dcls.asdcls": `define role zc_x { grant select on zi_x where (c) = aspect pfcg_auth( S_CARRID, ACTVT ); }`,
    "zbp_x.bdef.asbdef": `managed implementation in class zbp_x unique;\ndefine behavior for ZI_X alias X authorization master ( global ) lock master { }`,
  });
  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after, "--findings", writeJson("f.json", { findings: [] }));
  assert.ok(!out.verdict.reasons.includes("auth-coverage-lost"), `the DCL COVERS S_CARRID — reasons: ${out.verdict.reasons}`);
  assert.ok(!out.verdict.reasons.some((r) => r.includes("auth_vanished")), `reasons: ${out.verdict.reasons}`);
});
