// Pure ABAP-safety checks shared by the harness hooks. No I/O, no process.
// Each function takes text/strings and returns an array (of findings) or a boolean.

const SECRET_PATTERNS = [
  { label: "github-pat", re: /ghp_[A-Za-z0-9]{20,}/ },
  { label: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { label: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { label: "private-key-pem", re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
  { label: "hardcoded-password", re: /\bpass(?:word|wd)\s*=\s*'[^']{3,}'/i },
];

// Returns [{label, match}] for each secret signature found in text.
export function scanSecrets(text) {
  const found = [];
  for (const { label, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) found.push({ label, match: m[0] });
  }
  return found;
}

const INJECTION_SINKS = [
  { sink: "generate-subroutine-pool", re: /GENERATE\s+SUBROUTINE\s+POOL/i },
  { sink: "call-system", re: /CALL\s+'SYSTEM'/i },
  { sink: "dynamic-submit", re: /\bSUBMIT\s+\(/i },
  { sink: "dynamic-from", re: /\bFROM\s+\(/i },
  // C4/P8: native SQL bypasses Open SQL parameter binding (injection risk) and is forbidden in
  // ABAP Cloud — use Open SQL over released CDS entities.
  { sink: "native-sql", re: /\bEXEC\s+SQL\b/i },
];

// Returns [{sink, snippet}] for each dangerous ABAP construct in the source.
export function detectInjectionSinks(abap) {
  const found = [];
  for (const { sink, re } of INJECTION_SINKS) {
    const m = abap.match(re);
    if (m) found.push({ sink, snippet: m[0] });
  }
  return found;
}

const countMatches = (text, re) => (text.match(re) || []).length;

// P4(a) names three co-equal authorization gates: classic AUTHORITY-CHECK, the RAP BDEF
// `authorization master ( global | instance )` + its GET_*_AUTHORIZATIONS handlers, and CDS DCL.
// Only the classic form was diffed here, so deleting the primary ABAP-Cloud boundary was invisible
// to the deterministic gate and rested entirely on the reviewer agent's judgment (C2).
//
// Text-diff rather than a parse is deliberate: this gate is parse-independent and fail-closed, and
// it must stay pure (no I/O) — it does NOT import the moderniser's extractor.
const AUTH_MASTER_RE = /\bauthorization\s+(master|dependent)\b\s*(?:\(([^)]*)\)|by\s+(_\w+))?/gi;
const AUTH_HANDLER_RE = /GET_(?:GLOBAL|INSTANCE)_AUTHORIZATIONS/gi;
const DCL_GRANT_RE = /\bGRANT\s+SELECT\b/gi;

// The declared authorization surface of a BDEF: one token per mode and per scope, canonical UPPER.
// `authorization master ( global, instance )` -> {MASTER, GLOBAL, INSTANCE}.
function authScopes(text) {
  const tokens = new Set();
  let clauses = 0;
  for (const m of text.matchAll(AUTH_MASTER_RE)) {
    clauses += 1;
    tokens.add(m[1].toUpperCase());
    for (const t of (m[2] ?? m[3] ?? "").split(",")) {
      const tok = t.trim().toUpperCase();
      if (tok) tokens.add(tok);
    }
  }
  return { tokens, clauses };
}

// RAP-authorization regressions between baseline and changed source. Widening is never a
// regression; anything the baseline declared and the change does not is.
function rapAuthWeakening(oldText, newText) {
  const findings = [];
  const before = authScopes(oldText);
  const after = authScopes(newText);
  const lost = [...before.tokens].filter((t) => !after.tokens.has(t));
  if (before.clauses > after.clauses || lost.length > 0) {
    const detail = before.clauses > after.clauses
      ? "a BDEF `authorization` clause present in the baseline is gone"
      : `the declared authorization scope narrowed — lost: ${lost.join(", ")}`;
    findings.push({ type: "rap-auth-master-weakened", detail });
  }
  // The clause survives but the handler enforcing it does not, leaving the gate declared-only.
  if (after.clauses > 0 && countMatches(oldText, AUTH_HANDLER_RE) > countMatches(newText, AUTH_HANDLER_RE)) {
    findings.push({ type: "rap-auth-handler-missing", detail: "a declared authorization scope has lost its GET_*_AUTHORIZATIONS handler" });
  }
  if (countMatches(oldText, DCL_GRANT_RE) > countMatches(newText, DCL_GRANT_RE)) {
    findings.push({ type: "dcl-grant-dropped", detail: "a DCL GRANT SELECT present in the baseline is gone (row-level authorization removed)" });
  }
  return findings;
}

/**
 * Blank out comments so the P4 checks below read CODE, not prose about code.
 *
 * Every check here counts occurrences of an invariant's keywords, and until this existed a comment
 * naming one was indistinguishable from the thing itself. The dangerous direction is fail-OPEN: delete a
 * real AUTHORITY-CHECK and write `" AUTHORITY-CHECK moved to the caller` where it stood, and the counts
 * balance — the removal goes unreported. That is not an adversarial input; explaining a removal in a
 * comment is exactly what a careful author does, which is what made it reachable by accident.
 *
 * Over-stripping is equally unsafe in the other direction (a literal eaten as a comment hides an invariant
 * that IS there), so string literals are tracked rather than assumed away: `'…'` with `''` escaping,
 * `|…|` templates with backslash escaping. Comment forms handled: ABAP `*` in column 1 and `"` to end of
 * line; CDS/BDEF `//` to end of line, and slash-star … star-slash block comments spanning lines. Text is
 * replaced by spaces, never deleted, so offsets stay put for the windowed sy-subrc check.
 */
export function stripAbapComments(text) {
  const src = String(text ?? "");
  let out = "";
  let i = 0;
  let state = "code"; // code | str | tpl | line | block
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    const atLineStart = i === 0 || src[i - 1] === "\n";
    if (state === "str") {
      if (c === "'" && next === "'") { out += "''"; i += 2; continue; }
      if (c === "'") state = "code";
      out += c; i += 1; continue;
    }
    if (state === "tpl") {
      if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
      if (c === "|") state = "code";
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; } else out += " ";
      i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " ";
      i += 1; continue;
    }
    if (atLineStart && c === "*") { state = "line"; out += " "; i += 1; continue; }
    if (c === "'") { state = "str"; out += c; i += 1; continue; }
    if (c === "|") { state = "tpl"; out += c; i += 1; continue; }
    if (c === '"') { state = "line"; out += " "; i += 1; continue; }
    if (c === "/" && next === "/") { state = "line"; out += "  "; i += 2; continue; }
    if (c === "/" && next === "*") { state = "block"; out += "  "; i += 2; continue; }
    out += c; i += 1;
  }
  return out;
}

// Returns [{type, detail}] for immutable-invariant (P4) regressions between the
// pre-change (oldText) and post-change (newText) source of an object.
export function detectInvariantWeakening(rawOldText, rawNewText) {
  // Comments are stripped from BOTH sides before anything is counted. Stripping only the new side would
  // let a baseline comment inflate the old count into a phantom removal.
  const oldText = stripAbapComments(rawOldText);
  const newText = stripAbapComments(rawNewText);
  const findings = [];
  const authRe = /AUTHORITY-CHECK/gi;
  if (countMatches(oldText, authRe) > countMatches(newText, authRe)) {
    findings.push({ type: "authority-check-removed", detail: "an AUTHORITY-CHECK present in the baseline is gone" });
  }
  const commitWorkRe = /COMMIT\s+WORK/i;
  if (commitWorkRe.test(oldText) && !commitWorkRe.test(newText)) {
    findings.push({ type: "commit-work-suppressed", detail: "a COMMIT WORK present in the baseline is gone" });
  }
  // P4(b), ABAP Cloud / RAP: the save is COMMIT ENTITIES (COMMIT WORK is a runtime error in a
  // behaviour pool). Suppressing the RAP save is the same invariant regression as dropping COMMIT WORK.
  const commitEntitiesRe = /COMMIT\s+ENTITIES/i;
  if (commitEntitiesRe.test(oldText) && !commitEntitiesRe.test(newText)) {
    findings.push({ type: "commit-entities-suppressed", detail: "the RAP save (COMMIT ENTITIES) present in the baseline is gone" });
  }
  // Every AUTHORITY-CHECK in the new source must be followed (within ~250 chars) by an sy-subrc read.
  if (/AUTHORITY-CHECK/i.test(newText) && !/AUTHORITY-CHECK[\s\S]{0,250}?sy-subrc/i.test(newText)) {
    findings.push({ type: "sy-subrc-unchecked", detail: "AUTHORITY-CHECK is not followed by an sy-subrc check" });
  }
  // P4(a): the RAP/DCL authorization gates are co-equal with the classic form above.
  findings.push(...rapAuthWeakening(oldText, newText));
  return findings;
}

// True when an object name is in a customer/registered namespace (Z*, Y*, /NS/*).
export function inCustomerNamespace(objectName) {
  return /^[ZY]/i.test(objectName) || /^\/[A-Za-z0-9_]+\//.test(objectName);
}

// True for local ABAP source artifacts the pre-write gate must scan.
export function isAbapSource(filePath) {
  // Both the ADT/plain form (.bdef/.dcls/.ddls) and the abapGit export form (.asbdef/.asdcls/
  // .asddls). Missing .asbdef/.asdcls meant a BDEF or DCL in abapGit layout never reached the gate
  // at all — the P4(a) checks below cannot fire on a file this predicate rejects. The analyser
  // (modes.js BUNDLE_EXTENSIONS) and moderniser (bdef-dcl.js BDEF_RE/DCL_RE) already accept all six.
  return /\.(abap|ddls|asddls|bdef|asbdef|dcls|asdcls|behv|aclr)$/i.test(filePath);
}

const HEAVY_LANES = ["abap-build", "abap-auto", "abap-implement", "abap-change", "abap-refactor", "abap-validate", "abap-transport"];

// Returns the heavy build-lane command invoked in a prompt, or null.
export function buildLaneInPrompt(prompt) {
  const m = prompt.match(/\/(abap-build|abap-auto|abap-implement|abap-change|abap-refactor|abap-validate|abap-transport)\b/);
  return m && HEAVY_LANES.includes(m[1]) ? m[1] : null;
}
