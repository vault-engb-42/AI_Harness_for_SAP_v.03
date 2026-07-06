# Bundled Cloudification Registry (shared reference data)

An offline copy of SAP's cloudification / API-release classification so S/4HANA
readiness and greenfield released-API grounding work with **no network and no
external dependency** (the portable-plugin requirement).

This dir is **neutral shared reference material** — owned by neither the analyser
nor greenfield. Both read it with their own loaders; neither reaches into the
other's package for it:

- `analyser/src/cloudification.js` — S/4HANA readiness (release-state lookup).
- `greenfield/src/released-api-grounding.js` — pre-generation grounding.

## Files

| File | Entries | Purpose |
|---|---|---|
| `objectReleaseInfoLatest.json` | 34,675 | Authoritative release state per object: `released` / `deprecated` / `notToBeReleased`, plus `successors[]`. |
| `objectClassifications_SAP.json` | 8,479 | Classic-API classification (`classicAPI` / `noAPI`) for objects not in the release file. |
| `CLOUDIFICATION_LICENSE` | — | Apache-2.0 license governing the two datasets. |

Release info wins on name conflicts; classifications fill the gaps.

## Provenance

Copied verbatim from the TALOS accelerator's
`backend/src/data/sap_cloudification/` bundle (Apache-2.0). TALOS is used here as
a **reference only** — this harness has no runtime dependency on it. To refresh
the bundle from a newer TALOS checkout, re-copy the two JSONs and the
`CLOUDIFICATION_LICENSE` into this directory; both loaders are schema-tolerant to
the documented entry shape (`{ tadirObjName, objectType, state, successors[] }`).

## Security

Ingested as data, not code. Scanned before bundling: 0 prompt-injection markers,
0 unicode anomalies, 0 oversized strings (43,154 entries). Treated as untrusted
per harness rule P8 — values are used for classification lookups only, never
interpolated into instructions or tool-call arguments.
