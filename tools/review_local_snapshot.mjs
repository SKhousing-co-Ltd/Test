import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'http://127.0.0.1:54321',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
);
const data = [];
for (let offset = 0; ; offset += 1000) {
  const page = await supabase
    .from('rent_roll_snapshot_row')
    .select('property_name,property_id,occupancy_status,monthly_rent_amount,monthly_common_charge_amount,monthly_parking_amount,other_monthly_amount')
    .range(offset, offset + 999);
  if (page.error) throw page.error;
  data.push(...page.data);
  if (page.data.length < 1000) break;
}
const groups = new Map();
for (const row of data) {
  const key = `${row.property_id ?? 'UNMATCHED'}|${row.property_name}`;
  const item = groups.get(key) ?? { property_name: row.property_name, property_id: row.property_id, rows: 0, occupied: 0, vacant: 0, rent: 0, common: 0, parking: 0, other: 0 };
  item.rows += 1;
  item.occupied += row.occupancy_status === 'occupied' ? 1 : 0;
  item.vacant += row.occupancy_status === 'vacant' ? 1 : 0;
  item.rent += row.monthly_rent_amount ?? 0;
  item.common += row.monthly_common_charge_amount ?? 0;
  item.parking += row.monthly_parking_amount ?? 0;
  item.other += row.other_monthly_amount ?? 0;
  groups.set(key, item);
}
const result = [...groups.values()].sort((a, b) => a.property_name.localeCompare(b.property_name, 'ja'));
fs.writeFileSync('data/rent-roll-history/reports/local-property-review.json', JSON.stringify({ rowCount: data.length, matched: result.filter((x) => x.property_id).length, unmatched: result.filter((x) => !x.property_id).length, properties: result }, null, 2));
console.log(JSON.stringify({ rowCount: data.length, matched: result.filter((x) => x.property_id).length, unmatched: result.filter((x) => !x.property_id).length }));
