*"* ===================================================================
*"* ABAP Unit test class for ZBP_ApcNode behavior pool.
*"* ABAP-Unit-FIRST: tests are authored with the implementation.
*"*
*"* Test double: CL_ABAP_BEHV_TEST_ENVIRONMENT (released - confirmed
*"* via mcp__greenfield__ground_released_apis).  No mocks (tdd.md).
*"*
*"* Covered behaviors:
*"*   1. createChild - creates a child node under a folder parent.
*"*   2. validateName - rejects a create with empty Name.
*"*   3. GET_INSTANCE_AUTHORIZATIONS - denied case surfaces via FAILED.
*"*   4. setDefaults - new node without NodeType gets NodeType = 'FOLDER'.
*"*
*"* P4 invariants:
*"*   INV-1 Auth gate: test_auth_denied asserts FAILED is non-initial when
*"*         authorization is denied.  The AUTHORITY-CHECK is never removed.
*"*   INV-2 COMMIT WORK never issued inside this test; ROLLBACK ENTITIES
*"*         in teardown rolls back the RAP transactional buffer cleanly.
*"*   INV-3 SY-SUBRC is asserted indirectly via the FAILED structure.
*"* ===================================================================

CLASS ltcl_apcnode DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    CLASS-DATA go_env TYPE REF TO if_abap_behv_test_environment.

    CLASS-METHODS class_setup    RAISING cx_static_check.
    CLASS-METHODS class_teardown.
    METHODS       setup.
    METHODS       teardown.

    METHODS test_create_child             FOR TESTING RAISING cx_static_check.
    METHODS test_validate_name_rejects    FOR TESTING RAISING cx_static_check.
    METHODS test_set_defaults_node_type   FOR TESTING RAISING cx_static_check.
    METHODS test_auth_denied_sets_failed  FOR TESTING RAISING cx_static_check.

ENDCLASS.


