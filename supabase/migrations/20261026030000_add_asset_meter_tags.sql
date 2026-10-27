create table if not exists public.asset_meter_tag (
  asset_meter_tag_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  tag_name text not null check (length(trim(tag_name)) between 1 and 40),
  color text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now()
);

create unique index if not exists uq_asset_meter_tag_name
  on public.asset_meter_tag(asset_id, lower(trim(tag_name)));

alter table public.asset_meter_tag enable row level security;
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'asset_meter_tag'
      and policyname = 'active users manage meter tags'
  ) then
    create policy "active users manage meter tags"
      on public.asset_meter_tag for all to authenticated
      using (public.current_account_is_active())
      with check (public.current_account_is_active());
  end if;
end;
$$;

grant select, insert, update, delete on public.asset_meter_tag to authenticated;

alter table public.asset_meter
  add column if not exists asset_meter_tag_id uuid references public.asset_meter_tag(asset_meter_tag_id) on delete set null;

create index if not exists ix_asset_meter_tag on public.asset_meter(asset_meter_tag_id);

create or replace function public.validate_asset_meter_tag_asset()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.asset_meter_tag_id is not null and not exists (
    select 1 from public.asset_meter_tag tag
    where tag.asset_meter_tag_id = new.asset_meter_tag_id
      and tag.asset_id = new.asset_id
  ) then
    raise exception 'メーターとタグの物件が一致しません';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_asset_meter_tag_asset_trigger on public.asset_meter;
create trigger validate_asset_meter_tag_asset_trigger
before insert or update of asset_id, asset_meter_tag_id on public.asset_meter
for each row execute function public.validate_asset_meter_tag_asset();

comment on table public.asset_meter_tag is '物件内で共通利用するメーター識別タグ';
comment on column public.asset_meter_tag.color is '検針画面で表示するHEXカラー';
comment on column public.asset_meter.asset_meter_tag_id is 'メーター設定で選択した識別タグ';
