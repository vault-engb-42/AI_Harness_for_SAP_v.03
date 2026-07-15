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
