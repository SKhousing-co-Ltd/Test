create index ix_appsuite_procurement_inbox_account
  on public.appsuite_procurement_inbox(matched_account_id)
  where matched_account_id is not null;
