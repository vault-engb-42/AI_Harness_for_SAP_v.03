// UserPromptSubmit gate. Blocks (exit 2) a heavy build lane
// (/abap-build, /abap-auto, /abap-implement, /abap-change, /abap-refactor,
// /abap-validate, /abap-transport) when the working dir is a disposable
// artifact workspace (a .artifact-workspace marker file is present). Keeps the
// GAN pipeline out of throwaway analysis dirs; light lanes are unaffected.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildLaneInPrompt } from "./lib/abap-checks.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let payload = {};
try {
  payload = JSON.parse(raw || "{}");
} catch {
  process.exit(0);
}

if (payload.hook_event_name !== "UserPromptSubmit") process.exit(0);

const lane = buildLaneInPrompt(payload.prompt || "");
if (!lane) process.exit(0);

const cwd = payload.cwd || process.cwd();
if (existsSync(join(cwd, ".artifact-workspace"))) {
  process.stderr.write(
    `BLOCKED (artifact-guard): /${lane} is a build lane, but this is a disposable artifact workspace (.artifact-workspace present). ` +
      `Use a real project directory, or a light lane (/fit-to-standard, /readiness, /abap-design --doc-only).\n`,
  );
  process.exit(2);
}

process.exit(0);
