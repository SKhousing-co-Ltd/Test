import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'Unauthorized' }, 401);
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceRoleKey) return json({ error: 'Server authentication is not configured' }, 500);

  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user: caller }, error: callerError } = await userClient.auth.getUser();
  if (callerError || !caller) return json({ error: 'Unable to verify login' }, 401);

  const { data: callerProfile, error: callerProfileError } = await userClient.from('user_profiles')
    .select('role, account_status, must_change_password').eq('user_id', caller.id).maybeSingle();
  if (callerProfileError) return json({ error: 'Unable to verify administrator access' }, 403);
  if (callerProfile?.role !== 'admin' || callerProfile.account_status !== 'active' || callerProfile.must_change_password) {
    return json({ error: 'Administrator access is required' }, 403);
  }

  const { data: profiles, error: profilesError } = await admin.from('user_profiles').select('user_id');
  if (profilesError) return json({ error: 'Unable to load account list' }, 500);
  const profileIds = new Set((profiles ?? []).map((profile) => profile.user_id));
  const statusByUserId: Record<string, boolean> = Object.fromEntries([...profileIds].map((userId) => [userId, false]));

  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return json({ error: 'Unable to load Google identity status' }, 500);
    for (const user of data.users) {
      if (!profileIds.has(user.id)) continue;
      const hasGoogleIdentity = user.identities?.some((identity) => identity.provider === 'google') ?? false;
      const providers = Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers : [];
      const hasGoogleProvider = user.app_metadata?.provider === 'google' || providers.includes('google');
      statusByUserId[user.id] = hasGoogleIdentity || hasGoogleProvider;
    }
    if (data.users.length < perPage) break;
  }

  return json({ statusByUserId });
});
