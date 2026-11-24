import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './lib/supabase';
import './AdminDevelopmentPage.css';

type Deposit = {
  tenant_deposit_id: string;
  amount: number;
  payment_due_date: string | null;
  invoice_method: 'monthly' | 'spot' | null;
  invoice_month: string | null;
  invoiced_at: string | null;
  request: { source_record: { app_id: string; data_id: string; ringi_number: string | null } | null } | null;
  contract_unit: {
    unit: { unit_code: string; floor_label: string | null; asset: { asset_name: string } | null } | null;
    contract: { tenant: { tenant_name: string } | null } | null;
  } | null;
};

const select = 'tenant_deposit_id,amount,payment_due_date,invoice_method,invoice_month,invoiced_at,request:change_request(source_record:appsuite_record!source_appsuite_record_id(app_id,data_id,ringi_number)),contract_unit:lease_contract_unit(unit:unit_master(unit_code,floor_label,asset:asset_master(asset_name)),contract:lease_contract(tenant:tenant_master(tenant_name)))';

export function DepositManagementPage() {
  const [items, setItems] = useState<Deposit[]>([]);
  const [dates, setDates] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reload = async () => {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from('tenant_deposit_management').select(select).order('created_at', { ascending: false });
    if (loadError) { setError(`敷金管理表を読み込めませんでした: ${loadError.message}`); return; }
    const rows = (data ?? []) as unknown as Deposit[];
    setItems(rows);
    setDates(Object.fromEntries(rows.map((item) => [item.tenant_deposit_id, item.payment_due_date ?? ''])));
    setError('');
  };
  useEffect(() => { void reload().finally(() => setLoading(false)); }, []);

  const saveDate = async (item: Deposit) => {
    if (!supabase) return;
    const date = dates[item.tenant_deposit_id];
    if (!date) { setError('敷金の入金期日を選択してください。'); return; }
    setSaving(item.tenant_deposit_id); setError(''); setNotice('');
    const { error: saveError } = await supabase.from('tenant_deposit_management').update({ payment_due_date: date, due_date_answered_at: new Date().toISOString(), due_date_answered_by: (await supabase.auth.getUser()).data.user?.id }).eq('tenant_deposit_id', item.tenant_deposit_id);
    if (saveError) setError(`入金期日を保存できませんでした: ${saveError.message}`);
    else { setNotice('営業部の入金期日回答を保存しました。'); await reload(); }
    setSaving(null);
  };

  return <section className="admin-development-page">
    <header className="admin-console-page-heading"><p className="section-kicker">DEVELOPMENT / DEPOSITS</p><h1>敷金管理</h1><p>新規オフィス契約の対応依頼確定後、営業部の期日設定と総務経理部の請求を管理します。</p></header>
    <div className="deposit-task-summary"><span>営業部・期日回答待ち <strong>{items.filter((item) => !item.payment_due_date).length}</strong></span><span>総務経理部・請求待ち <strong>{items.filter((item) => !item.invoiced_at).length}</strong></span></div>
    {error && <p role="alert" className="deposit-error">{error}</p>}{notice && <p role="status" className="deposit-notice">{notice}</p>}
    <div className="deposit-table-scroll"><table className="deposit-table"><thead><tr><th>ビル</th><th>階</th><th>区画</th><th>テナント名</th><th>稟議番号</th><th>敷金額</th><th>支払期日・営業部タスク</th><th>総務経理部タスク</th></tr></thead><tbody>
      {items.map((item) => {
        const record = item.request?.source_record;
        const approvalUrl = record ? `https://sk-housing.dn-cloud.com/cgi-bin/dneo/appsuite.cgi?cmd=cdbbrowse&app_id=${encodeURIComponent(record.app_id)}#view_id=2&id=${encodeURIComponent(record.data_id)}` : '';
        return <tr key={item.tenant_deposit_id}><td>{item.contract_unit?.unit?.asset?.asset_name ?? '—'}</td><td>{item.contract_unit?.unit?.floor_label ?? '—'}</td><td>{item.contract_unit?.unit?.unit_code ?? '—'}</td><td>{item.contract_unit?.contract?.tenant?.tenant_name ?? '—'}</td><td>{approvalUrl ? <a href={approvalUrl} target="_blank" rel="noreferrer">{record?.ringi_number || '稟議を開く'}</a> : '—'}</td><td className="deposit-money">{Number(item.amount).toLocaleString('ja-JP')} 円</td><td><div className="deposit-date-cell"><input type="date" aria-label="敷金入金期日" value={dates[item.tenant_deposit_id] ?? ''} disabled={Boolean(item.invoice_method)} onChange={(event) => setDates((current) => ({ ...current, [item.tenant_deposit_id]: event.target.value }))} /><button type="button" disabled={saving === item.tenant_deposit_id || Boolean(item.invoice_method) || !dates[item.tenant_deposit_id] || dates[item.tenant_deposit_id] === item.payment_due_date} onClick={() => void saveDate(item)}>回答を保存</button></div></td><td>{item.invoiced_at ? '請求済み' : item.invoice_method ? '請求書作成済み' : <span className="deposit-pending">敷金請求待ち</span>}{item.invoice_method && <small>{item.invoice_method === 'monthly' ? '月次' : 'スポット'}</small>}</td></tr>;
      })}
      {!loading && items.length === 0 && <tr><td colSpan={8}>対象の敷金はありません。新規オフィス契約の対応依頼が確定するとここに追加されます。</td></tr>}
      {loading && <tr><td colSpan={8}>読み込み中…</td></tr>}
    </tbody></table></div><p className="deposit-help">入金期日が回答された敷金は、<Link to="/billing-codes">テナント請求の「請求書作成」</Link>から月次・スポットを選んで追加できます。</p><Link to="/admin/development">開発中の機能へ戻る</Link>
  </section>;
}
