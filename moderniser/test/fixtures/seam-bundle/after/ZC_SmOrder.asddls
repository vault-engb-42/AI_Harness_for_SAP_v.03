@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Sales order (seam fixture, consumption projection)'
@Metadata.allowExtensions: true
@Search.searchable: true
define root view entity ZC_SmOrder
  provider contract transactional_query
  as projection on ZI_SmOrder
{
      @Search.defaultSearchElement: true
  key OrderId,
      @Search.defaultSearchElement: true
      Customer,
      Country,
      @Semantics.amount.currencyCode: 'Currency'
      NetValue,
      @Semantics.currencyCode: true
      Currency,
      CreatedOn,
      CreatedBy,
      CreatedAt,
      LastChangedBy,
      LastChangedAt
}
