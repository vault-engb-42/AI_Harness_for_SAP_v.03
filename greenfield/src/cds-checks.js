import { objNameOf } from "./cloud-linter-checks.js";

/**
 * CDS-structural checks for greenfield's ABAP-Cloud linter. Raw-source checks over the
 * generated DDLS (CDS view entities) + DDLX (metadata extensions) — greenfield's own code,
 * never the analyser. G6 (@UI Fiori-Elements readiness) lives here; G9's CDS-graph rules
 * (composition ↔ to-parent, projection ↔ interface) will ride the same module.
 */

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DDLS_RE = /\.ddls(?:\.asddls)?$/i;
const DDLX_RE = /\.ddlx(?:\.asddlx)?$/i;

/** @param {string} filename @returns {boolean} a CDS DDL source (view entity) */
export function isDdls(filename) {
  return DDLS_RE.test(String(filename ?? ""));
}
/** @param {string} filename @returns {boolean} a CDS metadata extension (DDLX) */
export function isDdlx(filename) {
  return DDLX_RE.test(String(filename ?? ""));
}

// The minimum @UI set for a Fiori Elements List Report + Object Page to render with no
// hand-written UI. These annotation names appear only in an @UI context in CDS.
const UI_MIN_SET = [
  { key: "headerInfo", label: "@UI.headerInfo", re: /\bheaderInfo\b/i },
  { key: "lineItem", label: "@UI.lineItem", re: /\blineItem\b/i },
  { key: "selectionField", label: "@UI.selectionField", re: /\bselectionField\b/i },
  { key: "objectPage", label: "@UI.facet / @UI.identification", re: /\b(?:facet|identification)\b/i },
];
const HAS_UI_RE = /@UI\b/;
const PROJECTION_RE = /\bas\s+projection\s+on\b/i;

/**
 * gf-x-ui-fe-readiness (G6) — a consumption/projection CDS view that carries @UI annotations
 * (so it is UI-intended) but is MISSING part of the minimum Fiori-Elements set. The @UI may
 * live inline on the projection OR in a companion DDLX metadata extension (S3) — both are
 * aggregated by the annotated view name. A projection with NO @UI at all is not flagged here
 * (it may back a Web-API service; authoring @UI is the generator's contract, not this gate's).
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function uiFeReadinessFindings(files) {
  const list = Array.isArray(files) ? files : [];
  const ddlx = list.filter((f) => isDdlx(f.filename));
  const findings = [];
  for (const f of list) {
    if (!isDdls(f.filename)) continue;
    const own = String(f.source ?? "");
    if (!PROJECTION_RE.test(own)) continue; // only consumption/projection views carry the @UI contract
    const viewName = own.match(/define\s+view\s+entity\s+([\w/]+)/i)?.[1] ?? objNameOf(f.filename);
    const ext = ddlx
      .filter((d) => new RegExp(`annotate\\s+(?:view\\s+)?(?:entity\\s+)?${escapeRe(viewName)}\\b`, "i").test(String(d.source ?? "")))
      .map((d) => String(d.source ?? ""))
      .join("\n");
    const aggregated = `${own}\n${ext}`;
    if (!HAS_UI_RE.test(aggregated)) continue; // no @UI anywhere → not a UI-facing view
    const missing = UI_MIN_SET.filter((m) => !m.re.test(aggregated));
    if (missing.length) {
      findings.push({
        rule_id: "gf-x-ui-fe-readiness",
        severity: "error",
        object: objNameOf(f.filename),
        object_type: "DDLS",
        file: f.filename,
        line: 1,
        message: `the projection view ${viewName} is UI-intended (@UI present) but incomplete for Fiori Elements — missing ${missing.map((m) => m.label).join(", ")}; a List Report + Object Page will not render without them (put the @UI inline or in a DDLX)`,
        family: "fiori-ui",
      });
    }
  }
  return findings;
}
