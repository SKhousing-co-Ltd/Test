-- 部門 UUID の同期と従業員マスタ
-- 部門 UUID は、従業員マスタ原本および Supabase の部門マスタ内容と照合済み。

with expected_departments (department_id, department_name) as (
  values
    ('d5364021-e041-41a6-a963-3e357d10e4d1'::uuid, '総務経理部'),
    ('04a70146-b256-42a7-b27f-ae33f3128186'::uuid, '管理部'),
    ('b8b1ba0b-f788-4053-9540-1ff791047d5f'::uuid, '営業部'),
    ('3fb46bf3-e229-4465-854e-e3ae6310a373'::uuid, 'ホテル事業部'),
    ('fd8cbc67-faa1-42bc-9f7f-9b34a4ce6bf6'::uuid, '不動産部')
)
update public.department_master as department
set
  department_id = expected.department_id,
  updated_at = now()
from expected_departments as expected
where department.department_name = expected.department_name
  and department.department_id is distinct from expected.department_id;

create table if not exists public.employee_master (
  employee_id uuid primary key default gen_random_uuid(),
  employee_name varchar(100) not null,
  department_id uuid references public.department_master (department_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employee_master enable row level security;

comment on table public.employee_master is '従業員の基本情報';
comment on column public.employee_master.department_id is '部門マスタへの外部キー';

insert into public.employee_master (employee_name, department_id)
values
  ('小澤　夏子', 'd5364021-e041-41a6-a963-3e357d10e4d1'),
  ('濱ノ上郁', 'd5364021-e041-41a6-a963-3e357d10e4d1'),
  ('井上泰吾', 'd5364021-e041-41a6-a963-3e357d10e4d1'),
  ('村田佳奈美', 'd5364021-e041-41a6-a963-3e357d10e4d1'),
  ('太田拓也', 'd5364021-e041-41a6-a963-3e357d10e4d1'),
  ('武田敬介', 'fd8cbc67-faa1-42bc-9f7f-9b34a4ce6bf6'),
  ('岡部克則', 'b8b1ba0b-f788-4053-9540-1ff791047d5f'),
  ('福富靖貴', 'b8b1ba0b-f788-4053-9540-1ff791047d5f'),
  ('長谷川智英', '3fb46bf3-e229-4465-854e-e3ae6310a373'),
  ('朴正浩', '3fb46bf3-e229-4465-854e-e3ae6310a373'),
  ('中原一輝', '3fb46bf3-e229-4465-854e-e3ae6310a373'),
  ('佐藤史尚', '3fb46bf3-e229-4465-854e-e3ae6310a373'),
  ('大石浩司', 'b8b1ba0b-f788-4053-9540-1ff791047d5f'),
  ('真田幸範', null),
  ('金藤蒼月斗', '04a70146-b256-42a7-b27f-ae33f3128186'),
  ('本庄幸人', '04a70146-b256-42a7-b27f-ae33f3128186'),
  ('三好寿', 'b8b1ba0b-f788-4053-9540-1ff791047d5f'),
  ('里井　史隆', '3fb46bf3-e229-4465-854e-e3ae6310a373'),
  ('守時蓮', '04a70146-b256-42a7-b27f-ae33f3128186'),
  ('神作翔大', 'b8b1ba0b-f788-4053-9540-1ff791047d5f');
