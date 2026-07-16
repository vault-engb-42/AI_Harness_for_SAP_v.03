import { objNameOf } from "./cloud-linter-checks.js";

/**
 * RAP behaviour-structural checks for greenfield's ABAP-Cloud linter. Raw-source,
 * parse-independent checks over the generated `.bdef` + behaviour-pool set — greenfield's
 * own code (it shares only the `@abaplint` LIBRARY for object registration, never the
 * analyser's rule packs). abaplint registers a `.bdef.asbdef` as a BehaviorDefinition but
 * does NOT parse the BDL body, so the BDEF substrate here text-parses the raw source.
 */

// A file is a RAP behaviour pool when it declares a handler/saver on cl_abap_behavior_*
// or carries a `… FOR MODIFY/READ/DETERMINE/…` handler method (unambiguous RAP syntax).
const RAP_POOL_MARKER_RE = /\bINHERITING\s+FROM\s+cl_abap_behavior_(?:handler|saver)\b|\bFOR\s+(?:MODIFY|READ|DETERMINE|VALIDATE|LOCK|FEATURES|GLOBAL\s+AUTHORIZATION|INSTANCE\s+AUTHORIZATION)\b/i;
const COMMIT_ROLLBACK_WORK_RE = /\b(?:COMMIT|ROLLBACK)\s+WORK\b/i;

/**
 * gf-rap-no-commit-in-pool (P4(b)) — explicit `COMMIT WORK` / `ROLLBACK WORK` inside a RAP
 * behaviour pool is a RUNTIME ERROR: the RAP framework owns persistence via `COMMIT ENTITIES`.
 * Raw-source (parse-independent, so a pool with RAP handler syntax abaplint can't fully parse is
 * still covered). Scoped to files that carry a RAP-pool marker, so a plain classic class that
 * legitimately commits is never flagged. ABAP comments (`"` inline, `*` full-line) are stripped
 * first so a `" … COMMIT WORK …` note does not false-fire.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function commitInRapPoolFindings(files) {
  const findings = [];
  for (const f of files) {
    const source = String(f.source ?? "");
    if (!RAP_POOL_MARKER_RE.test(source)) continue;
    source.split(/\r?\n/).forEach((line, idx) => {
      if (/^\s*\*/.test(line)) return; // full-line comment
      const code = line.replace(/".*$/, ""); // strip inline comment ('"' is always a comment in ABAP)
      if (COMMIT_ROLLBACK_WORK_RE.test(code)) {
        findings.push({ rule_id: "gf-rap-no-commit-in-pool", severity: "error", object: objNameOf(f.filename), object_type: undefined, file: f.filename, line: idx + 1, message: "explicit COMMIT WORK / ROLLBACK WORK inside a RAP behaviour pool is a runtime error (P4(b)); the RAP framework owns persistence via COMMIT ENTITIES — remove it", family: "invariant" });
      }
    });
  }
  return findings;
}

// ===================== BDEF-AST substrate (G4/G8) =====================
// abaplint registers a .bdef.asbdef but does not parse the BDL body, so we text-parse
// the raw source. `.bdef` (older) and `.bdef.asbdef` (abapGit) are both accepted.
const BDEF_RE = /\.bdef(?:\.asbdef)?$/i;
const SAVER_RE = /INHERITING\s+FROM\s+cl_abap_behavior_saver/i;
const SAVE_MODIFIED_RE = /\bsave_modified\b/i;

/** @param {string} filename @returns {boolean} whether the file is a behaviour definition */
export function isBdef(filename) {
  return BDEF_RE.test(String(filename ?? ""));
}

