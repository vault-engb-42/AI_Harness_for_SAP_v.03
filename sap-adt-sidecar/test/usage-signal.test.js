import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  validateRuntimeSignals,
  classifyUsageRow,
  usageResponse,
  modificationsResponse,
  DEFAULT_RETIRE_POLICY,
} from "../lib/usage-signal.js";

// GAP#3a — the offline runtime-signal substrate. A canonical, schema-validated
// dataset (produced by a pluggable adapter from SCMON/UPL/CCM-app exports) is
// served through the same MCP tool shape the live path uses. Code is generic
// over the schema; nothing about a customer's system is hardcoded. Real temp
// files + real env resolution, no mocks (tdd.md: real code path for I/O).

const CANONICAL = {
  schema_version: "1.0",
  system: "S4D",
  generated_at: "2026-07-01T00:00:00Z",
  usage: {
    source: "scmon",
    window_days: 90,
    measurement_start: "2026-04-02",
    rows: [
      { object_type: "CLAS", object_name: "ZCL_ACTIVE", package: "ZFOO", exec_count: 1200, last_used: "2026-06-30", first_seen: "2026-04-02", callers: ["ZPROG_X"] },
      { object_type: "CLAS", object_name: "ZCL_IDLE", package: "ZBAR", exec_count: 3, last_used: "2026-01-05", first_seen: "2025-11-01", callers: [] },
    ],
  },
  modifications: {
    source: "smodilog",
    rows: [
      { object_name: "MARA", object_type: "TABL", package: "ZBAR", modified_by: "DEVQ1", modified_on: "2026-05-01", mod_type: "ENHANCEMENT" },
    ],
  },
};

const AS_OF = new Date("2026-07-07T00:00:00Z");
const HERE = dirname(fileURLToPath(import.meta.url));

