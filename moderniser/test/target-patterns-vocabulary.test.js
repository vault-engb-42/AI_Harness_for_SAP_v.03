import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONSUMPTION_FACTS } from "../src/plan/consumption-facts.js";
import { PERSISTENCE_FACTS } from "../src/plan/persistence-facts.js";
import { KNOWN_HINTS } from "../src/node/disposition-hints.js";

// F-7 — a shape is selected by SIGNALS, and a signal naming something no producer ever emits can never
// contribute. `value_help_cds` keyed entirely on `family:value-help` / `family:search-help`, neither of
// which exists in the 352-rule catalogue or either data pack: a target shape that no corpus could ever
// reach, indistinguishable in the file from the eight that work.
//
// This guards the JOIN between two independently-edited artifacts — the analyser's vocabulary and the
// moderniser's corpus — which is exactly where "grow the corpus, not the code" silently drifts. A shape
// may still declare a signal ahead of its detector, but it must SAY SO in `blocked_on`, so the gap is a
// recorded decision rather than a dead branch nobody can see.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const corpus = JSON.parse(readFileSync(join(HERE, "..", "src", "plan", "patterns", "target-patterns.json"), "utf8"));
const shapes = Array.isArray(corpus) ? corpus : (corpus.shapes ?? corpus.patterns ?? Object.values(corpus).find(Array.isArray));

/** Every rule id and finding family any producer can emit: the catalogue plus the data-driven packs. */
function analyserVocabulary() {
  const ids = new Set(), families = new Set();
  const absorb = (rows) => {
    for (const r of rows ?? []) {
      if (r?.id) ids.add(r.id);
      if (r?.family) families.add(r.family);
    }
  };
  const rows = (p) => {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j) ? j : (j.rules ?? Object.values(j).find(Array.isArray));
  };
  absorb(rows(join(REPO, "analyser", "rules", "talos-catalog.json")));
  absorb(rows(join(REPO, "analyser", "rules", "data", "regex-rules.json")));
  absorb(rows(join(REPO, "analyser", "rules", "data", "metadata-rules.json")));
  families.add("abaplint"); // the built-in pack, emitted by finding-severity rather than a data row
  return { ids, families };
}

const { ids: RULE_IDS, families: FAMILIES } = analyserVocabulary();

/**
 * Closed vocabularies by signal prefix. `target:` is deliberately absent — `modernization_target` is
 * free text from the analyser (real values are released API names like `I_PRODUCT`), so there is no set
 * to check it against. `object_kind:` and `disposition:` are likewise open at this seam.
 */
const VOCABULARY = {
  consumption: new Set(CONSUMPTION_FACTS),
  persistence: new Set(PERSISTENCE_FACTS),
  hint: new Set(KNOWN_HINTS),
  family: FAMILIES,
  rule: RULE_IDS,
};

const signalsOf = (shape) => {
  const w = shape.when_signals ?? shape.when ?? {};
  return [...(w.all ?? []), ...(w.any ?? []), ...(w.none ?? [])].map(String);
};

test("every shape signal names something a producer can actually emit", () => {
  const dead = [];
  for (const shape of shapes) {
    const declared = new Set(shape.blocked_on ?? []);
    for (const sig of signalsOf(shape)) {
      const idx = sig.indexOf(":");
      if (idx < 0) continue;
      const [prefix, value] = [sig.slice(0, idx), sig.slice(idx + 1)];
      const vocab = VOCABULARY[prefix];
      if (!vocab || vocab.has(value)) continue;
      if (declared.has(sig)) continue; // an acknowledged gap, awaiting a detector
      dead.push(`${shape.id} keys on '${sig}' which no producer emits`);
    }
  }
  assert.deepEqual(dead, [], `dead signals (add to the shape's blocked_on if the detector is owed):\n  ${dead.join("\n  ")}`);
});

test("a blocked_on entry names a signal the shape actually uses — no stale acknowledgements", () => {
  for (const shape of shapes) {
    const used = new Set(signalsOf(shape));
    for (const sig of shape.blocked_on ?? []) {
      assert.ok(used.has(sig), `${shape.id} declares blocked_on '${sig}' but no longer uses that signal`);
    }
  }
});

test("a shape whose EVERY route is blocked is unreachable and must say so in its id or blocked_on", () => {
  // Not a failure by itself — an owed detector is legitimate — but the corpus must not pretend the shape
  // is selectable. Every shape needs at least one live route, or an explicit blocked_on covering the rest.
  for (const shape of shapes) {
    const w = shape.when_signals ?? shape.when ?? {};
    const routes = [...(w.any ?? [])];
    if (routes.length === 0) continue; // `all`-only shapes are covered by the first test
    const declared = new Set(shape.blocked_on ?? []);
    const live = routes.filter((sig) => {
      const idx = String(sig).indexOf(":");
      if (idx < 0) return true;
      const vocab = VOCABULARY[String(sig).slice(0, idx)];
      return !vocab || vocab.has(String(sig).slice(idx + 1));
    });
    assert.ok(live.length > 0 || routes.every((r) => declared.has(String(r))),
      `${shape.id} has no reachable route in \`any\` and does not declare the gap in blocked_on`);
  }
});
