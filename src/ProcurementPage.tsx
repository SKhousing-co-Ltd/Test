import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Dialog } from './components/Dialog';
import { supabase } from './lib/supabase';

type Tab = 'orders' | 'invoices' | 'cashflow' | 'integrations';
type Property = { asset_id: string; asset_name: string; short_name: string | null };
type Account = { account_id: string; account_name: string };
type Vendor = { vendor_id: string; vendor_code: string; vendor_name: string; billone_supplier_id: string | null; is_active: boolean };
type OrderStatus = 'draft' | 'pending_approval' | 'approved' | 'ordered' | 'partially_invoiced' | 'invoiced' | 'completed' | 'cancelled';
type InvoiceStatus = 'received' | 'matched' | 'approved' | 'scheduled' | 'paid' | 'rejected';

type Order = {
  procurement_order_id: string;
  order_number: string;
  property_id: string;
  asset_name: string;
  account_id: string;
  account_name: string;
  vendor_id: string;
  vendor_name: string;
  order_type: 'repair' | 'brokerage' | 'other';
  title: string;
  ordered_amount: number;
  invoiced_amount: number;
  uninvoiced_amount: number;
  paid_amount: number;
  order_date: string | null;
  expected_payment_date: string | null;
  next_payment_date: string | null;
  status: OrderStatus;
  appsuite_ringi_number: string | null;
};

type Invoice = {
  vendor_invoice_id: string;
  property_id: string;
  account_id: string;
  vendor_id: string;
  invoice_number: string | null;
  billone_invoice_id: string | null;
  invoice_date: string;
  due_date: string;
  gross_amount: number;
  status: InvoiceStatus;
  property: { asset_name: string } | null;
  vendor: { vendor_name: string } | null;
  account: { account_name: string } | null;
};

type Cashflow = {
  payment_schedule_id: string;
  vendor_invoice_id: string;
  property_id: string;
  asset_name: string;
  account_name: string;
  vendor_name: string;
  invoice_number: string | null;
  billone_invoice_id: string | null;
  scheduled_date: string;
  amount: number;
  status: 'unscheduled' | 'scheduled' | 'processing' | 'paid' | 'cancelled';
  paid_date: string | null;
};

type AppsuiteInbox = {
  appsuite_procurement_inbox_id: string;
  ringi_number: string | null;
  property_name: string | null;
  vendor_name: string | null;
  title: string | null;
  gross_amount: number | null;
  match_status: 'action_required' | 'ready' | 'imported' | 'ignored';
  issues: string[];
  imported_procurement_order_id: string | null;
};

type BilloneInbox = {
  billone_invoice_inbox_id: string;
  source_invoice_id: string;
  invoice_number: string | null;
  supplier_name: string | null;
  property_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  gross_amount: number | null;
  match_status: 'action_required' | 'ready' | 'imported' | 'ignored';
  issues: string[];
  imported_vendor_invoice_id: string | null;
};

type OrderDraft = {
  property_id: string;
  account_id: string;
  vendor_id: string;
  order_type: Order['order_type'];
  title: string;
  description: string;
  gross_amount: number;
  order_date: string;
  expected_completion_date: string;
  expected_payment_date: string;
  appsuite_ringi_number: string;
};

const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
const today = new Date().toISOString().slice(0, 10);
const firstOfMonth = (value: string) => `${value.slice(0, 7)}-01`;
const orderStatusLabel: Record<OrderStatus, string> = {
  draft: '起案中', pending_approval: '承認待ち', approved: '承認済', ordered: '発注済',
  partially_invoiced: '一部請求', invoiced: '請求済', completed: '完了', cancelled: '取消',
};
const invoiceStatusLabel: Record<InvoiceStatus, string> = {
  received: '受領', matched: '発注照合済', approved: '承認済', scheduled: '支払予定', paid: '支払済', rejected: '差戻し',
};
const typeLabel = { repair: '修繕費', brokerage: '仲介料', other: 'その他' } as const;

