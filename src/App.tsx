import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { FinancialPage } from './FinancialPage';
import { LeasingMapPage } from './LeasingMapPage';
import { ContractDocumentPage } from './ContractDocumentPage';

type ContractStatus = '起案' | '審査' | '契約書作成' | '締結' | '完了';
type ContractType = '新規' | '更新';
type ViewMode = 'table' | 'board';

type Contract = {
  id: string;
  property: string;
  tenant: string;
  type: ContractType;
  startDate: string;
  endDate: string;
  assignee: string;
  status: ContractStatus;
  note: string;
  updatedAt: string;
};

type ContractDraft = Omit<Contract, 'id' | 'updatedAt'>;

type LeaseContractRow = {
  lease_contract_id: string;
  contract_status: 'draft' | 'active' | 'terminated' | 'expired';
  contract_type: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  updated_at: string;
  tenant: { tenant_name: string } | null;
  contract_units: Array<{ unit: { property: { property_name: string } | null } | null }> | null;
};

type AccountRole = 'admin' | 'manager' | 'staff' | 'viewer';
type AccountStatus = 'pending' | 'active' | 'suspended';

type Employee = {
  employee_id: string;
  employee_name: string;
  email: string | null;
  employment_status: 'active' | 'inactive';
  department?: { department_name: string } | null;
};

type UserProfile = {
  user_id: string;
  employee_id: string | null;
  email: string;
  role: AccountRole;
  account_status: AccountStatus;
  approved_at: string | null;
  created_at: string;
  employee?: Pick<Employee, 'employee_name'> | null;
};

const statuses: ContractStatus[] = ['起案', '審査', '契約書作成', '締結', '完了'];
const properties = ['三共小山ビル', '三共仙台ビル', '三共横浜ビル', '三共梅田ビル', '三共福岡ビル'];
const assignees = ['本庄 幸人', '武田 敬介', '岡部 克則', '金藤 蒼月斗'];

const initialContracts: Contract[] = [
  { id: 'CT-26071', property: '三共横浜ビル', tenant: '株式会社オービット', type: '更新', startDate: '2026-09-01', endDate: '2028-08-31', assignee: '本庄 幸人', status: '契約書作成', note: '賃料改定の合意済み。契約書最終確認中。', updatedAt: '今日 10:24' },
  { id: 'CT-26072', property: '三共仙台ビル', tenant: '東北ソリューションズ株式会社', type: '新規', startDate: '2026-10-01', endDate: '2028-09-30', assignee: '武田 敬介', status: '審査', note: '社内稟議の承認待ち。', updatedAt: '今日 09:48' },
  { id: 'CT-26073', property: '三共梅田ビル', tenant: '株式会社フルスケール', type: '更新', startDate: '2026-08-01', endDate: '2028-07-31', assignee: '岡部 克則', status: '締結', note: '先方署名済み。原本到着待ち。', updatedAt: '昨日 16:12' },
  { id: 'CT-26074', property: '三共福岡ビル', tenant: '九州デジタル株式会社', type: '新規', startDate: '2026-11-01', endDate: '2029-10-31', assignee: '金藤 蒼月斗', status: '起案', note: '申込書を受領、条件精査を開始。', updatedAt: '昨日 14:31' },
  { id: 'CT-26068', property: '三共小山ビル', tenant: '北関東ロジスティクス株式会社', type: '更新', startDate: '2026-07-01', endDate: '2028-06-30', assignee: '本庄 幸人', status: '完了', note: '電子契約を締結し、保管登録済み。', updatedAt: '7月11日' },
  { id: 'CT-26069', property: '三共横浜ビル', tenant: 'アーバンデザイン合同会社', type: '新規', startDate: '2026-08-15', endDate: '2029-08-14', assignee: '武田 敬介', status: '審査', note: '与信資料の追加提出依頼中。', updatedAt: '7月10日' },
];

