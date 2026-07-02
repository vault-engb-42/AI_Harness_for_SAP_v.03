// Test fixture: a REAL local HTTP server that implements the MCP-ADT sidecar's
// POST /mcp contract ({ tool, params } -> { result }). Not a mock — the bridge
// makes genuine HTTP round-trips to it, exercising the real code path offline.
import { createServer } from "node:http";

function handle(tool, params, headers) {
  switch (tool) {
    case "aws_abap_cb_connection_status":
      return { connected: true, system_id: "MOCK", client: "100", release: "758" };
    case "aws_abap_cb_get_source":
      return {
        source: `REPORT ${params.object_name}.\nWRITE 'hello from stub'.\n`,
        object_name: params.object_name,
        object_type: params.object_type,
      };
    case "aws_abap_cb_create_object":
      return { created: true, name: params.name, type: params.type, seen_host: headers["x-sap-host"] || null };
    case "aws_abap_cb_query_scmon_usage":
      return { executed_objects: [], window_days: params.window_days ?? 90, data_available: false };
    default:
      return { ok: true, tool, echo: params };
  }
}

// Resolves to { url, close() }. Binds to 127.0.0.1 on an ephemeral port.
export function startStub() {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"bad json"}');
        return;
      }
      const result = handle(parsed.tool, parsed.params || {}, req.headers);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
