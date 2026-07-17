import { parseAdtXml, findAll, attr } from "../lib/adt-xml.js";
import { OBJECT_URI } from "../lib/adt-uris.js";

/**
 * ABAP Unit runner (AUnit v1 API) + statement-coverage collection. Split out of quality.js
 * to keep both files under the 300-line limit. The coverage figure feeds the Karpathy ratchet
 * (`.claude/state/abapunit-baseline.json` `coverage_floor_pct`, only-up) that the
 * abap-evaluator owns — before this, run_unit_tests hardcoded `measurements type="none"` and
 * the ratchet had no data source. NO synthetic fallback: a failed/absent run never fakes green.
 */

/**
 * Build the AUnit v1 run request. `withCoverage` turns statement coverage on via the
 * <aunit:measurements> element. NOTE: the v1 enabling token is LIKELY "statement" (SAP's
 * documented default granularity) but is not publicly confirmed for the v1 API. If a live
 * run shows v1 does not surface coverage this way, the fully-documented path is the classic
 * /sap/bc/adt/abapunit/testruns API with <external><coverage active="true"/></external> plus
 * a two-step fetch at /sap/bc/adt/runtime/traces/coverage/measurements/{id} — coveragePercent
 * below reads that SAME node shape, so only the request/fetch wiring would change, not the parse.
 * @param {string} objectUri @param {boolean} withCoverage @returns {string}
 */
export function aunitRunBody(objectUri, withCoverage) {
  const measurements = withCoverage ? "statement" : "none";
  return `<?xml version="1.0" encoding="UTF-8"?>
<aunit:run title="harness run" context="harness sidecar" xmlns:aunit="http://www.sap.com/adt/api/aunit">
<aunit:options>
<aunit:measurements type="${measurements}"/>
<aunit:scope ownTests="true" foreignTests="false"/>
<aunit:riskLevel harmless="true" dangerous="true" critical="true"/>
<aunit:duration short="true" medium="true" long="true"/>
</aunit:options>
<osl:objectSet xsi:type="unionSet" xmlns:osl="http://www.sap.com/api/osl" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<osl:set xsi:type="osl:objectSet"><osl:objects><osl:object><osl:adtObjectRef xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="${objectUri}"/></osl:object></osl:objects></osl:set>
</osl:objectSet>
</aunit:run>`;
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Run-level statement coverage % from an ABAP Coverage response, or null if not measured.
 * The response is HIERARCHICAL (nodes > node > coverages > coverage): every parent <node>
 * carries its OWN aggregate PLUS its child nodes, so summing every <coverage> would count each
 * statement once per ANCESTOR level (skewing any depth-unbalanced tree). This sums only LEAF
 * nodes (a <node> with no child <node>) — each statement counts once, a true count-weighted
 * run-level ratio (Σexecuted/Σtotal), never an average-of-averages. A response with no <node>
 * hierarchy falls back to the <coverage> nodes directly. Aggregation matches SAP / abap-adt-api
 * (pacroy CheckCodeCoverage: recurse to leaves, accumulate once). @param {string} xml @returns {number|null}
 */
export function coveragePercent(xml) {
  const doc = parseAdtXml(xml);
  const nodes = findAll(doc, "node");
  const covNodes = nodes.length
    ? nodes.filter((n) => !n?.nodes?.node).flatMap((leaf) => asArray(leaf?.coverages?.coverage))
    : findAll(doc, "coverage");
  let total = 0;
  let executed = 0;
  for (const c of covNodes) {
    if ((attr(c, "type") ?? "").toLowerCase() !== "statement") continue;
    total += Number(attr(c, "total") ?? 0);
    executed += Number(attr(c, "executed") ?? 0);
  }
  return total > 0 ? Math.round((executed / total) * 100) : null;
}

/** run_unit_tests: AUnit v1 API (own CSRF fetch) — NO synthetic fallback. */
export async function runUnitTests(session, { object_name, object_type, with_coverage } = {}) {
  const type = String(object_type ?? "CLAS").toUpperCase();
  const uriFn = OBJECT_URI[type];
  if (!uriFn) throw new Error(`run_unit_tests: unsupported object_type ${object_type}`);
  const csrfRes = await session.request("GET", "/sap/bc/adt/api/abapunit/runs/00000000000000000000000000000000", {
    headers: { Accept: "application/vnd.sap.adt.api.abapunit.run-status.v1+xml", "x-csrf-token": "fetch" },
  });
  await csrfRes.text();
  const start = await session.request("POST", "/sap/bc/adt/api/abapunit/runs", {
    headers: { "Content-Type": "application/vnd.sap.adt.api.abapunit.run.v1+xml" },
    body: aunitRunBody(uriFn(object_name), with_coverage === true),
  });
  await start.text();
  if (start.status !== 201) throw new Error(`run_unit_tests: run start failed HTTP ${start.status}`);
  const location = start.headers.get("location");
  if (!location) throw new Error("run_unit_tests: no Location header on 201");
  return await pollUnitRun(session, location);
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
      // coverage_pct is null unless coverage was requested AND the response carries the node
      // (see aunitRunBody's live-confirmation note) — absent coverage is "not measured", not 0%.
      return { results, coverage_pct: coveragePercent(text) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("run_unit_tests: polling timed out after 60s");
}
