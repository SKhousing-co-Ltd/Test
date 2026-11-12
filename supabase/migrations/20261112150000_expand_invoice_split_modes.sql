-- 請求書の分割数を先に指定し、明細項目と区画を併用して振り分けられるようにする。
alter table public.billing_invoice_split_setting
  add column if not exists split_count smallint;

update public.billing_invoice_split_setting setting
set split_count = greatest(
  2,
  coalesce((select max(a.invoice_number) from public.billing_invoice_split_assignment a where a.billing_invoice_split_setting_id = setting.billing_invoice_split_setting_id), 1),
  coalesce((select max(a.invoice_number) from public.billing_invoice_split_unit_assignment a where a.billing_invoice_split_setting_id = setting.billing_invoice_split_setting_id), 1)
)
where split_count is null;

alter table public.billing_invoice_split_setting
  alter column split_count set default 2,
  alter column split_count set not null;

alter table public.billing_invoice_split_setting
  drop constraint if exists billing_invoice_split_setting_split_mode_check,
  drop constraint if exists billing_invoice_split_setting_split_count_check;

alter table public.billing_invoice_split_setting
  add constraint billing_invoice_split_setting_split_mode_check
    check (split_mode in ('unit', 'line_item', 'line_item_unit')),
  add constraint billing_invoice_split_setting_split_count_check
    check (split_count between 2 and 9);

alter table public.billing_invoice_split_assignment
  drop constraint if exists ck_billing_invoice_split_assignment_target;

alter table public.billing_invoice_split_assignment
  add constraint ck_billing_invoice_split_assignment_target check (
    (
      ((lease_contract_unit_id is not null)::integer + (lease_contract_billing_unit_id is not null)::integer = 1)
      and invoice_number is null
    )
    or (
      lease_contract_unit_id is null
      and lease_contract_billing_unit_id is null
      and invoice_number between 1 and 9
    )
  );

alter table public.billing_invoice_split_unit_assignment
  drop constraint if exists billing_invoice_split_unit_assignment_invoice_number_check;

alter table public.billing_invoice_split_unit_assignment
  add constraint billing_invoice_split_unit_assignment_invoice_number_check
    check (invoice_number between 2 and 9);

comment on column public.billing_invoice_split_setting.split_count
  is '請求書分割設定で作成する請求書の枚数（2～9）';
