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

// Returns [{type, detail}] for immutable-invariant (P4) regressions between the
// pre-change (oldText) and post-change (newText) source of an object.
export function detectInvariantWeakening(oldText, newText) {
  const findings = [];
  const authRe = /AUTHORITY-CHECK/gi;
  if (countMatches(oldText, authRe) > countMatches(newText, authRe)) {
    findings.push({ type: "authority-check-removed", detail: "an AUTHORITY-CHECK present in the baseline is gone" });
  }
  const commitRe = /COMMIT\s+WORK/i;
  if (commitRe.test(oldText) && !commitRe.test(newText)) {
    findings.push({ type: "commit-work-suppressed", detail: "a COMMIT WORK present in the baseline is gone" });
  }
  // Every AUTHORITY-CHECK in the new source must be followed (within ~250 chars) by an sy-subrc read.
  if (/AUTHORITY-CHECK/i.test(newText) && !/AUTHORITY-CHECK[\s\S]{0,250}?sy-subrc/i.test(newText)) {
    findings.push({ type: "sy-subrc-unchecked", detail: "AUTHORITY-CHECK is not followed by an sy-subrc check" });
  }
  return findings;
}

// True when an object name is in a customer/registered namespace (Z*, Y*, /NS/*).
export function inCustomerNamespace(objectName) {
  return /^[ZY]/i.test(objectName) || /^\/[A-Za-z0-9_]+\//.test(objectName);
}

// True for local ABAP source artifacts the pre-write gate must scan.
export function isAbapSource(filePath) {
  return /\.(abap|ddls|asddls|bdef|dcls|behv|aclr)$/i.test(filePath);
}

const HEAVY_LANES = ["abap-build", "abap-auto", "abap-implement", "abap-change", "abap-refactor", "abap-validate", "abap-transport"];

// Returns the heavy build-lane command invoked in a prompt, or null.
export function buildLaneInPrompt(prompt) {
  const m = prompt.match(/\/(abap-build|abap-auto|abap-implement|abap-change|abap-refactor|abap-validate|abap-transport)\b/);
  return m && HEAVY_LANES.includes(m[1]) ? m[1] : null;
}
