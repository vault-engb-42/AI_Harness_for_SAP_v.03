# integrations/ — external adapters (outside the harness core)

Adapters that map **external, vendor-specific formats** into the harness's
canonical shapes. They live here, not in the core, by design: the harness stays a
clean producer/consumer, and the one layer that knows a vendor format is
swappable. Nothing about a customer system is hardcoded in the core.

| File | Maps | Into |
|---|---|---|
| `usage-export-adapter.js` | SCMON / UPL / Custom-Code-Migration usage + SMODILOG modification exports | `runtime-signals` canonical (served by `sap-adt-sidecar/lib/usage-signal.js`) |
| `verdict-schema.js` | the five `specs/reviews/*-verdict.json` gate verdicts | validated for the CI gate |
| `ci-gate.js` | verdict files | pass/block exit code for external CI |

## usage-export-adapter — turn a runtime-usage export into a served signal

The `/readiness` retire tier needs to know which custom objects still execute.
SAP exposes that via **SCMON** (ABAP Call Monitor) / **UPL** / the **Custom Code
Migration** app — but there is no ADT REST endpoint for it, so the live tools
report `data_available:false`. This adapter ingests an **offline export** of that
data and produces the canonical `runtime-signals.json` the sidecar serves, so the
retire tier works with no live SAP.

### Run it on your export

```bash
node integrations/usage-export-adapter.js \
  --usage   path/to/scmon_usage.csv \
  --mods    path/to/smodilog_mods.csv \   # optional
  --system  S4D \
  --window-days 730 --measurement-start 2024-07-01 \
  --out     data/runtime-signals.json
```

Then either place the output at **`data/runtime-signals.json`** (the default the
sidecar reads) or point **`HARNESS_SIGNALS_FILE`** at it. On the next
`query_scmon_usage` / `query_smodilog_modifications` call, `data_available` flips
`true` and each object carries an `activity` (`active`/`idle`/`stale`) derived
from the retire policy (`HARNESS_RETIRE_POLICY`, default idle 180d / stale 365d).

### Your export's columns differ? Map them — don't edit code

The default column map targets `OBJECT_TYPE;OBJECT_NAME;PACKAGE;EXEC_COUNT;LAST_USED;FIRST_USED`
(semicolon-delimited, `YYYYMMDD` dates). For any other dialect pass a JSON map:

```bash
--delimiter "," --column-map my-columns.json
# my-columns.json: {"object_type":"typ","object_name":"obj","exec_count":"cnt","last_used":"last"}
```

Rows that cannot satisfy the canonical contract (missing type/name, non-integer
`exec_count`, impossible date) are **skipped with a warning** (fail-closed) — the
adapter never emits invalid canonical, and never fabricates a `0` from a blank.

### What this adapter does NOT decide (layer boundary)

The adapter and the sidecar serve **facts** — *which objects were observed
executing, and how recently*. They do **not** decide retirement. Per
`.claude/skills/readiness/SKILL.md`:

- **The retire decision is the `/readiness` lane's job**, not this code. The
  primary retire signal is the *set difference* — an inventoried object **absent**
  from the usage export — cross-referenced with a source read confirming no live
  caller. That is prompt-driven lane logic, deliberately not encoded here.
- **Absence is never death.** An object missing from the export is a *candidate*,
  not a decision (the `coverage_note` states this on every response).
- **SCMON only observes executables.** DDIC objects (TABL/DTEL/DOMA) and program
  includes never appear in a usage export; the set-difference must **not** treat
  their absence as retirement candidacy — scope it to executable object types.

### The bundled fixtures

`fixtures/abap_fico_*` are grounded on the **real** object inventory of the
`abap_fico` app (TALOS `live-e2e`, a classic S/4 Finance custom-code app) — real
types, names, and packages; **only the runtime numbers are synthetic**. The
SMODILOG fixture references plausible **SAP-standard** FI objects (SMODILOG logs
modifications to *standard* objects, which by definition are not in the custom
inventory). `fixtures/abap_fico_runtime-signals.json` is the adapter's output for
that pair — a ready demo dataset to point `HARNESS_SIGNALS_FILE` at.
