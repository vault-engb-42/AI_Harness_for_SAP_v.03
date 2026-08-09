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

// R2 + R3 (adversarial pass 2026-08-07; R2 raised independently by two lenses): the offline verdict is
// recorded PER NODE, but nothing scoped its evidence to that node. `--after specs/abap/` is the whole
// generated tree, so every node was graded on every other node's artifacts; and `--before` asked the
// fulfiller for a per-node brownfield directory that no verb, file or convention could produce.
//
// Scoping happens in the ENGINE, for the same reason R1's evidence is computed rather than passed: a caller
// cannot get wrong what it cannot supply. The AFTER side descends into `<after>/<sig>/` when that directory
// exists, so `--after specs/abap/` stays the lane's instruction and becomes correct once TRANSFORM writes
// per node. The BEFORE side is filtered to the frozen node's own `members`.
test("the verdict grades THIS node's artifacts, not its siblings' — <after>/<sig>/ wins", () => {
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", CLEAN_CDS);
  // A per-node tree: this node's dir is clean, a sibling node's dir is filthy.
  const after = writeDir("after", {});
  writeDir(join("after", sig), CLEAN_CDS);
  writeDir(join("after", "other-node-sig"), {
    "zcl_other.clas.abap": klass("", `    LOOP AT lt_k INTO DATA(ls_k).
      SELECT SINGLE carrid FROM sflight INTO @DATA(lv_c) WHERE carrid = @ls_k-carrid.
    ENDLOOP.`),
  });

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.ok(
    !out.verdict.reasons.includes("atc-p1-nonzero"),
    `a sibling node's SELECT-in-LOOP must not condemn this one: ${JSON.stringify(out.verdict.reasons)}`,
  );
  assert.equal(out.verdict.provisional, true, `reasons: ${JSON.stringify(out.verdict.reasons)}`);
});

test("a flat --after still works, so the lane keeps one instruction across both layouts", () => {
  // Descending into `<after>/<sig>/` is conditional on that directory existing. A run whose generator has
  // not adopted the per-node layout must not break — it simply gets the old, wider evidence.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const dir = writeDir("src", CLEAN_CDS);
  const out = cli("drive", runId, "--verdict", sig, "--before", dir, "--after", dir);
  assert.equal(out.verdict.provisional, true, `reasons: ${JSON.stringify(out.verdict.reasons)}`);
});

test("the scope actually applied is reported, so package-wide evidence can never look per-node", () => {
  // The failure mode being replaced was SILENT. Whatever the scope ends up being, the caller is told.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", CLEAN_CDS);
  const after = writeDir("after", {});
  writeDir(join("after", sig), CLEAN_CDS);

  const scoped = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.equal(scoped.scope.after, "node", "a per-node dir was found and used");

  const { cli: c2, writeDir: w2 } = mkCli();
  const r2 = atSyntaxOk(c2);
  const flat = w2("src", CLEAN_CDS);
  const wide = c2("drive", r2.runId, "--verdict", r2.sig, "--before", flat, "--after", flat);
  assert.equal(wide.scope.after, "tree", "no per-node dir — and the output says so rather than implying otherwise");
});

test("the before side is narrowed to the node's own objects, not the whole brownfield package", () => {
  // The other half of R3. abapGit names every file for its object, so the frozen node's `members` select
  // its source without needing the extractor verb that never existed. A package-wide before side is not
  // merely wasteful: it feeds assembleBundle every sibling's AUTHORITY-CHECKs, so the auth-coverage conjunct
  // demands this node re-cover authorization it never had.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const frozen = JSON.parse(readFileSync(join(cli.stateDir, "plan", `${runId}.plan.json`), "utf8"));
  const object = frozen.nodes.find((n) => n.id === sig)?.object;
  assert.ok(object, "the frozen plan names the node's object");

  const before = writeDir("before", {
    [`${object.toLowerCase()}.prog.abap`]: `REPORT ${object.toLowerCase()}.\nWRITE 'mine'.`,
    "zfico_unrelated_sibling.prog.abap": `REPORT zfico_unrelated_sibling.
AUTHORITY-CHECK OBJECT 'S_TABU_DIS' ID 'ACTVT' FIELD '02'.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`,
  });
  const after = writeDir("after", CLEAN_CDS);

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.equal(out.scope.before, "node", "a sibling object's source must not enter this node's evidence");
  assert.ok(
    !out.verdict.reasons.includes("auth-coverage-lost"),
    `the sibling's AUTHORITY-CHECK is not this node's to re-cover: ${JSON.stringify(out.verdict.reasons)}`,
  );
});

test("a bundle that does not follow the naming convention keeps the WIDER before side", () => {
  // The fallback errs closed on purpose: scoping a non-conforming corpus down to zero before-files would
  // read as "authorization vanished" and fabricate a block. Too-wide only makes the conjuncts stricter.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", { "totally_unrelated_name.prog.abap": "REPORT x.\nWRITE 'y'." });
  const after = writeDir("after", CLEAN_CDS);
  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.equal(out.scope.before, "tree", "no member matched — keep everything rather than scope to nothing");
});

