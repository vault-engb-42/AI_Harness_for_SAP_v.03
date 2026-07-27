import { objNameOf } from "./cloud-linter-checks.js";
import { isDdls, parseCdsEntity } from "./cds-checks.js";
import { isBdef, parseBdefHeader } from "./rap-checks.js";

/**
 * G8 — RAP object-naming convention checks for greenfield's ABAP-Cloud linter. Raw-source, reusing
 * the CDS view-entity parser (cds-checks) and the BDEF header parser (rap-checks) so the naming
 * facts are never re-derived. SAP's RAP virtual-data-model convention, mirrored by the harness's own
 * templates: the interface / data-model CDS view is ZI_*, the consumption / projection view is ZC_*,
 * and the behaviour implementation class (pool) is ZBP_*. All WARNING severity — a naming deviation
 * is a style / consistency issue, not an activation or Clean-Core failure.
 */

// The ZI_/ZC_/ZBP_ convention is a customer-namespace rule (names starting Z or Y). A name outside
// that namespace is namespace hygiene — a separate concern, not judged here.
const CUSTOMER_NS_RE = /^[ZY]/i;

/**
 * gf-x-naming-cds-* — the interface / data-model view entity is ZI_*, the consumption / projection
 * view entity is ZC_*. Only customer-namespace (Z or Y) view entities are judged. Classic
 * `define view` (no entity) and `extend view entity` are not view-entity definitions
 * (parseCdsEntity → null) and are skipped.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function cdsNamingFindings(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => isDdls(f?.filename));
  const findings = [];
  const emit = (rule_id, filename, message) =>
    findings.push({ rule_id, severity: "warning", object: objNameOf(filename), object_type: "DDLS", file: filename, line: 1, message, family: "naming" });
  for (const f of list) {
    const e = parseCdsEntity(f);
    if (!e || !CUSTOMER_NS_RE.test(e.name)) continue;
    if (e.isProjection) {
      if (!/^ZC_/i.test(e.name)) emit("gf-x-naming-cds-projection", f.filename, `the consumption/projection view ${e.name} should be named ZC_* (RAP consumption-layer convention)`);
    } else if (!/^ZI_/i.test(e.name)) {
      emit("gf-x-naming-cds-interface", f.filename, `the interface/data-model view ${e.name} should be named ZI_* (RAP interface-layer convention)`);
    }
  }
  return findings;
}

/**
 * gf-x-naming-behavior-pool — the RAP behaviour implementation class (the pool named in
 * `implementation in class …`) is ZBP_* by convention. Only a customer-namespace (Z or Y) class is
 * judged; a projection BDEF with no implementation class, or a class outside the customer namespace,
 * is skipped.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function bdefImplClassNamingFindings(files) {
  const list = Array.isArray(files) ? files : [];
  const findings = [];
  for (const f of list) {
    if (!isBdef(f.filename)) continue;
    const { implClass } = parseBdefHeader(f.source);
    if (!implClass || !CUSTOMER_NS_RE.test(implClass) || /^ZBP_/i.test(implClass)) continue;
    findings.push({ rule_id: "gf-x-naming-behavior-pool", severity: "warning", object: objNameOf(f.filename), object_type: "BDEF", file: f.filename, line: 1, message: `the behaviour implementation class ${implClass} should be named ZBP_* (RAP behaviour-pool convention)`, family: "naming" });
  }
  return findings;
}