const blankDraft = (): ContractDraft => ({
  property: properties[0], tenant: '', type: '新規', startDate: '', endDate: '', assignee: assignees[0], status: '起案', note: '',
});

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractLoadError, setContractLoadError] = useState('');

  const loadProfile = async (nextSession: Session | null) => {
    setSession(nextSession);
    if (!nextSession || !supabase) { setProfile(null); setIsLoading(false); return; }
    setIsLoading(true);
    const { data, error } = await supabase
      .from('user_profiles')
      .select('user_id, employee_id, email, role, account_status, approved_at, created_at, employee:employee_master(employee_name)')
      .eq('user_id', nextSession.user.id)
      .maybeSingle();
    setProfile(error ? null : data as UserProfile | null);
    setIsLoading(false);
  };

  useEffect(() => {
    if (!supabase) { setIsLoading(false); return; }
    void supabase.auth.getSession().then(({ data }) => void loadProfile(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => void loadProfile(nextSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const client = supabase;
    if (!session || !client) {
      setContracts([]);
      return;
    }

    const loadContracts = async () => {
      setContractLoadError('');
      const { data, error } = await client
        .from('lease_contract')
        .select('lease_contract_id, contract_status, contract_type, contract_start_date, contract_end_date, updated_at, tenant:tenant_master(tenant_name), contract_units:lease_contract_unit(unit:unit_master(property:property_master(property_name)))')
        .order('updated_at', { ascending: false });

      if (error) {
        setContracts([]);
        setContractLoadError(`契約データを読み込めませんでした: ${error.message}`);
        return;
      }

      const statusByLeaseStatus: Record<LeaseContractRow['contract_status'], ContractStatus> = {
        draft: statuses[0], active: statuses[2], terminated: statuses[3], expired: statuses[4],
      };
      setContracts(((data ?? []) as unknown as LeaseContractRow[]).map((contract) => ({
        id: contract.lease_contract_id,
        property: contract.contract_units?.[0]?.unit?.property?.property_name ?? '未設定',
        tenant: contract.tenant?.tenant_name ?? '未設定',
        type: contract.contract_type === 'renewal' ? initialContracts[0].type : initialContracts[1].type,
        startDate: contract.contract_start_date ?? '', endDate: contract.contract_end_date ?? '', assignee: '未設定',
        status: statusByLeaseStatus[contract.contract_status], note: '',
        updatedAt: new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium' }).format(new Date(contract.updated_at)),
      })));
    };

    void loadContracts();
  }, [session?.user.id]);

  const signOut = async () => { await supabase?.auth.signOut(); setSession(null); setProfile(null); };

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to={session ? '/dashboard' : '/login'} replace />} />
        <Route path="/login" element={session && profile?.account_status === 'active' ? <Navigate to="/dashboard" replace /> : <AuthPage mode="login" />} />
        <Route path="/signup" element={session && profile?.account_status === 'active' ? <Navigate to="/dashboard" replace /> : <AuthPage mode="signup" />} />
        <Route element={<ProtectedRoute session={session} profile={profile} isLoading={isLoading} />}>
          <Route element={<PortalLayout profile={profile!} onSignOut={signOut} />}>
            <Route path="/dashboard" element={<Dashboard contracts={contracts} userName={profile?.employee?.employee_name ?? profile?.email ?? 'ユーザー'} />} />
            <Route path="/financial" element={<FinancialPage />} />
            <Route path="/leasing-map" element={<LeasingMapPage />} />
            <Route path="/contracts" element={<ContractsPage contracts={contracts} setContracts={setContracts} canEdit={false} loadError={contractLoadError} />} />
            <Route path="/contract-documents" element={<Navigate to="/contracts/demo-ordinary-lease/document" replace />} />
            <Route path="/contracts/:contractId/document" element={<ContractDocumentPage />} />
            <Route path="/accounts" element={<AccountManagementPage currentUserId={session?.user.id ?? ''} />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to={session ? '/dashboard' : '/login'} replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function ProtectedRoute({ session, profile, isLoading }: { session: Session | null; profile: UserProfile | null; isLoading: boolean }) {
  const location = useLocation();
  if (!isSupabaseConfigured) return <ConfigurationRequired />;
  if (isLoading) return <main className="state-screen"><div className="state-card"><span className="loading-mark" /><h1>アカウント情報を確認しています</h1><p>しばらくお待ちください。</p></div></main>;
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!profile) return <AccountStatePage state="profile-missing" />;
  if (profile.account_status !== 'active') return <AccountStatePage state={profile.account_status} />;
  return <Outlet />;
}

function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const isSignUp = mode === 'signup';

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSignUp && !name.trim()) return setError('氏名を入力してください。');
    if (!email.includes('@')) return setError('メールアドレスを正しく入力してください。');
    if (password.length < 6) return setError('パスワードは6文字以上で入力してください。');
    if (!supabase) return setError('Supabaseの接続情報が設定されていません。');
    setError(''); setNotice(''); setIsSubmitting(true);
    const result = isSignUp
      ? await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim() } } })
      : await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setIsSubmitting(false);
    if (result.error) return setError(result.error.message);
    if (isSignUp && !result.data.session) setNotice('確認メールを送信しました。メールのリンクを開いて登録を完了してください。');
    else navigate('/dashboard', { replace: true });
  };

  return <main className="auth-screen">
    <section className="auth-showcase">
      <div className="brand"><span className="brand-mark">S</span><span>SHARE PORTAL</span></div>
      <div className="auth-message"><p className="eyebrow">PROPERTY OPERATIONS</p><h1>契約業務を、<br />もっと見通しよく。</h1><p>契約の進捗、対応期限、チームの動きを一つのポータルで管理します。</p></div>
      <div className="auth-preview"><span>本日の業務状況</span><strong>8<span>件</span></strong><p>対応が必要な契約があります</p></div>
    </section>
    <section className="auth-form-area">
      <div className="auth-form-wrap">
        <div className="mobile-brand brand"><span className="brand-mark">S</span><span>SHARE PORTAL</span></div>
        <p className="eyebrow">WELCOME</p><h2>{isSignUp ? 'アカウントを作成' : 'おかえりなさい'}</h2><p className="muted">{isSignUp ? '必要事項を入力して利用を開始してください。' : 'ログインして業務をはじめましょう。'}</p>
        <form onSubmit={submit} noValidate>
          {isSignUp && <label>氏名<input value={name} onChange={(e) => setName(e.target.value)} placeholder="例）山田 太郎" autoComplete="name" /></label>}
          <label>メールアドレス<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="email" /></label>
          <label>パスワード<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="6文字以上" autoComplete={isSignUp ? 'new-password' : 'current-password'} /></label>
          {error && <p className="form-error">{error}</p>}
          {notice && <p className="form-notice">{notice}</p>}
          <button className="primary-button full" type="submit" disabled={isSubmitting || !isSupabaseConfigured}>{isSubmitting ? '処理中…' : isSignUp ? 'アカウントを作成' : 'ログインする'} <span>→</span></button>
        </form>
        <p className="auth-switch">{isSignUp ? 'すでにアカウントをお持ちですか？' : 'アカウントをお持ちでない方'} <NavLink to={isSignUp ? '/login' : '/signup'}>{isSignUp ? 'ログイン' : '新規登録'}</NavLink></p>
        <p className="demo-note">登録済みの従業員メールアドレスは担当者へ自動紐づけされます。</p>
      </div>
    </section>
  </main>;
}

