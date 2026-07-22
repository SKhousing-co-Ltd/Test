import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const encoder = new TextEncoder();
const utf16Hex = (text: unknown) => 'FEFF' + Array.from(String(text ?? '')).map((character) => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const yen = (value: unknown) => value === '' || value === null || value === undefined ? '未設定' : `${Number(value).toLocaleString('ja-JP')} 円`;

function makePdf(values: Record<string, unknown>) {
  const title = '建物賃貸借契約書';
  const lines = [
    ['物件名', values.propertyName], ['所在地', values.propertyAddress], ['貸室・区画', values.unitNames],
    ['賃借人', values.tenantName], ['契約開始日', values.contractStartDate], ['契約終了日', values.contractEndDate],
    ['月額賃料', yen(values.monthlyRentAmount)], ['共益費', yen(values.monthlyCommonChargeAmount)],
    ['敷金', yen(values.depositAmount)], ['保証金', yen(values.securityDepositAmount)], ['礼金', yen(values.keyMoneyAmount)],
  ];
  const content = [
    'BT /FJ 22 Tf 150 790 Td <' + utf16Hex(title) + '> Tj ET',
    'BT /FJ 10 Tf 55 754 Td <' + utf16Hex('以下の条件により、貸主と賃借人は建物賃貸借契約を締結する。') + '> Tj ET',
    ...lines.map((line, index) => `BT /FJ 11 Tf 65 ${720 - index * 29} Td <${utf16Hex(`${line[0]}： ${line[1] || '未設定'}`)}> Tj ET`),
    'BT /FJ 10 Tf 55 365 Td <' + utf16Hex('第1条（使用目的） 賃借人は、上記貸室を契約で定める用途以外に使用してはならない。') + '> Tj ET',
    'BT /FJ 10 Tf 55 335 Td <' + utf16Hex('第2条（賃料） 賃借人は、毎月定められた期日までに賃料その他の負担金を支払う。') + '> Tj ET',
    'BT /FJ 10 Tf 55 305 Td <' + utf16Hex('第3条（原状回復） 契約終了時の原状回復は、別途合意した条件に従う。') + '> Tj ET',
    'BT /FJ 11 Tf 80 190 Td <' + utf16Hex('貸主') + '> Tj ET 0 0 0 RG 80 120 185 55 re S',
    'BT /FJ 11 Tf 350 190 Td <' + utf16Hex('賃借人') + '> Tj ET 0 0 0 RG 350 120 185 55 re S',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /FJ 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UTF16-H /DescendantFonts [6 0 R] >>',
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> >>',
  ];
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(encoder.encode(pdf).length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const startXref = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;
  return encoder.encode(pdf);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  const url = Deno.env.get('SUPABASE_URL')!; const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!; const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authorization = request.headers.get('Authorization') ?? '';
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  const body = await request.json(); const leaseContractId = body.leaseContractId as string;
  if (!leaseContractId) return new Response(JSON.stringify({ error: 'leaseContractId は必須です。' }), { status: 400, headers: corsHeaders });
  const { data: document, error } = await userClient.from('lease_contract_document').select('field_values').eq('lease_contract_id', leaseContractId).maybeSingle();
  if (error || !document) return new Response(JSON.stringify({ error: '契約書データを先に保存してください。' }), { status: 400, headers: corsHeaders });
  const values = document.field_values as Record<string, unknown>;
  for (const key of ['propertyName', 'tenantName', 'contractStartDate', 'contractEndDate']) if (!values[key]) return new Response(JSON.stringify({ error: `必須項目「${key}」を入力してください。` }), { status: 400, headers: corsHeaders });
  const admin = createClient(url, serviceKey); const path = `${leaseContractId}/ordinary_lease.pdf`;
  const { error: uploadError } = await admin.storage.from('contract-documents').upload(path, makePdf(values), { contentType: 'application/pdf', upsert: true });
  if (uploadError) return new Response(JSON.stringify({ error: `PDFを保存できませんでした: ${uploadError.message}` }), { status: 500, headers: corsHeaders });
  const generatedAt = new Date().toISOString();
  const { error: updateError } = await admin.from('lease_contract_document').update({ pdf_file_path: path, pdf_generated_at: generatedAt }).eq('lease_contract_id', leaseContractId);
  if (updateError) return new Response(JSON.stringify({ error: `PDF情報を保存できませんでした: ${updateError.message}` }), { status: 500, headers: corsHeaders });
  return new Response(JSON.stringify({ pdfFilePath: path, generatedAt }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
