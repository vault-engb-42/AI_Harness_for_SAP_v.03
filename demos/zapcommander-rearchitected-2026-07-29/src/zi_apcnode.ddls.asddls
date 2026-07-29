// Interface view entity for the APC Browser node.
// Self-association: _Parent [0..1] and _Children [0..*] on the same entity
// produce an arbitrary-depth tree.  RAP composition is NOT used here -
// composition implies parent-child ownership; a self-referential flat table
// with a self-association is the correct model for an arbitrary-depth tree.
// @Hierarchy.parentChild enables recursive hierarchy navigation in Fiori.

@AbapCatalog.viewEnhancementCategory: [#NONE]
@AccessControl.authorizationCheck: #CHECK   // P4: DCL role ZI_ApcNode enforces pfcg_auth
@EndUserText.label: 'APC Browser - Node interface view'
@Metadata.allowExtensions: true

@Hierarchy.parentChild: [{
  recurse: {
    parent: ['ParentUuid'],
    child: ['NodeUuid'],
    grandparentship: #NONE
  }
}]

define view entity ZI_ApcNode
  as select from ztapc_node

  // Self-association: navigation to the parent node (0..1 - root nodes have no parent)
  association [0..1] to ZI_ApcNode as _Parent
    on $projection.ParentUuid = _Parent.NodeUuid

  // Self-association: navigation to direct children (0..*)
  association [0..*] to ZI_ApcNode as _Children
    on $projection.NodeUuid = _Children.ParentUuid

{
  key node_uuid               as NodeUuid,
      parent_uuid             as ParentUuid,
      name                    as Name,
      node_type               as NodeType,

  // ByteSize is server-computed (readonly in BDEF) - do not emit from client
      byte_size               as ByteSize,
      mime_type               as MimeType,

  // largeObject exposes this rawstring field as an OData V4 stream property.
  // Upload/download rides OData streaming; no hand-written UI or action needed
  // for the transport itself.  The attachContent action finalises metadata (ByteSize).
  @Semantics.largeObject: {
    mimeType: 'MimeType',
    fileName: 'Name',
    contentDispositionPreference: #ATTACHMENT
  }
      content                 as Content,

  // RAP admin fields - annotated so the framework auto-fills them
  @Semantics.user.createdBy: true
      created_by              as CreatedBy,
  @Semantics.systemDateTime.createdAt: true
      created_at              as CreatedAt,
  @Semantics.user.lastChangedBy: true
      last_changed_by         as LastChangedBy,
  @Semantics.systemDateTime.localInstanceLastChangedAt: true
      last_changed_at         as LastChangedAt,
  @Semantics.systemDateTime.lastChangedAt: true
      local_last_changed_at   as LocalLastChangedAt,

  // Publish associations so the projection layer can redirect to ZC_*
  _Parent,
  _Children
}
