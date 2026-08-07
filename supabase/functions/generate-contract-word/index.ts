import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { adobeCorsHeaders, DOCX_MEDIA_TYPE, runAdobeJob, uploadAdobeAsset, adobeToken } from '../_shared/adobe-document-generation.ts';

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...adobeCorsHeaders, 'Content-Type': 'application/json' } });

function dataUrl(bytes: Uint8Array, mediaType: string) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mediaType};base64,${btoa(binary)}`;
}

/**
 * Document Generation text tags treat a plain newline in JSON as text, rather
 * than a Word line or paragraph break.  Contract clauses intentionally carry
 * manual line breaks from the approved source, so send the supported HTML
 * constructs instead.  A blank line is a paragraph boundary; a single line
 * break remains a Word line break.  Escaping first keeps customer-entered text
 * from being interpreted as arbitrary HTML.
 */
function contractTextToAdobeHtml(value: string | null | undefined) {
  const escaped = (value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  if (!escaped) return '';
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function normalizeText(value: string | null | undefined) {
  return (value ?? '').replace(/\r\n/g, '\n').trim();
}

const headerDateKeys = new Set(['contractStartDate', 'contractEndDate']);
const headerCurrencyKeys = new Set(['monthlyRentAmount', 'monthlyCommonChargeAmount', 'depositAmount', 'securityDepositAmount', 'keyMoneyAmount', 'guarantorLimitAmount']);

function formatHeaderValue(key: string, value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (headerDateKeys.has(key)) {
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return `${match[1]}年${match[2]}月${match[3]}日`;
  }
  if (headerCurrencyKeys.has(key)) {
    const amount = Number(text.replace(/,/g, ''));
    if (Number.isFinite(amount)) return new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 }).format(amount);
  }
  return text;
}

/**
 * The standard criteria remain as approved Word tables in the template.
 * Preserve contract-specific edits as a separate note instead of flattening
 * those tables into one long paragraph.  Prepending/appending a note is the
 * current form workflow; a replacement is retained in full so no saved text
 * is silently discarded until the form evolves into a structured table editor.
 */
function restorationNotes(currentValue: string | null | undefined, defaultValue: string | null | undefined) {
  const current = normalizeText(currentValue);
  const standard = normalizeText(defaultValue);
  if (!current || current === standard) return '';
  if (standard && current.endsWith(standard)) return current.slice(0, current.length - standard.length).trim();
  if (standard && current.startsWith(standard)) return current.slice(standard.length).trim();
  return `【フォームで確定した原状回復工事基準の変更内容】\n${current}`;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: adobeCorsHeaders });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);
  let stage = 'authenticate user';
  let failureContext: { documentId: string; templateRevisionId: string; contentVersion: number; userId: string } | null = null;
  let adminForFailure: ReturnType<typeof createClient> | null = null;
  try {
    const url = Deno.env.get('SUPABASE_URL')!; const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!; const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const { leaseContractId } = await request.json();
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return respond({ error: 'Unauthorized' }, 401);
    if (!leaseContractId) return respond({ error: 'leaseContractId is required.' }, 400);
    const admin = createClient(url, serviceKey); adminForFailure = admin;

    stage = 'load saved contract document';
    const { data: document, error: documentError } = await userClient.from('lease_contract_document')
      .select('lease_contract_document_id, document_type, contract_document_template_revision_id, content_version, field_values, terms_text, restoration_criteria_text')
      .eq('lease_contract_id', leaseContractId).single();
    if (documentError || !document?.contract_document_template_revision_id) return respond({ error: 'No saved contract document or template revision was found.' }, 400);
    failureContext = { documentId: document.lease_contract_document_id, templateRevisionId: document.contract_document_template_revision_id, contentVersion: document.content_version, userId: user.id };
    const { data: revision, error: revisionError } = await userClient.from('contract_document_template_revision')
      .select('generation_engine, template_docx_file_path, document_generation_schema, default_restoration_criteria_text').eq('contract_document_template_revision_id', document.contract_document_template_revision_id).single();
    if (revisionError || revision?.generation_engine !== 'document_generation' || !revision.template_docx_file_path) return respond({ error: 'A published Word document-generation template is required.' }, 400);

    stage = 'download Word template';
    const { data: template, error: templateError } = await admin.storage.from('contract-documents').download(revision.template_docx_file_path);
    if (templateError || !template) throw new Error(`Word template download failed: ${templateError?.message ?? 'not found'}`);

    stage = 'load plan snapshot';
    const { data: plans } = await userClient.from('lease_contract_document_plan').select('snapshot_file_path').eq('lease_contract_document_id', document.lease_contract_document_id).order('created_at').limit(1);
    let planImage = '';
    if (plans?.[0]?.snapshot_file_path) {
      const { data: snapshot, error: snapshotError } = await admin.storage.from('contract-documents').download(plans[0].snapshot_file_path);
      if (snapshotError || !snapshot) throw new Error(`Plan snapshot download failed: ${snapshotError?.message ?? 'not found'}`);
      const source = dataUrl(new Uint8Array(await snapshot.arrayBuffer()), 'image/png');
      // The DOCX template uses planImage as a standalone text tag. Adobe
      // Document Generation expands this HTML into an inline image, avoiding
      // any client-provided URL or image data.
      planImage = `<img src="${source}" width="620">`;
    }

    stage = 'generate Word document';
    const { token, clientId } = await adobeToken();
    const assetID = await uploadAdobeAsset(new Uint8Array(await template.arrayBuffer()), DOCX_MEDIA_TYPE, token, clientId);
    const fieldValues = Object.fromEntries(Object.entries((document.field_values ?? {}) as Record<string, unknown>)
      .map(([key, fieldValue]) => [key, formatHeaderValue(key, fieldValue)]));
    const mergeData = {
      ...fieldValues,
      // Use Document Generation's supported rich-text HTML so the layout of
      // the stored Japanese source (including explicit line/paragraph breaks)
      // survives in the generated DOCX and later formal PDF.
      termsText: contractTextToAdobeHtml(document.terms_text),
      restorationNotes: contractTextToAdobeHtml(restorationNotes(
        document.restoration_criteria_text,
        revision.default_restoration_criteria_text,
      )),
      planImage,
      hasPlan: Boolean(planImage),
      contentVersion: String(document.content_version),
    };
    const word = await runAdobeJob('documentgeneration', { assetID, outputFormat: 'docx', jsonDataForMerge: mergeData });

    stage = 'save Word output';
    const basePath = `documents/${leaseContractId}/${document.document_type}/${document.lease_contract_document_id}/outputs/v${document.content_version}`;
    const wordFilePath = `${basePath}/contract.docx`;
    const { error: uploadError } = await admin.storage.from('contract-documents').upload(wordFilePath, word, { contentType: DOCX_MEDIA_TYPE, upsert: true });
    if (uploadError) throw uploadError;
    const { data: output, error: outputError } = await admin.from('lease_contract_document_output_revision').upsert({
      lease_contract_document_id: document.lease_contract_document_id, contract_document_template_revision_id: document.contract_document_template_revision_id,
      content_version: document.content_version, status: 'word_generated', word_file_path: wordFilePath, error_summary: null, generated_by: user.id,
    }, { onConflict: 'lease_contract_document_id,content_version' }).select('lease_contract_document_output_revision_id').single();
    if (outputError || !output) throw new Error(`Word output history save failed: ${outputError?.message ?? 'unknown error'}`);
    await admin.from('lease_contract_document').update({ latest_word_output_revision_id: output.lease_contract_document_output_revision_id }).eq('lease_contract_document_id', document.lease_contract_document_id);
    return respond({ outputRevisionId: output.lease_contract_document_output_revision_id, wordFilePath, contentVersion: document.content_version, reused: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (failureContext && adminForFailure) {
      await adminForFailure.from('lease_contract_document_output_revision').upsert({
        lease_contract_document_id: failureContext.documentId, contract_document_template_revision_id: failureContext.templateRevisionId,
        content_version: failureContext.contentVersion, status: 'failed', error_summary: `${stage}: ${detail}`.slice(0, 4000), generated_by: failureContext.userId,
      }, { onConflict: 'lease_contract_document_id,content_version' });
    }
    console.error(JSON.stringify({ event: 'generate-contract-word-failed', stage, detail }));
    return respond({ error: `Word generation failed at ${stage}: ${detail}` }, 500);
  }
});
