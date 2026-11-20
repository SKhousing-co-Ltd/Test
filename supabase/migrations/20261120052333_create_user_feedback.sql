create table if not exists public.user_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  body text not null check (length(btrim(body)) > 0),
  attachment_paths text[] not null default '{}'::text[] check (cardinality(attachment_paths) <= 3),
  created_at timestamptz not null default now()
);

create index if not exists user_feedback_created_at_idx
  on public.user_feedback (created_at desc);

alter table public.user_feedback enable row level security;

grant select, insert, delete on public.user_feedback to authenticated;
revoke update on public.user_feedback from authenticated;

create policy "active users submit feedback"
  on public.user_feedback for insert to authenticated
  with check (
    public.current_account_is_active()
    and user_id = (select auth.uid())
    and coalesce((
      select bool_and(split_part(uploaded.path, '/', 1) = (select auth.uid())::text)
      from unnest(attachment_paths) as uploaded(path)
    ), true)
  );

create policy "admins read feedback"
  on public.user_feedback for select to authenticated
  using (public.current_account_is_admin());

create policy "admins delete feedback"
  on public.user_feedback for delete to authenticated
  using (public.current_account_is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-feedback-images', 'user-feedback-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "active users upload feedback images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'user-feedback-images'
    and public.current_account_is_active()
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "admins read feedback images"
  on storage.objects for select to authenticated
  using (bucket_id = 'user-feedback-images' and public.current_account_is_admin());

create policy "admins delete feedback images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'user-feedback-images' and public.current_account_is_admin());
