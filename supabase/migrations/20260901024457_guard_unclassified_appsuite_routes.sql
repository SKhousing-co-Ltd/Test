-- NULL must never act as an implicit routing decision.  New AppSuite
-- definitions default to an explicit synchronized-only disposition until an
-- administrator assigns a concrete business workflow.
update public.appsuite_application
set business_domain = 'other', processing_type = 'sync_only'
where business_domain is null or processing_type is null;

alter table public.appsuite_application
  alter column business_domain set default 'other',
  alter column processing_type set default 'sync_only',
  alter column business_domain set not null,
  alter column processing_type set not null,
  drop constraint if exists ck_appsuite_application_business_route;

alter table public.appsuite_application
  add constraint ck_appsuite_application_business_route check (
    (business_domain = 'lease_contract' and processing_type in ('contract_create', 'contract_update', 'contract_terminate'))
    or (business_domain = 'procurement' and processing_type in ('repair_order', 'purchase_order'))
    or (business_domain = 'workflow_control' and processing_type = 'approval_cancel')
    or (business_domain = 'payment' and processing_type = 'payment_request')
    or (business_domain in ('master', 'other') and processing_type = 'sync_only')
  );
