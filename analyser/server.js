// The analyser MCP: a stdio JSON-RPC 2.0 server exposing the standalone ABAP
// analyser's three modes (offline bundle / live-via-engine / live-via-ADT).
// Read-only against SAP; the only writes are local report files.
import { createInterface } from "node:readline";
import { ANALYSER_TOOLS, TOOL_NAMES } from "./analyser-tools.js";
import { analyzePackage, writeReport } from "./src/orchestrator.js";
import { filesFromBundle, filesFromLiveSystem, docFromAdtOnly } from "./src/modes.js";

const SERVER_INFO = { name: "abap-analyser", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_OUT = "specs/brownfield/analyser-findings.json";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function toolText(id, payload, isError = false) {
  sendResult(id, { content: [{ type: "text", text: payload }], ...(isError ? { isError: true } : {}) });
}

/** Run the full pipeline over acquired files, write the report, return a summary. */
function emit(files, args, extra = {}) {
  const doc = analyzePackage(files, {
    package: args.package,
    source_system: args.source_system,
    depth: args.depth,
    coverage_note: extra.coverage_note,
  });
  const out = writeReport(doc, args.out ?? DEFAULT_OUT);
  return summarize(doc, files.length, out);
}

function summarize(doc, objects, out) {
  return JSON.stringify({
    package: doc.package,
    objects,
    nodes: doc.graph.nodes.length,
    edges: doc.graph.edges.length,
    findings: doc.findings.length,
    s4_readiness_pct: doc.s4_readiness.s4_readiness_pct,
    blast_radius_entries: doc.blast_radius?.length ?? 0,
    out,
  });
}

async function runTool(name, args, env) {
  switch (name) {
    case "analyse_bundle": {
      const files = filesFromBundle(args.path);
      return emit(files, args);
    }
    case "analyse_source_system": {
      const { files, skipped } = await filesFromLiveSystem(env, args.package);
      const coverage_note = skipped.length
        ? `objects skipped by live pull (unsupported type or empty source): ${skipped.join(", ")}`
        : undefined;
      return emit(files, args, { coverage_note });
    }
    case "analyse_via_adt": {
      const doc = await docFromAdtOnly(env, args.package, { source_system: args.source_system });
      const out = writeReport(doc, args.out ?? DEFAULT_OUT);
      return summarize(doc, 0, out);
    }
    default:
      throw new Error(`unhandled tool ${name}`);
  }
}

async function handleCall(id, params, env) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (!TOOL_NAMES.has(name)) {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  try {
    toolText(id, await runTool(name, args, env));
  } catch (e) {
    toolText(id, `analyser error: ${e.message}`, true);
  }
}

async function handle(msg, env) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      sendResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return;
    case "notifications/initialized":
    case "initialized":
      return; // notification — no response
    case "ping":
      sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, { tools: ANALYSER_TOOLS });
      return;
    case "tools/call":
      await handleCall(id, params, env);
      return;
    default:
      if (id != null) sendError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  const env = process.env;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON lines
    }
    handle(msg, env).catch((e) => {
      if (msg && msg.id != null) sendError(msg.id, -32603, e.message);
    });
  });
}

main();
