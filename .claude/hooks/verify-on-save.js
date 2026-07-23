// PostToolUse observer for ABAP artifact writes. pre-write-gate already BLOCKED anything unsafe
// before it landed; this re-inspects what actually got written and reports. The value is
// defence-in-depth without a second veto: if a check here ever disagrees with the gate, that
// divergence is visible in the transcript instead of silently deciding the outcome.
// ADVISORY: exits 0 even on a detected violation.
import { readPayload, advise, finish } from "./lib/advisory.js";
import { scanSecrets, detectInjectionSinks, isAbapSource } from "./lib/abap-checks.js";

const p = await readPayload();
if (p.hook_event_name !== "PostToolUse") finish();
if (!/^(Write|Edit|MultiEdit)$/.test(p.tool_name ?? "")) finish();

const file = p.tool_input?.file_path ?? "";
if (!file || !isAbapSource(file)) finish();

const content = p.tool_input?.content ?? p.tool_input?.new_string ?? "";
const notes = [];
for (const s of scanSecrets(content)) notes.push(`secret (${s.kind ?? s})`);
for (const s of detectInjectionSinks(content)) notes.push(`injection sink (${s.kind ?? s})`);

if (notes.length > 0) {
  advise(`verify-on-save (advisory): ${file} — ${notes.join("; ")}. Not blocked here; pre-write-gate owns the veto.`);
}
finish();
