import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ESCALATION_KINDS } from "../src/exception/escalation-bus.js";
import { DECISIONS, renderPacket } from "../src/exception/gate-ui.js";
import { ESCALATABLE } from "../src/sched/drive.js";
import { packetContext, SURFACING_CRITICAL_KINDS } from "../src/cli-escalations.js";
import { cmdEscalate, cmdPackets } from "../src/cli-escalations.js";
import { raiseOwedGates } from "../src/cli-drive.js";
import { readEscalations, loadRun } from "../src/cli-io.js";
import { raiseDispositionReviews, raiseDroppedDependencies } from "../src/plan/disposition-gate.js";
import { raiseArchReviews, raiseNoTargetShape } from "../src/plan/arch-gate.js";

// THE SURFACE CENSUS.
//
// One property, stated once: EVERY GATE THE DESIGN SAYS A HUMAN MUST PASS HAS TO BE ABLE TO REACH THEM.
//
// It is the sibling of the decision-mutation census (vocabulary-census.test.js). That one guards FACTS —
// every declared fact must be able to change an outcome. This one guards SURFACES, and the repository has
// shipped the surface failure five separate times in one arc: a correct mechanism, fully built and
// unit-tested, wired to nothing or reachable by nobody. Nothing in the suite asserted on what a human
// actually SEES, so every instance was found by accident while building something else.
//
// Three failure directions, all observed here rather than imagined:
//
//   UNPRODUCED GATE  a kind in the closed taxonomy that no production path ever raises. Its typed decisions
//                    are declared, its cause renders, its packet is perfect — and the row is never created,
//                    so the human it exists to ask is never asked. F-8.2 was exactly this for
//                    NO_TARGET_SHAPE, and F18 of specs/reviews/branch-review-2026-07-13.md flagged the same
//                    shape for four modules, of which two were wired and two silently were not.
//
//   ESCAPED KIND     a kind the machinery EMITS that the closed taxonomy does not contain. The bus refuses
//                    it and the renderer throws, so the node rests on an owed decision that can be neither
//                    raised nor recorded nor cleared: a deadlock with no gate.
//
//   MUTE SURFACE     a packet whose decision-bearing content does not vary with the object it names. It
//                    reaches the human and tells them nothing they could act on — GAP 2b, where every gate
//                    arrived as a 64-char signature and a generic sentence.
//
// WHY A SOURCE SCAN AND NOT ONLY BEHAVIOUR. Exercising all twelve kinds end-to-end would mean driving a run
// into generator thrash, into a parity gray band and into an SCC over budget — corpora that do not exist.
// So production is measured structurally AND the structural measure is itself cross-checked behaviourally,
// by calling the four pure producers and asserting rows really appear. A scan that could pass on a comment
// would be precisely the inert guard this file exists to prevent.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith(".js")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

// A module PRODUCES a kind when it hands that kind to the bus. BOTH halves are required, and each alone is
// a measured false answer:
//   - "imports the bus" alone is not production. cli-escalations.js raises `kind: flags.kind` — the generic
//     operator verb — which would vouch for all twelve kinds at once and make this census vacuous.
//   - "names the kind" alone is not production either. oscillation.js builds `{ kind: "OSCILLATION", ... }`
//     descriptors that nothing raises; counting those would certify the very defect being looked for.
const RAISERS = sources(SRC).filter((f) => /\braiseEscalation\b/.test(f.text) && !f.path.endsWith("escalation-bus.js"));

/** Comments cannot certify a producer. Applied to the CALL text only, so it never has to reason about a
 *  regex literal elsewhere in the file. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/**
 * The kinds handed to the bus by an actual `raiseEscalation(...)` CALL in this source.
 *
 * STATEMENT-scoped, and that is the whole point. This was a WHOLE-FILE substring test and the adversarial
 * pass broke it twice: `oscillation.js` already carries `kind: "OSCILLATION"` in a JSDoc @returns line, so
 * one unused `import { raiseEscalation }` added there certified the kind as produced; a bare comment beside
 * a dynamic raise did the same for RISK_LEVEL_REVIEW. Both left the census green while the gate still had
 * zero callers — the census carrying the exact defect class it exists to catch.
 *
 * Parens are matched by DEPTH, not to the first close paren, because the real call sites nest
 * (`raiseEscalation(readEscalations(io), { kind: "BREAK_CYCLE", ... }, { ts })`). A paren inside a string
 * literal argument would still miscount; none of the call sites has one, and the hermetic tests below pin
 * the shapes that matter rather than trusting that.
 */
