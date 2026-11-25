import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
import { contractCapabilitiesForRole, type AccountRole } from './lib/contract-capabilities';
import { AdminConsoleHomePage, AdminConsoleLayout } from './AdminConsolePage';
import { AdminDevelopmentHomePage, AdminDevelopmentFeaturePage } from './AdminDevelopmentPage';
import { AdminOperationalRecordsPage } from './AdminOperationalRecordsPage';
import { DepositManagementPage } from './DepositManagementPage';
import { UserFeedbackWidget } from './UserFeedbackWidget';
import { RouteLoadingFallback } from './RouteLoadingFallback';

const FinancialPage = lazy(() => import('./FinancialPage').then((module) => ({ default: module.FinancialPage })));
const RentRollPage = lazy(() => import('./RentRollPage').then((module) => ({ default: module.RentRollPage })));
const LeasingMapPage = lazy(() => import('./LeasingMapPage').then((module) => ({ default: module.LeasingMapPage })));
const ContractDocumentPage = lazy(() => import('./ContractDocumentPage').then((module) => ({ default: module.ContractDocumentPage })));
const AppsuiteSyncPage = lazy(() => import('./AppsuiteSyncPage').then((module) => ({ default: module.AppsuiteSyncPage })));
const ApprovalInventoryPage = lazy(() => import('./ApprovalInventoryPage').then((module) => ({ default: module.ApprovalInventoryPage })));
const ContractWorkflowPage = lazy(() => import('./ContractWorkflowPage').then((module) => ({ default: module.ContractWorkflowPage })));
const ChangeRequestWorkbenchPage = lazy(() => import('./ChangeRequestWorkbenchPage').then((module) => ({ default: module.ChangeRequestWorkbenchPage })));
const ProcurementPage = lazy(() => import('./ProcurementPage').then((module) => ({ default: module.ProcurementPage })));
const OperationsDashboard = lazy(() => import('./OperationsDashboard').then((module) => ({ default: module.OperationsDashboard })));
const TenantBillingPage = lazy(() => import('./TenantBillingPage').then((module) => ({ default: module.TenantBillingPage })));
const ParkingPage = lazy(() => import('./ParkingPage').then((module) => ({ default: module.ParkingPage })));
const ParkingFeeCleanupPage = lazy(() => import('./ParkingFeeCleanupPage').then((module) => ({ default: module.ParkingFeeCleanupPage })));
const ContractBillingBulkPage = lazy(() => import('./ContractBillingBulkPage').then((module) => ({ default: module.ContractBillingBulkPage })));
const SchemaExplorerPage = lazy(() => import('./SchemaExplorerPage').then((module) => ({ default: module.SchemaExplorerPage })));
const AssetManagementPage = lazy(() => import('./AssetManagementPage').then((module) => ({ default: module.AssetManagementPage })));
const AssetRegistrationPage = lazy(() => import('./AssetRegistrationPage').then((module) => ({ default: module.AssetRegistrationPage })));
const TenantBillingSettingsPage = lazy(() => import('./TenantBillingSettingsPage').then((module) => ({ default: module.TenantBillingSettingsPage })));
const ContractInformationPage = lazy(() => import('./ContractInformationPage').then((module) => ({ default: module.ContractInformationPage })));
const CaseProgressMigrationPage = lazy(() => import('./CaseProgressMigrationPage').then((module) => ({ default: module.CaseProgressMigrationPage })));
const ContractAdminPage = lazy(() => import('./ContractAdminPage').then((module) => ({ default: module.ContractAdminPage })));
const PropertyProfitabilityPage = lazy(() => import('./PropertyProfitabilityPage').then((module) => ({ default: module.PropertyProfitabilityPage })));
const PropertyAcquisitionPlanPage = lazy(() => import('./PropertyAcquisitionPlanPage').then((module) => ({ default: module.PropertyAcquisitionPlanPage })));
const RentRollReconciliationPage = lazy(() => import('./RentRollReconciliationPage').then((module) => ({ default: module.RentRollReconciliationPage })));
const UserFeedbackAdminPage = lazy(() => import('./UserFeedbackAdminPage').then((module) => ({ default: module.UserFeedbackAdminPage })));

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
  must_change_password: boolean;
  approved_at: string | null;
  created_at: string;
  employee?: Pick<Employee, 'employee_name'> & { department?: { department_name: string } | null } | null;
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
      .select('user_id, employee_id, email, role, account_status, must_change_password, approved_at, created_at, employee:employee_master(employee_name, department:department_master(department_name))')
      .eq('user_id', nextSession.user.id)
      .maybeSingle();
    if (requestId !== profileRequestIdRef.current || currentUserIdRef.current !== requestedUserId) return;
    if (!error || blockUi) setProfile(error ? null : data as UserProfile | null);
    // A later, non-blocking auth event can supersede the initial blocking
    // request. The latest request must always release the route-level loader.
    setIsLoading(false);
  };

  useEffect(() => {
    if (!supabase) { setIsLoading(false); return; }
    let isMounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (isMounted) void loadProfile(data.session, true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'INITIAL_SESSION') return;

      if (event === 'TOKEN_REFRESHED' && nextSession?.user.id === currentUserIdRef.current) {
        setSession(nextSession);
        return;
      }

      const userChanged = (nextSession?.user.id ?? null) !== currentUserIdRef.current;
      // Supabase Auth holds an internal lock while notifying listeners. Defer
      // profile queries until the callback returns so they cannot block OAuth
      // session processing.
      window.setTimeout(() => {
        if (isMounted) void loadProfile(nextSession, userChanged);
      }, 0);
    });
    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => { await supabase?.auth.signOut(); setSession(null); setProfile(null); };

  const isAccountingDepartment = profile?.employee?.department?.department_name === '総務経理部';
  const canEditContractBillingTerms = profile?.role === 'admin' || isAccountingDepartment;

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Navigate to={session ? '/dashboard' : '/login'} replace />} />
        <Route path="/login" element={<LoginRoute session={session} profile={profile} />} />
        <Route element={<ProtectedRoute session={session} profile={profile} isLoading={isLoading} />}>
          <Route path="/change-password" element={<InitialPasswordChangePage onComplete={() => loadProfile(session, true)} />} />
          <Route element={<PortalLayout profile={profile!} onSignOut={signOut} />}>
            <Route path="/dashboard" element={<OperationsDashboard userName={profile?.employee?.employee_name ?? profile?.email ?? 'ユーザー'} />} />
            <Route path="/financial" element={<FinancialPage canManage={profile?.role === 'admin' || profile?.role === 'manager'} />} />
            <Route path="/property-profitability" element={<PropertyProfitabilityPage />} />
            <Route path="/property-profitability/plan" element={<PropertyAcquisitionPlanPage />} />
            <Route path="/procurement" element={<ProcurementPage canEdit={profile?.role !== 'viewer'} canManageVendors={profile?.role === 'admin' || profile?.role === 'manager'} />} />
            <Route path="/rent-roll" element={<RentRollPage capabilities={contractCapabilitiesForRole(profile?.role ?? 'viewer')} />} />
            <Route path="/contract-information" element={<ContractInformationPage canEditBillingTerms={canEditContractBillingTerms} />} />
            <Route path="/admin/contracts" element={<AdminContractPage role={profile?.role ?? 'viewer'} />} />
            <Route path="/billing-codes" element={<TenantBillingPage canEdit={profile?.role !== 'viewer'} canManageSettings={profile?.role === 'admin'} />} />
            <Route path="/parking" element={<ParkingPage canManage={profile?.role === 'admin' || profile?.role === 'manager'} />} />
            <Route path="/change-requests" element={<ChangeRequestWorkbenchPage role={profile?.role ?? 'viewer'} />} />
            <Route path="/appsuite-sync" element={<AppsuiteSyncPage isAdmin={profile?.role === 'admin'} />} />
            <Route path="/approval-inventory" element={<ApprovalInventoryPage />} />
            <Route path="/leasing-map" element={<LeasingMapPage />} />
            <Route path="/contracts" element={<ContractWorkflowPage role={profile?.role ?? 'viewer'} canComplete={profile?.role === 'admin' || (profile?.role !== 'viewer' && isAccountingDepartment)} />} />
            <Route path="/contract-documents" element={<ContractDocumentPage />} />
            <Route path="/contracts/:contractId/document" element={<ContractDocumentPage />} />
            <Route path="/case-progress-migration" element={<AdminOnly role={profile?.role ?? 'viewer'}><CaseProgressMigrationPage /></AdminOnly>} />
            <Route path="/admin/contract-billing-bulk" element={<ContractBillingBulkPage canEdit={canEditContractBillingTerms} />} />
          </Route>
          <Route element={<AdminConsoleOnly role={profile?.role ?? 'viewer'}><AdminConsoleLayout profile={profile!} onSignOut={signOut} /></AdminConsoleOnly>}>
            <Route path="/admin-console" element={<AdminConsoleHomePage />} />
            <Route path="/admin/development" element={<AdminDevelopmentHomePage />} />
            <Route path="/admin/development/deposits" element={<DepositManagementPage />} />
            <Route path="/admin/development/brokerage-fees" element={<AdminDevelopmentFeaturePage feature="brokerage-fees" />} />
            <Route path="/admin/development/garage-certificates" element={<AdminOperationalRecordsPage kind="garage" userId={session?.user.id ?? ''} userName={profile?.employee?.employee_name ?? profile?.email ?? ''} />} />
            <Route path="/admin/development/security-cards" element={<AdminOperationalRecordsPage kind="card" userId={session?.user.id ?? ''} userName={profile?.employee?.employee_name ?? profile?.email ?? ''} />} />
            <Route path="/accounts" element={<AccountManagementPage currentUserId={session?.user.id ?? ''} />} />
            <Route path="/admin/assets" element={<AssetRegistrationPage />} />
            <Route path="/settings/assets" element={<AssetManagementPage />} />
            <Route path="/settings/tenant-billing" element={<TenantBillingSettingsPage />} />
            <Route path="/admin/schema-explorer" element={<SchemaExplorerPage />} />
            <Route path="/admin/case-progress-migration" element={<CaseProgressMigrationPage />} />
            <Route path="/admin/parking-fee-cleanup" element={<ParkingFeeCleanupPage role={profile?.role ?? 'viewer'} />} />
            <Route path="/rent-roll/reconciliation" element={<RentRollReconciliationPage capabilities={contractCapabilitiesForRole(profile?.role ?? 'viewer')} />} />
            <Route path="/admin/user-feedback" element={<UserFeedbackAdminPage />} />
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
  if (profile.must_change_password && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  if (!profile.must_change_password && location.pathname === '/change-password') return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

function LoginRoute({ session, profile }: { session: Session | null; profile: UserProfile | null }) {
  const location = useLocation();
  const adminAccessDenied = Boolean((location.state as { adminAccessDenied?: boolean } | null)?.adminAccessDenied);
  const destination = new URLSearchParams(location.search).get('destination') === 'admin-console' ? '/admin-console' : '/dashboard';
  if (session && profile?.account_status === 'active' && !adminAccessDenied) return <Navigate to={destination} replace />;
  return <AuthPage adminAccessDenied={adminAccessDenied} />;
}

function AdminConsoleOnly({ role, children }: { role: AccountRole; children: ReactNode }) {
  return role === 'admin' ? <>{children}</> : <Navigate to="/login" state={{ adminAccessDenied: true }} replace />;
}

function AdminOnly({ role, children }: { role: AccountRole; children: ReactNode }) {
  return role === 'admin' ? <>{children}</> : <Navigate to="/dashboard" replace />;
}

function AdminContractPage({ role }: { role: AccountRole }) {
  return role === 'admin' || role === 'manager' ? <ContractAdminPage /> : <Navigate to="/dashboard" replace />;
}

function AuthPage({ adminAccessDenied = false }: { adminAccessDenied?: boolean }) {
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).has('error')
    ? 'Googleログインを完了できませんでした。@sk-housing.jp のアカウントを選択して再度お試しください。'
    : '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const signInWithGoogle = async (destination: 'dashboard' | 'admin-console' = 'dashboard') => {
    if (!supabase) return setError('Supabaseの接続情報が設定されていません。');
    setError('');
    setIsSubmitting(true);
    const redirectUrl = new URL('login', new URL(import.meta.env.BASE_URL, window.location.origin));
    if (destination === 'admin-console') redirectUrl.searchParams.set('destination', destination);
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl.toString(),
        queryParams: { hd: 'sk-housing.jp', prompt: 'select_account' },
      },
    });
    if (signInError) {
      setIsSubmitting(false);
      setError('Googleログインを開始できませんでした。時間をおいて再度お試しください。');
    }
  };

  return <main className="auth-screen">
    <section className="auth-showcase">
      <div className="brand auth-brand"><span className="brand-mark">要</span><span>KANAME</span></div>
      <div className="auth-architecture" aria-hidden="true"><span /><span /><span /></div>
      <div className="auth-message"><p className="eyebrow">PROPERTY OPERATIONS</p><p className="auth-tagline">A MORE EFFICIENT<br />PROPERTY TOMORROW</p></div>
      <div className="auth-preview"><span>Knowledge, Assets, Navigation</span><strong>KANAME</strong><p>Administration・Management・Efficiency</p></div>
    </section>
    <section className="auth-form-area">
      <div className="auth-form-wrap">
        <div className="mobile-brand brand"><span className="brand-mark">要</span><span>KANAME</span></div>
        <p className="eyebrow">WELCOME</p><h2>おかえりなさい</h2><p className="muted">ログインして業務をはじめましょう。</p>
        {adminAccessDenied && <p className="form-error">管理者権限がありません。管理者アカウントでログインしてください。</p>}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button full" type="button" onClick={() => void signInWithGoogle()} disabled={isSubmitting || !isSupabaseConfigured}>
          {isSubmitting ? 'Googleへ接続中…' : <><GoogleMark />Googleアカウントでログイン</>}
        </button>
        <div className="auth-console-entry"><button className="auth-console-button" type="button" onClick={() => void signInWithGoogle('admin-console')} disabled={isSubmitting || !isSupabaseConfigured}>{isSubmitting ? 'Googleへ接続中…' : '管理者コンソールにログイン'}</button></div>
        <p className="demo-note">@sk-housing.jp のGoogle Workspaceアカウントをご利用ください。アカウントの発行はシステム管理者へお問い合わせください。</p>
      </div>
    </section>
  </main>;
}

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.91c-.58 2.96-2.28 5.47-4.81 7.16l7.73 6C44.34 37.94 46.98 31.81 46.98 24.55Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.54 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.82l-7.73-6C30.02 37.91 27.26 39 24 39c-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 43.62 14.62 48 24 48Z"/></svg>;
}

