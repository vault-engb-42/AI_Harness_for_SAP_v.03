import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ESCALATION_KINDS } from "../src/exception/escalation-bus.js";
import { DECISIONS, renderPacket } from "../src/exception/gate-ui.js";
import { ESCALATABLE } from "../src/sched/drive.js";
import { packetContext, SURFACING_CRITICAL_KINDS } from "../src/cli-escalations.js";
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
const SKILL_MD = join(HERE, "..", "..", ".claude", "skills", "modernise", "SKILL.md");

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
// The driver's OWN table is therefore the source of truth for this channel — and it is a real production
// path rather than a claim about one, pinned end-to-end by drive-raises-gates.test.js, which drives the
// real CLI and asserts the row lands in the durable register.
const driverProduced = (kind) => ESCALATABLE.some(([, k]) => k === kind);

// The third and weakest channel: prose. Some gates are raised by the /modernise SKILL through the generic
// `escalate` verb rather than by any code. It counts only when the SKILL names the actual raise command for
// that exact kind — "the operator could type it" is not a production path.
const SKILL_TEXT = readFileSync(SKILL_MD, "utf8");
const skillProduced = (kind) => SKILL_TEXT.includes(`--kind ${kind}`);

const produced = (kind) => codeProduced(kind) || driverProduced(kind) || skillProduced(kind);
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
  // BUILT AND UNWIRED, both flagged by F18 (specs/reviews/branch-review-2026-07-13.md) and still unwired
  // two months later — which is the whole argument for this census existing.
  //
  // `exception/risk-gate.js levelDisposition` scores a wave's green nodes and has zero callers. Wiring it
  // today would raise a gate on EVERY wave rather than on risky ones: it is fail-closed by design (missing
  // evidence is FLAGGED, never assumed clear) and the offline path populates none of touches_ddic /
  // touches_invariant / touches_data_source / touches_money. So the evidence comes first, then the gate.
  RISK_LEVEL_REVIEW: { type: "owed", arc: "wave-boundary risk evidence — levelDisposition needs touches_* populated before it can flag anything but everything" },
  // `exception/oscillation.js isOscillating/clusterOscillations` detect a node flip-flopping across
  // verdicts and have zero callers. The machine ceiling (MAX_PHASE_RETRY_CYCLES) is NOT a substitute — it
  // counts retries within one pass, while oscillation is a cross-verdict signal — but nothing reads a
  // node's verdict history across runs yet, so there is no input to detect on.
  OSCILLATION: { type: "owed", arc: "cross-run verdict history — nothing reads a node's verdict series, so isOscillating has no input" },
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

test("surface census: no gate is MUTE — its packet's content depends on the object it names", () => {
  const context = packetContext(TWO_NODE_PLAN, null);
  const decisionBearing = (p) => JSON.stringify({ cause: p.cause, evidence: p.evidence, plan_fields: p.plan_fields });

  for (const kind of ESCALATION_KINDS) {
    const forNode = (sig) => {
      const e = { id: `esc-${kind}-${sig.slice(0, 4)}`, kind, node_ids: [sig], status: "OPEN", opened_at: "T" };
      return renderPacket(e, context(e));
    };
    const [a, b] = [forNode(A), forNode(B)];
    assert.ok(
      Object.keys(a.plan_fields).length > 0,
      `${kind}: the packet must carry plan fields — a bare signature is not something a human can decide on`,
    );
    assert.notEqual(
      decisionBearing(a), decisionBearing(b),
      `${kind}: two entirely different objects produce the SAME packet, so nothing in it could inform a `
      + "decision about either of them",
    );
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
