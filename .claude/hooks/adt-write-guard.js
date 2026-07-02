// PreToolUse gate on the 5 MCP-ADT WRITE tools. Defense-in-depth for P5/P1:
//  - blocks every write unless HARNESS_ADT_ALLOW_WRITE=1 (non-prod fail-closed),
//  - refuses to create/update/activate any object outside a customer namespace
//    (writing a SAP-standard-namespace object is a modification — P1/P5).
// Read tools pass through untouched.
import { inCustomerNamespace } from "./lib/abap-checks.js";

const WRITE_TOOLS = new Set([
  "mcp__sap-adt__aws_abap_cb_create_object",
  "mcp__sap-adt__aws_abap_cb_update_source",
  "mcp__sap-adt__aws_abap_cb_activate_object",
  "mcp__sap-adt__aws_abap_cb_activate_objects_batch",
  "mcp__sap-adt__aws_abap_cb_create_or_update_test_class",
]);

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let payload = {};
try {
  payload = JSON.parse(raw || "{}");
} catch {
  process.exit(0);
}

const tool = payload.tool_name || "";
if (!WRITE_TOOLS.has(tool)) process.exit(0);

function block(msg) {
  process.stderr.write(`BLOCKED (adt-write-guard): ${msg}\n`);
  process.exit(2);
}

if (process.env.HARNESS_ADT_ALLOW_WRITE !== "1") {
  block(`SAP write tool '${tool}' is disabled (P5 non-prod fail-closed). Set HARNESS_ADT_ALLOW_WRITE=1 for a DEV connection to enable writes.`);
}

const ti = payload.tool_input || {};
const names = [];
if (ti.name) names.push(ti.name);
if (ti.object_name) names.push(ti.object_name);
if (ti.class_name) names.push(ti.class_name);
if (Array.isArray(ti.objects)) {
  for (const o of ti.objects) if (o && o.name) names.push(o.name);
}

const standard = names.filter((n) => !inCustomerNamespace(n));
if (standard.length) {
  block(`target(s) not in a customer namespace: ${standard.join(", ")}. Writing or activating a SAP-standard-namespace object is a modification (P1/P5) — refused.`);
}

process.exit(0);