function PortalLayout({ profile, onSignOut }: { profile: UserProfile; onSignOut: () => Promise<void> }) {
  const navigate = useNavigate();
  const location = useLocation();
  const pageTitle = location.pathname === '/contracts' ? '契約業務フロー' : location.pathname.startsWith('/contract-documents') || location.pathname.endsWith('/document') ? '契約書作成' : location.pathname === '/accounts' ? 'アカウント管理' : location.pathname === '/financial' ? '収支管理' : location.pathname === '/leasing-map' ? 'リーシング図面' : 'ダッシュボード';
  const logout = async () => { await onSignOut(); navigate('/login', { replace: true }); };
  const userName = profile.employee?.employee_name ?? profile.email;
  return <div className="portal-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">S</span><span>SHARE PORTAL</span></div><p className="workspace-label">WORKSPACE</p>
      <nav><NavLink to="/dashboard" className="nav-item"><span>▦</span>ダッシュボード</NavLink><NavLink to="/financial" className="nav-item"><span>¥</span>収支管理</NavLink><NavLink to="/contracts" className="nav-item"><span>◇</span>契約業務フロー</NavLink><NavLink to="/contract-documents" className="nav-item"><span>▤</span>契約書作成</NavLink><NavLink to="/leasing-map" className="nav-item"><span>▱</span>リーシング図面</NavLink>{profile.role === 'admin' && <NavLink to="/accounts" className="nav-item"><span>♙</span>アカウント管理</NavLink>}</nav>
      <p className="workspace-label">COMING SOON</p><nav className="disabled-nav"><span><i>▤</i>物件管理</span><span><i>◫</i>収支管理</span><span><i>♙</i>マスタ管理</span></nav>
      <div className="sidebar-footer"><div className="help-card"><span>?</span><div><strong>お困りですか？</strong><small>ヘルプセンターを見る</small></div></div></div>
    </aside>
    <main className="portal-main"><header className="topbar"><div><p className="breadcrumb">ホーム / {pageTitle}</p><h1>{pageTitle}</h1></div><div className="user-menu"><button className="notification" aria-label="通知">♧<b>3</b></button><div className="avatar">{userName.slice(0, 1)}</div><div className="user-name"><strong>{userName}</strong><small>{roleLabel(profile.role)}</small></div><button className="logout-button" onClick={() => void logout()}>ログアウト</button></div></header><div className="page-content"><Outlet /></div></main>
  </div>;
}

