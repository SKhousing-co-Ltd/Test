-- public.case_progress_migration_verification is security_invoker, so calling
-- public.normalize_appsuite_ringi_number from it runs as the querying user.
-- The function is a pure, side-effect-free text normalization (uppercase +
-- whitespace strip) with no sensitive logic, so it is safe to expose to
-- authenticated callers.

grant execute on function public.normalize_appsuite_ringi_number(text) to authenticated;
