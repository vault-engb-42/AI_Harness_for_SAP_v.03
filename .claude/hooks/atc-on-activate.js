// PostToolUse observer for ADT activations. P6 says every changed object runs ATC before "done" —
// that gate belongs to the abap-evaluator, which runs it against the live tier and renders the
// verdict. This hook does NOT run ATC and MUST NOT: a hook that fabricated an ATC result would be
// a second, unaudited source of a gate verdict. It records the OBLIGATION, so ratchet-guard can
// surface at Stop anything activated without a corresponding evaluator run. ADVISORY: exits 0.
import { readPayload, stateDir, readJson, writeJson, advise, finish, now } from "./lib/advisory.js";

const p = await readPayload();
if (p.hook_event_name !== "PostToolUse") finish();
if (!/activate_object|activate_objects_batch/.test(p.tool_name ?? "")) finish();

const input = p.tool_input ?? {};
const names = []
  .concat(input.object_name ?? [])
  .concat(Array.isArray(input.objects) ? input.objects.map((o) => o?.object_name ?? o?.name ?? o) : [])
  .filter((n) => typeof n === "string" && n.length > 0);
if (names.length === 0) finish();

const dir = stateDir(p.cwd);
const owed = readJson(dir, "atc-owed.json", { pending: [] });
const pending = Array.isArray(owed.pending) ? owed.pending : [];
for (const object of names) {
  if (!pending.some((o) => o.object === object)) pending.push({ object, at: now() });
}
writeJson(dir, "atc-owed.json", { pending });
advise(`atc-on-activate (advisory): ATC owed for ${names.join(", ")} — variant ABAP_CLEAN_CORE_DEVELOPMENT, priority-1 AND priority-2 zero (P6). Recorded, not run.`);
finish();