function PortalLayout({ profile, onSignOut }: { profile: UserProfile; onSignOut: () => Promise<void> }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarPinned, setSidebarPinned] = useState(() => localStorage.getItem('sidebar-pinned') !== 'false');
  const pageTitle = location.pathname === '/case-progress-migration' ? '案件移行検証' : location.pathname === '/property-profitability' ? '物件別収益分析' : location.pathname === '/approval-inventory' ? '稟議の棚卸し' : location.pathname === '/appsuite-sync' ? 'AppSuite同期' : location.pathname === '/change-requests' ? '対応依頼' : location.pathname === '/admin/parking-fee-cleanup' ? '駐車料金一括整備' : location.pathname === '/admin/contract-billing-bulk' ? '請求条件一括設定' : location.pathname === '/admin/schema-explorer' ? 'スキーマ探索' : location.pathname === '/admin/case-progress-migration' ? '案件移行検証' : location.pathname === '/settings/assets' ? 'アセット設定' : location.pathname === '/settings/tenant-billing' ? 'テナント請求設定' : location.pathname === '/contracts' ? '契約業務フロー' : location.pathname.startsWith('/contract-documents') || location.pathname.endsWith('/document') ? '契約書作成' : location.pathname === '/accounts' ? 'アカウント管理' : location.pathname === '/billing-codes' ? 'テナント請求' : location.pathname === '/contract-information' ? '契約情報' : location.pathname === '/procurement' ? '発注・請求・支払管理' : location.pathname === '/financial' ? '収支管理' : location.pathname === '/rent-roll' ? 'レントロール' : location.pathname === '/parking' ? '駐車場・駐輪場台帳' : location.pathname === '/leasing-map' ? 'リーシング図面' : 'ダッシュボード';
  const logout = async () => { await onSignOut(); navigate('/login', { replace: true }); };
  const userName = profile.employee?.employee_name ?? profile.email;
  const canEditContractBillingTerms = profile.role === 'admin' || profile.employee?.department?.department_name === '総務経理部';
  const updateSidebarPinned = (next: boolean) => { setSidebarPinned(next); localStorage.setItem('sidebar-pinned', String(next)); };
  return <div className={`portal-shell ${sidebarPinned ? 'sidebar-pinned' : 'sidebar-unpinned'}`}>
    <aside className="sidebar"><button type="button" className={`sidebar-pin ${sidebarPinned ? 'is-pinned' : 'is-unpinned'}`} aria-pressed={sidebarPinned} aria-label={sidebarPinned ? 'サイドバーのピン留めを解除' : 'サイドバーをピン留め'} title={sidebarPinned ? 'ピン留め中（クリックで解除）' : 'ピン留めする'} onClick={() => updateSidebarPinned(!sidebarPinned)}><span aria-hidden="true">📌</span></button><div className="brand"><span className="brand-mark">要</span><span>KANAME</span></div><p className="workspace-label">WORKSPACE</p>
      <nav><NavLink to="/dashboard" className="nav-item"><span>▦</span>ダッシュボード</NavLink><NavLink to="/property-profitability" className="nav-item"><span>¥</span>物件別収益分析</NavLink><NavLink to="/change-requests" className="nav-item"><span>✓</span>対応依頼</NavLink><NavLink to="/approval-inventory" className="nav-item"><span>☑</span>稟議の棚卸し</NavLink><NavLink to="/billing-codes" className="nav-item"><span>＃</span>テナント請求</NavLink><NavLink to="/rent-roll" end className="nav-item"><span>▤</span>レントロール</NavLink><NavLink to="/contracts" className="nav-item"><span>◇</span>契約業務フロー</NavLink><NavLink to="/contract-documents" className={({ isActive }) => isActive || location.pathname.endsWith('/document') ? 'nav-item active' : 'nav-item'}><span>▤</span>契約書作成</NavLink><NavLink to="/leasing-map" className="nav-item"><span>▱</span>リーシング図面</NavLink></nav>
      <p className="workspace-label">請求支払業務</p><nav><NavLink to="/procurement" className="nav-item"><span>◫</span>発注・請求・支払</NavLink><NavLink to="/financial" className="nav-item"><span>¥</span>収支管理</NavLink></nav>
      <p className="workspace-label">契約管理</p><nav>{(profile.role === 'admin' || profile.role === 'manager') && <NavLink to="/admin/contracts" className="nav-item"><span>◇</span>契約台帳管理</NavLink>}<NavLink to="/contract-information" className="nav-item"><span>◈</span>契約情報</NavLink><NavLink to="/parking" className="nav-item"><span>Ⓟ</span>駐車場・駐輪場台帳</NavLink></nav>

      {(profile.role === 'admin' || canEditContractBillingTerms) && <><p className="workspace-label">管理者メニュー</p><nav>{profile.role === 'admin' && <><NavLink to="/admin-console" className="nav-item admin-console-entry"><span>⚙</span>管理者コンソール</NavLink><NavLink to="/case-progress-migration" className="nav-item"><span>⇄</span>案件移行検証</NavLink><NavLink to="/appsuite-sync" className="nav-item"><span>⇄</span>AppSuite同期</NavLink></>}{canEditContractBillingTerms && <NavLink to="/admin/contract-billing-bulk" className="nav-item"><span>¥</span>請求条件一括設定</NavLink>}</nav></>}
      <div className="sidebar-footer"><div className="help-card"><span>?</span><div><strong>お困りですか？</strong><small>ヘルプセンターを見る</small></div></div></div>
    </aside>
    <main className="portal-main"><header className="topbar"><div><p className="breadcrumb">ホーム / {pageTitle}</p><h1>{pageTitle}</h1></div><div className="user-menu"><div className="avatar">{userName.slice(0, 1)}</div><div className="user-name"><strong>{userName}</strong><small>{roleLabel(profile.role)}</small></div><button className="logout-button" onClick={() => void logout()}>ログアウト</button></div></header><div className="page-content"><Suspense fallback={<RouteLoadingFallback />}><Outlet /></Suspense></div></main><UserFeedbackWidget />
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