function ConfigurationRequired() { return <main className="state-screen"><div className="state-card"><p className="eyebrow">CONFIGURATION REQUIRED</p><h1>Supabaseの接続設定が必要です</h1><p><code>VITE_SUPABASE_URL</code> と <code>VITE_SUPABASE_ANON_KEY</code> を <code>.env.local</code> に設定してください。</p></div></main>; }

function AccountStatePage({ state }: { state: 'pending' | 'suspended' | 'profile-missing' }) {
  const navigate = useNavigate();
  const content = state === 'pending'
    ? { title: '管理者の承認待ちです', body: '登録は完了しました。担当者との紐づけと権限設定が完了すると、業務ポータルを利用できます。' }
    : state === 'suspended'
      ? { title: 'このアカウントは利用停止中です', body: '利用を再開するには、システム管理者へお問い合わせください。' }
      : { title: 'プロフィールを確認できません', body: 'アカウント情報の作成が完了していません。システム管理者へお問い合わせください。' };
  return <main className="state-screen"><div className="state-card"><p className="eyebrow">ACCOUNT STATUS</p><h1>{content.title}</h1><p>{content.body}</p><button className="secondary-button" onClick={() => navigate('/login')}>ログイン画面へ戻る</button></div></main>;
}

function AccountManagementPage({ currentUserId }: { currentUserId: string }) {
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selected, setSelected] = useState<UserProfile | null>(null);
  const [filter, setFilter] = useState<AccountStatus | 'all'>('all');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const loadData = async () => {
    if (!supabase) return;
    setIsLoading(true);
    const [profileResult, employeeResult] = await Promise.all([
      supabase.from('user_profiles').select('user_id, employee_id, email, role, account_status, approved_at, created_at, employee:employee_master(employee_name)').order('created_at', { ascending: false }),
      supabase.from('employee_master').select('employee_id, employee_name, email, employment_status, department:department_master(department_name)').order('employee_name'),
    ]);
    if (profileResult.error || employeeResult.error) {
      setMessage(`アカウント情報を読み込めませんでした: ${profileResult.error?.message ?? employeeResult.error?.message}`);
      setIsLoading(false);
      return;
    }
    if (profileResult.error || employeeResult.error) setMessage('アカウント情報を読み込めませんでした。権限とRLS設定を確認してください。');
    else { setProfiles(profileResult.data as unknown as UserProfile[]); setEmployees(employeeResult.data as unknown as Employee[]); }
    setIsLoading(false);
  };

  useEffect(() => { void loadData(); }, []);
  const filteredProfiles = profiles.filter((profile) => filter === 'all' || profile.account_status === filter);
  const save = async (draft: Pick<UserProfile, 'employee_id' | 'role' | 'account_status'>) => {
    if (!supabase || !selected) return;
    if (draft.account_status === 'active' && !draft.employee_id) { setMessage('有効化するには担当者を選択してください。'); return; }
    const approval = draft.account_status === 'active' ? { approved_at: new Date().toISOString(), approved_by: currentUserId } : { approved_at: null, approved_by: null };
    const { error } = await supabase.from('user_profiles').update({ ...draft, ...approval }).eq('user_id', selected.user_id);
    if (error) { setMessage(`保存できませんでした: ${error.message}`); return; }
    setSelected(null); setMessage('アカウント情報を更新しました。'); await loadData();
  };

  return <>
    <section className="page-heading"><div><p className="section-kicker">ADMINISTRATION</p><h2>アカウント管理</h2><p>ログインアカウント、担当者の紐づけ、権限、利用状態を管理します。</p></div></section>
    {message && <div className="account-message">{message}<button onClick={() => setMessage('')}>×</button></div>}
    <section className="account-summary"><SummaryCard label="承認待ち" value={profiles.filter((profile) => profile.account_status === 'pending').length} tone="orange" /><SummaryCard label="有効なアカウント" value={profiles.filter((profile) => profile.account_status === 'active').length} tone="green" /><SummaryCard label="利用停止中" value={profiles.filter((profile) => profile.account_status === 'suspended').length} tone="gray" /></section>
    <section className="account-panel"><header><div><h3>アカウント一覧</h3><p>未照合アカウントは、担当者を設定して承認してください。</p></div><select value={filter} onChange={(event) => setFilter(event.target.value as AccountStatus | 'all')}><option value="all">すべての状態</option><option value="pending">承認待ち</option><option value="active">有効</option><option value="suspended">利用停止</option></select></header>
      {isLoading ? <div className="empty-state"><strong>読み込み中です…</strong></div> : <div className="table-wrap"><table className="account-table"><thead><tr><th>メールアドレス</th><th>担当者・部門</th><th>ロール</th><th>状態</th><th>登録日時</th><th /></tr></thead><tbody>{filteredProfiles.map((profile) => { const employee = employees.find((item) => item.employee_id === profile.employee_id); return <tr key={profile.user_id}><td><strong>{profile.email}</strong></td><td>{employee ? <><strong>{employee.employee_name}</strong><small>{employee.department?.department_name ?? '部門未設定'}</small></> : <span className="unlinked">未紐づけ</span>}</td><td><span className="role-pill">{roleLabel(profile.role)}</span></td><td><AccountStatusBadge status={profile.account_status} /></td><td>{new Date(profile.created_at).toLocaleDateString('ja-JP')}</td><td><button className="row-action" onClick={() => setSelected(profile)}>{profile.account_status === 'pending' ? '承認・設定' : '編集'}</button></td></tr>; })}</tbody></table></div>}
    </section>
    {selected && <AccountModal profile={selected} employees={employees} profiles={profiles} onClose={() => setSelected(null)} onSave={save} />}
  </>;
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: string }) { return <article className={`summary-card ${tone}`}><p>{label}</p><strong>{value}<small>件</small></strong></article>; }
function AccountStatusBadge({ status }: { status: AccountStatus }) { const label = status === 'pending' ? '承認待ち' : status === 'active' ? '有効' : '利用停止'; return <span className={`account-status ${status}`}>{label}</span>; }
function roleLabel(role: AccountRole) { return role === 'admin' ? 'システム管理者' : role === 'manager' ? '業務管理者' : role === 'staff' ? '担当者' : '参照専用'; }

