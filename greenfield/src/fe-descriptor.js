/**
 * G12 — Fiori Elements app-project descriptor gate. Validates a generated `manifest.json`
 * (the FE app descriptor) as a NON-ATC, offline, deterministic check: the app must be a valid
 * FE descriptor bound to the published SRVB OData service — a List Report + Object Page over a
 * main entitySet that is the G6 ZC_ projection. Mirrors the cloud-linter's {findings, errorCount,
 * warningCount} shape. Greenfield-only; never the analyser, never SAP.
 */

const summary = (findings) => ({
  findings,
  errorCount: findings.filter((f) => f.severity === "error").length,
  warningCount: findings.filter((f) => f.severity === "warning").length,
});

/**
 * A routing target's declared main entity: {name, matchable}, or null if it declares none. FE V4
 * targets use settings.entitySet OR settings.contextPath (the UI5>=1.94 default). A single-segment
 * contextPath (/Travel) is the root entity and MUST match the projection; a multi-segment navigation
 * contextPath (/Travel/_Booking) targets a nav entity and is NOT forced to equal the root (matchable:false).
 */
function targetEntity(settings) {
  if (!settings || typeof settings !== "object") return null;
  if (settings.entitySet) return { name: String(settings.entitySet), matchable: true };
  const cp = typeof settings.contextPath === "string" ? settings.contextPath.trim() : "";
  const segs = cp.replace(/^\/+/, "").split("/").filter(Boolean);
  if (!segs.length) return null;
  return { name: segs[segs.length - 1], matchable: segs.length === 1 };
}

/**
 * @param {{manifest: object|string, entity?: string, service?: string}} input
 *   manifest — the FE descriptor (object or JSON string); entity — the expected main entitySet
 *   (the G6 projection's exposed entity); service — a service name the dataSource URI must reference.
 * @returns {{findings: object[], errorCount: number, warningCount: number}}
 */
export function validateFeDescriptor({ manifest, entity, service } = {}) {
  const findings = [];
  const err = (rule_id, message) => findings.push({ rule_id, severity: "error", message });
  const warn = (rule_id, message) => findings.push({ rule_id, severity: "warning", message });

  let m = manifest;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      err("fe-manifest-invalid-json", "manifest.json is not valid JSON");
      return summary(findings);
    }
  }
  if (!m || typeof m !== "object") {
    err("fe-manifest-invalid", "the FE descriptor must be a JSON object");
    return summary(findings);
  }

  const app = m["sap.app"];
  const ui5 = m["sap.ui5"];
  if (!app || typeof app !== "object") err("fe-manifest-no-sap-app", "descriptor missing the sap.app section");
  if (!ui5 || typeof ui5 !== "object") err("fe-manifest-no-sap-ui5", "descriptor missing the sap.ui5 section");

  // dataSource -> the published SRVB OData service
  const dataSources = app?.dataSources ?? {};
  const odata = Object.entries(dataSources).filter(([, ds]) => String(ds?.type ?? "").toUpperCase() === "ODATA");
  if (!odata.length) {
    err("fe-no-odata-datasource", "sap.app.dataSources has no OData dataSource — the FE app must bind to the published SRVB OData service");
  }
  const modelDs = ui5?.models?.[""]?.dataSource;
  if (odata.length && !modelDs) warn("fe-model-no-datasource", "the default UI5 model does not reference a dataSource");
  if (odata.length && modelDs && !dataSources[modelDs]) err("fe-model-datasource-unresolved", `the default model references dataSource '${modelDs}', which is not defined`);
  if (service && odata.length && !odata.some(([, ds]) => String(ds?.uri ?? "").toLowerCase().includes(String(service).toLowerCase()))) {
    err("fe-datasource-wrong-service", `no OData dataSource URI references the generated service '${service}'`);
  }

  // FE floorplans: List Report + Object Page (annotation-driven, no hand-written view code)
  const targets = ui5?.routing?.targets ?? {};
  const targetNames = Object.values(targets).map((t) => String(t?.name ?? ""));
  if (!targetNames.some((n) => /sap\.fe\.templates\.ListReport/i.test(n))) err("fe-no-list-report", "no sap.fe.templates.ListReport routing target — the List Report floorplan is required");
  if (!targetNames.some((n) => /sap\.fe\.templates\.ObjectPage/i.test(n))) err("fe-no-object-page", "no sap.fe.templates.ObjectPage routing target — the Object Page floorplan is required");

  // Main entity — present, and EVERY floorplan target must bind the generated projection (a single
  // correct target must not mask an Object Page wrongly bound to the ZI_ interface view). A target
  // declares its entity via settings.entitySet OR settings.contextPath (see targetEntity).
  const declared = Object.values(targets)
    .map((t) => targetEntity(t?.options?.settings))
    .filter(Boolean);
  if (!declared.length) {
    err("fe-no-entityset", "no routing target declares a main entitySet or contextPath — Fiori Elements needs one to render");
  } else if (entity) {
    const mismatched = declared.filter((d) => d.matchable && d.name.toLowerCase() !== String(entity).toLowerCase());
    if (mismatched.length) {
      err("fe-entityset-projection-mismatch", `these FE targets bind an entity that is not the generated projection '${entity}': [${mismatched.map((d) => d.name).join(", ")}] — the UI must target the ZC_ consumption view, never the ZI_ interface view`);
    }
  }

  return summary(findings);
}
