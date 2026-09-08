*&---------------------------------------------------------------------*
*& Report ZSM_ORDER_LIST
*&---------------------------------------------------------------------*
*& Hand-written seam fixture. NOT vendored third-party source — every line here
*& is written for this repository and carries its MIT licence, so it can ship in
*& git and run on a clean checkout (see demos/FETCH.md for why the real corpora
*& cannot). It exists to exercise the analyser -> moderniser seam end to end.
*&
*& Deliberate archetype: a classic list report. Reads an SAP table it does not
*& own, presents a UI surface, gates on AUTHORITY-CHECK, and commits. Its
*& disposition must NOT be `seal` — it has ample evidence — which is what makes
*& it a regression detector for the classifier.
*&---------------------------------------------------------------------*
REPORT zsm_order_list.

TABLES: vbak.

PARAMETERS: p_vkorg TYPE vbak-vkorg OBLIGATORY,
            p_erdat TYPE vbak-erdat.

DATA: gt_orders TYPE STANDARD TABLE OF vbak,
      gs_order  TYPE vbak,
      gv_answer TYPE c LENGTH 1.

START-OF-SELECTION.

  AUTHORITY-CHECK OBJECT 'V_VBAK_VKO'
    ID 'VKORG' FIELD p_vkorg
    ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0.
    MESSAGE 'Not authorised for this sales organisation' TYPE 'E'.
    RETURN.
  ENDIF.

  SELECT * FROM vbak
    INTO TABLE gt_orders
    WHERE vkorg = p_vkorg
      AND erdat >= p_erdat.

  IF gt_orders IS INITIAL.
    MESSAGE 'No orders found' TYPE 'S'.
    RETURN.
  ENDIF.

  CALL FUNCTION 'POPUP_TO_CONFIRM'
    EXPORTING
      titlebar      = 'Confirm'
      text_question = 'Display the selected orders?'
    IMPORTING
      answer        = gv_answer.

  IF gv_answer <> '1'.
    RETURN.
  ENDIF.

  LOOP AT gt_orders INTO gs_order.
    WRITE: / gs_order-vbeln, gs_order-erdat, gs_order-netwr, gs_order-waerk.
  ENDLOOP.

  COMMIT WORK.