function AccountModal({ profile, employees, profiles, onClose, onSave }: { profile: UserProfile; employees: Employee[]; profiles: UserProfile[]; onClose: () => void; onSave: (draft: Pick<UserProfile, 'employee_id' | 'role' | 'account_status'>) => Promise<void> }) {
  const [employeeId, setEmployeeId] = useState(profile.employee_id ?? '');
  const [role, setRole] = useState<AccountRole>(profile.role);
  const [status, setStatus] = useState<AccountStatus>(profile.account_status);
  const [isSaving, setIsSaving] = useState(false);
  const unavailableEmployeeIds = new Set(profiles.filter((item) => item.user_id !== profile.user_id && item.employee_id).map((item) => item.employee_id));
  const availableEmployees = employees.filter((employee) => employee.employment_status === 'active' && (!unavailableEmployeeIds.has(employee.employee_id) || employee.employee_id === profile.employee_id));
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setIsSaving(true); await onSave({ employee_id: employeeId || null, role, account_status: status }); setIsSaving(false); };
  return <div className="modal-backdrop"><form className="modal account-modal" onSubmit={(event) => void submit(event)}><header><div><p className="eyebrow">ACCOUNT SETTINGS</p><h2>アカウントを設定</h2></div><button type="button" className="modal-close" onClick={onClose}>×</button></header><div className="modal-body"><div className="read-only-field"><span>メールアドレス</span><strong>{profile.email}</strong></div><label>担当者<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">未紐づけ</option>{availableEmployees.map((employee) => <option value={employee.employee_id} key={employee.employee_id}>{employee.employee_name}（{employee.department?.department_name ?? '部門未設定'}）</option>)}</select></label><div className="form-grid"><label>ロール<select value={role} onChange={(event) => setRole(event.target.value as AccountRole)}><option value="admin">システム管理者</option><option value="manager">業務管理者</option><option value="staff">担当者</option><option value="viewer">参照専用</option></select></label><label>アカウント状態<select value={status} onChange={(event) => setStatus(event.target.value as AccountStatus)}><option value="pending">承認待ち</option><option value="active">有効</option><option value="suspended">利用停止</option></select></label></div><p className="modal-hint">有効化には、在籍中かつ他のアカウントに未紐づけの担当者を設定してください。</p></div><footer><button type="button" className="secondary-button" onClick={onClose}>キャンセル</button><button className="primary-button" type="submit" disabled={isSaving}>{isSaving ? '保存中…' : '保存する'}</button></footer></form></div>;
}

