@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Travel'
define view entity ZI_Travel
  as select from /dmo/travel as Travel
  association [0..1] to ZI_Agency as _Agency on $projection.agency_id = _Agency.AgencyId
{
  key travel_id  as TravelId,
      agency_id  as AgencyId,
      _Agency
}
