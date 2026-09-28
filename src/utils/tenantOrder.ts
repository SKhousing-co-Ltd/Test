// テナント請求の各画面で使う、テナントの並び順です。
// 請求設定の「テナント並び順」で保存した順番を優先し、まだ保存していないテナントは次のように差し込みます。
//   1. 並び順が決まっているテナントと同じ区画に入居しているテナントは、そのテナントのすぐ下に置く
//   2. それ以外は、レントロールの並び（階順）で前後のテナントを見て、その位置に置く
import type { SupabaseClient } from '@supabase/supabase-js';

export type TenantUnitRow = { tenant_id: string | null; unit_id: string | null };
export type SavedTenantOrder = { tenant_id: string; sort_order: number };

// レントロールの行（階順）と保存済みの並び順から、テナントの並び順を作ります。
// 返す配列の順番がそのまま表示順です。レントロールに居ないテナントは含みません。
export function orderTenants(rows: TenantUnitRow[], saved: SavedTenantOrder[]): string[] {
  const floorRank = new Map<string, number>();
  const unitsOf = new Map<string, Set<string>>();
  for (const row of rows) {
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
