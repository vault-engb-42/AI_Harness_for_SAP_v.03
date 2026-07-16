import { objNameOf } from "./cloud-linter-checks.js";

/**
 * RAP behaviour-structural checks for greenfield's ABAP-Cloud linter. Raw-source,
 * parse-independent checks over the generated `.bdef` + behaviour-pool set — greenfield's
 * own code (it shares only the `@abaplint` LIBRARY for object registration, never the
 * analyser's rule packs). abaplint registers a `.bdef.asbdef` as a BehaviorDefinition but
 * does NOT parse the BDL body, so the BDEF substrate here text-parses the raw source.
 */

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Strip ABAP comments: `*` full-line and `"` inline — but a `"` inside a `'…'` string literal
 * is DATA, not a comment, so each line is walked tracking single-quote state (`''` is an
 * escaped quote = two toggles = unchanged). Preserves the line count.
 * @param {string} source
 * @returns {string}
 */
function stripAbapComments(source) {
  return String(source ?? "").split(/\r?\n/).map((line) => {
    if (/^\s*\*/.test(line)) return "";
    let inStr = false;
    let out = "";
    for (const ch of line) {
      if (ch === "'") inStr = !inStr;
      else if (ch === '"' && !inStr) break; // start of an inline comment
      out += ch;
    }
    return out;
  }).join("\n");
}

/** Strip BDEF `//` line comments before header/body parsing. */
function stripBdefComments(source) {
  return String(source ?? "").split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

// A file is a RAP behaviour pool when it declares a handler/saver on cl_abap_behavior_*
// or carries a `… FOR MODIFY/READ/DETERMINE/…` handler method (unambiguous RAP syntax).
const RAP_POOL_MARKER_RE = /\bINHERITING\s+FROM\s+cl_abap_behavior_(?:handler|saver)\b|\bFOR\s+(?:MODIFY|READ|DETERMINE|VALIDATE|LOCK|FEATURES|GLOBAL\s+AUTHORIZATION|INSTANCE\s+AUTHORIZATION)\b/i;
const COMMIT_ROLLBACK_WORK_RE = /\b(?:COMMIT|ROLLBACK)\s+WORK\b/i;

/**
 * gf-rap-no-commit-in-pool (P4(b)) — explicit `COMMIT WORK` / `ROLLBACK WORK` inside a RAP
 * behaviour pool is a RUNTIME ERROR: the RAP framework owns persistence via `COMMIT ENTITIES`.
 * Both the RAP-pool marker test and the COMMIT scan run over comment-STRIPPED source (string-
 * literal-aware), so a `FOR MODIFY` / `COMMIT WORK` sitting in an ABAP comment never mis-fires,
 * and a `"` inside a `'…'` literal does not truncate the line.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function commitInRapPoolFindings(files) {
  const findings = [];
  for (const f of files) {
    const stripped = stripAbapComments(f.source);
    if (!RAP_POOL_MARKER_RE.test(stripped)) continue;
    stripped.split(/\r?\n/).forEach((line, idx) => {
      if (COMMIT_ROLLBACK_WORK_RE.test(line)) {
        findings.push({ rule_id: "gf-rap-no-commit-in-pool", severity: "error", object: objNameOf(f.filename), object_type: undefined, file: f.filename, line: idx + 1, message: "explicit COMMIT WORK / ROLLBACK WORK inside a RAP behaviour pool is a runtime error (P4(b)); the RAP framework owns persistence via COMMIT ENTITIES — remove it", family: "invariant" });
      }
    });
  }
  return findings;
}

// ===================== BDEF-AST substrate (G4/G8) =====================
const BDEF_RE = /\.bdef(?:\.asbdef)?$/i;
const SAVER_RE = /INHERITING\s+FROM\s+cl_abap_behavior_saver/i;
const SAVE_MODIFIED_RE = /\bsave_modified\b/i;

/** @param {string} filename @returns {boolean} whether the file is a behaviour definition */
export function isBdef(filename) {
  return BDEF_RE.test(String(filename ?? ""));
}

/**
 * Parse a .bdef header: impl-type + save requirement + implementation class + root entity/alias.
 * implType ∈ managed | managed with additional save | managed with unmanaged save | unmanaged
 *            | projection | unknown. Namespaced names (`/DMO/…`, `/NS/…`) are captured — the
 * class/entity regexes allow `/`.
 * @param {string} source
 * @returns {{implType: string, needsSaver: boolean, implClass: string|null, entity: string|null, alias: string|null, isProjection: boolean}}
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
  const behav = text.match(/define\s+behavior\s+for\s+([\w/]+)(?:\s+alias\s+(\w+))?/i);
  return {
    implType,
    needsSaver,
    implClass: text.match(/implementation\s+in\s+class\s+([\w/]+)/i)?.[1] ?? null,
    entity: behav?.[1] ?? null,
    alias: behav?.[2] ?? behav?.[1] ?? null,
    isProjection,
  };
}

/**
 * Split a BDEF into its per-entity behaviour blocks — one per `define behavior for <entity>
 * [alias <alias>] { … }` — with the brace-balanced body of each. A BDEF may define behaviour
 * for several entities (root + composition children); each has its own alias + op set, so op
 * names are entity-scoped (a name may recur across entities).
 * @param {string} source
 * @returns {Array<{entity: string, alias: string, body: string}>}
 */
function bdefBlocks(source) {
  const text = stripBdefComments(source);
  const blocks = [];
  const re = /\bdefine\s+behavior\s+for\s+([\w/]+)(?:\s+alias\s+(\w+))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf("{", re.lastIndex);
    if (open < 0) continue;
    let depth = 0;
    let end = text.length;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) { end = i; break; }
    }
    blocks.push({ entity: m[1], alias: m[2] ?? m[1], body: text.slice(open + 1, end) });
  }
  return blocks;
}

