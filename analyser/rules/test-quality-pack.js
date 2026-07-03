import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Test-quality rules over the testclasses include:
 *   CLEAN-015  a FOR TESTING method whose implementation contains no
 *              assertion — the test proves nothing
 *   CLEAN-019  a public method of the class that the test include never
 *              references (classes WITHOUT any test include are HARDY-10's
 *              case, not this rule's)
 */

const ASSERT_RE = /\bCL_A(?:BAP_UNIT|UNIT)_ASSERT\b/i;

export const testQualityPack = {
  id: "test-quality-pack",
  family: "anti-pattern",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    for (const obj of objectsOf(ctx.reg)) {
      if (obj.getType?.() !== "CLAS") continue;
      const testFile = obj.getTestclassFile?.();
      if (!testFile) continue;
      checkAssertions(obj, testFile, findings);
      checkPublicCoverage(obj, testFile, findings);
    }
    return findings;
  },
};

/** CLEAN-015: FOR TESTING methods without an assertion in their body. */
function checkAssertions(obj, testFile, findings) {
  const raw = testFile.getRaw?.() ?? "";
  const testMethods = new Set([...raw.matchAll(/METHODS\s+(\w+)\s+FOR\s+TESTING/gi)].map((m) => m[1].toUpperCase()));
  if (!testMethods.size) return;
  for (const m of raw.matchAll(/\bMETHOD\s+(\w+)\s*\.([\s\S]*?)\bENDMETHOD\b/gi)) {
    const name = m[1].toUpperCase();
    if (!testMethods.has(name) || ASSERT_RE.test(m[2])) continue;
    findings.push({
      rule_id: "talos-test-no-assert",
      severity: "priority-2",
      object: obj.getName(),
      object_type: "CLAS",
      file: testFile.getFilename(),
      line: lineOfIndex(raw, m.index),
      message: `test method ${name} contains no assertion — it can never fail and proves nothing (CLEAN-015)`,
      family: "anti-pattern",
    });
  }
}

/** CLEAN-019: public methods the test include never mentions. */
function checkPublicCoverage(obj, testFile, findings) {
  const def = obj.getClassDefinition?.();
  const publicMethods = (def?.methods ?? [])
    .filter((m) => String(m.visibility ?? "").toLowerCase() !== "private" && String(m.visibility ?? "").toLowerCase() !== "protected")
    .map((m) => String(m.name).toUpperCase())
    .filter((n) => !n.startsWith("CONSTRUCTOR"));
  if (!publicMethods.length) return;
  const testRaw = (testFile.getRaw?.() ?? "").toUpperCase();
  const untested = publicMethods.filter((name) => !testRaw.includes(name));
  if (untested.length) {
    findings.push({
      rule_id: "talos-public-method-untested",
      severity: "priority-3",
      object: obj.getName(),
      object_type: "CLAS",
      file: testFile.getFilename(),
      line: 1,
      message: `public methods never referenced by the test include: ${untested.join(", ")} — behavior changes there are unguarded (CLEAN-019)`,
      family: "anti-pattern",
    });
  }
}

/** @param {string} raw @param {number} index @returns {number} 1-based line */
function lineOfIndex(raw, index) {
  return raw.slice(0, index).split("\n").length;
}
