import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAbap, objectsOf } from "../src/abap-parse.js";

// GF-2 foundation — greenfield's own minimal @abaplint/core loader for the
// cloud linter. Uses the abaplint LIBRARY only, not analyser code. Real parse.

test("parseAbap parses real ABAP source into objects", () => {
  const reg = parseAbap([{ filename: "zcl_x.clas.abap", source: "CLASS zcl_x DEFINITION PUBLIC FINAL.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\n  METHOD run.\n  ENDMETHOD.\nENDCLASS." }]);
  assert.ok(objectsOf(reg).some((o) => o.getName?.() === "ZCL_X"));
});

test("parseAbap degrades on a malformed DDIC object rather than crashing (P8)", () => {
  const badTabl = {
    filename: "zt_bad.tabl.xml",
    source: `<?xml version="1.0"?><abapGit><asx:abap><asx:values><DD02V><TABNAME>ZT_BAD</TABNAME><TABCLASS>TRANSP</TABCLASS></DD02V><DD03P_TABLE><DD03P><FIELDNAME>F1</FIELDNAME><KEYFLAG>X</KEYFLAG></DD03P></DD03P_TABLE></asx:values></asx:abap></abapGit>`,
  };
  const good = { filename: "zr_ok.prog.abap", source: "REPORT zr_ok.\nSTART-OF-SELECTION.\n  WRITE 'x'." };
  let reg;
  assert.doesNotThrow(() => {
    reg = parseAbap([badTabl, good]);
  });
  assert.ok(objectsOf(reg).some((o) => o.getName?.() === "ZR_OK"), "healthy object still parsed");
});
