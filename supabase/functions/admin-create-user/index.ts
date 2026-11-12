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
  const { data: { user: caller }, error: callerError } = await userClient.auth.getUser();
  if (callerError || !caller) return json({ error: 'ログイン状態を確認できません。' }, 401);

  const { data: callerProfile, error: callerProfileError } = await userClient.from('user_profiles')
    .select('role, account_status, must_change_password').eq('user_id', caller.id).maybeSingle();
  if (callerProfileError) return json({ error: '管理者権限を確認できません。' }, 403);
  if (callerProfile?.role !== 'admin' || callerProfile.account_status !== 'active' || callerProfile.must_change_password) {
    return json({ error: 'システム管理者のみアカウントを作成できます。' }, 403);
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const employeeId = typeof body?.employee_id === 'string' ? body.employee_id : '';
  const role = body?.role;
  if (!email.includes('@') || password.length < 6 || !employeeId || !['admin', 'manager', 'staff', 'viewer'].includes(String(role))) {
    return json({ error: '入力内容を確認してください。' }, 400);
  }

  const { data: employee, error: employeeError } = await admin.from('employee_master')
    .select('employee_id, employment_status').eq('employee_id', employeeId).maybeSingle();
  if (employeeError) return json({ error: '担当者情報を確認できません。' }, 500);
  if (!employee || employee.employment_status !== 'active') return json({ error: '在籍中の担当者を選択してください。' }, 400);
  const { data: linkedProfile, error: linkedProfileError } = await admin.from('user_profiles')
    .select('user_id').eq('employee_id', employeeId).maybeSingle();
  if (linkedProfileError) return json({ error: '担当者の紐づけを確認できません。' }, 500);
  if (linkedProfile) return json({ error: '選択した担当者には既にアカウントが紐づいています。' }, 409);

  const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError || !created.user) return json({ error: createError?.message ?? 'Auth アカウントを作成できませんでした。' }, 400);

  const { error: profileError } = await admin.from('user_profiles').update({
    employee_id: employeeId,
    role,
    account_status: 'active',
    must_change_password: true,
    approved_at: new Date().toISOString(),
    approved_by: caller.id,
  }).eq('user_id', created.user.id);
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: 'プロフィールの設定に失敗したため、作成したアカウントを取り消しました。' }, 500);
  }

  return json({ user_id: created.user.id });
});
