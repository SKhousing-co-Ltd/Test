-- Remote migration version: 20260818085601
-- Security/Performance Advisorで検出された駐車場台帳固有の指摘を解消する。

create or replace function public.normalize_parking_tenant_name(input_name text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select lower(
    regexp_replace(
      replace(replace(replace(replace(replace(replace(coalesce(input_name, ''), '株式会社', ''), '(株)', ''), '（株）', ''), '㈱', ''), '有限会社', ''), '　', ''),
      '[[:space:]・･]', '', 'g'
    )
  );
$$;

create index if not exists ix_parking_facility_type on public.parking_facility_master (parking_type_id)
where parking_type_id is not null;
create index if not exists ix_parking_import_batch_facility on public.parking_import_batch (parking_facility_id);
create index if not exists ix_parking_import_batch_created_by on public.parking_import_batch (created_by);
create index if not exists ix_parking_import_row_tenant on public.parking_import_row (matched_tenant_id)
where matched_tenant_id is not null;
create index if not exists ix_parking_import_row_main_contract on public.parking_import_row (main_lease_contract_id)
where main_lease_contract_id is not null;
create index if not exists ix_parking_import_row_committed_unit on public.parking_import_row (committed_unit_id)
where committed_unit_id is not null;
create index if not exists ix_parking_import_row_committed_contract on public.parking_import_row (committed_lease_contract_id)
where committed_lease_contract_id is not null;
create index if not exists ix_parking_import_row_committed_contract_unit on public.parking_import_row (committed_lease_contract_unit_id)
where committed_lease_contract_unit_id is not null;

drop policy if exists "managers manage parking facilities" on public.parking_facility_master;
drop policy if exists "managers manage parking spaces" on public.parking_space_master;
drop policy if exists "managers manage parking contracts" on public.parking_contract_detail;
drop policy if exists "managers manage parking assignments" on public.parking_space_assignment;
drop policy if exists "managers manage parking vehicles" on public.parking_vehicle_history;

create policy "managers insert parking facilities" on public.parking_facility_master for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers update parking facilities" on public.parking_facility_master for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers delete parking facilities" on public.parking_facility_master for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "managers insert parking spaces" on public.parking_space_master for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers update parking spaces" on public.parking_space_master for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers delete parking spaces" on public.parking_space_master for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "managers insert parking contracts" on public.parking_contract_detail for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers update parking contracts" on public.parking_contract_detail for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers delete parking contracts" on public.parking_contract_detail for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "managers insert parking assignments" on public.parking_space_assignment for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers update parking assignments" on public.parking_space_assignment for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers delete parking assignments" on public.parking_space_assignment for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));

create policy "managers insert parking vehicles" on public.parking_vehicle_history for insert to authenticated
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers update parking vehicles" on public.parking_vehicle_history for update to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'))
with check ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
create policy "managers delete parking vehicles" on public.parking_vehicle_history for delete to authenticated
using ((select public.current_account_is_active()) and (select public.current_account_role()) in ('admin', 'manager'));
