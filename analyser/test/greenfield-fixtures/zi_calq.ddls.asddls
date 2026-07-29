@EndUserText.label: 'Calibration repository pane'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_CAL_QUERY'
@AccessControl.authorizationCheck: #NOT_REQUIRED
define custom entity ZI_CalQ
{
  key object_name : abap.char(30);
      object_type : abap.char(4);
}
