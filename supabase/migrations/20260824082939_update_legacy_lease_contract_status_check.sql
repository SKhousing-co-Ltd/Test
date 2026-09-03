alter table public.lease_contract drop constraint if exists ck_lease_contract_status;
alter table public.lease_contract add constraint ck_lease_contract_status check (
  contract_status::text = any (
    array[
      'draft'::character varying,
      'scheduled'::character varying,
      'active'::character varying,
      'terminated'::character varying,
      'expired'::character varying
    ]::text[]
  )
);
