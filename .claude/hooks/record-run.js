// SessionStart / Stop telemetry. Appends one JSONL row per lifecycle event to
// .claude/state/run-log.jsonl so a run's shape — when it started, when it stopped, under which
// session — is reconstructable after the fact. ADVISORY: exits 0 always, and a write failure is
// swallowed, because telemetry that can wedge a session is worse than no telemetry.
import { readPayload, stateDir, appendJsonl, finish, now } from "./lib/advisory.js";

const p = await readPayload();
const event = p.hook_event_name;
if (event !== "SessionStart" && event !== "Stop") finish();

try {
  appendJsonl(stateDir(p.cwd), "run-log.jsonl", {
    at: now(),
    event,
    session_id: p.session_id ?? null,
    source: p.source ?? null,
    cwd: p.cwd ?? null,
  });
} catch {
  // see the advisory.js docstring: never surface a telemetry failure
}
finish();
