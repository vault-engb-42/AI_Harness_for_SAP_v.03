// Custom entity: APC Remote Item pane.
// Implemented by ZCL_ApcRemoteQuery (IF_RAP_QUERY_PROVIDER).
//
// SCOPE NOTICE (re-scoped capability - DESIGN.md sec 2):
// The remote pane reads a remote RELEASED HTTP/OData surface via:
//   CL_HTTP_DESTINATION_PROVIDER + IF_WEB_HTTP_CLIENT (released - confirmed).
// It does NOT read a remote OS directory or arbitrary file system.
// The destination is configured via the SAP Communication Arrangement
// (communication scenario ZAPC_REMOTE_BROWSE, destination ZAPC_REMOTE).
//
// @ObjectModel.query.implementedBy references ZCL_APCREMOTEQUERY.

@EndUserText.label: 'APC - Remote Item (released HTTP surface)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_APCREMOTEQUERY'
// Auth is enforced in the IF_RAP_QUERY_PROVIDER implementation (ZCL_APCREMOTEQUERY),
// not via CDS DCL - correct pattern for custom entities. #NOT_REQUIRED here is deliberate.
@AccessControl.authorizationCheck: #NOT_REQUIRED

define custom entity ZI_ApcRemoteItem
{
  key RemotePath    : abap.char(255);
      DisplayName   : abap.char(255);
      ItemType      : abap.char(10);    // 'ENTITY' | 'PROPERTY' | 'COLLECTION'
      HttpStatus    : abap.int4;
      ContentType   : abap.char(100);
}
