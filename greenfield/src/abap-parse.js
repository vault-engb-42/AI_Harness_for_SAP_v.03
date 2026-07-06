import { Registry, MemoryFile } from "@abaplint/core";

/**
 * Greenfield's own minimal @abaplint/core loader for the cloud linter. Uses the
 * abaplint LIBRARY only — no analyser code. Defensive: a malformed generated
 * object must never crash the lint gate (mirrors the analyser's P8 posture),
 * so a throwing parse degrades to the files that parse in isolation.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {import("@abaplint/core").Registry}
 */
export function parseAbap(files) {
  const reg = new Registry();
  for (const f of files) reg.addFile(new MemoryFile(f.filename, f.source));
  try {
    reg.parse();
    return reg;
  } catch {
    const good = [];
    for (const f of files) {
      const probe = new Registry();
      probe.addFile(new MemoryFile(f.filename, f.source));
      try {
        probe.parse();
        good.push(f);
      } catch {
        // drop the object abaplint refuses to parse
      }
    }
    const clean = new Registry();
    for (const f of good) clean.addFile(new MemoryFile(f.filename, f.source));
    try {
      clean.parse();
    } catch {
      // pathological cross-object interaction — return as-added rather than throw
    }
    return clean;
  }
}

/** @param {import("@abaplint/core").Registry} reg @returns {import("@abaplint/core").IObject[]} */
export function objectsOf(reg) {
  return [...reg.getObjects()];
}