export function ProcurementPage({ canEdit, canManageVendors }: { canEdit: boolean; canManageVendors: boolean }) {
  const [tab, setTab] = useState<Tab>('orders');
  const [properties, setProperties] = useState<Property[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [cashflow, setCashflow] = useState<Cashflow[]>([]);
  const [appsuiteInbox, setAppsuiteInbox] = useState<AppsuiteInbox[]>([]);
  const [billoneInbox, setBilloneInbox] = useState<BilloneInbox[]>([]);
  const [query, setQuery] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [notice, setNotice] = useState('');
  const [orderDialog, setOrderDialog] = useState(false);
  const [invoiceDialog, setInvoiceDialog] = useState(false);
  const [vendorDialog, setVendorDialog] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!supabase) return;
    setLoading(true); setNotice('');
    const [propertyResult, accountResult, vendorResult, orderResult, invoiceResult, cashflowResult, appsuiteInboxResult, billoneInboxResult] = await Promise.all([
      supabase.from('asset_master').select('asset_id, asset_name, short_name').order('asset_name'),
      supabase.from('income_expense_account_master').select('account_id, account_name').eq('income_expense_type', '支出').order('account_id'),
      supabase.from('vendor_master').select('vendor_id, vendor_code, vendor_name, billone_supplier_id, is_active').eq('is_active', true).order('vendor_name'),
      supabase.from('procure_to_pay_overview').select('*').order('updated_at', { ascending: false }),
      supabase.from('vendor_invoice').select('vendor_invoice_id, property_id, account_id, vendor_id, invoice_number, billone_invoice_id, invoice_date, due_date, gross_amount, status, property:asset_master(asset_name), vendor:vendor_master(vendor_name), account:income_expense_account_master(account_name)').order('invoice_date', { ascending: false }),
      supabase.from('payable_cashflow').select('*').order('scheduled_date'),
      supabase.from('appsuite_procurement_inbox').select('appsuite_procurement_inbox_id, ringi_number, property_name, vendor_name, title, gross_amount, match_status, issues, imported_procurement_order_id').order('updated_at', { ascending: false }).limit(500),
      supabase.from('billone_invoice_inbox').select('billone_invoice_inbox_id, source_invoice_id, invoice_number, supplier_name, property_name, invoice_date, due_date, gross_amount, match_status, issues, imported_vendor_invoice_id').order('last_received_at', { ascending: false }).limit(500),
    ]);
    const error = [propertyResult, accountResult, vendorResult, orderResult, invoiceResult, cashflowResult, appsuiteInboxResult, billoneInboxResult].find((result) => result.error)?.error;
    if (error) setNotice(`発注・支払データを読み込めませんでした: ${error.message}`);
    setProperties((propertyResult.data ?? []) as Property[]);
    setAccounts((accountResult.data ?? []) as Account[]);
    setVendors((vendorResult.data ?? []) as Vendor[]);
    setOrders((orderResult.data ?? []) as Order[]);
    setInvoices((invoiceResult.data ?? []) as unknown as Invoice[]);
    setCashflow((cashflowResult.data ?? []) as Cashflow[]);
    setAppsuiteInbox((appsuiteInboxResult.data ?? []) as AppsuiteInbox[]);
    setBilloneInbox((billoneInboxResult.data ?? []) as BilloneInbox[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP');
  const filteredOrders = useMemo(() => orders.filter((order) =>
    (!propertyId || order.property_id === propertyId)
    && (!normalizedQuery || [order.order_number, order.asset_name, order.vendor_name, order.title, order.appsuite_ringi_number ?? '']
      .some((value) => value.toLocaleLowerCase('ja-JP').includes(normalizedQuery))),
  ), [orders, propertyId, normalizedQuery]);
  const filteredInvoices = useMemo(() => invoices.filter((invoice) =>
    (!propertyId || invoice.property_id === propertyId)
    && (!normalizedQuery || [invoice.invoice_number ?? '', invoice.billone_invoice_id ?? '', invoice.property?.asset_name ?? '', invoice.vendor?.vendor_name ?? '']
      .some((value) => value.toLocaleLowerCase('ja-JP').includes(normalizedQuery))),
  ), [invoices, propertyId, normalizedQuery]);
  const filteredCashflow = useMemo(() => cashflow.filter((payment) =>
    (!propertyId || payment.property_id === propertyId)
    && (!normalizedQuery || [payment.invoice_number ?? '', payment.billone_invoice_id ?? '', payment.asset_name, payment.vendor_name]
      .some((value) => value.toLocaleLowerCase('ja-JP').includes(normalizedQuery))),
  ), [cashflow, propertyId, normalizedQuery]);

  const metrics = {
    openOrders: orders.filter((order) => !['completed', 'cancelled'].includes(order.status)).reduce((sum, order) => sum + Number(order.ordered_amount), 0),
    uninvoiced: orders.reduce((sum, order) => sum + Number(order.uninvoiced_amount), 0),
    unpaid: cashflow.filter((payment) => !['paid', 'cancelled'].includes(payment.status)).reduce((sum, payment) => sum + Number(payment.amount), 0),
    overdue: cashflow.filter((payment) => !['paid', 'cancelled'].includes(payment.status) && payment.scheduled_date < today).length,
  };

  const updateOrderStatus = async (order: Order, status: OrderStatus) => {
    if (!supabase) return;
    const { error } = await supabase.from('procurement_order').update({ status }).eq('procurement_order_id', order.procurement_order_id);
    if (error) setNotice(error.message); else void load();
  };
  const updateInvoiceStatus = async (invoice: Invoice, status: InvoiceStatus) => {
    if (!supabase) return;
    if (status === 'paid' && !confirm(`${invoice.vendor?.vendor_name ?? '取引先'}への${yen.format(Number(invoice.gross_amount))}を支払済みにしますか？`)) return;
    const { error } = await supabase.rpc('set_vendor_invoice_status', {
      p_vendor_invoice_id: invoice.vendor_invoice_id, p_status: status,
      p_paid_date: status === 'paid' ? today : null, p_payment_reference: null,
    });
    if (error) setNotice(error.message); else void load();
  };
  const refreshMatches = async () => {
    if (!supabase) return;
    setLoading(true);
    const { error } = await supabase.rpc('refresh_external_procurement_inboxes');
    if (error) { setNotice(error.message); setLoading(false); } else await load();
  };
  const commitAppsuite = async (id: string) => {
    if (!supabase) return;
    const { error } = await supabase.rpc('commit_appsuite_procurement_inbox', { target_id: id });
    if (error) setNotice(error.message); else await load();
  };
  const commitBillone = async (id: string) => {
    if (!supabase) return;
    const { error } = await supabase.rpc('commit_billone_invoice_inbox', { target_id: id });
    if (error) setNotice(error.message); else await load();
  };

  return <section className="procurement-page">
    <div className="page-heading"><div><p className="section-kicker">PROCURE TO PAY</p><h2>発注・請求・支払管理</h2><p>修繕費・仲介料を、発注からBill One請求書、支払、物件収支まで一つの流れで管理します。</p></div><div className="procurement-actions">{canManageVendors && <button className="secondary-button" onClick={() => setVendorDialog(true)}>取引先登録</button>}{canEdit && <button className="secondary-button" onClick={() => setInvoiceDialog(true)} disabled={!vendors.length}>請求書を登録</button>}{canEdit && <button className="primary-button" onClick={() => setOrderDialog(true)} disabled={!vendors.length}>発注を登録</button>}</div></div>
    {notice && <p className="procurement-notice">{notice}</p>}
    {!vendors.length && !loading && <p className="procurement-notice warning">最初に取引先を登録してください。取引先マスタは管理者・業務管理者が登録できます。</p>}
    <div className="procurement-metrics">
      <Metric label="進行中の発注額" value={metrics.openOrders} tone="blue" />
      <Metric label="未請求残高" value={metrics.uninvoiced} tone="orange" />
      <Metric label="支払予定残高" value={metrics.unpaid} tone="green" />
      <article className="procurement-metric red"><span>支払期日超過</span><strong>{metrics.overdue}<small>件</small></strong></article>
    </div>
    <nav className="procurement-tabs"><button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>発注一覧</button><button className={tab === 'invoices' ? 'active' : ''} onClick={() => setTab('invoices')}>請求書</button><button className={tab === 'cashflow' ? 'active' : ''} onClick={() => setTab('cashflow')}>支払予定・資金繰り</button><button className={tab === 'integrations' ? 'active' : ''} onClick={() => setTab('integrations')}>外部連携受信箱</button></nav>
    {tab !== 'integrations' && <div className="procurement-toolbar"><label className="procurement-search">検索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="番号、物件、取引先、件名" /></label><label>物件<select value={propertyId} onChange={(event) => setPropertyId(event.target.value)}><option value="">すべての物件</option>{properties.map((property) => <option key={property.asset_id} value={property.asset_id}>{property.short_name || property.asset_name}</option>)}</select></label></div>}
    {tab === 'orders' && <OrderTable orders={filteredOrders} canEdit={canEdit} onStatus={updateOrderStatus} loading={loading} />}
    {tab === 'invoices' && <InvoiceTable invoices={filteredInvoices} canEdit={canEdit} onStatus={updateInvoiceStatus} loading={loading} />}
    {tab === 'cashflow' && <CashflowTable payments={filteredCashflow} loading={loading} />}
    {tab === 'integrations' && <IntegrationInbox appsuiteItems={appsuiteInbox} billoneItems={billoneInbox} canEdit={canEdit} loading={loading} onRefresh={refreshMatches} onCommitAppsuite={commitAppsuite} onCommitBillone={commitBillone} />}
    {orderDialog && <OrderDialog properties={properties} accounts={accounts} vendors={vendors} onClose={() => setOrderDialog(false)} onSaved={() => { setOrderDialog(false); void load(); }} />}
    {invoiceDialog && <InvoiceDialog properties={properties} accounts={accounts} vendors={vendors} orders={orders.filter((order) => !['completed', 'cancelled', 'invoiced'].includes(order.status))} onClose={() => setInvoiceDialog(false)} onSaved={() => { setInvoiceDialog(false); void load(); }} />}
    {vendorDialog && <VendorDialog onClose={() => setVendorDialog(false)} onSaved={() => { setVendorDialog(false); void load(); }} />}
  </section>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) { return <article className={`procurement-metric ${tone}`}><span>{label}</span><strong>{yen.format(value)}</strong></article>; }

function OrderTable({ orders, canEdit, onStatus, loading }: { orders: Order[]; canEdit: boolean; onStatus: (order: Order, status: OrderStatus) => void; loading: boolean }) {
  const nextStatus = (status: OrderStatus): { status: OrderStatus; label: string } | null => status === 'draft' ? { status: 'pending_approval', label: '承認申請' } : status === 'pending_approval' ? { status: 'approved', label: '承認反映' } : status === 'approved' ? { status: 'ordered', label: '発注済にする' } : status === 'invoiced' ? { status: 'completed', label: '完了' } : null;
  return <div className="procurement-panel"><div className="table-wrap"><table className="procurement-table"><thead><tr><th>発注番号／種別</th><th>物件・件名</th><th>取引先</th><th>発注額</th><th>請求済／未請求</th><th>支払</th><th>状態</th><th>稟議番号</th><th /></tr></thead><tbody>{loading && <tr><td colSpan={9} className="procurement-empty">読み込み中…</td></tr>}{!loading && orders.map((order) => { const next = nextStatus(order.status); return <tr key={order.procurement_order_id}><td><strong>{order.order_number}</strong><small>{typeLabel[order.order_type]}</small></td><td><strong>{order.title}</strong><small>{order.asset_name}｜{order.account_name}</small></td><td>{order.vendor_name}</td><td className="numeric">{yen.format(Number(order.ordered_amount))}</td><td className="numeric">{yen.format(Number(order.invoiced_amount))}<small>残 {yen.format(Number(order.uninvoiced_amount))}</small></td><td className="numeric">{yen.format(Number(order.paid_amount))}<small>{order.next_payment_date ? `次回 ${order.next_payment_date}` : '予定なし'}</small></td><td><Status value={order.status} label={orderStatusLabel[order.status]} /></td><td>{order.appsuite_ringi_number || '—'}</td><td>{canEdit && next && <button className="row-action" onClick={() => onStatus(order, next.status)}>{next.label}</button>}</td></tr>; })}{!loading && !orders.length && <tr><td colSpan={9} className="procurement-empty">条件に一致する発注はありません。</td></tr>}</tbody></table></div></div>;
}

function InvoiceTable({ invoices, canEdit, onStatus, loading }: { invoices: Invoice[]; canEdit: boolean; onStatus: (invoice: Invoice, status: InvoiceStatus) => void; loading: boolean }) {
  const nextStatus = (status: InvoiceStatus): { status: InvoiceStatus; label: string } | null => ['received', 'matched'].includes(status) ? { status: 'approved', label: '承認' } : status === 'approved' ? { status: 'scheduled', label: '支払予定' } : status === 'scheduled' ? { status: 'paid', label: '支払済' } : null;
  return <div className="procurement-panel"><div className="table-wrap"><table className="procurement-table"><thead><tr><th>請求書番号</th><th>Bill One ID</th><th>物件・科目</th><th>取引先</th><th>請求日</th><th>支払期日</th><th>金額</th><th>状態</th><th /></tr></thead><tbody>{loading && <tr><td colSpan={9} className="procurement-empty">読み込み中…</td></tr>}{!loading && invoices.map((invoice) => { const next = nextStatus(invoice.status); return <tr key={invoice.vendor_invoice_id}><td><strong>{invoice.invoice_number || '番号なし'}</strong></td><td>{invoice.billone_invoice_id || '手動登録'}</td><td><strong>{invoice.property?.asset_name ?? '—'}</strong><small>{invoice.account?.account_name ?? '—'}</small></td><td>{invoice.vendor?.vendor_name ?? '—'}</td><td>{invoice.invoice_date}</td><td className={invoice.status !== 'paid' && invoice.due_date < today ? 'overdue' : ''}>{invoice.due_date}</td><td className="numeric"><strong>{yen.format(Number(invoice.gross_amount))}</strong></td><td><Status value={invoice.status} label={invoiceStatusLabel[invoice.status]} /></td><td>{canEdit && next && <button className="row-action" onClick={() => onStatus(invoice, next.status)}>{next.label}</button>}</td></tr>; })}{!loading && !invoices.length && <tr><td colSpan={9} className="procurement-empty">条件に一致する請求書はありません。</td></tr>}</tbody></table></div></div>;
}

function CashflowTable({ payments, loading }: { payments: Cashflow[]; loading: boolean }) { return <div className="procurement-panel"><div className="table-wrap"><table className="procurement-table"><thead><tr><th>支払予定日</th><th>物件・科目</th><th>取引先</th><th>請求書番号</th><th>Bill One ID</th><th>金額</th><th>状態</th><th>支払日</th></tr></thead><tbody>{loading && <tr><td colSpan={8} className="procurement-empty">読み込み中…</td></tr>}{!loading && payments.map((payment) => <tr key={payment.payment_schedule_id}><td className={payment.status !== 'paid' && payment.scheduled_date < today ? 'overdue' : ''}><strong>{payment.scheduled_date}</strong></td><td><strong>{payment.asset_name}</strong><small>{payment.account_name}</small></td><td>{payment.vendor_name}</td><td>{payment.invoice_number || '番号なし'}</td><td>{payment.billone_invoice_id || '手動登録'}</td><td className="numeric"><strong>{yen.format(Number(payment.amount))}</strong></td><td><Status value={payment.status} label={payment.status === 'paid' ? '支払済' : payment.status === 'scheduled' ? '支払予定' : '未予定'} /></td><td>{payment.paid_date || '—'}</td></tr>)}{!loading && !payments.length && <tr><td colSpan={8} className="procurement-empty">支払予定はありません。</td></tr>}</tbody></table></div></div>; }
function Status({ value, label }: { value: string; label: string }) { return <span className={`procurement-status ${value}`}>{label}</span>; }

function IntegrationInbox({ appsuiteItems, billoneItems, canEdit, loading, onRefresh, onCommitAppsuite, onCommitBillone }: { appsuiteItems: AppsuiteInbox[]; billoneItems: BilloneInbox[]; canEdit: boolean; loading: boolean; onRefresh: () => void; onCommitAppsuite: (id: string) => void; onCommitBillone: (id: string) => void }) {
  const statusLabel = (status: AppsuiteInbox['match_status']) => status === 'ready' ? '照合済み' : status === 'imported' ? '反映済み' : status === 'ignored' ? '対象外' : '要確認';
  return <div className="integration-inbox">
    <div className="integration-inbox-heading"><div><h3>外部連携受信箱</h3><p>AppSuiteの決裁済み発注とBill One請求書を照合し、準備が整った行だけ台帳へ反映します。</p></div>{canEdit && <button className="secondary-button" disabled={loading} onClick={onRefresh}>マスタと再照合</button>}</div>
    <section className="procurement-panel"><header className="integration-source-heading"><div><strong>AppSuite 修繕発注</strong><small>取引先未登録などの行は、問題を解消してから再照合します。</small></div><span>{appsuiteItems.filter((item) => item.match_status === 'action_required').length}件 要確認</span></header><div className="table-wrap"><table className="procurement-table"><thead><tr><th>稟議番号</th><th>物件・発注内容</th><th>取引先</th><th>金額</th><th>照合</th><th /></tr></thead><tbody>{appsuiteItems.map((item) => <tr key={item.appsuite_procurement_inbox_id}><td>{item.ringi_number ?? '—'}</td><td><strong>{item.title ?? '内容未設定'}</strong><small>{item.property_name ?? '物件未特定'}</small></td><td>{item.vendor_name ?? '—'}</td><td className="numeric">{item.gross_amount ? yen.format(Number(item.gross_amount)) : '—'}</td><td><Status value={item.match_status} label={statusLabel(item.match_status)} />{item.issues.length > 0 && <small>{item.issues.join('／')}</small>}</td><td>{canEdit && item.match_status === 'ready' && <button className="row-action" onClick={() => onCommitAppsuite(item.appsuite_procurement_inbox_id)}>発注へ反映</button>}</td></tr>)}{!appsuiteItems.length && <tr><td colSpan={6} className="procurement-empty">AppSuiteアプリID 87を同期すると、決裁済みの発注候補が表示されます。</td></tr>}</tbody></table></div></section>
    <section className="procurement-panel"><header className="integration-source-heading"><div><strong>Bill One 請求書</strong><small>連携受信APIが同じ請求書IDを再受信しても重複登録しません。</small></div><span>{billoneItems.filter((item) => item.match_status === 'action_required').length}件 要確認</span></header><div className="table-wrap"><table className="procurement-table"><thead><tr><th>Bill One ID／請求書番号</th><th>物件・取引先</th><th>請求日／支払期日</th><th>金額</th><th>照合</th><th /></tr></thead><tbody>{billoneItems.map((item) => <tr key={item.billone_invoice_inbox_id}><td><strong>{item.source_invoice_id}</strong><small>{item.invoice_number ?? '番号なし'}</small></td><td><strong>{item.supplier_name ?? '取引先未特定'}</strong><small>{item.property_name ?? '物件未特定'}</small></td><td>{item.invoice_date ?? '—'}<small>{item.due_date ? `支払 ${item.due_date}` : '支払期日なし'}</small></td><td className="numeric">{item.gross_amount ? yen.format(Number(item.gross_amount)) : '—'}</td><td><Status value={item.match_status} label={statusLabel(item.match_status)} />{item.issues.length > 0 && <small>{item.issues.join('／')}</small>}</td><td>{canEdit && item.match_status === 'ready' && <button className="row-action" onClick={() => onCommitBillone(item.billone_invoice_inbox_id)}>請求書へ反映</button>}</td></tr>)}{!billoneItems.length && <tr><td colSpan={6} className="procurement-empty">Bill One連携受信APIから届いた請求書はここに表示されます。</td></tr>}</tbody></table></div></section>
  </div>;
}

function OrderDialog({ properties, accounts, vendors, onClose, onSaved }: { properties: Property[]; accounts: Account[]; vendors: Vendor[]; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<OrderDraft>({ property_id: properties[0]?.asset_id ?? '', account_id: accounts[0]?.account_id ?? '', vendor_id: vendors[0]?.vendor_id ?? '', order_type: 'repair', title: '', description: '', gross_amount: 0, order_date: today, expected_completion_date: '', expected_payment_date: '', appsuite_ringi_number: '' });
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => { event.preventDefault(); if (!supabase) return; setSaving(true); const { error: saveError } = await supabase.from('procurement_order').insert({ ...draft, description: draft.description || null, expected_completion_date: draft.expected_completion_date || null, expected_payment_date: draft.expected_payment_date || null, appsuite_ringi_number: draft.appsuite_ringi_number || null, order_date: draft.order_date || null, gross_amount: Number(draft.gross_amount), status: draft.appsuite_ringi_number ? 'pending_approval' : 'draft' }); setSaving(false); if (saveError) setError(saveError.message); else onSaved(); };
  return <Dialog title="発注を登録" onClose={onClose}><form className="procurement-form" onSubmit={save}><Field label="物件"><select value={draft.property_id} onChange={(e) => setDraft({ ...draft, property_id: e.target.value })}>{properties.map((item) => <option value={item.asset_id} key={item.asset_id}>{item.asset_name}</option>)}</select></Field><Field label="取引先"><select value={draft.vendor_id} onChange={(e) => setDraft({ ...draft, vendor_id: e.target.value })}>{vendors.map((item) => <option value={item.vendor_id} key={item.vendor_id}>{item.vendor_name}</option>)}</select></Field><Field label="区分"><select value={draft.order_type} onChange={(e) => setDraft({ ...draft, order_type: e.target.value as Order['order_type'] })}>{Object.entries(typeLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Field label="収支科目"><select value={draft.account_id} onChange={(e) => setDraft({ ...draft, account_id: e.target.value })}>{accounts.map((item) => <option value={item.account_id} key={item.account_id}>{item.account_name}</option>)}</select></Field><Field label="件名"><input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required /></Field><Field label="発注額（税込・円）"><input type="number" min="1" value={draft.gross_amount || ''} onChange={(e) => setDraft({ ...draft, gross_amount: Number(e.target.value) })} required /></Field><Field label="発注日"><input type="date" value={draft.order_date} onChange={(e) => setDraft({ ...draft, order_date: e.target.value })} /></Field><Field label="完了予定日"><input type="date" value={draft.expected_completion_date} onChange={(e) => setDraft({ ...draft, expected_completion_date: e.target.value })} /></Field><Field label="支払見込日"><input type="date" value={draft.expected_payment_date} onChange={(e) => setDraft({ ...draft, expected_payment_date: e.target.value })} /></Field><Field label="AppSuite稟議番号"><input value={draft.appsuite_ringi_number} onChange={(e) => setDraft({ ...draft, appsuite_ringi_number: e.target.value })} /></Field><Field label="内容"><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>{error && <p className="procurement-form-error">{error}</p>}<div className="procurement-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存'}</button></div></form></Dialog>;
}

function InvoiceDialog({ properties, accounts, vendors, orders, onClose, onSaved }: { properties: Property[]; accounts: Account[]; vendors: Vendor[]; orders: Order[]; onClose: () => void; onSaved: () => void }) {
  const [orderId, setOrderId] = useState(''); const [propertyId, setPropertyId] = useState(properties[0]?.asset_id ?? ''); const [accountId, setAccountId] = useState(accounts[0]?.account_id ?? ''); const [vendorId, setVendorId] = useState(vendors[0]?.vendor_id ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState(''); const [billoneId, setBilloneId] = useState(''); const [invoiceDate, setInvoiceDate] = useState(today); const [dueDate, setDueDate] = useState(today); const [subtotal, setSubtotal] = useState(0); const [tax, setTax] = useState(0); const [notes, setNotes] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const selectOrder = (id: string) => { setOrderId(id); const order = orders.find((item) => item.procurement_order_id === id); if (order) { setPropertyId(order.property_id); setAccountId(order.account_id); setVendorId(order.vendor_id); setSubtotal(Number(order.uninvoiced_amount)); setTax(0); } };
  const save = async (event: FormEvent) => { event.preventDefault(); if (!supabase) return; setSaving(true); const { error: saveError } = await supabase.rpc('register_vendor_invoice', { p_property_id: propertyId, p_account_id: accountId, p_vendor_id: vendorId, p_invoice_number: invoiceNumber, p_billone_invoice_id: billoneId, p_invoice_date: invoiceDate, p_due_date: dueDate, p_accounting_month: firstOfMonth(invoiceDate), p_subtotal_amount: Number(subtotal), p_tax_amount: Number(tax), p_procurement_order_id: orderId || null, p_notes: notes || null }); setSaving(false); if (saveError) setError(saveError.message); else onSaved(); };
  return <Dialog title="請求書を登録・照合" onClose={onClose}><form className="procurement-form" onSubmit={save}><Field label="照合する発注"><select value={orderId} onChange={(e) => selectOrder(e.target.value)}><option value="">発注なし／後で照合</option>{orders.map((order) => <option value={order.procurement_order_id} key={order.procurement_order_id}>{order.order_number}｜{order.title}｜残 {yen.format(Number(order.uninvoiced_amount))}</option>)}</select></Field><Field label="取引先"><select value={vendorId} disabled={Boolean(orderId)} onChange={(e) => setVendorId(e.target.value)}>{vendors.map((item) => <option value={item.vendor_id} key={item.vendor_id}>{item.vendor_name}</option>)}</select></Field><Field label="物件"><select value={propertyId} disabled={Boolean(orderId)} onChange={(e) => setPropertyId(e.target.value)}>{properties.map((item) => <option value={item.asset_id} key={item.asset_id}>{item.asset_name}</option>)}</select></Field><Field label="収支科目"><select value={accountId} disabled={Boolean(orderId)} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((item) => <option value={item.account_id} key={item.account_id}>{item.account_name}</option>)}</select></Field><Field label="請求書番号"><input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} /></Field><Field label="Bill One請求書ID"><input value={billoneId} onChange={(e) => setBilloneId(e.target.value)} /></Field><Field label="請求日"><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required /></Field><Field label="支払期日"><input type="date" min={invoiceDate} value={dueDate} onChange={(e) => setDueDate(e.target.value)} required /></Field><Field label="税抜額（円）"><input type="number" min="0" value={subtotal || ''} onChange={(e) => setSubtotal(Number(e.target.value))} required /></Field><Field label="消費税（円）"><input type="number" min="0" value={tax || ''} onChange={(e) => setTax(Number(e.target.value))} /></Field><div className="invoice-total"><span>税込合計</span><strong>{yen.format(subtotal + tax)}</strong></div><Field label="備考"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>{error && <p className="procurement-form-error">{error}</p>}<div className="procurement-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || subtotal + tax <= 0}>{saving ? '登録中…' : '請求書を登録'}</button></div></form></Dialog>;
}

function VendorDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) { const [code, setCode] = useState(''); const [name, setName] = useState(''); const [billoneId, setBilloneId] = useState(''); const [error, setError] = useState(''); const save = async (event: FormEvent) => { event.preventDefault(); if (!supabase) return; const { error: saveError } = await supabase.from('vendor_master').insert({ vendor_code: code.trim(), vendor_name: name.trim(), billone_supplier_id: billoneId.trim() || null }); if (saveError) setError(saveError.message); else onSaved(); }; return <Dialog title="取引先を登録" onClose={onClose}><form className="procurement-form" onSubmit={save}><Field label="取引先コード"><input value={code} onChange={(e) => setCode(e.target.value)} required /></Field><Field label="取引先名"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field><Field label="Bill One取引先ID"><input value={billoneId} onChange={(e) => setBilloneId(e.target.value)} /></Field>{error && <p className="procurement-form-error">{error}</p>}<div className="procurement-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">登録</button></div></form></Dialog>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="procurement-field"><span>{label}</span>{children}</label>; }
