// Stop observer for the Karpathy ratchet. The ratchet is ENFORCED by the evaluator and the
// verdict reducer — accepted WARN findings only down, coverage only up — and that enforcement is
// not duplicated here. This hook reports what is outstanding at the end of a turn: objects
// activated without a recorded ATC run, and a missing/corrupt baseline pair.
// ADVISORY: exits 0 even when it finds something. A second blocking path would be a second source
// of truth for the ratchet, which is the divergence this codebase has already paid for once.
import { readPayload, stateDir, readJson, advise, finish } from "./lib/advisory.js";

const p = await readPayload();
if (p.hook_event_name !== "Stop") finish();

const dir = stateDir(p.cwd);
const owed = readJson(dir, "atc-owed.json", { pending: [] });
const pending = Array.isArray(owed.pending) ? owed.pending : [];
if (pending.length > 0) {
  advise(
    `ratchet-guard (advisory): ${pending.length} object(s) activated with no recorded ATC run — ` +
      `${pending.map((o) => o.object).join(", ")}. P6: run aws_abap_cb_run_atc_check before calling this done.`,
  );
}

const atc = readJson(dir, "atc-baseline.json", null);
const cov = readJson(dir, "abapunit-baseline.json", null);
if (atc === null || cov === null) {
  advise("ratchet-guard (advisory): a baseline file is missing or unreadable — the ratchet cannot tighten from a baseline it cannot read.");
}
finish();
