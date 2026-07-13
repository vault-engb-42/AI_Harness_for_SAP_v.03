/**
 * Park-lifecycle verb for the /modernise CLI (MODERNISER_DESIGN §3.4 #5, L7; review
 * F18/F26): the documented per-run successor re-probe, made executable. Offline there is
 * no registry endpoint to poll, so the OPERATOR supplies the shipped successor names —
 * the verb joins them against each audited row's canonicalised `successor_probe`,
 * releases the matching rows, and re-enters the nodes (PARK → PENDING) in the SAME
 * command, so the audit file and live state can never diverge.
 *
 *   reprobe <run_id> --available I_X[,I_Y...]
 */
import { reEnter } from "./exception/park.js";
import { applyProgress } from "./sched/loop.js";
import { loadRun, readParkRegister, saveParkRegister, saveState, log } from "./cli-io.js";

export function cmdReprobe(io, pos, flags) {
  const [runId] = pos;
  const { plan, state } = loadRun(io, runId);
  const available = new Set(
    String(flags.available ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase()) // same canonicalisation as the park probe (registry case)
      .filter(Boolean),
  );
  if (available.size === 0) {
    throw new Error("reprobe: --available I_X[,I_Y...] is required — offline, the operator supplies the shipped successor names");
  }
  const reg = readParkRegister(io);
  const { register, reentered } = reEnter(reg, { available });
  let next = state;
  for (const sig of reentered) {
    // guard: a register row for a node this run does not hold parked (crash-retry replay,
    // or a sig parked by another run against the shared register) re-enters nothing here
    if (next.status[sig] === "PARK") next = applyProgress(plan, next, sig, "PENDING");
  }
  // state BEFORE register: a crash between the two writes leaves the row in place, and the
  // retry re-runs reEnter against it — the PENDING status above makes the replay a no-op
  saveState(io, runId, next);
  saveParkRegister(io, register);
  for (const sig of reentered) log(io, runId, "reprobe-reenter", { sig });
  return { reentered, still_parked: register.parked.map((p) => p.node_id) };
}
