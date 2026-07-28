import { adminClient, changed, corsHeaders, fetchRecords, json } from '../_shared/appsuite.ts';

async function syncApplication(appId: string) {
  const admin = adminClient();
  const records = await fetchRecords(appId);
  const { data: stored, error } = await admin.from('appsuite_record').select('data_id, revision, raw_payload, is_present').eq('app_id', appId);
  if (error) throw error;
  const existing = new Map((stored ?? []).map((row) => [row.data_id, row]));
  const inserted = records.filter((record) => !existing.has(record.data_id)).length;
  const updated = records.filter((record) => existing.has(record.data_id) && changed(record, existing.get(record.data_id))).length;
  const unchanged = records.length - inserted - updated;
  const sourceIds = new Set(records.map((record) => record.data_id));
  const missing = (stored ?? []).filter((row) => row.is_present && !sourceIds.has(row.data_id)).map((row) => row.data_id);
  const { data: run, error: runError } = await admin.from('appsuite_sync_run').insert({ app_id: appId, trigger_type: 'scheduled', status: 'running', fetched_count: records.length, inserted_count: inserted, updated_count: updated, unchanged_count: unchanged, missing_count: missing.length }).select('appsuite_sync_run_id').single();
  if (runError) throw runError;
  const now = new Date().toISOString();
  try {
    const { error: upsertError } = await admin.from('appsuite_record').upsert(records.map((record) => ({ ...record, is_present: true, last_seen_at: now })), { onConflict: 'app_id,data_id' });
    if (upsertError) throw upsertError;
    if (missing.length) {
      const { error: missingError } = await admin.from('appsuite_record').update({ is_present: false }).eq('app_id', appId).in('data_id', missing);
      if (missingError) throw missingError;
    }
    await admin.from('appsuite_application').update({ last_synced_at: now }).eq('app_id', appId);
    await admin.from('appsuite_sync_run').update({ status: 'succeeded', finished_at: now }).eq('appsuite_sync_run_id', run.appsuite_sync_run_id);
    return { appId, status: 'succeeded', fetched: records.length };
  } catch (error) {
    await admin.from('appsuite_sync_run').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: error instanceof Error ? error.message : String(error) }).eq('appsuite_sync_run_id', run.appsuite_sync_run_id);
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!Deno.env.get('APPSUITE_SCHEDULER_SECRET') || request.headers.get('x-appsuite-scheduler-secret') !== Deno.env.get('APPSUITE_SCHEDULER_SECRET')) return json({ error: 'Unauthorized' }, 401);
  try {
    const { data: applications, error } = await adminClient().from('appsuite_application').select('app_id').eq('is_sync_enabled', true);
    if (error) throw error;
    const results = [];
    for (const application of applications ?? []) results.push(await syncApplication(application.app_id));
    return json({ results });
  } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
});
