-- 物件マスタ
-- 元データ: データテーブル.xlsx / 「物件マスタ」シート
-- 築年月・取得年月は月初日を DATE 型で保持する。

create extension if not exists pgcrypto;

create table if not exists public.property_master (
  property_id uuid primary key default gen_random_uuid(),
  property_name varchar(100) not null,
  short_name varchar(50),
  address text,
  construction_date date,
  acquisition_date date,
  land_area_sqm numeric(12, 2),
  building_area_sqm numeric(12, 2),
  rentable_area_sqm numeric(12, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_property_master_property_name unique (property_name),
  constraint ck_property_master_areas_nonnegative check (
    (land_area_sqm is null or land_area_sqm >= 0)
    and (building_area_sqm is null or building_area_sqm >= 0)
    and (rentable_area_sqm is null or rentable_area_sqm >= 0)
  )
);

alter table public.property_master enable row level security;

comment on table public.property_master is '物件の基本情報';
comment on column public.property_master.construction_date is '築年月（月初日で保持）';
comment on column public.property_master.acquisition_date is '取得年月（月初日で保持）';
comment on column public.property_master.land_area_sqm is '土地面積（㎡）';
comment on column public.property_master.building_area_sqm is '建物面積（㎡）';
comment on column public.property_master.rentable_area_sqm is '貸床面積（㎡）';

insert into public.property_master (
  property_name, short_name, address, construction_date, acquisition_date,
  land_area_sqm, building_area_sqm, rentable_area_sqm
) values
  ('三共小山ビル', '小山', '栃木県小山市駅東通り２丁目３７−３', date '1991-07-01', date '2016-03-01', 509, 2018, 1557),
  ('三共ビル郡山北館', '郡山北', '福島県郡山市駅前２丁目１０−１５', date '1981-12-01', date '2014-06-01', 256, 1596, 957),
  ('三共ビル郡山南館', '郡山南', '福島県郡山市駅前２丁目１０−１６', date '1984-03-01', date '2014-01-01', 258, 1681, 1129),
  ('三共仙台ビル', '仙台', '宮城県仙台市青葉区本町１丁目１２−７', date '1992-05-01', date '2013-04-01', 531, 2923, 2037),
  ('三共仙台東ビル', '仙台東', '宮城県仙台市宮城野区榴岡５丁目１−３５', date '1991-06-01', date '2015-04-01', 638, 2960, 1725),
  ('三共福島ビル', '福島', '福島県福島市大町７−１１', date '1995-03-01', date '2013-12-01', 751, 4577, 1124),
  ('三共横浜ビル', '横浜', '神奈川県横浜市中区長者町５丁目８５', date '1996-03-01', date '2016-03-01', 662, 4429, 3575),
  ('三共小石川THビル', '小石川', '東京都文京区小石川５丁目３６−５', date '2014-01-01', date '2014-01-01', 175, 789, 571),
  ('三共西新宿ビル', '西新宿', '東京都新宿区西新宿４丁目２−１８', date '1993-03-01', date '2015-04-01', 83, 497, 430),
  ('三共赤坂ビル', '赤坂', '東京都港区赤坂７丁目１１−７', null, null, null, null, null),
  ('大阪リバーサイドホテル会館棟', '大阪RH', '大阪府大阪市都島区中野町５丁目１２−３０', null, null, null, null, null),
  ('三共梅田ビル', '梅田', '大阪府大阪市北区堂山町１−５', date '1965-09-01', date '2012-05-01', 613, 6203, 4095),
  ('三共肥後橋ビル', '肥後橋', '大阪府大阪市西区江戸堀１丁目１９−１０', date '1990-03-01', date '2004-01-01', 217, 892, 604),
  ('三共日本橋ビル', '日本橋', '大阪府大阪市中央区日本橋１丁目３−１', date '1991-02-01', date '2002-02-01', 46, 396, 344),
  ('三共神戸ツインビル', '神戸', '兵庫県神戸市中央区中町通２丁目３−２', date '1983-03-01', date '2011-06-01', 865, 6586, 1431),
  ('リバーサイドタワー中之島', '中之島', '大阪府大阪市福島区福島３丁目１−６１', date '2010-02-01', date '2011-04-01', 505, 5353, 4149),
  ('三共四ツ橋ビル', '四ツ橋', '大阪府大阪市西区南堀江１丁目１１−１', date '1974-07-01', date '2004-03-01', 485, 3902, 2657),
  ('三共ビル東館', '東館', '大阪府大阪市北区西天満５丁目２−１８', date '1967-06-01', date '2001-03-01', 232, 2771, 1884),
  ('三共新大阪ビル', '新大阪', '大阪府大阪市淀川区木川東２丁目４−１０', date '1991-10-01', date '2003-09-01', 189, 686, 599),
  ('三共本町ビル', '本町', '大阪府大阪市西区靱本町１丁目１０−２４', date '1991-06-01', date '2011-11-01', 258, 2031, 1334),
  ('三共堺筋本町ビル', '堺筋本町', '大阪府大阪市中央区博労町１丁目８−２', date '1993-10-01', date '2013-06-01', 147, 1250, 935),
  ('三共広島ビル', '広島', '広島県広島市中区小町３−２５', date '1974-06-01', date '2004-11-01', 228, 2021, 1325),
  ('三共稲荷町ビル', '稲荷町', '広島県広島市南区稲荷町５−１８', date '1992-05-01', date '2010-02-01', 201, 1201, 875),
  ('三共京橋ビル', '京橋', '広島県広島市南区京橋町９−２１', date '1990-01-01', date '2008-12-01', 253, 1260, 959),
  ('三共若草ビル', '若草', '広島県広島市東区若草町９−７', date '1987-09-01', date '2008-12-01', 314, 1291, 1025),
  ('三共福岡ビル', '福岡', '福岡県福岡市博多区博多駅南２丁目９−１１', date '1975-07-01', date '2007-10-01', 451, 4245, 2850),
  ('その他', 'その他', null, null, null, null, null, null),
  ('SK HOTEL 神戸駅前', null, null, null, null, null, null, null),
  ('大阪リバーサイドホテル', null, null, null, null, null, null, null),
  ('HOTEL SANKYO FUKUSHIMA', null, null, null, null, null, null, null)
on conflict (property_name) do update set
  short_name = excluded.short_name,
  address = excluded.address,
  construction_date = excluded.construction_date,
  acquisition_date = excluded.acquisition_date,
  land_area_sqm = excluded.land_area_sqm,
  building_area_sqm = excluded.building_area_sqm,
  rentable_area_sqm = excluded.rentable_area_sqm,
  updated_at = now();
