@AbapCatalog.viewEnhancementCategory: [#NONE]
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Sales order (seam fixture, interface view)'
@Metadata.ignorePropagatedAnnotations: true
@ObjectModel.usageType:{
  serviceQuality: #X,
  sizeCategory: #S,
  dataClass: #TRANSACTIONAL
}
define root view entity ZI_SmOrder
  as select from zsm_order
{
  key order_id            as OrderId,
      customer            as Customer,
      country             as Country,
      @Semantics.amount.currencyCode: 'Currency'
      net_value           as NetValue,
      @Semantics.currencyCode: true
      currency            as Currency,
      created_on          as CreatedOn,

      @Semantics.user.createdBy: true
      created_by          as CreatedBy,
      @Semantics.systemDateTime.createdAt: true
      created_at          as CreatedAt,
      @Semantics.user.lastChangedBy: true
      last_changed_by     as LastChangedBy,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at     as LastChangedAt
}
