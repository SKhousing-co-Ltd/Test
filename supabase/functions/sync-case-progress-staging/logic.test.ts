import { normalizeRows, REQUIRED_HEADERS, validateHeaders } from './logic.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('Google Sheetの表示値を保持し、型付き値を正規化する', async () => {
  const displayValues = Object.fromEntries(REQUIRED_HEADERS.map((header) => [header, '']));
  Object.assign(displayValues, {
    ID: '000001',
    担当者: '担当者A',
    ビル名称: '本社ビル',
    案件名: '空調更新',
    入力日: '2026/9/18',
    稟議No: ' sk-001 ',
    予算: '1,234,000',
  });
  const [row] = await normalizeRows([{
    sourceRowNumber: 2,
    displayValues,
    typedValues: { ...displayValues, 予算: 1234000 },
  }]);

  assert(row.legacy_case_id === '000001', '先頭ゼロを含むIDを表示値のまま保持する');
  assert(row.source_key === 'id:000001' && row.identity_quality === 'strong', 'IDを安定キーにする');
  assert(row.approval_no_normalized === 'SK-001', '稟議Noを正規化する');
  assert(row.budget_amount === 1234000, '金額を整数へ変換する');
  assert(row.input_date === '2026-09-18', '日付をISO形式へ変換する');
  assert(row.validation_errors.length === 0, '正常行には変換警告を付けない');
  assert(/^[0-9a-f]{64}$/.test(row.source_hash), 'SHA-256 hashを作る');
});

Deno.test('IDなしは行番号fallbackとし、変換不能値は原文と警告を残す', async () => {
  const displayValues = Object.fromEntries(REQUIRED_HEADERS.map((header) => [header, '']));
  Object.assign(displayValues, { 予算: '金額未定', 完了予定日: '未定' });
  const [row] = await normalizeRows([{
    sourceRowNumber: 9,
    displayValues,
    typedValues: displayValues,
  }]);

  assert(row.source_key === 'row:9' && row.identity_quality === 'fallback', 'IDなしは行番号fallbackにする');
  assert(row.budget_amount === null && row.planned_completion_date === null, '変換不能値をNULLにする');
  assert(row.raw_payload.予算 === '金額未定', '原文を保持する');
  assert(row.validation_errors.length === 2, '金額と日付の警告を記録する');
});

Deno.test('必須ヘッダー不足・重複とsource key重複を拒否する', async () => {
  const headerResult = validateHeaders([...REQUIRED_HEADERS.slice(0, -1), 'ID']);
  assert(headerResult.missing.includes('備考'), '不足ヘッダーを検出する');
  assert(headerResult.duplicates.includes('ID'), '重複ヘッダーを検出する');

  const values = Object.fromEntries(REQUIRED_HEADERS.map((header) => [header, '']));
  values.ID = '000001';
  let rejected = false;
  try {
    await normalizeRows([
      { sourceRowNumber: 2, displayValues: values, typedValues: values },
      { sourceRowNumber: 3, displayValues: values, typedValues: values },
    ]);
  } catch (error) {
    rejected = error instanceof Error && error.message === 'duplicate source key: id:000001';
  }
  assert(rejected, '同一IDの行を拒否する');
});
