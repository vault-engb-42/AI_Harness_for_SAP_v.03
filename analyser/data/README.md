# Bundled Cloudification Registry

The analyser ships an offline copy of SAP's cloudification / API-release
classification so S/4HANA readiness works with no network and no external
dependency (the portable-plugin requirement).

## Files

| File | Entries | Purpose |
|---|---|---|
| `objectReleaseInfoLatest.json` | 34,675 | Authoritative release state per object: `released` / `deprecated` / `notToBeReleased`, plus `successors[]`. |
| `objectClassifications_SAP.json` | 8,479 | Classic-API classification (`classicAPI` / `noAPI`) for objects not in the release file. |
| `CLOUDIFICATION_LICENSE` | — | Apache-2.0 license governing the two datasets. |

Merged and indexed by [`../src/cloudification.js`](../src/cloudification.js)
(release info wins on name conflicts; classifications fill the gaps).

## Provenance

Copied verbatim from the TALOS accelerator's
`backend/src/data/sap_cloudification/` bundle (Apache-2.0). TALOS is used here
as a **reference only** — this harness has no runtime dependency on it. To
refresh the bundle from a newer TALOS checkout, re-copy the two JSONs and the
`LICENSE` into this directory; the loader is schema-tolerant to the documented
entry shape (`{ tadirObjName, objectType, state, successors[] }`).

## Business-function datasets (`business-functions/`)

| File | Purpose |
|---|---|
| `always_off_2240359.json` | Business functions that can NEVER be active in S/4HANA (SAP Note 2240359, community cross-walk) |
| `always_on_2240360.json` | Always-on business functions (SAP Note 2240360) |
| `bf_object_map.json` | BF → owned repository objects (SFW_DELIVERY_BF cross-walk) |

Copied verbatim from the TALOS reference (`backend/src/data/sap_business_functions/`);
consumed by [`../src/business-functions.js`](../src/business-functions.js) for the
CLOUD-34 rules (bf-pack). The underlying SAP Notes are login-walled; the JSONs
are a curated community cross-walk — refresh them when SAP updates the notes.

## Security

Ingested as data, not code. Scanned before bundling: 0 prompt-injection
markers, 0 unicode anomalies, 0 oversized strings (cloudification: 43,154
entries; business functions: 3 small curated JSONs, injection-scanned clean).
Treated as untrusted per harness rule P8 — values are used for classification
lookups only, never interpolated into instructions or tool-call arguments.
