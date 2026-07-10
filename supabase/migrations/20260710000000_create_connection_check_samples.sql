create table if not exists public.connection_check_samples (
  key text primary key,
  label text not null,
  expected_value text not null,
  sort_order smallint not null unique check (sort_order > 0),
  created_at timestamptz not null default now()
);

alter table public.connection_check_samples enable row level security;

grant select on table public.connection_check_samples to anon, authenticated;

create policy "Allow read access to connection check samples"
  on public.connection_check_samples
  for select
  to anon, authenticated
  using (true);

insert into public.connection_check_samples (key, label, expected_value, sort_order)
values
  ('database_connection', 'データベース接続', '接続確認用ダミーデータ', 1),
  ('rls_read_access', 'RLS 読み取り権限', 'anon と authenticated で参照可能', 2),
  ('sample_version', 'サンプルデータ版', 'v1', 3)
on conflict (key) do update
set
  label = excluded.label,
  expected_value = excluded.expected_value,
  sort_order = excluded.sort_order;
