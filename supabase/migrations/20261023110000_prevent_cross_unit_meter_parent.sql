create or replace function public.validate_asset_meter_parent_unit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_child_unit_id uuid;
  v_parent_unit_id uuid;
begin
  if new.parent_asset_meter_id is null then
    return new;
  end if;

  select assignment.unit_id
    into v_child_unit_id
    from public.asset_meter_unit_assignment assignment
   where assignment.asset_meter_id = new.asset_meter_id
     and assignment.effective_from <= current_date
     and (assignment.effective_to is null or assignment.effective_to >= current_date)
   order by assignment.effective_from desc
   limit 1;

  select assignment.unit_id
    into v_parent_unit_id
    from public.asset_meter_unit_assignment assignment
   where assignment.asset_meter_id = new.parent_asset_meter_id
     and assignment.effective_from <= current_date
     and (assignment.effective_to is null or assignment.effective_to >= current_date)
   order by assignment.effective_from desc
   limit 1;

  if v_child_unit_id is null or v_parent_unit_id is null or v_child_unit_id <> v_parent_unit_id then
    raise exception '親メーターは同じ設置区画のメーターから選択してください';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_asset_meter_parent_unit_trigger on public.asset_meter;
create trigger validate_asset_meter_parent_unit_trigger
before insert or update of parent_asset_meter_id on public.asset_meter
for each row execute function public.validate_asset_meter_parent_unit();

with current_assignments as (
  select distinct on (assignment.asset_meter_id)
    assignment.asset_meter_id,
    assignment.unit_id
  from public.asset_meter_unit_assignment assignment
  where assignment.effective_from <= current_date
    and (assignment.effective_to is null or assignment.effective_to >= current_date)
  order by assignment.asset_meter_id, assignment.effective_from desc
), invalid_children as (
  select child.asset_meter_id
  from public.asset_meter child
  left join current_assignments child_assignment
    on child_assignment.asset_meter_id = child.asset_meter_id
  left join current_assignments parent_assignment
    on parent_assignment.asset_meter_id = child.parent_asset_meter_id
  where child.parent_asset_meter_id is not null
    and (
      child_assignment.unit_id is null
      or parent_assignment.unit_id is null
      or child_assignment.unit_id <> parent_assignment.unit_id
    )
)
update public.asset_meter meter
set parent_asset_meter_id = null,
    updated_at = now()
from invalid_children invalid
where meter.asset_meter_id = invalid.asset_meter_id;

comment on function public.validate_asset_meter_parent_unit() is
  '親子メーターが現在同じ設置区画に属することを保証する';
