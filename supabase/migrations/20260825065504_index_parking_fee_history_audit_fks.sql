create index if not exists ix_parking_fee_history_source_batch
  on public.parking_fee_history(source_import_batch_id)
  where source_import_batch_id is not null;

create index if not exists ix_parking_fee_history_source_row
  on public.parking_fee_history(source_import_row_id)
  where source_import_row_id is not null;

create index if not exists ix_parking_fee_history_created_by
  on public.parking_fee_history(created_by);
