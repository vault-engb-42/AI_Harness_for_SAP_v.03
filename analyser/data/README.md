# Analyser bundled data

## Cloudification registry — moved

The shared SAP cloudification / API-release dataset (`objectReleaseInfoLatest.json`,
`objectClassifications_SAP.json`, `CLOUDIFICATION_LICENSE`) now lives in the
neutral top-level [`data/`](../../data/) dir — it is shared reference material for
both the analyser and greenfield, owned by neither. The analyser reads it via
[`../src/cloudification.js`](../src/cloudification.js). See [`../../data/README.md`](../../data/README.md).

## Business-function datasets (`business-functions/`) — analyser-only

| File | Purpose |
|---|---|
| `always_off_2240359.json` | Business functions that can NEVER be active in S/4HANA (SAP Note 2240359, community cross-walk) |
| `always_on_2240360.json` | Always-on business functions (SAP Note 2240360) |
| `bf_object_map.json` | BF → owned repository objects (SFW_DELIVERY_BF cross-walk) |

Copied verbatim from the TALOS reference (`backend/src/data/sap_business_functions/`);
consumed by [`../src/business-functions.js`](../src/business-functions.js) for the
CLOUD-34 rules (bf-pack). The underlying SAP Notes are login-walled; the JSONs are
a curated community cross-walk — refresh them when SAP updates the notes.

## Security

Ingested as data, not code. The business-function JSONs are 3 small curated files,
injection-scanned clean (0 markers, 0 unicode anomalies). Treated as untrusted per
harness rule P8 — used for classification lookups only, never interpolated into
instructions or tool-call arguments.
