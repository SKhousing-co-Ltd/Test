-- appsuite_record の式インデックスは service_role による同期時にも評価される。
-- 公開ロールへの権限を広げず、同期に必要な関数だけ許可する。
grant execute on function public.normalize_contract_property_match_key(text)
  to service_role;

grant execute on function public.appsuite_contract_property(jsonb)
  to service_role;
