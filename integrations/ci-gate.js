#!/usr/bin/env node
/**
 * GAP#1b — the CI/CD gate adapter. Deterministic, no LLM: reads the gate verdicts
 * the /abap-validate lane wrote, validates their shape (fail-closed), and blocks
 * the build on any HARD failure. Wire as a CI step:
 *     node integrations/ci-gate.js specs/reviews   # exit 1 on any block
 *
 * The harness stays a clean producer — this adapter only CONSUMES the JSON
 * contract (hardened by verdict-schema.js) and never touches SAP.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateVerdict } from "./verdict-schema.js";

/** HARD gates: any BLOCK / pass:false / priority-1 ATC / missing / invalid blocks the build. */
const HARD = [
  { file: "sap-verdict.json", kind: "sap" },
  { file: "clean-core-verdict.json", kind: "clean-core" },
  { file: "security-verdict.json", kind: "security" },
  { file: "diff-review-verdict.json", kind: "diff-review" },
];

/**
 * Evaluate the verdict set in `dir`.
 * @param {string} dir directory holding the *-verdict.json files (e.g. specs/reviews)
 * @returns {{pass: boolean, blocks: string[], warnings: string[]}}
 */
export function evaluateGate(dir) {
  const blocks = [];
  const warnings = [];
  for (const { file, kind } of HARD) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      blocks.push(`${file}: missing or unreadable (fail-closed)`);
      continue;
    }
    const v = validateVerdict(kind, doc);
    if (!v.valid) {
      blocks.push(`${file}: invalid shape — ${v.errors.join("; ")}`);
      continue;
    }
    if (kind === "sap") {
      if (doc.verdict === "BLOCK") blocks.push(`sap-verdict: BLOCK (failure_layer=${doc.failure_layer})`);
      if (doc.atc?.priority1?.length) blocks.push(`sap-verdict: ${doc.atc.priority1.length} priority-1 ATC finding(s)`);
    } else if (doc.pass === false) {
      blocks.push(`${file}: pass=false`);
    }
  }
  // design-critique is the SOFT gate: WARN is a non-blocking notice, a reserved
  // BLOCK (P1/P4 model breach) blocks. Its absence never blocks.
  try {
    const d = JSON.parse(readFileSync(join(dir, "design-critique.json"), "utf8"));
    if (validateVerdict("design-critique", d).valid) {
      if (d.verdict === "BLOCK") blocks.push("design-critique: BLOCK (P1/P4 model breach)");
      else if (d.verdict === "WARN") warnings.push("design-critique: WARN — needs human acknowledgement");
    }
  } catch {
    // soft gate — absent design-critique does not block
  }
  return { pass: blocks.length === 0, blocks, warnings };
}

function main() {
  const dir = process.argv[2] || "specs/reviews";
  const { pass, blocks, warnings } = evaluateGate(dir);
  for (const w of warnings) process.stdout.write(`! ${w}\n`);
  if (pass) {
    process.stdout.write(`✓ gate PASS — all hard verdicts clean (${dir})\n`);
    process.exit(0);
  }
  process.stderr.write(`✗ gate BLOCK (${dir}):\n${blocks.map((b) => "  - " + b).join("\n")}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