function kindsRaisedIn(text) {
  const out = new Set();
  const NEEDLE = "raiseEscalation(";
  for (let i = text.indexOf(NEEDLE); i >= 0; i = text.indexOf(NEEDLE, i + 1)) {
    let depth = 0;
    let j = i + NEEDLE.length - 1;
    for (; j < text.length; j += 1) {
      if (text[j] === "(") depth += 1;
      else if (text[j] === ")") { depth -= 1; if (depth === 0) break; }
    }
    for (const m of stripComments(text.slice(i, j + 1)).matchAll(/kind:\s*"([A-Z_]+)"/g)) out.add(m[1]);
  }
  return out;
}

/**
 * The producer predicate over an ARBITRARY file list. `codeProduced` is defined in terms of it, so the
 * hermetic tests below exercise the predicate the census really uses rather than a helper it might quietly
 * stop calling — which is the same "correct mechanism, not wired" trap this whole file exists to catch, and
 * which the first draft of this fix fell into: the tests called `kindsRaisedIn` directly, so reverting the
 * predicate to the old whole-file substring scan left them green.
 *
 * RESIDUAL LIMIT, stated rather than hidden: a rewrite of `codeProduced` that bypassed this function
 * entirely would still not be caught. The difference between file-scope and statement-scope is only
 * OBSERVABLE on drifted input, and no src file today carries a stray kind literal in a bus-importing file.
 * The hermetic cases below are that drifted input, held one level down.
 */
const producedInFiles = (files, kind) => files.some((f) => kindsRaisedIn(f.text).has(kind));
const codeProduced = (kind) => producedInFiles(RAISERS, kind);

// The second production channel. `driveOfflineVerdict` computes an escalation and returns it as INTENT
// ("raising touches the durable register, which is the CLI's job", sched/drive.js); `cli-drive.js` raises
// whatever it returns, so the kind arrives dynamically and carries no literal for the scan above to see.
// The driver's OWN table is the source of truth for WHICH kinds ride this channel.
//
// THREE THINGS, and it matters which this file proves and which it does not.
//   (1) MEMBERSHIP - the kind is in the table. That is this predicate, and on its own it is not
//       production: the adversarial pass added `if (e.kind === "PARITY_REVIEW") continue;` to
//       `raiseOwedGates` and the census stayed green while the gray-band gate never reached the register.
//   (2) THE RAISE LANDS - measured below, by running `raiseOwedGates` for every entry against a real
//       register. That closes (1).
//   (3) THE CALL SITE IS WIRED - NOT proved here, and the census must not claim it. Commenting out the
//       single `raiseOwedGates(...)` call in `offlineVerdictStep` restores the original GAP 7 defect and
//       leaves every test in this file green. Measured 2026-09-12. The guard for (3) is
//       drive-raises-gates.test.js, which drives the real CLI end to end; under that same drift all EIGHT
//       of its tests fail. Duplicating a multi-minute end-to-end loop here would be divergent duplication
//       for no added coverage - so instead the test below asserts that suite COVERS every entry, which is
//       the one thing nothing checked: today all three happen to be pinned by hand-written tests, and
//       nothing stopped a fourth entry arriving with none.
const driverProduced = (kind) => ESCALATABLE.some(([, k]) => k === kind);

// THERE IS NO PROSE CHANNEL. There was one - a match for the raise command in SKILL.md - and the
// adversarial pass (2026-09-11) took two lines to dismantle the case for it.
//
// It certified exactly ONE kind, AUTH_EQUIVALENCE, which the driver channel already covers, so it carried
// no weight. It could be satisfied by a sentence saying the OPPOSITE, measured: appending "do NOT run
// `escalate --kind OSCILLATION` by hand - no detector feeds it yet" to the SKILL made the census report
// OSCILLATION as produced, and routed into the same exemption-deletion remedy. And it was the only channel
// whose input lived outside moderniser/, so a docs-only edit by someone not touching the moderniser could
// retire a genuine gap.
//
// A channel that certifies nothing new and can be fooled by its own disclaimer is not a weak channel, it
// is a liability. Deleted rather than hardened: there is nothing left for it to do.
const produced = (kind) => codeProduced(kind) || driverProduced(kind);

