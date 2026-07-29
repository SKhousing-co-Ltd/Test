import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const TEMPLATE_PATH = 'templates/ordinary_lease/loan-room-lease-2025-06-02-source-refresh.pdf';
const FONT_PATH = 'templates/ordinary_lease/yumin.ttf';
const A4_WIDTH = 595.25;
const A4_HEIGHT = 841.89;
type Values = Record<string, unknown>;

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
function text(value: unknown) { return String(value ?? '').trim(); }
function yen(value: unknown) { const number = Number(value); return Number.isFinite(number) && text(value) !== '' ? `${Math.round(number).toLocaleString('ja-JP')}円` : ''; }
function sqm(value: unknown) { const number = Number(value); return Number.isFinite(number) && text(value) !== '' ? `${number.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}` : ''; }
function tsubo(value: unknown) { const number = Number(value); return Number.isFinite(number) && text(value) !== '' ? (number / 3.305785).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''; }
function japaneseDate(value: unknown) { const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})$/); return match ? `${match[1]}年${match[2]}月${match[3]}日` : text(value); }

function draw(page: any, font: any, value: unknown, x: number, y: number, size = 10, maxWidth?: number) {
  const content = text(value); if (!content) return;
  page.drawText(content, { x, y, size, font, color: rgb(0, 0, 0), maxWidth, lineHeight: size * 1.3 });
}
// ひな型の罫線は残し、既存のプレースホルダ文字だけを隠す。セル全体を塗りつぶさない。
function clear(page: any, x: number, y: number, width: number, height: number) { const insetX = 2; const textHeight = Math.min(10, Math.max(0, height - 8)); const textY = y + (height - textHeight) / 2; page.drawRectangle({ x: x + insetX, y: textY, width: Math.max(0, width - insetX * 2), height: textHeight, color: rgb(1, 1, 1) }); }
function clearBlock(page: any, x: number, y: number, width: number, height: number) { page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1) }); }

async function loadPrivateFile(admin: ReturnType<typeof createClient>, path: string, label: string) {
  const { data, error } = await admin.storage.from('contract-documents').download(path);
  if (error || !data) throw new Error(`${label}をStorageから取得できませんでした: ${error?.message ?? ''}`);
  return new Uint8Array(await data.arrayBuffer());
}

async function splitTemplate(templateBytes: Uint8Array) {
  const source = await PDFDocument.load(templateBytes);
  if (source.getPageCount() !== 9) throw new Error(`ひな型PDFは見開き9枚である必要があります（現在 ${source.getPageCount()} 枚）。`);
  const output = await PDFDocument.create();
  for (let index = 0; index < source.getPageCount(); index += 1) {
    const sourcePage = source.getPage(index);
    const { width, height } = sourcePage.getSize();
    if (width / height < 1.3) throw new Error(`ひな型の${index + 1}枚目が見開き形式ではありません。`);
    for (const side of [0, 1]) {
      const embedded = await output.embedPage(sourcePage, { left: width / 2 * side, right: width / 2 * (side + 1), bottom: 0, top: height });
      const page = output.addPage([A4_WIDTH, A4_HEIGHT]);
      page.drawPage(embedded, { x: 0, y: 0, width: A4_WIDTH, height: A4_HEIGHT });
    }
  }
  return output;
}

