-- tenant_master.tenant_name is the current-name source of truth.  This migration
-- deliberately does not update contracts, import rows, documents, or snapshots.

create table public.tenant_name_history (
  tenant_name_history_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant_master(tenant_id) on delete restrict,
  old_name varchar(200) not null,
  new_name varchar(200) not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null,
  constraint ck_tenant_name_history_names_not_blank check (
    old_name = btrim(old_name) and old_name <> ''
    and new_name = btrim(new_name) and new_name <> ''
    and old_name <> new_name
  )
);

create index ix_tenant_name_history_tenant_changed_at
  on public.tenant_name_history(tenant_id, changed_at desc);

alter table public.tenant_name_history enable row level security;
grant select on public.tenant_name_history to authenticated;

create policy "active users read tenant name history"
  on public.tenant_name_history for select to authenticated
  using ((select public.current_account_is_active()));

create or replace function public.tenant_name_change_context(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tenant public.tenant_master%rowtype;
begin
  if not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager') then
    raise exception 'テナント名称を変更する権限がありません';
  end if;

  select * into v_tenant from public.tenant_master where tenant_id = p_tenant_id;
  if not found then raise exception 'テナントが見つかりません'; end if;

  return jsonb_build_object(
    'tenant_id', v_tenant.tenant_id,
    'tenant_name', v_tenant.tenant_name,
    'contract_count', (select count(*) from public.lease_contract where tenant_id = p_tenant_id),
    'billing_code_count', (select count(*) from public.tenant_billing_code where tenant_id = p_tenant_id),
    'parking_contract_count', (
      select count(*)
      from public.lease_contract contract
      join public.lease_contract_unit contract_unit using (lease_contract_id)
      join public.unit_master unit using (unit_id)
      where contract.tenant_id = p_tenant_id and unit.unit_type = 'parking'
    )
  );
end;
$$;

-- SECURITY DEFINER is required here to keep history inserts exclusive to this
-- audited transaction.  The function enforces the same active admin/manager
-- authorization used by other master-data mutations and has a fixed search path.
create or replace function public.rename_tenant(p_tenant_id uuid, p_new_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenant_master%rowtype;
  v_new_name varchar(200);
  v_normalized_name varchar(200);
  v_history public.tenant_name_history%rowtype;
begin
  if auth.uid() is null
     or not public.current_account_is_active()
     or public.current_account_role() not in ('admin', 'manager') then
    raise exception 'テナント名称を変更する権限がありません';
  end if;

  v_new_name := btrim(coalesce(p_new_name, ''));
  if v_new_name = '' then raise exception '新しい名称を入力してください'; end if;
  if char_length(v_new_name) > 200 then raise exception 'テナント名称は200文字以内で入力してください'; end if;

  select * into v_tenant from public.tenant_master
  where tenant_id = p_tenant_id for update;
  if not found then raise exception 'テナントが見つかりません'; end if;
  if v_tenant.tenant_name = v_new_name then
    return jsonb_build_object('changed', false, 'tenant_id', v_tenant.tenant_id, 'tenant_name', v_tenant.tenant_name);
  end if;

  -- Reuse the existing tenant matching normalization: lowercase and remove
  -- ASCII/full-width whitespace, while preserving the entered legal name.
  v_normalized_name := lower(regexp_replace(v_new_name, '[[:space:]　]+', '', 'g'));
  if v_normalized_name = '' then raise exception '新しい名称を入力してください'; end if;

  insert into public.tenant_name_history(tenant_id, old_name, new_name, changed_by)
  values (v_tenant.tenant_id, v_tenant.tenant_name, v_new_name, auth.uid())
  returning * into v_history;

  update public.tenant_master
  set tenant_name = v_new_name,
      normalized_tenant_name = v_normalized_name,
      updated_at = now()
  where tenant_id = v_tenant.tenant_id;

  return jsonb_build_object(
    'changed', true,
    'tenant_id', v_tenant.tenant_id,
    'tenant_name', v_new_name,
    'history_id', v_history.tenant_name_history_id,
    'changed_at', v_history.changed_at
  );
end;
$$;

revoke all on function public.tenant_name_change_context(uuid) from public, anon;
revoke all on function public.rename_tenant(uuid, text) from public, anon;
grant execute on function public.tenant_name_change_context(uuid) to authenticated;
grant execute on function public.rename_tenant(uuid, text) to authenticated;

comment on table public.tenant_name_history is '現在名称の変更履歴。契約書、PDF、取込原文、Snapshotの名称は更新しない。';
comment on function public.rename_tenant(uuid, text) is 'テナント名称と正規化名称を履歴保存と同一トランザクションで更新する。tenant_id、請求コード、契約・資料Snapshotは変更しない。';
