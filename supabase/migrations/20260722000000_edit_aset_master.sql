-- ============================================================
-- asset_master 統合SQL（アセットマスタ_追加情報.csv より生成）
--   STEP1 列追加 → STEP2 全件UPSERT → STEP3 確認
--   何度実行しても同じ結果になる（冪等）。
-- ============================================================


-- ------------------------------------------------------------
-- STEP1. 追加情報を保持する列を追加
-- ------------------------------------------------------------
alter table asset_master
  add column if not exists address            text,
  add column if not exists construction_date  date,
  add column if not exists acquisition_date   date,
  add column if not exists land_area_sqm      numeric(12, 2),
  add column if not exists building_area_sqm  numeric(12, 2),
  add column if not exists rentable_area_sqm  numeric(12, 2);

comment on column asset_master.address           is '住所';
comment on column asset_master.construction_date is '築年月（月初日で保持）';
comment on column asset_master.acquisition_date  is '取得年月（月初日で保持）';
comment on column asset_master.land_area_sqm     is '土地面積（㎡）';
comment on column asset_master.building_area_sqm is '建物面積（㎡）';
comment on column asset_master.rentable_area_sqm is '貸床面積（㎡）';


-- ------------------------------------------------------------
-- STEP2. 全件 UPSERT
--   ・asset_code 200 / 210 / 220（ホテル3件）は新規追加
--   ・既存レコードは名称・短縮名・セグメント・住所等を CSV の内容で更新
--     （43 大阪リバーサイドホテル（ビル）／51 三共赤坂ビル は名称変更あり）
-- ------------------------------------------------------------
insert into asset_master (
  asset_code, asset_name, short_name, segment_id,
  address, construction_date, acquisition_date,
  land_area_sqm, building_area_sqm, rentable_area_sqm
) values
  (1,  '本社経費',           '本社',       '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (2,  '北春日丘',           '北春日丘',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (4,  '南春日丘',           '南春日丘',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (5,  '小石川パークタワー', '小石川Ｐ',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (6,  '中之島社宅',         '中之島社宅', '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (7,  '三重',               '三重',       '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),

  (11, '三共四ツ橋ビル',   '四ツ橋',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市西区南堀江１丁目１１−１',       date '1974-07-01', date '2004-03-01', 485, 3902, 2657),
  (12, '三共広島ビル',     '広島',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '広島県広島市中区小町３−２５',               date '1974-06-01', date '2004-11-01', 228, 2021, 1325),
  (13, '三共ビル東館',     '東館',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市北区西天満５丁目２−１８',       date '1967-06-01', date '2001-03-01', 232, 2771, 1884),
  (14, '三共日本橋ビル',   '日本橋',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市中央区日本橋１丁目３−１',       date '1991-02-01', date '2002-02-01',  46,  396,  344),
  (16, '三共新大阪ビル',   '新大阪',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市淀川区木川東２丁目４−１０',     date '1991-10-01', date '2003-09-01', 189,  686,  599),
  (17, '三共肥後橋ビル',   '肥後橋',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市西区江戸堀１丁目１９−１０',     date '1990-03-01', date '2004-01-01', 217,  892,  604),
  (19, '吉田マンション',   '吉田',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', null, null, null, null, null, null),
  (20, '三共福岡ビル',     '福岡',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '福岡県福岡市博多区博多駅南２丁目９−１１',   date '1975-07-01', date '2007-10-01', 451, 4245, 2850),
  (21, '三共京橋ビル',     '京橋',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '広島県広島市南区京橋町９−２１',             date '1990-01-01', date '2008-12-01', 253, 1260,  959),
  (22, '三共若草ビル',     '若草',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '広島県広島市東区若草町９−７',               date '1987-09-01', date '2008-12-01', 314, 1291, 1025),
  (23, '三共堺東ビル',     '堺東',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', null, null, null, null, null, null),
  (24, '三共稲荷町ビル',   '稲荷町',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '広島県広島市南区稲荷町５−１８',             date '1992-05-01', date '2010-02-01', 201, 1201,  875),
  (25, '三共本町ビル',     '本町',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市西区靱本町１丁目１０−２４',     date '1991-06-01', date '2011-11-01', 258, 2031, 1334),
  (26, 'ＲＳＴ中之島',     '中之島',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市福島区福島３丁目１−６１',       date '2010-02-01', date '2011-04-01', 505, 5353, 4149),
  (27, '三共神戸ツインビル', '神戸',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '兵庫県神戸市中央区中町通２丁目３−２',       date '1983-03-01', date '2011-06-01', 865, 6586, 1431),
  (29, '三共梅田ビル',     '梅田',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市北区堂山町１−５',               date '1965-09-01', date '2012-05-01', 613, 6203, 4095),
  (30, '三共仙台ビル',     '仙台',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '宮城県仙台市青葉区本町１丁目１２−７',       date '1992-05-01', date '2013-04-01', 531, 2923, 2037),
  (33, '茨木駅前ビル',     '茨木',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', null, null, null, null, null, null),
  (41, '三共堺筋本町ビル', '堺筋本町', '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市中央区博労町１丁目８−２',       date '1993-10-01', date '2013-06-01', 147, 1250,  935),
  (42, '三共福島ビル',     '福島',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '福島県福島市大町７−１１',                   date '1995-03-01', date '2013-12-01', 751, 4577, 1124),
  (43, '大阪リバーサイドホテル（ビル）', 'ＲＨ', '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '大阪府大阪市都島区中野町５丁目１２−３０', null, null, null, null, null),
  (44, '三共郡山ビル南館', '郡山南',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '福島県郡山市駅前２丁目１０−１６',           date '1984-03-01', date '2014-01-01', 258, 1681, 1129),
  (45, '三共小石川ＴＨビル', '小石川', '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '東京都文京区小石川５丁目３６−５',           date '2014-01-01', date '2014-01-01', 175,  789,  571),
  (46, '三共郡山ビル北館', '郡山北',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '福島県郡山市駅前２丁目１０−１５',           date '1981-12-01', date '2014-06-01', 256, 1596,  957),
  (47, '三共仙台東ビル',   '仙台東',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '宮城県仙台市宮城野区榴岡５丁目１−３５',     date '1991-06-01', date '2015-04-01', 638, 2960, 1725),
  (48, '三共西新宿ビル',   '西新宿',   '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '東京都新宿区西新宿４丁目２−１８',           date '1993-03-01', date '2015-04-01',  83,  497,  430),
  (49, '三共横浜ビル',     '横浜',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '神奈川県横浜市中区長者町５丁目８５',         date '1996-03-01', date '2016-03-01', 662, 4429, 3575),
  (50, '三共小山ビル',     '小山',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '栃木県小山市駅東通り２丁目３７−３',         date '1991-07-01', date '2016-03-01', 509, 2018, 1557),
  (51, '三共赤坂ビル',     '赤坂',     '5022e780-d77d-4a6f-84b5-0aa3bd39047f', '東京都港区赤坂７丁目１１−７',               null, null, null, null, null),

  -- ホテル（新規追加）
  (200, 'HOTEL SANKYO FUKUSHIMA', 'Ｈ福島',     '8ce4d194-6b78-404b-a000-060c623538cf', null, null, null, null, null, null),
  (210, '大阪リバーサイドホテル', '大阪ＲＨ',   '8ce4d194-6b78-404b-a000-060c623538cf', null, null, null, null, null, null),
  (220, 'SK HOTEL 神戸駅前',      'Ｈ神戸',     '8ce4d194-6b78-404b-a000-060c623538cf', null, null, null, null, null, null),

  -- 寮
  (401, '堺寮',           '堺寮',     '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (402, '千舟寮',         '千舟寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (403, '岸和田寮',       '岸和田寮', '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (404, '東中島寮',       '東中島寮', '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (405, '寝屋川寮',       '寝屋川寮', '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (406, '塩釜寮',         '塩釜寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (407, '名取寮',         '名取寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (408, '尼崎寮',         '尼崎寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (409, '松戸寮',         '松戸寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (410, '浦安寮',         '浦安寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (411, '習志野寮',       '習志野寮', '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (412, '立川寮',         '立川寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (413, '横浜寮',         '横浜寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (414, '摂津寮（鳥飼）', '摂津寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (415, '博多寮',         '博多寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (416, '三郷寮（金町）', '三郷寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (417, '粕屋寮',         '粕屋寮',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),

  -- 土地・その他
  (501, '阪南箱作',               '阪南箱作',       '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (502, '太子町',                 '太子町',         '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (503, '池田市天神',             '池田市天神',     '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (504, '東伊豆',                 '東伊豆',         '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (505, '奈良ドリームランド跡地', '奈良',           '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (506, '目黒',                   '目黒',           '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (507, '銀座８丁目',             '銀座８丁目',     '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (508, 'りんくう',               'りんくう',       '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (509, '岩沼（仙台空港）',       '岩沼',           '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (510, '神戸市北区（山林）',     '神戸市北区山林', '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (511, '淡路市',                 '淡路市',         '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (512, '奈良市般若寺',           '奈良市般若寺',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (513, '札幌',                   '札幌',           '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (514, '阪南市土地',             '阪南市土地',     '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (515, '堺市西区太平寺',         '堺市西区太平寺', '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (516, '埼玉県吉川市',           '埼玉県吉川市',   '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null),
  (517, '埼玉県吉川市②',         '埼玉県吉川市②', '4ab28b6d-20a9-438b-bff5-ae66678acc50', null, null, null, null, null, null)
on conflict (asset_code) do update set
  asset_name        = excluded.asset_name,
  short_name        = excluded.short_name,
  segment_id        = excluded.segment_id,
  address           = excluded.address,
  construction_date = excluded.construction_date,
  acquisition_date  = excluded.acquisition_date,
  land_area_sqm     = excluded.land_area_sqm,
  building_area_sqm = excluded.building_area_sqm,
  rentable_area_sqm = excluded.rentable_area_sqm,
  updated_at        = now();


-- ------------------------------------------------------------
-- STEP3. 結果確認
-- ------------------------------------------------------------
select asset_code, asset_name, short_name, segment_id, address,
       construction_date, acquisition_date,
       land_area_sqm, building_area_sqm, rentable_area_sqm
from asset_master
order by asset_code;
