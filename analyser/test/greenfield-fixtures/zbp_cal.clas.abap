CLASS zbp_cal DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF zi_cal.
  PRIVATE SECTION.
    METHODS create_node FOR MODIFY IMPORTING entities FOR CREATE Node.
    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
      IMPORTING keys REQUEST requested_authorizations FOR Node RESULT result.
ENDCLASS.

CLASS zbp_cal IMPLEMENTATION.
  METHOD create_node.
    " Same-BO internal EML inside an authorized handler: IN LOCAL MODE is the
    " standard RAP pattern here (avoids feature-control recursion), not a bypass.
    IF entities IS NOT INITIAL.
      MODIFY ENTITIES OF zi_cal IN LOCAL MODE
        ENTITY Node
          CREATE FIELDS ( Name ) WITH entities
        REPORTED DATA(reported).
    ENDIF.
  ENDMETHOD.

  METHOD get_instance_authorizations.
    LOOP AT keys INTO DATA(key).
      APPEND VALUE #( %tky = key-%tky
                      %auth-%update = if_abap_behv=>auth-allowed ) TO result.
    ENDLOOP.
  ENDMETHOD.
ENDCLASS.
