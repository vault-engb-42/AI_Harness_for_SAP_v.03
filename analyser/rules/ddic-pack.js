import { ABAPObject } from "@abaplint/core";
import { objectsOf } from "../src/abaplint-loader.js";
import { classifyNamespace } from "../src/namespace.js";

/**
 * DDIC rule pack — checks over abapGit-serialized dictionary objects
 * (TABL / DTEL / DOMA XML), the surface that unblocked the PERF-49/50/52/53/55
 * parity deferrals. Shapes verified against the installed @abaplint/core
 * parser (DD02V tableCategory, DD03P KEYFLAG fields, DD04V domainName,
 * DD01V conversionExit).
 *
 * PERF-49/50 are documented approximations (see PARITY.md): the "hot SELECT
 * projection" and "same label" halves of the TALOS rules need usage/catalog
 * data the bundle does not carry.
 */

const DB_WRITE_STMTS = new Set(["InsertDatabase", "UpdateDatabase", "ModifyDatabase", "DeleteDatabase"]);
const DB_WRITE_TARGET_RE = /^(?:INSERT(?:\s+INTO)?|UPDATE|MODIFY(?:\s+TABLE)?|DELETE(?:\s+FROM)?)\s+(\w+)/i;

export const ddicPack = {
  id: "ddic-pack",
  family: "ddic-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    const objects = objectsOf(ctx.reg);
    const domains = new Map();
    for (const o of objects) {
      if (o.getType?.() === "DOMA") domains.set(o.getName(), o);
    }
    const writtenTables = collectDbWriteTargets(objects);

    for (const obj of objects) {
      const type = obj.getType?.();
      if (type === "TABL") checkTable(obj, writtenTables, findings);
      else if (type === "DTEL") checkDataElement(obj, domains, findings);
    }
    return findings;
  },
};

/** Tables written by in-bundle DML (statement scan over ABAP objects). */
function collectDbWriteTargets(objects) {
  const written = new Set();
  for (const obj of objects) {
    if (!(obj instanceof ABAPObject)) continue;
    for (const file of obj.getABAPFiles()) {
      for (const st of file.getStatements()) {
        if (!DB_WRITE_STMTS.has(st.get()?.constructor?.name)) continue;
        const m = DB_WRITE_TARGET_RE.exec(st.concatTokens());
        if (m) written.add(m[1].toUpperCase());
      }
    }
  }
  return written;
}

function checkTable(obj, writtenTables, findings) {
  const name = obj.getName();
  const file = obj.getFiles()[0]?.getFilename();
  const mk = (rule_id, severity, message, family) =>
    findings.push({ rule_id, severity, object: name, object_type: "TABL", file, line: 1, message, family });

  const category = obj.getTableCategory?.();
  if (category === "CLUSTER" || category === "POOL") {
    mk("talos-tabl-cluster-pool", "priority-1", `table ${name} is declared ${category} — cluster/pool tables are deprecated for S/4HANA cloud; convert to a transparent table (ABAP-PERF-53)`, "deprecation");
  }

  if (category === "TRANSP") {
    const fields = obj.parsedData?.fields ?? [];
    const keyFields = fields.filter((f) => f.KEYFLAG === "X").map((f) => String(f.FIELDNAME).toUpperCase());
    const nonClientKeys = keyFields.filter((k) => k !== "MANDT" && k !== ".INCLUDE");
    if (fields.length > 0 && nonClientKeys.length === 0) {
      mk("talos-tabl-low-cardinality-key", "priority-2", `table ${name}'s primary key is client-only — every row shares one lock granularity, forcing table-level lock escalation (ABAP-PERF-55)`, "performance");
    }
  }

  // Buffering flags are not in abaplint's parsedData — read the raw DD02V.
  const raw = obj.getFiles()[0]?.getRaw?.() ?? "";
  const buffered = /<(?:BUFALLOW|PUFFERUNG)>X<\//.test(raw);
  if (buffered && writtenTables.has(name)) {
    mk("talos-tabl-buffered-write", "priority-2", `buffered table ${name} is written by in-bundle DML — every write invalidates the buffer on all servers; reconsider the buffering mode or route writes elsewhere (ABAP-PERF-52)`, "performance");
  }
}

function checkDataElement(obj, domains, findings) {
  const name = obj.getName();
  const file = obj.getFiles()[0]?.getFilename();
  const domainName = obj.getDomainName?.();
  if (!domainName) return;
  const mk = (rule_id, severity, message, family) =>
    findings.push({ rule_id, severity, object: name, object_type: "DTEL", file, line: 1, message, family });

  const domain = domains.get(String(domainName).toUpperCase());
  const convexit = domain?.getConversionExit?.();
  if (convexit) {
    mk("talos-dtel-conversion-exit", "priority-3", `data element ${name} rides domain ${domainName} with conversion exit ${convexit} — a SELECT projecting it cannot push conversion to the database (ABAP-PERF-49; usage-site analysis needs DFG)`, "performance");
  }

  const dtelNs = classifyNamespace(name);
  const domNs = classifyNamespace(domainName);
  if ((dtelNs === "Z" || dtelNs === "Y") && domNs === "sap") {
    mk("talos-dtel-duplicates-sap", "info", `custom data element ${name} is typed directly on SAP domain ${domainName} — check whether a SAP-delivered data element already covers it (ABAP-PERF-50)`, "clean-core");
  }
}
