import type { SupabaseClient } from '@supabase/supabase-js';

export async function assertRevenuePostingReleased(client: SupabaseClient, assetId: string, sourceKind: 'monthly' | 'spot', sourceKey: string): Promise<void> {
  const { data, error } = await client.from('revenue_posting_source').select('id').eq('asset_id', assetId).eq('source_kind', sourceKind).eq('source_key', sourceKey).is('released_at', null).limit(1);
  if (error) throw error;
  if (data?.length) throw new Error('売上計上CSVが確定済みです。先に請求明細画面で確定解除してください。');
}