function populateTemplate(pdf: PDFDocument, font: any, values: Values, planSnapshot?: Uint8Array) {
  const tenant = text(values.tenantName);
  const pages = pdf.getPages();
  if (pages.length !== 18) throw new Error(`分割後のページ数が18ではありません（${pages.length}ページ）。`);
  const cover = pages[0]; const head = pages[1]; // 元PDFの最初の見開き右側（2ページ）
  // 冒頭の「〇〇」、頭書、賃借人署名欄を同一の契約者名で置換する。
  clear(cover, 250, 185, 250, 26); draw(cover, font, tenant, 261, 199, 12, 220);
  clearBlock(head, 30, 668, 535, 50); draw(head, font, `賃貸人 ＳＫハウジング株式会社と、賃借人 ${tenant} との間に、貸室に関する賃貸借契約`, 40, 696, 8.2, 520); draw(head, font, '（以下「本契約」という）を次のとおり締結する。', 40, 678, 8.2, 520);
  clear(head, 205, 582, 285, 20); draw(head, font, tenant, 208, 592, 10, 175);
  clear(head, 205, 556, 285, 20); draw(head, font, `${text(values.guarantorName)}${text(values.guarantorLimitAmount) ? `（極度額 ${yen(values.guarantorLimitAmount)}を上限とする）` : ''}`, 208, 566, 9, 265);
  clear(head, 205, 530, 285, 20); draw(head, font, values.propertyName, 208, 540, 10, 175);
  clear(head, 205, 504, 285, 20); draw(head, font, values.propertyLotAddress, 208, 514, 9, 175);
  clear(head, 205, 478, 285, 20); draw(head, font, values.propertyAddress, 208, 488, 9, 175);
  clear(head, 205, 448, 285, 28); draw(head, font, `${text(values.buildingStructure)}　延床面積 ${sqm(values.buildingGrossAreaSqm)}㎡`, 208, 464, 8.5, 265);
  clear(head, 205, 412, 285, 22); draw(head, font, `${text(values.floorLabel)}階　${sqm(values.leasedAreaSqm)}㎡（${tsubo(values.leasedAreaSqm)}坪）`, 208, 423, 9, 265);
  clear(head, 205, 378, 285, 20); draw(head, font, values.usePurpose, 225, 389, 9.5, 190);
  clear(head, 205, 350, 285, 22); draw(head, font, `${japaneseDate(values.contractStartDate)}から${japaneseDate(values.contractEndDate)}まで`, 208, 358, 8.6, 275);
  clear(head, 205, 304, 285, 21); draw(head, font, yen(values.monthlyRentAmount), 238, 315, 10, 80);
  clear(head, 205, 278, 285, 21); draw(head, font, values.rentPaymentDue, 208, 289, 8.5, 195);
  clear(head, 205, 252, 285, 21); draw(head, font, values.dailyCalculationMethod, 208, 263, 8, 220);
  clear(head, 205, 226, 285, 21); draw(head, font, `金 ${yen(values.depositAmount)}（月額賃料 ${text(values.depositMonths)}ヶ月分）`, 208, 237, 9, 265);
  clear(head, 205, 35, 285, 150); draw(head, font, values.specialProvisions, 208, 160, 8.5, 175);

  const signature = pages[12]; // 13ページ左側
  clear(signature, 175, 684, 130, 24); draw(signature, font, japaneseDate(values.contractStartDate), 182, 696, 10, 130);
  draw(signature, font, tenant, 226, 530, 10, 160);
  draw(signature, font, values.tenantSignerName, 226, 506, 9, 160);
  draw(signature, font, values.guarantorName, 206, 374, 10, 180);
  draw(signature, font, values.brokerName, 206, 266, 10, 180);

  const planPage = pages[13]; // 14ページ右側
  clear(planPage, 45, 709, 210, 25); draw(planPage, font, `${text(values.floorLabel)}階　${sqm(values.leasedAreaSqm)}㎡（${tsubo(values.leasedAreaSqm)}坪）`, 50, 722, 9, 200);
  if (!planSnapshot) return Promise.resolve();
  return pdf.embedPng(planSnapshot).then((image) => {
    const maxWidth = 500; const maxHeight = 560; const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
    const width = image.width * scale; const height = image.height * scale;
    planPage.drawImage(image, { x: (A4_WIDTH - width) / 2, y: 125 + (maxHeight - height) / 2, width, height });
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!; const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!; const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authorization = request.headers.get('Authorization') ?? '';
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return response({ error: 'Unauthorized' }, 401);
  const body = await request.json(); const leaseContractId = text(body.leaseContractId); const previewValues = body.previewValues as Values | undefined;
  const isPreview = Boolean(previewValues);
  if (!isPreview && !leaseContractId) return response({ error: 'leaseContractId は必須です。' }, 400);
  const { data: document, error: documentError } = isPreview && !leaseContractId ? { data: null, error: null } : await userClient.from('lease_contract_document').select('lease_contract_document_id, field_values').eq('lease_contract_id', leaseContractId).maybeSingle();
  if (!isPreview && (documentError || !document)) return response({ error: '契約書データを先に保存してください。' }, 400);
  const values = (previewValues ?? document?.field_values) as Values;
  for (const key of ['propertyName', 'tenantName', 'contractStartDate', 'contractEndDate', 'floorLabel', 'leasedAreaSqm']) if (!text(values[key])) return response({ error: `必須項目「${key}」を入力してください。` }, 400);
  const admin = createClient(url, serviceKey);
  const { data: planRows, error: planError } = document ? await userClient.from('lease_contract_document_plan').select('snapshot_file_path, floor_plan_revision:floor_plan_revision_id(floor_plan:floor_plan_id(floor_label))').eq('lease_contract_document_id', document.lease_contract_document_id).order('created_at') : { data: [], error: null };
  if (!isPreview && (planError || !planRows?.length)) return response({ error: planError ? `対象区画図を確認できませんでした: ${planError.message}` : '対象区画を選択して保存してからPDFを生成してください。' }, 400);
  const floorLabels = new Set((planRows ?? []).map((row: any) => row.floor_plan_revision?.floor_plan?.floor_label).filter(Boolean));
  if (!isPreview && floorLabels.size !== 1) return response({ error: '平面図欄は1フロアのみ対応です。対象区画を同一フロアにしてください。' }, 400);
  try {
    const [templateBytes, fontBytes, snapshotBytes] = await Promise.all([
      loadPrivateFile(admin, TEMPLATE_PATH, '契約書ひな型'), loadPrivateFile(admin, FONT_PATH, '日本語フォント'), planRows?.length ? loadPrivateFile(admin, planRows[0].snapshot_file_path, '保存済み対象区画図') : Promise.resolve(undefined),
    ]);
    const output = await splitTemplate(templateBytes); output.registerFontkit(fontkit);
    const font = await output.embedFont(fontBytes, { subset: true });
    await populateTemplate(output, font, values, snapshotBytes);
    const outputPdf = await output.save(); const path = isPreview ? `previews/${user.id}/ordinary_lease-preview.pdf` : `${leaseContractId}/ordinary_lease.pdf`;
    const { error: uploadError } = await admin.storage.from('contract-documents').upload(path, outputPdf, { contentType: 'application/pdf', upsert: true });
    if (uploadError) return response({ error: `PDFを保存できませんでした: ${uploadError.message}` }, 500);
    const generatedAt = new Date().toISOString();
    if (!isPreview) { const { error: updateError } = await admin.from('lease_contract_document').update({ pdf_file_path: path, pdf_generated_at: generatedAt }).eq('lease_contract_id', leaseContractId); if (updateError) return response({ error: `PDF情報を保存できませんでした: ${updateError.message}` }, 500); }
    return response({ pdfFilePath: path, generatedAt, pageCount: 18 });
  } catch (error) { return response({ error: `契約書PDFを生成できませんでした: ${error instanceof Error ? error.message : String(error)}` }, 500); }
});
