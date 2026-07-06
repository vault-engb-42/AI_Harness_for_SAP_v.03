import { objectsOf } from "../src/abaplint-loader.js";

/**
 * HARDY-10: a global class with no ABAP Unit companion. A CLAS object whose
 * bundle carries no testclasses include and whose definition is not itself
 * FOR TESTING has no executable safety net — flag it so brownfield pinning
 * (characterization tests) can be routed before changes.
 */
export const missingTestClassRule = {
  id: "talos-missing-test-class",
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
      const def = obj.getClassDefinition?.();
      if (def?.isForTesting) continue; // test classes don't need test classes
      const hasTestInclude = obj.getTestclassFile?.() !== undefined;
      const hasLocalTests = /\bFOR\s+TESTING\b/i.test(obj.getFiles?.()[0]?.getRaw?.() ?? "");
      if (hasTestInclude || hasLocalTests) continue;
      findings.push({
        rule_id: "talos-missing-test-class",
        severity: "priority-2",
        object: obj.getName(),
        object_type: "CLAS",
        file: obj.getFiles()[0]?.getFilename(),
        line: 1,
        message: "class has no ABAP Unit test class (no testclasses include, no FOR TESTING local class); pin behavior before changing it (HARDY-10)",
        family: "anti-pattern",
      });
    }
    return findings;
  },
};