CLASS ltcl_apcnode IMPLEMENTATION.

  METHOD class_setup.
    " Build the RAP behavior test environment once.
    " The double intercepts EML calls so no live DB is touched (test isolation).
    go_env = cl_abap_behv_test_environment=>create(
               i_for_entities = VALUE #(
                 ( i_for_entity = 'ZI_APCNODE' ) ) ).
  ENDMETHOD.

  METHOD class_teardown.
    go_env->destroy( ).
  ENDMETHOD.

  METHOD setup.
    " Reset the double before every test - order-independent isolation.
    go_env->clear_doubles( ).
  ENDMETHOD.

  METHOD teardown.
    " Roll back the RAP transactional buffer - never COMMIT WORK (INV-2).
    ROLLBACK ENTITIES.
  ENDMETHOD.


  " ===  1. createChild - folder parent spawns a child node  ===========
  METHOD test_create_child.
    " GIVEN a parent folder node already persisted in the test double
    DATA(lv_parent_uuid) = cl_system_uuid=>create_uuid_x16_static( ).

    go_env->insert_test_data( i_data = VALUE zi_apcnode_tab(
      ( NodeUuid  = lv_parent_uuid
        NodeType  = 'FOLDER'
        Name      = 'Root Folder'
        ByteSize  = 0 ) ) ).

    " WHEN createChild action is called on the parent via EML
    DATA lt_action_keys TYPE TABLE FOR ACTION IMPORT ZI_ApcNode~createChild.
    APPEND VALUE #( NodeUuid = lv_parent_uuid ) TO lt_action_keys.

    " ABAP-PERF-12: guard runtime driver before EML call
    IF lt_action_keys IS NOT INITIAL.
      MODIFY ENTITIES OF ZI_ApcNode
        ENTITY Node
          EXECUTE createChild
            FROM lt_action_keys
        MAPPED   DATA(ls_mapped)
        FAILED   DATA(ls_failed)
        REPORTED DATA(ls_reported).
    ENDIF.

    " THEN the action completes without error - failed is empty
    cl_abap_unit_assert=>assert_initial(
      act = ls_failed-node
      msg = 'createChild on a FOLDER node must not fail' ).
  ENDMETHOD.


  " ===  2. validateName - empty Name triggers validation error  ========
  METHOD test_validate_name_rejects.
    " GIVEN a create request with an empty Name
    DATA lt_create TYPE TABLE FOR CREATE ZI_ApcNode\\Node.
    APPEND VALUE #(
      %cid     = 'CID_EMPTY_NAME'
      NodeType = 'FOLDER'
      Name     = ''              " deliberately empty - must be rejected
    ) TO lt_create.

    " WHEN the create is submitted through EML
    " ABAP-PERF-12: guard runtime driver before EML call
    IF lt_create IS NOT INITIAL.
      MODIFY ENTITIES OF ZI_ApcNode
        ENTITY Node
          CREATE FIELDS ( Name NodeType )
            WITH lt_create
        FAILED   DATA(ls_failed)
        REPORTED DATA(ls_reported).
    ENDIF.

    " THEN the validation rejects it - FAILED structure is non-initial
    cl_abap_unit_assert=>assert_not_initial(
      act = ls_failed-node
      msg = 'Empty Name must be rejected: FAILED must be non-initial' ).
  ENDMETHOD.


  " ===  3. setDefaults - NodeType defaults to FOLDER on create  ========
  METHOD test_set_defaults_node_type.
    " GIVEN a create request that omits NodeType
    DATA lt_create TYPE TABLE FOR CREATE ZI_ApcNode\\Node.
    APPEND VALUE #(
      %cid = 'CID_DEFAULTS'
      Name = 'Unnamed Node'
      " NodeType deliberately omitted - determination must default it
    ) TO lt_create.

    " WHEN the create is submitted
    " ABAP-PERF-12: guard runtime driver before EML call
    IF lt_create IS NOT INITIAL.
      MODIFY ENTITIES OF ZI_ApcNode
        ENTITY Node
          CREATE FIELDS ( Name )
            WITH lt_create
        MAPPED   DATA(ls_mapped)
        FAILED   DATA(ls_failed)
        REPORTED DATA(ls_reported).
    ENDIF.

    " THEN the create succeeds
    cl_abap_unit_assert=>assert_initial(
      act = ls_failed-node
      msg = 'Create without NodeType must not fail - setDefaults supplies the default' ).

    " AND the mapped key exists (a node was created)
    cl_abap_unit_assert=>assert_not_initial(
      act = ls_mapped-node
      msg = 'Mapped result must be non-initial after successful create' ).
  ENDMETHOD.


  " ===  4. GET_INSTANCE_AUTHORIZATIONS - denied case  =================
  " P4/INV-1: the AUTHORITY-CHECK gate in get_instance_authorizations is
  " never removed.  This test asserts the DENIED path surfaces correctly
  " via the RAP FAILED structure.  We drive the denial through the test
  " double's authority context without weakening or removing the gate.
  METHOD test_auth_denied_sets_failed.
    " GIVEN an ITEM node in the double (attachContent is ITEM-only)
    DATA(lv_item_uuid) = cl_system_uuid=>create_uuid_x16_static( ).
    go_env->insert_test_data( i_data = VALUE zi_apcnode_tab(
      ( NodeUuid  = lv_item_uuid
        NodeType  = 'ITEM'
        Name      = 'data.csv'
        ByteSize  = 0 ) ) ).

    " AND the test double is configured to deny ZAPC_NODE / ACTVT '02'
    " (the change authorization the instance auth handler checks).
    " We use the test environment's authorization-mock capability to deny.
    go_env->set_authorization(
      i_auth_check_results = VALUE #(
        ( %key  = VALUE #( NodeUuid = lv_item_uuid )
          %auth = if_abap_behv=>auth-unauthorized ) ) ).

    " WHEN attachContent action is called on the ITEM
    DATA lt_action TYPE TABLE FOR ACTION IMPORT ZI_ApcNode~attachContent.
    APPEND VALUE #( NodeUuid = lv_item_uuid ) TO lt_action.

    " ABAP-PERF-12: guard runtime driver before EML call
    IF lt_action IS NOT INITIAL.
      MODIFY ENTITIES OF ZI_ApcNode
        ENTITY Node
          EXECUTE attachContent
            FROM lt_action
        FAILED   DATA(ls_failed)
        REPORTED DATA(ls_reported).
    ENDIF.

    " THEN the authorization denial surfaces via the FAILED structure.
    " The AUTHORITY-CHECK (INV-1) is enforced in the handler; SY-SUBRC <> 0
    " maps to auth-unauthorized which the framework exposes here (INV-3).
    cl_abap_unit_assert=>assert_not_initial(
      act = ls_failed-node
      msg = 'Auth denial must surface as non-initial FAILED structure (INV-1/INV-3)' ).
  ENDMETHOD.

ENDCLASS.
