import { adminClient, changed, corsHeaders, enrichRingiNumbers, fetchRecords, json } from '../_shared/appsuite.ts';

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [value.message, value.details, value.hint, value.code].filter((part): part is string => typeof part === 'string' && part.length > 0);
    if (parts.length) return parts.join(' | ');
    try { return JSON.stringify(error); } catch { return 'Unknown object error'; }
  }
  return String(error);
}

async function syncApplication(appId: string) {
  const admin = adminClient();
  const { data: run, error: runError } = await admin.from('appsuite_sync_run')
    .insert({ app_id: appId, trigger_type: 'scheduled', status: 'running' })
    .select('appsuite_sync_run_id').single();
  if (runError) throw runError;

  try {
    const records = await fetchRecords(appId);
    const { data: stored, error } = await admin.from('appsuite_record')
      .select('data_id, revision, raw_payload, is_present, ringi_number').eq('app_id', appId);
    if (error) throw error;
    const existing = new Map((stored ?? []).map((row) => [row.data_id, row]));
    const inserted = records.filter((record) => !existing.has(record.data_id)).length;
    const updated = records.filter((record) => existing.has(record.data_id) && changed(record, existing.get(record.data_id))).length;
    const unchanged = records.length - inserted - updated;
    const sourceIds = new Set(records.map((record) => record.data_id));
    const missing = (stored ?? []).filter((row) => row.is_present && !sourceIds.has(row.data_id)).map((row) => row.data_id);
    const enrichedRecords = await enrichRingiNumbers(records, existing);
    const now = new Date().toISOString();
    const { error: upsertError } = await admin.from('appsuite_record')
      .upsert(enrichedRecords.map((record) => ({ ...record, is_present: true, last_seen_at: now })), { onConflict: 'app_id,data_id' });
    if (upsertError) throw upsertError;
    if (missing.length) {
      const { error: missingError } = await admin.from('appsuite_record')
        .update({ is_present: false }).eq('app_id', appId).in('data_id', missing);
      if (missingError) throw missingError;
    }
    const counts = {
      fetched_count: records.length, inserted_count: inserted, updated_count: updated,
      unchanged_count: unchanged, missing_count: missing.length,
    };
    await admin.from('appsuite_application').update({ last_synced_at: now }).eq('app_id', appId);
    const { error: finishError } = await admin.from('appsuite_sync_run')
      .update({ status: 'succeeded', finished_at: now, ...counts }).eq('appsuite_sync_run_id', run.appsuite_sync_run_id);
    if (finishError) throw finishError;
    return { appId, status: 'succeeded', fetched: records.length, inserted, updated, missing: missing.length };
  } catch (error) {
    const message = errorMessage(error);
    await admin.from('appsuite_sync_run').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message })
      .eq('appsuite_sync_run_id', run.appsuite_sync_run_id);
    return { appId, status: 'failed', error: message };
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!Deno.env.get('APPSUITE_SCHEDULER_SECRET') || request.headers.get('x-appsuite-scheduler-secret') !== Deno.env.get('APPSUITE_SCHEDULER_SECRET')) return json({ error: 'Unauthorized' }, 401);
  try {
    const body = await request.json().catch(() => ({})) as { appId?: unknown };
    const requestedAppId = typeof body.appId === 'string' && body.appId.trim() ? body.appId.trim() : null;
    let appIds: string[];
    if (requestedAppId) {
      const { data: application, error } = await adminClient().from('appsuite_application')
        .select('app_id').eq('app_id', requestedAppId).eq('is_sync_enabled', true).maybeSingle();
      if (error) throw error;
      if (!application) return json({ error: '同期対象として有効なアプリではありません' }, 400);
      appIds = [application.app_id];
    } else {
      const { data: applications, error } = await adminClient().from('appsuite_application')
        .select('app_id').eq('is_sync_enabled', true);
      if (error) throw error;
      appIds = (applications ?? []).map((application) => application.app_id);
    }
    const results = [];
    for (const appId of appIds) results.push(await syncApplication(appId));
    return json({ results }, results.some((result) => result.status === 'failed') ? 207 : 200);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});
