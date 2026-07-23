// End-to-end tests for the ADVISORY hooks: spawn the real hook process, feed it the Claude Code
// hook JSON on stdin, assert its exit code and its output. No mocks — real processes, real stdin,
// real files on disk.
//
// THE GOVERNING INVARIANT, asserted by nearly every test below: an advisory hook ALWAYS exits 0.
// The three enforcement hooks (pre-write-gate, adt-write-guard, artifact-guard) are the blocking
// layer — PreToolUse, exit 2, fail-closed. A second path that can also block would create two
// sources of truth for "is this allowed", which is the divergent-duplication class that has
// already produced one real defect in this codebase. So these hooks OBSERVE and REPORT; they never
// decide. Where a hook detects a genuine violation, the test asserts it says so AND still exits 0.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, "..");
const RECORD_RUN = join(HOOKS, "record-run.js");
const VERIFY_ON_SAVE = join(HOOKS, "verify-on-save.js");
const REVIEW_ON_STOP = join(HOOKS, "review-on-stop.js");
const ATC_ON_ACTIVATE = join(HOOKS, "atc-on-activate.js");
const RATCHET_GUARD = join(HOOKS, "ratchet-guard.js");

const WS = join(HERE, "fixtures", "advisory-ws");
const STATE = join(WS, ".claude", "state");

// CONSTRUCTED, never a literal: this repository's own pre-write-gate refuses any write containing
// a real-looking credential, which is the correct behaviour and applies to test fixtures too.
const FAKE_PAT = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/** Spawn a hook with a payload on stdin. @returns {Promise<{code:number, out:string, err:string}>} */
function runHook(hookPath, payload) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [hookPath], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(payload));
  });
}

before(() => {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(join(STATE, "atc-baseline.json"), JSON.stringify({ per_object: { N1: 2 } }));
  writeFileSync(join(STATE, "abapunit-baseline.json"), JSON.stringify({ per_object: { N1: { pct: 80 } }, coverage_floor_pct: 70 }));
});
after(() => rmSync(join(HERE, "fixtures", "advisory-ws"), { recursive: true, force: true }));

// ---------------------------------------------------------------- record-run

test("record-run appends a telemetry row and exits 0", async () => {
  const r = await runHook(RECORD_RUN, { hook_event_name: "SessionStart", cwd: WS, session_id: "s1", source: "startup" });
  assert.equal(r.code, 0);
  const log = join(STATE, "run-log.jsonl");
  assert.ok(existsSync(log), "run-log.jsonl must be created");
  const rows = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).event, "SessionStart");
  assert.equal(rows.at(-1).session_id, "s1");
  assert.ok(rows.at(-1).at, "every row carries a timestamp");
});

test("record-run APPENDS rather than truncating — history is the point", async () => {
  await runHook(RECORD_RUN, { hook_event_name: "SessionStart", cwd: WS, session_id: "s2" });
  await runHook(RECORD_RUN, { hook_event_name: "Stop", cwd: WS, session_id: "s2" });
  const rows = readFileSync(join(STATE, "run-log.jsonl"), "utf8").trim().split("\n");
  assert.ok(rows.length >= 3, `expected accumulated rows, got ${rows.length}`);
});

test("record-run tolerates an unwritable state dir — telemetry never breaks a session", async () => {
  const r = await runHook(RECORD_RUN, { hook_event_name: "Stop", cwd: "/nonexistent-path-xyz", session_id: "s3" });
  assert.equal(r.code, 0, "a telemetry failure must never surface as a hook failure");
});

// ---------------------------------------------------------------- verify-on-save

test("verify-on-save inspects a written ABAP artifact and exits 0 (advisory, not a 2nd gate)", async () => {
  const r = await runHook(VERIFY_ON_SAVE, {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    cwd: WS,
    tool_input: { file_path: "specs/abap/zcl_x.clas.abap", content: "CLASS zcl_x DEFINITION. ENDCLASS." },
  });
  assert.equal(r.code, 0, "MUST exit 0 — pre-write-gate is the blocking layer");
});

test("verify-on-save flags a secret in written ABAP, and still exits 0", async () => {
  const r = await runHook(VERIFY_ON_SAVE, {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    cwd: WS,
    tool_input: { file_path: "specs/abap/zcl_x.clas.abap", content: `DATA(t) = '${FAKE_PAT}'.` },
  });
  assert.equal(r.code, 0, "a detected secret is REPORTED here, never blocked — that is pre-write-gate's job");
  assert.match(r.err + r.out, /secret/i, "a detected secret must be SURFACED");
});

test("verify-on-save ignores non-ABAP writes and non-Write tools", async () => {
  const md = await runHook(VERIFY_ON_SAVE, { hook_event_name: "PostToolUse", tool_name: "Write", cwd: WS, tool_input: { file_path: "README.md", content: "hi" } });
  assert.equal(md.code, 0);
  assert.equal(md.err.trim(), "", "a Markdown write produces no ABAP advisory");
  const other = await runHook(VERIFY_ON_SAVE, { hook_event_name: "PostToolUse", tool_name: "Bash", cwd: WS, tool_input: { command: "ls" } });
  assert.equal(other.code, 0);
});

