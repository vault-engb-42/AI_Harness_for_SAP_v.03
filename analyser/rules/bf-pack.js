import { ABAPObject } from "@abaplint/core";
import { objectsOf } from "../src/abaplint-loader.js";
import { isAlwaysOff, offOwnerOf } from "../src/business-functions.js";

/**
 * CLOUD-34 — business-function ownership rules over the bundled SAP-note
 * datasets (always-off BFs + BF->object cross-walk):
 *   talos-bf-always-off-probe  an SFW state probe of a BF that can NEVER be
 *                              active in S/4 — the guarded branch is dead
 *   talos-bf-owned-object-ref  a dependency edge onto an object owned by an
 *                              always-off BF
 */

const SFW_PROBE_RE = /(?:cl_sfw_bf_status_check|cl_fdt_environment|sfw_active|switch_is_active)[^\n]*?'(\w+)'/i;
const CLASSIFIABLE_EDGE_KINDS = new Set(["call-function", "uses-table", "consumes-cds", "inherits", "calls"]);

export const bfPack = {
  id: "bf-pack",
  family: "clean-core",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    for (const obj of objectsOf(ctx.reg)) {
      if (!(obj instanceof ABAPObject)) continue;
      for (const file of obj.getABAPFiles()) {
        scanProbes(file, obj, findings);
      }
    }
    // Owned-object detection matches an edge target against the BF cross-walk.
    // Reachable target names are object names the edge model actually emits:
    // TABL (uses-table), CDS (consumes-cds), classes (inherits/calls). The
    // dataset's FUGR rows key on the function-GROUP program (SAPL…), which no
    // edge target ever equals — a call-function edge carries the function
    // MODULE name (statement-edges.js) — so FUGR ownership is not edge-detectable
    // without an FM->function-group map the offline bundle does not carry. See
    // PARITY.md (CLOUD-34 approximation); the rows are kept for that future path.
    for (const edge of ctx.graph?.toGraphJSON?.().edges ?? []) {
      if (!CLASSIFIABLE_EDGE_KINDS.has(edge.kind)) continue;
      const bf = offOwnerOf(edge.target);
      if (bf) {
        findings.push({
          rule_id: "talos-bf-owned-object-ref",
          severity: "priority-1",
          object: edge.source,
          message: `references ${edge.target}, owned by business function ${bf}, which is ALWAYS OFF in S/4HANA — this dependency has no forward path (CLOUD-34)`,
          family: "clean-core",
        });
      }
    }
    return findings;
  },
};

function scanProbes(file, obj, findings) {
  const lines = (file.getRaw?.() ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[*"]/.test(lines[i])) continue;
    const bf = SFW_PROBE_RE.exec(lines[i])?.[1];
    if (bf && isAlwaysOff(bf)) {
      findings.push({
        rule_id: "talos-bf-always-off-probe",
        severity: "priority-1",
        object: obj.getName(),
        object_type: obj.getType(),
        file: file.getFilename(),
        line: i + 1,
        message: `probes business function ${bf.toUpperCase()}, which is ALWAYS OFF in S/4HANA (SAP Note 2240359) — the guarded code is unreachable; delete the branch (CLOUD-34)`,
        family: "clean-core",
      });
    }
  }
}