const inTaxonomy = (kind) => ESCALATION_KINDS.includes(kind);

/** The registered verb set, parsed from cli.js's COMMANDS map — the source of truth the skill contract uses. */
const CLI_VERBS = (() => {
  const text = readFileSync(join(SRC, "cli.js"), "utf8");
  const block = text.match(/const COMMANDS = \{([\s\S]*?)\};/);
  if (!block) throw new Error("surface-census: cli.js must declare a COMMANDS map");
  const verbs = new Set();
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s*"?([a-z][a-z-]*)"?\s*:/);
    if (m) verbs.add(m[1]);
  }
  return verbs;
})();

/**
 * Gates that reach no human BY DESIGN, or not yet. Typed, never free text — every type is checked below, so
 * an entry is an argument this test can audit rather than a rubber stamp. Staleness is enforced too: a kind
 * that gains a producer must lose its entry, or this table rots into noise the way F18's findings did.
 *
 * Ratified by the operator 2026-09-11 after this census measured the four: supersede the two that a live
 * mechanism already covers, and OWE the two that need evidence the pipeline does not yet produce.
 */
const ACKNOWLEDGED = {
  // The park path is fully built and is the mechanism actually used: `outcome <run> <sig> PARK --reason
  // NO_RELEASED_SUCCESSOR --signed-by <name> --justification "..."` writes the audited park-register row,
  // and `reprobe` releases it when the operator reports the successor shipped. This kind's typed decisions
  // are PARK_JUSTIFY / DENY, and PARK_JUSTIFY is precisely what that verb does — so raising it as well
  // would be two mechanisms for one decision, which is how the register and the park register would drift
  // apart. The `superseded_by` type is VERIFIED below: the named verb must be registered in cli.js.
  NO_RELEASED_SUCCESSOR: { type: "superseded_by", verb: "outcome" },
  // The gate the §3.4 taxonomy describes IS implemented — as a fail-closed REFUSAL rather than an
  // escalation. `cli-replan.js assertForcedIfDestructive` throws when any node is in flight ("a re-freeze
  // restarts them from PENDING") or when a changed node would lose a ratified Architecture Contract, and
  // clearing it requires `--force --by <name>`: a NAMED human accepting the loss, which is exactly the
  // sign-off REPLAN_WAVE_MOVE asks for. A refusal is the STRONGER form — an escalation can sit queued
  // while work proceeds, a refusal cannot be bypassed.
  //
  // MEASURED, not reasoned: an earlier draft of this entry claimed the gate was unnecessary because a
  // replan makes a fresh run in which nothing is committed. That is true of per-node PROGRESS
  // (`migrateState` starts from `initRun`) and false as an argument — `run_epoch` and the untouched nodes'
  // `arch_contracts` DO carry forward, so a replan is not a clean slate, and the refusal above is what
  // actually protects the committed work. `sched/plan.js replan()`'s own `moved_committed` computation
  // stays callerless because the hash bind subsumes the diff it performs.
  REPLAN_WAVE_MOVE: { type: "superseded_by", verb: "replan" },
  // OSCILLATION and RISK_LEVEL_REVIEW both had entries here, on the same F18 grounds, and both are GONE.
  // Their absence is the point: each was owed until the INPUT its detector needed existed, and this test is
  // what forced the deletion the moment a producer landed. RISK_LEVEL_REVIEW was the larger of the two -
  // measured 2026-09-13, five of levelDisposition's eight inputs had no producer anywhere, and since it is
  // fail-closed, wiring it before that would have flagged EVERY wave. node/risk-evidence.js is those five.
};

const SIG = (c) => c.repeat(64);
const [A, B] = [SIG("a"), SIG("b")];
const empty = () => ({ escalations: [] });

/**
 * The four plan-time producers, actually CALLED. This is what stops the source scan from passing on a
 * string in a comment: if `codeProduced` says these four are live, a real call must yield a real row.
 */