// Statement-packed ABAP is what trips abaplint's crash (`abaplint_engine_error`) — it throws on this shape
// while parsing outright garbage fine. Probed 2026-08-09: this pair yields the engine error and NOTHING
// else, so the unanalysable reason stands alone.
const PACKED_CLASS = `CLASS zcl_p DEFINITION PUBLIC FINAL CREATE PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_p IMPLEMENTATION. METHOD m. COMMIT WORK. ENDMETHOD. ENDCLASS.`;
const PACKED_TESTS = `CLASS ltcl_p DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS. PRIVATE SECTION. METHODS f FOR TESTING. ENDCLASS.
CLASS ltcl_p IMPLEMENTATION. METHOD f. cl_abap_unit_assert=>assert_true( abap_true ). ENDMETHOD. ENDCLASS.`;

test("an unanalysable artifact escalates to the human instead of burning three regenerations", () => {
  // R5. The unanalysable guard was right to block but wrong about HOW: no rewrite fixes an abaplint crash,
  // so routing it through the cycle-capped retry loop spent the whole budget before quarantining. drive.js
  // already has the category for this — ESCALATABLE, "reasons a human, not a regeneration, can clear" —
  // and auth-delta-unattested has used it since gap-2b. Statement-packed ABAP is what trips the crash
  // (abaplint throws on it while parsing outright garbage fine), so this fixture is deliberately compressed.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", CLEAN_CDS);
  // Its OWN test class too: without one the artifact also carries talos-missing-test-class (priority-2),
  // which regeneration genuinely can fix — so the node would correctly route to `generate` and this test
  // would be asserting the wrong thing. The engine error must be the ONLY blocking reason.
  const after = writeDir("after", { "zcl_p.clas.abap": PACKED_CLASS, "zcl_p.clas.testclasses.abap": PACKED_TESTS });

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.equal(out.verdict.provisional, false, "an unanalysed artifact still cannot pass");
  assert.ok(
    out.verdict.reasons.some((r) => r.startsWith("final-review-unanalysable:")),
    `reasons: ${JSON.stringify(out.verdict.reasons)}`,
  );
  assert.equal(out.action, "await_human", "the human is the only one who can clear an engine crash");
  assert.ok(
    out.escalations?.some((e) => e.kind === "UNANALYSABLE_ARTIFACT"),
    `escalations: ${JSON.stringify(out.escalations)}`,
  );
  assert.equal(cli("status", runId).counts.PROVISIONAL_GATED, 1, "and it rests there, retry budget untouched");
});

test("a real defect still outranks an unanalysable sibling artifact — fix first, then look", () => {
  // The precedence drive.js:169-170 already sets for attestations: a defect the generator CAN fix routes to
  // regeneration even when an unclearable reason is also present. Otherwise one crashed file would park a
  // node that has a genuine, fixable defect sitting next to it.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", CLEAN_CDS);
  const after = writeDir("after", {
    "zcl_p.clas.abap": PACKED_CLASS,
    "zcl_p.clas.testclasses.abap": PACKED_TESTS,
    "zcl_fixable.clas.abap": klass("", GUARDED), // not FINAL → talos-cloud-005, triaged `fix`
  });

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.equal(out.action, "generate", "the fixable defect wins the routing");
  assert.equal(out.packets[0].retry, true);
});

test("the document bucket is RECORDED durably, not just returned on stdout", () => {
  // R4. BUILD_PLAN C1 asks for "a recorded suppression" for the idiom/advisory cases. Counts alone are not
  // a record: they say three things were surfaced without saying what, so nothing downstream — the proof
  // bundle, the gate, a later audit — can name them. The run log is the durable channel already in use.
  const { cli, writeDir } = mkCli();
  const { runId, sig } = atSyntaxOk(cli);
  const before = writeDir("before", CLEAN_CDS);
  // EML IN LOCAL MODE → talos-*-eml-local-mode, triaged `document`.
  const after = writeDir("after", {
    "zbp_e.clas.abap": `CLASS zbp_e DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS m.
ENDCLASS.

CLASS zbp_e IMPLEMENTATION.
  METHOD m.
    MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY X UPDATE FIELDS ( f ) WITH lt_x FAILED DATA(ls_f).
  ENDMETHOD.
ENDCLASS.`,
    "zbp_e.clas.testclasses.abap": PACKED_TESTS,
  });

  const out = cli("drive", runId, "--verdict", sig, "--before", before, "--after", after);
  assert.ok(out.final_review.counts.document > 0, `expected a documented finding: ${JSON.stringify(out.final_review.counts)}`);

  const entry = readFileSync(join(cli.runsDir, runId, "log.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.event === "drive-offline-verdict").pop();
  assert.ok(Array.isArray(entry.documented), "the log must carry WHAT was documented, not only how many");
  assert.ok(entry.documented.length > 0);
  for (const d of entry.documented) {
    assert.ok(d.rule_id, "each recorded row names its rule");
    assert.ok("file" in d, "and where it was found");
  }
});
