import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ratifyArch } from "./support/ratify-arch.js";

// Arc C / C1 — the final-output self-review, end to end through the real CLI: real subprocess, real fs,
// real `analyzePackage` over real generated artifacts. No mocks.
//
// C1 is ALWAYS-ON, never a flag. An opt-in review the lane forgets to pass would fail OPEN — a defect in a
// generated artifact would sail through the gate unmentioned. That is the inverse of the `--findings`
// fail-closed precedent (F5, cli-drive.js:45-46), where ABSENCE deliberately produces a block rather than a
// fabricated clean pass.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

// Written out multi-line on purpose. abaplint CRASHES on statement-packed one-liners (emitting
// `abaplint_engine_error`, which C1 treats as a block), so a compressed fixture would silently skip abaplint
// entirely and these tests would assert against harness-pack findings alone. Probed 2026-08-07: this shape
// analyses cleanly and yields three genuine advisory findings.
const klass = (decl, body) => `CLASS zcl_x DEFINITION PUBLIC ${decl} CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS m.
ENDCLASS.

CLASS zcl_x IMPLEMENTATION.
  METHOD m.
${body}
  ENDMETHOD.
ENDCLASS.`;

/** Clean Core shaped: FINAL, so the review's `fix` rules stay silent unless a test deliberately adds one. */
const cleanClass = (body) => klass("FINAL", body);

const GUARDED = `    AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    COMMIT WORK.`;

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "final-review-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  const cli = (...a) =>
    JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" }));
  cli.stateDir = state;
  cli.runsDir = runs;
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

function atSyntaxOk(cli) {
  const planned = cli("plan", FIXTURE);
  ratifyArch(cli.stateDir, planned.run_id);
  const sig = cli("drive", planned.run_id).packets[0].sig;
  cli("drive", planned.run_id, "--report", `${sig}=syntax_ok`);
  return { runId: planned.run_id, sig };
}

test("a fixable defect in the generated artifact blocks the verdict and drives a retry carrying it", () => {
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  // NOT final, NOT abstract → talos-cloud-005-class-final-abstract, which C2 triages `fix`.
  const after = writeDir("after", { "zcl_x.clas.abap": klass("", GUARDED) });
  const before = writeDir("before", { "zcl_x.clas.abap": cleanClass(GUARDED) });
  const findings = writeJson("f.json", { findings: [] });

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after, "--findings", findings);
  assert.equal(out.verdict.provisional, false, `reasons: ${out.verdict.reasons}`);
  assert.ok(
    out.verdict.reasons.some((r) => r.startsWith("final-review-fix:talos-cloud-005-class-final-abstract")),
    `reasons: ${JSON.stringify(out.verdict.reasons)}`,
  );
  assert.equal(out.action, "generate");
  assert.equal(out.packets[0].retry, true, "regenerate-with-findings, not a fresh dispatch");
  assert.ok(
    out.packets[0].findings.some((f) => f.startsWith("final-review-fix:")),
    "the defect reaches the generator as repair context",
  );
});

// R1: passing provisionally now requires a genuinely clean artifact — zero priority-1 AND priority-2 (P6),
// counted off the artifact itself rather than off a supplied document. A CDS view entity with its auth
// annotation and label is clean; a hand-written class is not (description_empty + talos-missing-test-class,
// both priority-2, both real). Using the class here would have tested nothing but its own residuals.
const CLEAN_CDS = {
  "zi_x.ddls.asddls": `@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Guarded posting item'
define view entity ZI_X as select from sflight
{
  key carrid as Carrid,
  key connid as Connid,
      fldate as Fldate
}`,
};

test("a clean generated artifact passes — the review does not manufacture a block", () => {
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const dir = writeDir("src", CLEAN_CDS);
  const out = cli("drive", runId, "--verdict", sig, "--before", dir, "--after", dir);
  assert.equal(out.verdict.provisional, true, `reasons: ${JSON.stringify(out.verdict.reasons)}`);
  assert.equal(out.final_review.counts.fix, 0);
});

test("the review reports every action bucket, so an advisory finding is visible rather than absent", () => {
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const dir = writeDir("src", CLEAN_CDS);
  const out = cli("drive", runId, "--verdict", sig, "--before", dir, "--after", dir);
  assert.deepEqual(Object.keys(out.final_review).sort(), ["counts", "document", "fix", "recommend"]);
  for (const k of ["fix", "document", "recommend"]) {
    assert.equal(typeof out.final_review.counts[k], "number", k);
    assert.ok(Array.isArray(out.final_review[k]), k);
  }
  // The advisory findings this CDS does carry are priority-3/info — real analyser output, not a defect.
  // They must surface in `recommend` AND leave the verdict provisional: that is the whole fix/advisory split.
  assert.ok(out.final_review.counts.recommend > 0, "the recommend bucket is reachable from real analyser output");
  assert.equal(out.verdict.provisional, true, "and an advisory never blocks");
});