const BEHAVIOURAL = {
  DISPOSITION_REVIEW: () => raiseDispositionReviews(empty(), { rows: [{ sig: A, autonomy: "prompt", confidence: 0.4 }] }, { ts: "T" }),
  DROPPED_DEPENDENCY: () => raiseDroppedDependencies(empty(), {
    nodes: [
      { id: A, object: "ZGONE", disposition: "retire" },
      { id: B, object: "ZCALLER", disposition: "refactor", dependencies: [A] },
    ],
  }, { ts: "T" }),
  ARCH_REVIEW: () => raiseArchReviews(empty(), { rows: [{ sig: A }] }, { ts: "T" }),
  NO_TARGET_SHAPE: () => raiseNoTargetShape(empty(), [{ sig: A, reason: "no target shape fits" }], { ts: "T" }),
};

test("surface census: every gate in the closed taxonomy has a live production path", () => {
  const unproduced = ESCALATION_KINDS.filter((k) => !produced(k) && !ACKNOWLEDGED[k]);
  assert.deepEqual(
    unproduced, [],
    "these kinds declare typed decisions and render a cause, but NOTHING ever raises a row of them — so the "
    + "human they exist to ask is never asked, and a node waiting on one waits forever. Either wire a "
    + `producer, or add a typed ACKNOWLEDGED entry saying why the gate is unreachable on purpose: ${unproduced}`,
  );
});

test("surface census: the production scan is cross-checked by calling the producers", () => {
  for (const [kind, produce] of Object.entries(BEHAVIOURAL)) {
    assert.ok(codeProduced(kind), `${kind}: the scan must see this producer, or the scan itself is broken`);
    const rows = produce().escalations.filter((e) => e.kind === kind);
    assert.equal(rows.length, 1, `${kind}: calling its producer must yield exactly one row, got ${rows.length}`);
    assert.equal(rows[0].status, "OPEN", `${kind}: a produced gate must be OPEN`);
  }
});

test("surface census: the DRIVER channel is MEASURED - every kind in its table really lands a row", () => {
  // The code channel has had a behavioural cross-check since it was written; this channel had none, and
  // the adversarial pass showed what that costs: a one-line filter in `raiseOwedGates` silently removed a
  // gate from production with the census none the wiser. Real fs, real register, no mocks - one temp state
  // dir per kind, so a row left by one cannot vouch for the next.
  for (const [, kind] of ESCALATABLE) {
    const base = mkdtempSync(join(tmpdir(), "census-driver-"));
    const io = { stateDir: base, runsDir: join(base, "runs") };
    raiseOwedGates(io, "R", { action: "await_human", nodes: [A], escalations: [{ kind, node_ids: [A] }] });
    const rows = readEscalations(io).escalations.filter((e) => e.kind === kind && e.status === "OPEN");
    assert.equal(
      rows.length, 1,
      `${kind}: the driver names it as a reason only a human can clear, but running the raise lands no row, `
      + "so the gate the census reports as produced never reaches the register",
    );
    assert.deepEqual(rows[0].node_ids, [A], `${kind}: the row must name the node the driver blocked on`);
  }
});

test("surface census: every driver kind is PINNED end-to-end by drive-raises-gates.test.js", () => {
  // A COVERAGE check on the end-to-end suite, and deliberately nothing more. It cannot prove the call site
  // is wired - only that suite can, and it does. What it prevents is a new ESCALATABLE entry arriving with
  // no end-to-end pin at all, which is the gap the adversarial pass named: "nothing anywhere asserts that
  // each ESCALATABLE entry HAS one".
  const e2e = readFileSync(join(HERE, "drive-raises-gates.test.js"), "utf8");
  const unpinned = ESCALATABLE.map(([, kind]) => kind).filter((kind) => !e2e.includes(kind));
  assert.deepEqual(
    unpinned, [],
    "these kinds ride the driver channel but no end-to-end test names them, so nothing proves the CLI "
    + `actually raises them from a real run - the defect e13aa2f exists to prevent: ${unpinned}`,
  );
});

