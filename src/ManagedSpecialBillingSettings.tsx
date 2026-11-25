import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from './lib/supabase';
import './ManagedSpecialBillingSettings.css';

export type ManagedBillingKind = 'deposit' | 'garage_certificate' | 'security_card';
type Setting = { kind: ManagedBillingKind; invoice_item_1: string; invoice_item_2: string; account_code: string; subaccount_code: string };
const labels: Record<ManagedBillingKind, string> = { deposit: '敷金', garage_certificate: '車庫証明', security_card: 'セキュリティカード' };

export function ManagedSpecialBillingSettings({ kind }: { kind: ManagedBillingKind }) {
  const [setting, setSetting] = useState<Setting | null>(null);
  const [saved, setSaved] = useState<Setting | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    setSetting(null); setMessage('');
    void supabase?.from('managed_special_billing_setting').select('kind,invoice_item_1,invoice_item_2,account_code,subaccount_code').eq('kind', kind).single().then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) setMessage(`請求設定を読み込めませんでした: ${error?.message ?? '設定がありません'}`);
      else { setSetting(data as Setting); setSaved(data as Setting); }
    });
    return () => { cancelled = true; };
  }, [kind]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !setting) return;
    setBusy(true); setMessage('');
    const values = { invoice_item_1: setting.invoice_item_1.trim(), invoice_item_2: setting.invoice_item_2.trim(), account_code: setting.account_code.trim(), subaccount_code: setting.subaccount_code.trim(), updated_at: new Date().toISOString() };
    const { error } = await supabase.from('managed_special_billing_setting').update(values).eq('kind', kind);
    setBusy(false);
    if (error) setMessage(`保存できませんでした: ${error.message}`);
    else { const next = { ...setting, ...values }; setSetting(next); setSaved(next); setMessage('請求書明細・計上科目の設定を保存しました。'); }
  };
  return <section className="managed-billing-settings"><div><h2>{labels[kind]}の請求・計上設定</h2><p>請求書作成に渡す明細項目と、会計連携時の貸方科目を設定します。</p></div>{setting ? <form onSubmit={(event) => void save(event)}><label>明細項目１<input value={setting.invoice_item_1} required onChange={(event) => setSetting({ ...setting, invoice_item_1: event.target.value })} /></label><label>明細項目２<input value={setting.invoice_item_2} required onChange={(event) => setSetting({ ...setting, invoice_item_2: event.target.value })} /></label><label>計上科目コード<input value={setting.account_code} required pattern="[0-9]+" onChange={(event) => setSetting({ ...setting, account_code: event.target.value })} /></label><label>補助科目コード<input value={setting.subaccount_code} pattern="[0-9]*" onChange={(event) => setSetting({ ...setting, subaccount_code: event.target.value })} /></label><button type="submit" disabled={busy || JSON.stringify(setting) === JSON.stringify(saved)}>{busy ? '保存中…' : '設定を保存'}</button></form> : <p>設定を読み込み中です。</p>}{message && <p role="status" className="managed-billing-message">{message}</p>}</section>;
}
