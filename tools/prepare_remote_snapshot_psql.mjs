import fs from 'node:fs';
import path from 'node:path';

const csvPath = process.argv[2] ?? 'data/rent-roll-history/normalized/rent_roll_snapshot_rows.csv';
const outputPath = process.argv[3] ?? path.join(process.env.TEMP ?? '.', 'rent-roll-snapshot-import.sql');
const headers = ['snapshot_date', 'source_file', 'source_sheet_name', 'source_row_number', 'property_name', 'wing_code', 'floor_label', 'unit_code', 'unit_type', 'tenant_name', 'source_status', 'occupancy_status', 'area_sqm', 'monthly_rent_amount', 'monthly_common_charge_amount', 'monthly_parking_amount', 'other_monthly_amount', 'deposit_amount', 'security_deposit_amount', 'key_money_amount', 'renewal_fee_amount', 'contract_start_date', 'contract_end_date', 'review_flags'];
const csvField = (value) => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
const prefix = `begin;
create temporary table rent_roll_snapshot_stage (
  snapshot_date date, source_file text, source_sheet_name text, source_row_number integer,
  property_name text, wing_code text, floor_label text, unit_code text, unit_type text,
  tenant_name text, source_status text, occupancy_status text, area_sqm numeric,
  monthly_rent_amount numeric, monthly_common_charge_amount numeric, monthly_parking_amount numeric,
  other_monthly_amount numeric, deposit_amount numeric, security_deposit_amount numeric,
  key_money_amount numeric, renewal_fee_amount numeric, contract_start_date date,
  contract_end_date date, review_flags text
);
\\copy rent_roll_snapshot_stage (snapshot_date, source_file, source_sheet_name, source_row_number, property_name, wing_code, floor_label, unit_code, unit_type, tenant_name, source_status, occupancy_status, area_sqm, monthly_rent_amount, monthly_common_charge_amount, monthly_parking_amount, other_monthly_amount, deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount, contract_start_date, contract_end_date, review_flags) from stdin with (format csv, header true);
`;
const suffix = `\\.
do $$ declare unmatched_count integer; begin
  select count(*) into unmatched_count from rent_roll_snapshot_stage s left join public.asset_master a on a.asset_name = s.property_name where a.asset_id is null;
  raise notice 'unmatched asset_master rows skipped: %', unmatched_count;
end $$;
insert into public.rent_roll_snapshot_batch (as_of_date, source_file_name, row_count, status)
select snapshot_date, source_file, count(*)::integer, 'loaded'
from rent_roll_snapshot_stage
group by snapshot_date, source_file
on conflict (as_of_date, source_file_name) do update set row_count = excluded.row_count;
delete from public.rent_roll_snapshot_row r
using public.rent_roll_snapshot_batch b, rent_roll_snapshot_stage s
where r.rent_roll_snapshot_batch_id = b.rent_roll_snapshot_batch_id
  and b.as_of_date = s.snapshot_date and b.source_file_name = s.source_file;
insert into public.rent_roll_snapshot_row (
  rent_roll_snapshot_batch_id, source_sheet_name, source_row_number, property_name, property_id,
  wing_code, floor_label, unit_code, unit_type, tenant_name, source_status, occupancy_status,
  area_sqm, monthly_rent_amount, monthly_common_charge_amount, monthly_parking_amount,
  other_monthly_amount, deposit_amount, security_deposit_amount, key_money_amount, renewal_fee_amount,
  contract_start_date, contract_end_date, review_flags)
select b.rent_roll_snapshot_batch_id, s.source_sheet_name, s.source_row_number, s.property_name, a.asset_id,
  s.wing_code, s.floor_label, s.unit_code, s.unit_type, s.tenant_name, s.source_status, s.occupancy_status,
  s.area_sqm, s.monthly_rent_amount, s.monthly_common_charge_amount, s.monthly_parking_amount,
  s.other_monthly_amount, s.deposit_amount, s.security_deposit_amount, s.key_money_amount, s.renewal_fee_amount,
  s.contract_start_date, s.contract_end_date, s.review_flags
from rent_roll_snapshot_stage s
join public.asset_master a on a.asset_name = s.property_name
join public.rent_roll_snapshot_batch b on b.as_of_date = s.snapshot_date and b.source_file_name = s.source_file
on conflict (rent_roll_snapshot_row_id) do nothing;
commit;
`;
fs.writeFileSync(outputPath, prefix, 'utf8');
if (csvPath.toLowerCase().endsWith('.json')) {
  const rows = JSON.parse(fs.readFileSync(csvPath, 'utf8'));
  fs.appendFileSync(outputPath, `${headers.join(',')}\n${rows.map((row) => headers.map((header) => csvField(row[header])).join(',')).join('\n')}\n`, 'utf8');
} else {
  fs.appendFileSync(outputPath, fs.readFileSync(csvPath));
}
fs.appendFileSync(outputPath, suffix, 'utf8');
console.log(outputPath);
