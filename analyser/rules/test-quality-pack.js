import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Test-quality rules over the testclasses include:
 *   CLEAN-015  a FOR TESTING method whose body asserts nothing — directly OR
 *              via a same-class helper method — proves nothing
 *   CLEAN-019  a public method of the class that the test include never
 *              references (classes WITHOUT any test include are HARDY-10's case,
 *              not this rule's)
 *
 * Both read the PARSED statement stream of the test include, not raw text, so
 * idiomatic colon-chained `METHODS:` declarations are handled — abaplint
 * normalizes them into individual MethodDef statements.
 */

const ASSERT_RE = /\bCL_A(?:BAP_UNIT|UNIT)_ASSERT\b/i;
const VISIBILITY_PUBLIC = 3; // abaplint Visibility enum: Private=1, Protected=2, Public=3

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

/**
 * Walk the test include's statements into the set of FOR TESTING method names
 * and each method's body text + start line.
 * @returns {{testMethods: Set<string>, bodies: Map<string, {text: string, line: number}>}}
 */
function parseTestMethods(testFile) {
  const testMethods = new Set();
  const bodies = new Map();
  let current = null;
  let buf = [];
  let line = 1;
  for (const st of testFile.getStatements?.() ?? []) {
    const kind = st.get()?.constructor?.name;
    const text = st.concatTokens();
    if (kind === "MethodDef") {
      if (!/\bFOR\s+TESTING\b/i.test(text)) continue;
      const nm = /^METHODS\s+([\w~]+)/i.exec(text)?.[1]?.toUpperCase();
      if (nm) testMethods.add(nm);
    } else if (kind === "MethodImplementation" || kind === "Method") {
      current = /^METHOD\s+([\w~]+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
      buf = [];
      line = st.getFirstToken()?.getStart()?.getRow?.() ?? 1;
    } else if (kind === "EndMethod") {
      if (current) bodies.set(current, { text: buf.join("\n"), line });
      current = null;
    } else if (current) {
      buf.push(text);
    }
  }
  return { testMethods, bodies };
}

/** CLEAN-015: FOR TESTING methods that assert neither directly nor through a
 * same-class helper method. */
function checkAssertions(obj, testFile, findings) {
  const { testMethods, bodies } = parseTestMethods(testFile);
  if (!testMethods.size) return;
  const asserting = new Set([...bodies].filter(([, b]) => ASSERT_RE.test(b.text)).map(([n]) => n));
  for (const name of testMethods) {
    const body = bodies.get(name);
    if (!body) continue;
    if (ASSERT_RE.test(body.text)) continue;
    if ([...asserting].some((h) => h !== name && mentions(body.text, h))) continue;
    findings.push({
      rule_id: "talos-test-no-assert",
      severity: "priority-2",
      object: obj.getName(),
      object_type: "CLAS",
      file: testFile.getFilename(),
      line: body.line,
      message: `test method ${name} contains no assertion — it can never fail and proves nothing (CLEAN-015)`,
      family: "anti-pattern",
    });
  }
}

/** @returns {boolean} whether text references identifier `name` at a word boundary */
function mentions(text, name) {
  return new RegExp(`(?<![\\w~])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w~])`, "i").test(text);
}

/** CLEAN-019: public methods the test include never mentions. */
function checkPublicCoverage(obj, testFile, findings) {
  const def = obj.getClassDefinition?.();
  const publicMethods = (def?.methods ?? [])
    .filter((m) => Number(m.visibility) === VISIBILITY_PUBLIC)
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
