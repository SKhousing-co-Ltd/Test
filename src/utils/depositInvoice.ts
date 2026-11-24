import type { SupabaseClient } from '@supabase/supabase-js';

export async function markDepositInvoicesIssued(client: SupabaseClient, recordIds: string[], issuedAt: string): Promise<void> {
  for (const recordId of new Set(recordIds)) {
    const { error } = await client.from('tenant_deposit_management').update({ invoiced_at: issuedAt }).eq('invoice_record_id', recordId);
    if (error) throw new Error(`敷金管理表の請求済み更新に失敗しました: ${error.message}`);
  }
}
