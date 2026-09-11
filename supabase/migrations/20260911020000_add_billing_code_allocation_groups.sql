-- 複数のテナントコードを同一請求先グループとして扱い、割当方式を物件単位で管理する。
create table if not exists public.billing_code_allocation_group (
  billing_code_allocation_group_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  tenant_id uuid references public.tenant_master(tenant_id) on delete set null,
  allocation_mode varchar(20) not null check (allocation_mode in ('contract', 'line_item')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_code_allocation_group_member (
  billing_code_allocation_group_id uuid not null references public.billing_code_allocation_group(billing_code_allocation_group_id) on delete cascade,
  billing_code_id uuid not null references public.billing_code(billing_code_id) on delete cascade,
  primary key (billing_code_allocation_group_id, billing_code_id)
);

create table if not exists public.billing_code_line_item_allocation (
  billing_code_allocation_group_id uuid not null references public.billing_code_allocation_group(billing_code_allocation_group_id) on delete cascade,
  asset_billing_line_item_id uuid not null references public.asset_billing_line_item(asset_billing_line_item_id) on delete cascade,
  billing_code_id uuid not null references public.billing_code(billing_code_id) on delete restrict,
  effective_from date not null,
  effective_to date,
  primary key (billing_code_allocation_group_id, asset_billing_line_item_id, effective_from),
  constraint ck_billing_code_line_item_allocation_dates check (effective_to is null or effective_to >= effective_from)
);

alter table public.billing_code_allocation_group enable row level security;
alter table public.billing_code_allocation_group_member enable row level security;
alter table public.billing_code_line_item_allocation enable row level security;
grant select, insert, update, delete on public.billing_code_allocation_group, public.billing_code_allocation_group_member, public.billing_code_line_item_allocation to authenticated;
create policy "active users manage billing code allocation groups" on public.billing_code_allocation_group for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage billing code allocation group members" on public.billing_code_allocation_group_member for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage billing code line item allocations" on public.billing_code_line_item_allocation for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
