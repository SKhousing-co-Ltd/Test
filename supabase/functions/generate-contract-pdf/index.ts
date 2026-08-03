import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const value = (input: unknown) => String(input ?? '').trim();
type Field = { key: string; label: string; required?: boolean; acroformFieldName?: string };
type BlockDefinitions = { terms?: { acroformFieldName?: string }; restoration?: { acroformFieldName?: string }; plan?: { page?: number; x?: number; y?: number; maxWidth?: number; maxHeight?: number } };

async function adobeToken() {
  const clientId = Deno.env.get('ADOBE_PDF_SERVICES_CLIENT_ID'); const clientSecret = Deno.env.get('ADOBE_PDF_SERVICES_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Adobe PDF Servicesの認証情報が設定されていません。');
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope: Deno.env.get('ADOBE_PDF_SERVICES_SCOPE') ?? 'openid,AdobeID,read_organizations' });
  const result = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const payload = await result.json(); if (!result.ok || !payload.access_token) throw new Error(`Adobe OAuthに失敗しました: ${payload.error_description ?? payload.error ?? result.status}`);
  return { token: payload.access_token as string, clientId };
}
async function adobeJson(url: string, token: string, clientId: string, init: RequestInit = {}) {
  const result = await fetch(url, { ...init, headers: { 'x-api-key': clientId, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const payload = await result.json(); if (!result.ok) throw new Error(`Adobe PDF Servicesの要求に失敗しました: ${payload?.error?.message ?? payload?.message ?? result.status}`); return payload;
}
async function uploadAdobeAsset(bytes: Uint8Array, token: string, clientId: string) {
  const asset = await adobeJson('https://pdf-services.adobe.io/assets', token, clientId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'application/pdf' }) });
  const upload = await fetch(asset.uploadUri, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes }); if (!upload.ok) throw new Error('Adobeへのひな型PDFアップロードに失敗しました。'); return asset.assetID as string;
}
async function downloadAdobeAsset(assetId: string, token: string, clientId: string) {
  const asset = await adobeJson(`https://pdf-services.adobe.io/assets/${assetId}`, token, clientId); const result = await fetch(asset.downloadUri); if (!result.ok) throw new Error('Adobe生成PDFのダウンロードに失敗しました。'); return new Uint8Array(await result.arrayBuffer());
}
async function importFormData(template: Uint8Array, fields: Record<string, string>) {
  const { token, clientId } = await adobeToken(); const assetID = await uploadAdobeAsset(template, token, clientId);
  const started = await adobeJson('https://pdf-services.adobe.io/operation/setformdata', token, clientId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetID, jsonFormFieldsData: fields }) });
  let job = started; const location = started.location ?? started.statusUri; for (let i = 0; location && !job.assetID && i < 30; i += 1) { await new Promise((resolve) => setTimeout(resolve, 1000)); job = await adobeJson(location, token, clientId); if (job.status === 'failed') throw new Error(`Adobe PDF生成に失敗しました: ${job.error?.message ?? ''}`); }
  const outputAssetId = job.assetID ?? job.output?.assetID ?? job.result?.assetID; if (!outputAssetId) throw new Error('Adobe PDF生成の完了結果を取得できませんでした。'); return downloadAdobeAsset(outputAssetId, token, clientId);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders }); if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL')!; const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!; const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; const auth = request.headers.get('Authorization') ?? '';
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } }); const { data: { user } } = await userClient.auth.getUser(); if (!user) return response({ error: 'Unauthorized' }, 401);
    const { leaseContractId } = await request.json(); if (!value(leaseContractId)) return response({ error: 'leaseContractId は必須です。' }, 400);
    const { data: document, error: documentError } = await userClient.from('lease_contract_document').select('lease_contract_document_id, document_type, contract_document_template_revision_id, field_values, terms_text, restoration_criteria_text').eq('lease_contract_id', leaseContractId).single();
    if (documentError || !document?.contract_document_template_revision_id) return response({ error: '契約書データまたはひな型版がありません。' }, 400);
    const { data: revision, error: revisionError } = await userClient.from('contract_document_template_revision').select('template_file_path, field_definitions, block_definitions').eq('contract_document_template_revision_id', document.contract_document_template_revision_id).single();
    if (revisionError || !revision?.template_file_path) return response({ error: 'AcroFormひな型が登録されていません。' }, 400);
    const formFields: Record<string, string> = {}; for (const field of (revision.field_definitions ?? []) as Field[]) { const fieldName = field.acroformFieldName ?? field.key; const fieldValue = value((document.field_values as Record<string, unknown>)[field.key]); if (field.required && !fieldValue) return response({ error: `必須項目「${field.label}」を入力してください。` }, 400); formFields[fieldName] = fieldValue; }
    const blocks = (revision.block_definitions ?? {}) as BlockDefinitions; if (blocks.terms?.acroformFieldName) formFields[blocks.terms.acroformFieldName] = document.terms_text ?? ''; if (blocks.restoration?.acroformFieldName) formFields[blocks.restoration.acroformFieldName] = document.restoration_criteria_text ?? '';
    const admin = createClient(url, serviceKey); const { data: template, error: templateError } = await admin.storage.from('contract-documents').download(revision.template_file_path); if (templateError || !template) throw new Error(`ひな型PDFを取得できませんでした: ${templateError?.message ?? ''}`);
    let output = await importFormData(new Uint8Array(await template.arrayBuffer()), formFields);
    const { data: plans } = await userClient.from('lease_contract_document_plan').select('snapshot_file_path').eq('lease_contract_document_id', document.lease_contract_document_id).order('created_at').limit(1);
    const placement = blocks.plan; if (plans?.[0] && placement?.page && placement.maxWidth && placement.maxHeight) { const { data: snapshot } = await admin.storage.from('contract-documents').download(plans[0].snapshot_file_path); if (snapshot) { const pdf = await PDFDocument.load(output); const page = pdf.getPages()[placement.page - 1]; if (!page) throw new Error('対象箇所図の配置ページがひな型にありません。'); const image = await pdf.embedPng(new Uint8Array(await snapshot.arrayBuffer())); const scale = Math.min(placement.maxWidth / image.width, placement.maxHeight / image.height); page.drawImage(image, { x: placement.x ?? 0, y: placement.y ?? 0, width: image.width * scale, height: image.height * scale }); output = await pdf.save(); } }
    const path = `documents/${leaseContractId}/${document.document_type}/${document.lease_contract_document_id}/${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`; const { error: uploadError } = await admin.storage.from('contract-documents').upload(path, output, { contentType: 'application/pdf', upsert: false }); if (uploadError) throw uploadError;
    const generatedAt = new Date().toISOString(); await admin.from('lease_contract_document').update({ pdf_file_path: path, pdf_generated_at: generatedAt }).eq('lease_contract_document_id', document.lease_contract_document_id); return response({ pdfFilePath: path, generatedAt });
  } catch (error) { return response({ error: `契約書PDFを生成できませんでした: ${error instanceof Error ? error.message : String(error)}` }, 500); }
});
