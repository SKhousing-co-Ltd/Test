-- リーシング図面で追加した未契約区画を削除する。
-- 契約・区画再編の履歴を持つ区画は正本・監査情報を保全するため削除しない。

create or replace function public.delete_map_unit(p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_account_is_active() then
    raise exception '有効なアカウントが必要です';
  end if;

  perform 1 from public.unit_master where unit_id = p_unit_id for update;
  if not found then raise exception '対象区画が見つかりません'; end if;

  if exists (select 1 from public.lease_contract_unit where unit_id = p_unit_id) then
    raise exception '契約に紐付いている区画は削除できません';
  end if;

  if exists (select 1 from public.unit_lineage where source_unit_id = p_unit_id or target_unit_id = p_unit_id) then
    raise exception '区画の分割・統合履歴があるため削除できません';
  end if;

  delete from public.unit_plan_geometry where unit_id = p_unit_id;
  delete from public.unit_leasing_status where unit_id = p_unit_id;
  delete from public.unit_master where unit_id = p_unit_id;
end;
$$;

revoke all on function public.delete_map_unit(uuid) from public;
grant execute on function public.delete_map_unit(uuid) to authenticated;

comment on function public.delete_map_unit(uuid) is
  '契約・区画再編履歴のないリーシング図面用区画を、図形とリーシング状態とともに削除する。';
