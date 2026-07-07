import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  sapDateToIso,
  adaptUsage,
  adaptModifications,
  buildDataset,
  DEFAULT_USAGE_COLUMNS,
} from "../usage-export-adapter.js";
import { validateRuntimeSignals, usageResponse, modificationsResponse } from "../../sap-adt-sidecar/lib/usage-signal.js";

// GAP#3a step 4 — the pluggable adapter that maps a vendor usage export (here a
// German-locale SCMON/UPL CSV, semicolon-delimited, YYYYMMDD dates) into the
// canonical runtime-signals shape the sidecar serves. The USAGE fixture is
// grounded on the REAL abap_fico custom object inventory (TALOS live-e2e) — only
// the runtime numbers are synthetic. The MODIFICATION fixture references plausible
// SAP-STANDARD FI objects (SMODILOG logs mods to standard objects, which by
// definition are not in the custom inventory). No mocks: real fixture files, real
// canonical validator, real sidecar consumer, real temp-dir + subprocess round trip.

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE_CSV = readFileSync(join(HERE, "..", "fixtures", "abap_fico_scmon_usage.csv"), "utf8");
const MOD_CSV = readFileSync(join(HERE, "..", "fixtures", "abap_fico_smodilog_mods.csv"), "utf8");
const AS_OF = new Date("2026-07-07T00:00:00Z");

// ---- date transform (SAP YYYYMMDD → ISO) ----

test("sapDateToIso converts SAP dates and null-guards blanks/garbage", () => {
  assert.equal(sapDateToIso("20260706"), "2026-07-06");
  assert.equal(sapDateToIso("20240902"), "2024-09-02");
  assert.equal(sapDateToIso(""), null);
  assert.equal(sapDateToIso("00000000"), null);
  assert.equal(sapDateToIso("not-a-date"), null);
});

// ---- usage mapping ----

test("adaptUsage maps the grounded fixture to a valid canonical usage section", () => {
  const { usage, warnings } = adaptUsage(USAGE_CSV, { window_days: 730, measurement_start: "2024-07-01" });
  assert.equal(warnings.length, 0, warnings.join("; "));
  assert.equal(usage.source, "scmon");
  assert.equal(usage.rows.length, 11);
  const funcs = usage.rows.find((r) => r.object_name === "ZFICO_FUNCTIONS");
  assert.deepEqual(
    { t: funcs.object_type, p: funcs.package, c: funcs.exec_count, l: funcs.last_used },
    { t: "CLAS", p: "ZFICO", c: 45220, l: "2026-06-10" },
  );
});

test("adaptUsage output passes the sidecar's canonical validator", () => {
  const { usage } = adaptUsage(USAGE_CSV, { window_days: 730, measurement_start: "2024-07-01" });
  const doc = { schema_version: "1.0", system: "S4F", generated_at: "2026-07-07T00:00:00Z", usage };
  assert.equal(validateRuntimeSignals(doc).valid, true, validateRuntimeSignals(doc).errors.join("; "));
});

test("the delimiter and column map are config (a comma dialect with renamed columns maps too)", () => {
  const csv = "typ,obj,pkg,cnt,last\nCLAS,ZCL_X,ZDEMO,99,20260101\n";
  const columnMap = { ...DEFAULT_USAGE_COLUMNS, object_type: "typ", object_name: "obj", package: "pkg", exec_count: "cnt", last_used: "last" };
  const { usage, warnings } = adaptUsage(csv, { delimiter: ",", columnMap });
  assert.equal(warnings.length, 0);
  assert.deepEqual(usage.rows[0], { object_type: "CLAS", object_name: "ZCL_X", package: "ZDEMO", exec_count: 99, last_used: "2026-01-01", first_seen: null, callers: [] });
});

test("adaptUsage is fail-closed on a bad row (non-numeric exec_count) — skipped + warned, rest valid", () => {
  const csv = "OBJECT_TYPE;OBJECT_NAME;PACKAGE;EXEC_COUNT;LAST_USED\nCLAS;ZCL_GOOD;ZDEMO;5;20260101\nCLAS;ZCL_BAD;ZDEMO;NaN;20260101\n";
  const { usage, warnings } = adaptUsage(csv);
  assert.equal(usage.rows.length, 1);
  assert.equal(usage.rows[0].object_name, "ZCL_GOOD");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ZCL_BAD/);
});

// ---- modification mapping ----

test("adaptModifications maps the SMODILOG fixture to a valid modifications section", () => {
  const { modifications, warnings } = adaptModifications(MOD_CSV);
  assert.equal(warnings.length, 0);
  assert.equal(modifications.rows.length, 2);
  assert.equal(modifications.source, "smodilog");
  const m = modifications.rows.find((r) => r.object_name === "SAPMF05A");
  assert.deepEqual({ by: m.modified_by, on: m.modified_on, t: m.mod_type }, { by: "DEVFI01", on: "2025-03-10", t: "MODIFICATION" });
});

// ---- full dataset assembly ----

test("buildDataset assembles a canonical dataset that validates", () => {
  const { dataset, warnings } = buildDataset({
    system: "S4F", generatedAt: "2026-07-07T00:00:00Z", window_days: 730, measurement_start: "2024-07-01",
    usageCsv: USAGE_CSV, modCsv: MOD_CSV,
  });
  assert.equal(warnings.length, 0);
  assert.equal(validateRuntimeSignals(dataset).valid, true, validateRuntimeSignals(dataset).errors.join("; "));
  assert.equal(dataset.usage.rows.length, 11);
  assert.equal(dataset.modifications.rows.length, 2);
});

// ---- END-TO-END: real fixture → adapter → sidecar tool → tiered ----

