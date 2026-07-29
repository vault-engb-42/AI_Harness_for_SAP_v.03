*&---------------------------------------------------------------------*
*& ZBP_ApcNode - managed behavior pool for ZI_ApcNode (APC Browser)
*&
*& Implementation type: plain `managed` - RAP framework owns save/commit.
*& No saver class; no COMMIT WORK / ROLLBACK WORK inside this pool (INV-2).
*&
*& P4 invariants enforced here:
*&   INV-1  AUTHORITY-CHECK gates: GET_GLOBAL_AUTHORIZATIONS (CUD) and
*&          GET_INSTANCE_AUTHORIZATIONS (row-level update/delete/action).
*&   INV-2  COMMIT WORK / ROLLBACK WORK never issued inside this pool.
*&   INV-3  SY-SUBRC checked immediately after every AUTHORITY-CHECK.
*&
*& Released APIs used (P2 - grounded via mcp__greenfield__ground_released_apis):
*&   CL_ABAP_BEHV            - released (behavior framework constants)
*&   CL_SYSTEM_UUID          - released (UUID generation for createChild)
*&   IF_ABAP_BEHV_MESSAGE     - released (error message factory)
*&   IF_ABAP_BEHV             - released (behavior constants mk-on, auth-*)
*&---------------------------------------------------------------------*
CLASS zbp_apcnode DEFINITION
  PUBLIC
  ABSTRACT
  FINAL
  FOR BEHAVIOR OF ZI_ApcNode.
ENDCLASS.

CLASS zbp_apcnode IMPLEMENTATION.
ENDCLASS.


"----------------------------------------------------------------------
" Local handler class implementing all behavior methods.
" FINAL: local handler classes must not be subclassed (talos-cloud-005).
"
" IN LOCAL MODE note (covers all EML MODIFY/READ ENTITIES calls below):
" Every READ/MODIFY ENTITIES ... IN LOCAL MODE inside this pool is a
" SAME-BO call from an already-authorized handler. This is the standard
" RAP pattern (avoids feature-control recursion - SAP Note 3136620).
" It is NOT an authorization bypass; the DCL and GET_INSTANCE_AUTH handler
" enforce access before the framework invokes any of these methods.
"----------------------------------------------------------------------
CLASS lcl_apcnode_handler DEFINITION FINAL INHERITING FROM cl_abap_behavior_handler.

  PRIVATE SECTION.

    " ---- Determination ON SAVE -----------------------------------------
    METHODS setDefaults FOR DETERMINE ON SAVE
      IMPORTING keys FOR Node~setDefaults.

    " ---- Validation ON SAVE -------------------------------------------
    METHODS validateName FOR VALIDATE ON SAVE
      IMPORTING keys FOR Node~validateName.

    " ---- Custom action: createChild ------------------------------------
    METHODS createChild FOR MODIFY
      IMPORTING keys FOR ACTION Node~createChild RESULT result.

    " ---- Custom action: attachContent ---------------------------------
    METHODS attachContent FOR MODIFY
      IMPORTING keys FOR ACTION Node~attachContent RESULT result.

    " ---- Instance feature control (action availability) ---------------
    METHODS get_instance_features FOR INSTANCE FEATURES
      IMPORTING keys REQUEST requested_features FOR Node RESULT result.

    " ---- Authorization: GLOBAL (CUD operation-level gate) ------------
    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION
      IMPORTING REQUEST requested_authorizations FOR Node RESULT result.

    " ---- Authorization: INSTANCE (per-row gate) ----------------------
    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
      IMPORTING keys REQUEST requested_authorizations FOR Node RESULT result.

    " ---- Private helper: read NodeType by keys (deduplicates the read block) --
    METHODS load_node_types
      IMPORTING it_keys  TYPE TABLE FOR READ IMPORT ZI_ApcNode\\Node
      EXPORTING et_nodes TYPE TABLE FOR READ RESULT ZI_ApcNode\\Node.

ENDCLASS.


