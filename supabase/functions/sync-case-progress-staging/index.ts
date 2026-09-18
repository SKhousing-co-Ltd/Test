import { createClient } from 'npm:@supabase/supabase-js@2.110.1';
import { normalizeRows, validateHeaders } from './logic.ts';

const EXPECTED_SPREADSHEET_ID = '1NgMHz3krxkEb8Lz13-9VcrPwgfKEnFyBi3cEodFQLs8';
const EXPECTED_SHEET_NAME = '案件シート';
const EXPECTED_TIME_ZONE = 'Asia/Tokyo';
const SOURCE_SYSTEM = 'google_sheets';
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-case-progress-sync-secret',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

type TriggerType = 'scheduled' | 'manual';
type ClientError = { code?: unknown; message?: unknown };
type Payload = {
  sourceSystem?: unknown;
  spreadsheetId?: unknown;
  sheetName?: unknown;
  spreadsheetTimeZone?: unknown;
  triggerType?: unknown;
  clientError?: ClientError | null;
  headers?: unknown;
  rows?: unknown;
};

function safeEqual(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  let difference = actualBytes.length ^ expectedBytes.length;
  const length = Math.max(actualBytes.length, expectedBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function adminClient() {
  const serviceRoleKey = Deno.env.get('CASE_PROGRESS_SYNC_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!serviceRoleKey || !supabaseUrl) throw new Error('Supabase server credentials are not configured');
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
}

async function failRun(admin: ReturnType<typeof adminClient>, runId: string, message: string, errorCount = 1) {
  const { error } = await admin.from('case_progress_sync_runs').update({
    status: 'failed',
    completed_at: new Date().toISOString(),
    error_count: errorCount,
    error_message: message.slice(0, 1000),
  }).eq('case_progress_sync_run_id', runId).eq('status', 'running');
  if (error) console.error('Failed to update sync run', error.message);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('CASE_PROGRESS_SYNC_SECRET');
  if (!expectedSecret || !safeEqual(request.headers.get('x-case-progress-sync-secret'), expectedSecret)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH) {
    return json({ error: 'Payload is too large' }, 413);
  }

  let body: Payload;
  try {
    body = await request.json() as Payload;
  } catch {
    return json({ error: 'Invalid JSON payload' }, 400);
  }

  const triggerType: TriggerType | null = body.triggerType === 'manual' || body.triggerType === 'scheduled'
    ? body.triggerType
    : null;
  if (!triggerType) return json({ error: 'triggerType must be manual or scheduled' }, 400);

  const admin = adminClient();
  const { data: run, error: runError } = await admin.from('case_progress_sync_runs').insert({
    source_system: SOURCE_SYSTEM,
    spreadsheet_id: EXPECTED_SPREADSHEET_ID,
    sheet_name: EXPECTED_SHEET_NAME,
    trigger_type: triggerType,
    status: 'running',
    source_row_count: Array.isArray(body.rows) ? body.rows.length : 0,
  }).select('case_progress_sync_run_id').single();
  if (runError) return json({ error: 'Could not create sync run' }, 500);
  const runId = run.case_progress_sync_run_id as string;

  try {
    if (body.sourceSystem !== SOURCE_SYSTEM || body.spreadsheetId !== EXPECTED_SPREADSHEET_ID || body.sheetName !== EXPECTED_SHEET_NAME) {
      throw new Error('Payload source does not match the configured spreadsheet');
    }
    if (body.spreadsheetTimeZone !== EXPECTED_TIME_ZONE) {
      throw new Error(`Spreadsheet time zone must be ${EXPECTED_TIME_ZONE}`);
    }
    if (body.clientError) {
      const code = typeof body.clientError.code === 'string' ? body.clientError.code : 'CLIENT_ERROR';
      const message = typeof body.clientError.message === 'string' ? body.clientError.message : 'Apps Script reported an error';
      throw new Error(`${code}: ${message}`);
    }

    const headerResult = validateHeaders(body.headers);
    if (headerResult.missing.length) throw new Error(`Missing required headers: ${headerResult.missing.join(', ')}`);
    if (headerResult.duplicates.length) throw new Error(`Duplicate headers: ${headerResult.duplicates.join(', ')}`);

    const rows = await normalizeRows(body.rows);
    const syncedAt = new Date().toISOString();
    const { data: result, error: applyError } = await admin.rpc('apply_case_progress_sync', {
      p_sync_run_id: runId,
      p_source_system: SOURCE_SYSTEM,
      p_spreadsheet_id: EXPECTED_SPREADSHEET_ID,
      p_sheet_name: EXPECTED_SHEET_NAME,
      p_synced_at: syncedAt,
      p_rows: rows,
    });
    if (applyError) throw applyError;
    return json(result);
  } catch (error) {
    const message = safeMessage(error);
    await failRun(admin, runId, message);
    const status = /duplicate source/.test(message)
      ? 409
      : /Missing required|Duplicate headers|must be|does not match|CLIENT_ERROR|every row|displayValues|typedValues/.test(message)
        ? 400
        : 500;
    return json({ runId, error: message }, status);
  }
});
