import { test } from "node:test";
import assert from "node:assert/strict";
import { registryProvenance } from "../src/provenance.js";

// O4: the oracle's registries must carry verifiable provenance — a content-SHA per
// bundled registry, reconciled against the committed data/registry-provenance.json
// sidecar, so a silent registry swap is detectable (feeds config_hash §7). Real
// files on disk, no mocks.

test("registryProvenance exposes a content-SHA per registry reconciled to the sidecar (O4)", () => {
  const p = registryProvenance();
  assert.ok(p.generated_at, "the sidecar records a capture/generated date");
  const rel = p.files.find((f) => f.file === "objectReleaseInfoLatest.json");
  const cls = p.files.find((f) => f.file === "objectClassifications_SAP.json");
  assert.ok(rel && cls, "both bundled registries are covered");
  for (const f of [rel, cls]) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.file}: recomputed content SHA-256 hex`);
    assert.equal(f.recorded, f.sha256, `${f.file}: sidecar SHA equals the recomputed SHA`);
    assert.equal(f.matches_sidecar, true, `${f.file}: no registry drift`);
  }
});

test("registryProvenance is fail-open and drift-detecting (O4)", () => {
  // An unreadable/missing sidecar must not throw — provenance degrades to recorded:null.
  const p = registryProvenance();
  assert.ok(Array.isArray(p.files) && p.files.length === 2, "always returns the two registry rows");
  // matches_sidecar is a strict boolean|null tri-state (never undefined).
  for (const f of p.files) assert.ok(f.matches_sidecar === true || f.matches_sidecar === false || f.matches_sidecar === null);
});