function Dashboard({ contracts, userName }: { contracts: Contract[]; userName: string }) {
  const active = contracts.filter((item) => item.status !== '完了').length;
  const due = contracts.filter((item) => item.status !== '完了').slice(0, 4);
  const statusCount = statuses.map((status) => ({ status, count: contracts.filter((item) => item.status === status).length }));
  return <>
    <section className="welcome-row"><div><p className="section-kicker">2026年7月14日（火）</p><h2>おはようございます、{userName}さん</h2><p>本日の契約業務の状況です。</p></div><NavLink className="primary-button" to="/contracts">契約を確認する <span>→</span></NavLink></section>
    <section className="metric-grid"><Metric label="進行中の契約" value={active} unit="件" detail="前月比 +2件" icon="◫" tone="blue" /><Metric label="今月の締結予定" value={2} unit="件" detail="締結予定日：7月31日" icon="✓" tone="green" /><Metric label="対応期限超過" value={1} unit="件" detail="至急確認が必要です" icon="!" tone="red" /><Metric label="承認待ち" value={2} unit="件" detail="最長 3日間保留中" icon="◷" tone="orange" /></section>
    <section className="dashboard-grid"><article className="panel due-panel"><div className="panel-title"><div><h3>対応期限が近い契約</h3><p>直近30日以内に対応が必要な契約</p></div><NavLink to="/contracts">すべて見る</NavLink></div><div className="due-list">{due.map((contract, index) => <div className="due-row" key={contract.id}><div className={`date-badge ${index === 0 ? 'urgent' : ''}`}><strong>{index === 0 ? '18' : index === 1 ? '22' : index === 2 ? '25' : '30'}</strong><span>7月</span></div><div className="due-details"><strong>{contract.tenant}</strong><span>{contract.property} ・ {contract.type}契約</span></div><StatusBadge status={contract.status} /><span className="chevron">›</span></div>)}</div></article>
      <article className="panel progress-panel"><div className="panel-title"><div><h3>契約進捗</h3><p>ステータス別の件数</p></div><button className="text-button">詳細を見る</button></div><div className="progress-list">{statusCount.map((item) => <div className="progress-row" key={item.status}><div><span className={`dot dot-${statusClass(item.status)}`} />{item.status}</div><div className="progress-track"><i style={{ width: `${Math.max((item.count / Math.max(contracts.length, 1)) * 100, item.count ? 13 : 0)}%` }} /></div><strong>{item.count}<small>件</small></strong></div>)}</div></article>
      <article className="panel updates-panel"><div className="panel-title"><div><h3>最近の更新</h3><p>チームの最新アクティビティ</p></div></div><div className="update-list">{contracts.slice(0, 4).map((contract, index) => <div className="update-row" key={contract.id}><span className={`activity-icon activity-${index}`}>{index === 0 ? '✎' : index === 1 ? '✓' : '◷'}</span><div><p><strong>{contract.assignee}</strong> が「{contract.tenant}」を{index === 0 ? '更新しました' : index === 1 ? '承認しました' : '確認しました'}</p><small>{contract.updatedAt}</small></div></div>)}</div></article>
    </section>
  </>;
}

function Metric({ label, value, unit, detail, icon, tone }: { label: string; value: number; unit: string; detail: string; icon: string; tone: string }) { return <article className="metric-card"><div><p>{label}</p><strong>{value}<small>{unit}</small></strong><span className={tone === 'red' ? 'negative' : ''}>{tone === 'blue' ? '↗ ' : ''}{detail}</span></div><i className={`metric-icon ${tone}`}>{icon}</i></article>; }

