import { adminClient, changed, corsHeaders, enrichRingiNumbers, fetchRecords, json, listApplications, requireActiveUser } from '../_shared/appsuite.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { user, userClient } = await requireActiveUser(request);
    const body = await request.json().catch(() => ({}));
    if (body.action === 'list_applications') {
      const { data: isAdmin } = await userClient.rpc('current_account_is_admin');
      if (!isAdmin) return json({ error: '管理者のみアプリ一覧を更新できます' }, 403);
      return json({ applications: await listApplications() });
    }
    const appId = String(body.appId ?? '');
    if (!appId) return json({ error: 'appId が必要です' }, 400);
    const { data: application, error: applicationError } = await userClient.from('appsuite_application').select('app_id, app_name, is_sync_enabled').eq('app_id', appId).maybeSingle();
    if (applicationError) {
      const details = applicationError.details ? `: ${applicationError.details}` : "";
      throw new Error(`${applicationError.message}${details}`);
    }
    if (!application || !application.is_sync_enabled) return json({ error: '同期対象として有効なアプリを選択してください' }, 400);
    const admin = adminClient();
    const records = await fetchRecords(appId);
    const { data: stored, error } = await admin.from('appsuite_record').select('data_id, revision, raw_payload, is_present, ringi_number').eq('app_id', appId);
    if (error) throw error;
    const existing = new Map((stored ?? []).map((row) => [row.data_id, row]));
    const enrichedRecords = await enrichRingiNumbers(records, existing);
    const items = enrichedRecords.map((record) => ({ ...record, change_type: !existing.has(record.data_id) ? '追加' : changed(record, existing.get(record.data_id)) ? '更新' : '未変更', previous_payload: existing.get(record.data_id)?.raw_payload ?? null }));
    const fetchedIds = new Set(enrichedRecords.map((record) => record.data_id));
    const missing = (stored ?? []).filter((row) => row.is_present && !fetchedIds.has(row.data_id)).map((row) => ({ data_id: row.data_id, change_type: 'ソース未検出', previous_payload: row.raw_payload }));
    const summary = { fetched: records.length, inserted: items.filter((item) => item.change_type === '追加').length, updated: items.filter((item) => item.change_type === '更新').length, unchanged: items.filter((item) => item.change_type === '未変更').length, missing: missing.length };
    const snapshot = { records: enrichedRecords, missing_data_ids: missing.map((item) => item.data_id) };
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { data: preview, error: previewError } = await admin.from('appsuite_sync_preview').insert({ app_id: appId, created_by: user.id, status: 'pending', expires_at: expiresAt, snapshot, summary }).select('appsuite_sync_preview_id, expires_at').single();
    if (previewError) throw previewError;
    return json({ previewId: preview.appsuite_sync_preview_id, expiresAt: preview.expires_at, application, summary, items: [...items, ...missing] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : error && typeof error === 'object'
      ? JSON.stringify(error)
      : String(error);
    return json({ error: detail }, /Unauthorized/.test(detail) ? 401 : 500);
  }
});