test("end-to-end: adapted dataset flips both sidecar tools to data_available:true and tiers correctly", () => {
  const { dataset } = buildDataset({
    system: "S4F", generatedAt: "2026-07-07T00:00:00Z", window_days: 730, measurement_start: "2024-07-01",
    usageCsv: USAGE_CSV, modCsv: MOD_CSV,
  });
  const dir = mkdtempSync(join(tmpdir(), "gap3a-e2e-"));
  const file = join(dir, "runtime-signals.json");
  writeFileSync(file, JSON.stringify(dataset), "utf8");
  const prev = process.env.HARNESS_SIGNALS_FILE;
  process.env.HARNESS_SIGNALS_FILE = file;
  try {
    const usage = usageResponse({}, AS_OF);
    assert.equal(usage.data_available, true);
    assert.equal(usage.source, "scmon");
    assert.equal(usage.executed_objects.length, 11);
    const activity = Object.fromEntries(usage.executed_objects.map((r) => [r.object_name, r.activity]));
    // Hot FI exits are active; cooling programs idle; the old batch + rare txn are stale (retire candidates).
    assert.equal(activity.ZFI_RGGBS000, "active");
    assert.equal(activity.ZFICO_FUNCTIONS, "active");
    assert.equal(activity.ZCREATE_ASSET, "idle");
    assert.equal(activity.ZFI_FIELDSTATUS_ANALYZE, "idle");
    assert.equal(activity.ZFICO_BTC_CSV_GL, "stale");
    assert.equal(activity.Y_BS1_59000003, "stale");

    const mods = modificationsResponse({});
    assert.equal(mods.data_available, true);
    assert.equal(mods.modifications.length, 2);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_SIGNALS_FILE;
    else process.env.HARNESS_SIGNALS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- hardening (adversarial-verify findings: dates, exec_count, dedup, CLI, dialects) ----

test("sapDateToIso rejects impossible calendar dates instead of letting Date roll them over", () => {
  assert.equal(sapDateToIso("20260231"), null); // Feb 30
  assert.equal(sapDateToIso("20250431"), null); // Apr 31
  assert.equal(sapDateToIso("20250229"), null); // Feb 29, 2025 is not a leap year
  assert.equal(sapDateToIso("20240229"), "2024-02-29"); // 2024 IS a leap year
  assert.equal(sapDateToIso("20261301"), null); // month 13
  assert.equal(sapDateToIso("20260100"), null); // day 00
});

test("adaptUsage is fail-closed on blank/whitespace/hex/exponential/fractional exec_count (not coerced to 0)", () => {
  const csv = "OBJECT_TYPE;OBJECT_NAME;PACKAGE;EXEC_COUNT;LAST_USED\n"
    + "CLAS;ZCL_BLANK;ZDEMO;;20260101\n"
    + "CLAS;ZCL_HEX;ZDEMO;0x10;20260101\n"
    + "CLAS;ZCL_EXP;ZDEMO;1e3;20260101\n"
    + "CLAS;ZCL_FRAC;ZDEMO;1.5;20260101\n"
    + "CLAS;ZCL_OK;ZDEMO;7;20260101\n";
  const { usage, warnings } = adaptUsage(csv);
  assert.deepEqual(usage.rows.map((r) => r.object_name), ["ZCL_OK"]);
  assert.equal(warnings.length, 4);
});

test("adaptUsage de-duplicates rows with the same (type, name), keeping the first and warning", () => {
  const csv = "OBJECT_TYPE;OBJECT_NAME;PACKAGE;EXEC_COUNT;LAST_USED\n"
    + "CLAS;ZDUP;ZDEMO;5;20260101\n"
    + "CLAS;ZDUP;ZDEMO;9;20200101\n";
  const { usage, warnings } = adaptUsage(csv);
  assert.equal(usage.rows.length, 1);
  assert.equal(usage.rows[0].exec_count, 5);
  assert.match(warnings.join(), /duplicate/i);
});

test("buildDataset assembles usage-only and modifications-only datasets (advertised single-source dialects)", () => {
  const usageOnly = buildDataset({ system: "S4F", generatedAt: "2026-07-07T00:00:00Z", usageCsv: USAGE_CSV });
  assert.equal(validateRuntimeSignals(usageOnly.dataset).valid, true);
  assert.ok(usageOnly.dataset.usage && !usageOnly.dataset.modifications);
  const modsOnly = buildDataset({ system: "S4F", generatedAt: "2026-07-07T00:00:00Z", modCsv: MOD_CSV });
  assert.equal(validateRuntimeSignals(modsOnly.dataset).valid, true);
  assert.ok(modsOnly.dataset.modifications && !modsOnly.dataset.usage);
});

test("CLI maps a renamed-column comma export via --column-map (cross-app dialect at the operator boundary)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gap3a-cli-"));
  const csv = join(dir, "export.csv");
  const map = join(dir, "map.json");
  writeFileSync(csv, "typ,obj,pkg,cnt,last\nCLAS,ZCL_X,ZDEMO,99,20260101\n", "utf8");
  writeFileSync(map, JSON.stringify({ object_type: "typ", object_name: "obj", package: "pkg", exec_count: "cnt", last_used: "last" }), "utf8");
  try {
    const out = execFileSync(process.execPath, [
      join(HERE, "..", "usage-export-adapter.js"),
      "--usage", csv, "--system", "S4F", "--delimiter", ",", "--column-map", map,
    ], { encoding: "utf8" });
    const dataset = JSON.parse(out);
    assert.equal(dataset.usage.rows.length, 1);
    assert.deepEqual(
      { n: dataset.usage.rows[0].object_name, c: dataset.usage.rows[0].exec_count, l: dataset.usage.rows[0].last_used },
      { n: "ZCL_X", c: 99, l: "2026-01-01" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
