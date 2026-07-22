/**
 * gap-2b B2 — the BDEF/DCL/DDLS regex engine (engine 2). @abaplint/core parses none of RAP
 * behaviour definitions, CDS DCL access controls, or CDS annotations (B1 probe pins this), so
 * their authorization features are extracted here (RAP_DEEP_EXTRACTION §3.5). Produces the
 * invariantDiff inputs the AST reader CANNOT. Comment-safe, TOTAL (never throws), pure.
 *
 * B6.5 REMEDIATION — four adversarially-confirmed defects, each with a probe in
 * `extract-bdef-dcl-auth.test.js`:
 *   F2  comment stripping ran the block-comment regex BEFORE the line strip and was blind to
 *       string literals, so a line comment containing a block-opener, followed later by a block
 *       terminator, DELETED every clause between them — an auth
 *       removal then rendered as a clean PROVISIONAL. Replaced by a single left-to-right scanner
 *       that consumes literals, `//` and comments in SOURCE ORDER.
 *   F3  that same regex was quadratic — 234 KB of repeated block-comment openers took 2.7 s, a P8
 *       DoS on untrusted ABAP. The scanner is O(n).
 *   F4  the BDEF `authorization master ( global | instance )` clause — which CLAUDE.md P4a NAMES
 *       as the RAP authorization gate — was never extracted, so DELETING it was invisible. Now
 *       `auth_bdef`. DCL grants are also recorded in ALL forms (`dcl_grants`), so a
 *       `pfcg_auth` → `inheriting conditions` migration reads as continuity rather than auth loss.
 *   F7  `privilegedCds` matched `with privileged access` INSIDE a DCL grant. That clause does not
 *       exist in DCL grammar — WITH PRIVILEGED ACCESS is an ABAP-SQL addition (@abaplint/core files
 *       it under statements/, not DCL), so the branch was dead on real code while both REAL
 *       bypasses went unmonitored. Replaced by the CDS-annotation bypass
 *       (`@AccessControl.authorizationCheck: #NOT_REQUIRED | #NOT_ALLOWED`); the ABAP-SQL half is
 *       engine 1's, merged in `bundle.js`.
 */

const DCL_RE = /\.dcls(\.asdcls)?$/i;
const BDEF_RE = /\.bdef(\.asbdef)?$/i;
const DDLS_RE = /\.ddls(\.asddls)?$/i;

// A CDS/ABAP name: letters, digits, underscore, and the /NS/ namespace slashes.
const NAME = "[\\w/]+";

/**
 * Strip DCL/BDEF/DDLS comments with a single left-to-right scan (F2/F3). Order matters: a `/*`
 * inside a `//` line, or inside a string literal, is NOT a comment opener. Newlines inside block
 * comments are preserved so downstream line numbers do not shift. O(n), no backtracking.
 */
function stripComments(src) {
  const s = String(src ?? "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    const two = s[i] + s[i + 1];
    if (s[i] === "'") {
      const start = i++;
      while (i < s.length) {
        if (s[i] !== "'") i++;
        else if (s[i + 1] === "'") i += 2; // '' is an escaped quote inside a literal
        else { i++; break; }
      }
      out.push(s.slice(start, i));
    } else if (two === "//") {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (two === "/*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        if (s[i] === "\n") out.push("\n");
        i++;
      }
      i = Math.min(i + 2, s.length); // unterminated → consume to EOF
    } else {
      out.push(s[i]);
      i++;
    }
  }
  return out.join("");
}

const uniqSort = (arr) => [...new Set(arr)].sort();
const byKey = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);

/**
 * @param {Array<{filename: string, source: string}>} files
 * @returns {{dcl_restrictions: Array<{object: string}>, dcl_grants: Array<{entity: string, form: string}>, auth_bdef: Array<{entity: string, mode: string, scope: string}>, privileged_cds: Array<{object: string, had_row_auth: boolean}>, edges: Array<{kind: string, source: string, target: string}>}}
 */
export function extractBdefDcl(files) {
  const list = Array.isArray(files) ? files : [];
  const authObjects = [];
  const grants = [];
  const auth_bdef = [];
  const edges = [];
  const bypassed = [];

  for (const f of list) {
    if (!f || typeof f.source !== "string") continue;
    const src = stripComments(f.source);
    if (DCL_RE.test(f.filename)) {
      const dcl = dclStatements(src);
      authObjects.push(...dcl.restrictions);
      grants.push(...dcl.grants);
    } else if (BDEF_RE.test(f.filename)) {
      edges.push(...bdefEdges(src));
      auth_bdef.push(...bdefAuth(src));
    } else if (DDLS_RE.test(f.filename)) {
      bypassed.push(...ddlsBypasses(src));
    }
  }

  // had_row_auth is resolved ACROSS the file set: a bypassed view that a DCL role also grants on
  // did have row-level authorization, which is exactly invariantDiff's F14 trigger.
  const granted = new Set(grants.map((g) => g.entity));
  return {
    // Auth objects are canonical UPPER (matched cross-bundle against AUTHORITY-CHECK objects). Each
    // carries the ENTITY it protects, so the judge can tell a grant-form migration (entity still
    // granted) from a genuine removal — `invariantDiff` keys loss on both.
    dcl_restrictions: dedupe(authObjects, (r) => `${r.object}|${r.entity}`).sort(byKey("object")),
    dcl_grants: dedupe(grants, (g) => `${g.entity}|${g.form}`).sort(byKey("entity")),
    auth_bdef: dedupe(auth_bdef, (a) => `${a.entity}|${a.mode}|${a.scope}`).sort(byKey("entity")),
    privileged_cds: uniqSort(bypassed).map((object) => ({ object, had_row_auth: granted.has(object) })),
    edges,
  };
}