CLASS lcl_apcnode_handler IMPLEMENTATION.

  "====================================================================
  " DETERMINATION setDefaults - fill NodeType default on create.
  " Admin fields (CreatedBy/At, LastChangedBy/At) are filled by the
  " RAP framework via @Semantics annotations on the CDS view; no
  " explicit code needed for those (managed BO handles it).
  "====================================================================
  METHOD setDefaults.
    READ ENTITIES OF ZI_ApcNode IN LOCAL MODE
      ENTITY Node
        FIELDS ( NodeType )
        WITH CORRESPONDING #( keys )
      RESULT DATA(lt_nodes).

    DATA lt_updates LIKE lt_nodes.
    LOOP AT lt_nodes INTO DATA(ls_node).
      IF ls_node-NodeType IS INITIAL.
        ls_node-NodeType = 'FOLDER'.   " default: new nodes are folders
        APPEND ls_node TO lt_updates.
      ENDIF.
    ENDLOOP.

    IF lt_updates IS NOT INITIAL.
      MODIFY ENTITIES OF ZI_ApcNode IN LOCAL MODE
        ENTITY Node
          UPDATE FIELDS ( NodeType )
          WITH CORRESPONDING #( lt_updates )
        REPORTED DATA(ls_reported).
      reported = CORRESPONDING #( DEEP ls_reported ).
    ENDIF.
  ENDMETHOD.

  "====================================================================
  " VALIDATION validateName - reject empty Name before commit.
  " Fail-closed: non-empty failed table aborts the RAP save (INV-2).
  "====================================================================
  METHOD validateName.
    READ ENTITIES OF ZI_ApcNode IN LOCAL MODE
      ENTITY Node
        FIELDS ( Name )
        WITH CORRESPONDING #( keys )
      RESULT DATA(lt_nodes).

    LOOP AT lt_nodes INTO DATA(ls_node).
      IF ls_node-Name IS INITIAL.
        APPEND VALUE #( %tky = ls_node-%tky ) TO failed-node.
        APPEND VALUE #(
          %tky      = ls_node-%tky
          %msg      = new_message_with_text(
                        severity = if_abap_behv_message=>severity-error
                        text     = 'Node Name must not be empty.' )
          %element-Name = if_abap_behv=>mk-on )
        TO reported-node.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  "====================================================================
  " ACTION createChild - creates a new child node under each parent key.
  " Returns the parent instance as $self result.
  " A new child row is created via EML MODIFY ... CREATE IN LOCAL MODE;
  " the RAP framework assigns the child's NodeUuid (managed numbering).
  " INV-2: no COMMIT WORK here - the framework commits via COMMIT ENTITIES.
  "====================================================================
  METHOD createChild.
    READ ENTITIES OF ZI_ApcNode IN LOCAL MODE
      ENTITY Node
        FIELDS ( NodeUuid NodeType )
        WITH CORRESPONDING #( keys )
      RESULT DATA(lt_parents)
      FAILED failed.

    " Build CREATE table for child nodes (one per parent key)
    DATA lt_new_children TYPE TABLE FOR CREATE ZI_ApcNode\\Node.
    DATA lv_cid_counter TYPE i VALUE 1.
    LOOP AT lt_parents INTO DATA(ls_parent).
      APPEND VALUE #(
        %cid       = |CHILD_{ lv_cid_counter }|
        ParentUuid = ls_parent-NodeUuid
        Name       = 'New Folder'
        NodeType   = 'FOLDER'
      ) TO lt_new_children.
      lv_cid_counter += 1.
    ENDLOOP.

    IF lt_new_children IS NOT INITIAL.
      MODIFY ENTITIES OF ZI_ApcNode IN LOCAL MODE
        ENTITY Node
          CREATE FIELDS ( ParentUuid Name NodeType )
          WITH lt_new_children
        FAILED   DATA(ls_create_failed)
        REPORTED DATA(ls_create_reported).

      failed    = CORRESPONDING #( DEEP ls_create_failed ).
      reported  = CORRESPONDING #( DEEP ls_create_reported ).
    ENDIF.

    " Return the parent nodes as the action result ($self)
    result = VALUE #( FOR ls_p IN lt_parents
      ( %tky   = ls_p-%tky
        %param = ls_p ) ).
  ENDMETHOD.

  "====================================================================
  " ACTION attachContent - finalise content metadata after OData upload.
  " Reads the Content field (rawstring) and writes ByteSize.
  " The actual content upload rides OData V4 streaming (@Semantics.largeObject);
  " this action is called by the client AFTER the stream PUT to commit metadata.
  " INV-2: no COMMIT WORK - the framework commits via COMMIT ENTITIES.
  "====================================================================
  METHOD attachContent.
    READ ENTITIES OF ZI_ApcNode IN LOCAL MODE
      ENTITY Node
        FIELDS ( Content MimeType )
        WITH CORRESPONDING #( keys )
      RESULT DATA(lt_nodes)
      FAILED failed.

    DATA lt_updates TYPE TABLE FOR UPDATE ZI_ApcNode\\Node.
    LOOP AT lt_nodes INTO DATA(ls_node).
      " Compute content size: XSTRLEN on rawstring gives byte count
      DATA(lv_size) = CONV int8( xstrlen( ls_node-Content ) ).
      APPEND VALUE #(
        %tky      = ls_node-%tky
        ByteSize  = lv_size
      ) TO lt_updates.
    ENDLOOP.

    IF lt_updates IS NOT INITIAL.
      MODIFY ENTITIES OF ZI_ApcNode IN LOCAL MODE
        ENTITY Node
          UPDATE FIELDS ( ByteSize )
          WITH lt_updates
        FAILED   DATA(ls_upd_failed)
        REPORTED DATA(ls_upd_reported).

      failed   = CORRESPONDING #( DEEP ls_upd_failed ).
      reported = CORRESPONDING #( DEEP ls_upd_reported ).
    ENDIF.

    " Return the updated nodes as action result ($self)
    READ ENTITIES OF ZI_ApcNode IN LOCAL MODE
      ENTITY Node
        ALL FIELDS WITH CORRESPONDING #( keys )
      RESULT DATA(lt_result_nodes).

    result = VALUE #( FOR ls_r IN lt_result_nodes
      ( %tky   = ls_r-%tky
        %param = ls_r ) ).
  ENDMETHOD.

  "====================================================================
  " INSTANCE FEATURE CONTROL - actions enabled only when NodeType is valid.
  "====================================================================
  METHOD get_instance_features.
    " load_node_types: extracts the duplicate READ block shared with get_instance_authorizations.
    load_node_types( EXPORTING it_keys = keys IMPORTING et_nodes = DATA(lt_nodes) ).

    result = VALUE #( FOR ls_n IN lt_nodes
      ( %tky                  = ls_n-%tky
        %action-createChild   = COND #( WHEN ls_n-NodeType = 'FOLDER'
                                        THEN if_abap_behv=>fc-o-enabled
                                        ELSE if_abap_behv=>fc-o-disabled )
        %action-attachContent = COND #( WHEN ls_n-NodeType = 'ITEM'
                                        THEN if_abap_behv=>fc-o-enabled
                                        ELSE if_abap_behv=>fc-o-disabled ) ) ).
  ENDMETHOD.

  "====================================================================
  " GLOBAL AUTHORIZATION - guards CUD operations (create/update/delete).
  " P4/INV-1: auth gate stays; INV-3: SY-SUBRC checked immediately.
  " Auth object ZAPC_NODE, activity: 01=create, 02=change, 06=delete.
  "====================================================================
  METHOD get_global_authorizations.
    " ---- create gate -------------------------------------------------
    AUTHORITY-CHECK OBJECT 'ZAPC_NODE'
      ID 'ACTVT' FIELD '01'.
    DATA(lv_create) = COND #( WHEN sy-subrc = 0       " INV-3: checked immediately
                               THEN if_abap_behv=>auth-allowed
                               ELSE if_abap_behv=>auth-unauthorized ).

    " ---- change gate -------------------------------------------------
    AUTHORITY-CHECK OBJECT 'ZAPC_NODE'
      ID 'ACTVT' FIELD '02'.
    DATA(lv_change) = COND #( WHEN sy-subrc = 0
                               THEN if_abap_behv=>auth-allowed
                               ELSE if_abap_behv=>auth-unauthorized ).

    " ---- delete gate -------------------------------------------------
    AUTHORITY-CHECK OBJECT 'ZAPC_NODE'
      ID 'ACTVT' FIELD '06'.
    DATA(lv_delete) = COND #( WHEN sy-subrc = 0
                               THEN if_abap_behv=>auth-allowed
                               ELSE if_abap_behv=>auth-unauthorized ).

    IF requested_authorizations-%create = if_abap_behv=>mk-on.
      result-%create = lv_create.
    ENDIF.
    IF requested_authorizations-%update = if_abap_behv=>mk-on.
      result-%update = lv_change.
    ENDIF.
    IF requested_authorizations-%delete = if_abap_behv=>mk-on.
      result-%delete = lv_delete.
    ENDIF.
  ENDMETHOD.

  "====================================================================
  " INSTANCE AUTHORIZATION - per-row gate for update/delete/actions.
  " P4/INV-1: never removed; INV-3: SY-SUBRC checked per row immediately.
  "====================================================================
  METHOD get_instance_authorizations.
    " load_node_types: shared READ helper (same-BO IN LOCAL MODE - see class header note).
    load_node_types( EXPORTING it_keys = keys IMPORTING et_nodes = DATA(lt_nodes) ).

    LOOP AT lt_nodes INTO DATA(ls_node).
      " Per-row change authorization: must hold ZAPC_NODE / ZAPC_NTYP for the NodeType
      AUTHORITY-CHECK OBJECT 'ZAPC_NODE'
        ID 'ZAPC_NTYP' FIELD ls_node-NodeType
        ID 'ACTVT'     FIELD '02'.
      DATA(lv_auth) = COND #( WHEN sy-subrc = 0    " INV-3: immediate check
                               THEN if_abap_behv=>auth-allowed
                               ELSE if_abap_behv=>auth-unauthorized ).

      APPEND VALUE #(
        %tky                  = ls_node-%tky
        %update               = lv_auth
        %delete               = lv_auth
        %action-createChild   = lv_auth
        %action-attachContent = lv_auth ) TO result.
    ENDLOOP.
  ENDMETHOD.

  "====================================================================
  " PRIVATE HELPER load_node_types - deduplicates the identical READ block
  " that was previously duplicated in get_instance_features and
  " get_instance_authorizations (talos-duplicate-block fix).
  " IN LOCAL MODE: same-BO call inside an authorized handler - standard
  " RAP pattern (see class header note). NOT an auth bypass.
  "====================================================================
  METHOD load_node_types.
    READ ENTITIES OF ZI_ApcNode IN LOCAL MODE
      ENTITY Node
        FIELDS ( NodeType )
        WITH CORRESPONDING #( it_keys )
      RESULT et_nodes.
  ENDMETHOD.

ENDCLASS.
