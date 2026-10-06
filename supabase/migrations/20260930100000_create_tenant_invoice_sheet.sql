-- 請求書作成画面の内容（手で直した件名・金額・税区分なども含む）を、物件・請求月ごとに保存します。
-- 入金明細・請求明細は、保存した請求書作成の内容から表示します。
create table if not exists public.tenant_invoice_sheet (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  billing_month date not null,
  -- 請求書の行（CSVの列の値・請求種別・テナント）と、入金期限・請求期間・請求書備考の画面状態です。
  sheet jsonb not null,
  saved_at timestamptz not null default now(),
  saved_by uuid default auth.uid(),
  primary key (asset_id, billing_month),
  constraint ck_tenant_invoice_sheet_month check (billing_month = date_trunc('month', billing_month)::date)
);
comment on table public.tenant_invoice_sheet is '請求書作成画面の保存内容。入金明細・請求明細の元データ';

alter table public.tenant_invoice_sheet enable row level security;
grant select, insert, update, delete on public.tenant_invoice_sheet to authenticated;
drop policy if exists "active users manage tenant invoice sheets" on public.tenant_invoice_sheet;
create policy "active users manage tenant invoice sheets" on public.tenant_invoice_sheet for all to authenticated
  using (public.current_account_is_active()) with check (public.current_account_is_active());
