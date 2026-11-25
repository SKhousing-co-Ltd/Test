import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import type { BillingPeriod } from './TenantBillingControls';
import { emptyValues, loadSavedInvoiceSheet, recalcInvoices, saveInvoiceSheet, type InvoiceRow, type InvoiceSheet, type SpotInvoice } from './utils/invoiceSheet';
import { monthStart } from './utils/spotInvoices';
import './AdminDevelopmentPage.css';
import { depositInvoiceDetail, lateContractFixedCharges } from './utils/lateContractSpotInvoice';

type DepositOption = { tenant_deposit_id: string; amount: number; payment_due_date: string; invoice_record_id: string | null; created_at: string; contract_unit: { lease_start_date: string | null; monthly_rent_amount: number | null; monthly_common_charge_amount: number | null; contract: { tenant_id: string; contract_start_date: string | null; tenant: { tenant_name: string } | null } | null; unit: { unit_code: string; floor_label: string | null; unit_type: string | null } | null } | null };
type Recipient = { tenant_id: string | null; issue_code: string; invoice_display_name: string | null; recipient_name: string | null; invoice_subject: string | null };
const blankSheet = (): InvoiceSheet => ({ rows: [], duePatternByInvoice: {}, dueDateByPattern: {}, periodPatternByRow: {}, periodRangeByPattern: {}, invoiceNote: '', showInvoiceNote: false });
const dateText = (date: string) => date ? `${Number(date.slice(0, 4))}/${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : '';
const periodText = (start: string, end: string) => `${dateText(start)}～${dateText(end)}分`;

export function DepositInvoicePanel({ propertyId, propertyName, period, mode, onAdded }: { propertyId: string; propertyName: string; period: BillingPeriod; mode: 'monthly' | 'spot'; onAdded: () => void }) {
  const calendarYear = period.fiscalYear + (period.month <= 3 ? 1 : 0);
  const [deposits, setDeposits] = useState<DepositOption[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!supabase || !propertyId) return;
    let cancelled = false;
    void Promise.all([
      supabase.from('tenant_deposit_management').select('tenant_deposit_id,amount,payment_due_date,invoice_record_id,created_at,contract_unit:lease_contract_unit!inner(lease_start_date,monthly_rent_amount,monthly_common_charge_amount,contract:lease_contract(tenant_id,contract_start_date,tenant:tenant_master(tenant_name)),unit:unit_master!inner(unit_code,floor_label,unit_type,asset:asset_master!inner(asset_id)))').not('payment_due_date', 'is', null).is('invoice_record_id', null).eq('contract_unit.unit.asset.asset_id', propertyId),
      supabase.from('billing_code').select('tenant_id,issue_code,invoice_display_name,recipient_name,invoice_subject').eq('property_id', propertyId),
    ]).then(([depositResult, codeResult]) => {
      if (cancelled) return;
      if (depositResult.error || codeResult.error) { setError(depositResult.error?.message ?? codeResult.error?.message ?? '敷金を読み込めませんでした。'); return; }
      const next = (depositResult.data ?? []) as unknown as DepositOption[];
      setDeposits(next); setRecipients((codeResult.data ?? []) as Recipient[]);
      setSelectedId((current) => next.some((item) => item.tenant_deposit_id === current) ? current : next[0]?.tenant_deposit_id ?? '');
    });
    return () => { cancelled = true; };
  }, [propertyId]);

  const addDeposit = async () => {
    const deposit = deposits.find((item) => item.tenant_deposit_id === selectedId);
    if (!supabase || !deposit) return;
    const tenantId = deposit.contract_unit?.contract?.tenant_id;
    const recipient = recipients.find((item) => item.tenant_id === tenantId);
    if (!recipient) { setError('請求先コードが未登録です。テナントコード一覧で登録してください。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const { data: billingSetting, error: settingError } = await supabase.from('managed_special_billing_setting').select('invoice_item_1,invoice_item_2,account_code,subaccount_code').eq('kind', 'deposit').single();
      if (settingError || !billingSetting) throw new Error(`敷金の請求・計上設定を読み込めませんでした: ${settingError?.message ?? '設定がありません'}`);
      const saved = await loadSavedInvoiceSheet(supabase, propertyId, calendarYear, period.month);
      const sheet = saved?.sheet ?? blankSheet();
      if (!saved && mode === 'monthly') throw new Error('先に月次請求書を保存してください。');
      const existingMonthly = sheet.rows.find((row) => row.depositId === deposit.tenant_deposit_id);
      const existingSpot = sheet.spotInvoices?.find((spot) => spot.rows.some((row) => row.depositId === deposit.tenant_deposit_id));
      if (existingMonthly || existingSpot) {
        const { error: recoveryError } = await supabase.from('tenant_deposit_management').update({ invoice_method: existingSpot ? 'spot' : 'monthly', invoice_month: monthStart(calendarYear, period.month), invoice_record_id: existingSpot?.id ?? existingMonthly?.id }).eq('tenant_deposit_id', deposit.tenant_deposit_id).is('invoice_record_id', null);
        if (recoveryError) throw recoveryError;
        setDeposits((current) => current.filter((item) => item.tenant_deposit_id !== selectedId));
        setNotice('既存の請求書と敷金管理表の紐づけを復旧しました。');
        onAdded();
        return;
      }
      // 参考CSVと同じく、敷金は「その他」・非課税・備考で内容を示します。
      const detail = depositInvoiceDetail(Number(deposit.amount), deposit.contract_unit?.lease_start_date ?? deposit.contract_unit?.contract?.contract_start_date ?? '', '敷金', billingSetting.invoice_item_1, billingSetting.invoice_item_2);
      const rowId = `deposit:manual:${deposit.tenant_deposit_id}`;
      let invoiceRecordId = rowId;
      let nextSheet: InvoiceSheet;
      if (mode === 'monthly') {
        const source = sheet.rows.find((row) => row.tenantId === tenantId && sheet.invoiceStatuses?.[row.invoiceKey]?.state !== 'issued');
        if (!source) throw new Error('編集可能な月次請求書がありません。スポット発行を選択してください。');
        const dueDate = source.values[4]?.trim();
        if (dueDate && dueDate !== dateText(deposit.payment_due_date)) throw new Error('月次請求書の入金期限と敷金期日が異なります。スポット発行を選択してください。');
        const row: InvoiceRow = { ...source, id: rowId, values: detail, chargeType: '敷金', depositId: deposit.tenant_deposit_id, postingAccountCode: billingSetting.account_code, postingSubaccountCode: billingSetting.subaccount_code, recurring: undefined };
        const rows = [...sheet.rows];
        if (!dueDate) {
          const firstIndex = rows.findIndex((item) => item.invoiceKey === source.invoiceKey);
          rows[firstIndex] = { ...rows[firstIndex], values: rows[firstIndex].values.map((value, column) => column === 4 ? dateText(deposit.payment_due_date) : value) };
        }
        const index = rows.reduce((found, item, position) => item.invoiceKey === source.invoiceKey ? position : found, -1);
        rows.splice(index + 1, 0, row);
        nextSheet = { ...sheet, rows: recalcInvoices(rows) };
      } else {
        const id = crypto.randomUUID();
        const values = [...detail];
        values[0] = '1'; values[1] = recipient.issue_code;
        values[2] = recipient.invoice_display_name || recipient.recipient_name || deposit.contract_unit?.contract?.tenant?.tenant_name || recipient.issue_code;
        values[3] = recipient.invoice_subject || `${propertyName} 敷金御請求書`;
        values[4] = dateText(deposit.payment_due_date);
        const depositRow: InvoiceRow = { id: rowId, invoiceKey: id, values, chargeType: '敷金', depositId: deposit.tenant_deposit_id, postingAccountCode: billingSetting.account_code, postingSubaccountCode: billingSetting.subaccount_code, tenantId: tenantId ?? '', tenantName: values[2], floor: deposit.contract_unit?.unit?.floor_label ?? '' };
        const lateCharges = lateContractFixedCharges({
          workflowCreatedAt: deposit.created_at,
          issuedAt: Object.values(sheet.invoiceStatuses ?? {}).map((status) => status.issuedAt),
          contractStart: deposit.contract_unit?.contract?.contract_start_date ?? null,
          leaseStart: deposit.contract_unit?.lease_start_date ?? null,
          monthlyRent: deposit.contract_unit?.monthly_rent_amount ?? null,
          monthlyCommonCharge: deposit.contract_unit?.monthly_common_charge_amount ?? null,
        });
        const fixedRows = lateCharges.map((charge, index): InvoiceRow => {
          const fixedValues = emptyValues();
          if (index === 0) for (let column = 0; column <= 4; column += 1) fixedValues[column] = values[column];
          fixedValues[10] = periodText(charge.periodStart, charge.periodEnd); fixedValues[11] = charge.name;
          fixedValues[15] = charge.amount.toLocaleString('ja-JP'); fixedValues[18] = '課税';
          fixedValues[20] = `※${dateText(charge.periodStart)}～契約`;
          return { ...depositRow, id: `${id}:late-fixed:${index}`, values: fixedValues, chargeType: charge.name, depositId: undefined, postingAccountCode: undefined, postingSubaccountCode: undefined };
        });
        const spot: SpotInvoice = { id, postingMonth: monthStart(calendarYear, period.month), createdAt: new Date().toISOString(), state: 'draft', rows: recalcInvoices([...fixedRows, depositRow]) };
        nextSheet = { ...sheet, spotInvoices: [...(sheet.spotInvoices ?? []), spot] };
        invoiceRecordId = id;
      }
      await saveInvoiceSheet(supabase, propertyId, calendarYear, period.month, nextSheet);
      const { data: updated, error: updateError } = await supabase.from('tenant_deposit_management').update({ invoice_method: mode, invoice_month: monthStart(calendarYear, period.month), invoice_record_id: invoiceRecordId }).eq('tenant_deposit_id', deposit.tenant_deposit_id).is('invoice_record_id', null).select('tenant_deposit_id');
      if (updateError) throw new Error(`請求書に追加しましたが、敷金管理表の更新に失敗しました: ${updateError.message}`);
      if (!updated?.length) throw new Error('請求書に追加しましたが、敷金管理表が既に更新されています。画面を再読み込みして確認してください。');
      setDeposits((current) => current.filter((item) => item.tenant_deposit_id !== selectedId));
      setNotice(mode === 'monthly' ? '月次請求書に敷金を追加しました。' : '敷金と、月次発行に間に合わなかった固定費のスポット請求書を作成しました。');
      onAdded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '敷金を追加できませんでした。'); }
    finally { setBusy(false); }
  };

  if (!deposits.length && !error && !notice) return null;
  return <section className="deposit-invoice-panel"><div><strong>敷金請求</strong><span>営業部が入金期日を設定した敷金を請求書へ追加します。</span></div><select aria-label="請求する敷金" value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={busy}><option value="">敷金を選択</option>{deposits.map((item) => <option value={item.tenant_deposit_id} key={item.tenant_deposit_id}>{item.contract_unit?.contract?.tenant?.tenant_name} / {item.contract_unit?.unit?.floor_label} {item.contract_unit?.unit?.unit_code} / {Number(item.amount).toLocaleString('ja-JP')}円 / 期日 {item.payment_due_date}</option>)}</select><button type="button" onClick={() => void addDeposit()} disabled={!selectedId || busy}>{mode === 'monthly' ? '月次請求に追加' : 'スポット請求に追加'}</button>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</section>;
}
