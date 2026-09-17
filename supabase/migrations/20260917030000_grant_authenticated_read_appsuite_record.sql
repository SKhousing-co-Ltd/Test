-- 対応依頼画面から稟議番号をデスクネッツの該当レコードへのリンクにするため、
-- 有効なアカウントに appsuite_record の閲覧を許可する（書込は service_role のみ）。

create policy "active users read appsuite records"
  on public.appsuite_record for select to authenticated
  using (public.current_account_is_active());

grant select on public.appsuite_record to authenticated;

comment on policy "active users read appsuite records" on public.appsuite_record
  is '対応依頼画面で稟議番号をデスクネッツへのリンクとして表示するために、有効なアカウントへ参照権限を付与する。';
