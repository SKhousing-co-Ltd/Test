// テナント請求の各画面で使う、テナントの並び順です。
// 入金明細・請求明細・請求書作成で保存した共通順を優先し、まだ保存していないテナントは次のように差し込みます。
//   1. 並び順が決まっているテナントと同じ区画に入居しているテナントは、そのテナントのすぐ下に置く
//   2. それ以外は、レントロールの並び（階順）で前後のテナントを見て、その位置に置く
import type { SupabaseClient } from '@supabase/supabase-js';

export type TenantUnitRow = { tenant_id: string | null; unit_id: string | null; floor_label?: string | null; unit_name?: string | null; unit_code?: string | null };
export type SavedTenantOrder = { tenant_id: string; sort_order: number };

// 階の並びです。レントロール画面と同じく、地下（B1）→ 1F → 2F → … → 10F → 屋上 の順にします。
// レントロールのRPCは階を文字列で並べる（10F が 2F より前に来る）ため、ここで並べ直します。
const collator = new Intl.Collator('ja-JP', { numeric: true, sensitivity: 'base' });
export function floorOrder(label: string): number {
  const normalized = label.normalize('NFKC').trim().toUpperCase();
  const basement = normalized.match(/^B(\d+)/);
  if (basement) return -Number(basement[1]);
  const numeric = normalized.match(/-?\d+(?:\.\d+)?/);
  if (numeric) return Number(numeric[0]);
  if (normalized.includes('PH') || normalized.includes('屋上')) return 10000;
  return 5000;
}
const compareUnits = (left: TenantUnitRow, right: TenantUnitRow) => {
  const leftFloor = left.floor_label ?? '';
  const rightFloor = right.floor_label ?? '';
  return floorOrder(leftFloor) - floorOrder(rightFloor) || collator.compare(leftFloor, rightFloor)
    || collator.compare(left.unit_name ?? '', right.unit_name ?? '') || collator.compare(left.unit_code ?? '', right.unit_code ?? '');
};

// レントロールの行と保存済みの並び順から、テナントの並び順を作ります。
// 返す配列の順番がそのまま表示順です。レントロールに居ないテナントは含みません。
export function orderTenants(rows: TenantUnitRow[], saved: SavedTenantOrder[]): string[] {
  const floorRank = new Map<string, number>();
  const unitsOf = new Map<string, Set<string>>();
  for (const row of [...rows].sort(compareUnits)) {
    if (!row.tenant_id) continue;
    if (!floorRank.has(row.tenant_id)) floorRank.set(row.tenant_id, floorRank.size);
    if (row.unit_id) unitsOf.set(row.tenant_id, (unitsOf.get(row.tenant_id) ?? new Set()).add(row.unit_id));
  }
  const savedRank = new Map(saved.map((row) => [row.tenant_id, row.sort_order]));
  const ordered = [...floorRank.keys()].filter((id) => savedRank.has(id))
    .sort((left, right) => savedRank.get(left)! - savedRank.get(right)! || floorRank.get(left)! - floorRank.get(right)!);
  const pending = [...floorRank.keys()].filter((id) => !savedRank.has(id));

  const sharesUnit = (left: string, right: string) => [...(unitsOf.get(left) ?? [])].some((unit) => unitsOf.get(right)?.has(unit));
  for (const tenantId of pending) {
    // 同じ区画のテナントが既に並んでいれば、そのすぐ下（先に差し込んだ同じ区画のテナントの後ろ）に置きます。
    const anchor = ordered.findIndex((other) => sharesUnit(tenantId, other));
    if (anchor >= 0) {
      let position = anchor + 1;
      while (position < ordered.length && !savedRank.has(ordered[position]) && sharesUnit(tenantId, ordered[position])) position += 1;
      ordered.splice(position, 0, tenantId);
      continue;
    }
    // 階順で自分より後ろのテナントのうち、最初に並んでいるものの手前に置きます。
    const rank = floorRank.get(tenantId)!;
    const before = ordered.findIndex((other) => floorRank.get(other)! > rank);
    if (before >= 0) ordered.splice(before, 0, tenantId);
    else ordered.push(tenantId);
  }
  return ordered;
}

// ドラッグした行（from）を、insertBefore 番目の行の手前へ移します。insertBefore が行数と同じなら末尾です。
export function moveBefore<T>(items: T[], from: number, insertBefore: number): T[] {
  if (from < 0 || from >= items.length || insertBefore < 0 || insertBefore > items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(insertBefore > from ? insertBefore - 1 : insertBefore, 0, moved);
  return next;
}

// 並び順を比較関数にします。並び順に居ないテナント（テナント未設定を含む）は後ろに回し、元の順番を保ちます。
export function tenantComparator(order: string[]) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return (left: string | null | undefined, right: string | null | undefined) =>
    (rank.get(left ?? '') ?? Number.MAX_SAFE_INTEGER) - (rank.get(right ?? '') ?? Number.MAX_SAFE_INTEGER);
}

// 保存済みの並び順を読みます。読めないときは並び順なし（レントロールの階順）で表示を続けます。
export async function loadSavedTenantOrder(client: SupabaseClient, assetId: string): Promise<SavedTenantOrder[]> {
  const { data, error } = await client.from('asset_billing_tenant_order').select('tenant_id, sort_order').eq('asset_id', assetId);
  if (error) { console.warn(`テナント並び順を読み込めませんでした: ${error.message}`); return []; }
  return (data ?? []) as SavedTenantOrder[];
}

// 明細画面で変更した順番を、テナント請求全体の共通順として保存します。
// 同じテナントに複数の請求書がある場合は最初の請求書の位置を使い、今回の明細に居ない
// テナントは既存順の末尾に残します（過去月など一部のテナントだけの明細で順番を失わないためです）。
export async function saveTenantOrder(client: SupabaseClient, assetId: string, tenantIds: string[]): Promise<void> {
  const visible = [...new Set(tenantIds.filter(Boolean))];
  if (!visible.length) return;
  const existing = (await loadSavedTenantOrder(client, assetId)).sort((left, right) => left.sort_order - right.sort_order);
  const visibleSet = new Set(visible);
  const ordered = [...visible, ...existing.map((row) => row.tenant_id).filter((tenantId) => !visibleSet.has(tenantId))];
  const { error } = await client.from('asset_billing_tenant_order').upsert(
    ordered.map((tenant_id, sort_order) => ({ asset_id: assetId, tenant_id, sort_order })),
    { onConflict: 'asset_id,tenant_id' },
  );
  if (error) throw new Error(`テナント並び順を保存できませんでした: ${error.message}`);
}
