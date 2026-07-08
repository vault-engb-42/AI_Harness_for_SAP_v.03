import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSnippet, enclosingUnit, attachFindingIdentity, sortFindings } from "../src/finding-identity.js";

// finding_id + AST-unit attribution (arch spec §7, conv #10/#11): finding_id =
// SHA-256(rule_id + object + enclosing_unit + normalized_snippet) — line-resilient
// (survives line shift + whitespace/case reformatting; NOT identifier/literal change).

test("normalizeSnippet collapses whitespace and upper-cases outside string literals", () => {
  assert.equal(normalizeSnippet("   select  *   from kna1  "), "SELECT * FROM KNA1");
  // string-literal content is preserved verbatim (ABAP literals are case-sensitive)
  assert.equal(normalizeSnippet("write 'Hello World'"), "WRITE 'Hello World'");
  assert.equal(normalizeSnippet(""), "");
  assert.equal(normalizeSnippet(null), "");
});

test("enclosingUnit finds the nearest METHOD, else falls back to the object", () => {
  const lines = [
    "CLASS zcl_a IMPLEMENTATION.", // 1
    "  METHOD run.", //              2
    "    SELECT * FROM kna1.", //    3
    "  ENDMETHOD.", //               4
    "  METHOD other.", //           5
    "    WRITE 'x'.", //             6
    "  ENDMETHOD.", //               7
    "ENDCLASS.", //                  8
  ];
  assert.equal(enclosingUnit(lines, 3, "ZCL_A"), "method:run");
  assert.equal(enclosingUnit(lines, 6, "ZCL_A"), "method:other");
  assert.equal(enclosingUnit(lines, 1, "ZCL_A"), "ZCL_A", "outside any method -> object fallback");
  assert.equal(enclosingUnit(lines, 8, "ZCL_A"), "ZCL_A", "after all methods -> object fallback");
});

test("attachFindingIdentity stamps enclosing_unit / normalized_snippet / finding_id", () => {
  const files = [{ filename: "z.clas.abap", source: "CLASS z IMPLEMENTATION.\n  METHOD m.\n    SELECT * FROM kna1.\n  ENDMETHOD.\nENDCLASS." }];
  const [f] = attachFindingIdentity([{ rule_id: "R1", object: "Z", file: "z.clas.abap", line: 3, message: "x" }], files);
  assert.equal(f.enclosing_unit, "method:m");
  assert.equal(f.normalized_snippet, "SELECT * FROM KNA1.");
  assert.match(f.finding_id, /^[0-9a-f]{64}$/);
});

test("finding_id survives reformatting (line shift + whitespace + keyword case) — conv #10", () => {
  const base = { filename: "z.clas.abap", source: "CLASS z IMPLEMENTATION.\n  METHOD m.\n    SELECT * FROM kna1.\n  ENDMETHOD.\nENDCLASS." };
  const reformatted = { filename: "z.clas.abap", source: "\nclass z implementation.\n  method m.\n       select   *   from kna1.\n  endmethod.\nendclass." };
  const finding = { rule_id: "R1", object: "Z", file: "z.clas.abap", message: "x" };
  const [a] = attachFindingIdentity([{ ...finding, line: 3 }], [base]); //        SELECT at line 3
  const [b] = attachFindingIdentity([{ ...finding, line: 4 }], [reformatted]); // SELECT shifted to line 4
  assert.equal(a.finding_id, b.finding_id, "finding_id is line-resilient + reformat-stable");
  const [c] = attachFindingIdentity([{ ...finding, line: 3 }], [{ filename: "z.clas.abap", source: "CLASS z IMPLEMENTATION.\n  METHOD m.\n    SELECT * FROM lfa1.\n  ENDMETHOD.\nENDCLASS." }]);
  assert.notEqual(a.finding_id, c.finding_id, "a genuinely different statement -> different finding_id");
});

test("sortFindings is a stable total order by (file, line, rule_id, object, finding_id)", () => {
  const input = [
    { file: "b.abap", line: 2, rule_id: "R2", object: "O", finding_id: "f2" },
    { file: "a.abap", line: 10, rule_id: "R1", object: "O", finding_id: "f3" },
    { file: "a.abap", line: 2, rule_id: "R1", object: "O", finding_id: "f1" },
  ];
  assert.deepEqual(sortFindings(input).map((f) => f.finding_id), ["f1", "f3", "f2"], "a:2 < a:10 (numeric) < b:2");
});
