import { objNameOf } from "./cloud-linter-checks.js";

/**
 * RAP behaviour-structural checks for greenfield's ABAP-Cloud linter. Raw-source,
 * parse-independent checks over the generated `.bdef` + behaviour-pool set — greenfield's
 * own code (it shares only the `@abaplint` LIBRARY for object registration, never the
 * analyser's rule packs). abaplint registers a `.bdef.asbdef` as a BehaviorDefinition but
 * does NOT parse the BDL body, so the BDEF substrate here text-parses the raw source.
 */

// A file is a RAP behaviour pool when it declares a handler/saver on cl_abap_behavior_*
// or carries a `… FOR MODIFY/READ/DETERMINE/…` handler method (unambiguous RAP syntax).
const RAP_POOL_MARKER_RE = /\bINHERITING\s+FROM\s+cl_abap_behavior_(?:handler|saver)\b|\bFOR\s+(?:MODIFY|READ|DETERMINE|VALIDATE|LOCK|FEATURES|GLOBAL\s+AUTHORIZATION|INSTANCE\s+AUTHORIZATION)\b/i;
const COMMIT_ROLLBACK_WORK_RE = /\b(?:COMMIT|ROLLBACK)\s+WORK\b/i;

/**
 * gf-rap-no-commit-in-pool (P4(b)) — explicit `COMMIT WORK` / `ROLLBACK WORK` inside a RAP
 * behaviour pool is a RUNTIME ERROR: the RAP framework owns persistence via `COMMIT ENTITIES`.
 * Raw-source (parse-independent, so a pool with RAP handler syntax abaplint can't fully parse is
 * still covered). Scoped to files that carry a RAP-pool marker, so a plain classic class that
 * legitimately commits is never flagged. ABAP comments (`"` inline, `*` full-line) are stripped
 * first so a `" … COMMIT WORK …` note does not false-fire.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function commitInRapPoolFindings(files) {
  const findings = [];
  for (const f of files) {
    const source = String(f.source ?? "");
    if (!RAP_POOL_MARKER_RE.test(source)) continue;
    source.split(/\r?\n/).forEach((line, idx) => {
      if (/^\s*\*/.test(line)) return; // full-line comment
      const code = line.replace(/".*$/, ""); // strip inline comment ('"' is always a comment in ABAP)
      if (COMMIT_ROLLBACK_WORK_RE.test(code)) {
        findings.push({ rule_id: "gf-rap-no-commit-in-pool", severity: "error", object: objNameOf(f.filename), object_type: undefined, file: f.filename, line: idx + 1, message: "explicit COMMIT WORK / ROLLBACK WORK inside a RAP behaviour pool is a runtime error (P4(b)); the RAP framework owns persistence via COMMIT ENTITIES — remove it", family: "invariant" });
      }
    });
  }
  return findings;
}
