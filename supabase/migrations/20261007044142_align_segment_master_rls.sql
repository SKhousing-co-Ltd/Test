-- Match the remote schema: segment_master is not exposed to client roles.
alter table public.segment_master enable row level security;
