import { escapeXml, parseAdtXml, findAll, attr } from "../lib/adt-xml.js";
import { OBJECT_URI, CREATION } from "../lib/adt-uris.js";

/**
 * Write tools — REAL implementations. The TALOS reference returned hardcoded
 * fake-success payloads for all three without touching SAP (spec:
 * real_handlers.py:102-140); under the operator's no-fakes directive these
 * are the standard ADT write flows:
 *   create_object              POST to the type's collection URI
 *   update_source              lock -> PUT source/main -> unlock
 *   create_or_update_test_class lock -> PUT includes/testclasses -> unlock
 * Every step checks the real HTTP status and PROPAGATES failures. P5 gating
 * (writes blocked outside DEV) stays at the MCP bridge, which fails closed
 * before any request reaches this sidecar.
 */

// SRVB binding-type profiles (G10): OData V4 UI is the Fiori-Elements default; V2 UI for a
// legacy UI; V4 Web API (category 0) for a headless remote API (release contract C2).
const SRVB_BINDINGS = {
  ODATA_V4_UI: { type: "ODATA", version: "V4", category: "1" },
  ODATA_V2_UI: { type: "ODATA", version: "V2", category: "1" },
  ODATA_V4_WEBAPI: { type: "ODATA", version: "V4", category: "0" },
};

// Publishing a service binding is a DISTINCT action that runs AFTER the binding is activated:
// it registers the OData service group at the gateway. The endpoint differs by protocol — V4
// vs V2 — so publish routes on the binding's own protocol (read from the binding), not a default.
const PUBLISH = {
  V4: "/sap/bc/adt/businessservices/odatav4/publishjobs",
  V2: "/sap/bc/adt/businessservices/odatav2/publishjobs",
};

/**
 * Build the ADT creation payload for a type (pure — asserted offline in write.test.js).
 * Source-based objects (CLAS/…/DDLS/SRVD/TABL) get the generic adtcore shell — created
 * empty, then their source is PUT to /source/main. A service binding (SRVB, `spec.binding`)
 * is CONFIG-only (no /source/main), so its body carries the referenced service definition +
 * the binding block. Grounded on abap-adt-api objectcreator.ts; the default binding is OData
 * V4 UI (category 1); `binding_type` selects the profile (G10). The V4 create-body attributes
 * await live ADT confirmation (abap-adt-api encodes only the V2 body).
 * @param {{root:string, ns:string, extra:string, binding?:boolean}} spec
 * @param {{name:string, description?:string, responsible:string, pkg:string, service_definition?:string, binding_type?:string}} o
 * @returns {string}
 */
export function creationBody(spec, { name, description, responsible, pkg, service_definition, binding_type }) {
  const nm = escapeXml(String(name).toUpperCase());
  const desc = escapeXml(description ?? name);
  const resp = escapeXml(String(responsible).toUpperCase());
  const pkgRef = `<adtcore:packageRef adtcore:name="${escapeXml(String(pkg).toUpperCase())}"/>`;
  const open = `<?xml version="1.0" encoding="UTF-8"?>
<${spec.root} ${spec.ns} xmlns:adtcore="http://www.sap.com/adt/core"${spec.extra} adtcore:name="${nm}" adtcore:description="${desc}" adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:responsible="${resp}">`;
  if (spec.binding) {
    const srvd = escapeXml(String(service_definition ?? name).toUpperCase());
    const b = SRVB_BINDINGS[String(binding_type ?? "ODATA_V4_UI").toUpperCase()] ?? SRVB_BINDINGS.ODATA_V4_UI;
    return `${open}
${pkgRef}
<srvb:services srvb:name="${nm}">
<srvb:content srvb:version="0001" srvb:releaseState="notReleased">
<srvb:serviceDefinition adtcore:name="${srvd}"/>
</srvb:content>
</srvb:services>
<srvb:binding srvb:type="${b.type}" srvb:version="${b.version}" srvb:category="${b.category}">
<srvb:implementation adtcore:name=""/>
</srvb:binding>
</${spec.root}>`;
  }
  return `${open}
${pkgRef}
</${spec.root}>`;
}

/** create_object: POST the adtcore creation payload to the collection. */
export async function createObject(session, { name, type, package: pkg, description, transport_request, service_definition, binding_type }) {
  const t = String(type ?? "").toUpperCase();
  const spec = CREATION[t];
  if (!spec) {
    throw new Error(`create_object: unsupported type ${type} (supported: ${Object.keys(CREATION).join(", ")})`);
  }
  if (!name || !pkg) throw new Error("create_object: name and package are required");
  // Fail closed: a service binding must name the service definition it exposes. Without it
  // the body would reference the binding's own name as its SRVD (a broken binding), so refuse.
  if (spec.binding && !service_definition) {
    throw new Error("create_object: a service binding (SRVB) requires service_definition — the service definition (SRVD) it exposes");
  }
  const body = creationBody(spec, { name, description, responsible: session.conn.username, pkg, service_definition, binding_type });
  await session.ensureFreshCsrf();
  const params = transport_request ? `?corrNr=${encodeURIComponent(transport_request)}` : "";
  const res = await session.request("POST", `${spec.collection}${params}`, {
    headers: { "Content-Type": spec.contentType, Accept: "application/xml, */*" },
    body,
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`create_object ${name} (${t}) failed: HTTP ${res.status} (${firstMessage(text) ?? text.slice(0, 200)})`);
  }
  return { created: true, name: String(name).toUpperCase(), type: t, package: String(pkg).toUpperCase(), transport_request: transport_request ?? "", http_status: res.status };
}

