/**
 * A NET-NEW regex CDS-DDL structural extractor (BUILD_PLAN S7 CORRECTION). @abaplint parses no CDS DDL,
 * and `extract/ast-reader.js` / `bdef-dcl.js` emit auth/commit/save/edges — NOT the structural surface the
 * conformance gate (sched/conformance.js) must compare against the ratified Architecture Contract. This
 * pulls `{keys, fields(name+element+type), associations, annotations}` (plus entity + select source) from
 * a GENERATED CDS view entity — well-formed, template-shaped source, not arbitrary hostile input.
 *
 * Pure. P8: the input is the moderniser's OWN generated CDS (a conformance check of what it built), never
 * hostile customer source; even so it only reads structure and never executes anything.
 */

/**
 * @param {string} source CDS DDL view-entity source
 * @returns {{entity: string|null, source: string|null, keys: string[], fields: Array<{name: string, element: string, type: string|null}>, associations: Array<{name: string, target: string, cardinality: string|null}>, annotations: Array<{name: string, value: string}>}}
 */
export function extractCdsStructure(source) {
  const src = stripComments(String(source ?? ""));
  const entity = match1(src, /define\s+(?:root\s+)?view\s+entity\s+([\w/]+)/i);
  const selectSource = match1(src, /\bselect(?:\s+distinct)?\s+from\s+([\w/]+)/i);
  const associations = extractAssociations(src);
  const assocNames = new Set(associations.map((a) => a.name));
  const { keys, fields } = extractFields(src, assocNames);
  return { entity, source: selectSource, keys, fields, associations, annotations: extractAnnotations(src) };
}

const match1 = (s, re) => {
  const m = re.exec(s);
  return m ? m[1] : null;
};

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

function extractAssociations(s) {
  const re = /association(?:\s*\[\s*([^\]]*?)\s*\])?\s+(?:of\s+)?to\s+([\w/]+)\s+as\s+(\w+)/gi;
  const out = [];
  let m;
  while ((m = re.exec(s))) out.push({ name: m[3], target: m[2], cardinality: (m[1] ?? "").trim() || null });
  return out;
}

function extractAnnotations(s) {
  const re = /@([\w.]+)\s*:\s*([^\n,]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) out.push({ name: m[1], value: m[2].trim() });
  return out;
}

function extractFields(s, assocNames) {
  const keys = [];
  const fields = [];
  for (const raw of splitTopLevel(extractBody(s))) {
    let expr = stripFieldAnnotations(raw).trim();
    if (!expr) continue;
    let isKey = false;
    const km = /^key\s+/i.exec(expr);
    if (km) {
      isKey = true;
      expr = expr.slice(km[0].length).trim();
    }
    // A bare `_Assoc` / known-association identifier exposed in the body is an association, not a field.
    if (/^_?\w+$/.test(expr) && (assocNames.has(expr) || expr.startsWith("_"))) continue;
    const parsed = parseFieldExpr(expr);
    if (!parsed.name) continue;
    fields.push(parsed);
    if (isKey) keys.push(parsed.name);
  }
  return { keys, fields };
}

/** The projection body between the first top-level `{` and its matching `}`. */
function extractBody(s) {
  const start = s.indexOf("{");
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start + 1, i);
    }
  }
  return s.slice(start + 1);
}

/** Split on commas at bracket depth 0 (a comma inside cast(…) / [..] / {..} is not a separator). */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const stripFieldAnnotations = (chunk) => chunk.split("\n").filter((l) => !/^\s*@/.test(l)).join("\n");

/** `<expr> as <Alias>` → {name: Alias, element: expr, type}; `<expr>` → {name: lastIdent, element: expr}. */
function parseFieldExpr(expr) {
  const asIdx = topLevelAs(expr);
  const element = (asIdx === -1 ? expr : expr.slice(0, asIdx)).trim();
  const name = asIdx === -1 ? lastIdent(element) : expr.slice(asIdx + 4).trim();
  return { name, element, type: castType(element) };
}

/** Index of the space before a top-level ` as `, or -1 (an ` as ` inside cast(…) is not top-level). */
function topLevelAs(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length - 3; i++) {
    const ch = expr[i];
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (depth === 0 && /^\sas\s/i.test(expr.slice(i, i + 4))) return i;
  }
  return -1;
}

/** The declared type of a `cast( <expr> as <type> )`, else null. */
function castType(element) {
  const m = /^cast\s*\(([\s\S]*)\)\s*$/i.exec(element.trim());
  if (!m) return null;
  const asIdx = topLevelAs(m[1]);
  return asIdx === -1 ? null : m[1].slice(asIdx + 4).trim();
}

const lastIdent = (s) => {
  const m = s.trim().match(/([\w/]+)\s*$/);
  return m ? m[1] : s.trim();
};
