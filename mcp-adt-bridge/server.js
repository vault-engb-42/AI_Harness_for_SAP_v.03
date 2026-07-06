// MCP stdio server fronting the MCP-ADT REST sidecar.
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio transport)
// and forwards tools/call to the sidecar's POST /mcp endpoint. This is the
// harness's live-SAP substrate; the standalone analyser (abap-analyser MCP) is
// the separate offline-diagnosis substrate.
import { createInterface } from "node:readline";
import { ADT_TOOLS, WRITE_TOOLS, TOOL_NAMES } from "./adt-tools.js";
import { callAdtTool } from "./adt-client.js";

const SERVER_INFO = { name: "sap-adt", version: "1.0.0" };
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

function toolList() {
  return {
    tools: ADT_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

async function handleCall(id, params, env) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (!TOOL_NAMES.has(name)) {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  if (WRITE_TOOLS.has(name) && env.HARNESS_ADT_ALLOW_WRITE !== "1") {
    sendResult(id, {
      content: [
        {
          type: "text",
          text: `BLOCKED: '${name}' mutates SAP. P5 non-prod fail-closed — set HARNESS_ADT_ALLOW_WRITE=1 on a DEV connection to enable writes.`,
        },
      ],
      isError: true,
    });
    return;
  }
  try {
    const result = await callAdtTool(name, args, env);
    sendResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (e) {
    sendResult(id, { content: [{ type: "text", text: `ADT error: ${e.message}` }], isError: true });
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
      sendResult(id, toolList());
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
