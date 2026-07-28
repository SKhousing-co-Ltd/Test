alter table public.appsuite_record
  add column if not exists ringi_number varchar(100);

create index if not exists ix_appsuite_record_ringi_number
  on public.appsuite_record (ringi_number)
  where ringi_number is not null;
