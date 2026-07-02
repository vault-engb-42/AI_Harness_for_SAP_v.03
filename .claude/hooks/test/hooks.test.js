// End-to-end tests for the enforcement hooks: spawn the real hook process,
// feed it the Claude Code hook JSON on stdin, and assert its exit code.
// exit 2 = block; exit 0 = allow. No mocks — real processes, real stdin.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, "..");
const PRE_WRITE = join(HOOKS, "pre-write-gate.js");
const ADT_GUARD = join(HOOKS, "adt-write-guard.js");
const ARTIFACT_GUARD = join(HOOKS, "artifact-guard.js");

const ARTIFACT_WS = join(HERE, "fixtures", "artifact-ws");
const CLEAN_WS = join(HERE, "fixtures", "clean-ws");

before(() => {
  mkdirSync(ARTIFACT_WS, { recursive: true });
  mkdirSync(CLEAN_WS, { recursive: true });
  writeFileSync(join(ARTIFACT_WS, ".artifact-workspace"), "disposable\n");
});
after(() => {
  rmSync(join(HERE, "fixtures"), { recursive: true, force: true });
});

function runHook(hookPath, payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], { env: { ...process.env, ...extraEnv } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const write = (file_path, content) => ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content } });
const edit = (file_path, old_string, new_string) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path, old_string, new_string } });
const adt = (tool, tool_input) => ({ hook_event_name: "PreToolUse", tool_name: `mcp__sap-adt__aws_abap_cb_${tool}`, tool_input });
const prompt = (p, cwd) => ({ hook_event_name: "UserPromptSubmit", prompt: p, cwd });

// ---- pre-write-gate ----
test("pre-write-gate allows clean ABAP source", async () => {
  const r = await runHook(PRE_WRITE, write("specs/abap/zcl_x.clas.abap", "METHOD run.\n  WRITE 'ok'.\nENDMETHOD."));
  assert.equal(r.code, 0);
});
test("pre-write-gate blocks a hardcoded secret", async () => {
  const r = await runHook(PRE_WRITE, write("specs/abap/zcl_x.clas.abap", "DATA(t) = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345."));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /secret/i);
});
test("pre-write-gate blocks an injection sink in ABAP", async () => {
  const r = await runHook(PRE_WRITE, write("specs/abap/zcl_x.clas.abap", "GENERATE SUBROUTINE POOL lt_src NAME lv_n."));
  assert.equal(r.code, 2);
});
test("pre-write-gate blocks removal of an AUTHORITY-CHECK (P4)", async () => {
  const before = "AUTHORITY-CHECK OBJECT 'Z' ID 'ACTVT' FIELD '03'.\nIF sy-subrc <> 0. RAISE. ENDIF.\nMODIFY ztab FROM ls.";
  const after = "MODIFY ztab FROM ls.";
  const r = await runHook(PRE_WRITE, edit("specs/abap/zcl_x.clas.abap", before, after));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /AUTHORITY-CHECK|invariant/i);
});
test("pre-write-gate ignores a clean non-ABAP file", async () => {
  const r = await runHook(PRE_WRITE, write("notes.md", "GENERATE SUBROUTINE POOL is fine in prose."));
  assert.equal(r.code, 0);
});
test("pre-write-gate honors the HARNESS_ABAP_GATE=off escape hatch", async () => {
  const r = await runHook(PRE_WRITE, write("specs/abap/zcl_x.clas.abap", "CALL 'SYSTEM' ID 'COMMAND' FIELD lv."), { HARNESS_ABAP_GATE: "off" });
  assert.equal(r.code, 0);
});

// ---- adt-write-guard ----
test("adt-write-guard blocks a write tool when writes are disabled (P5)", async () => {
  const r = await runHook(ADT_GUARD, adt("create_object", { name: "ZCL_NEW", type: "CLAS", package: "$TMP", transport_request: "K1" }), { HARNESS_ADT_ALLOW_WRITE: "0" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /HARNESS_ADT_ALLOW_WRITE|write/i);
});
test("adt-write-guard allows a Z-namespace write when writes are enabled", async () => {
  const r = await runHook(ADT_GUARD, adt("create_object", { name: "ZCL_NEW", type: "CLAS", package: "ZPKG", transport_request: "K1" }), { HARNESS_ADT_ALLOW_WRITE: "1" });
  assert.equal(r.code, 0);
});
test("adt-write-guard blocks a write to a SAP-standard-namespace object (P1/P5)", async () => {
  const r = await runHook(ADT_GUARD, adt("update_source", { object_name: "CL_SALES_ORDER", object_type: "CLAS" }), { HARNESS_ADT_ALLOW_WRITE: "1" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /namespace|standard/i);
});
test("adt-write-guard blocks a batch containing a standard-namespace object", async () => {
  const r = await runHook(ADT_GUARD, adt("activate_objects_batch", { objects: [{ name: "ZI_X", type: "DDLS" }, { name: "MARA", type: "TABL" }] }), { HARNESS_ADT_ALLOW_WRITE: "1" });
  assert.equal(r.code, 2);
});
test("adt-write-guard passes through a read tool untouched", async () => {
  const r = await runHook(ADT_GUARD, adt("get_source", { object_name: "MARA", object_type: "TABL" }), { HARNESS_ADT_ALLOW_WRITE: "0" });
  assert.equal(r.code, 0);
});

// ---- artifact-guard ----
test("artifact-guard blocks a heavy lane in an artifact-only workspace", async () => {
  const r = await runHook(ARTIFACT_GUARD, prompt("/abap-build a new package", ARTIFACT_WS));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /artifact|disposable|lane/i);
});
test("artifact-guard allows a heavy lane in a normal workspace", async () => {
  const r = await runHook(ARTIFACT_GUARD, prompt("/abap-build a new package", CLEAN_WS));
  assert.equal(r.code, 0);
});
test("artifact-guard allows /abap-vibe even in an artifact workspace", async () => {
  const r = await runHook(ARTIFACT_GUARD, prompt("/abap-vibe fix a typo", ARTIFACT_WS));
  assert.equal(r.code, 0);
});
