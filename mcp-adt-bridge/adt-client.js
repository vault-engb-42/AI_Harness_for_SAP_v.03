// Forwards a single ADT tool call to the MCP-ADT REST sidecar (adapter.py).
// The sidecar is NOT an MCP server — it is a FastAPI endpoint that accepts
// { tool, params } on POST /mcp with per-request X-SAP-* credential headers.

const SAP_HEADER_ENV = {
  "X-SAP-Host": "SAP_HOST",
  "X-SAP-User": "SAP_USER",
  "X-SAP-Password": "SAP_PASSWORD",
  "X-SAP-Port": "SAP_PORT",
  "X-SAP-Client": "SAP_CLIENT",
  "X-SAP-Language": "SAP_LANGUAGE",
  "X-SAP-SSL-Verify": "SAP_SSL_VERIFY",
};

function sapHeaders(env) {
  const headers = {};
  for (const [header, envVar] of Object.entries(SAP_HEADER_ENV)) {
    const value = env[envVar];
    if (value !== undefined && value !== "") headers[header] = value;
  }
  return headers;
}

function endpoint(env) {
  const base = (env.ADT_MCP_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
  return `${base}/mcp`;
}

// Returns the sidecar's structured result (unwrapping the { result: ... } envelope).
// Throws on transport/HTTP failure so the caller can surface an MCP tool error.
export async function callAdtTool(name, args, env) {
  const res = await fetch(endpoint(env), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...sapHeaders(env) },
    body: JSON.stringify({ tool: name, params: args || {} }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ADT sidecar ${name} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`ADT sidecar ${name} returned non-JSON: ${text.slice(0, 300)}`);
  }
  return json.result !== undefined ? json.result : json;
}
