/**
 * The `drive <run_id>` verb — one step of the deterministic driver (MODERNISER_DRIVER_AND_GAP2_DESIGN
 * Phase 2). Loads the run and returns the ONE next action the /modernise fulfiller must take:
 * {generate | await_human | provisional_complete | complete | blocked}. The fulfiller performs it
 * (spawn the generator, write artifacts, run SELF_CHECK, report the outcome via the granular verbs),
 * then calls `drive` again. Read-only over the run state — the reducer verbs own the mutations.
 */
import { driveDecision } from "./sched/drive.js";
import { loadRun } from "./cli-io.js";

export function cmdDrive(io, pos) {
  const runId = pos[0];
  if (!runId) throw new Error("drive: usage: drive <run_id>");
  const { plan, state } = loadRun(io, runId);
  return driveDecision(plan, state);
}