/**
 * Extract the CUSTOM operations one behaviour BLOCK declares that need a handler METHOD:
 * determinations + validations (`… on save/modify`, so a mere reference inside a determine
 * action is not re-counted) and custom actions — EXCLUDING `draft action …` and any
 * `[draft] determine action …` (both are framework constructs with no pool handler).
 * @param {string} body
 * @returns {{determinations: string[], validations: string[], actions: string[]}}
 */
function extractOps(body) {
  const all = (re) => { const out = new Set(); const r = new RegExp(re.source, "gi"); let m; while ((m = r.exec(body))) out.add(m[1]); return [...out]; };
  const excluded = new Set([
    ...all(/\bdraft\s+action\s+(\w+)/),
    ...all(/\b(?:draft\s+)?determine\s+action\s+(\w+)/),
  ].map((n) => n.toLowerCase()));
  return {
    determinations: all(/\bdetermination\s+(\w+)\s+on\s+(?:save|modify)\b/),
    validations: all(/\bvalidation\s+(\w+)\s+on\s+(?:save|modify)\b/),
    actions: all(/\baction\s+(?:\([^)]*\)\s*)?(\w+)/).filter((n) => !excluded.has(n.toLowerCase())),
  };
}

/**
 * Flat (whole-BDEF) view of the declared ops + auth scope — the union across all entity blocks.
 * @param {string} source
 * @returns {{determinations: string[], validations: string[], actions: string[], authGlobal: boolean, authInstance: boolean}}
 */
export function parseBdefOps(source) {
  const blocks = bdefBlocks(source);
  const union = (key) => [...new Set(blocks.flatMap((b) => extractOps(b.body)[key]))];
  const authMaster = stripBdefComments(source).match(/\bauthorization\s+(?:master|dependent)\s*\(([^)]*)\)/i)?.[1] ?? "";
  return {
    determinations: union("determinations"),
    validations: union("validations"),
    actions: union("actions"),
    authGlobal: /\bglobal\b/i.test(authMaster),
    authInstance: /\binstance\b/i.test(authMaster),
  };
}