/** Strip BDEF `//` line comments before header parsing. */
function stripBdefComments(source) {
  return String(source ?? "").split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

/**
 * Parse a .bdef header into its impl-type + save requirement + implementation class + entity.
 * implType ∈ managed | managed with additional save | managed with unmanaged save | unmanaged
 *            | projection | unknown. `needsSaver` is true iff the mode requires a
 * cl_abap_behavior_saver (additional-save / unmanaged-save / unmanaged).
 * @param {string} source
 * @returns {{implType: string, needsSaver: boolean, implClass: string|null, entity: string|null, isProjection: boolean}}
 */
export function parseBdefHeader(source) {
  const text = stripBdefComments(source);
  const header = text.split(/\bdefine\s+behavior\b/i)[0] ?? text; // impl-type lives before `define behavior`
  const isProjection = /\bprojection\s*;/i.test(header);
  const m = header.match(/\b(managed|unmanaged)\b(?:\s+with\s+(additional|unmanaged)\s+save)?/i);
  let implType = "unknown";
  let needsSaver = false;
  if (m) {
    const base = m[1].toLowerCase();
    const save = m[2]?.toLowerCase();
    if (base === "unmanaged") { implType = "unmanaged"; needsSaver = true; }
    else if (save === "additional") { implType = "managed with additional save"; needsSaver = true; }
    else if (save === "unmanaged") { implType = "managed with unmanaged save"; needsSaver = true; }
    else { implType = "managed"; needsSaver = false; }
  } else if (isProjection) {
    implType = "projection";
  }
  return {
    implType,
    needsSaver,
    implClass: text.match(/implementation\s+in\s+class\s+(\w+)/i)?.[1] ?? null,
    entity: text.match(/define\s+behavior\s+for\s+(\w+)/i)?.[1] ?? null,
    isProjection,
  };
}

/**
 * Whether a saver class (cl_abap_behavior_saver + save_modified) exists for `implClass`.
 * When the BDEF names its implementation class, the saver MUST live in a file of that class —
 * an unrelated saver for another BO does not satisfy it. Only when the class cannot be
 * identified at all do we fall back to a whole-set check.
 */
function hasSaverFor(implClass, files) {
  const pool = implClass ? files.filter((f) => String(f.filename ?? "").toLowerCase().includes(implClass.toLowerCase())) : files;
  return pool.some((f) => { const s = String(f.source ?? ""); return SAVER_RE.test(s) && SAVE_MODIFIED_RE.test(s); });
}

/**
 * gf-x-bdef-managed-save-consistency (GF-2 exceed ①) — a BDEF that declares a save mode
 * requiring a saver (additional save / unmanaged save / unmanaged) but ships no
 * cl_abap_behavior_saver redefining save_modified. Closes G1's blind spot. Single-BO scope:
 * the saver is matched to the BDEF's `implementation in class` (falls back to the whole set).
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function bdefSaveConsistencyFindings(files) {
  const list = Array.isArray(files) ? files : [];
  const findings = [];
  for (const f of list) {
    if (!isBdef(f.filename)) continue;
    const { implType, needsSaver, implClass } = parseBdefHeader(f.source);
    if (!needsSaver || hasSaverFor(implClass, list)) continue;
    const lines = String(f.source ?? "").split(/\r?\n/);
    const line = lines.findIndex((l) => /\b(managed|unmanaged)\b/i.test(l.replace(/\/\/.*$/, ""))) + 1 || 1;
    findings.push({ rule_id: "gf-x-bdef-managed-save-consistency", severity: "error", object: objNameOf(f.filename), object_type: "BDEF", file: f.filename, line, message: `the behaviour definition declares '${implType}' but no saver class (a local class INHERITING FROM cl_abap_behavior_saver redefining save_modified) is present — additional/unmanaged save requires one`, family: "rap-odata" });
  }
  return findings;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Extract the CUSTOM operations a BDEF declares that need a handler METHOD: determinations
 * and validations (`… on save/modify`), and custom actions — EXCLUDING `draft action …` and
 * the `draft determine action …` framework actions. Plus the auth scope. A determination/
 * validation merely REFERENCED inside a `draft determine action Prepare { … }` block has no
 * `on save/modify`, so it is not re-counted as a fresh declaration.
 * @param {string} source
 * @returns {{determinations: string[], validations: string[], actions: string[], authGlobal: boolean, authInstance: boolean}}
 */
export function parseBdefOps(source) {
  const text = stripBdefComments(source);
  const all = (re) => { const out = new Set(); const r = new RegExp(re.source, "gi"); let m; while ((m = r.exec(text))) out.add(m[1]); return [...out]; };
  const draftActions = new Set(all(/\bdraft\s+(?:determine\s+)?action\s+(\w+)/).map((n) => n.toLowerCase()));
  const authMaster = text.match(/\bauthorization\s+(?:master|dependent)\s*\(([^)]*)\)/i)?.[1] ?? "";
  return {
    determinations: all(/\bdetermination\s+(\w+)\s+on\s+(?:save|modify)\b/),
    validations: all(/\bvalidation\s+(\w+)\s+on\s+(?:save|modify)\b/),
    actions: all(/\baction\s+(?:\([^)]*\)\s*)?(\w+)/).filter((n) => !draftActions.has(n.toLowerCase())),
    authGlobal: /\bglobal\b/i.test(authMaster),
    authInstance: /\binstance\b/i.test(authMaster),
  };
}

