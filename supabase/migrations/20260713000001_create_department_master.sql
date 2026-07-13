-- 部門マスタ
-- 元データ: データテーブル.xlsx / 「部門マスタ」シート

create table if not exists public.department_master (
  department_id uuid primary key default gen_random_uuid(),
  department_name varchar(100) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_department_master_department_name unique (department_name)
);

alter table public.department_master enable row level security;

comment on table public.department_master is '部門の基本情報';

insert into public.department_master (department_name)
values
  ('総務経理部'),
  ('管理部'),
  ('営業部'),
  ('ホテル事業部'),
  ('不動産部')
on conflict (department_name) do update set
  updated_at = now();
