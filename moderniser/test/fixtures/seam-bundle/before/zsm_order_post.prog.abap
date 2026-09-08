*&---------------------------------------------------------------------*
*& Report ZSM_ORDER_POST
*&---------------------------------------------------------------------*
*& Hand-written seam fixture — MIT, written for this repository, not vendored.
*&
*& Deliberate archetype: a batch poster that writes through an SAP BAPI rather
*& than touching a table directly. `persistenceFacts` must report writes_via_sap_api
*& for it — a fact carried by the CALL FUNCTION target, not by any uses-table edge.
*& It is the object that proves the write dimension has more than one producer.
*&---------------------------------------------------------------------*
REPORT zsm_order_post.

DATA: gs_header  TYPE bapisdhd1,
      gt_items   TYPE STANDARD TABLE OF bapisditm,
      gs_item    TYPE bapisditm,
      gt_return  TYPE STANDARD TABLE OF bapiret2,
      gv_vbeln   TYPE bapivbeln-vbeln.

START-OF-SELECTION.

  AUTHORITY-CHECK OBJECT 'V_VBAK_AAT'
    ID 'AUART' FIELD 'TA'
    ID 'ACTVT' FIELD '01'.
  IF sy-subrc <> 0.
    MESSAGE 'Not authorised to create orders' TYPE 'E'.
    RETURN.
  ENDIF.

  gs_header-doc_type = 'TA'.
  gs_header-sales_org = '1000'.
  gs_header-distr_chan = '10'.
  gs_header-division = '00'.

  gs_item-itm_number = '000010'.
  gs_item-material = 'SEAM-FIXTURE-01'.
  gs_item-req_qty = 1000.
  APPEND gs_item TO gt_items.

  CALL FUNCTION 'BAPI_SALESORDER_CREATEFROMDAT2'
    EXPORTING
      order_header_in = gs_header
    IMPORTING
      salesdocument   = gv_vbeln
    TABLES
      order_items_in  = gt_items
      return          = gt_return.

  READ TABLE gt_return TRANSPORTING NO FIELDS WITH KEY type = 'E'.
  IF sy-subrc = 0.
    CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
    MESSAGE 'Order creation failed' TYPE 'E'.
    RETURN.
  ENDIF.

  CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
    EXPORTING
      wait = abap_true.

  WRITE: / 'Created order', gv_vbeln.
