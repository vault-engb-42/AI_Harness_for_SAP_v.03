// The 17 ABAP Developer Tools exposed by the MCP-ADT sidecar
// (docker/sap-adt/adapter.py TOOL_MAP). `readOnly: false` marks the 5 tools
// that MUTATE the SAP system — the bridge fails those closed by default (P5).

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });

export const ADT_TOOLS = [
  {
    name: "aws_abap_cb_connection_status",
    readOnly: true,
    description: "Verify SAP connection liveness and report system/client/release.",
    inputSchema: obj({}),
  },
  {
    name: "aws_abap_cb_get_objects",
    readOnly: true,
    description: "List/enumerate ABAP objects, optionally scoped to a package.",
    inputSchema: obj({ package_name: str("Package to enumerate; omit for default scope") }),
  },
  {
    name: "aws_abap_cb_get_source",
    readOnly: true,
    description: "Fetch the source code of an ABAP object.",
    inputSchema: obj(
      { object_name: str("Object name"), object_type: str("ADT object type, e.g. CLAS/PROG/DDLS") },
      ["object_name", "object_type"],
    ),
  },
  {
    name: "aws_abap_cb_search_object",
    readOnly: true,
    description: "Search objects by query and/or type.",
    inputSchema: obj({
      query: str("Free-text query"),
      object_type: str("Restrict to an ADT object type"),
      max_results: int("Cap on results"),
    }),
  },
  {
    name: "aws_abap_cb_create_object",
    readOnly: false,
    description: "Create a new ABAP object in a package on an open transport.",
    inputSchema: obj(
      {
        name: str("Object name"),
        type: str("ADT object type, e.g. CLAS/INTF/PROG/DDLS/BDEF/SRVD/SRVB/TABL"),
        package: str("Target package"),
        description: str("Short description (defaults to the object name)"),
        service_definition: str("Referenced service definition (SRVB service bindings only; defaults to the binding name)"),
        transport_request: str("Open transport request to assign the object to"),
      },
      ["name", "type", "package", "transport_request"],
    ),
  },
  {
    name: "aws_abap_cb_update_source",
    readOnly: false,
    description: "Replace the source code of an existing ABAP object.",
    inputSchema: obj(
      {
        object_name: str("Object name"),
        object_type: str("ADT object type"),
        source_code: str("New source"),
        transport_request: str("Open transport request to assign the change to"),
      },
      ["object_name", "object_type", "source_code"],
    ),
  },
  {
    name: "aws_abap_cb_check_syntax",
    readOnly: true,
    description: "Validate the syntax of an ABAP object (self-check; no gate verdict).",
    inputSchema: obj(
      { object_name: str("Object name"), object_type: str("ADT object type") },
      ["object_name", "object_type"],
    ),
  },
  {
    name: "aws_abap_cb_activate_object",
    readOnly: false,
    description: "Activate/publish a single ABAP object.",
    inputSchema: obj(
      { object_name: str("Object name"), object_type: str("ADT object type") },
      ["object_name", "object_type"],
    ),
  },
  {
    name: "aws_abap_cb_activate_objects_batch",
    readOnly: false,
    description: "Activate multiple ABAP objects in one call.",
    inputSchema: obj(
      {
        objects: {
          type: "array",
          description: "Objects to activate",
          items: obj({ object_name: str("Object name"), object_type: str("ADT object type") }, ["object_name", "object_type"]),
        },
      },
      ["objects"],
    ),
  },
  {
    name: "aws_abap_cb_run_atc_check",
    readOnly: true,
    description: "Run ABAP Test Cockpit static analysis; returns prioritised findings.",
    inputSchema: obj({
      object_name: str("Object to check"),
      object_type: str("ADT object type of the object to check (single-object ATC)"),
      package_name: str("Package to check"),
      check_variant: str("ATC check variant (harness pins ABAP_CLEAN_CORE_DEVELOPMENT)"),
    }),
  },
  {
    name: "aws_abap_cb_run_unit_tests",
    readOnly: true,
    description: "Run ABAP Unit tests for a class, optionally collecting statement coverage.",
    inputSchema: obj(
      { object_name: str("Class name"), object_type: str("ADT object type"), with_coverage: bool("Collect statement coverage for the Karpathy ratchet") },
      ["object_name"],
    ),
  },
  {
    name: "aws_abap_cb_get_test_classes",
    readOnly: true,
    description: "Retrieve the test-class source for a class.",
    inputSchema: obj(
      { class_name: str("Class name"), object_type: str("ADT object type") },
      ["class_name"],
    ),
  },
  {
    name: "aws_abap_cb_create_or_update_test_class",
    readOnly: false,
    description: "Write (create or update) the test class for a class.",
    inputSchema: obj(
      {
        class_name: str("Class name"),
        test_source: str("Test-class include source"),
        transport_request: str("Open transport request to assign the change to"),
      },
      ["class_name", "test_source"],
    ),
  },
  {
    name: "aws_abap_cb_get_transport_requests",
    readOnly: true,
    description: "List transport requests / change orders owned by a user, read from CTS via ADT.",
    inputSchema: obj({ username: str("Owner to filter by") }),
  },
  {
    name: "aws_abap_cb_get_migration_analysis",
    readOnly: true,
    description: "S/4HANA readiness / released-API analysis for an object.",
    inputSchema: obj(
      { object_name: str("Object name"), object_type: str("ADT object type") },
      ["object_name", "object_type"],
    ),
  },
  {
    name: "aws_abap_cb_query_scmon_usage",
    readOnly: true,
    description: "Query ABAP Call Monitor usage. Serves a validated offline usage dataset when present (GAP#3a), else data_available=false; never infer retirement from a missing signal.",
    inputSchema: obj({ window_days: int("Look-back window in days"), package_name: str("Package scope") }),
  },
  {
    name: "aws_abap_cb_query_smodilog_modifications",
    readOnly: true,
    description: "Query SAP-standard modification log. Serves a validated offline modification dataset when present (GAP#3a), else data_available=false; never infer cleanliness from a missing signal.",
    inputSchema: obj({ package_name: str("Package scope"), date_from: str("ISO date lower bound") }),
  },
];

export const WRITE_TOOLS = new Set(ADT_TOOLS.filter((t) => !t.readOnly).map((t) => t.name));

export const TOOL_NAMES = new Set(ADT_TOOLS.map((t) => t.name));