const dedupe = (arr, key) => {
  const seen = new Set();
  return arr.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};

/**
 * One pass over the DCL grant statements, yielding BOTH the pfcg_auth restrictions (each tagged
 * with the entity it protects) and every grant with the FORM of its condition (F4b). Recording the
 * form — rather than only pfcg_auth objects — is what lets a `pfcg_auth` → `inheriting conditions`
 * migration read as CONTINUITY on that entity instead of a false auth-loss BLOCK, while a deleted
 * role still reads as loss because it produces no grant at all.
 * `pfcg_auth` is only legal inside a grant's condition, so scoping the scan to grant statements is
 * both correct and more precise than scanning the whole file.
 */
function dclStatements(src) {
  const grantRe = new RegExp(`\\bgrant\\s+select\\s+on\\s+(${NAME})`, "i");
  const pfcgRe = new RegExp(`aspect\\s+pfcg_auth\\s*\\(\\s*(${NAME})`, "gi");
  const restrictions = [];
  const grants = [];
  for (const stmt of src.split(";")) {
    const m = stmt.match(grantRe);
    if (!m) continue;
    const entity = m[1].toUpperCase();
    grants.push({ entity, form: grantForm(stmt) });
    for (const a of stmt.matchAll(pfcgRe)) restrictions.push({ object: a[1].toUpperCase(), entity });
  }
  return { restrictions, grants };
}

function grantForm(stmt) {
  if (/aspect\s+pfcg_auth/i.test(stmt)) return "pfcg_auth";
  if (/inheriting\s+conditions/i.test(stmt)) return "inheriting";
  return /\bwhere\b/i.test(stmt) ? "condition" : "unconditional";
}

/**
 * The BDEF authorization gate (F4): `authorization master ( global, instance )` or
 * `authorization dependent by _Assoc`. P4a names this as the RAP authorization gate alongside the
 * handlers and DCL, so its REMOVAL must be visible — before this, deleting it changed nothing in
 * the extracted bundle.
 */
function bdefAuth(src) {
  const out = [];
  for (const { entity, body } of behaviourSegments(src)) {
    const m = body.match(/\bauthorization\s+(master|dependent)\b\s*(?:\(([^)]*)\)|by\s+(_\w+))?/i);
    if (!m) continue;
    const scope = (m[2] ?? m[3] ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean).join(",");
    out.push({ entity, mode: m[1].toLowerCase(), scope });
  }
  return out;
}

/** Per-entity BDEF segments — the shared spine of `bdefAuth` and `bdefEdges`. */
function behaviourSegments(src) {
  const decls = [...src.matchAll(new RegExp(`define\\s+behavior\\s+for\\s+(${NAME})(?:\\s+alias\\s+(\\w+))?`, "gi"))];
  return decls.map((d, i) => ({
    entity: d[1].toUpperCase(),
    alias: d[2] ? d[2].toUpperCase() : null,
    body: src.slice(d.index, i + 1 < decls.length ? decls[i + 1].index : src.length),
  }));
}

/** Lock-dependency edges (resolved to the parent entity via the alias map) + composition edges. */
function bdefEdges(src) {
  const segments = behaviourSegments(src);
  const aliasToEntity = new Map();
  for (const s of segments) {
    aliasToEntity.set(s.entity, s.entity);
    if (s.alias) aliasToEntity.set(s.alias, s.entity);
  }
  const edges = [];
  for (const { entity, body } of segments) {
    const lockDep = body.match(/\block\s+dependent\s+by\s+_(\w+)/i);
    if (lockDep) {
      const key = lockDep[1].toUpperCase();
      edges.push({ kind: "lock", source: entity, target: aliasToEntity.get(key) ?? `_${key}` });
    }
    for (const a of body.matchAll(/\bassociation\s+_(\w+)/gi)) {
      edges.push({ kind: "composition", source: entity, target: `_${a[1].toUpperCase()}` });
    }
  }
  return edges;
}

/**
 * The REAL CDS authorization bypass (F7): `@AccessControl.authorizationCheck: #NOT_REQUIRED` (or
 * `#NOT_ALLOWED`) disables DCL enforcement for the view. `#CHECK` is the safe default and is never
 * a bypass. The other real bypass — ABAP SQL `SELECT … WITH PRIVILEGED ACCESS` — is a statement,
 * so engine 1 extracts it and `bundle.js` merges the two.
 */
function ddlsBypasses(src) {
  if (!/@AccessControl\.authorizationCheck\s*:\s*#(NOT_REQUIRED|NOT_ALLOWED)/i.test(src)) return [];
  const m = src.match(new RegExp(`define\\s+(?:root\\s+)?(?:view|abstract\\s+entity|table\\s+function)\\s+(?:entity\\s+)?(${NAME})`, "i"));
  return m ? [m[1].toUpperCase()] : [];
}
