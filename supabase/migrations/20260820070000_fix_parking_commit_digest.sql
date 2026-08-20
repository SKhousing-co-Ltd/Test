-- pgcrypto is installed in the extensions schema on Supabase projects.
-- Keep the existing function body, but make its unqualified digest call
-- resolve consistently regardless of the caller's search_path.
alter function public.commit_parking_import(uuid)
  set search_path = public, extensions;
