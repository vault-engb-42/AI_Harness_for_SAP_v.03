import { escapeXml, parseAdtXml, findAll, attr } from "../lib/adt-xml.js";
import { OBJECT_URI, ACTIVATION, ATC_SOURCE_URI } from "../lib/adt-uris.js";

/**
 * Quality-gate tools: syntax check, activation (single/batch), ATC, ABAP
 * Unit, migration analysis. Faithful to the spec's endpoints/payloads with
 * the deliberate divergences the spec mandated:
 *   - run_atc_check errors PROPAGATE (upstream swallowed them into [] — a
 *     failed ATC run must never look like a clean one; P6 fail-closed)
 *   - run_unit_tests has NO synthetic-success fallback
 *   - get_migration_analysis surfaces errors (upstream fabricated mock
 *     analysis on failure — poisonous for P2 grounding)
 */

const LINE_RE = /#start=(\d+)/;

function lineOf(uri) {
  const m = LINE_RE.exec(uri ?? "");
  return m ? Number(m[1]) : 0;
}

/** check_syntax: POST /sap/bc/adt/checkruns (inactive server-side version). */
export async function checkSyntax(session, { object_name, object_type }) {
  const type = String(object_type ?? "").toUpperCase();
  const uriFn = OBJECT_URI[type];
  if (!uriFn) throw new Error(`check_syntax: unsupported object_type ${object_type}`);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<chkrun:checkObjectList xmlns:adtcore="http://www.sap.com/adt/core" xmlns:chkrun="http://www.sap.com/adt/checkrun">
<chkrun:checkObject adtcore:uri="${uriFn(object_name)}" chkrun:version="inactive"/>
</chkrun:checkObjectList>`;
  await session.ensureFreshCsrf();
  const res = await session.request("POST", "/sap/bc/adt/checkruns?reporters=abapCheckRun", {
    headers: {
      "Content-Type": "application/vnd.sap.adt.checkobjects+xml",
      Accept: "application/vnd.sap.adt.checkmessages+xml",
    },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`check_syntax ${object_name} failed: HTTP ${res.status} (${text.slice(0, 200)})`);
  }
  const errors = [];
  const warnings = [];
  for (const msg of findAll(parseAdtXml(text), "checkMessage")) {
    const entry = { line: lineOf(attr(msg, "uri")), message: attr(msg, "shortText") ?? "" };
    const t = (attr(msg, "type") ?? "").toUpperCase();
    if (t === "E" || t === "A") errors.push(entry);
    else if (t === "W") warnings.push(entry);
  }
  return { object_name, object_type: type, has_errors: errors.length > 0, errors, warnings };
}

/** Shared activation-result parsing (spec: _parse_activation_result). */
function parseActivation(text) {
  const doc = parseAdtXml(text);
  const errors = [];
  const warnings = [];
  for (const msg of findAll(doc, "msg")) {
    const line = lineOf(attr(msg, "href"));
    const txt = findAll(msg, "txt")[0]?.["#text"] ?? attr(msg, "shortText") ?? "";
    const entry = `Line ${line}: ${txt}`;
    const t = (attr(msg, "type") ?? "").toUpperCase();
    if (t === "E" || t === "A") errors.push(entry);
    else if (t === "W") warnings.push(entry);
  }
  const props = findAll(doc, "property");
  let activated = true;
  for (const p of props) {
    if ((attr(p, "name") ?? "").toLowerCase().includes("activationexecuted")) {
      activated = String(p["#text"]).toLowerCase() !== "false";
    }
  }
  return { success: errors.length === 0 && activated, errors, warnings };
}

/** activate_object: POST /sap/bc/adt/activation?method=activate. */
export async function activateObject(session, { object_name, object_type }) {
  const type = String(object_type ?? "").toUpperCase();
  const act = ACTIVATION[type];
  if (!act) throw new Error(`activate_object: unsupported object_type ${object_type}`);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
<adtcore:objectReference adtcore:uri="${act.uri(object_name)}" adtcore:name="${escapeXml(String(object_name).toUpperCase())}"/>
</adtcore:objectReferences>`;
  await session.ensureFreshCsrf();
  const res = await session.request("POST", "/sap/bc/adt/activation?method=activate&preauditRequested=true", {
    headers: { "Content-Type": "application/xml", Accept: "application/xml" },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`activate_object ${object_name} failed: HTTP ${res.status} (${text.slice(0, 200)})`);
  }
  const parsed = parseActivation(text);
  return { ...parsed, activated_count: parsed.success ? 1 : 0 };
}