test("surface census: every kind the machinery EMITS is inside the closed taxonomy", () => {
  // The bus refuses an unknown kind and gate-ui throws on it, so a kind emitted from outside the taxonomy
  // cannot be raised, cannot be rendered and cannot be decided. The node rests on an owed human decision
  // with no gate in existence to clear it — the F-8.2 deadlock, arriving from the opposite direction.
  const escaped = ESCALATABLE.map(([, kind]) => kind).filter((k) => !inTaxonomy(k));
  assert.deepEqual(
    escaped, [],
    "the driver returns these as escalation intent but the §3.4 taxonomy does not contain them: "
    + "raiseEscalation refuses them, renderPacket throws on them and DECISIONS has no verbs for them, so the "
    + `owed decision can never be recorded and the node can never clear: ${escaped}`,
  );
});

test("surface census: no acknowledgement is stale — a gate that gained a producer must lose its entry", () => {
  const stale = Object.keys(ACKNOWLEDGED).filter((k) => produced(k));
  // TWO BRANCHES, deliberately. This message used to say only "delete their entries", and the adversarial
  // pass showed a false positive in `produced()` then walked the developer into permanently retiring an
  // operator-ratified exemption — with the gate still having zero callers and the suite fully green. A
  // guard that can be talked into destroying a ratified record is worse than no guard.
  assert.deepEqual(
    stale, [],
    `${stale} read as PRODUCED while still carrying an ACKNOWLEDGED entry. Either (a) the gate genuinely `
    + `gained a producer, in which case delete its entry — or (b) the scan matched a mention that raises `
    + `nothing, in which case FIX THE SCAN and keep the entry. Check which before deleting anything: an `
    + `exemption here was ratified by the operator.`,
  );
});

test("surface census: every acknowledgement carries a known, checkable type", () => {
  const KNOWN = new Set(["superseded_by", "owed"]);
  for (const [kind, ack] of Object.entries(ACKNOWLEDGED)) {
    assert.ok(inTaxonomy(kind), `${kind}: acknowledging a kind that is not in the taxonomy at all`);
    assert.ok(KNOWN.has(ack?.type), `${kind}: '${ack?.type}' is not one of [${[...KNOWN]}]`);
    // A `superseded_by` claim is VERIFIED, not trusted: the mechanism said to carry the decision instead
    // must be a registered CLI verb. Two dead mechanisms vouching for each other is how this table rots.
    if (ack.type === "superseded_by") {
      assert.ok(ack.verb, `${kind}: superseded_by must name the verb that takes the decision instead`);
      assert.ok(CLI_VERBS.has(ack.verb), `${kind}: its stand-in verb '${ack.verb}' is not registered in cli.js`);
    }
    if (ack.type === "owed") assert.ok(ack.arc, `${kind}: an 'owed' acknowledgement must name the arc that owes it`);
  }
});

// ---- MUTE SURFACES: what the human receives must depend on which object they are being asked about ----
//
// GAP 2b generalised. `renderPacket` has always accepted evidence and plan_fields, and for months the
// caller passed neither: every gate arrived as a 64-char signature, a one-line cause and a verb list —
// identical for two completely different objects. The point guard for that case lives in cli-disposition
// ("a NO_TARGET_SHAPE packet names the object and carries its evidence"); this is the same predicate over
// EVERY kind, so a gate added tomorrow cannot ship mute.

const planNode = (id, o) => ({
  id, wave: 0, members: [o.object], disposition: "re_architect", finding_families: [], disposition_hints: [], ...o,
});
const TWO_NODE_PLAN = {
  nodes: [
    planNode(A, {
      object: "ZORD_ORDER", object_kind: "class", disposition_rationale: "owns a customer table",
      disposition_confidence: 0.8, modernization_target: "rap_bo_fiori", finding_families: ["clean_core"],
      disposition_hints: ["ui_rearch"], disposition_evidence: { no_successor_refs: [] },
    }),
    planNode(B, {
      object: "ZFICO_BTC_CSV_GL", object_kind: "program", disposition_rationale: "batch file exchange",
      disposition_confidence: 0.4, modernization_target: null, finding_families: ["dynamic"],
      disposition_hints: ["style"],
    }),
  ],
};

