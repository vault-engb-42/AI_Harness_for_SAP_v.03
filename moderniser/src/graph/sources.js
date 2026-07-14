/**
 * Bundle source mapper (gap-1 wiring, operator-ordered 2026-07-14): the Stage-1 dynamic
 * scan (graph/adapt.js → graph/augment.js) needs each object's raw ABAP source, but the
 * analyser findings doc deliberately carries none (P8 + size). This reads the SAME abapGit
 * bundle directory the analyser scanned and keys raw source text by OBJECT id — the
 * `sources` shape `augmentFromCpg(doc, sources)` consumes.
 *
 *   - object id = the filename up to the first "." (abapGit convention), uppercased —
 *     matching the analyser's filename-derived object identity;
 *   - recursive walk, ABAP source extensions only (parity with the analyser's
 *     BUNDLE_EXTENSIONS: .abap/.asddls/.asbdef/.acds);
 *   - multiple files for ONE object (main + includes + testclasses) CONCATENATE — the
 *     line-based scan must see every line the object owns;
 *   - deterministic: sorted walk, so the map is byte-stable across runs;
 *   - a missing/unreadable dir FAILS LOUD — a silent {} would plan an UNSEALED graph
 *     (under-approximation, the direction L5 forbids).
 *
 * The scanned text is UNTRUSTED (P8): it feeds the pattern scan only, never instructions.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const ABAP_EXTENSIONS = [".abap", ".asddls", ".asbdef", ".acds"];

/**
 * @param {string} dir the abapGit bundle directory the analyser scanned
 * @returns {Record<string, string>} OBJECT id → concatenated raw source
 */
export function readBundleSources(dir) {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new Error(`sources: bundle dir '${dir}' does not exist — an unscanned plan would be silently UNSEALED (L5)`);
  }
  if (!stat.isDirectory()) throw new Error(`sources: bundle path '${dir}' is not a directory`);
  const sources = {};
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ABAP_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      const object = basename(entry.name).split(".")[0].toUpperCase();
      if (object.length === 0) continue;
      const text = readFileSync(full, "utf8");
      sources[object] = sources[object] === undefined ? text : `${sources[object]}\n${text}`;
    }
  }
  return Object.fromEntries(Object.entries(sources).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
