/**
 * The analyser MCP's tool registry: three read-only entry points, one per
 * analysis mode (arch doc §10). All three emit (or summarize) the
 * analyser-findings document consumed by /abap-brownfield, /readiness and
 * /seam-finder.
 */

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const obj = (properties, required = []) => ({ type: "object", properties, required });

export const ANALYSER_TOOLS = [
  {
    name: "analyse_bundle",
    description:
      "Analyse an offline bundle: a flat directory of ABAP/CDS/RAP source files (*.abap, *.ddls.asddls, *.bdef.asbdef). Full pipeline: parse -> code graph -> all rule packs -> S/4 readiness -> blast radius. Writes the analyser-findings.json report and returns a summary.",
    inputSchema: obj(
      {
        path: str("Directory containing the source files"),
        package: str("Logical package name recorded in the report"),
        source_system: str("Identity recorded as the report's source system"),
        out: str("Report output path (default specs/brownfield/analyser-findings.json)"),
        depth: int("Blast-radius BFS depth 1-5 (default 3)"),
      },
      ["path"],
    ),
  },
  {
    name: "analyse_source_system",
    description:
      "Analyse a live SAP package via the MCP-ADT sidecar (read-only): enumerate objects, pull their source, parse locally, then run the full pipeline (graph + rules + readiness + blast radius). Requires ADT_MCP_URL to reach the sidecar.",
    inputSchema: obj(
      {
        package: str("SAP package to analyse"),
        source_system: str("Identity recorded as the report's source system"),
        out: str("Report output path (default specs/brownfield/analyser-findings.json)"),
        depth: int("Blast-radius BFS depth 1-5 (default 3)"),
      },
      ["package"],
    ),
  },
  {
    name: "get_report",
    description:
      "Return a previously written analyser-findings report (default: the standard report path). Read-only convenience for consumers that cannot read files directly.",
    inputSchema: obj({
      out: str("Report path to read (default specs/brownfield/analyser-findings.json, contained under the report root)"),
    }),
  },
  {
    name: "analyse_via_adt",
    description:
      "Subset analysis of a live SAP package via ADT signals only (read-only): run_atc_check (variant ABAP_CLEAN_CORE_DEVELOPMENT) + get_migration_analysis. No local parse — findings + readiness only, empty graph, explicit coverage note. Requires ADT_MCP_URL.",
    inputSchema: obj(
      {
        package: str("SAP package to analyse"),
        source_system: str("Identity recorded as the report's source system"),
        out: str("Report output path (default specs/brownfield/analyser-findings.json)"),
      },
      ["package"],
    ),
  },
];

export const TOOL_NAMES = new Set(ANALYSER_TOOLS.map((t) => t.name));