test("surface census: the wiring holds at the PRODUCTION surface - `packets` carries context for every kind", () => {
  // EXERCISED, not reconstructed. This test used to compose packetContext and renderPacket itself, and
  // the adversarial pass showed what that misses: changing cmdPackets to `renderPacket(e)` - dropping the
  // context, i.e. restoring GAP 2b on the real surface - left the census fully green. A census that
  // rebuilds the wiring it is meant to check is blind to the exact defect it names as its motivation.
  //
  // One real plan, one subprocess, then the real verbs in-process. Every taxonomy kind is raised on a real
  // plan node through the real `escalate`, so a kind added tomorrow is covered without anyone remembering.
  const base = mkdtempSync(join(tmpdir(), "census-surface-"));
  const io = { stateDir: join(base, "state"), runsDir: join(base, "runs") };
  const planned = JSON.parse(execFileSync(
    process.execPath,
    [join(SRC, "cli.js"), "plan", join(HERE, "fixtures", "analyser-findings.json"), "--state-dir", io.stateDir, "--runs-dir", io.runsDir],
    { encoding: "utf8" },
  ));
  const nodes = loadRun(io, planned.run_id).plan.nodes;
  assert.ok(nodes.length >= 2, "the fixture must offer two distinct objects for the comparison below");
  const [one, two] = [nodes[0].id, nodes[1].id];

  for (const kind of ESCALATION_KINDS) {
    cmdEscalate(io, [planned.run_id], { kind, nodes: one });
    cmdEscalate(io, [planned.run_id], { kind, nodes: two });
  }
  const { packets } = cmdPackets(io, [planned.run_id], { max: 999 });

  const bearing = (p) => JSON.stringify({ evidence: p.evidence, plan_fields: p.plan_fields });
  for (const kind of ESCALATION_KINDS) {
    const mine = packets.filter((p) => p.kind === kind);
    assert.equal(mine.length, 2, `${kind}: raised on two real plan nodes but ${mine.length} reached the window`);
    for (const p of mine) {
      assert.ok(
        p.plan_fields?.object,
        `${kind}: reaches the operator as a bare 64-char signature - the production surface passed no context`,
      );
    }
    assert.notEqual(
      bearing(mine[0]), bearing(mine[1]),
      `${kind}: two entirely different objects produce the SAME packet content, so nothing in it could `
      + "inform a decision about either of them",
    );
  }
});

test("surface census: every kind renders a DISTINCT cause - the human can tell which gate they are at", () => {
  // The genuinely per-kind property, and the one the loop above was mistaken for. A gate added tomorrow
  // that copy-pastes a neighbour's cause renders a packet the operator cannot tell apart from the gate
  // beside it - and `cause` is the ONLY per-kind decision-bearing field renderPacket produces, since
  // evidence and plan_fields come verbatim from the caller.
  const context = packetContext(TWO_NODE_PLAN, null);
  const byCause = new Map();
  for (const kind of ESCALATION_KINDS) {
    const e = { id: `esc-${kind}`, kind, node_ids: [A], status: "OPEN", opened_at: "T" };
    const { cause } = renderPacket(e, context(e));
    assert.ok(cause && cause.length > 0, `${kind}: renders no cause at all`);
    const twin = byCause.get(cause);
    assert.equal(twin, undefined, `${kind} and ${twin} render the SAME cause, so the packets are `
      + `indistinguishable to the human being asked: "${cause}"`);
    byCause.set(cause, kind);
  }
});

