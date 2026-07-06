// Tool definitions for the greenfield MCP. GF-1 exposes pre-generation
// grounding; GF-2 will add the ABAP-Cloud generation linter to the same server.

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
];

export const GREENFIELD_TOOL_NAMES = new Set(GREENFIELD_TOOLS.map((t) => t.name));
