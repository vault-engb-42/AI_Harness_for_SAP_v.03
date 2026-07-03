import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Service-binding rules (PERF-21/30). SRVB/SRVD artifacts are opaque to
 * abaplint, so the pack joins them by RAW content: an SRVB references its
 * service definition by name; the SRVD exposes CDS entities; the entities'
 * annotations carry the paging story. Files are matched by abapGit suffix
 * (.srvb. / .srvd.) independent of Registry typing, and the join is
 * fail-quiet: when a link of the chain is not in the bundle, no finding is
 * possible and none is invented.
 */

const PAGING_SIGNAL_RE = /@Capabilities|maxItems|presentationVariant|skipSupported|topSupported/i;
const LARGE_SIZE_RE = /@ObjectModel\.usageType\.sizeCategory\s*:\s*#(?:L|XL|XXL)\b/i;

export const srvbPack = {
  id: "srvb-pack",
  family: "rap-odata",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const catalog = collectArtifacts(ctx.reg);
    const findings = [];
    for (const srvb of catalog.bindings) {
      for (const srvd of catalog.definitions) {
        if (!srvb.raw.toUpperCase().includes(srvd.name)) continue;
        for (const entity of srvd.exposed) {
          const cds = catalog.cds.get(entity);
          if (!cds) continue; // chain incomplete — cannot judge
          judgeEntity(srvb, entity, cds, findings);
        }
      }
    }
    return findings;
  },
};

function judgeEntity(srvb, entity, cdsRaw, findings) {
  const mk = (rule_id, severity, message) =>
    findings.push({ rule_id, severity, object: srvb.name, object_type: "SRVB", file: srvb.file, line: 1, message, family: "rap-odata" });

  if (!PAGING_SIGNAL_RE.test(cdsRaw)) {
    mk("talos-srvb-no-paging-policy", "priority-1", `service binding ${srvb.name} exposes ${entity} with no paging policy on the view (@Capabilities / presentationVariant maxItems) — clients can pull the whole collection (ABAP-PERF-21)`);
  }
  const isV2 = /V2/i.test(srvb.raw) && /ODATA/i.test(srvb.raw);
  if (isV2 && LARGE_SIZE_RE.test(cdsRaw)) {
    mk("talos-srvb-offset-paging", "priority-2", `service binding ${srvb.name} exposes large entity ${entity} (sizeCategory L+) over OData V2 — $skip offset paging degrades on large sets; bind V4 for $skiptoken cursor paging (ABAP-PERF-30)`);
  }
}

/** @returns {{bindings: Array<{name: string, file: string, raw: string}>, definitions: Array<{name: string, exposed: string[]}>, cds: Map<string, string>}} */
function collectArtifacts(reg) {
  const bindings = [];
  const definitions = [];
  const cds = new Map();
  for (const obj of objectsOf(reg)) {
    for (const f of obj.getFiles?.() ?? []) {
      const filename = f.getFilename?.() ?? "";
      const raw = f.getRaw?.() ?? "";
      if (filename.includes(".srvb.")) {
        bindings.push({ name: obj.getName(), file: filename, raw });
      } else if (filename.includes(".srvd.")) {
        const exposed = [...raw.matchAll(/expose\s+(\w+)/gi)].map((m) => m[1].toUpperCase());
        definitions.push({ name: obj.getName().toUpperCase(), exposed });
      } else if (filename.endsWith(".asddls")) {
        cds.set(obj.getName().toUpperCase(), raw);
      }
    }
  }
  return { bindings, definitions, cds };
}
