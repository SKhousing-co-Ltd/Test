-- 駐車場Excel取込は、料金未設定の契約を対応依頼として起票する。
-- 20260901040936 で change_request を Data API 経由で読み取り専用にした後も、
-- このRPCが SECURITY INVOKER のままだったため、取込の途中で起票できなかった。
-- 呼出元の管理者・マネージャー検証は既存関数の先頭で維持し、テーブルの直接権限は戻さない。
alter function public.commit_parking_import(uuid)
  security definer
  set search_path = public, extensions;

revoke all on function public.commit_parking_import(uuid) from public, anon;
grant execute on function public.commit_parking_import(uuid) to authenticated;
