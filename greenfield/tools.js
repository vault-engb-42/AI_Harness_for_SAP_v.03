// Tool definitions for the greenfield MCP. GF-1 exposes PRE-generation
// grounding; GF-2 adds the POST-generation ABAP-Cloud linter on the same server.

export const GREENFIELD_TOOLS = [
  {
    name: "ground_released_apis",
    description:
      "Greenfield PRE-generation grounding. Given SAP object refs (or design/spec text to harvest them from), returns each object's released-API state + released successor from the bundled SAP cloudification registry, rendered as a grounding pack to inject into the generator's context so it writes against RELEASED APIs only. Offline, deterministic — a released-API registry lookup, not a code scan.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        refs: {
          type: "array",
          items: { type: "string" },
          description: "explicit SAP object names to ground (e.g. CL_A4C_BC_FACTORY, BAPIRET1). Preferred when the design already lists its SAP dependencies.",
        },
        text: {
          type: "string",
          description: "design/spec text to harvest candidate SAP object refs from (used when `refs` is omitted).",
        },
      },
    },
  },
  {
    name: "lint_abap_cloud",
    description:
      "Greenfield POST-generation ABAP-Cloud linter. Parses the generated ABAP source (@abaplint/core) and returns Clean-Core violations — CLOUD-forbidden statements (TABLES/WRITE/native SQL/Dynpro/CALL TRANSACTION/WITH HEADER LINE), the released-API grounding check (deprecated/notToBeReleased refs), immutable-invariant breaches (COMMIT-in-loop, AUTHORITY-CHECK without SY-SUBRC), RAP/CDS structural rules, HARDY assert-less tests, and performance smells. Blocks on `error`; `repair` is an injectable brief for the lint→regenerate loop. Offline, deterministic — no SAP, not the analyser.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        files: {
          type: "array",
          description: "the generated ABAP artifacts to lint (RAP/CDS/class/test source).",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["filename", "source"],
            properties: {
              filename: { type: "string", description: "the object filename, e.g. zcl_order.clas.abap or zi_order.ddls.asddls (the extension selects the parser)." },
              source: { type: "string", description: "the ABAP/CDS source text." },
            },
          },
        },
      },
    },
  },
  {
    name: "validate_fe_descriptor",
    description:
      "Greenfield descriptor gate (G12). Validates a generated Fiori Elements app manifest.json — a NON-ATC, offline check: it must be a valid FE descriptor bound to the published SRVB OData service (an OData dataSource the default model uses), with List Report + Object Page floorplans over a main entitySet that is the generated ZC_ projection entity. Returns {findings, errorCount, warningCount}; blocks on `error`. Offline, deterministic — no SAP, not the analyser.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["manifest"],
      properties: {
        manifest: { type: "string", description: "the manifest.json content (JSON text) of the generated Fiori Elements app project." },
        entity: { type: "string", description: "the expected main entitySet — the entity the ZC_ projection (G6) exposes; the app's List Report / Object Page must target it." },
        service: { type: "string", description: "the generated OData service name the manifest's dataSource must reference (the published SRVB service)." },
      },
    },
  },
];

export const GREENFIELD_TOOL_NAMES = new Set(GREENFIELD_TOOLS.map((t) => t.name));
