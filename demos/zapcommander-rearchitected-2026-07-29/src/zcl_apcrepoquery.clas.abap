*&---------------------------------------------------------------------*
*& ZCL_ApcRepoQuery - IF_RAP_QUERY_PROVIDER for the Repository pane.
*&
*& SCOPE NOTICE (honest limit per DESIGN.md sec 2 + grounding):
*& XCO_CP_ABAP_REPOSITORY (part of released XCO_CP framework) exposes
*& RELEASED + CUSTOMER-NAMESPACE objects only.  Internal SAP delivery
*& objects are inaccessible in ABAP Cloud - this is the correct scope
*& for Level-A applications, not a workaround.
*&
*& Released APIs used (P2 - confirmed via mcp__greenfield__ground_released_apis):
*&   XCO_CP                   - released (XCO framework entry point)
*&   XCO_CP_ABAP_REPOSITORY   - released (repository access via XCO_CP)
*&   IF_RAP_QUERY_PROVIDER    - released (custom entity query contract)
*&
*& LIVE-GATE (tdd.md sec "When Live Stack Can't Exercise a Path"):
*& The XCO round-trip (xco_cp_abap_repository=>package->for(...)->...)
*& requires a live SAP system with DEV credentials.  The unit test
*& (ltcl_apcrepoquery below) covers only the pure request-mapping logic
*& (filter extraction + paging) - the live XCO call is documented here,
*& never mocked.
*&---------------------------------------------------------------------*
CLASS zcl_apcrepoquery DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.

  PRIVATE SECTION.
    " Pure helper: extract package filter from OData filter ranges.
    " Testable without touching XCO (pure function - tdd.md allows unit test).
    CLASS-METHODS extract_package_filter
      IMPORTING it_filter_ranges TYPE if_rap_query_filter=>tt_name_range_pairs
      RETURNING VALUE(rv_package) TYPE char30.

ENDCLASS.


CLASS zcl_apcrepoquery IMPLEMENTATION.

  " ====================================================================
  " IF_RAP_QUERY_PROVIDER~SELECT - called by RAP runtime for each OData read.
  " ====================================================================
  METHOD if_rap_query_provider~select.
    DATA lt_result TYPE STANDARD TABLE OF zi_apcrepoobject WITH DEFAULT KEY.

    " Extract paging (top / skip)
    DATA(lo_paging) = io_request->get_paging( ).
    DATA(lv_top)    = lo_paging->get_page_size( ).
    DATA(lv_skip)   = lo_paging->get_offset( ).

    " Extract filter ranges (OData $filter -> ABAP range table)
    DATA(lt_filters) = io_request->get_filter( )->get_as_ranges( ).
    DATA(lv_package) = extract_package_filter( lt_filters ).

    " DEV-GATE: XCO round-trip starts here.
    " Use XCO_CP_ABAP_REPOSITORY to list packages in the customer namespace.
    " xco_cp_abap_repository is accessed via the released XCO_CP framework.
    " Exact method chaining follows the published XCO API documentation.
    DATA(lo_packages) = xco_cp_abap_repository=>package->all->in( xco_cp_abap=>repository )->get( ).

    LOOP AT lo_packages INTO DATA(lo_package) FROM lv_skip + 1.
      DATA(lv_pkg_name) = lo_package->name->value.

      " Apply package filter from OData request
      IF lv_package IS NOT INITIAL AND NOT ( lv_pkg_name CS lv_package ).
        CONTINUE.
      ENDIF.

      " Customer-namespace check: only Z/Y prefix (released objects already visible)
      IF lv_pkg_name(1) <> 'Z' AND lv_pkg_name(1) <> 'Y'.
        CONTINUE.
      ENDIF.

      APPEND VALUE #(
        objectname        = lv_pkg_name
        objecttype        = 'DEVC'
        packagename       = lv_pkg_name
        softwarecomponent = ''
        description       = ''
      ) TO lt_result.

      " Honour OData $top paging
      IF lv_top > 0 AND lines( lt_result ) >= lv_top.
        EXIT.
      ENDIF.
    ENDLOOP.

    io_response->set_total_number_of_records( lines( lt_result ) ).
    io_response->set_data( lt_result ).
  ENDMETHOD.


  " ====================================================================
  " PURE HELPER - extract package filter from OData filter ranges.
  " No I/O: testable by unit test without live XCO.
  " ====================================================================
  METHOD extract_package_filter.
    rv_package = 'Z'.   " default: customer namespace
    LOOP AT it_filter_ranges INTO DATA(ls_pair).
      IF ls_pair-name = 'PACKAGENAME' AND ls_pair-range IS NOT INITIAL.
        rv_package = ls_pair-range[ 1 ]-low.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.


*"* ===================================================================
*"* Unit tests for ZCL_ApcRepoQuery - pure request-mapping only.
*"* The live XCO round-trip is DEV-gated (see class header comment).
*"* tdd.md: "not reachable without live service - document, don't mock."
*"* ===================================================================
CLASS ltcl_apcrepoquery DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    METHODS test_filter_extracts_package  FOR TESTING.
    METHODS test_filter_default_z         FOR TESTING.

ENDCLASS.

CLASS ltcl_apcrepoquery IMPLEMENTATION.

  " WHEN PackageName filter present THEN extract_package_filter returns it
  METHOD test_filter_extracts_package.
    DATA lt_ranges TYPE if_rap_query_filter=>tt_name_range_pairs.
    APPEND VALUE #(
      name  = 'PACKAGENAME'
      range = VALUE #( ( sign = 'I' option = 'EQ' low = 'ZAPC_CLOUD' ) )
    ) TO lt_ranges.

    DATA(lv_result) = zcl_apcrepoquery=>extract_package_filter( lt_ranges ).

    cl_abap_unit_assert=>assert_equals(
      exp = 'ZAPC_CLOUD'
      act = lv_result
      msg = 'PackageName filter must be extracted from OData ranges' ).
  ENDMETHOD.

  " WHEN no filter THEN default 'Z' (customer namespace) is returned
  METHOD test_filter_default_z.
    DATA lt_ranges TYPE if_rap_query_filter=>tt_name_range_pairs.  " empty

    DATA(lv_result) = zcl_apcrepoquery=>extract_package_filter( lt_ranges ).

    cl_abap_unit_assert=>assert_equals(
      exp = 'Z'
      act = lv_result
      msg = 'Default package filter must be Z (customer namespace)' ).
  ENDMETHOD.

ENDCLASS.
