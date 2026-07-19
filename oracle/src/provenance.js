import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Registry provenance (O4, arch spec §7 / §15.10). The bundled SAP cloudification
 * registries carry no date/SHA of their own, so the oracle cannot otherwise prove
 * WHICH registry snapshot produced a verdict. This recomputes the content-SHA of
 * each registry live and reconciles it against the committed data/registry-provenance.json
 * sidecar, so a silent registry swap is detectable (matches_sidecar:false) and the SHA
 * can feed the analyser config_hash (§7) — making a release change a hash-visible event.
 * The same SHA is the reconcile key against the live get_migration_analysis (DEV-gated).
 * Fail-open: an unreadable registry or sidecar degrades to null, never throws.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const REGISTRY_FILES = ["objectReleaseInfoLatest.json", "objectClassifications_SAP.json"];
const SIDECAR_FILE = "registry-provenance.json";

/** @param {string} path @returns {string|null} SHA-256 hex of the file's raw bytes, or null if unreadable. */
function contentSha(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null; // fail-open
  }
}

/** @returns {{generated_at: string|null, files: Array<{file: string, sha256: string|null}>}} the committed sidecar (fail-open to empty). */
function loadSidecar() {
  try {
    const s = JSON.parse(readFileSync(join(DATA_DIR, SIDECAR_FILE), "utf8"));
    return { generated_at: s.generated_at ?? null, files: Array.isArray(s.files) ? s.files : [] };
  } catch {
    return { generated_at: null, files: [] };
  }
}

/**
 * @returns {{generated_at: string|null, files: Array<{file: string, sha256: string|null, recorded: string|null, matches_sidecar: boolean|null}>}}
 *   generated_at: the sidecar capture date; per file: recomputed content SHA, the sidecar-recorded
 *   SHA, and matches_sidecar (true/false, or null when the sidecar has no row — never undefined).
 */
export function registryProvenance() {
  const sidecar = loadSidecar();
  const recorded = new Map(sidecar.files.map((f) => [f.file, f.sha256 ?? null]));
  const files = REGISTRY_FILES.map((file) => {
    const sha256 = contentSha(join(DATA_DIR, file));
    const rec = recorded.has(file) ? recorded.get(file) : null;
    return { file, sha256, recorded: rec, matches_sidecar: rec == null ? null : rec === sha256 };
  });
  return { generated_at: sidecar.generated_at, files };
}
