-- 契約書に添付する対象区画図。図面版と生成済みスナップショットを固定する。
create table if not exists public.lease_contract_document_plan (
  lease_contract_document_plan_id uuid primary key default gen_random_uuid(),
  lease_contract_document_id uuid not null references public.lease_contract_document (lease_contract_document_id) on delete cascade,
  floor_plan_revision_id uuid not null references public.floor_plan_revision (floor_plan_revision_id) on delete restrict,
  target_unit_ids uuid[] not null,
  snapshot_file_path text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_lease_contract_document_plan_revision unique (lease_contract_document_id, floor_plan_revision_id),
  constraint ck_lease_contract_document_plan_target_units check (cardinality(target_unit_ids) > 0 and array_position(target_unit_ids, null) is null),
  constraint ck_lease_contract_document_plan_snapshot_path check (length(trim(snapshot_file_path)) > 0)
);

create index if not exists ix_lease_contract_document_plan_document
  on public.lease_contract_document_plan (lease_contract_document_id);

comment on table public.lease_contract_document_plan is '契約書に添付する対象区画図の図面版・対象区画・描画済みスナップショット。';

create or replace function public.validate_lease_contract_document_plan()
returns trigger language plpgsql set search_path = public as $$
declare v_lease_contract_id uuid;
begin
  select lease_contract_id into v_lease_contract_id
  from public.lease_contract_document
  where lease_contract_document_id = new.lease_contract_document_id;

  if v_lease_contract_id is null then
    raise exception '契約書が見つかりません';
  end if;

  if exists (
    select 1 from unnest(new.target_unit_ids) as target_unit_id
    where not exists (
      select 1 from public.lease_contract_unit contract_unit
      where contract_unit.lease_contract_id = v_lease_contract_id
        and contract_unit.unit_id = target_unit_id
    )
  ) then
    raise exception '対象区画には当該契約に紐づく区画のみを指定できます';
  end if;

  if exists (
    select 1 from unnest(new.target_unit_ids) as target_unit_id
    where not exists (
      select 1 from public.unit_plan_geometry geometry
      where geometry.floor_plan_revision_id = new.floor_plan_revision_id
        and geometry.unit_id = target_unit_id
    )
  ) then
    raise exception '対象区画の図形が指定した平面図版に登録されていません';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_lease_contract_document_plan on public.lease_contract_document_plan;
create trigger validate_lease_contract_document_plan
before insert or update on public.lease_contract_document_plan
for each row execute procedure public.validate_lease_contract_document_plan();

drop trigger if exists set_lease_contract_document_plan_updated_at on public.lease_contract_document_plan;
create trigger set_lease_contract_document_plan_updated_at
before update on public.lease_contract_document_plan
for each row execute procedure public.set_updated_at();

alter table public.lease_contract_document_plan enable row level security;
grant select, insert, update, delete on public.lease_contract_document_plan to authenticated;

create policy "active users manage lease contract document plans"
  on public.lease_contract_document_plan for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());
