import { adminClient, corsHeaders, json, requireActiveUser } from '../_shared/appsuite.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let previewId: string | null = null;
  try {
    const { user, userClient } = await requireActiveUser(request);
    const requestBody = await request.json();
    previewId = typeof requestBody.previewId === 'string' ? requestBody.previewId : null;
    if (!previewId) return json({ error: 'previewId が必要です' }, 400);
    const { data: claim, error: claimError } = await userClient.rpc('claim_appsuite_sync_preview', { p_preview_id: previewId });
    if (claimError) return json({ error: claimError.message }, 409);
    const admin = adminClient();
    const snapshot = claim.snapshot as { records: Array<Record<string, unknown>>; missing_data_ids: string[] };
    const summary = claim.summary as { fetched: number; inserted: number; updated: number; unchanged: number; missing: number };
    const { data: run, error: runError } = await admin.from('appsuite_sync_run').insert({ app_id: claim.app_id, trigger_type: 'manual', status: 'running', triggered_by: user.id, fetched_count: summary.fetched, inserted_count: summary.inserted, updated_count: summary.updated, unchanged_count: summary.unchanged, missing_count: summary.missing }).select('appsuite_sync_run_id').single();
    if (runError) throw runError;
    const now = new Date().toISOString();
    const records = snapshot.records.map((record) => ({ ...record, is_present: true, last_seen_at: now }));
    const { error: upsertError } = await admin.from('appsuite_record').upsert(records, { onConflict: 'app_id,data_id' });
    if (upsertError) throw upsertError;
    if (claim.app_id === '65') {
      for (const record of records) {
        const dataId = typeof record.data_id === 'string' ? record.data_id : null;
        if (!dataId) continue;
        const { error: requestError } = await userClient.rpc('create_change_request_from_appsuite_record', {
          p_app_id: claim.app_id,
          p_data_id: dataId,
        });
        if (requestError) throw requestError;
      }
    }
    if (snapshot.missing_data_ids.length) {
      const { error: missingError } = await admin.from('appsuite_record').update({ is_present: false }).eq('app_id', claim.app_id).in('data_id', snapshot.missing_data_ids);
      if (missingError) throw missingError;
    }
    await admin.from('appsuite_application').update({ last_synced_at: now }).eq('app_id', claim.app_id);
    await admin.from('appsuite_sync_run').update({ status: 'succeeded', finished_at: now }).eq('appsuite_sync_run_id', run.appsuite_sync_run_id);
    await admin.from('appsuite_sync_preview').update({ status: 'applied', applied_at: now }).eq('appsuite_sync_preview_id', previewId);
    return json({ runId: run.appsuite_sync_run_id, summary });
  } catch (error) {
    if (previewId) await adminClient().from('appsuite_sync_preview').update({ status: 'pending', error_message: error instanceof Error ? error.message : String(error) }).eq('appsuite_sync_preview_id', previewId).eq('status', 'applying');
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