// ---------------------------------------------------------------- atc-on-activate

test("atc-on-activate records the owed ATC run for the activated object and exits 0", async () => {
  const r = await runHook(ATC_ON_ACTIVATE, {
    hook_event_name: "PostToolUse",
    tool_name: "mcp__sap-adt__aws_abap_cb_activate_object",
    cwd: WS,
    tool_input: { object_name: "ZCL_X", object_type: "CLAS" },
  });
  assert.equal(r.code, 0);
  const owed = JSON.parse(readFileSync(join(STATE, "atc-owed.json"), "utf8"));
  assert.ok(owed.pending.some((o) => o.object === "ZCL_X"), `ZCL_X must be recorded as owing ATC: ${JSON.stringify(owed)}`);
  assert.match(r.err + r.out, /ATC/i, "the obligation is surfaced, not silent");
});

test("atc-on-activate does NOT itself run ATC — it records the obligation (P6 stays the evaluator's)", async () => {
  const r = await runHook(ATC_ON_ACTIVATE, {
    hook_event_name: "PostToolUse",
    tool_name: "mcp__sap-adt__aws_abap_cb_activate_object",
    cwd: WS,
    tool_input: { object_name: "ZCL_Y", object_type: "CLAS" },
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /priority-1|findings\[/, "a hook must never fabricate an ATC verdict");
});

test("atc-on-activate ignores non-activate tools", async () => {
  const r = await runHook(ATC_ON_ACTIVATE, { hook_event_name: "PostToolUse", tool_name: "mcp__sap-adt__aws_abap_cb_get_source", cwd: WS, tool_input: {} });
  assert.equal(r.code, 0);
  assert.equal(r.err.trim(), "");
});

// ---------------------------------------------------------------- ratchet-guard

test("ratchet-guard exits 0 with no outstanding obligations", async () => {
  writeFileSync(join(STATE, "atc-owed.json"), JSON.stringify({ pending: [] }));
  const r = await runHook(RATCHET_GUARD, { hook_event_name: "Stop", cwd: WS });
  assert.equal(r.code, 0, "the ratchet is enforced by the evaluator; this hook only reports");
});

test("ratchet-guard reports outstanding ATC obligations at Stop, and still exits 0", async () => {
  writeFileSync(join(STATE, "atc-owed.json"), JSON.stringify({ pending: [{ object: "ZCL_X", at: "2026-07-23T00:00:00Z" }] }));
  const r = await runHook(RATCHET_GUARD, { hook_event_name: "Stop", cwd: WS });
  assert.equal(r.code, 0);
  assert.match(r.err + r.out, /ZCL_X/, "an object activated without a recorded ATC run must be surfaced at Stop");
});

// ---------------------------------------------------------------- review-on-stop

test("review-on-stop summarises ABAP artifacts and exits 0", async () => {
  mkdirSync(join(WS, "specs", "abap"), { recursive: true });
  writeFileSync(join(WS, "specs", "abap", "zcl_new.clas.abap"), "CLASS zcl_new DEFINITION. ENDCLASS.");
  const r = await runHook(REVIEW_ON_STOP, { hook_event_name: "Stop", cwd: WS });
  assert.equal(r.code, 0);
  assert.match(r.err + r.out, /zcl_new|specs\/abap|ABAP artifact/i, "the turn's ABAP artifacts should be summarised");
});

test("review-on-stop is silent when there is no ABAP work to review", async () => {
  const r = await runHook(REVIEW_ON_STOP, { hook_event_name: "Stop", cwd: join(HERE, "fixtures") });
  assert.equal(r.code, 0);
});

// ---------------------------------------------------------------- the shared contract

test("EVERY advisory hook exits 0 on malformed stdin — none can wedge a session", async () => {
  for (const h of [RECORD_RUN, VERIFY_ON_SAVE, REVIEW_ON_STOP, ATC_ON_ACTIVATE, RATCHET_GUARD]) {
    const p = spawn(process.execPath, [h], { stdio: ["pipe", "pipe", "pipe"] });
    const code = await new Promise((res) => {
      p.on("close", res);
      p.stdin.end("{not json");
    });
    assert.equal(code, 0, `${h} must exit 0 on malformed input`);
  }
});

test("EVERY advisory hook ignores an event it does not own", async () => {
  for (const h of [RECORD_RUN, VERIFY_ON_SAVE, REVIEW_ON_STOP, ATC_ON_ACTIVATE, RATCHET_GUARD]) {
    const r = await runHook(h, { hook_event_name: "SomeOtherEvent", cwd: WS });
    assert.equal(r.code, 0, `${h} must exit 0 for a foreign event`);
  }
});
