-- Edge Functions write immutable output revisions using the service role.
grant select, insert, update on public.lease_contract_document_output_revision to service_role;
