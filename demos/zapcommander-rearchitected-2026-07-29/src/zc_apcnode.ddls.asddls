// Projection (consumption) view entity for the APC Browser node BO.
// UI annotations are in the companion DDLX (zc_apcnode.ddlx.asddlx) so
// the UI layer evolves independently of the data model.
// @Metadata.allowExtensions: true is REQUIRED for the DDLX to attach.
//
// Associations redirected from ZI_* (interface) to ZC_* (projection)
// so the service tree stays within the projection layer (P1/P3).

@AccessControl.authorizationCheck: #CHECK   // P4: DCL enforced on the interface layer
@EndUserText.label: 'APC Browser - Node projection view'
@Metadata.allowExtensions: true

define view entity ZC_ApcNode
  as projection on ZI_ApcNode
{
  key NodeUuid,
      ParentUuid,
      Name,
      NodeType,
      ByteSize,
      MimeType,
      Content,
      CreatedBy,
      CreatedAt,
      LastChangedBy,
      LastChangedAt,
      LocalLastChangedAt,

  // Redirect self-associations to projection layer
  _Parent   : redirected to parent ZC_ApcNode,
  _Children : redirected to ZC_ApcNode
}
