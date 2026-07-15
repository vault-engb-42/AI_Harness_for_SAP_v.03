import { test } from "node:test";
import assert from "node:assert/strict";
import { IDIOM_KB, groundingBrief, repairBrief } from "../src/node/idiom-kb.js";
import { analyzePackage } from "../../analyser/src/orchestrator.js";
import { ruleGate } from "../src/node/rule-gate.js";

// The idiom KB is the shared first-pass-intelligence asset: rule_id → {cause, fix, before→after
// exemplar}. It renders in TWO framings — a pre-generation "avoid these anti-patterns" grounding
// brief, and a post-gate "fix and regenerate" repair brief — both backed by the same exemplars,
// so the generator is taught the batched/pre-loaded form it must emit first-pass.

const hit = (rule_id, over) => ({ rule_id, file: "z.clas.abap", line: 1, message: "m", ...over });

test("the KB covers the gap-2a structural rules, each with a cause + fix + before/after exemplar", () => {
  for (const id of [
    "talos-rap-modify-in-loop",
    "talos-select-in-loop",
    "talos-rap-modify-entities-in-read-handler",
    "talos-rap-modify-no-guard",
  ]) {
    const e = IDIOM_KB[id];
    assert.ok(e && e.cause && e.fix && e.before && e.after, `${id} has a full KB entry`);
  }
});

test("repairBrief renders a KB-backed fix with file:line and the batched after-form exemplar", () => {
  const b = repairBrief([hit("talos-rap-modify-in-loop", { file: "zbp_x.clas.abap", line: 114 })]);
  assert.match(b, /zbp_x\.clas\.abap:114/);
  assert.match(b, /talos-rap-modify-in-loop/);
  assert.match(b, /WITH lt/i, "includes the batched after-form exemplar");
  assert.match(b, /regenerate/i, "repair framing");
});

test("groundingBrief frames the findings as anti-patterns to avoid before writing", () => {
  const b = groundingBrief([hit("talos-select-in-loop", { file: "z.clas.abap", line: 49 })]);
  assert.match(b, /do NOT reproduce|avoid/i);
  assert.match(b, /FOR ALL ENTRIES|pre-load/i, "includes the pre-load exemplar");
});

test("an unknown rule_id falls back to the finding's own message (never crashes, never blank)", () => {
  const b = repairBrief([hit("talos-some-other-rule", { message: "do the thing (ABAP-X)" })]);
  assert.match(b, /do the thing/);
  assert.match(b, /talos-some-other-rule/);
});

test("empty / missing input yields an empty brief (no noise)", () => {
  assert.equal(repairBrief([]), "");
  assert.equal(groundingBrief([]), "");
  assert.equal(repairBrief(undefined), "");
  assert.equal(groundingBrief(null), "");
});

// The AFTER exemplar must itself be gap-2a gate-clean — a fix that trips ANOTHER gate rule
// mis-teaches the generator (it would pass one rule and immediately fail the next). Wrap each
// method-body exemplar in a class and run it through the REAL analyser gate.
const BODY_EXEMPLARS = ["talos-rap-modify-in-loop", "talos-select-in-loop", "talos-rap-modify-no-guard", "talos-rap-commit-in-loop"];
test("every method-body AFTER exemplar is gap-2a gate-clean (a fix must not trip another rule)", () => {
  for (const id of BODY_EXEMPLARS) {
    const src = [
      "CLASS zcl_ex DEFINITION PUBLIC FINAL CREATE PUBLIC.",
      "  PUBLIC SECTION.",
      "    METHODS run.",
      "ENDCLASS.",
      "CLASS zcl_ex IMPLEMENTATION.",
      "  METHOD run.",
      IDIOM_KB[id].after,
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    const g = ruleGate(analyzePackage([{ filename: "zcl_ex.clas.abap", source: src }]));
    assert.equal(g.blocked, false, `${id} AFTER exemplar trips: ${g.hits.map((h) => h.rule_id).join(", ")}`);
  }
});
