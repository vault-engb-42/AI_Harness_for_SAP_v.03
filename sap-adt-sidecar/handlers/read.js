import { parseAdtXml, findAll, attr } from "../lib/adt-xml.js";
import { SOURCE_URI } from "../lib/adt-uris.js";

/**
 * Read-only ADT tools (real SAP calls, ported per the spec's per-tool table).
 * Errors PROPAGATE — no empty-array fallbacks that masquerade as clean runs.
 */

/** connection_status: the port authenticates eagerly, so this reports a REAL probe. */
export async function connectionStatus(session) {
  return {
    connected: session.authenticated && session.csrfToken !== null,
    system_id: session.conn.host,
    client: session.conn.client,
    username: session.conn.username,
    auth_type: "basic",
    release: "",
    detail: "Live SAP session (harness sap-adt-sidecar, real mode)",
  };
}

/**
 * get_objects: POST /sap/bc/adt/repository/nodestructure with urlencoded
 * query params and an empty body (spec: sap_client.py:760-786).
 */
export async function getObjects(session, { package_name } = {}) {
  const params = new URLSearchParams({ withShortDescriptions: "true" });
  if (package_name) {
    params.set("parent_type", "DEVC/K");
    params.set("parent_name", package_name);
  }
  const res = await session.request("POST", `/sap/bc/adt/repository/nodestructure?${params}`, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/xml, application/vnd.sap.as+xml",
    },
    body: "",
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`get_objects failed: HTTP ${res.status} (${text.slice(0, 200)})`);
  }
  const doc = parseAdtXml(text);
  // nodestructure rows come back as SEU_ADT node entries; match generically.
  const objects = [];
  for (const node of findAll(doc, "node")) {
    const name = textOf(node, "OBJECT_NAME");
    const type = textOf(node, "OBJECT_TYPE");
    if (name && type) {
      objects.push({
        name,
        type: type.split("/")[0],
        url: textOf(node, "OBJECT_URI") ?? "",
        description: textOf(node, "DESCRIPTION") ?? "",
        package: package_name ?? "",
      });
    }
  }
  return { objects };
}

/**
 * get_source: direct typed source URI (spec short-circuit paths); raw text.
 */
export async function getSource(session, { object_name, object_type }) {
  const type = String(object_type ?? "").toUpperCase();
  const uriFn = SOURCE_URI[type];
  if (!uriFn) {
    throw new Error(`get_source: unsupported object_type ${object_type} (supported: ${Object.keys(SOURCE_URI).join(", ")})`);
  }
  const res = await session.request("GET", uriFn(object_name), { headers: { Accept: "text/plain" } });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`get_source ${object_name} (${type}) failed: HTTP ${res.status} (${text.slice(0, 200)})`);
  }
  return { source: text, object_name, object_type: type };
}

/**
 * search_object: quickSearch with the upstream's client-side guards
 * (query charset/length, maxResults bounds).
 */
export async function searchObject(session, { query, object_type, max_results } = {}) {
  const q = String(query ?? "");
  if (!/^[A-Za-z0-9*_]{1,100}$/.test(q)) {
    throw new Error("search_object: query must be 1-100 chars of A-Z a-z 0-9 * _");
  }
  const max = Math.min(Math.max(Number(max_results) || 50, 1), 500);
  const params = new URLSearchParams({ operation: "quickSearch", query: q, maxResults: String(max) });
  if (object_type && object_type !== "ALL") params.set("objectType", object_type);
  const res = await session.request("GET", `/sap/bc/adt/repository/informationsystem/search?${params}`, {
    headers: { Accept: "application/xml" },
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`search_object failed: HTTP ${res.status} (${text.slice(0, 200)})`);
  }
  const refs = findAll(parseAdtXml(text), "objectReference");
  return {
    objects: refs.map((r) => ({
      name: attr(r, "name") ?? "",
      type: (attr(r, "type") ?? "").split("/")[0],
      url: attr(r, "uri") ?? "",
      description: attr(r, "description") ?? "",
      package: attr(r, "packageName") ?? "",
    })),
  };
}

/**
 * get_test_classes: the class's testclasses include as raw text; retries the
 * inactive version like the upstream (spec: sap_client.py:1195-1251).
 */
export async function getTestClasses(session, { class_name }) {
  for (const version of ["active", "inactive"]) {
    const res = await session.request(
      "GET",
      `/sap/bc/adt/oo/classes/${String(class_name).toLowerCase()}/includes/testclasses?version=${version}`,
      { headers: { Accept: "text/plain" } },
    );
    const text = await res.text();
    if (res.status === 200 && text.trim()) return { class_name, source: text };
  }
  return { class_name, source: "" };
}

/**
 * get_transport_requests — REAL (upstream returned an honest-empty; the
 * operator directive turns gaps into working code): ADT CTS transport search.
 */
export async function getTransportRequests(session, { username } = {}) {
  const user = username ?? session.conn.username;
  const res = await session.request(
    "GET",
    `/sap/bc/adt/cts/transportrequests?user=${encodeURIComponent(user)}&targets=true`,
    { headers: { Accept: "application/xml, application/vnd.sap.adt.transportorganizer.v1+xml" } },
  );
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`get_transport_requests failed: HTTP ${res.status} (${text.slice(0, 200)})`);
  }
  const doc = parseAdtXml(text);
  const transports = findAll(doc, "request").map((r) => ({
    number: attr(r, "number") ?? attr(r, "name") ?? "",
    description: attr(r, "desc") ?? attr(r, "description") ?? "",
    owner: attr(r, "owner") ?? "",
    status: attr(r, "status") ?? "",
    type: attr(r, "type") ?? "",
  })).filter((t) => t.number);
  return { transports, username: user };
}

/**
 * SCMON / SMODILOG: ADT exposes NO endpoint for these table-level signals
 * (they need an RFC/table gateway). Reporting data_available:false is the
 * truthful answer, with the reason stated — consumers must never read a
 * missing signal as "unused/unmodified" (schema coverage_note contract).
 */
export async function queryScmonUsage(_session, { window_days } = {}) {
  return {
    executed_objects: [],
    window_days: window_days ?? 90,
    measurement_start: "",
    data_available: false,
    reason: "SCMON is not exposed via the ADT REST protocol; an RFC/table gateway is required",
  };
}

export async function querySmodilogModifications(_session, { package_name, date_from } = {}) {
  return {
    modifications: [],
    data_available: false,
    package_name: package_name ?? "",
    date_from: date_from ?? "",
    reason: "SMODILOG is not exposed via the ADT REST protocol; an RFC/table gateway is required",
  };
}

/** First matching descendant's text (nodestructure rows are element-based). */
function textOf(node, localName) {
  const hits = findAll(node, localName);
  const v = hits[0]?.["#text"];
  return typeof v === "string" && v ? v : undefined;
}
