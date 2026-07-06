import { Registry, MemoryFile } from "@abaplint/core";

/**
 * Load a set of in-memory ABAP source files into a parsed abaplint Registry.
 * `parse()` is synchronous in @abaplint/core (verified against 2.119.x) — it
 * returns the registry itself, so no await.
 *
 * @param {Array<{filename: string, source: string}>} files
 *   filename follows abapGit convention (zcl_x.clas.abap, zr_x.prog.abap,
 *   zi_x.ddls.asddls) so the Registry infers the object type.
 * @returns {import("@abaplint/core").Registry}
 */
export function loadRegistry(files) {
  const reg = new Registry();
  for (const f of files) {
    reg.addFile(new MemoryFile(f.filename, f.source));
  }
  try {
    reg.parse();
    return reg;
  } catch {
    // abaplint's DDIC parser THROWS (rather than collecting an issue) on some
    // malformed shapes — e.g. a TABL field with no type. Untrusted abapGit XML
    // trivially produces that, so a single bad object must not crash the whole
    // analysis (harness rule P8). Rebuild from only the files that parse in
    // isolation; the dropped names are surfaced for a coverage note.
    return parseSkippingUnparseable(files);
  }
}

/**
 * P8 fallback: parse each file in isolation, keep only the ones abaplint can
 * parse without throwing, and record the rest on `reg.droppedFiles`.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {import("@abaplint/core").Registry}
 */
function parseSkippingUnparseable(files) {
  const good = [];
  const dropped = [];
  for (const f of files) {
    const probe = new Registry();
    probe.addFile(new MemoryFile(f.filename, f.source));
    try {
      probe.parse();
      good.push(f);
    } catch {
      dropped.push(f.filename);
    }
  }
  const reg = new Registry();
  for (const f of good) reg.addFile(new MemoryFile(f.filename, f.source));
  try {
    reg.parse();
  } catch {
    // Extremely defensive: a pathological cross-object interaction that only
    // surfaces in combination — leave the registry as-added rather than throw.
  }
  reg.droppedFiles = dropped;
  return reg;
}

/**
 * Spread the Registry's object iterator into an array. `getObjects()` returns
 * a generator (no `.length`), so callers that need an array use this.
 * @param {import("@abaplint/core").Registry} reg
 * @returns {import("@abaplint/core").IObject[]}
 */
export function objectsOf(reg) {
  return [...reg.getObjects()];
}
