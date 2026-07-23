// Stop observer. Summarises the ABAP artifacts sitting under specs/abap/ at the end of a turn, so
// what was produced is visible without re-reading the transcript. It reviews nothing and grades
// nothing: the GAN separation puts judgement in the fresh-context evaluator, and a hook that
// rendered an opinion on the generator's output would blur exactly that line. ADVISORY: exits 0.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPayload, advise, finish } from "./lib/advisory.js";
import { isAbapSource } from "./lib/abap-checks.js";

const p = await readPayload();
if (p.hook_event_name !== "Stop") finish();

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) walk(full, out);
      else if (isAbapSource(full)) out.push(name);
    } catch {
      // an unreadable entry is skipped, never fatal
    }
  }
  return out;
}

const found = walk(join(p.cwd || process.cwd(), "specs", "abap"));
if (found.length > 0) {
  const shown = found.slice(0, 8).join(", ");
  advise(`review-on-stop (advisory): ${found.length} ABAP artifact(s) under specs/abap — ${shown}${found.length > 8 ? ", …" : ""}. Grading belongs to the fresh-context evaluator (GAN separation).`);
}
finish();
