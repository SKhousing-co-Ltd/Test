import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const csvPath = process.argv[2] ?? 'data/rent-roll-history/normalized/rent_roll_snapshot_rows.json';
const url = 'http://127.0.0.1:54321';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const supabase = createClient(url, key);

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const parseLine = (line) => {
    const out = [];
    let value = '', quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i += 1; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === ',' && !quoted) { out.push(value); value = ''; continue; }
      value += ch;
    }
    out.push(value);
    return out;
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => Object.fromEntries(parseLine(line).map((v, i) => [headers[i], v || null])));
}
const rows = csvPath.endsWith('.json')
  ? JSON.parse(fs.readFileSync(csvPath, 'utf8'))
  : parseCsv(fs.readFileSync(csvPath, 'utf8'));
const assets = await supabase.from('asset_master').select('asset_id,asset_name');
if (assets.error) throw assets.error;
const assetByName = new Map(assets.data.map((asset) => [asset.asset_name, asset.asset_id]));
const groups = new Map();
for (const row of rows) {
  if (!assetByName.has(row.property_name)) continue;
  const key = `${row.snapshot_date}|${row.source_file}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
let insertedRows = 0; let insertedBatches = 0; let unmatched = 0;
for (const [groupKey, group] of groups) {
  const [asOfDate, sourceFileName] = groupKey.split('|');
  const batch = await supabase.from('rent_roll_snapshot_batch').upsert({ as_of_date: asOfDate, source_file_name: sourceFileName, row_count: group.length, status: 'loaded' }, { onConflict: 'as_of_date,source_file_name' }).select('rent_roll_snapshot_batch_id').single();
  if (batch.error) throw batch.error;
  const batchId = batch.data.rent_roll_snapshot_batch_id;
  await supabase.from('rent_roll_snapshot_row').delete().eq('rent_roll_snapshot_batch_id', batchId);
  const payload = group.map((row) => ({
    rent_roll_snapshot_batch_id: batchId,
    source_sheet_name: row.source_sheet_name,
    source_row_number: row.source_row_number ? Number(row.source_row_number) : null,
    property_name: row.property_name,
    property_id: assetByName.get(row.property_name) ?? null,
    wing_code: row.wing_code, floor_label: row.floor_label, unit_code: row.unit_code,
    unit_type: row.unit_type, tenant_name: row.tenant_name, source_status: row.source_status,
    occupancy_status: row.occupancy_status, area_sqm: row.area_sqm ? Number(row.area_sqm) : null,
    monthly_rent_amount: row.monthly_rent_amount ? Number(row.monthly_rent_amount) : null,
    monthly_common_charge_amount: row.monthly_common_charge_amount ? Number(row.monthly_common_charge_amount) : null,
    monthly_parking_amount: row.monthly_parking_amount ? Number(row.monthly_parking_amount) : null,
    other_monthly_amount: row.other_monthly_amount ? Number(row.other_monthly_amount) : null,
    deposit_amount: row.deposit_amount ? Number(row.deposit_amount) : null,
    security_deposit_amount: row.security_deposit_amount ? Number(row.security_deposit_amount) : null,
    key_money_amount: row.key_money_amount ? Number(row.key_money_amount) : null,
    renewal_fee_amount: row.renewal_fee_amount ? Number(row.renewal_fee_amount) : null,
    contract_start_date: row.contract_start_date, contract_end_date: row.contract_end_date,
    review_flags: row.review_flags,
  }));
  for (let i = 0; i < payload.length; i += 500) {
    const result = await supabase.from('rent_roll_snapshot_row').insert(payload.slice(i, i + 500));
    if (result.error) throw result.error;
  }
  insertedRows += payload.length; insertedBatches += 1;
}
unmatched = rows.filter((row) => !assetByName.has(row.property_name)).length;
console.log(JSON.stringify({ sourceRows: rows.length, insertedRows, insertedBatches, unmatchedPropertiesRows: unmatched }));