// ---- THE SCAN MUST BE STATEMENT-SCOPED, NOT FILE-SCOPED ----
//
// Found by the adversarial pass (2026-09-11) and reproduced twice, independently, by a reviewer and its
// refuter: the producer scan was a WHOLE-FILE substring test, so any file that imported the bus anywhere
// certified any kind it merely MENTIONED. `oscillation.js` already carries `kind: "OSCILLATION"` in a JSDoc
// line, and adding one unused `import { raiseEscalation }` to it made the census report OSCILLATION as
// produced. A bare comment beside a dynamic raise did the same for RISK_LEVEL_REVIEW.
//
// Worse than a false pass: test 4 below reuses the same predicate, so its failure text then instructed the
// developer to DELETE that kind's operator-ratified exemption — and following that instruction left the
// suite fully green with the gate still having zero callers. A guard that can be talked into destroying a
// ratified record is worse than no guard.
//
// The census existed to catch exactly this class in OTHER people's code and shipped with it in its own. The
// fix is to bind the kind literal to an actual `raiseEscalation(...)` CALL. Tested here on synthetic source
// rather than by mutating the repo, so the guard is hermetic and fast.
test("surface census: the producer scan is STATEMENT-scoped - a mention outside a raise call is not a producer", () => {
  const sees = (src, kind) => producedInFiles([{ path: "probe.js", text: src }], kind);
  const IMPORTS = `import { raiseEscalation } from "./escalation-bus.js";
`;

  const real = IMPORTS + `reg = raiseEscalation(reg, { kind: "ARCH_REVIEW", node_ids: [s] }, { ts });`;
  assert.ok(sees(real, "ARCH_REVIEW"), "a real raise must still be seen, or the fix broke the scan");

  // The nested call is why this cannot be a naive "up to the next semicolon" match.
  const nested = IMPORTS + `const r = raiseEscalation(readEscalations(io), { kind: "BREAK_CYCLE", node_ids: [sig] }, { ts });`;
  assert.ok(sees(nested, "BREAK_CYCLE"), "balanced parens, not the first close paren");

  // The real oscillation.js shape: the literal lives in a JSDoc @returns line and nothing raises it.
  const jsdoc = IMPORTS + `/** @returns {Array<{kind: "OSCILLATION", root_signature: string}>} clusters */
function f() {}`;
  assert.ok(!sees(jsdoc, "OSCILLATION"), "a JSDoc mention is not a producer");

  const besideCall = IMPORTS + `// { kind: "RISK_LEVEL_REVIEW" } is deliberately NOT raised here yet
reg = raiseEscalation(reg, { kind: e.kind }, { ts });`;
  assert.ok(!sees(besideCall, "RISK_LEVEL_REVIEW"), "a comment beside a DYNAMIC raise is not a producer");

  const insideCall = IMPORTS + `raiseEscalation(reg, { /* kind: "PARITY_REVIEW" */ kind: e.kind }, { ts });`;
  assert.ok(!sees(insideCall, "PARITY_REVIEW"), "nor a comment INSIDE the call parens");

  // The generic operator verb must stay invisible, or the census is vacuous again.
  const dynamic = IMPORTS + `const next = raiseEscalation(reg, { kind: flags.kind, node_ids }, { ts });`;
  for (const k of ESCALATION_KINDS) assert.ok(!sees(dynamic, k), `a dynamic kind vouches for nothing, not even ${k}`);
});

// ---- A GATE THAT CANNOT WIN THE WINDOW IS A GATE THAT DOES NOT REACH A HUMAN ----
//
// GAP 6 made the surfacing window lead with the gates that actually BLOCK the run, because at the default
// `--max 5` the operator saw five routine prompts while 18 blocking gates sat unseen. Its `criticalKinds`
// was then hard-coded to the two PLAN-time arch gates.
//
// The adversarial pass found the consequence: every DRIVE-time kind — the ones GAP 7 finally made real —
// was excluded, so the gates the driver is stuck on sort LAST, by construction, being the newest rows. The
// refuter correctly downgraded this from "unreachable" to "unprioritised" (queued rows carry their ids, so
// `escalations <run>` still finds them), but the ordering still contradicts the principle GAP 6 established.
//
// Deriving the set from the driver's OWN table rather than a hand-written literal is what stops it drifting
// a third time: add a kind to ESCALATABLE and it is prioritised automatically.
test("surface census: every kind that BLOCKS the driver can win the surfacing window", () => {
  const blocking = ESCALATABLE.map(([, kind]) => kind);
  const missing = blocking.filter((k) => !SURFACING_CRITICAL_KINDS.has(k));
  assert.deepEqual(
    missing, [],
    "the driver returns await_human for these and only a human can clear them, but the surfacing path does "
    + "not rank them as critical — so they sort by recency, and a drive-time gate is always the NEWEST row, "
    + `which puts it last in the default window: ${missing}`,
  );
});

test("surface census: every taxonomy kind still declares typed decisions", () => {
  // The converse of the production census: a gate with a producer but no verbs is equally unanswerable.
  const verbless = ESCALATION_KINDS.filter((k) => !(DECISIONS[k]?.length > 0));
  assert.deepEqual(verbless, [], `these kinds can be raised but offer the human nothing to decide: ${verbless}`);
});
