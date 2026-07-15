import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// `drive <run_id>` end-to-end (real subprocess, real fs, golden fixture — no mocks): a freshly
// planned run returns `generate` for its ready frontier; a run driven to a rested/terminal state
// returns the right terminal action.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "drive-cli-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  return (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" }));
}

test("drive on a fresh planned run returns generate for the ready frontier", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  const d = cli("drive", planned.run_id);
  assert.equal(d.action, "generate");
  assert.ok(Array.isArray(d.packets) && d.packets.length > 0, "frontier packets present");
  assert.ok(d.packets.every((p) => p.sig && p.object !== undefined && p.wave !== undefined), "each packet is a {sig, object, wave}");
});

test("drive fails loud when the run does not exist", () => {
  const cli = mkCli();
  assert.throws(() => cli("drive", "run-nope"));
});

// --report (increment 2): the driver owns retry-vs-ceiling — mutation rides ONLY on --report,
// bare `drive` stays read-only (Option A). Real subprocess, real fs, golden fixture.

test("drive --report syntax_ok advances the reported node and returns the next action", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  const sig = cli("drive", planned.run_id).packets[0].sig;
  const action = cli("drive", planned.run_id, "--report", `${sig}=syntax_ok`);
  assert.ok(typeof action.action === "string", "returns a next top-level action");
  const st = cli("status", planned.run_id);
  assert.ok((st.counts.SYNTAX_OK ?? 0) >= 1, "the reported node advanced to SYNTAX_OK on disk");
});

test("drive --report syntax_fail retries below the ceiling, then BLOCKs at it (SYNTAX_CEILING)", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  const sig = cli("drive", planned.run_id).packets[0].sig;
  const a1 = cli("drive", planned.run_id, "--report", `${sig}=syntax_fail`);
  assert.equal(a1.action, "generate");
  assert.ok(a1.packets.some((p) => p.sig === sig && p.retry === true), "re-issues the same node with retry");
  cli("drive", planned.run_id, "--report", `${sig}=syntax_fail`); // 2nd attempt
  cli("drive", planned.run_id, "--report", `${sig}=syntax_fail`); // 3rd → ceiling
  const st = cli("status", planned.run_id);
  assert.ok((st.counts.BLOCK ?? 0) >= 1, "the node is quarantined at the syntax ceiling");
  assert.ok(st.deferral_track.some((d) => d.sig === sig && d.reason === "SYNTAX_CEILING"), "quarantine reason recorded");
});

test("drive --report rejects a malformed value", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  assert.throws(() => cli("drive", planned.run_id, "--report", "bogus"));
});
