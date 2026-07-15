// PreToolUse(Write|Edit|MultiEdit) gate for LOCAL source writes.
// Blocks (exit 2) on hardcoded secrets in any file, and — for ABAP source —
// on injection/codegen sinks (P8/security) or an immutable-invariant
// regression (P4). Escape hatch: HARNESS_ABAP_GATE=off.
import { scanSecrets, detectInjectionSinks, detectInvariantWeakening, isAbapSource } from "./lib/abap-checks.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let payload = {};
try {
  payload = JSON.parse(raw || "{}");
} catch {
  process.exit(0); // malformed hook input — do not block
}

if (process.env.HARNESS_ABAP_GATE === "off") process.exit(0);

const tool = payload.tool_name;
if (!["Write", "Edit", "MultiEdit"].includes(tool)) process.exit(0);

const ti = payload.tool_input || {};
const filePath = ti.file_path || "";

let newText = "";
let oldText = "";
if (tool === "Write") {
  newText = ti.content || "";
} else if (tool === "Edit") {
  newText = ti.new_string || "";
  oldText = ti.old_string || "";
} else {
  const edits = ti.edits || [];
  newText = edits.map((e) => e.new_string || "").join("\n");
  oldText = edits.map((e) => e.old_string || "").join("\n");
}

function block(msg) {
  process.stderr.write(`BLOCKED (pre-write-gate): ${msg}\n`);
  process.exit(2);
}

const secrets = scanSecrets(newText);
if (secrets.length) {
  block(`hardcoded secret detected (${secrets.map((s) => s.label).join(", ")}). Move it to an environment variable — never commit secrets.`);
}

if (isAbapSource(filePath)) {
  const sinks = detectInjectionSinks(newText);
  if (sinks.length) {
    block(`ABAP injection/codegen sink (${sinks.map((s) => s.sink).join(", ")}) — forbidden in new code (P8/security). Use static SQL, released APIs, and static SUBMIT.`);
  }
  const inv = detectInvariantWeakening(oldText, newText);
  if (inv.length) {
    block(`immutable invariant regression (${inv.map((i) => i.type).join(", ")}). AUTHORITY-CHECK / COMMIT ENTITIES (RAP save; or COMMIT WORK in classic code) / SY-SUBRC are un-loosenable (P4) — restore the guard.`);
  }
}

process.exit(0);