function InitialPasswordChangePage({ onComplete }: { onComplete: () => Promise<void> }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < 6) return setError('パスワードは6文字以上で入力してください。');
    if (password !== confirmation) return setError('確認用パスワードが一致しません。');
    if (!supabase) return setError('Supabaseの接続情報が設定されていません。');
    setError(''); setIsSaving(true);
    const { error: changeError } = await supabase.functions.invoke('complete-initial-password-change', { body: { password } });
    setIsSaving(false);
    if (changeError) return setError(changeError.message || 'パスワードを変更できませんでした。');
    await onComplete();
    navigate('/dashboard', { replace: true });
  };

  return <main className="state-screen"><section className="state-card"><p className="eyebrow">FIRST LOGIN</p><h1>パスワードを変更</h1><p>初回ログインのため、パスワードを設定してください。初期パスワードと同じ値も設定できます。</p><form className="password-change-form" onSubmit={(event) => void submit(event)}><label>新しいパスワード<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength={6} /></label><label>新しいパスワード（確認）<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required minLength={6} /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full" type="submit" disabled={isSaving}>{isSaving ? '変更中…' : 'パスワードを設定する'}</button><button className="secondary-button full" type="button" onClick={() => void supabase?.auth.signOut().then(() => navigate('/login', { replace: true }))}>ログアウト</button></form></section></main>;
}

