-- 分割した契約行を見分けるための名前（3F など）です。
-- メーター割り当てで、テナント名と並べて表示します。空欄なら画面は「分割 n」と表示します。
alter table public.meter_reading_contract
  add column if not exists split_label varchar(50);

comment on column public.meter_reading_contract.split_label is '分割した契約行の識別名（3F など）';