function ContractsPage({ contracts, setContracts, canEdit, loadError }: { contracts: Contract[]; setContracts: React.Dispatch<React.SetStateAction<Contract[]>>; canEdit: boolean; loadError: string }) {
  const [view, setView] = useState<ViewMode>('table'); const [query, setQuery] = useState(''); const [property, setProperty] = useState(''); const [type, setType] = useState(''); const [status, setStatus] = useState(''); const [editing, setEditing] = useState<Contract | null>(null); const [isCreating, setIsCreating] = useState(false); const [toast, setToast] = useState('');
  const filtered = useMemo(() => contracts.filter((contract) => (!query || [contract.id, contract.tenant, contract.property, contract.assignee].some((value) => value.toLowerCase().includes(query.toLowerCase()))) && (!property || contract.property === property) && (!type || contract.type === type) && (!status || contract.status === status)), [contracts, query, property, type, status]);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2800); };
  const save = (draft: ContractDraft, id?: string) => { if (id) { setContracts((items) => items.map((item) => item.id === id ? { ...item, ...draft, updatedAt: 'たった今' } : item)); notify('契約情報を更新しました。'); } else { const nextId = `CT-26${String(75 + contracts.length).padStart(2, '0')}`; setContracts((items) => [{ id: nextId, ...draft, updatedAt: 'たった今' }, ...items]); notify('新しい契約を追加しました。'); } setEditing(null); setIsCreating(false); };
  const move = (contract: Contract, next: ContractStatus) => { setContracts((items) => items.map((item) => item.id === contract.id ? { ...item, status: next, updatedAt: 'たった今' } : item)); notify(`「${contract.tenant}」を${next}へ移動しました。`); };
  return <>
    {loadError && <div className="account-message">{loadError}</div>}
    <section className="page-heading"><div><p>賃貸借契約の進捗と担当状況を管理します。</p></div>{canEdit && <button className="primary-button" onClick={() => setIsCreating(true)}>＋ 契約を追加</button>}</section>
    <section className="filter-panel"><div className="search-box"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="契約ID・テナント名・物件名で検索" /></div><select value={property} onChange={(e) => setProperty(e.target.value)}><option value="">すべての物件</option>{properties.map((value) => <option key={value}>{value}</option>)}</select><select value={type} onChange={(e) => setType(e.target.value)}><option value="">契約種別</option><option>新規</option><option>更新</option></select><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">すべてのステータス</option>{statuses.map((value) => <option key={value}>{value}</option>)}</select><button className="clear-button" onClick={() => { setQuery(''); setProperty(''); setType(''); setStatus(''); }}>条件をクリア</button></section>
    <section className="contracts-toolbar"><p><strong>{filtered.length}</strong> 件の契約</p><div className="view-switch"><button className={view === 'table' ? 'selected' : ''} onClick={() => setView('table')}>☷ 一覧</button><button className={view === 'board' ? 'selected' : ''} onClick={() => setView('board')}>▦ ボード</button></div></section>
    {view === 'table' ? <ContractTable contracts={filtered} onEdit={setEditing} canEdit={canEdit} /> : <ContractBoard contracts={filtered} onEdit={setEditing} onMove={move} canEdit={canEdit} />}
    {(editing || isCreating) && <ContractModal contract={editing ?? undefined} onClose={() => { setEditing(null); setIsCreating(false); }} onSave={save} />}
    {toast && <div className="toast">✓ {toast}</div>}
  </>;
}

function ContractTable({ contracts, onEdit, canEdit }: { contracts: Contract[]; onEdit: (contract: Contract) => void; canEdit: boolean }) { return <div className="table-panel"><div className="table-wrap"><table><thead><tr><th>契約ID</th><th>テナント・物件</th><th>種別</th><th>契約期間</th><th>担当者</th><th>ステータス</th><th aria-label="契約書" />{canEdit && <th aria-label="操作" />}</tr></thead><tbody>{contracts.map((contract) => <tr key={contract.id}><td><strong className="contract-id">{contract.id}</strong></td><td><strong>{contract.tenant}</strong><small>{contract.property}</small></td><td><span className={`type-pill ${contract.type === '新規' ? 'new' : ''}`}>{contract.type}</span></td><td>{formatDate(contract.startDate)}<span className="date-separator">〜</span>{formatDate(contract.endDate)}</td><td><span className="table-person">{contract.assignee.slice(0, 1)}</span>{contract.assignee}</td><td><StatusBadge status={contract.status} /></td><td><NavLink className="row-action" to={`/contracts/${contract.id}/document`}>契約書作成</NavLink></td>{canEdit && <td><button className="row-action" onClick={() => onEdit(contract)}>編集</button></td>}</tr>)}</tbody></table></div>{contracts.length === 0 && <EmptyState />}</div>; }