/** activate_objects_batch: POST /sap/bc/adt/activation/runs + long-poll. */
export async function activateObjectsBatch(session, { objects }) {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new Error("activate_objects_batch: objects[] is required");
  }
  const refs = objects
    .map((o) => {
      const act = ACTIVATION[String(o.object_type ?? "").toUpperCase()];
      if (!act) throw new Error(`activate_objects_batch: unsupported object_type ${o.object_type}`);
      return `<adtcore:objectReference adtcore:uri="${act.uri(o.object_name)}" adtcore:type="${act.type}" adtcore:name="${escapeXml(String(o.object_name).toUpperCase())}"/>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
${refs}
</adtcore:objectReferences>`;
  await session.ensureFreshCsrf();
  const res = await session.request("POST", "/sap/bc/adt/activation/runs?method=activate&preauditRequested=false", {
    headers: { "Content-Type": "application/xml", Accept: "application/xml" },
    body,
  });
  const text = await res.text();
  if (res.status === 200) {
    const parsed = parseActivation(text);
    return { ...parsed, activated_count: parsed.success ? objects.length : 0 };
  }
  if (res.status !== 201) {
    throw new Error(`activate_objects_batch failed: HTTP ${res.status} (${text.slice(0, 200)})`);
  }
  const location = res.headers.get("location");
  if (!location) throw new Error("activate_objects_batch: no Location header on 201");
  for (let i = 0; i < 30; i++) {
    const poll = await session.request("GET", `${location}?withLongPolling=true`, {
      headers: { Accept: "application/xml, application/vnd.sap.adt.backgroundrun.v1+xml" },
    });
    const pollText = await poll.text();
    if (/status="finished"/i.test(pollText) || findAll(parseAdtXml(pollText), "msg").length > 0) {
      const parsed = parseActivation(pollText);
      return { ...parsed, activated_count: parsed.success ? objects.length : 0 };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("activate_objects_batch: polling timed out after 30s");
}

/** run_atc_check: worklist -> run -> poll -> worklist findings (5-step). */
export async function runAtcCheck(session, { object_name, object_type, package_name, check_variant } = {}) {
  await session.ensureFreshCsrf();
  const variant = check_variant ?? "ABAP_CLEAN_CORE_DEVELOPMENT";
  const wl = await session.request("POST", `/sap/bc/adt/atc/worklists?checkVariant=${encodeURIComponent(variant)}`, {
    headers: { Accept: "text/plain" },
    body: "",
  });
  const worklistId = (await wl.text()).trim();
  if (wl.status !== 200 || !worklistId) {
    throw new Error(`run_atc_check: worklist creation failed HTTP ${wl.status} (${worklistId.slice(0, 200)})`);
  }
  const uri = package_name
    ? `/sap/bc/adt/repository/informationsystem/virtualfolders?selection=package%3a${encodeURIComponent(package_name)}`
    : ATC_SOURCE_URI[String(object_type ?? "").toUpperCase()]?.(object_name);
  if (!uri) throw new Error(`run_atc_check: need package_name or a supported object_type (got ${object_type})`);
  const runBody = `<?xml version="1.0" encoding="UTF-8"?>
<atc:run maximumVerdicts="100" xmlns:atc="http://www.sap.com/adt/atc">
<objectSets xmlns:adtcore="http://www.sap.com/adt/core">
<objectSet kind="inclusive"><adtcore:objectReferences><adtcore:objectReference adtcore:uri="${uri}"/></adtcore:objectReferences></objectSet>
</objectSets>
</atc:run>`;
  const run = await session.request("POST", `/sap/bc/adt/atc/runs?worklistId=${worklistId}&clientWait=false`, {
    headers: { "Content-Type": "application/xml", Accept: "application/xml" },
    body: runBody,
  });
  await run.text();
  if (run.status !== 200 && run.status !== 201) {
    throw new Error(`run_atc_check: run start failed HTTP ${run.status}`);
  }
  const findings = await pollAtcWorklist(session, worklistId);
  return { findings };
}

async function pollAtcWorklist(session, worklistId) {
  for (let i = 0; i < 150; i++) {
    const res = await session.request("GET", `/sap/bc/adt/atc/worklists/${worklistId}?includeExemptedFindings=false`, {
      headers: { Accept: "application/atc.worklist.v1+xml, application/xml" },
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`run_atc_check: worklist read failed HTTP ${res.status}`);
    const doc = parseAdtXml(text);
    const complete = !/atcworklist:status="RUNNING"/i.test(text);
    if (complete) {
      return findAll(doc, "finding").map((f) => ({
        check_id: attr(f, "checkId") ?? attr(f, "checkTitle") ?? "atc",
        message: attr(f, "messageTitle") ?? "",
        object_name: (attr(f, "location") ?? attr(f, "uri") ?? "").split("/").filter(Boolean).slice(-3, -2)[0] ?? "",
        object_type: "",
        line: lineOf(attr(f, "location") ?? attr(f, "uri")),
        column: 0,
        priority: Number(attr(f, "priority") ?? 3),
        category: attr(f, "checkTitle") ?? "",
        quickfix_available: false,
      }));
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("run_atc_check: polling timed out after 300s");
}

/** run_unit_tests: AUnit v1 API (own CSRF fetch) — NO synthetic fallback. */
export async function runUnitTests(session, { object_name, object_type } = {}) {
  const type = String(object_type ?? "CLAS").toUpperCase();
  const uriFn = OBJECT_URI[type];
  if (!uriFn) throw new Error(`run_unit_tests: unsupported object_type ${object_type}`);
  const csrfRes = await session.request("GET", "/sap/bc/adt/api/abapunit/runs/00000000000000000000000000000000", {
    headers: { Accept: "application/vnd.sap.adt.api.abapunit.run-status.v1+xml", "x-csrf-token": "fetch" },
  });
  await csrfRes.text();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:run title="harness run" context="harness sidecar" xmlns:aunit="http://www.sap.com/adt/api/aunit">
<aunit:options>
<aunit:measurements type="none"/>
<aunit:scope ownTests="true" foreignTests="false"/>
<aunit:riskLevel harmless="true" dangerous="true" critical="true"/>
<aunit:duration short="true" medium="true" long="true"/>
</aunit:options>
<osl:objectSet xsi:type="unionSet" xmlns:osl="http://www.sap.com/api/osl" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<osl:set xsi:type="osl:objectSet"><osl:objects><osl:object><osl:adtObjectRef xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="${uriFn(object_name)}"/></osl:object></osl:objects></osl:set>
</osl:objectSet>
</aunit:run>`;
  const start = await session.request("POST", "/sap/bc/adt/api/abapunit/runs", {
    headers: { "Content-Type": "application/vnd.sap.adt.api.abapunit.run.v1+xml" },
    body,
  });
  await start.text();
  if (start.status !== 201) throw new Error(`run_unit_tests: run start failed HTTP ${start.status}`);
  const location = start.headers.get("location");
  if (!location) throw new Error("run_unit_tests: no Location header on 201");
  return { results: await pollUnitRun(session, location) };
}

async function pollUnitRun(session, location) {
  for (let i = 0; i < 60; i++) {
    const res = await session.request("GET", location, {
      headers: { Accept: "application/vnd.sap.adt.api.abapunit.run-status.v1+xml" },
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`run_unit_tests: status read failed HTTP ${res.status}`);
    if (/FINISHED/i.test(text)) {
      const doc = parseAdtXml(text);
      const results = [];
      for (const cls of findAll(doc, "testClass")) {
        const className = attr(cls, "name") ?? "";
        for (const m of findAll(cls, "testMethod")) {
          const alerts = findAll(m, "alert");
          const failed = alerts.some((a) => /failedAssertion|failed/i.test(attr(a, "kind") ?? ""));
          const errored = alerts.length > 0 && !failed;
          results.push({
            class_name: className,
            method_name: attr(m, "name") ?? "",
            status: failed ? "failed" : errored ? "error" : "passed",
            message: alerts.map((a) => findAll(a, "title")[0]?.["#text"] ?? "").filter(Boolean).join("; "),
          });
        }
      }
      return results;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("run_unit_tests: polling timed out after 60s");
}

/** get_migration_analysis: real POST; errors SURFACE (no fabricated data). */
export async function getMigrationAnalysis(session, { object_name, object_type }) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<migration:analysisRequest xmlns:migration="http://www.sap.com/adt/migration" xmlns:adtcore="http://www.sap.com/adt/core">
<migration:object adtcore:name="${escapeXml(object_name)}" adtcore:type="${escapeXml(object_type)}"/>
</migration:analysisRequest>`;
  await session.ensureFreshCsrf();
  const res = await session.request("POST", "/sap/bc/adt/migration/analysis", {
    headers: { "Content-Type": "application/xml", Accept: "application/xml" },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(
      `get_migration_analysis ${object_name} failed: HTTP ${res.status} — this system does not expose /sap/bc/adt/migration/analysis; ` +
        `use the analyser's bundled cloudification registry for readiness instead (${text.slice(0, 150)})`,
    );
  }
  const doc = parseAdtXml(text);
  const findings = [
    ...findAll(doc, "issue").map((i) => ({
      object_name,
      finding_type: (attr(i, "severity") ?? "compatibility_issue").toLowerCase(),
      description: attr(i, "message") ?? i["#text"] ?? "",
      line: Number(attr(i, "line") ?? 0),
    })),
    ...findAll(doc, "recommendation").map((r) => ({
      object_name,
      finding_type: "recommendation",
      description: attr(r, "message") ?? r["#text"] ?? "",
      line: 0,
    })),
  ];
  return { object_name, object_type, findings };
}
