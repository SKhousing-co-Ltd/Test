alter table public.appsuite_application
  drop constraint if exists ck_appsuite_application_business_route;

alter table public.appsuite_application
  add constraint ck_appsuite_application_business_route check (
    (not is_sync_enabled and business_domain is null and processing_type is null)
    or (
      business_domain is not null
      and processing_type is not null
      and (
        (business_domain = 'lease_contract' and processing_type in ('contract_create', 'contract_update', 'contract_terminate'))
        or (business_domain = 'procurement' and processing_type in ('repair_order', 'purchase_order'))
        or (business_domain = 'workflow_control' and processing_type = 'approval_cancel')
        or (business_domain = 'payment' and processing_type = 'payment_request')
        or (business_domain in ('master', 'other') and processing_type = 'sync_only')
      )
    )
  );