/** Run body with HARNESS_SIGNALS_FILE pointed at a fresh temp dataset, then clean up. */
function withDatasetFile(contents, body) {
  const dir = mkdtempSync(join(tmpdir(), "gap3a-"));
  const file = join(dir, "runtime-signals.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  const prev = process.env.HARNESS_SIGNALS_FILE;
  process.env.HARNESS_SIGNALS_FILE = file;
  try {
    return body(file);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_SIGNALS_FILE;
    else process.env.HARNESS_SIGNALS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run body with the signals path forced to a non-existent file (absent case). */
function withNoDataset(body) {
  const prev = process.env.HARNESS_SIGNALS_FILE;
  process.env.HARNESS_SIGNALS_FILE = join(tmpdir(), "gap3a-does-not-exist-4172.json");
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env.HARNESS_SIGNALS_FILE;
    else process.env.HARNESS_SIGNALS_FILE = prev;
  }
}

// ---- validator (the canonical contract) ----

test("validateRuntimeSignals accepts the canonical shape", () => {
  const r = validateRuntimeSignals(CANONICAL);
  assert.equal(r.valid, true, r.errors.join("; "));
});

test("validateRuntimeSignals requires header fields", () => {
  for (const f of ["schema_version", "system", "generated_at"]) {
    const doc = { ...CANONICAL }; delete doc[f];
    assert.equal(validateRuntimeSignals(doc).valid, false, `missing ${f} must fail`);
  }
});

test("validateRuntimeSignals rejects an unknown usage.source", () => {
  const doc = { ...CANONICAL, usage: { ...CANONICAL.usage, source: "guesswork" } };
  assert.match(validateRuntimeSignals(doc).errors.join(), /source/);
});

test("validateRuntimeSignals rejects a usage row missing object_name or with a negative exec_count", () => {
  const noName = structuredClone(CANONICAL); delete noName.usage.rows[0].object_name;
  assert.match(validateRuntimeSignals(noName).errors.join(), /object_name/);
  const negative = structuredClone(CANONICAL); negative.usage.rows[0].exec_count = -1;
  assert.match(validateRuntimeSignals(negative).errors.join(), /exec_count/);
});

test("validateRuntimeSignals rejects a modification row missing modified_by", () => {
  const doc = structuredClone(CANONICAL); delete doc.modifications.rows[0].modified_by;
  assert.match(validateRuntimeSignals(doc).errors.join(), /modified_by/);
});

test("validateRuntimeSignals accepts a dataset with only a usage section (partial-signal reality)", () => {
  const doc = { schema_version: "1.0", system: "S4D", generated_at: "2026-07-01T00:00:00Z", usage: CANONICAL.usage };
  assert.equal(validateRuntimeSignals(doc).valid, true);
});

// ---- retire classifier (facts derived from the row, policy-driven) ----

test("classifyUsageRow buckets active/idle/stale/unknown against the default policy", () => {
  assert.equal(classifyUsageRow({ last_used: "2026-06-30" }, DEFAULT_RETIRE_POLICY, AS_OF).activity, "active");
  assert.equal(classifyUsageRow({ last_used: "2026-01-05" }, DEFAULT_RETIRE_POLICY, AS_OF).activity, "idle");
  assert.equal(classifyUsageRow({ last_used: "2024-01-01" }, DEFAULT_RETIRE_POLICY, AS_OF).activity, "stale");
  assert.equal(classifyUsageRow({ last_used: null }, DEFAULT_RETIRE_POLICY, AS_OF).activity, "unknown");
});

test("classifyUsageRow reports days_since_last_use from the reference date", () => {
  assert.equal(classifyUsageRow({ last_used: "2026-06-30" }, DEFAULT_RETIRE_POLICY, AS_OF).days_since_last_use, 7);
});

// ---- usage consumer (served through the live tool shape) ----

test("usageResponse serves canonical rows when a dataset is present", () => {
  withDatasetFile(CANONICAL, () => {
    const r = usageResponse({}, AS_OF);
    assert.equal(r.data_available, true);
    assert.equal(r.source, "scmon");
    assert.equal(r.executed_objects.length, 2);
    assert.equal(r.executed_objects[0].activity, "active");
    assert.ok(r.coverage_note.length > 0, "coverage_note must warn against inferring retirement from absence");
    assert.match(r.coverage_note, /retire/i);
  });
});

test("usageResponse narrows executed_objects by package_name", () => {
  withDatasetFile(CANONICAL, () => {
    const r = usageResponse({ package_name: "ZBAR" }, AS_OF);
    assert.equal(r.executed_objects.length, 1);
    assert.equal(r.executed_objects[0].object_name, "ZCL_IDLE");
  });
});

test("usageResponse is fail-closed on a missing dataset (data_available:false, ADT-REST reason preserved)", () => {
  withNoDataset(() => {
    const r = usageResponse({ window_days: 90 }, AS_OF);
    assert.equal(r.data_available, false);
    assert.deepEqual(r.executed_objects, []);
    assert.match(r.reason, /ADT REST/);
  });
});

test("usageResponse is fail-closed on malformed JSON (no throw, no garbage served)", () => {
  withDatasetFile("{ this is not json", () => {
    const r = usageResponse({}, AS_OF);
    assert.equal(r.data_available, false);
    assert.match(r.reason, /malformed|invalid/i);
  });
});

test("usageResponse is fail-closed on a present-but-schema-invalid dataset", () => {
  withDatasetFile({ schema_version: "1.0", system: "S4D", generated_at: "x", usage: { source: "nope", rows: [] } }, () => {
    const r = usageResponse({}, AS_OF);
    assert.equal(r.data_available, false);
    assert.match(r.reason, /valid/i);
  });
});

// ---- modifications consumer ----

test("modificationsResponse serves canonical rows, filtered by package and date_from", () => {
  withDatasetFile(CANONICAL, () => {
    const all = modificationsResponse({});
    assert.equal(all.data_available, true);
    assert.equal(all.modifications.length, 1);
    assert.equal(modificationsResponse({ package_name: "ZFOO" }).modifications.length, 0);
    assert.equal(modificationsResponse({ date_from: "2026-06-01" }).modifications.length, 0);
    assert.equal(modificationsResponse({ date_from: "2026-01-01" }).modifications.length, 1);
  });
});

test("modificationsResponse is fail-closed on a missing dataset", () => {
  withNoDataset(() => {
    const r = modificationsResponse({});
    assert.equal(r.data_available, false);
    assert.deepEqual(r.modifications, []);
  });
});

// ---- policy is config, not a hardcoded constant ----

// ---- JSON-Schema companion (external contract for the step-4 adapter) ----

test("the JSON-Schema companion exists and defines the dataset sections", () => {
  const schema = JSON.parse(readFileSync(join(HERE, "..", "..", ".claude", "schemas", "runtime-signals.schema.json"), "utf8"));
  for (const def of ["signalSource", "usageSection", "usageRow", "modSection", "modRow"]) {
    assert.ok(schema.$defs[def], `schema missing $defs.${def}`);
  }
  // The schema's source enum must agree with what the runtime validator accepts.
  assert.deepEqual(schema.$defs.signalSource.enum.sort(), ["ccm-app", "scmon", "smodilog", "upl"]);
});

test("the retire policy is overridable via HARNESS_RETIRE_POLICY (no hardcoded thresholds)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gap3a-pol-"));
  const polFile = join(dir, "retire-policy.json");
  // A stricter policy: 5 days idle, 10 days stale — flips ZCL_ACTIVE (7d) to idle.
  writeFileSync(polFile, JSON.stringify({ idle_days: 5, stale_days: 10 }), "utf8");
  const prev = process.env.HARNESS_RETIRE_POLICY;
  process.env.HARNESS_RETIRE_POLICY = polFile;
  try {
    withDatasetFile(CANONICAL, () => {
      const r = usageResponse({ package_name: "ZFOO" }, AS_OF);
      assert.equal(r.executed_objects[0].activity, "idle", "custom policy must override the default threshold");
    });
  } finally {
    if (prev === undefined) delete process.env.HARNESS_RETIRE_POLICY;
    else process.env.HARNESS_RETIRE_POLICY = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
