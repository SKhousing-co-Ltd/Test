-- The candidate-search function is defined by 20261014210000. Preserve only
-- the independent index from the colliding 20261014200000 migration so that
-- applying this later migration cannot replace the newer function definition.
create index if not exists ix_appsuite_record_unprocessed_approval_candidates
  on public.appsuite_record (app_id, approval_status, source_updated_at desc)
  where is_present and workflow_processed_at is null;
