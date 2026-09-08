"! <p class="shorttext synchronized">Pricing arithmetic (seam fixture)</p>
"! Hand-written seam fixture — MIT, written for this repository, not vendored.
"!
"! Deliberate archetype: pure logic. No database, no UI, no remote call. It exists
"! so the fixture contains an object whose HONEST persistence answer is "none" —
"! the absence must be reported as absence, never as an unmatched shape quietly
"! resolved into a Business Object.
CLASS zcl_sm_pricing DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CONSTANTS c_max_discount_pct TYPE p LENGTH 3 DECIMALS 2 VALUE '25.00'.

    METHODS net_after_discount
      IMPORTING iv_gross           TYPE p
                iv_discount_pct    TYPE p
      RETURNING VALUE(rv_net)      TYPE p.

    METHODS is_discount_allowed
      IMPORTING iv_discount_pct    TYPE p
      RETURNING VALUE(rv_allowed)  TYPE abap_bool.

ENDCLASS.

CLASS zcl_sm_pricing IMPLEMENTATION.

  METHOD net_after_discount.
    IF is_discount_allowed( iv_discount_pct ) = abap_false.
      rv_net = iv_gross.
      RETURN.
    ENDIF.
    rv_net = iv_gross - ( iv_gross * iv_discount_pct / 100 ).
  ENDMETHOD.

  METHOD is_discount_allowed.
    rv_allowed = xsdbool( iv_discount_pct >= 0 AND iv_discount_pct <= c_max_discount_pct ).
  ENDMETHOD.

ENDCLASS.
