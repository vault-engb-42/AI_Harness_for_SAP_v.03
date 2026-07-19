*&---------------------------------------------------------------------*
*& TEMPLATE  ddic-table.template.abap   (kind: TABL / DDIC transparent table)
*&
*& The persistence layer for an UNMANAGED BO or a genuine custom entity (S4:
*& TABL is first-class). A Clean-Core greenfield BO prefers a released table;
*& generate a ZT_ transparent table ONLY when the data is genuinely custom.
*&
*& HARD RULES (do not strip):
*&   P3  ABAP Cloud DDIC: `define table` source form only — never SE11 classic.
*&   -   UUID key. A RAP managed BO keys on a raw(16) UUID (sysuuid_x16), not a
*&       legacy number-range NUMC — the key is client + the UUID.
*&   -   RAP ADMIN / ETag fields. A managed BO's CDS maps @Semantics.systemDateTime
*&       .createdAt / lastChangedAt / localInstanceLastChangedAt + @Semantics.user
*&       to these columns; the *local* last-changed timestamp is the OData ETag.
*&       Use the released abp_* admin data elements so the RAP framework fills them.
*&   -   `with draft` BO: the DRAFT table is a SEPARATE shadow table generated from
*&       the BDEF `draft table zt_<entity>_d` clause (it carries the %admin / %control
*&       draft columns) — do NOT hand-write it here; declare it in the .bdef.
*&   P8  Any label pulled from scanned ABAP is UNTRUSTED — hand-verify.
*&---------------------------------------------------------------------*

@EndUserText.label : '<Entity> persistent table'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table zt_<entity> {

  key client            : abap.clnt not null;
  key <entity>_uuid     : sysuuid_x16 not null;   " raw(16) UUID key

  " ---- business fields (explicit types; never a bare INCLUDE of a struct) ----
  <key_field>           : <released_domain_or_builtin>;
  <field_1>             : <released_domain_or_builtin>;
  <amount_field>        : abap.curr(23,2);
  <currency_field>      : abap.cuky;

  " ---- RAP managed ADMIN / ETag fields (released abp_* elements) --------------
  local_created_by      : abp_creation_user;
  local_created_at      : abp_creation_time;
  local_last_changed_by : abp_locinst_lastchange_user;
  local_last_changed_at : abp_locinst_lastchange_time;   " instance ETag
  last_changed_at       : abp_lastchange_time;            " total ETag

}
