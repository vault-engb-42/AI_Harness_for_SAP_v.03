import { SCHEMA_VERSION } from "./run-identity.js";

/**
 * SARIF 2.1.0 emitter (arch spec §3.C) — the analyser's OWN emitter (TALOS is
 * reference-only, decision #12: NOT tool.driver.name "talos-code-graph"). A pure,
 * deterministic transform of the curated findings into the SARIF envelope
 * confirmed by the reference sample (docs/reference/analyser-html/09-sarif.sample
 * .json): $schema, version, runs[].tool.driver{name,version,informationUri,rules},
 * results[]. Each finding -> a result; each distinct rule_id -> a reportingDescriptor.
 */

const SARIF_SCHEMA = "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";
const TOOL_NAME = "sap-abap-harness-analyser";
const TOOL_URI = "https://github.com/sap-abap-harness/analyser";

/** clean-core grade -> SARIF level (§3.C: grade tiers line up error/warning/note/note). */
const GRADE_LEVEL = { blocker: "error", warning: "warning", advisory: "note", needs_review: "note" };
/** clean-core grade -> SARIF security-severity (0-10). */
const GRADE_SECURITY_SEVERITY = { blocker: "9.0", warning: "6.0", advisory: "3.0", needs_review: "1.0" };

/** @param {{grade?: string}} f */
const levelFor = (f) => GRADE_LEVEL[f?.grade] ?? "note";
const severityFor = (f) => GRADE_SECURITY_SEVERITY[f?.grade] ?? "0.0";

/**
 * @param {{findings?: object[]}} doc a produced analyser-findings document
 * @returns {object} a SARIF 2.1.0 log
 */
export function toSarif(doc) {
  const findings = doc?.findings ?? [];

  // one reportingDescriptor per distinct rule_id, sorted for determinism.
  const ruleMap = new Map();
  for (const f of findings) {
    if (f?.rule_id == null || ruleMap.has(f.rule_id)) continue;
    ruleMap.set(f.rule_id, {
      id: f.rule_id,
      name: f.family ?? f.rule_id,
      shortDescription: { text: f.family ?? f.rule_id },
      properties: f.atcCheckId ? { atcCheckId: f.atcCheckId } : {},
    });
  }
  const rules = [...ruleMap.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const results = findings.map((f) => ({
    ruleId: f.rule_id,
    level: levelFor(f),
    message: { text: f.message ?? "" },
    locations: f.file
      ? [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line ?? 1 } } }]
      : [],
    properties: {
      "security-severity": severityFor(f),
      ...(f.atcCheckId ? { atcCheckId: f.atcCheckId } : {}),
      ...(f.finding_id ? { finding_id: f.finding_id } : {}),
    },
  }));

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: TOOL_NAME, version: SCHEMA_VERSION, informationUri: TOOL_URI, rules } },
        results,
      },
    ],
  };
}
