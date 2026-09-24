import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient('http://127.0.0.1:54321', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU');
const source = JSON.parse(fs.readFileSync('data/rent-roll-history/normalized/rent_roll_snapshot_rows.json', 'utf8'));
const assets = await supabase.from('asset_master').select('asset_name');
if (assets.error) throw assets.error;
const assetNames = new Set(assets.data.map((row) => row.asset_name));
const expected = new Map();
for (const row of source) {
  if (!assetNames.has(row.property_name)) continue;
  const key = `${row.snapshot_date}|${row.property_name}`;
  const item = expected.get(key) ?? { snapshot_date: row.snapshot_date, property_name: row.property_name, rows: 0, occupied: 0, vacant: 0, rent: 0, common: 0, parking: 0, other: 0 };
  item.rows += 1; item.occupied += row.occupancy_status === 'occupied' ? 1 : 0; item.vacant += row.occupancy_status === 'vacant' ? 1 : 0;
  if (row.occupancy_status === 'occupied') { item.rent += Number(row.monthly_rent_amount ?? 0); item.common += Number(row.monthly_common_charge_amount ?? 0); item.parking += Number(row.monthly_parking_amount ?? 0); item.other += Number(row.other_monthly_amount ?? 0); }
  expected.set(key, item);
}
const actual = new Map();
for (let offset = 0; ; offset += 1000) {
  const page = await supabase.from('rent_roll_snapshot_row').select('rent_roll_snapshot_batch(as_of_date),property_name,occupancy_status,monthly_rent_amount,monthly_common_charge_amount,monthly_parking_amount,other_monthly_amount').range(offset, offset + 999);
  if (page.error) throw page.error;
  for (const row of page.data) {
    const date = row.rent_roll_snapshot_batch.as_of_date; const key = `${date}|${row.property_name}`;
    const item = actual.get(key) ?? { snapshot_date: date, property_name: row.property_name, rows: 0, occupied: 0, vacant: 0, rent: 0, common: 0, parking: 0, other: 0 };
    item.rows += 1; item.occupied += row.occupancy_status === 'occupied' ? 1 : 0; item.vacant += row.occupancy_status === 'vacant' ? 1 : 0;
    if (row.occupancy_status === 'occupied') { item.rent += Number(row.monthly_rent_amount ?? 0); item.common += Number(row.monthly_common_charge_amount ?? 0); item.parking += Number(row.monthly_parking_amount ?? 0); item.other += Number(row.other_monthly_amount ?? 0); }
    actual.set(key, item);
  }
  if (page.data.length < 1000) break;
}
const differences = [];
for (const [key, expectedRow] of expected) {
  const actualRow = actual.get(key);
  if (!actualRow || ['rows', 'occupied', 'vacant', 'rent', 'common', 'parking', 'other'].some((field) => Number(actualRow[field] ?? 0) !== Number(expectedRow[field] ?? 0))) differences.push({ key, expected: expectedRow, actual: actualRow ?? null });
}
const result = { expectedGroups: expected.size, actualGroups: actual.size, differenceCount: differences.length, differences: differences.slice(0, 100) };
fs.writeFileSync('data/rent-roll-history/reports/local-total-comparison.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ expectedGroups: result.expectedGroups, actualGroups: result.actualGroups, differenceCount: result.differenceCount }));
