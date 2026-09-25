-- 中之島駐車場台帳の外部契約者。住戸契約・主契約は作成せず、駐車場契約の契約先候補として管理する。
insert into public.tenant_master (tenant_name, normalized_tenant_name)
values
  ('元岡建築技術㈱', '元岡建築技術㈱'),
  ('土居知己', '土居知己'),
  ('和田武文', '和田武文'),
  ('㈱サトウデザイン', '㈱サトウデザイン'),
  ('内匠真一', '内匠真一'),
  ('MIHARA合同会社', 'mihara合同会社'),
  ('小嶋英昭', '小嶋英昭'),
  ('㈱ヤマモト介護サービス', '㈱ヤマモト介護サービス'),
  ('日本自動車サービス開発㈱', '日本自動車サービス開発㈱')
on conflict (normalized_tenant_name) do update
set tenant_name = excluded.tenant_name,
    updated_at = now();
