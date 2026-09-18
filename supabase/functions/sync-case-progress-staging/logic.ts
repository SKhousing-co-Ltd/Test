export const REQUIRED_HEADERS = [
  'ID',
  '担当者',
  'ビル名称',
  '案件名',
  '項目',
  'ステータス',
  '入力日',
  '処理予定日',
  '処理日',
  '稟議No',
  '予算',
  '決定金額',
  '完了予定日',
  '備考',
] as const;

export type IncomingRow = {
  sourceRowNumber?: unknown;
  displayValues?: unknown;
  typedValues?: unknown;
};

export type ValidationIssue = {
  field: string;
  code: string;
  message: string;
};

export type NormalizedRow = {
  source_row_number: number;
  source_key: string;
  legacy_case_id: string | null;
  manager_raw: string | null;
  building_raw: string | null;
  case_name_raw: string | null;
  category_raw: string | null;
  status_raw: string | null;
  input_date: string | null;
  planned_process_date: string | null;
  processed_date: string | null;
  approval_no_raw: string | null;
  approval_no_normalized: string | null;
  budget_amount: number | null;
  decided_amount: number | null;
  planned_completion_date: string | null;
  note: string | null;
  raw_payload: Record<string, string>;
  validation_errors: ValidationIssue[];
  source_hash: string;
  identity_quality: 'strong' | 'fallback';
};

const AMOUNT_PATTERN = /^-?\d+(?:\.0+)?$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_DATE_PATTERN = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const JAPANESE_DATE_PATTERN = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('displayValues must be an object');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item == null ? '' : String(item)]));
}

function typedRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('typedValues must be an object');
  return value;
}

function trimmed(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

export function normalizeApprovalNo(value: unknown): string | null {
  const result = trimmed(value)?.replace(/[\s\u3000]+/gu, '').toUpperCase() ?? null;
  return !result || result === '-' || result === 'ー' ? null : result;
}

function normalizeAmount(
  field: string,
  typedValue: unknown,
  displayValue: string,
  issues: ValidationIssue[],
): number | null {
  if (typedValue === '' || typedValue === null || typedValue === undefined) {
    if (!displayValue.trim()) return null;
  } else if (typeof typedValue === 'number') {
    if (Number.isSafeInteger(typedValue)) return typedValue;
    issues.push({ field, code: 'INVALID_AMOUNT', message: `${field}を整数の金額として変換できません` });
    return null;
  }

  const normalized = displayValue.normalize('NFKC').replace(/[¥￥,\s\u3000]/gu, '');
  if (!normalized) return null;
  if (!AMOUNT_PATTERN.test(normalized)) {
    issues.push({ field, code: 'INVALID_AMOUNT', message: `${field}を金額として変換できません` });
    return null;
  }
  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount)) {
    issues.push({ field, code: 'INVALID_AMOUNT', message: `${field}が安全に保存できる整数範囲を超えています` });
    return null;
  }
  return amount;
}

