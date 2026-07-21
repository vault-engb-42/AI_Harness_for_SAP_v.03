import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, MemoryFile } from "@abaplint/core";

// gap-2b B1 — the C2 justification probe (MODERNISER_DRIVER_AND_GAP2_DESIGN §5.3 / Phase 3:
// "Probe first: parse a .bdef/.dcls with @abaplint/core and assert the AST yields no
// behaviour/grant tokens"). @abaplint/core RECOGNISES a RAP behaviour definition and a CDS
// DCL access control as OBJECTS (getType BDEF / DCLS) but parses ZERO ABAP statements from
// either — the `authorization` / `with draft` / `create-update-delete` / `action` /
// `determination` behaviour tokens and the DCL `grant … aspect pfcg_auth` clauses never
// surface as AST. So the before/after extractor needs a REGEX engine for BDEF/DCL alongside
// the AST reader for plain ABAP (the "two engines"). This is a characterization test: if a
// future abaplint gains a BDEF/DCL parser, it fails LOUDLY and the two-engine split is revisited.

const BDEF = `managed implementation in class zbp_i_travel unique;
strict ( 2 );
define behavior for ZI_Travel alias Travel
persistent table zdmo_travel
lock master
authorization master ( instance )
with draft
{
  create;
  update;
  delete;
  action ( features : instance ) copyTravel result [1] $self;
  determination setDefaults on modify { create; }
  draft table zdmo_travel_d;
  field ( readonly ) TravelId;
}`;

const DCL = `@EndUserText.label: 'Travel access'
@MappingRole: true
define role ZI_Travel_Access {
  grant select on ZI_Travel
    where ( CompanyCode ) = aspect pfcg_auth( F_BKPF_BUK, BUKRS, ACTVT = '03' );
}`;

/** Parse one source through @abaplint/core and return its objects. */
function parseObjects(filename, src) {
  const reg = new Registry();
  reg.addFile(new MemoryFile(filename, src));
  reg.parse();
  return [...reg.getObjects()];
}

/** Flatten every parsed ABAP statement across an object's ABAP files (empty when unparsed). */
function abapStatements(obj) {
  return (obj.getABAPFiles?.() ?? []).flatMap((f) => f.getStatements());
}

test("B1/C2: @abaplint/core parses ZERO statements from a RAP BDEF — behaviour tokens need the regex engine", () => {
  const objs = parseObjects("zbp_i_travel.bdef.asbdef", BDEF);
  assert.equal(objs.length, 1, "abaplint recognises the file as one object");
  assert.equal(objs[0].getType(), "BDEF", "recognised as a BehaviorDefinition object");
  assert.equal(abapStatements(objs[0]).length, 0, "but ZERO ABAP statements parsed — authorization/draft/create/action/determination are not AST-extractable");
});

test("B1/C2: @abaplint/core parses ZERO statements from a CDS DCL — grants need the regex engine", () => {
  const objs = parseObjects("zi_travel_access.dcls.asdcls", DCL);
  assert.equal(objs.length, 1, "abaplint recognises the file as one object");
  assert.equal(objs[0].getType(), "DCLS", "recognised as a DCL/access-control object");
  assert.equal(abapStatements(objs[0]).length, 0, "but ZERO ABAP statements parsed — the DCL grant clause is not AST-extractable");
});

test("B1: a plain ABAP class IS parsed by @abaplint/core (the AST reader's domain — control for the probe)", () => {
  // The contrast that makes the two-engine split precise: abaplint DOES parse plain ABAP into
  // statements (AUTHORITY-CHECK, COMMIT, etc.), so the AST reader (engine 1) handles those.
  const objs = parseObjects("zcl_x.clas.abap", `CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD run.
    AUTHORITY-CHECK OBJECT 'S_DEVELOP' ID 'ACTVT' FIELD '03'.
  ENDMETHOD.
ENDCLASS.`);
  assert.ok(objs.length === 1 && abapStatements(objs[0]).length > 0, "plain ABAP yields real statements — the AST engine's domain");
});
