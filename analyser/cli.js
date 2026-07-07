// Local CLI entry for the standalone analyser — the no-MCP way to run a scan and
// read the result in one command:  node analyser/cli.js <bundle-dir> [--package N]
// [--out file] [--json]. Uses the SAME analyzePackage/writeReport pipeline the
// abap-analyser MCP uses; this just renders the report to the terminal so the
// analysis can be produced and read here, without wiring the MCP server.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { filesFromBundle } from "./src/modes.js";
import { analyzePackage, writeReport } from "./src/orchestrator.js";

const DEFAULT_OUT = "specs/brownfield/analyser-findings.json";

function parseArgs(argv) {
  const opts = { path: undefined, package: undefined, out: DEFAULT_OUT, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package") opts.package = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--json") opts.json = true;
    else rest.push(a);
  }
  opts.path = rest[0];
  return opts;
}

const tally = (arr, key) => arr.reduce((m, x) => ((m[x[key]] = (m[x[key]] || 0) + 1), m), {});
const fmt = (t) => Object.entries(t).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)";

/** Render a produced analyser document as a terminal report. Pure — testable. */
export function renderReport(doc, fileCount, outPath) {
  const g = doc.graph;
  const r = doc.s4_readiness;
  const p1 = doc.findings.filter((f) => f.severity === "priority-1");
  const succ = doc.findings.filter((f) => f.family === "released-api" && f.suggestion);
  const out = [
    `ABAP Analyser — ${doc.package ?? "(unnamed)"}  (${fileCount} source files)`,
    ``,
    `Code graph:  ${g.nodes.length} nodes, ${g.edges.length} edges`,
    `  node kinds: ${fmt(tally(g.nodes, "kind"))}`,
    `  edge kinds: ${fmt(tally(g.edges, "kind"))}`,
    ``,
    `Findings: ${doc.findings.length}   by family: ${fmt(tally(doc.findings, "family"))}`,
    `                      by severity: ${fmt(tally(doc.findings, "severity"))}`,
    ``,
    `S/4 readiness: ${r.s4_readiness_pct}%  (${r.deprecated_hits} deprecated / ${r.total_api_calls} classifiable API calls)`,
  ];
  if (doc.blast_radius?.length) {
    out.push(``, `Blast radius (SAP objects at risk, most-affected first):`);
    for (const b of doc.blast_radius.slice(0, 10)) out.push(`  ${String(b.object).padEnd(12)} ${b.affected_program_count} prog(s) → ${b.successor_kind} [${b.highest_impact}]`);
  }
  if (succ.length) {
    out.push(``, `Released-API successors:`);
    for (const f of succ.slice(0, 10)) out.push(`  ${f.object}: ${f.suggestion}`);
  }
  if (p1.length) {
    out.push(``, `Priority-1 findings (${p1.length}) — first 8:`);
    for (const f of p1.slice(0, 8)) out.push(`  ${(f.file ?? f.object ?? "")}:${f.line ?? ""}  [${f.rule_id ?? f.family}] ${f.message}`);
  }
  out.push(``, `Full report written to: ${outPath}`);
  return out.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.path) {
    process.stderr.write("usage: node analyser/cli.js <bundle-dir> [--package NAME] [--out file] [--json]\n");
    process.exit(2);
  }
  const files = filesFromBundle(opts.path);
  if (files.length === 0) {
    process.stderr.write(`no analysable source (*.abap / *.asddls / *.asbdef / *.acds) under ${resolve(opts.path)} — point at the bundle's source dir\n`);
    process.exit(1);
  }
  const doc = analyzePackage(files, { package: opts.package, source_system: `bundle:${opts.path}` });
  const outPath = writeReport(doc, opts.out);
  process.stdout.write((opts.json ? JSON.stringify(doc, null, 2) : renderReport(doc, files.length, outPath)) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
