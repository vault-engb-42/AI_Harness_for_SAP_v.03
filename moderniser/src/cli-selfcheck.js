/**
 * gap-2a self-check verb — `lint-rules <sig> --files <dir>`.
 *
 * Runs the analyser (as a library — `analyzePackage`) over a node's generated artifacts and
 * applies the gap-2a rule gate. The offline greenfield linter carries no structural RAP/N+1
 * rules, so this is the SELF_CHECK step that BLOCKs on `MODIFY ENTITIES in a loop / in a read
 * handler / without a guard` and `SELECT in a loop`. A hit prints the structured findings on
 * stdout (repair context for the driver) and signals a blocking outcome via `blocked:true`,
 * which the CLI turns into a non-zero exit — the /modernise SELF_CHECK treats it exactly like
 * a lint failure (regenerate, no SYNTAX_OK; at the cycle ceiling → BLOCK SYNTAX_CEILING).
 */
import { analyzePackage } from "../../analyser/src/orchestrator.js";
import { filesFromBundle } from "../../analyser/src/modes.js";
import { ruleGate } from "./node/rule-gate.js";

/**
 * @param {{stateDir: string, runsDir: string}} _io unused — the gate reads artifacts, not run state
 * @param {string[]} pos [sig]
 * @param {Record<string, string|undefined>} flags --files <dir>
 * @returns {{sig: string, blocked: boolean, hits: object[], files_scanned: number}}
 */
export function cmdLintRules(_io, pos, flags) {
  const sig = pos[0];
  if (!sig) throw new Error("lint-rules: usage: lint-rules <sig> --files <dir>");
  const dir = flags.files;
  if (!dir) throw new Error("lint-rules: --files <dir> is required (the node's generated artifacts)");
  const files = filesFromBundle(dir);
  if (files.length === 0) throw new Error(`lint-rules: no analysable source under ${dir} — point at the node's artifacts dir`);
  const doc = analyzePackage(files, { package: sig, source_system: `selfcheck:${sig}` });
  const { blocked, hits } = ruleGate(doc);
  return { sig, blocked, hits, files_scanned: files.length };
}
