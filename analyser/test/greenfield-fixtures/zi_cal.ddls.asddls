@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Calibration node'
@Metadata.allowExtensions: true
define view entity ZI_Cal
  as select from ztcal_node
  association [0..1] to ZI_Cal as _Parent
    on $projection.ParentUuid = _Parent.NodeUuid
{
  key node_uuid       as NodeUuid,
      parent_uuid     as ParentUuid,
      name            as Name,
      @Semantics.user.createdBy: true
      created_by      as CreatedBy,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at as LastChangedAt,
      _Parent
}
