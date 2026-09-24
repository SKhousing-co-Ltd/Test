import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dumpPath = process.argv[2] ?? 'data/rent-roll-history/reports/local-snapshot-data.sql';
const chunkSize = Number(process.argv[3] ?? 300);
const remoteDbUrl = process.env.REMOTE_DB_URL;
const sql = fs.readFileSync(dumpPath, 'utf8');

function statements(text) {
  const result = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 39 && text.charCodeAt(i - 1) !== 92) quoted = !quoted;
    if (text[i] === ';' && !quoted) {
      const statement = text.slice(start, i + 1).trim();
      if (statement.startsWith('INSERT INTO public.rent_roll_snapshot_')) result.push(statement);
      start = i + 1;
    }
  }
  return result;
}

function splitValues(values) {
  const result = [];
  let start = 0;
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values.charCodeAt(i) === 39 && values.charCodeAt(i - 1) !== 92) quoted = !quoted;
    if (!quoted) {
      if (values[i] === '(') depth += 1;
      if (values[i] === ')') depth -= 1;
      if (values[i] === ',' && depth === 0) { result.push(values.slice(start, i).trim()); start = i + 1; }
    }
  }
  result.push(values.slice(start).trim());
  return result;
}

function quoteSql(value) {
  return value === 'NULL' ? 'NULL' : `'${value.slice(1, -1).replaceAll("''", "''")}'`;
}

function transform(statement) {
  const isRow = statement.startsWith('INSERT INTO public.rent_roll_snapshot_row');
  const marker = ' VALUES (';
  const valuesStart = statement.indexOf(marker) + marker.length;
  if (valuesStart < marker.length) return `${statement.slice(0, -1)} ON CONFLICT DO NOTHING;`;
  const valuesEnd = statement.lastIndexOf(');');
  const values = splitValues(statement.slice(valuesStart, valuesEnd));
  if (isRow && values.length > 5) {
    const propertyName = values[4];
    values[5] = `(select asset_id from public.asset_master where asset_name = ${propertyName} limit 1)`;
  }
  return `${statement.slice(0, valuesStart)}${values.join(', ')});`.replace(/;$/, ' ON CONFLICT DO NOTHING;');
}

const transformed = statements(sql).map(transform).sort((a, b) => {
  const aBatch = a.startsWith('INSERT INTO public.rent_roll_snapshot_batch') ? 0 : 1;
  const bBatch = b.startsWith('INSERT INTO public.rent_roll_snapshot_batch') ? 0 : 1;
  return aBatch - bBatch;
});
function combine(items) {
  const result = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const group = items.slice(i, i + chunkSize);
  const buckets = new Map();
  for (const statement of group) {
    const match = statement.match(/^(INSERT INTO public\.rent_roll_snapshot_(?:batch|row) \([^]+?\) VALUES) \(([^]+)\) ON CONFLICT DO NOTHING;$/);
    if (!match) throw new Error(`Unexpected generated statement at ${i}`);
    if (!buckets.has(match[1])) buckets.set(match[1], []);
    buckets.get(match[1]).push(`(${match[2]})`);
  }
    for (const [prefix, tuples] of buckets) result.push(`${prefix} ${tuples.join(', ')} ON CONFLICT DO NOTHING;`);
  }
  return result;
}
const all = [...combine(transformed.filter((statement) => statement.startsWith('INSERT INTO public.rent_roll_snapshot_batch'))), ...combine(transformed.filter((statement) => statement.startsWith('INSERT INTO public.rent_roll_snapshot_row')))];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-roll-remote-'));
try {
  for (let offset = 0; offset < all.length; offset += chunkSize) {
    const chunkPath = path.join(tempDir, `chunk-${String(offset / chunkSize).padStart(4, '0')}.sql`);
    fs.writeFileSync(chunkPath, all.slice(offset, offset + chunkSize).join('\n'), 'utf8');
    console.log(`Uploading ${Math.min(offset + chunkSize, all.length)}/${all.length}`);
    const queryArgs = remoteDbUrl ? ['supabase', 'db', 'query', '--db-url', remoteDbUrl, '--file', chunkPath] : ['supabase', 'db', 'query', '--linked', '--file', chunkPath];
    const command = process.platform === 'win32' ? ['cmd.exe', ['/c', 'npx', ...queryArgs]] : ['npx', queryArgs];
    execFileSync(command[0], command[1], { stdio: 'inherit' });
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
