-- AppSuiteの決裁済み発注に現れた取引先候補を、管理者承認後に一括登録する。

create or replace view public.appsuite_vendor_candidate
with (security_invoker = true)
as
with candidate as (
  select
    md5(regexp_replace(lower(inbox.vendor_name), '[[:space:]　株式会社（）()]', '', 'g')) as candidate_key,
    min(inbox.vendor_name) as vendor_name,
    count(*)::integer as source_row_count,
    coalesce(sum(inbox.gross_amount), 0)::numeric(16, 0) as gross_amount_total,
    min(inbox.created_at) as first_seen_at,
    max(inbox.updated_at) as last_seen_at
  from public.appsuite_procurement_inbox as inbox
  where inbox.match_status = 'action_required'
    and inbox.matched_vendor_id is null
    and nullif(btrim(inbox.vendor_name), '') is not null
  group by md5(regexp_replace(lower(inbox.vendor_name), '[[:space:]　株式会社（）()]', '', 'g'))
)
select
  candidate.candidate_key,
  candidate.vendor_name,
  candidate.source_row_count,
  candidate.gross_amount_total,
  candidate.first_seen_at,
  candidate.last_seen_at,
  coalesce(existing.match_count, 0)::integer as existing_match_count,
  existing.vendor_id as existing_vendor_id,
  existing.vendor_name as existing_vendor_name
from candidate
left join lateral (
  select
    count(*)::integer as match_count,
    min(vendor.vendor_id::text)::uuid as vendor_id,
    min(vendor.vendor_name) as vendor_name
  from public.vendor_master as vendor
  where vendor.is_active
    and md5(regexp_replace(lower(vendor.vendor_name), '[[:space:]　株式会社（）()]', '', 'g')) = candidate.candidate_key
) as existing on true;

create or replace function public.register_appsuite_vendor_candidates(p_candidate_keys text[])
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  candidate record;
  inbox_id uuid;
  billone_id uuid;
  selected_keys text[];
  created_count integer := 0;
  reused_count integer := 0;
  skipped_count integer := 0;
  reconciled_count integer := 0;
  ready_count integer := 0;
  vendor_matches integer;
  matched_vendor_id uuid;
begin
  if not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager') then
    raise exception '取引先登録権限がありません';
  end if;

  select array_agg(distinct key)
    into selected_keys
  from unnest(coalesce(p_candidate_keys, '{}'::text[])) as key
  where key ~ '^[0-9a-f]{32}$';

  if coalesce(cardinality(selected_keys), 0) = 0 then
    raise exception '登録する取引先候補を選択してください';
  end if;
  if cardinality(selected_keys) > 200 then
    raise exception '一度に登録できる取引先候補は200件までです';
  end if;

  for candidate in
    select
      md5(regexp_replace(lower(inbox.vendor_name), '[[:space:]　株式会社（）()]', '', 'g')) as candidate_key,
      min(inbox.vendor_name) as vendor_name
    from public.appsuite_procurement_inbox as inbox
    where inbox.match_status = 'action_required'
      and inbox.matched_vendor_id is null
      and nullif(btrim(inbox.vendor_name), '') is not null
      and md5(regexp_replace(lower(inbox.vendor_name), '[[:space:]　株式会社（）()]', '', 'g')) = any(selected_keys)
    group by md5(regexp_replace(lower(inbox.vendor_name), '[[:space:]　株式会社（）()]', '', 'g'))
    order by min(inbox.vendor_name)
  loop
    select count(*), min(vendor.vendor_id::text)::uuid into vendor_matches, matched_vendor_id
    from public.vendor_master as vendor
    where md5(regexp_replace(lower(vendor.vendor_name), '[[:space:]　株式会社（）()]', '', 'g')) = candidate.candidate_key;

    if vendor_matches = 0 then
      insert into public.vendor_master (vendor_code, vendor_name)
      values ('AS-' || upper(substr(candidate.candidate_key, 1, 16)), candidate.vendor_name);
      created_count := created_count + 1;
    elsif vendor_matches = 1 then
      update public.vendor_master
         set is_active = true,
             updated_by = auth.uid(),
             updated_at = now()
       where vendor_id = matched_vendor_id;
      reused_count := reused_count + 1;
    else
      skipped_count := skipped_count + 1;
      continue;
    end if;

    for inbox_id in
      select inbox.appsuite_procurement_inbox_id
      from public.appsuite_procurement_inbox as inbox
      where inbox.match_status = 'action_required'
        and inbox.vendor_name is not null
        and md5(regexp_replace(lower(inbox.vendor_name), '[[:space:]　株式会社（）()]', '', 'g')) = candidate.candidate_key
    loop
      perform public.reconcile_appsuite_procurement_inbox(inbox_id);
      reconciled_count := reconciled_count + 1;
    end loop;

    for billone_id in
      select inbox.billone_invoice_inbox_id
      from public.billone_invoice_inbox as inbox
      where inbox.match_status = 'action_required'
        and inbox.supplier_name is not null
        and md5(regexp_replace(lower(inbox.supplier_name), '[[:space:]　株式会社（）()]', '', 'g')) = candidate.candidate_key
    loop
      perform public.reconcile_billone_invoice_inbox(billone_id);
      reconciled_count := reconciled_count + 1;
    end loop;
  end loop;

  select count(*)::integer into ready_count
  from public.appsuite_procurement_inbox as inbox
  where inbox.match_status = 'ready'
    and inbox.vendor_name is not null
    and md5(regexp_replace(lower(inbox.vendor_name), '[[:space:]　株式会社（）()]', '', 'g')) = any(selected_keys);

  return jsonb_build_object(
    'created_count', created_count,
    'reused_count', reused_count,
    'skipped_count', skipped_count,
    'reconciled_count', reconciled_count,
    'ready_count', ready_count
  );
end;
$$;

revoke all on public.appsuite_vendor_candidate from public;
grant select on public.appsuite_vendor_candidate to authenticated;

revoke all on function public.register_appsuite_vendor_candidates(text[]) from public;
grant execute on function public.register_appsuite_vendor_candidates(text[]) to authenticated;

comment on view public.appsuite_vendor_candidate is 'AppSuite発注受信箱の未登録取引先を正規化名ごとに集約した、承認用の候補一覧。';
comment on function public.register_appsuite_vendor_candidates(text[]) is '管理者・マネージャーが選択したAppSuite取引先候補を登録し、該当する受信箱だけを再照合する。';