function ContractBoard({ contracts, onEdit, onMove, canEdit }: { contracts: Contract[]; onEdit: (contract: Contract) => void; onMove: (contract: Contract, status: ContractStatus) => void; canEdit: boolean }) { return <div className="board">{statuses.map((status) => <section className="board-column" key={status}><header><div><span className={`dot dot-${statusClass(status)}`} />{status}</div><b>{contracts.filter((item) => item.status === status).length}</b></header><div className="board-cards">{contracts.filter((item) => item.status === status).map((contract) => <article className="board-card" key={contract.id}><div className="board-card-head"><span className={`type-pill ${contract.type === '新規' ? 'new' : ''}`}>{contract.type}</span>{canEdit && <button onClick={() => onEdit(contract)}>•••</button>}</div><h3>{contract.tenant}</h3><p>{contract.property}</p><div className="board-dates">◷ {formatDate(contract.startDate)}〜</div><footer><span className="table-person">{contract.assignee.slice(0, 1)}</span>{canEdit ? <select aria-label={`${contract.tenant} のステータス`} value={contract.status} onChange={(e) => onMove(contract, e.target.value as ContractStatus)}>{statuses.map((value) => <option key={value}>{value}</option>)}</select> : <StatusBadge status={contract.status} />}</footer></article>)}</div></section>)}</div>; }

function ContractModal({ contract, onClose, onSave }: { contract?: Contract; onClose: () => void; onSave: (draft: ContractDraft, id?: string) => void }) { const [draft, setDraft] = useState<ContractDraft>(contract ? { property: contract.property, tenant: contract.tenant, type: contract.type, startDate: contract.startDate, endDate: contract.endDate, assignee: contract.assignee, status: contract.status, note: contract.note } : blankDraft()); const update = <K extends keyof ContractDraft>(key: K, value: ContractDraft[K]) => setDraft((item) => ({ ...item, [key]: value })); const submit = (e: FormEvent) => { e.preventDefault(); if (!draft.tenant.trim() || !draft.startDate || !draft.endDate) return; onSave(draft, contract?.id); };
  return <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={submit}><header><div><p className="eyebrow">CONTRACT</p><h2>{contract ? '契約情報を編集' : '契約を追加'}</h2></div><button type="button" className="modal-close" onClick={onClose}>×</button></header><div className="modal-body"><div className="form-grid"><label>契約種別<select value={draft.type} onChange={(e) => update('type', e.target.value as ContractType)}><option>新規</option><option>更新</option></select></label><label>進捗ステータス<select value={draft.status} onChange={(e) => update('status', e.target.value as ContractStatus)}>{statuses.map((value) => <option key={value}>{value}</option>)}</select></label><label>物件<select value={draft.property} onChange={(e) => update('property', e.target.value)}>{properties.map((value) => <option key={value}>{value}</option>)}</select></label><label>担当者<select value={draft.assignee} onChange={(e) => update('assignee', e.target.value)}>{assignees.map((value) => <option key={value}>{value}</option>)}</select></label></div><label>テナント名<input value={draft.tenant} onChange={(e) => update('tenant', e.target.value)} placeholder="例）株式会社サンプル" required /></label><div className="form-grid"><label>契約開始日<input type="date" value={draft.startDate} onChange={(e) => update('startDate', e.target.value)} required /></label><label>契約終了日<input type="date" value={draft.endDate} onChange={(e) => update('endDate', e.target.value)} required /></label></div><label>備考<textarea value={draft.note} onChange={(e) => update('note', e.target.value)} placeholder="連絡事項や進捗メモを入力" rows={3} /></label></div><footer><button type="button" className="secondary-button" onClick={onClose}>キャンセル</button><button className="primary-button" type="submit">{contract ? '変更を保存' : '契約を追加'}</button></footer></form></div>; }

function StatusBadge({ status }: { status: ContractStatus }) { return <span className={`status-badge ${statusClass(status)}`}><i />{status}</span>; }
function EmptyState() { return <div className="empty-state"><strong>該当する契約がありません</strong><p>検索条件を変更してもう一度お試しください。</p></div>; }
function statusClass(status: ContractStatus) { return status === '起案' ? 'draft' : status === '審査' ? 'review' : status === '契約書作成' ? 'document' : status === '締結' ? 'signing' : 'complete'; }
function formatDate(value: string) { return value ? value.replace(/-/g, '/') : '未設定'; }

export default App;
