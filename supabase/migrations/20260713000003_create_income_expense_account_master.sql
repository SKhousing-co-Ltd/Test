-- 収支科目マスタ
-- 元データ: データテーブル.xlsx / 「収支科目マスタ」シート

create table if not exists public.income_expense_account_master (
  account_id varchar(10) primary key,
  account_name varchar(100) not null,
  income_expense_type varchar(10) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_income_expense_account_master_name unique (account_name),
  constraint ck_income_expense_account_master_type
    check (income_expense_type in ('収入', '支出'))
);

alter table public.income_expense_account_master enable row level security;

insert into public.income_expense_account_master (account_id, account_name, income_expense_type) values
  ('M01', '賃料収入', '収入'), ('M02', '共益費収入', '収入'), ('M03', 'その他収入', '収入'),
  ('M04', 'BM費（管理費）', '支出'), ('M05', '電気代', '支出'), ('M06', '水道代', '支出'),
  ('M07', '固定資産税', '支出'), ('M08', 'その他支出', '支出')
on conflict (account_id) do update set
  account_name = excluded.account_name,
  income_expense_type = excluded.income_expense_type,
  updated_at = now();

grant select on public.income_expense_account_master to authenticated;
create policy "authenticated users can read income expense accounts"
  on public.income_expense_account_master for select to authenticated using (true);
