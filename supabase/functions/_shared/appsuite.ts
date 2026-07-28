import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-appsuite-scheduler-secret',
};

export type AppsuiteRecord = {
  app_id: string; data_id: string; revision: string | null; workflow_type: string; approval_status: string | null;
  property_name: string | null; tenant_name: string | null; source_created_at: string | null; source_updated_at: string | null;
  raw_payload: Record<string, unknown>;
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

export function adminClient() {
  const serviceRoleKey = Deno.env.get('APPSUITE_SYNC_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceRoleKey) throw new Error('同期用サービスロールキーが設定されていません');
  return createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);
}

export async function requireActiveUser(request: Request) {
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) throw new Error('Unauthorized');
  const { data: active, error } = await userClient.rpc('current_account_is_active');
  if (error || !active) throw new Error('有効なアカウントが必要です');
  return { user, userClient };
}

function apiUrl() {
  const base = (Deno.env.get('APPSUITE_URL') ?? '').replace(/\/$/, '');
  if (!base) throw new Error('APPSUITE_URL が未設定です');
  if (/\/appsr\.cgi$/.test(base)) return base;
  if (/\/[^/]+\.cgi$/.test(base)) return base.replace(/\/[^/]+\.cgi$/, '/appsr.cgi');
  return `${base}/cgi-bin/dneo/appsr.cgi`;
}

async function postAppsuite(params: Record<string, string>) {
  const key = Deno.env.get('APPSUITE_ACCESS_KEY');
  if (!key) throw new Error('APPSUITE_ACCESS_KEY が未設定です');
  const response = await fetch(apiUrl(), { method: 'POST', headers: { 'X-Desknets-Auth': key }, body: new URLSearchParams(params) });
  if (response.status === 429) throw new Error('AppSuite API が混雑しています。しばらくしてから再試行してください');
  if (!response.ok) throw new Error(`AppSuite API の取得に失敗しました (${response.status})`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error(body.errormessage ?? 'AppSuite API がエラーを返しました');
  return body;
}

function value(payload: Record<string, unknown>, key: string): string | null {
  const field = payload[key] as { val?: unknown } | undefined;
  if (!field || field.val === undefined || field.val === null) return null;
  return typeof field.val === 'string' ? field.val.trim() || null : String(field.val);
}

function workflowType(name: string | null) {
  if (!name) return 'その他';
  if (/定期借家.*(?:まき直し|巻き直し)|(?:まき直し|巻き直し).*定期借家/.test(name)) return '定期借家まき直し稟議';
  if (name.includes('新規契約稟議')) return '新規契約稟議';
  if (name.includes('入居稟議')) return '入居稟議';
  return 'その他';
}

export async function listApplications() {
  const body = await postAppsuite({ action: 'list_apps' });
  return (body.list?.item ?? []).map((item: Record<string, unknown>) => ({ app_id: String(item.id), app_name: String(item.name), app_status: item.app_status ? String(item.app_status) : null }));
}

export async function fetchRecords(appId: string): Promise<AppsuiteRecord[]> {
  const count = await postAppsuite({ action: 'count_data', app_id: appId });
  const total = Number(count.allcnt ?? 0);
  const results: AppsuiteRecord[] = [];
  for (let offset = 0; offset < total; offset += 100) {
    const page = await postAppsuite({ action: 'list_data', app_id: appId, offset: String(offset), limit: '100' });
    for (const raw of page.list?.item ?? []) {
      const payload = raw as Record<string, unknown>;
      const requirement = value(payload, '申請の要件');
      const dataId = value(payload, 'データID');
      if (!dataId) continue;
      results.push({ app_id: appId, data_id: dataId, revision: value(payload, 'revision'), workflow_type: workflowType(requirement), approval_status: value(payload, '決裁状況'), property_name: value(payload, '物件名'), tenant_name: value(payload, 'テナント名'), source_created_at: value(payload, '登録日時'), source_updated_at: value(payload, '更新日時'), raw_payload: payload });
    }
  }
  return results;
}

export function changed(source: AppsuiteRecord, stored?: { revision: string | null; raw_payload: unknown; is_present: boolean }) {
  return !stored || !stored.is_present || source.revision !== stored.revision || JSON.stringify(source.raw_payload) !== JSON.stringify(stored.raw_payload);
}
