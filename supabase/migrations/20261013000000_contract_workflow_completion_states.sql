-- Contract workflow state used by the workflow UI and rent-roll eligibility checks.
alter table public.lease_contract
  add column if not exists contract_content_reviewed_at timestamptz,
  add column if not exists contract_content_reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists contract_document_completed_at timestamptz,
  add column if not exists contract_document_completed_by uuid references auth.users(id) on delete set null,
  add column if not exists btob_registered_at timestamptz,
  add column if not exists btob_registered_by uuid references auth.users(id) on delete set null;

alter table public.lease_contract_document
  add column if not exists workflow_pdf_uploaded_at timestamptz,
  add column if not exists workflow_pdf_uploaded_by uuid references auth.users(id) on delete set null;

create table if not exists public.lease_contract_document_pdf_history (
  lease_contract_document_pdf_history_id uuid primary key default gen_random_uuid(),
  lease_contract_document_id uuid not null references public.lease_contract_document(lease_contract_document_id) on delete cascade,
  pdf_file_path text not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now()
);
create index if not exists ix_lease_contract_document_pdf_history_document
  on public.lease_contract_document_pdf_history(lease_contract_document_id, uploaded_at desc);
alter table public.lease_contract_document_pdf_history enable row level security;
grant select, insert on public.lease_contract_document_pdf_history to authenticated;
drop policy if exists "active users read contract document pdf history" on public.lease_contract_document_pdf_history;
create policy "active users read contract document pdf history"
  on public.lease_contract_document_pdf_history for select to authenticated
  using (public.current_account_is_active());
drop policy if exists "active users insert contract document pdf history" on public.lease_contract_document_pdf_history;
create policy "active users insert contract document pdf history"
  on public.lease_contract_document_pdf_history for insert to authenticated
  with check (public.current_account_is_active());

create or replace function public.complete_contract_content_review(p_lease_contract_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  update public.lease_contract set contract_content_reviewed_at = coalesce(contract_content_reviewed_at, now()), contract_content_reviewed_by = coalesce(contract_content_reviewed_by, auth.uid()) where lease_contract_id = p_lease_contract_id;
  if not found then raise exception '契約が見つかりません'; end if;
end; $$;

create or replace function public.complete_contract_document_workflow(p_lease_contract_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  update public.lease_contract set contract_document_completed_at = coalesce(contract_document_completed_at, now()), contract_document_completed_by = coalesce(contract_document_completed_by, auth.uid()) where lease_contract_id = p_lease_contract_id;
  if not found then raise exception '契約が見つかりません'; end if;
end; $$;

create or replace function public.set_contract_btob_registration(p_lease_contract_id uuid, p_registered boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  update public.lease_contract set btob_registered_at = case when p_registered then coalesce(btob_registered_at, now()) else null end, btob_registered_by = case when p_registered then auth.uid() else null end where lease_contract_id = p_lease_contract_id;
  if not found then raise exception '契約が見つかりません'; end if;
end; $$;

create or replace function public.request_contract_workflow_change(p_lease_contract_id uuid, p_title text, p_summary text, p_proposed_payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'Active account required'; end if;
  insert into public.change_request(source_type, source_record_key, request_type, title, summary, source_payload, proposed_payload)
  values ('manual', p_lease_contract_id::text, 'contract_update', p_title, p_summary, jsonb_build_object('lease_contract_id', p_lease_contract_id), coalesce(p_proposed_payload, '{}'::jsonb))
  on conflict (source_type, source_record_key, request_type) where source_record_key is not null and status not in ('applied','excluded')
  do update set title = excluded.title, summary = excluded.summary, proposed_payload = excluded.proposed_payload, updated_at = now(), updated_by = auth.uid()
  returning change_request_id into v_id;
  return v_id;
end; $$;

revoke all on function public.complete_contract_content_review(uuid), public.complete_contract_document_workflow(uuid), public.set_contract_btob_registration(uuid, boolean), public.request_contract_workflow_change(uuid, text, text, jsonb) from public, anon;
grant execute on function public.complete_contract_content_review(uuid), public.complete_contract_document_workflow(uuid), public.set_contract_btob_registration(uuid, boolean), public.request_contract_workflow_change(uuid, text, text, jsonb) to authenticated;
