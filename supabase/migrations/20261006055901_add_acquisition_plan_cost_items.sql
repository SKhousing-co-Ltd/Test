create table if not exists public.property_acquisition_plan_cost_item (
  property_acquisition_plan_cost_item_id uuid primary key default gen_random_uuid(),
  property_acquisition_plan_id uuid not null references public.property_acquisition_plan(property_acquisition_plan_id) on delete cascade,
  cost_type varchar(30) not null check (cost_type in ('purchase_price','acquisition_cost','initial_capex','inherited_deposit')),
  item_name text not null,
  amount numeric(16,0) not null default 0 check (amount >= 0),
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_property_acquisition_plan_cost_item_plan_type on public.property_acquisition_plan_cost_item(property_acquisition_plan_id, cost_type, display_order);
alter table public.property_acquisition_plan_cost_item enable row level security;
grant select, insert, update, delete on public.property_acquisition_plan_cost_item to authenticated;
create policy "authenticated users can read acquisition plan cost items" on public.property_acquisition_plan_cost_item for select to authenticated using (true);
create policy "authenticated users can insert acquisition plan cost items" on public.property_acquisition_plan_cost_item for insert to authenticated with check (true);
create policy "authenticated users can update acquisition plan cost items" on public.property_acquisition_plan_cost_item for update to authenticated using (true) with check (true);
create policy "authenticated users can delete acquisition plan cost items" on public.property_acquisition_plan_cost_item for delete to authenticated using (true);