const normalize = (s) => String(s ?? "").toLowerCase().replace(/[/#]/g, "");

/**
 * The non-BDEF files that belong to `implClass`, matched on the abapGit class-file base name
 * (the segment before `.clas`), namespace-normalised (`/`,`#` stripped). So `zbp_i_travel`
 * does NOT capture the sibling `zbp_i_travel_ext`, and `/DMO/BP_TRAVEL` matches `#dmo#bp_travel`.
 * When the class cannot be identified, returns all non-BDEF files (whole-set fallback).
 */
function classFilesFor(implClass, files) {
  const nonBdef = files.filter((c) => !isBdef(c.filename));
  if (!implClass) return nonBdef;
  const base = normalize(implClass);
  return nonBdef.filter((c) => normalize(String(c.filename ?? "").split(/\.clas\b/i)[0]) === base);
}

/** Whether a real (non-commented) saver class exists for `implClass`. */
function hasSaverFor(implClass, files) {
  return classFilesFor(implClass, files).some((f) => {
    const s = stripAbapComments(f.source);
    return SAVER_RE.test(s) && SAVE_MODIFIED_RE.test(s);
  });
}

/**
 * gf-x-bdef-managed-save-consistency (GF-2 exceed ①) — a BDEF declaring a save mode that
 * requires a saver (additional save / unmanaged save / unmanaged) but ships no
 * cl_abap_behavior_saver redefining save_modified. Closes G1's blind spot. The saver is
 * matched to the BDEF's implementation class (a commented-out or unrelated saver never counts).
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

/** Concatenated ABAP-comment-stripped source of the class files belonging to `implClass`. */
function poolSourceFor(implClass, files) {
  return classFilesFor(implClass, files).map((c) => stripAbapComments(c.source)).join("\n");
}

/** 1-based line of `name`'s first mention in the .bdef, else 1. */
function bdefLineOf(source, name) {
  const idx = String(source ?? "").split(/\r?\n/).findIndex((l) => new RegExp(`\\b${escapeRe(name)}\\b`).test(l.replace(/\/\/.*$/, "")));
  return idx + 1 || 1;
}

/**
 * gf-x-bdef-handler-reconciliation (GF-2 exceed ①, HIGH) — a determination / validation /
 * custom action declared in the BDEF with no handler method in the behaviour pool. Parsed and
 * matched PER-ENTITY-BLOCK: a handler must carry the `FOR [ACTION] <alias>~<op>` binding for
 * THAT entity's alias, so (a) an op name recurring across entities is checked independently,
 * (b) one FOR MODIFY method binding several actions is not a false positive, and (c) a bare
 * `alias~op` component-selector call or an ABAP-comment mention does not count as a handler.
 * Projections delegate (skipped); the pool is comment-stripped.
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
    const pool = poolSourceFor(implClass, list);
    for (const block of bdefBlocks(f.source)) {
      const ops = extractOps(block.body);
      const declared = [
        ...ops.determinations.map((name) => ({ name, kind: "determination" })),
        ...ops.validations.map((name) => ({ name, kind: "validation" })),
        ...ops.actions.map((name) => ({ name, kind: "action" })),
      ];
      for (const op of declared) {
        const bind = new RegExp(`\\bFOR\\s+(?:ACTION\\s+)?${escapeRe(block.alias)}\\s*~\\s*${escapeRe(op.name)}\\b`, "i");
        if (bind.test(pool)) continue;
        findings.push({ rule_id: "gf-x-bdef-handler-reconciliation", severity: "error", object: objNameOf(f.filename), object_type: "BDEF", file: f.filename, line: bdefLineOf(f.source, op.name), message: `${op.kind} '${op.name}' (entity ${block.entity}) is declared in the behaviour definition but has no handler method (a FOR ${op.kind === "action" ? "ACTION " : ""}${block.alias}~${op.name} binding) in the behaviour pool${implClass ? ` ${implClass}` : ""}`, family: "rap-odata" });
      }
    }
  }
  return findings;
}
