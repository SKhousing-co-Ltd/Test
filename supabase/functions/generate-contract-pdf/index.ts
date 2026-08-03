// Pin the module because esm.sh's moving @2 tag can temporarily resolve to an
// unavailable package build while Supabase bundles an Edge Function.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const value = (input: unknown) => String(input ?? '').trim();
type Field = { key: string; label: string; required?: boolean; acroformFieldName?: string };
type BlockDefinitions = { terms?: { acroformFieldName?: string }; restoration?: { acroformFieldName?: string }; plan?: { page?: number; x?: number; y?: number; maxWidth?: number; maxHeight?: number } };
type AdobeJob = { status?: string; assetID?: string; asset?: { assetID?: string }; output?: { assetID?: string }; result?: { assetID?: string }; error?: unknown; errors?: unknown };

function adobeJobFailureDetail(job: AdobeJob) {
  // Adobe's asynchronous endpoint does not consistently use error.message.
  // Keep the diagnostic limited to status/error fields so no contract payload
  // or temporary asset identifier is exposed in the client response or logs.
  return JSON.stringify({ status: job.status ?? null, error: job.error ?? null, errors: job.errors ?? null });
}

async function adobeToken() {
  const clientId = Deno.env.get('ADOBE_PDF_SERVICES_CLIENT_ID');
  const clientSecret = Deno.env.get('ADOBE_PDF_SERVICES_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Adobe credentials are not configured.');
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  const result = await fetch('https://pdf-services.adobe.io/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const payload = await result.json();
  if (!result.ok || !payload.access_token) throw new Error(`Adobe OAuth failed: ${payload.error_description ?? payload.error ?? result.status}`);
  return { token: payload.access_token as string, clientId };
}

async function adobeJson(url: string, token: string, clientId: string, init: RequestInit = {}) {
  const result = await fetch(url, { ...init, headers: { 'x-api-key': clientId, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const text = await result.text(); let payload: Record<string, unknown> = {};
  if (text) { try { payload = JSON.parse(text) as Record<string, unknown>; } catch { payload = { message: text }; } }
  if (!result.ok) throw new Error(`Adobe API failed: ${String((payload.error as Record<string, unknown> | undefined)?.message ?? payload.message ?? result.status)}`);
  return payload;
}

async function uploadAdobeAsset(bytes: Uint8Array, token: string, clientId: string) {
  const asset = await adobeJson('https://pdf-services.adobe.io/assets', token, clientId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'application/pdf' }) });
  const upload = await fetch(asset.uploadUri as string, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
  if (!upload.ok) throw new Error(`Adobe asset upload failed: ${upload.status}`);
  return asset.assetID as string;
}

async function importFormData(template: Uint8Array, fields: Record<string, string>) {
  const { token, clientId } = await adobeToken();
  const assetID = await uploadAdobeAsset(template, token, clientId);
  const result = await fetch('https://pdf-services.adobe.io/operation/setformdata', { method: 'POST', headers: { 'x-api-key': clientId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ assetID, jsonFormFieldsData: fields }) });
  const startText = await result.text(); let started: AdobeJob = {};
  if (startText) { try { started = JSON.parse(startText) as AdobeJob; } catch { started = { error: { message: startText } }; } }
  if (!result.ok) throw new Error(`Adobe form import failed: ${adobeJobFailureDetail(started)}`);
  const location = result.headers.get('location');
  if (!location) throw new Error('Adobe form import did not return a job location.');
  let job = started;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const outputAssetId = job.assetID ?? job.asset?.assetID ?? job.output?.assetID ?? job.result?.assetID;
    if (outputAssetId) {
      const asset = await adobeJson(`https://pdf-services.adobe.io/assets/${outputAssetId}`, token, clientId);
      const download = await fetch(asset.downloadUri as string);
      if (!download.ok) throw new Error(`Adobe output download failed: ${download.status}`);
      return new Uint8Array(await download.arrayBuffer());
    }
    if (job.status === 'failed') throw new Error(`Adobe form import job failed: ${adobeJobFailureDetail(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    job = await adobeJson(location, token, clientId) as AdobeJob;
  }
  throw new Error('Adobe form import timed out.');
}

async function diagnoseFormData(template: Uint8Array, fields: Record<string, string>, blocks: BlockDefinitions, smokeTemplate?: Uint8Array) {
  const longFieldNames = [blocks.terms?.acroformFieldName, blocks.restoration?.acroformFieldName].filter((name): name is string => Boolean(name));
  const headings = Object.fromEntries(Object.entries(fields).filter(([name]) => !longFieldNames.includes(name)));
  const groups = [
    ['headings', headings],
    ...longFieldNames.map((name) => [`${name} (${[...fields[name] ?? ''].length} chars)`, { [name]: fields[name] ?? '' }] as const),
  ] as const;
  const results: Array<{ group: string; ok: boolean; error?: string }> = [];
  for (const [group, values] of groups) {
    try {
      await importFormData(template, values);
      results.push({ group, ok: true });
    } catch (error) {
      results.push({ group, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  try {
    if (!smokeTemplate) throw new Error('Standard AcroForm smoke template is not available.');
    await importFormData(smokeTemplate, { smoke: 'PDF Services smoke test' });
    results.push({ group: 'standard AcroForm smoke test', ok: true });
  } catch (error) {
    results.push({ group: 'standard AcroForm smoke test', ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return results;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  let stage = 'authenticate user';
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const auth = request.headers.get('Authorization') ?? '';
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return response({ error: 'Unauthorized' }, 401);
    const { leaseContractId } = await request.json();
    if (!value(leaseContractId)) return response({ error: 'leaseContractId is required.' }, 400);

    stage = 'load saved contract document';
    const { data: document, error: documentError } = await userClient.from('lease_contract_document').select('lease_contract_document_id, document_type, contract_document_template_revision_id, field_values, terms_text, restoration_criteria_text').eq('lease_contract_id', leaseContractId).single();
    if (documentError || !document?.contract_document_template_revision_id) return response({ error: 'No saved contract document or template revision was found.' }, 400);
    const { data: revision, error: revisionError } = await userClient.from('contract_document_template_revision').select('template_file_path, field_definitions, block_definitions').eq('contract_document_template_revision_id', document.contract_document_template_revision_id).single();
    if (revisionError || !revision?.template_file_path) return response({ error: 'No AcroForm PDF template was found.' }, 400);

    stage = 'validate AcroForm values';
    const formFields: Record<string, string> = {};
    for (const field of (revision.field_definitions ?? []) as Field[]) {
      const fieldName = field.acroformFieldName ?? field.key;
      const fieldValue = value((document.field_values as Record<string, unknown>)[field.key]);
      if (field.required && !fieldValue) return response({ error: `Required field is empty: ${field.label}` }, 400);
      formFields[fieldName] = fieldValue;
    }
    const blocks = (revision.block_definitions ?? {}) as BlockDefinitions;
    if (blocks.terms?.acroformFieldName) formFields[blocks.terms.acroformFieldName] = document.terms_text ?? '';
    if (blocks.restoration?.acroformFieldName) formFields[blocks.restoration.acroformFieldName] = document.restoration_criteria_text ?? '';

    stage = 'download template from storage';
    const admin = createClient(url, serviceKey);
    const { data: template, error: templateError } = await admin.storage.from('contract-documents').download(revision.template_file_path);
    if (templateError || !template) throw new Error(`Template download failed: ${templateError?.message ?? 'not found'}`);
    stage = 'fill Adobe AcroForm';
    const templateBytes = new Uint8Array(await template.arrayBuffer());
    let output: Uint8Array;
    try {
      output = await importFormData(templateBytes, formFields);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!detail.includes('Adobe form import')) throw error;
      const { data: smokeTemplate } = await admin.storage.from('contract-documents').download('templates/_diagnostics/adobe-form-smoke.pdf');
      const smokeBytes = smokeTemplate ? new Uint8Array(await smokeTemplate.arrayBuffer()) : undefined;
      const diagnostics = await diagnoseFormData(templateBytes, formFields, blocks, smokeBytes);
      throw new Error(`${detail}; field diagnostics=${JSON.stringify(diagnostics)}`);
    }

    stage = 'attach plan snapshot';
    const { data: plans } = await userClient.from('lease_contract_document_plan').select('snapshot_file_path').eq('lease_contract_document_id', document.lease_contract_document_id).order('created_at').limit(1);
    const placement = blocks.plan;
    if (plans?.[0] && placement?.page && placement.maxWidth && placement.maxHeight) {
      const { data: snapshot } = await admin.storage.from('contract-documents').download(plans[0].snapshot_file_path);
      if (snapshot) {
        const pdf = await PDFDocument.load(output); const page = pdf.getPages()[placement.page - 1];
        if (!page) throw new Error('Configured plan page is not available in the generated PDF.');
        const image = await pdf.embedPng(new Uint8Array(await snapshot.arrayBuffer())); const scale = Math.min(placement.maxWidth / image.width, placement.maxHeight / image.height);
        page.drawImage(image, { x: placement.x ?? 0, y: placement.y ?? 0, width: image.width * scale, height: image.height * scale }); output = await pdf.save();
      }
    }
    stage = 'save generated PDF to storage';
    const path = `documents/${leaseContractId}/${document.document_type}/${document.lease_contract_document_id}/${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;
    const { error: uploadError } = await admin.storage.from('contract-documents').upload(path, output, { contentType: 'application/pdf', upsert: false });
    if (uploadError) throw uploadError;
    const generatedAt = new Date().toISOString();
    await admin.from('lease_contract_document').update({ pdf_file_path: path, pdf_generated_at: generatedAt }).eq('lease_contract_document_id', document.lease_contract_document_id);
    return response({ pdfFilePath: path, generatedAt });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'generate-contract-pdf-failed', stage, detail }));
    return response({ error: `PDF generation failed at ${stage}: ${detail}` }, 500);
  }
});
