create index ix_financial_actual_import_batch_created_by
  on public.financial_actual_import_batch(created_by)
  where created_by is not null;

create index ix_financial_actual_import_batch_applied_by
  on public.financial_actual_import_batch(applied_by)
  where applied_by is not null;
