alter table public.billing_invoice_split_assignment
  add column if not exists lease_contract_billing_unit_id uuid
  references public.lease_contract_billing_unit(lease_contract_billing_unit_id) on delete restrict;

alter table public.billing_invoice_split_assignment
  drop constraint if exists ck_billing_invoice_split_assignment_target;

alter table public.billing_invoice_split_assignment
  add constraint ck_billing_invoice_split_assignment_target check (
    (
      invoice_number is null
      and ((lease_contract_unit_id is not null)::integer + (lease_contract_billing_unit_id is not null)::integer = 1)
    )
    or (
      lease_contract_unit_id is null
      and lease_contract_billing_unit_id is null
      and invoice_number between 1 and 3
    )
  );

comment on column public.billing_invoice_split_assignment.lease_contract_billing_unit_id
  is '請求書を契約の請求区画単位で分割する場合の割当先';
