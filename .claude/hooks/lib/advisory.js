import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shared spine of the ADVISORY hooks (record-run, verify-on-save, review-on-stop,
 * atc-on-activate, ratchet-guard).
 *
 * The enforcement hooks — pre-write-gate, adt-write-guard, artifact-guard — are the blocking layer:
 * PreToolUse, exit 2, fail-closed. These five are the OBSERVABILITY layer, and the separation is
 * deliberate. Two independent paths that can both block would be two sources of truth for "is this
 * allowed", and this codebase has already paid for one divergent duplication of exactly that kind.
 *
 * So the contract here is absolute and lives in `advise()` / `finish()`: an advisory hook writes
 * what it saw to stderr and exits 0. ALWAYS. It never exits 2, and a failure inside it — an
 * unwritable state directory, a corrupt baseline, malformed stdin — is swallowed rather than
 * surfaced as a hook failure, because telemetry that can wedge a session is worse than no telemetry.
 */

/** Read and parse the hook payload from stdin. Malformed input yields {} — never a throw. */
export async function readPayload() {
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/** The project's durable state dir, created on demand. */
export function stateDir(cwd) {
  const dir = join(cwd || process.cwd(), ".claude", "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Surface an observation. stderr, because stdout is reserved for structured hook output. */
export function advise(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * The single exit point. Exits 0 unconditionally — the whole point of the advisory layer.
 * Takes no code argument on purpose: there is no path here that can choose to block.
 */
export function finish() {
  process.exit(0);
}

/** Append one JSON row. Swallows every I/O failure (see the file docstring). */
export function appendJsonl(dir, file, row) {
  try {
    appendFileSync(join(dir, file), `${JSON.stringify(row)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Read a JSON file, or the supplied fallback when absent/corrupt. */
export function readJson(dir, file, fallback) {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch {
    return fallback;
  }
}

/** Write a JSON file. Swallows every I/O failure. */
export function writeJson(dir, file, value) {
  try {
    writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** An ISO timestamp for a telemetry row. */
export const now = () => new Date().toISOString();
