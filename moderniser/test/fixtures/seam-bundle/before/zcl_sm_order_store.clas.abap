"! <p class="shorttext synchronized">Order persistence (seam fixture)</p>
"! Hand-written seam fixture — MIT, written for this repository, not vendored.
"!
"! Deliberate archetype: the object that OWNS customer persistent state. It reads
"! and writes its own Z table, so `persistenceFacts` must report owns_customer_table
"! for it. That fact is what earns a RAP BO root; an object that loses it silently
"! loses its whole target shape, which is the regression this fixture guards.
CLASS zcl_sm_order_store DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES: BEGIN OF ty_order,
             order_id   TYPE zsm_order-order_id,
             customer   TYPE zsm_order-customer,
             net_value  TYPE zsm_order-net_value,
             currency   TYPE zsm_order-currency,
             created_on TYPE zsm_order-created_on,
           END OF ty_order,
           ty_orders TYPE STANDARD TABLE OF ty_order WITH EMPTY KEY.

    METHODS read_by_customer
      IMPORTING iv_customer     TYPE zsm_order-customer
      RETURNING VALUE(rt_orders) TYPE ty_orders.

    METHODS save
      IMPORTING is_order         TYPE ty_order
      RETURNING VALUE(rv_ok)     TYPE abap_bool.

    METHODS delete
      IMPORTING iv_order_id      TYPE zsm_order-order_id
      RETURNING VALUE(rv_ok)     TYPE abap_bool.

  PRIVATE SECTION.
    METHODS enrich_from_master
      IMPORTING iv_customer          TYPE zsm_order-customer
      RETURNING VALUE(rv_country)    TYPE kna1-land1.
ENDCLASS.

CLASS zcl_sm_order_store IMPLEMENTATION.

  METHOD read_by_customer.
    SELECT order_id, customer, net_value, currency, created_on
      FROM zsm_order
      WHERE customer = @iv_customer
      INTO TABLE @rt_orders.
  ENDMETHOD.

  METHOD save.
    DATA ls_row TYPE zsm_order.

    ls_row-order_id   = is_order-order_id.
    ls_row-customer   = is_order-customer.
    ls_row-net_value  = is_order-net_value.
    ls_row-currency   = is_order-currency.
    ls_row-created_on = is_order-created_on.
    ls_row-country    = enrich_from_master( is_order-customer ).

    MODIFY zsm_order FROM ls_row.
    rv_ok = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.

  METHOD delete.
    DELETE FROM zsm_order WHERE order_id = iv_order_id.
    rv_ok = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.

  METHOD enrich_from_master.
    " Reads an SAP master-data table it does not own — reads_sap_table, distinct
    " from the owns_customer_table above. The two dimensions must not collapse.
    SELECT SINGLE land1 FROM kna1
      WHERE kunnr = @iv_customer
      INTO @rv_country.
  ENDMETHOD.

ENDCLASS.