test("an owed attestation still routes to the human when the artifact also carries advisory findings", () => {
  // THE regression guard for the whole seam. `auth-delta-unattested` is only routed to `await_human` while
  // EVERY reason is attestable (sched/drive.js:187). Advisory review findings must therefore never enter
  // the reason list — if they did, this node would be pushed into the cycle-capped regenerate loop and
  // every classic→managed-RAP node would eventually land a false ceiling BLOCK.
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", { "zcl_x.clas.abap": cleanClass(GUARDED) });
  const after = writeDir("after", {
    "zc_x.dcls.asdcls": `define role zc_x { grant select on zi_x where (c) = aspect pfcg_auth( S_CARRID, ACTVT ); }`,
    "zbp_x.bdef.asbdef": `managed implementation in class zbp_x unique;\ndefine behavior for ZI_X alias X authorization master ( global ) lock master { }`,
  });
  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after, "--findings", writeJson("f.json", { findings: [] }));

  assert.ok(out.verdict.reasons.includes("auth-delta-unattested"), `reasons: ${JSON.stringify(out.verdict.reasons)}`);
  assert.ok(
    !out.verdict.reasons.some((r) => r.startsWith("final-review-fix:")),
    `no review reason may join an attestable-only list: ${JSON.stringify(out.verdict.reasons)}`,
  );
  assert.equal(out.action, "await_human", "it escalates to the human who can clear it");
  assert.equal(cli("status", runId).counts.PROVISIONAL_GATED, 1, "and rests there, retry budget untouched");
});

test("the review's counts are recorded in the run log, not only returned", () => {
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const dir = writeDir("src", { "zcl_x.clas.abap": cleanClass(GUARDED) });
  cli("drive", runId, "--verdict", sig, "--before", dir, "--after", dir, "--findings", writeJson("f.json", { findings: [] }));
  const entry = readFileSync(join(cli.runsDir, runId, "log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === "drive-offline-verdict")
    .pop();
  assert.ok(entry, "the verdict step logs");
  assert.ok(entry.final_review, "with the review counts attached — the durable record of what was surfaced");
  for (const k of ["fix", "document", "recommend"]) assert.equal(typeof entry.final_review[k], "number", k);
});

// R1 (adversarial pass 2026-08-07, CONFIRMED with an end-to-end reproduction): the verdict step was handed
// the BROWNFIELD findings doc as the after-side findings, so atc_p1/atc_p2 counted the PRE-modernisation
// source's defects. Every node — however clean its generated output — blocked on atc-p1-nonzero /
// atc-p2-nonzero, regenerated three times against repair context describing code it had already replaced,
// and quarantined at OFFLINE_VERDICT_CEILING.
//
// offline-checkpoint.js:22-26 states the contract outright: "The caller passes the AFTER-side findings —
// the generated artifact is what is being judged." The verdict step now computes that document itself, from
// the same analyzePackage run C1 already performs, so the caller cannot get it wrong.
test("the verdict judges the GENERATED artifact, never the brownfield source it replaced", () => {
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const dir = writeDir("src", { "zcl_x.clas.abap": cleanClass(GUARDED) });
  // A brownfield doc dense with defects — exactly what specs/brownfield/analyser-findings.json looks like.
  const brownfield = writeJson("brownfield.json", {
    findings: [
      ...Array.from({ length: 23 }, (_, i) => ({ severity: "priority-1", rule_id: "talos-select-in-loop", file: `legacy_${i}.prog.abap`, line: i + 1 })),
      ...Array.from({ length: 202 }, (_, i) => ({ severity: "priority-2", rule_id: "7bit_ascii", file: `legacy_${i}.prog.abap`, line: i + 1 })),
    ],
  });

  const out = cli("drive", runId, "--verdict", sig, "--before", dir, "--after", dir, "--findings", brownfield);
  assert.ok(
    !out.verdict.reasons.includes("atc-p1-nonzero"),
    `the brownfield source's 23 priority-1 findings must not condemn the generated artifact: ${JSON.stringify(out.verdict.reasons)}`,
  );
});

test("a priority-1 defect in the GENERATED artifact does block — the counts are real, not disabled", () => {
  // The mirror of the test above: proving the fix did not simply stop counting. A generated artifact
  // carrying its own priority-1 finding must still fail (P6 — priority-1 and priority-2 zero before done).
  const { cli, writeDir, writeJson } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  // SELECT inside a LOOP → talos-select-in-loop, priority-1, in the artifact itself.
  const after = writeDir("after", {
    "zcl_x.clas.abap": cleanClass(`    LOOP AT lt_keys INTO DATA(ls_key).
      SELECT SINGLE carrid FROM sflight INTO @DATA(lv_c) WHERE carrid = @ls_key-carrid.
    ENDLOOP.`),
  });
  const before = writeDir("before", { "zcl_x.clas.abap": cleanClass(GUARDED) });
  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after, "--findings", writeJson("f.json", { findings: [] }));
  assert.equal(out.verdict.provisional, false, `reasons: ${JSON.stringify(out.verdict.reasons)}`);
  assert.ok(out.verdict.reasons.includes("atc-p1-nonzero"), `reasons: ${JSON.stringify(out.verdict.reasons)}`);
});
