create table if not exists public.contract_workflow_progress (
  lease_contract_id uuid primary key references public.lease_contract(lease_contract_id) on delete cascade,
  rent_roll_status text check (rent_roll_status in ('reflected', 'skipped')),
  rent_roll_completed_at timestamptz,
  rent_roll_completed_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.contract_workflow_stage_skip (
  lease_contract_id uuid not null references public.lease_contract(lease_contract_id) on delete cascade,
  stage_no smallint not null check (stage_no between 2 and 5),
  reason text not null check (length(btrim(reason)) > 0),
  skipped_at timestamptz not null default now(),
  skipped_by uuid not null references auth.users(id),
  primary key (lease_contract_id, stage_no)
);

alter table public.contract_workflow_progress enable row level security;
alter table public.contract_workflow_stage_skip enable row level security;
revoke all on public.contract_workflow_progress, public.contract_workflow_stage_skip from public, anon;
grant select on public.contract_workflow_progress, public.contract_workflow_stage_skip to authenticated;

create policy "Active accounts can read contract workflow progress"
  on public.contract_workflow_progress for select to authenticated
  using (public.current_account_is_active());
create policy "Active accounts can read contract workflow skips"
  on public.contract_workflow_stage_skip for select to authenticated
  using (public.current_account_is_active());

create or replace function public.mark_contract_rent_roll_reflected()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.btob_registered_at is not null and (old.btob_registered_at is null or new.btob_registered_at is distinct from old.btob_registered_at) then
    insert into public.contract_workflow_progress (lease_contract_id, rent_roll_status, rent_roll_completed_at)
    values (new.lease_contract_id, 'reflected', now())
    on conflict (lease_contract_id) do update
      set rent_roll_status = 'reflected', rent_roll_completed_at = now(), rent_roll_completed_by = null, updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists lease_contract_mark_rent_roll_reflected on public.lease_contract;
create trigger lease_contract_mark_rent_roll_reflected
  after update of btob_registered_at on public.lease_contract
  for each row execute function public.mark_contract_rent_roll_reflected();

insert into public.contract_workflow_progress (lease_contract_id, rent_roll_status, rent_roll_completed_at)
select lease_contract_id, 'reflected', btob_registered_at
  from public.lease_contract
 where btob_registered_at is not null
on conflict (lease_contract_id) do nothing;

create or replace function public.skip_contract_workflow_stage(
  p_lease_contract_id uuid,
  p_stage_no smallint,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager', 'staff') then
    raise exception 'Active operator account required';
  end if;
  if p_stage_no not between 2 and 5 or length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A valid stage and skip reason are required';
  end if;
  if not exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id) then
    raise exception 'Lease contract not found';
  end if;
  if (p_stage_no = 2 and exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id and contract_content_reviewed_at is not null))
     or (p_stage_no = 3 and exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id and contract_document_completed_at is not null))
     or (p_stage_no = 4 and exists (select 1 from public.lease_contract where lease_contract_id = p_lease_contract_id and btob_registered_at is not null))
     or (p_stage_no = 5 and exists (select 1 from public.contract_workflow_progress where lease_contract_id = p_lease_contract_id and rent_roll_status = 'reflected')) then
    raise exception 'The stage is already complete';
  end if;
  if p_stage_no > 2 and not exists (
    select 1 from public.lease_contract contract
    where contract.lease_contract_id = p_lease_contract_id
      and (contract.contract_content_reviewed_at is not null or exists (
        select 1 from public.contract_workflow_stage_skip skip
        where skip.lease_contract_id = p_lease_contract_id and skip.stage_no = 2
      ))
  ) then raise exception 'Complete or skip the previous stage first'; end if;
  if p_stage_no > 3 and not exists (
    select 1 from public.lease_contract contract
    where contract.lease_contract_id = p_lease_contract_id
      and (contract.contract_document_completed_at is not null or exists (
        select 1 from public.contract_workflow_stage_skip skip
        where skip.lease_contract_id = p_lease_contract_id and skip.stage_no = 3
      ))
  ) then raise exception 'Complete or skip the previous stage first'; end if;
  if p_stage_no > 4 and not exists (
    select 1 from public.lease_contract contract
    where contract.lease_contract_id = p_lease_contract_id
      and (contract.btob_registered_at is not null or exists (
        select 1 from public.contract_workflow_stage_skip skip
        where skip.lease_contract_id = p_lease_contract_id and skip.stage_no = 4
      ))
  ) then raise exception 'Complete or skip the previous stage first'; end if;

  insert into public.contract_workflow_stage_skip (lease_contract_id, stage_no, reason, skipped_by)
  values (p_lease_contract_id, p_stage_no, btrim(p_reason), v_user_id)
  on conflict (lease_contract_id, stage_no) do update
    set reason = excluded.reason, skipped_at = now(), skipped_by = excluded.skipped_by;

  if p_stage_no = 5 then
    insert into public.contract_workflow_progress (lease_contract_id, rent_roll_status, rent_roll_completed_at, rent_roll_completed_by)
    values (p_lease_contract_id, 'skipped', now(), v_user_id)
    on conflict (lease_contract_id) do update
      set rent_roll_status = 'skipped', rent_roll_completed_at = now(), rent_roll_completed_by = v_user_id, updated_at = now();
  end if;
end;
$$;

revoke all on function public.skip_contract_workflow_stage(uuid, smallint, text) from public, anon;
grant execute on function public.skip_contract_workflow_stage(uuid, smallint, text) to authenticated;