function validDate(year: number, month: number, day: number): string | null {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateValue(value: unknown): string | null {
  const text = trimmed(value);
  if (!text) return null;
  const isoDate = text.length >= 10 ? text.slice(0, 10) : text;
  const match = ISO_DATE_PATTERN.exec(isoDate) ?? SLASH_DATE_PATTERN.exec(text) ?? JAPANESE_DATE_PATTERN.exec(text);
  if (!match) return null;
  return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function normalizeDate(
  field: string,
  typedValue: unknown,
  displayValue: string,
  issues: ValidationIssue[],
): string | null {
  if ((typedValue === '' || typedValue === null || typedValue === undefined) && !displayValue.trim()) return null;
  const parsed = parseDateValue(typedValue) ?? parseDateValue(displayValue);
  if (parsed) return parsed;
  issues.push({ field, code: 'INVALID_DATE', message: `${field}を日付として変換できません` });
  return null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function validateHeaders(headers: unknown): { headers: string[]; missing: string[]; duplicates: string[] } {
  if (!Array.isArray(headers) || !headers.every((header) => typeof header === 'string')) {
    throw new Error('headers must be an array of strings');
  }
  const normalized = headers.map((header) => header.trim());
  const missing = REQUIRED_HEADERS.filter((required) => !normalized.includes(required));
  const duplicates = [...new Set(normalized.filter((header, index) => header && normalized.indexOf(header) !== index))];
  return { headers: normalized, missing, duplicates };
}

export async function normalizeRow(row: IncomingRow): Promise<NormalizedRow> {
  if (typeof row.sourceRowNumber !== 'number' || !Number.isInteger(row.sourceRowNumber) || row.sourceRowNumber < 2) {
    throw new Error('sourceRowNumber must be an integer greater than or equal to 2');
  }
  const sourceRowNumber = row.sourceRowNumber;
  const display = displayRecord(row.displayValues);
  const typed = typedRecord(row.typedValues);
  const issues: ValidationIssue[] = [];
  const legacyCaseId = trimmed(display.ID);
  const identityQuality = legacyCaseId ? 'strong' : 'fallback';
  const approvalNoRaw = trimmed(display['稟議No']);

  const normalized = {
    legacy_case_id: legacyCaseId,
    manager_raw: trimmed(display['担当者']),
    building_raw: trimmed(display['ビル名称']),
    case_name_raw: trimmed(display['案件名']),
    category_raw: trimmed(display['項目']),
    status_raw: trimmed(display['ステータス']),
    input_date: normalizeDate('入力日', typed['入力日'], display['入力日'] ?? '', issues),
    planned_process_date: normalizeDate('処理予定日', typed['処理予定日'], display['処理予定日'] ?? '', issues),
    processed_date: normalizeDate('処理日', typed['処理日'], display['処理日'] ?? '', issues),
    approval_no_normalized: normalizeApprovalNo(approvalNoRaw),
    budget_amount: normalizeAmount('予算', typed['予算'], display['予算'] ?? '', issues),
    decided_amount: normalizeAmount('決定金額', typed['決定金額'], display['決定金額'] ?? '', issues),
    planned_completion_date: normalizeDate('完了予定日', typed['完了予定日'], display['完了予定日'] ?? '', issues),
    note: trimmed(display['備考']),
  };

  const sourceHash = await sha256(JSON.stringify(normalized));
  return {
    source_row_number: sourceRowNumber,
    source_key: legacyCaseId ? `id:${legacyCaseId}` : `row:${sourceRowNumber}`,
    legacy_case_id: legacyCaseId,
    manager_raw: normalized.manager_raw,
    building_raw: normalized.building_raw,
    case_name_raw: normalized.case_name_raw,
    category_raw: normalized.category_raw,
    status_raw: normalized.status_raw,
    input_date: normalized.input_date,
    planned_process_date: normalized.planned_process_date,
    processed_date: normalized.processed_date,
    approval_no_raw: approvalNoRaw,
    approval_no_normalized: normalized.approval_no_normalized,
    budget_amount: normalized.budget_amount,
    decided_amount: normalized.decided_amount,
    planned_completion_date: normalized.planned_completion_date,
    note: normalized.note,
    raw_payload: display,
    validation_errors: issues,
    source_hash: sourceHash,
    identity_quality: identityQuality,
  };
}

export async function normalizeRows(rows: unknown): Promise<NormalizedRow[]> {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2000) {
    throw new Error('rows must contain 1 to 2000 items');
  }
  const normalized = await Promise.all(rows.map((row) => {
    if (!isRecord(row)) throw new Error('every row must be an object');
    return normalizeRow(row);
  }));
  const sourceKeys = new Set<string>();
  const rowNumbers = new Set<number>();
  for (const row of normalized) {
    if (sourceKeys.has(row.source_key)) throw new Error(`duplicate source key: ${row.source_key}`);
    if (rowNumbers.has(row.source_row_number)) throw new Error(`duplicate source row number: ${row.source_row_number}`);
    sourceKeys.add(row.source_key);
    rowNumbers.add(row.source_row_number);
  }
  return normalized;
}
