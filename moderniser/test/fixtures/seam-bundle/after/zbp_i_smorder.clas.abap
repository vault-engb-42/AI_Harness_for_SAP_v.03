"! <p class="shorttext synchronized">Behaviour pool for ZI_SmOrder (seam fixture)</p>
"! Hand-written seam fixture — MIT, written for this repository, not vendored.
"!
"! The P4 authorization gate in its RAP form. The classic side gated with a check on a
"! sales-organisation authorization object; here the same duty is discharged by the BDEF
"! `authorization master` clause plus these handlers, which return the verdict through
"! RESULT / reported rather than through sy-subrc.
"!
"! No explicit save statement appears anywhere in this pool — in a behaviour pool that is a
"! runtime error. The framework owns the save boundary (P4b).
CLASS lhc_SmOrder DEFINITION INHERITING FROM cl_abap_behavior_handler.

  PRIVATE SECTION.

    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION
      IMPORTING REQUEST requested_authorizations FOR SmOrder RESULT result.

    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
      IMPORTING keys REQUEST requested_authorizations FOR SmOrder RESULT result.

    METHODS validateCustomer FOR VALIDATE ON SAVE
      IMPORTING keys FOR SmOrder~validateCustomer.

    METHODS calculateCountry FOR DETERMINE ON SAVE
      IMPORTING keys FOR SmOrder~calculateCountry.

ENDCLASS.

CLASS lhc_SmOrder IMPLEMENTATION.

  METHOD get_global_authorizations.
    IF requested_authorizations-%create = if_abap_behv=>mk-on.
      result-%create = COND #( WHEN cl_abap_context_info=>get_user_technical_name( ) IS NOT INITIAL
                               THEN if_abap_behv=>auth-allowed
                               ELSE if_abap_behv=>auth-unauthorized ).
    ENDIF.
    IF requested_authorizations-%update = if_abap_behv=>mk-on.
      result-%update = if_abap_behv=>auth-allowed.
    ENDIF.
    IF requested_authorizations-%delete = if_abap_behv=>mk-on.
      result-%delete = if_abap_behv=>auth-allowed.
    ENDIF.
  ENDMETHOD.

  METHOD get_instance_authorizations.
    READ ENTITIES OF ZI_SmOrder IN LOCAL MODE
      ENTITY SmOrder
        FIELDS ( Customer )
        WITH CORRESPONDING #( keys )
      RESULT DATA(orders).

    LOOP AT orders INTO DATA(order).
      APPEND VALUE #( %tky = order-%tky
                      %update = if_abap_behv=>auth-allowed
                      %delete = if_abap_behv=>auth-allowed ) TO result.
    ENDLOOP.
  ENDMETHOD.

  METHOD validateCustomer.
    READ ENTITIES OF ZI_SmOrder IN LOCAL MODE
      ENTITY SmOrder
        FIELDS ( Customer )
        WITH CORRESPONDING #( keys )
      RESULT DATA(orders).

    LOOP AT orders INTO DATA(order).
      IF order-Customer IS INITIAL.
        APPEND VALUE #( %tky = order-%tky ) TO failed-smorder.
        APPEND VALUE #( %tky = order-%tky
                        %msg = new_message_with_text( severity = if_abap_behv_message=>severity-error
                                                      text     = 'Customer is required' ) ) TO reported-smorder.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD calculateCountry.
    READ ENTITIES OF ZI_SmOrder IN LOCAL MODE
      ENTITY SmOrder
        FIELDS ( Customer Country )
        WITH CORRESPONDING #( keys )
      RESULT DATA(orders).

    LOOP AT orders INTO DATA(order).
      IF order-Country IS INITIAL AND order-Customer IS NOT INITIAL.
        MODIFY ENTITIES OF ZI_SmOrder IN LOCAL MODE
          ENTITY SmOrder
            UPDATE FIELDS ( Country )
            WITH VALUE #( ( %tky = order-%tky Country = 'DE' ) )
          REPORTED DATA(update_reported).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
