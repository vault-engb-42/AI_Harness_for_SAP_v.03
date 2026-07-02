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
  reg.parse();
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
