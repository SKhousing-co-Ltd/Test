begin;

do $$
declare
  tenant_a uuid;
  tenant_b uuid;
  primary_code uuid;
  sub_code uuid;
  other_code uuid;
begin
  insert into public.tenant_master(external_tenant_code, tenant_name, normalized_tenant_name)
  values ('BILL-TEST-A', '請求コードテストA', '請求コードテストa')
  returning tenant_id into tenant_a;
  insert into public.tenant_master(external_tenant_code, tenant_name, normalized_tenant_name)
  values ('BILL-TEST-B', '請求コードテストB', '請求コードテストb')
  returning tenant_id into tenant_b;

  insert into public.tenant_billing_code(tenant_id, billing_code, is_primary, sort_order)
  values (tenant_a, 'BILL-TEST-A', true, 0)
  returning tenant_billing_code_id into primary_code;
  insert into public.tenant_billing_code(tenant_id, billing_code, sort_order)
  values (tenant_a, 'BILL-TEST-A-SUB', 1)
  returning tenant_billing_code_id into sub_code;
  insert into public.tenant_billing_code(tenant_id, billing_code, is_primary, sort_order)
  values (tenant_b, 'BILL-TEST-B', true, 0)
  returning tenant_billing_code_id into other_code;

  insert into public.tenant_billing_code_account(tenant_id, account_id, tenant_billing_code_id)
  values (tenant_a, 'M01', primary_code), (tenant_a, 'M02', sub_code), (tenant_a, 'M03', primary_code);

  if (select count(*) from public.tenant_billing_code where tenant_id = tenant_a) <> 2 then
    raise exception 'A tenant must retain multiple billing codes';
  end if;
  if (select tenant_billing_code_id from public.tenant_billing_code_account where tenant_id = tenant_a and account_id = 'M02') <> sub_code then
    raise exception 'An income account must resolve to its assigned sub-code';
  end if;

  begin
    insert into public.tenant_billing_code(tenant_id, billing_code)
    values (tenant_b, 'BILL-TEST-A-SUB');
    raise exception 'A billing code reused by another tenant must fail';
  exception when unique_violation then null;
  end;

  begin
    insert into public.tenant_billing_code(tenant_id, billing_code, is_primary)
    values (tenant_a, 'BILL-TEST-A-PRIMARY-2', true);
    raise exception 'A second primary code must fail';
  exception when unique_violation then null;
  end;

  begin
    insert into public.tenant_billing_code_account(tenant_id, account_id, tenant_billing_code_id)
    values (tenant_a, 'M01', other_code)
    on conflict (tenant_id, account_id) do update set tenant_billing_code_id = excluded.tenant_billing_code_id;
    raise exception 'An assignment to another tenant code must fail';
  exception when foreign_key_violation then null;
  end;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tenant_billing_code'
      and policyname = 'managers maintain tenant billing codes'
  ) then
    raise exception 'Manager write RLS policy is missing';
  end if;
  if has_function_privilege('anon', 'public.replace_tenant_billing_code_config(uuid,jsonb)', 'EXECUTE') then
    raise exception 'Anonymous users must not execute the billing configuration RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.replace_tenant_billing_code_config(uuid,jsonb)', 'EXECUTE') then
    raise exception 'Authenticated users need RPC access before the function performs its role check';
  end if;
end;
$$;

rollback;
