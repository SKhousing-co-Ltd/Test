begin;

-- このテストは契約書マイグレーション適用後の Supabase SQL Editor / db test で実行する。
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'lease_contract_document') then
    raise exception 'lease_contract_document が作成されていません';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lease_contract_document_lease_contract_id_key') then
    raise exception '契約ごとの契約書一意制約が作成されていません';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lease_contract_document' and policyname = 'active users manage lease contract documents') then
    raise exception '契約書RLSポリシーが作成されていません';
  end if;
end;
$$;

rollback;
