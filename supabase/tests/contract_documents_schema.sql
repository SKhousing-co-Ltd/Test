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
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'lease_contract_document_plan') then
    raise exception '契約書対象区画図テーブルが作成されていません';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'uq_lease_contract_document_plan_revision') then
    raise exception '契約書・平面図版の一意制約が作成されていません';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'validate_lease_contract_document_plan' and not tgisinternal) then
    raise exception '対象区画図の整合性検証トリガーが作成されていません';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lease_contract_document_plan' and policyname = 'active users manage lease contract document plans') then
    raise exception '契約書対象区画図RLSポリシーが作成されていません';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'lease_contract_document' and column_name = 'terms_text') then
    raise exception '契約書の約款本文列が作成されていません';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'lease_contract_document' and column_name = 'restoration_criteria_text') then
    raise exception '契約書の原状回復工事基準本文列が作成されていません';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contract_document_template_revision' and column_name = 'block_definitions') then
    raise exception 'ひな型版のブロック定義列が作成されていません';
  end if;
end;
$$;

rollback;
