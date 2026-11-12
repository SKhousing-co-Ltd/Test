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
  if (!url || !anonKey || !serviceRoleKey) return json({ error: 'サーバーの認証設定が不足しています。' }, 500);

  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: 'ログイン状態を確認できません。' }, 401);

  const { data: profile, error: profileError } = await admin.from('user_profiles')
    .select('account_status, must_change_password').eq('user_id', user.id).maybeSingle();
  if (profileError) return json({ error: 'アカウント情報を確認できません。' }, 500);
  if (!profile || profile.account_status !== 'active') return json({ error: '有効なアカウントが必要です。' }, 403);
  if (!profile.must_change_password) return json({ error: '初回パスワード変更は必要ありません。' }, 409);

  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length < 6) return json({ error: 'パスワードは6文字以上で入力してください。' }, 400);

  const { error: passwordError } = await admin.auth.admin.updateUserById(user.id, { password });
  if (passwordError) return json({ error: passwordError.message }, 400);
  const { error: clearRequirementError } = await admin.from('user_profiles')
    .update({ must_change_password: false }).eq('user_id', user.id).eq('must_change_password', true);
  if (clearRequirementError) return json({ error: 'パスワードは変更されましたが、初回設定状態の更新に失敗しました。再度お試しください。' }, 500);

  return json({ success: true });
});