/** Concatenated (comment-stripped) source of the non-BDEF files of `implClass` (else all non-BDEF). */
function poolSourceFor(implClass, files) {
  const nonBdef = files.filter((c) => !isBdef(c.filename));
  const pool = implClass ? nonBdef.filter((c) => String(c.filename ?? "").toLowerCase().includes(implClass.toLowerCase())) : nonBdef;
  return pool.map((c) => stripBdefComments(c.source)).join("\n");
}

/** 1-based line of `name`'s first mention in the .bdef, else 1. */
function bdefLineOf(source, name) {
  const idx = String(source ?? "").split(/\r?\n/).findIndex((l) => new RegExp(`\\b${escapeRe(name)}\\b`).test(l.replace(/\/\/.*$/, "")));
  return idx + 1 || 1;
}

/**
 * gf-x-bdef-handler-reconciliation (GF-2 exceed ①, HIGH) — a determination / validation /
 * custom action declared in the BDEF with no handler method in the behaviour pool. A handler
 * is recognised by its `<alias>~<op>` binding, matched PER-OP (one FOR MODIFY method can bind
 * several actions), so a shared method is not a false positive. Projections delegate (skipped);
 * draft actions + the Prepare determine-action are framework-handled (excluded by parseBdefOps).
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function bdefHandlerReconciliationFindings(files) {
  const list = Array.isArray(files) ? files : [];
  const findings = [];
  for (const f of list) {
    if (!isBdef(f.filename)) continue;
    const { implClass, isProjection } = parseBdefHeader(f.source);
    if (isProjection) continue;
    const ops = parseBdefOps(f.source);
    const pool = poolSourceFor(implClass, list);
    const declared = [
      ...ops.determinations.map((name) => ({ name, kind: "determination" })),
      ...ops.validations.map((name) => ({ name, kind: "validation" })),
      ...ops.actions.map((name) => ({ name, kind: "action" })),
    ];
    for (const op of declared) {
      if (new RegExp(`~\\s*${escapeRe(op.name)}\\b`, "i").test(pool)) continue;
      findings.push({ rule_id: "gf-x-bdef-handler-reconciliation", severity: "error", object: objNameOf(f.filename), object_type: "BDEF", file: f.filename, line: bdefLineOf(f.source, op.name), message: `${op.kind} '${op.name}' is declared in the behaviour definition but has no handler method (a FOR ${op.kind === "action" ? "ACTION " : ""}…~${op.name} binding) in the behaviour pool${implClass ? ` ${implClass}` : ""}`, family: "rap-odata" });
    }
  }
  return findings;
}
