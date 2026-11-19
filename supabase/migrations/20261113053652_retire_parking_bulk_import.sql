-- Retain import history while removing direct access to the retired workflow.
revoke execute on function public.prepare_parking_import(uuid, uuid, date, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.commit_parking_import(uuid) from public, anon, authenticated;
revoke execute on function public.commit_parking_import_without_fee(uuid) from public, anon, authenticated;
