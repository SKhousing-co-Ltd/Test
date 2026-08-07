// Pin the module because esm.sh's moving @2 tag can temporarily resolve to an
// unavailable package build while Supabase bundles an Edge Function.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { PDFDocument, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const value = (input: unknown) => String(input ?? '').trim();
const headerDateKeys = new Set(['contractStartDate', 'contractEndDate']);
const headerCurrencyKeys = new Set(['monthlyRentAmount', 'monthlyCommonChargeAmount', 'depositAmount', 'securityDepositAmount', 'keyMoneyAmount', 'guarantorLimitAmount']);
function formatHeaderValue(key: string, input: unknown) {
  const text = value(input);
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
type Field = { key: string; label: string; required?: boolean; acroformFieldName?: string };
type BlockDefinitions = {
  // Long-text fields must be painted page by page.  A single AcroForm value
  // is shared by all of its widgets, so putting a long clause into the field
  // itself repeats the entire clause on every page.  `pageNumbers` is an
  // optional one-based mapping for templates whose widgets do not expose /P.
  // `renderInPdf: false` is retained as an explicit opt-out only.
  terms?: { acroformFieldName?: string; renderInPdf?: boolean; pageNumbers?: number[] };
  restoration?: { acroformFieldName?: string; renderInPdf?: boolean; pageNumbers?: number[] };
  plan?: { page?: number; x?: number; y?: number; maxWidth?: number; maxHeight?: number };
};
type TextBlock = { fieldName: string; text: string; pageNumbers?: number[] };
type TextBox = { pageIndex: number; x: number; y: number; width: number; height: number };
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

function wrapText(text: string, font: any, size: number, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    let lineWidth = 0;
    for (const character of Array.from(paragraph)) {
      // Measuring the accumulated string for every character makes a 10,000
      // character clause quadratic and exhausts an Edge Function.  PDF text
      // widths are additive for the embedded Japanese font, so keep a running
      // width and make this operation linear.
      const characterWidth = font.widthOfTextAtSize(character, size);
      if (line && lineWidth + characterWidth > maxWidth) {
        lines.push(line);
        line = character;
        lineWidth = characterWidth;
      } else {
        line += character;
        lineWidth += characterWidth;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

async function renderContractValues(input: Uint8Array, fields: Record<string, string>, blocks: TextBlock[], fontBytes: Uint8Array) {
  const pdf = await PDFDocument.load(input);
  pdf.registerFontkit(fontkit);
  // A subset contains only contract glyphs and keeps the Edge Function below
  // its memory/output limits while still embedding every used Japanese glyph.
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const form = pdf.getForm();
  const pages = pdf.getPages();

  for (const [name, fieldValue] of Object.entries(fields)) {
    try {
      const field = form.getTextField(name);
      field.setText(fieldValue);
      field.updateAppearances(font);
    } catch (error) {
      throw new Error(`Cannot render field ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const block of blocks) {
    let field: any;
    let widgets: any[];
    let boxes: TextBox[];
    try {
      field = form.getTextField(block.fieldName) as any;
      widgets = field.acroField.getWidgets() as any[];
      boxes = widgets.map((widget, widgetIndex) => {
        // Do not read widget /P here.  This legacy document has orphaned and
        // malformed references which cause pdf-lib's "Unexpected N type"
        // failure.  The registered order is deterministic for this revision.
        const pageNumber = block.pageNumbers?.[widgetIndex]
          ?? (block.fieldName === 'termsText' ? widgetIndex + 1 : block.fieldName === 'restorationCriteriaText' ? 8 : undefined);
        const pageIndex = pageNumber === undefined ? -1 : pageNumber - 1;
        if (pageIndex < 0) throw new Error(`Cannot locate PDF page for ${block.fieldName}.`);
        return { pageIndex, ...widget.getRectangle() };
      }).sort((left: TextBox, right: TextBox) => left.pageIndex - right.pageIndex);
    } catch (error) {
      throw new Error(`Cannot read block ${block.fieldName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (boxes.length === 0) throw new Error(`No PDF drawing area is configured for ${block.fieldName}.`);

    // A shared AcroForm field renders one value into every widget.  Keep the
    // widgets empty and paint consecutive text segments onto the pages below;
    // hiding annotations is not reliable across PDF viewers.
    try {
      field.setText('');
      field.updateAppearances(font);
    } catch (error) {
      throw new Error(`Cannot clear block ${block.fieldName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const narrowestWidth = Math.max(1, Math.min(...boxes.map((box) => box.width - 8)));
    let lines: string[] = [];
    let usedSize = 0;
    for (let size = 10; size >= 6; size -= 1) {
      const candidateLines = wrapText(block.text, font, size, narrowestWidth);
      const lineHeight = size * 1.32;
      const capacity = boxes.reduce((total, box) => total + Math.max(1, Math.floor((box.height - 8) / lineHeight)), 0);
      if (candidateLines.length <= capacity) { usedSize = size; lines = candidateLines; break; }
    }
    if (!usedSize) throw new Error(`${block.fieldName} is too long for the configured PDF areas.`);

    for (const box of boxes) {
      const page = pages[box.pageIndex];
      const lineHeight = usedSize * 1.32;
      const capacity = Math.max(1, Math.floor((box.height - 8) / lineHeight));
      const segment = lines.splice(0, capacity);
      page.drawRectangle({ x: box.x, y: box.y, width: box.width, height: box.height, color: rgb(1, 1, 1) });
      for (const [index, line] of segment.entries()) {
        page.drawText(line, { x: box.x + 4, y: box.y + box.height - 4 - usedSize - (index * lineHeight), size: usedSize, font, color: rgb(0, 0, 0) });
      }
    }
  }
  // Do not flatten this legacy template.  Its AcroForm resource tree contains
  // incomplete indirect references, which pdf-lib cannot flatten reliably
  // (`Unexpected N type: undefined`).  Header appearances are already updated
  // with the embedded Japanese font, and legacy long-text fields remain empty.
  return new Uint8Array(await pdf.save());
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
    const { leaseContractId } = await request.json();
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return response({ error: 'Unauthorized' }, 401);
    const admin = createClient(url, serviceKey);
    if (!value(leaseContractId)) return response({ error: 'leaseContractId is required.' }, 400);

    stage = 'load saved contract document';
    const { data: document, error: documentError } = await userClient.from('lease_contract_document').select('lease_contract_document_id, document_type, contract_document_template_revision_id, field_values, terms_text, restoration_criteria_text').eq('lease_contract_id', leaseContractId).single();
    if (documentError || !document?.contract_document_template_revision_id) return response({ error: 'No saved contract document or template revision was found.' }, 400);
    const { data: revision, error: revisionError } = await userClient.from('contract_document_template_revision').select('template_file_path, font_file_path, field_definitions, block_definitions').eq('contract_document_template_revision_id', document.contract_document_template_revision_id).single();
    if (revisionError || !revision?.template_file_path) return response({ error: 'No AcroForm PDF template was found.' }, 400);

    stage = 'validate AcroForm values';
    const formFields: Record<string, string> = {};
    for (const field of (revision.field_definitions ?? []) as Field[]) {
      const fieldName = field.acroformFieldName ?? field.key;
      const fieldValue = formatHeaderValue(field.key, (document.field_values as Record<string, unknown>)[field.key]);
      if (field.required && !fieldValue) return response({ error: `Required field is empty: ${field.label}` }, 400);
      formFields[fieldName] = fieldValue;
    }
    const blocks = (revision.block_definitions ?? {}) as BlockDefinitions;
    const textBlocks: TextBlock[] = [];
    // Render long text by default when the template declares a target field.
    // This is intentionally different from writing the form value itself:
    // the renderer clears the shared AcroForm value and paints each page
    // segment into its own rectangle, preventing duplicate text on every page.
    if (blocks.terms?.acroformFieldName && blocks.terms.renderInPdf !== false) textBlocks.push({ fieldName: blocks.terms.acroformFieldName, text: document.terms_text ?? '', pageNumbers: blocks.terms.pageNumbers });
    if (blocks.restoration?.acroformFieldName && blocks.restoration.renderInPdf !== false) textBlocks.push({ fieldName: blocks.restoration.acroformFieldName, text: document.restoration_criteria_text ?? '', pageNumbers: blocks.restoration.pageNumbers });

    stage = 'download template from storage';
    const { data: template, error: templateError } = await admin.storage.from('contract-documents').download(revision.template_file_path);
    if (templateError || !template) throw new Error(`Template download failed: ${templateError?.message ?? 'not found'}`);
    stage = 'fill Adobe AcroForm';
    const templateBytes = new Uint8Array(await template.arrayBuffer());
    let output: Uint8Array;
    // Adobe's hosted renderer cannot resolve Japanese glyphs in this legacy
    // template.  It creates the AcroForm PDF first; values are rendered below
    // with the embedded Japanese font kept in private Storage.
    output = await importFormData(templateBytes, {});

    stage = 'render contract values with embedded Japanese font';
    const fontPath = revision.font_file_path || 'templates/ordinary_lease/yumin.ttf';
    const { data: fontFile, error: fontError } = await admin.storage.from('contract-documents').download(fontPath);
    if (fontError || !fontFile) throw new Error(`Japanese font download failed: ${fontError?.message ?? 'not found'}`);
    const fontBytes = new Uint8Array(await fontFile.arrayBuffer());
    stage = 'render contract values';
    output = await renderContractValues(output, formFields, textBlocks, fontBytes);

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
