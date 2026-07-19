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
// hand-written UI. Matched in the ANNOTATION-KEY form (`<name>:`) so a CDS element literally
// named `LineItem` / `Identification` is never mistaken for the annotation.
const UI_MIN_SET = [
  { key: "headerInfo", label: "@UI.headerInfo", re: /\bheaderInfo\s*:/i },
  { key: "lineItem", label: "@UI.lineItem", re: /\blineItem\s*:/i },
  { key: "selectionField", label: "@UI.selectionField", re: /\bselectionField\s*:/i },
  { key: "objectPage", label: "@UI.facet / @UI.identification", re: /\b(?:facet|identification)\s*:/i },
];
const HAS_UI_RE = /@UI\b/;
const PROJECTION_RE = /\bas\s+projection\s+on\b/i;

/** Strip CDS line comments (`//…`) and block comments (slash-star … star-slash) so a commented @UI never counts. */
function stripCdsComments(source) {
  return String(source ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

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
  const ddlx = list.filter((f) => isDdlx(f.filename)).map((d) => ({ ...d, source: stripCdsComments(d.source) }));
  const findings = [];
  for (const f of list) {
    if (!isDdls(f.filename)) continue;
    const own = stripCdsComments(f.source);
    if (!PROJECTION_RE.test(own)) continue; // only consumption/projection views carry the @UI contract
    const viewName = own.match(/define\s+view\s+entity\s+([\w/]+)/i)?.[1] ?? objNameOf(f.filename);
    const ext = ddlx
      .filter((d) => new RegExp(`annotate\\s+(?:view\\s+)?(?:entity\\s+)?${escapeRe(viewName)}\\b`, "i").test(d.source))
      .map((d) => d.source)
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

// --- G9: CDS BO-structure integrity over the composition/association graph across all DDLS ---

const VIEW_ENTITY_RE = /\bdefine\s+(root\s+)?view\s+entity\s+([\w/]+)/i;
const PROJECTION_ON_RE = /\bas\s+projection\s+on\s+([\w/]+)/i;
const CDS_KEY_RE = /\bkey\s+[\w/]/i;
const CDS_COMPOSITION_RE = /\bcomposition\s+(?:\[[^\]]*\]\s+)?of\s+([\w/]+)/gi;
const CDS_TO_PARENT_RE = /\bassociation\s+(?:\[[^\]]*\]\s+)?to\s+parent\s+([\w/]+)/i;

// Blank CDS single-quoted string literals ('' is the escaped quote) so a structural keyword inside
// an annotation value (@EndUserText.label: 'Composition of Material', 'the key of everything') is
// never mistaken for real syntax. G9-scoped — the annotation-KEY rules (G6) key off names, not values.
const blankCdsStrings = (s) => String(s).replace(/'(?:[^']|'')*'/g, "''");

// EXTEND VIEW ENTITY (a field/element extension) needs the BASE to declare @AbapCatalog.
// viewEnhancementCategory with a category other than #NONE, and @AbapCatalog.extensibility.extensible
// not false. This is DISTINCT from @Metadata.allowExtensions, which enables DDLX *metadata* (annotation)
// extensions, not field extensions. @param {string} src (comment- + string-blanked) @returns {boolean}
function isViewExtensible(src) {
  const cat = /@AbapCatalog\.viewEnhancementCategory\s*:\s*\[?\s*#(\w+)/i.exec(src);
  if (!cat || cat[1].toUpperCase() === "NONE") return false;
  return !/@AbapCatalog\.extensibility\.extensible\s*:\s*false/i.test(src);
}

/** Parse a DDLS view-entity into its BO-structure facts. String literals are blanked BEFORE comment
 * stripping so a block comment (slash-star … star-slash) straddling annotation strings can't erase a
 * real annotation. @returns {object|null} */
function parseCdsEntity(f) {
  const src = stripCdsComments(blankCdsStrings(f.source ?? ""));
  const dm = VIEW_ENTITY_RE.exec(src);
  if (!dm) return null; // not a view entity (classic `define view` is gf-cds-classic-view's job)
  const proj = PROJECTION_ON_RE.exec(src);
  return {
    filename: f.filename,
    name: dm[2],
    isRoot: Boolean(dm[1]),
    isProjection: Boolean(proj),
    base: proj?.[1] ?? null,
    hasKey: CDS_KEY_RE.test(src),
    compositions: [...src.matchAll(CDS_COMPOSITION_RE)].map((m) => m[1]),
    toParent: CDS_TO_PARENT_RE.exec(src)?.[1] ?? null,
    isExtensible: isViewExtensible(src),
  };
}

/**
 * gf-x-cds-* (G9) — CDS BO-structure integrity resolved across ALL DDLS in one pass: composition ↔
 * to-parent reciprocity (HIGH), a key per node, the composition root marked `root`, and a projection
 * sitting on the interface layer. Registry-fusion rules (dangling / non-entity / orphan targets) are
 * cluster-③ and deferred. @param {Array<{filename: string, source: string}>} files @returns {object[]}
 */
export function cdsStructureFindings(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => isDdls(f?.filename));
  const entities = list.map(parseCdsEntity).filter(Boolean);
  const byName = new Map(entities.map((e) => [e.name.toLowerCase(), e]));
  const findings = [];
  const emit = (rule_id, severity, filename, message) =>
    findings.push({ rule_id, severity, object: objNameOf(filename), object_type: "DDLS", file: filename, line: 1, message, family: "cds-structure" });

  for (const e of entities) {
    if (!e.hasKey) emit("gf-x-cds-node-no-key", "error", e.filename, `the view entity ${e.name} declares no key element — every CDS BO node needs a key`);
    if (e.isProjection && /(?:^|\/)ZC_/i.test(e.base ?? "")) {
      emit("gf-x-cds-projection-not-on-interface", "warning", e.filename, `the projection ${e.name} projects another projection (${e.base}) — a ZC_ consumption view should project the ZI_ interface layer, not a projection`);
    }
    if (e.compositions.length) {
      if (!e.toParent && !e.isRoot) {
        emit("gf-x-cds-root-not-declared", "error", e.filename, `${e.name} composes children and has no parent (a composition root) but is not declared 'define root view entity'`);
      }
      for (const childName of e.compositions) {
        const child = byName.get(childName.toLowerCase());
        if (child && child.toParent?.toLowerCase() !== e.name.toLowerCase()) {
          emit("gf-x-cds-composition-no-back-association", "error", child.filename, `${child.name} is composed by ${e.name} but declares no matching 'association to parent ${e.name}' — a composition child must reciprocate with its to-parent association`);
        }
      }
    }
  }

  // positive extension awareness (G11): an `extend view entity <base>` whose base IS a generated view
  // entity must target a FIELD-extensible base (@AbapCatalog.viewEnhancementCategory, not #NONE, and
  // extensibility.extensible not false) or it will not activate. A base outside the generated set (a
  // released SAP view) cannot be judged offline — not flagged.
  for (const f of list) {
    const ex = /\bextend\s+view\s+entity\s+([\w/]+)/i.exec(stripCdsComments(blankCdsStrings(f.source ?? "")));
    const base = ex && byName.get(ex[1].toLowerCase());
    if (base && !base.isExtensible) {
      emit("gf-x-cds-extend-base-not-extensible", "error", f.filename, `this extends ${base.name}, but ${base.name} is not field-extensible — mark the base with @AbapCatalog.viewEnhancementCategory (e.g. #PROJECTION_LIST) and don't set extensibility.extensible:false, or extend a released extensible view`);
    }
  }
  return findings;
}
