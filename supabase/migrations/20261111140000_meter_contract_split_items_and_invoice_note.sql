alter table public.meter_reading_contract
  add column if not exists split_items text[] not null
    default array['rent', 'common', 'storage', 'variable']::text[],
  add column if not exists invoice_note text;

alter table public.meter_reading_contract
  drop constraint if exists meter_reading_contract_split_items_check;

alter table public.meter_reading_contract
  add constraint meter_reading_contract_split_items_check
  check (split_items <@ array['rent', 'common', 'storage', 'variable']::text[]);
