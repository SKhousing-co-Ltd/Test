import { useEffect, useRef, useState, type FormEvent } from 'react';
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
import { RentRollPage } from './RentRollPage';
import { LeasingMapPage } from './LeasingMapPage';
import { ContractDocumentPage } from './ContractDocumentPage';
import { AppsuiteSyncPage } from './AppsuiteSyncPage';
import { ContractWorkflowPage } from './ContractWorkflowPage';
import { ChangeRequestWorkbenchPage } from './ChangeRequestWorkbenchPage';
import { ProcurementPage } from './ProcurementPage';
import { OperationsDashboard } from './OperationsDashboard';
import { ParkingPage } from './ParkingPage';
import { TenantBillingCodesPage } from './TenantBillingCodesPage';
import { contractCapabilitiesForRole, type AccountRole } from './lib/contract-capabilities';

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
  contract_units: Array<{ unit: { asset: { asset_name: string } | null } | null }> | null;
};

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

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const currentUserIdRef = useRef<string | null>(null);
  const profileRequestIdRef = useRef(0);

  const loadProfile = async (nextSession: Session | null, blockUi = false) => {
    const requestedUserId = nextSession?.user.id ?? null;
    const requestId = ++profileRequestIdRef.current;
    currentUserIdRef.current = requestedUserId;
    setSession(nextSession);
    if (!nextSession || !supabase) { setProfile(null); setIsLoading(false); return; }
    if (blockUi) setIsLoading(true);
    const { data, error } = await supabase
      .from('user_profiles')
      .select('user_id, employee_id, email, role, account_status, approved_at, created_at, employee:employee_master(employee_name)')
      .eq('user_id', nextSession.user.id)
      .maybeSingle();
    if (requestId !== profileRequestIdRef.current || currentUserIdRef.current !== requestedUserId) return;
    if (!error || blockUi) setProfile(error ? null : data as UserProfile | null);
    if (blockUi) setIsLoading(false);
  };

  useEffect(() => {
    if (!supabase) { setIsLoading(false); return; }
    void supabase.auth.getSession().then(({ data }) => void loadProfile(data.session, true));
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'INITIAL_SESSION') return;

      if (event === 'TOKEN_REFRESHED' && nextSession?.user.id === currentUserIdRef.current) {
        setSession(nextSession);
        return;
      }

      const userChanged = (nextSession?.user.id ?? null) !== currentUserIdRef.current;
      void loadProfile(nextSession, userChanged);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const signOut = async () => { await supabase?.auth.signOut(); setSession(null); setProfile(null); };

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Navigate to={session ? '/dashboard' : '/login'} replace />} />
        <Route path="/login" element={session && profile?.account_status === 'active' ? <Navigate to="/dashboard" replace /> : <AuthPage mode="login" />} />
        <Route path="/signup" element={session && profile?.account_status === 'active' ? <Navigate to="/dashboard" replace /> : <AuthPage mode="signup" />} />
        <Route element={<ProtectedRoute session={session} profile={profile} isLoading={isLoading} />}>
          <Route element={<PortalLayout profile={profile!} onSignOut={signOut} />}>
            <Route path="/dashboard" element={<OperationsDashboard userName={profile?.employee?.employee_name ?? profile?.email ?? 'ユーザー'} />} />
            <Route path="/financial" element={<FinancialPage canManage={profile?.role === 'admin' || profile?.role === 'manager'} />} />
            <Route path="/procurement" element={<ProcurementPage canEdit={profile?.role !== 'viewer'} canManageVendors={profile?.role === 'admin' || profile?.role === 'manager'} />} />
            <Route path="/rent-roll" element={<RentRollPage capabilities={contractCapabilitiesForRole(profile?.role ?? 'viewer')} />} />
            <Route path="/tenants" element={<TenantBillingCodesPage canManage={profile?.role === 'admin' || profile?.role === 'manager'} />} />
            <Route path="/parking" element={<ParkingPage canManage={profile?.role === 'admin' || profile?.role === 'manager'} />} />
            <Route path="/change-requests" element={<ChangeRequestWorkbenchPage role={profile?.role ?? 'viewer'} />} />
            <Route path="/appsuite-sync" element={<AppsuiteSyncPage isAdmin={profile?.role === 'admin'} />} />
            <Route path="/leasing-map" element={<LeasingMapPage />} />
            <Route path="/contracts" element={<ContractWorkflowPage canComplete={profile?.role !== 'viewer'} />} />
            <Route path="/contract-documents" element={<Navigate to="/contracts/90528c83-bff1-485b-8bc1-1b74bad9d6f7/document" replace />} />
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
      <div className="auth-preview"><span>業務データを一元管理</span><strong>LIVE</strong><p>契約・レントロール・発注支払・収支を最新状態で確認</p></div>
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
  const pageTitle = location.pathname === '/appsuite-sync' ? 'AppSuite同期' : location.pathname === '/change-requests' ? '対応依頼' : location.pathname === '/contracts' ? '契約業務フロー' : location.pathname.startsWith('/contract-documents') || location.pathname.endsWith('/document') ? '契約書作成' : location.pathname === '/accounts' ? 'アカウント管理' : location.pathname === '/tenants' ? '請求コード管理' : location.pathname === '/procurement' ? '発注・請求・支払管理' : location.pathname === '/financial' ? '収支管理' : location.pathname === '/rent-roll' ? 'レントロール' : location.pathname === '/parking' ? '駐車場台帳' : location.pathname === '/leasing-map' ? 'リーシング図面' : 'ダッシュボード';
  const logout = async () => { await onSignOut(); navigate('/login', { replace: true }); };
  const userName = profile.employee?.employee_name ?? profile.email;
  return <div className="portal-shell"><NavLink to="/appsuite-sync" className="appsuite-sync-shortcut">AppSuite同期</NavLink>
    <aside className="sidebar"><div className="brand"><span className="brand-mark">S</span><span>SHARE PORTAL</span></div><p className="workspace-label">WORKSPACE</p>
      <nav><NavLink to="/dashboard" className="nav-item"><span>▦</span>ダッシュボード</NavLink><NavLink to="/change-requests" className="nav-item"><span>✓</span>対応依頼</NavLink><NavLink to="/financial" className="nav-item"><span>¥</span>収支管理</NavLink><NavLink to="/procurement" className="nav-item"><span>◫</span>発注・請求・支払</NavLink><NavLink to="/rent-roll" className="nav-item"><span>▤</span>レントロール</NavLink><NavLink to="/tenants" className="nav-item"><span>♙</span>請求コード</NavLink><NavLink to="/parking" className="nav-item"><span>Ⓟ</span>駐車場台帳</NavLink><NavLink to="/contracts" className="nav-item"><span>◇</span>契約業務フロー</NavLink><NavLink to="/contract-documents" className={({ isActive }) => isActive || location.pathname.endsWith('/document') ? 'nav-item active' : 'nav-item'}><span>▤</span>契約書作成</NavLink><NavLink to="/leasing-map" className="nav-item"><span>▱</span>リーシング図面</NavLink>{profile.role === 'admin' && <NavLink to="/accounts" className="nav-item"><span>♙</span>アカウント管理</NavLink>}</nav>
      <p className="workspace-label">COMING SOON</p><nav className="disabled-nav"><span><i>▤</i>物件管理</span><span><i>◫</i>収支管理</span><span><i>♙</i>マスタ管理</span></nav>
      <div className="sidebar-footer"><div className="help-card"><span>?</span><div><strong>お困りですか？</strong><small>ヘルプセンターを見る</small></div></div></div>
    </aside>
    <main className="portal-main"><header className="topbar"><div><p className="breadcrumb">ホーム / {pageTitle}</p><h1>{pageTitle}</h1></div><div className="user-menu"><div className="avatar">{userName.slice(0, 1)}</div><div className="user-name"><strong>{userName}</strong><small>{roleLabel(profile.role)}</small></div><button className="logout-button" onClick={() => void logout()}>ログアウト</button></div></header><div className="page-content"><Outlet /></div></main>
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

export default App;
