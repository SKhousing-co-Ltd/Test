-- セグメントマスタ テーブル作成
create table if not exists segments (
  uid uuid primary key default gen_random_uuid(),  -- 主キー（自動採番UUID）
  segment_name text not null unique,               -- セグメント名
  created_at timestamptz not null default now()    -- 登録日時
);

-- データ投入
insert into segments (segment_name) values
  ('ビル事業部'),
  ('ホテル事業部'),
  ('本社');
