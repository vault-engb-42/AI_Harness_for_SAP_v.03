import { createServer } from "node:http";
import { sanitizeError, classifyError } from "./lib/security.js";
import { SapSession } from "./lib/session.js";
import * as read from "./handlers/read.js";
import * as quality from "./handlers/quality.js";
import * as aunit from "./handlers/aunit.js";
import * as write from "./handlers/write.js";

/**
 * The harness's own MCP-ADT sidecar — the TALOS docker/sap-adt adapter ported
 * to Node as REAL working code (operator directive: no mock mode; the
 * write-path fake-success handlers of the reference are replaced with real
 * ADT flows; quality-tool errors propagate instead of collapsing to
 * empty/fabricated results).
 *
 * Contract (unchanged for the bridge): POST /mcp {tool, params} + X-SAP-*
 * headers -> 200 {result} | 4xx/5xx {detail}. GET /health. Env: ADAPTER_PORT
 * (default 8090). Divergence from the reference: binds 127.0.0.1, never
 * 0.0.0.0 (shared-host parallel-safety rule).
 */

const PORT = Number(process.env.ADAPTER_PORT ?? 8090);

/** tool name -> handler(session, params). All 17 tools are real code. */
const HANDLERS = {
  aws_abap_cb_connection_status: read.connectionStatus,
  aws_abap_cb_get_objects: read.getObjects,
  aws_abap_cb_get_source: read.getSource,
  aws_abap_cb_search_object: read.searchObject,
  aws_abap_cb_get_test_classes: read.getTestClasses,
  aws_abap_cb_get_transport_requests: read.getTransportRequests,
  aws_abap_cb_query_scmon_usage: read.queryScmonUsage,
  aws_abap_cb_query_smodilog_modifications: read.querySmodilogModifications,
  aws_abap_cb_check_syntax: quality.checkSyntax,
  aws_abap_cb_activate_object: quality.activateObject,
  aws_abap_cb_activate_objects_batch: quality.activateObjectsBatch,
  aws_abap_cb_run_atc_check: quality.runAtcCheck,
  aws_abap_cb_run_unit_tests: aunit.runUnitTests,
  aws_abap_cb_get_migration_analysis: quality.getMigrationAnalysis,
  aws_abap_cb_create_object: write.createObject,
  aws_abap_cb_update_source: write.updateSource,
  aws_abap_cb_create_or_update_test_class: write.createOrUpdateTestClass,
};

/**
 * Extract SAP credentials from X-SAP-* headers (adapter.py:167-197 semantics:
 * defaults for port/client/language/ssl-verify; host/user/password required).
 * @param {import("node:http").IncomingHttpHeaders} headers
 */
function extractCredentials(headers) {
  const get = (name) => headers[name.toLowerCase()];
  const missing = ["X-SAP-Host", "X-SAP-User", "X-SAP-Password"].filter((h) => !get(h));
  if (missing.length) {
    throw httpError(400, `Missing required headers: ${missing.join(", ")}`);
  }
  const sslVerify = String(get("X-SAP-SSL-Verify") ?? "true").toLowerCase();
  return {
    host: get("X-SAP-Host"),
    port: get("X-SAP-Port") ?? "44300",
    client: get("X-SAP-Client") ?? "100",
    username: get("X-SAP-User"),
    password: get("X-SAP-Password"),
    language: get("X-SAP-Language") ?? "EN",
    secure: !["false", "0", "no"].includes(sslVerify),
  };
}

function httpError(status, detail) {
  const e = new Error(detail);
  e.status = status;
  return e;
}

function respond(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function handleMcp(body, headers) {
  let parsed;
  try {
    parsed = JSON.parse(body || "");
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
  const tool = parsed?.tool;
  if (!tool) throw httpError(400, "Missing 'tool' field");
  const handler = HANDLERS[tool];
  if (!handler) throw httpError(404, `Unknown tool: ${tool}`);

  const session = new SapSession(extractCredentials(headers));
  // Port fix (spec CRITICAL): authenticate eagerly — the reference adapter
  // skipped this and null-dereferenced on several paths.
  await session.authenticate();
  return handler(session, parsed.params ?? {});
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/health/")) {
    respond(res, 200, {
      status: "healthy",
      adapter: "harness-sap-adt-sidecar",
      version: "1.0.0",
      mode: "real",
      mode_reason: "mock mode not ported (operator directive: no fakes) — all 17 tools are real ADT calls",
    });
    return;
  }
  if (req.method !== "POST" || req.url !== "/mcp") {
    respond(res, 404, { detail: "Not found — POST /mcp or GET /health" });
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const result = await handleMcp(body, req.headers);
      respond(res, 200, { result });
    } catch (e) {
      const status = e.status ?? classifyError(e.message);
      respond(res, status, { detail: sanitizeError(e.message) });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  // ADAPTER_PORT=0 binds an ephemeral port; report the actual one.
  const { port } = server.address();
  process.stdout.write(`sap-adt-sidecar listening on http://127.0.0.1:${port} (real mode, 17 tools)\n`);
});
