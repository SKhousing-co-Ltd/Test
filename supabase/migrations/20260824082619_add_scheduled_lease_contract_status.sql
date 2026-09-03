alter table public.lease_contract drop constraint if exists lease_contract_contract_status_check;
alter table public.lease_contract add constraint lease_contract_contract_status_check check (
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
