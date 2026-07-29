// Custom entity: APC Repository Object pane.
// Implemented by ZCL_ApcRepoQuery (IF_RAP_QUERY_PROVIDER).
//
// SCOPE NOTICE (honest limit - DESIGN.md sec 2):
// XCO_CP_ABAP_REPOSITORY exposes RELEASED + CUSTOMER-NAMESPACE objects only.
// Internal SAP delivery objects (SAP prefix, ABAP basis, standard packages)
// are NOT browseable via Clean-Core XCO - this is by design and is correct
// for ABAP Cloud Level-A applications.  This is NOT an SE80 whole-SAP-repo
// browser.  The entity is a released/customer object browser.
//
// @ObjectModel.query.implementedBy references ZCL_APCREPOQUERY (released
// IF_RAP_QUERY_PROVIDER pattern - confirmed released via grounding).

@EndUserText.label: 'APC - Repository Object (customer/released scope)'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_APCREPOQUERY'
// Auth is enforced in the IF_RAP_QUERY_PROVIDER implementation (ZCL_APCREPOQUERY),
// not via CDS DCL - correct pattern for custom entities. #NOT_REQUIRED here is deliberate.
@AccessControl.authorizationCheck: #NOT_REQUIRED

define custom entity ZI_ApcRepoObject
{
  key ObjectName        : abap.char(120);
  key ObjectType        : abap.char(4);
      PackageName       : abap.char(30);
      SoftwareComponent : abap.char(30);
      Description       : abap.char(100);
}
