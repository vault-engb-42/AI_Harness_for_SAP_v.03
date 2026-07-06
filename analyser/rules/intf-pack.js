import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Interface-signature rules (PERF-47/48): released internal APIs must be
 * consumable at scale — table-returning readers need paging parameters and
 * per-row operations need batch siblings.
 */

const PAGING_PARAM_RE = /\b\w*(?:TOP|SKIP|OFFSET|MAX|LIMIT|PAGE|PAGING)\w*\b/i;
const PER_ROW_RE = /^(\w+?)_(?:ONE|SINGLE)$/i;
const BATCH_SUFFIX_RE = /_(?:MANY|ALL|LIST|MULTI|BATCH|TABLE)$/i;

export const intfPack = {
  id: "intf-pack",
  family: "performance",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    for (const obj of objectsOf(ctx.reg)) {
      if (obj.getType?.() !== "INTF") continue;
      checkInterface(obj, findings);
    }
    return findings;
  },
};

function checkInterface(obj, findings) {
  const file = obj.getFiles()[0];
  const mk = (rule_id, message, st) =>
    findings.push({ rule_id, severity: "priority-2", object: obj.getName(), object_type: "INTF", file: file.getFilename(), line: st?.getFirstToken()?.getStart()?.getRow?.() ?? 1, message, family: "performance" });

  const methodNames = [];
  for (const f of obj.getABAPFiles?.() ?? []) {
    for (const st of f.getStatements()) {
      const text = st.concatTokens();
      const name = /^(?:METHODS|CLASS-METHODS)\s+(\w+)/i.exec(text)?.[1]?.toUpperCase();
      if (!name) continue;
      methodNames.push({ name, st });

      // PERF-47: returns a table but accepts no paging parameter. Test the
      // PARAMETER region only — strip the METHODS keyword + method name (so a
      // name like get_top_orders is not mistaken for a paging param) and the
      // RETURNING clause onward.
      const paramRegion = text.replace(/^(?:CLASS-)?METHODS\s+[\w~]+/i, "").replace(/RETURNING[\s\S]*$/i, "");
      if (/RETURNING\s+VALUE\(\w+\)\s+TYPE\s+(?:STANDARD\s+|SORTED\s+|HASHED\s+)?TABLE\b/i.test(text) && !PAGING_PARAM_RE.test(paramRegion)) {
        mk("talos-intf-read-no-paging", `interface method ${name} returns a table with no paging parameter (top/skip/max) — unbounded reads cannot scale (ABAP-PERF-47)`, st);
      }
    }
  }

  // PERF-48: a per-row method without a batch sibling sharing its prefix
  const nameSet = new Set(methodNames.map((m) => m.name));
  for (const { name, st } of methodNames) {
    const m = PER_ROW_RE.exec(name);
    if (!m) continue;
    const prefix = m[1].toUpperCase();
    const hasBatch = [...nameSet].some((other) => other !== name && other.startsWith(prefix) && BATCH_SUFFIX_RE.test(other));
    if (!hasBatch) {
      mk("talos-intf-no-batch-sibling", `interface method ${name} operates per row with no batch sibling (${prefix}_MANY/_ALL/...) — N callers will loop it into N round-trips (ABAP-PERF-48)`, st);
    }
  }
}
