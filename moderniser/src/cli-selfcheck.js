/**
 * gap-2a self-check + grounding verbs.
 *
 * `lint-rules <sig> --files <dir>` runs the analyser (as a library — `analyzePackage`) over a
 * node's generated artifacts and applies the gap-2a rule gate. The offline greenfield linter
 * carries no structural RAP/N+1 rules, so this is the SELF_CHECK step that BLOCKs on `MODIFY
 * ENTITIES in a loop / in a read handler / without a guard` and `SELECT in a loop`. A hit prints
 * the structured `hits[]` AND an exemplar-backed `repair` brief on stdout (repair context for the
 * driver), and signals a blocking outcome via `blocked:true`, which the CLI turns into a non-zero
 * exit — the /modernise SELF_CHECK treats it like a lint failure.
 *
 * `findings-brief <object> --findings <analyser-findings.json>` is the PRE-generation counterpart:
 * it side-looks-up the object's priority-1 structural anti-patterns from the analyser findings doc
 * (never the frozen plan) and renders them as an "avoid these" grounding brief, so the generator
 * emits the batched/pre-loaded form first-pass instead of reproducing the source defect.
 */
import { readFileSync } from "node:fs";
import { analyzePackage } from "../../analyser/src/orchestrator.js";
import { filesFromBundle } from "../../analyser/src/modes.js";
import { ruleGate } from "./node/rule-gate.js";
import { IDIOM_KB, groundingBrief, repairBrief } from "./node/idiom-kb.js";

/**
 * @param {{stateDir: string, runsDir: string}} _io unused — the gate reads artifacts, not run state
 * @param {string[]} pos [sig]
 * @param {Record<string, string|undefined>} flags --files <dir>
 * @returns {{sig: string, blocked: boolean, hits: object[], repair: string, files_scanned: number}}
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
  return { sig, blocked, hits, repair: repairBrief(hits), files_scanned: files.length };
}

/**
 * @param {{stateDir: string, runsDir: string}} _io unused
 * @param {string[]} pos [object]
 * @param {Record<string, string|undefined>} flags --findings <analyser-findings.json>
 * @returns {{object: string, count: number, brief: string}}
 */
export function cmdFindingsBrief(_io, pos, flags) {
  const object = pos[0];
  if (!object) throw new Error("findings-brief: usage: findings-brief <object> --findings <analyser-findings.json>");
  const path = flags.findings;
  if (!path) throw new Error("findings-brief: --findings <analyser-findings.json> is required");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const obj = object.toUpperCase();
  // Only KB-covered priority-1 rules — each yields a concrete before→after exemplar; the generic
  // RAP/EML idioms are already in the generator prompt, and released-API grounding is separate.
  const matched = (doc.findings ?? []).filter(
    (f) => String(f.object ?? "").toUpperCase() === obj && f.severity === "priority-1" && IDIOM_KB[f.rule_id],
  );
  return { object: obj, count: matched.length, brief: groundingBrief(matched) };
}
