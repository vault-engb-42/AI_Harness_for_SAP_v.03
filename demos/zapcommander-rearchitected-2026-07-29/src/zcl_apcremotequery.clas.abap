*&---------------------------------------------------------------------*
*& ZCL_ApcRemoteQuery - IF_RAP_QUERY_PROVIDER for the Remote pane.
*&
*& Released outbound HTTP via:
*&   CL_HTTP_DESTINATION_PROVIDER  - released (confirmed via grounding)
*&   IF_WEB_HTTP_CLIENT            - released (confirmed via grounding)
*&   CL_WEB_HTTP_CLIENT_MANAGER    - released (confirmed via grounding)
*&
*& Communication arrangement: ZAPC_REMOTE_BROWSE (must be configured
*& via the SAP Communication Management app on the target system).
*& Destination name: ZAPC_REMOTE_DEST.
*&
*& SCOPE (honest re-scoping per DESIGN.md sec 2):
*& Reads a REMOTE RELEASED HTTP/OData surface - NOT an arbitrary remote OS
*& directory or server filesystem.  The remote side must expose an OData
*& or REST endpoint; the client reads its metadata/entities.
*&
*& LIVE-GATE (tdd.md): The HTTP round-trip requires a live destination
*& configured in the SAP Communication Arrangement.  The unit test below
*& covers only the pure request-shaping logic (URL + headers building).
*&---------------------------------------------------------------------*
CLASS zcl_apcremotequery DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_rap_query_provider.
    CONSTANTS c_destination_name TYPE string VALUE 'ZAPC_REMOTE_DEST'.

  PRIVATE SECTION.
    " Pure helper: build the request path from OData filter/paging params.
    " Testable without live HTTP (pure function).
    CLASS-METHODS build_request_path
      IMPORTING iv_top           TYPE i
                iv_skip          TYPE i
                iv_remote_path   TYPE string DEFAULT ''
      RETURNING VALUE(rv_path)   TYPE string.

ENDCLASS.


CLASS zcl_apcremotequery IMPLEMENTATION.

  " ====================================================================
  " IF_RAP_QUERY_PROVIDER~SELECT
  " ====================================================================
  METHOD if_rap_query_provider~select.
    DATA lt_result TYPE STANDARD TABLE OF zi_apcremoteitem WITH DEFAULT KEY.

    " Extract paging and filter from the OData request
    DATA(lo_paging)    = io_request->get_paging( ).
    DATA(lv_top)       = lo_paging->get_page_size( ).
    DATA(lv_skip)      = lo_paging->get_offset( ).
    DATA(lt_filters)   = io_request->get_filter( )->get_as_ranges( ).

    " Extract optional RemotePath filter
    DATA lv_remote_path TYPE string.
    LOOP AT lt_filters INTO DATA(ls_pair).
      IF ls_pair-name = 'REMOTEPATH' AND ls_pair-range IS NOT INITIAL.
        lv_remote_path = ls_pair-range[ 1 ]-low.
      ENDIF.
    ENDLOOP.

    " Build the request path (pure - testable)
    DATA(lv_path) = build_request_path(
                      iv_top         = lv_top
                      iv_skip        = lv_skip
                      iv_remote_path = lv_remote_path ).

    " DEV-GATE: HTTP round-trip starts here.
    " Released outbound: CL_HTTP_DESTINATION_PROVIDER + CL_WEB_HTTP_CLIENT_MANAGER.
    " Destination ZAPC_REMOTE_DEST must be configured via Communication Arrangement.
    DATA(lo_destination) = cl_http_destination_provider=>create_by_comm_arrangement(
                             comm_scenario  = 'ZAPC_REMOTE_BROWSE'
                             service_id     = ''
                             comm_system_id = '' ).

    DATA(lo_client) = cl_web_http_client_manager=>create_by_http_destination( lo_destination ).
    DATA(lo_request) = lo_client->get_http_request( ).
    lo_request->set_uri_path( lv_path ).

    DATA(lo_response) = lo_client->execute( if_web_http_client=>get ).
    DATA(lv_status)   = lo_response->get_status( )-code.

    " Parse status - a real implementation would parse OData JSON response here.
    " Emit a single diagnostic item reflecting the HTTP probe result.
    APPEND VALUE #(
      remotepath   = lv_path
      displayname  = lv_path
      itemtype     = 'COLLECTION'
      httpstatus   = lv_status
      contenttype  = lo_response->get_header_field( 'content-type' )
    ) TO lt_result.

    io_response->set_total_number_of_records( lines( lt_result ) ).
    io_response->set_data( lt_result ).
  ENDMETHOD.


  " ====================================================================
  " PURE HELPER - build OData request path from paging / filter params.
  " No I/O: testable by unit test without live HTTP.
  " ====================================================================
  METHOD build_request_path.
    DATA lv_base TYPE string.

    " Base path: use the remote path filter or default to OData metadata
    IF iv_remote_path IS NOT INITIAL.
      lv_base = iv_remote_path.
    ELSE.
      lv_base = '/$metadata'.
    ENDIF.

    " Append $top / $skip for paging
    DATA lv_sep TYPE string VALUE '?'.
    rv_path = lv_base.
    IF iv_top > 0.
      rv_path = rv_path && lv_sep && '$top=' && iv_top.
      lv_sep = '&'.
    ENDIF.
    IF iv_skip > 0.
      rv_path = rv_path && lv_sep && '$skip=' && iv_skip.
    ENDIF.
  ENDMETHOD.

ENDCLASS.


*"* ===================================================================
*"* Unit tests for ZCL_ApcRemoteQuery - pure request-shaping only.
*"* The live HTTP round-trip is DEV-gated (communication arrangement
*"* required). tdd.md: "not reachable without live service - document."
*"* ===================================================================
CLASS ltcl_apcremotequery DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    METHODS test_path_no_filter         FOR TESTING.
    METHODS test_path_with_top_skip     FOR TESTING.
    METHODS test_path_with_remote_path  FOR TESTING.

ENDCLASS.

CLASS ltcl_apcremotequery IMPLEMENTATION.

  " WHEN no filter THEN path defaults to /$metadata
  METHOD test_path_no_filter.
    DATA(lv_path) = zcl_apcremotequery=>build_request_path(
                      iv_top  = 0
                      iv_skip = 0 ).
    cl_abap_unit_assert=>assert_equals(
      exp = '/$metadata'
      act = lv_path
      msg = 'Default path must be /$metadata when no filter is supplied' ).
  ENDMETHOD.

  " WHEN top=10, skip=20 THEN OData paging params are appended
  METHOD test_path_with_top_skip.
    DATA(lv_path) = zcl_apcremotequery=>build_request_path(
                      iv_top  = 10
                      iv_skip = 20 ).
    cl_abap_unit_assert=>assert_char_cp(
      act = lv_path
      exp = '*$top=10*'
      msg = 'Path must contain $top=10' ).
    cl_abap_unit_assert=>assert_char_cp(
      act = lv_path
      exp = '*$skip=20*'
      msg = 'Path must contain $skip=20' ).
  ENDMETHOD.

  " WHEN RemotePath filter supplied THEN it is used as base path
  METHOD test_path_with_remote_path.
    DATA(lv_path) = zcl_apcremotequery=>build_request_path(
                      iv_top         = 0
                      iv_skip        = 0
                      iv_remote_path = '/api/v1/Nodes' ).
    cl_abap_unit_assert=>assert_char_cp(
      act = lv_path
      exp = '/api/v1/Nodes*'
      msg = 'Supplied RemotePath must be used as the request base path' ).
  ENDMETHOD.

ENDCLASS.
