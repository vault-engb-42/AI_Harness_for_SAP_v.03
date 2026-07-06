// The greenfield MCP: a stdio JSON-RPC 2.0 server exposing greenfield's own
// build tooling. GF-1: `ground_released_apis` (pre-generation released-API
// grounding over the bundled SAP cloudification registry). Offline, read-only
// — no SAP connection, no analyser. GF-2 will add the ABAP-Cloud lint tool.
import { createInterface } from "node:readline";
import { GREENFIELD_TOOLS, GREENFIELD_TOOL_NAMES } from "./tools.js";
import { harvestRefs, groundReleasedApis, renderGroundingPack } from "./src/released-api-grounding.js";

const SERVER_INFO = { name: "greenfield", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

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

/** @param {string} name @param {object} args @returns {string} */
function runTool(name, args) {
  if (name !== "ground_released_apis") throw new Error(`unhandled tool ${name}`);
  const refs = Array.isArray(args.refs) && args.refs.length ? args.refs : harvestRefs(args.text ?? "");
  const grounded = groundReleasedApis(refs);
  return JSON.stringify({ pack: renderGroundingPack(grounded), counts: grounded.counts, refs: grounded.refs });
}

function handleCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (!GREENFIELD_TOOL_NAMES.has(name)) {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  try {
    toolText(id, runTool(name, args));
  } catch (e) {
    toolText(id, `greenfield error: ${e.message}`, true);
  }
}

function handle(msg) {
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
      sendResult(id, { tools: GREENFIELD_TOOLS });
      return;
    case "tools/call":
      handleCall(id, params);
      return;
    default:
      if (id != null) sendError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
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
    try {
      handle(msg);
    } catch (e) {
      if (msg && msg.id != null) sendError(msg.id, -32603, e.message);
    }
  });
}

main();