function AccountManagementPage({ currentUserId }: { currentUserId: string }) {
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selected, setSelected] = useState<UserProfile | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
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

  const createAccount = async (draft: { email: string; employee_id: string; role: AccountRole }) => {
    if (!supabase) return;
    const { error } = await supabase.functions.invoke('admin-create-user', { body: draft });
    if (error) { setMessage(`アカウントを作成できませんでした: ${error.message}`); return; }
    setShowCreateModal(false);
    setMessage('アカウントを作成しました。社員はGoogle Workspaceアカウントでログインできます。');
    await loadData();
  };

  return <>
    <section className="page-heading"><div><p className="section-kicker">ADMINISTRATION</p><h2>アカウント管理</h2><p>Google Workspaceログイン、担当者の紐づけ、権限、利用状態を管理します。</p></div><button className="primary-button" onClick={() => setShowCreateModal(true)}>アカウントを作成</button></section>
    {message && <div className="account-message">{message}<button onClick={() => setMessage('')}>×</button></div>}
    <section className="account-summary"><SummaryCard label="承認待ち" value={profiles.filter((profile) => profile.account_status === 'pending').length} tone="orange" /><SummaryCard label="有効なアカウント" value={profiles.filter((profile) => profile.account_status === 'active').length} tone="green" /><SummaryCard label="利用停止中" value={profiles.filter((profile) => profile.account_status === 'suspended').length} tone="gray" /></section>
    <section className="account-panel"><header><div><h3>アカウント一覧</h3><p>未照合アカウントは、担当者を設定して承認してください。</p></div><select value={filter} onChange={(event) => setFilter(event.target.value as AccountStatus | 'all')}><option value="all">すべての状態</option><option value="pending">承認待ち</option><option value="active">有効</option><option value="suspended">利用停止</option></select></header>
      {isLoading ? <div className="empty-state"><strong>読み込み中です…</strong></div> : <div className="table-wrap"><table className="account-table"><thead><tr><th>メールアドレス</th><th>担当者・部門</th><th>ロール</th><th>状態</th><th>登録日時</th><th /></tr></thead><tbody>{filteredProfiles.map((profile) => { const employee = employees.find((item) => item.employee_id === profile.employee_id); return <tr key={profile.user_id}><td><strong>{profile.email}</strong></td><td>{employee ? <><strong>{employee.employee_name}</strong><small>{employee.department?.department_name ?? '部門未設定'}</small></> : <span className="unlinked">未紐づけ</span>}</td><td><span className="role-pill">{roleLabel(profile.role)}</span></td><td><AccountStatusBadge status={profile.account_status} /></td><td>{new Date(profile.created_at).toLocaleDateString('ja-JP')}</td><td><button className="row-action" onClick={() => setSelected(profile)}>{profile.account_status === 'pending' ? '承認・設定' : '編集'}</button></td></tr>; })}</tbody></table></div>}
    </section>
    {showCreateModal && <CreateAccountModal employees={employees} profiles={profiles} onClose={() => setShowCreateModal(false)} onCreate={createAccount} />}
    {selected && <AccountModal profile={selected} employees={employees} profiles={profiles} onClose={() => setSelected(null)} onSave={save} />}
  </>;
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: string }) { return <article className={`summary-card ${tone}`}><p>{label}</p><strong>{value}<small>件</small></strong></article>; }
function AccountStatusBadge({ status }: { status: AccountStatus }) { const label = status === 'pending' ? '承認待ち' : status === 'active' ? '有効' : '利用停止'; return <span className={`account-status ${status}`}>{label}</span>; }
function roleLabel(role: AccountRole) { return role === 'admin' ? 'システム管理者' : role === 'manager' ? '業務管理者' : role === 'staff' ? '担当者' : '参照専用'; }

