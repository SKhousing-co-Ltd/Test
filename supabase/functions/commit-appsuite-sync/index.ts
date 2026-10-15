import { adminClient, corsHeaders, errorMessage, json, requireActiveUser, upsertAppsuiteRecords } from '../_shared/appsuite.ts';
import type { AppsuiteRecord } from '../_shared/appsuite.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let previewId: string | null = null;
  let runId: string | null = null;
  try {
    const { user, userClient } = await requireActiveUser(request);
    const requestBody = await request.json();
    previewId = typeof requestBody.previewId === 'string' ? requestBody.previewId : null;
    if (!previewId) return json({ error: 'previewId が必要です' }, 400);
    const { data: claim, error: claimError } = await userClient.rpc('claim_appsuite_sync_preview', { p_preview_id: previewId });
    if (claimError) return json({ error: claimError.message }, 409);
    const admin = adminClient();
    const snapshot = claim.snapshot as { records: AppsuiteRecord[]; missing_data_ids: string[] };
    const summary = claim.summary as { fetched: number; inserted: number; updated: number; unchanged: number; missing: number };
    const { data: run, error: runError } = await admin.from('appsuite_sync_run').insert({ app_id: claim.app_id, trigger_type: 'manual', status: 'running', triggered_by: user.id, fetched_count: summary.fetched, inserted_count: summary.inserted, updated_count: summary.updated, unchanged_count: summary.unchanged, missing_count: summary.missing }).select('appsuite_sync_run_id').single();
    if (runError) throw runError;
    runId = run.appsuite_sync_run_id;
    const now = new Date().toISOString();
    await upsertAppsuiteRecords(admin, snapshot.records, now);
    if (snapshot.missing_data_ids.length) {
      const { error: missingError } = await admin.from('appsuite_record').update({ is_present: false }).eq('app_id', claim.app_id).in('data_id', snapshot.missing_data_ids);
      if (missingError) throw missingError;
    }
    await admin.from('appsuite_application').update({ last_synced_at: now }).eq('app_id', claim.app_id);
    await admin.from('appsuite_sync_run').update({ status: 'succeeded', finished_at: now }).eq('appsuite_sync_run_id', run.appsuite_sync_run_id);
    await admin.from('appsuite_sync_preview').update({ status: 'applied', applied_at: now }).eq('appsuite_sync_preview_id', previewId);
    return json({ runId: run.appsuite_sync_run_id, summary });
  } catch (error) {
    const message = errorMessage(error);
    try {
      const admin = adminClient();
      if (runId) await admin.from('appsuite_sync_run').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message }).eq('appsuite_sync_run_id', runId);
      if (previewId) await admin.from('appsuite_sync_preview').update({ status: 'pending', error_message: message }).eq('appsuite_sync_preview_id', previewId).eq('status', 'applying');
    } catch (cleanupError) {
      console.error('AppSuite sync failure cleanup failed:', errorMessage(cleanupError));
    }
    return json({ error: message }, 500);
  }
});
