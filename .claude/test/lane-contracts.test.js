import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

// Lane artifact-contract guard. The greenfield/wave lanes hand off through
// Markdown design artifacts under specs/design/; there is no compiler to catch a
// producer/consumer name mismatch, so this test IS the contract check. It scans
// every skill/agent/command definition and fails if a lane references a design
// artifact that NO lane produces — the exact silent drift that once broke the
// design->implement handoff (implement/generator read object-map.md +
// cds-contracts.md + rap-contracts.md + data-model.md, none of which any lane
// wrote; the produced set is component-map.md + object-contract.md +
// api-grounding.md). Real files, no mocks.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE = join(HERE, "..");

// Design artifacts that were consumed but never produced — retired by the
// contract reconciliation. Their reappearance is a regression.
const RETIRED_ARTIFACTS = ["object-map.md", "cds-contracts.md", "rap-contracts.md", "data-model.md"];

// The canonical produced set every consumer must code against.
const PRODUCED_ARTIFACTS = ["component-map.md", "object-contract.md", "api-grounding.md"];

/** @param {string} dir @param {RegExp} match @returns {string[]} absolute file paths */
function walk(dir, match) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, match));
    else if (match.test(name)) out.push(p);
  }
  return out;
}

/** @returns {Array<{path: string, text: string}>} every lane/agent/command definition */
function laneDefinitions() {
  const files = [
    ...walk(join(CLAUDE, "skills"), /^SKILL\.md$/),
    ...walk(join(CLAUDE, "agents"), /\.md$/),
    ...walk(join(CLAUDE, "commands"), /\.md$/),
  ];
  return files.map((path) => ({ path: relative(CLAUDE, path), text: readFileSync(path, "utf8") }));
}

test("no lane references a retired design artifact (producer/consumer drift guard)", () => {
  const defs = laneDefinitions();
  const offenders = [];
  for (const { path, text } of defs) {
    for (const artifact of RETIRED_ARTIFACTS) {
      if (text.includes(artifact)) offenders.push(`${path} references retired '${artifact}'`);
    }
  }
  assert.deepEqual(offenders, [], `retired design artifacts must not be referenced:\n${offenders.join("\n")}`);
});

test("the produced design artifacts are actually consumed by the realize lanes", () => {
  // Sanity anchor: the implement lane must read the canonical produced set, so a
  // future rename of the WRITE side cannot silently orphan the READ side again.
  const implement = laneDefinitions().find((d) => d.path.replace(/\\/g, "/") === "skills/abap-implement/SKILL.md");
  assert.ok(implement, "abap-implement/SKILL.md must exist");
  for (const artifact of PRODUCED_ARTIFACTS) {
    assert.ok(implement.text.includes(artifact), `abap-implement must consume produced artifact '${artifact}'`);
  }
});
