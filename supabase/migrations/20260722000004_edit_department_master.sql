-- 1) 親セグメント参照用のカラムを追加
alter table department_master
  add column if not exists segment_id uuid;

-- 外部キー制約（segment_master.uid を参照）
alter table department_master
  add constraint fk_department_segment
  foreign key (segment_id) references segment_master (uid);   -- ★ id → uid に修正

-- 2) 既存部署にセグメントを紐付け
update department_master set segment_id = '4ab28b6d-20a9-438b-bff5-ae66678acc50' where department_name = '総務経理部'; -- 本社
update department_master set segment_id = '5022e780-d77d-4a6f-84b5-0aa3bd39047f' where department_name = '営業部';     -- ビル事業部
update department_master set segment_id = '5022e780-d77d-4a6f-84b5-0aa3bd39047f' where department_name = '管理部';     -- ビル事業部
update department_master set segment_id = '5022e780-d77d-4a6f-84b5-0aa3bd39047f' where department_name = '不動産部';   -- ビル事業部

-- 3) 新規部署を追加
insert into department_master (department_name, segment_id) values
  ('役員',                      '4ab28b6d-20a9-438b-bff5-ae66678acc50'),  -- 本社
  ('ホテル総合',                '8ce4d194-6b78-404b-a000-060c623538cf'),  -- ホテル事業部
  ('HOTEL SANKYO FUKUSHIMA',    '8ce4d194-6b78-404b-a000-060c623538cf'),  -- ホテル事業部
  ('大阪リバーサイドホテル',    '8ce4d194-6b78-404b-a000-060c623538cf'),  -- ホテル事業部
  ('SK HOTEL 神戸駅前',         '8ce4d194-6b78-404b-a000-060c623538cf'); -- ホテル事業部

-- 4) 従業員を新しいホテル各部署へ移してから、旧部門を削除する
update employee_master employee
set department_id = department.department_id
from department_master department
where department.department_name = case employee.employee_name
  when '長谷川智英' then 'ホテル総合'
  when '朴正浩' then '大阪リバーサイドホテル'
  when '中原一輝' then 'SK HOTEL 神戸駅前'
  when '佐藤史尚' then 'HOTEL SANKYO FUKUSHIMA'
  when '里井　史隆' then 'ホテル総合'
end
and employee.employee_name in ('長谷川智英', '朴正浩', '中原一輝', '佐藤史尚', '里井　史隆');

delete from department_master where department_name = 'ホテル事業部';