/** Lock an object for modification; returns the lock handle. */
async function lock(session, objUri) {
  const res = await session.request("POST", `${objUri}?_action=LOCK&accessMode=MODIFY`, {
    headers: { Accept: "application/xml, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result, */*" },
    body: "",
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`lock ${objUri} failed: HTTP ${res.status} (${firstMessage(text) ?? text.slice(0, 200)})`);
  }
  const handle = findAll(parseAdtXml(text), "LOCK_HANDLE")[0]?.["#text"];
  if (!handle) throw new Error(`lock ${objUri}: no LOCK_HANDLE in response`);
  return handle;
}

/** Unlock; best-effort (a failed unlock times out server-side eventually). */
async function unlock(session, objUri, handle) {
  try {
    const res = await session.request("POST", `${objUri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`, { body: "" });
    await res.text();
  } catch {
    // lock expires server-side; surfacing an unlock failure would mask the
    // real result of the write that preceded it
  }
}

/** PUT new source under a held lock. */
async function putSource(session, sourceUri, handle, sourceCode, transport) {
  const params = new URLSearchParams({ lockHandle: handle });
  if (transport) params.set("corrNr", transport);
  const res = await session.request("PUT", `${sourceUri}?${params}`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "application/xml, */*" },
    body: sourceCode,
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`source update failed: HTTP ${res.status} (${firstMessage(text) ?? text.slice(0, 200)})`);
  }
}

/** update_source: lock -> PUT {uri}/source/main -> unlock. */
export async function updateSource(session, { object_name, object_type, source_code, transport_request }) {
  const t = String(object_type ?? "").toUpperCase();
  const uriFn = OBJECT_URI[t];
  if (!uriFn) throw new Error(`update_source: unsupported object_type ${object_type}`);
  if (typeof source_code !== "string" || !source_code.trim()) {
    throw new Error("update_source: source_code is required");
  }
  const objUri = uriFn(object_name);
  await session.ensureFreshCsrf();
  const handle = await lock(session, objUri);
  try {
    await putSource(session, `${objUri}/source/main`, handle, source_code, transport_request);
  } finally {
    await unlock(session, objUri, handle);
  }
  return { updated: true, object_name: String(object_name).toUpperCase(), object_type: t };
}

/** create_or_update_test_class: lock class -> PUT includes/testclasses -> unlock. */
export async function createOrUpdateTestClass(session, { class_name, test_source, transport_request }) {
  if (!class_name) throw new Error("create_or_update_test_class: class_name is required");
  if (typeof test_source !== "string" || !test_source.trim()) {
    throw new Error("create_or_update_test_class: test_source is required");
  }
  const objUri = OBJECT_URI.CLAS(class_name);
  await session.ensureFreshCsrf();
  const handle = await lock(session, objUri);
  try {
    await putSource(session, `${objUri}/includes/testclasses`, handle, test_source, transport_request);
  } finally {
    await unlock(session, objUri, handle);
  }
  return { created: true, class_name: String(class_name).toUpperCase() };
}

/** SCGR object-reference body for a service-binding publish job (G10). @param {string} name @returns {string} */
export function publishBody(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
<adtcore:objectReference adtcore:name="${escapeXml(String(name).toUpperCase())}" adtcore:type="SCGR"/>
</adtcore:objectReferences>`;
}

/** OData protocol (V2|V4) of a service binding from its config XML; defaults to V4. @param {string} configXml @returns {"V2"|"V4"} */
export function bindingProtocol(configXml) {
  const v = findAll(parseAdtXml(configXml), "binding")
    .map((b) => String(attr(b, "version") ?? "").toUpperCase())
    .find((x) => x === "V2" || x === "V4");
  return v ?? "V4";
}

/** Protocol-correct publish-job URL (V2 carries servicename/serviceversion). @param {string} name @param {"V2"|"V4"} protocol @returns {string} */
export function publishUrl(name, protocol) {
  const base = PUBLISH[protocol] ?? PUBLISH.V4;
  const nm = String(name).toUpperCase();
  return protocol === "V2" ? `${base}?servicename=${encodeURIComponent(nm)}&serviceversion=0001` : base;
}

/**
 * Publish an ALREADY-ACTIVATED service binding's OData service (registers the service group so the
 * service is reachable). Publish is SEPARATE from and runs AFTER repository activation (see
 * activateObject) — a binding must be active first. Reads the binding to route to the protocol-
 * correct endpoint (V4 vs V2). The published service URL + a $metadata reachability probe are the
 * delivery proof; the exact service-group URL comes from ADT discovery on a live DEV tier, so that
 * proof is captured by the evaluator on the live run (offline this returns the publish status).
 * @param {object} session @param {{object_name: string}} params
 */
export async function publishServiceBinding(session, { object_name }) {
  if (!object_name) throw new Error("publish: object_name (the service binding) is required");
  const name = String(object_name).toUpperCase();
  await session.ensureFreshCsrf();
  const cfg = await session.request("GET", OBJECT_URI.SRVB(object_name), { headers: { Accept: "application/xml, */*" } });
  const protocol = bindingProtocol(await cfg.text());
  const res = await session.request("POST", publishUrl(name, protocol), {
    headers: { "Content-Type": "application/xml", Accept: "application/xml, */*" },
    body: publishBody(object_name),
  });
  const text = await res.text();
  if (![200, 201, 202].includes(res.status)) {
    throw new Error(`publish ${name} (SRVB, ${protocol}) failed: HTTP ${res.status} (${firstMessage(text) ?? text.slice(0, 200)})`);
  }
  return { published: true, service_binding: name, protocol, http_status: res.status };
}

/** Extract SAP's human-readable error message from an exception XML body. */
function firstMessage(text) {
  try {
    const doc = parseAdtXml(text);
    return findAll(doc, "message")[0]?.["#text"] ?? findAll(doc, "localizedMessage")[0]?.["#text"];
  } catch {
    return undefined;
  }
}
