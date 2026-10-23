create or replace function public.save_next_utility_tariff_version(
  p_asset_id uuid,
  p_billing_month date,
  p_tariff_name text,
  p_tax_rate numeric,
  p_tiers jsonb
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_effective_from date := date_trunc('month', p_billing_month)::date;
  v_version_id uuid;
  v_next_from date;
begin
  if auth.uid() is null or not public.current_account_is_active() then raise exception '料金表を編集する権限がありません'; end if;
  if jsonb_array_length(p_tiers) = 0 then raise exception '料金表の段階を入力してください'; end if;

  insert into public.utility_tariff_version (asset_id, tariff_kind, tariff_name, effective_from, tax_rate)
  values (p_asset_id, 'osaka_general_water', p_tariff_name, v_effective_from, p_tax_rate)
  on conflict (asset_id, tariff_kind, effective_from) do update
    set tariff_name = excluded.tariff_name, tax_rate = excluded.tax_rate, updated_at = now()
  returning utility_tariff_version_id into v_version_id;

  delete from public.utility_tariff_tier where utility_tariff_version_id = v_version_id;
  insert into public.utility_tariff_tier (utility_tariff_version_id, component, min_usage, max_usage, rate, deduction, sort_order)
  select v_version_id, row->>'component', (row->>'min_usage')::integer,
    nullif(row->>'max_usage', '')::integer, (row->>'rate')::numeric,
    (row->>'deduction')::numeric, (row->>'sort_order')::integer
  from jsonb_array_elements(p_tiers) row;

  update public.utility_tariff_version set effective_to = v_effective_from - 1, updated_at = now()
  where asset_id = p_asset_id and tariff_kind = 'osaka_general_water'
    and effective_from < v_effective_from
    and (effective_to is null or effective_to >= v_effective_from);
  select min(effective_from) into v_next_from from public.utility_tariff_version
  where asset_id = p_asset_id and tariff_kind = 'osaka_general_water' and effective_from > v_effective_from;
  update public.utility_tariff_version set effective_to = case when v_next_from is null then null else v_next_from - 1 end
  where utility_tariff_version_id = v_version_id;
  return v_version_id;
end;
$$;

comment on function public.save_next_utility_tariff_version(uuid, date, text, numeric, jsonb)
  is '選択中の請求月から適用する料金表バージョンを保存する';