function CreateAccountModal({ employees, profiles, onClose, onCreate }: { employees: Employee[]; profiles: UserProfile[]; onClose: () => void; onCreate: (draft: { email: string; employee_id: string; role: AccountRole }) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState<AccountRole>('staff');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const unavailable = new Set(profiles.map((profile) => profile.employee_id).filter((id): id is string => Boolean(id)));
  const availableEmployees = employees.filter((employee) => employee.employment_status === 'active' && !unavailable.has(employee.employee_id));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@sk-housing\.jp$/i.test(normalizedEmail)) return setError('@sk-housing.jp のメールアドレスを入力してください。');
    if (profiles.some((profile) => profile.email.toLowerCase() === normalizedEmail)) return setError('このメールアドレスのアカウントは既に登録されています。');
    if (!employeeId) return setError('担当者を選択してください。');
    setError(''); setIsSaving(true);
    await onCreate({ email: normalizedEmail, employee_id: employeeId, role });
    setIsSaving(false);
  };

  return <div className="modal-backdrop"><form className="modal account-modal" onSubmit={(event) => void submit(event)}><header><div><p className="eyebrow">NEW ACCOUNT</p><h2>アカウントを作成</h2></div><button type="button" className="modal-close" onClick={onClose}>×</button></header><div className="modal-body"><label>会社メールアドレス<input type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@sk-housing.jp" required /></label><label>担当者<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required><option value="">担当者を選択</option>{availableEmployees.map((employee) => <option value={employee.employee_id} key={employee.employee_id}>{employee.employee_name}（{employee.department?.department_name ?? '部門未設定'}）</option>)}</select></label><label>ロール<select value={role} onChange={(event) => setRole(event.target.value as AccountRole)}><option value="admin">システム管理者</option><option value="manager">業務管理者</option><option value="staff">担当者</option><option value="viewer">参照専用</option></select></label><p className="modal-hint">登録後すぐに、指定した会社メールアドレスのGoogle Workspaceアカウントでログインできます。</p>{error && <p className="form-error">{error}</p>}</div><footer><button type="button" className="secondary-button" onClick={onClose}>キャンセル</button><button className="primary-button" type="submit" disabled={isSaving}>{isSaving ? '作成中…' : '作成する'}</button></footer></form></div>;
}

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
