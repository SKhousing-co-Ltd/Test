import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type FieldMap = Record<string, string>;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'GET') return response({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const authorization = request.headers.get('Authorization') ?? '';
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return response({ error: 'Unauthorized' }, 401);

  const apiUrl = Deno.env.get('DESKNETS_API_URL');
  const apiToken = Deno.env.get('DESKNETS_API_TOKEN');
  const formId = Deno.env.get('DESKNETS_WORKFLOW_FORM_ID');
  const mappingText = Deno.env.get('DESKNETS_FIELD_MAP');
  if (!apiUrl || !apiToken || !formId || !mappingText) {
    return response({ error: 'デスクネッツAPIの接続設定が未投入です。管理者に DESKNETS_API_URL、DESKNETS_API_TOKEN、DESKNETS_WORKFLOW_FORM_ID、DESKNETS_FIELD_MAP の設定を依頼してください。', code: 'DESKNETS_NOT_CONFIGURED' }, 503);
  }

  let fieldMap: FieldMap;
  try { fieldMap = JSON.parse(mappingText); } catch { return response({ error: 'DESKNETS_FIELD_MAP がJSON形式ではありません。', code: 'DESKNETS_INVALID_MAPPING' }, 500); }

  try {
    // API仕様受領後、endpoint・認証ヘッダー・レスポンス配列の位置をここで確定する。
    const apiResponse = await fetch(`${apiUrl.replace(/\/$/, '')}/workflow/applications?form_id=${encodeURIComponent(formId)}&status=approved`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
    });
    if (!apiResponse.ok) return response({ error: `デスクネッツAPIの取得に失敗しました (${apiResponse.status})。`, code: 'DESKNETS_API_ERROR' }, 502);
    const payload = await apiResponse.json();
    const applications = Array.isArray(payload) ? payload : payload.applications;
    if (!Array.isArray(applications)) return response({ error: 'デスクネッツAPIの応答形式が想定と異なります。', code: 'DESKNETS_INVALID_RESPONSE' }, 502);
    const items = applications
      .filter((item: Record<string, unknown>) => String(item.status).toLowerCase() === 'approved')
      .map((item: Record<string, unknown>) => ({
        applicationId: String(item.id ?? item.application_id ?? ''),
        title: String(item.title ?? item.subject ?? '無題の申請'),
        approvedAt: item.approved_at ?? item.completed_at ?? null,
        values: Object.fromEntries(Object.entries(fieldMap).map(([documentField, workflowField]) => [documentField, item[workflowField] ?? ''])),
        source: item,
      }));
    return response({ applications: items });
  } catch (error) {
    return response({ error: `デスクネッツAPIへ接続できませんでした: ${error instanceof Error ? error.message : String(error)}`, code: 'DESKNETS_NETWORK_ERROR' }, 502);
  }
});
