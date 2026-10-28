import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import './AdminConsolePage.css';

type AdminConsoleProfile = {
  email: string;
  employee?: { employee_name: string } | null;
};

const adminItems = [
  { to: '/accounts', icon: '♙', title: 'アカウント管理', description: '利用者、担当者、権限、利用状態を管理します。', category: 'ユーザー・権限' },
  { to: '/admin/assets', icon: '⌂', title: '物件登録', description: '物件の基本情報を登録・更新します。', category: '物件マスタ' },
  { to: '/settings/assets', icon: '▤', title: 'アセット設定', description: '業務画面で使う物件や表示条件を設定します。', category: '表示・利用設定' },
  { to: '/settings/tenant-billing', icon: '⚙', title: 'テナント請求設定', description: 'テナント請求に関するシステム設定を管理します。', category: '請求設定' },
  { to: '/admin/schema-explorer', icon: '◎', title: 'スキーマ探索', description: 'データベースのテーブル構成と関連を確認します。', category: 'システム情報' },
  { to: '/admin/case-progress-migration', icon: '⇄', title: '案件移行検証', description: '案件移行データの確認と検証を行います。', category: 'データ移行' },
];

const routeTitles = new Map(adminItems.map((item) => [item.to, item.title]));

export function AdminConsoleLayout({ profile, onSignOut }: { profile: AdminConsoleProfile; onSignOut: () => Promise<void> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const pageTitle = location.pathname === '/admin-console' ? 'コンソール概要' : routeTitles.get(location.pathname) ?? '管理者コンソール';
  const userName = profile.employee?.employee_name ?? profile.email;

  const logout = async () => {
    await onSignOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="admin-console-shell">
      <aside className="admin-console-sidebar">
        <NavLink to="/admin-console" className="admin-console-brand">
          <span className="admin-console-brand-mark">要</span><span>KANAME</span>
        </NavLink>
        <p className="admin-console-nav-label">ADMINISTRATION</p>
        <nav className="admin-console-nav" aria-label="管理者メニュー">
          <NavLink to="/admin-console" end className={({ isActive }) => `admin-console-nav-item${isActive ? ' active' : ''}`}><span>▦</span>コンソール概要</NavLink>
          {adminItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `admin-console-nav-item${isActive ? ' active' : ''}`}>
              <span>{item.icon}</span>{item.title}
            </NavLink>
          ))}
        </nav>
        <div className="admin-console-sidebar-footer">
          <NavLink to="/dashboard" className="admin-console-portal-link">← 業務画面へ戻る</NavLink>
          <div className="admin-console-user"><span className="admin-console-avatar">{userName.slice(0, 1)}</span><span><strong>{userName}</strong><small>管理者</small></span></div>
          <button type="button" className="admin-console-logout" onClick={() => void logout()}>ログアウト</button>
        </div>
      </aside>

      <div className="admin-console-workspace">
        <header className="admin-console-topbar">
          <p>管理者コンソール <span>/</span> <strong>{pageTitle}</strong></p>
          <span className="admin-console-role">● 管理者権限</span>
        </header>
        <main className="admin-console-content"><Outlet /></main>
      </div>
    </div>
  );
}

export function AdminConsoleHomePage() {
  return (
    <section className="admin-console-home">
      <header className="admin-console-page-heading">
        <p className="section-kicker">ADMINISTRATION</p>
        <h1>管理者コンソール</h1>
        <p>システムの設定とアカウントを管理します。</p>
      </header>

      <section className="admin-console-welcome">
        <div><p className="admin-console-kicker">ADMIN WORKSPACE</p><h2>管理業務の入口</h2><p>管理項目を選択して、各設定・管理画面へ進んでください。</p></div>
        <div className="admin-console-summary"><strong>{adminItems.length} 項目</strong><span>管理者専用メニュー</span></div>
      </section>

      <div className="admin-console-section-heading"><div><h2>設定・管理</h2><p>管理者権限で利用できる項目です。</p></div><span>ADMIN TOOLS</span></div>
      <div className="admin-console-cards">
        {adminItems.map((item) => (
          <NavLink key={item.to} to={item.to} className="admin-console-card">
            <span className="admin-console-card-top"><span className="admin-console-card-icon">{item.icon}</span><span className="admin-console-card-arrow">↗</span></span>
            <strong>{item.title}</strong>
            <span className="admin-console-card-description">{item.description}</span>
            <span className="admin-console-card-category"><i />{item.category}</span>
          </NavLink>
        ))}
      </div>
      <p className="admin-console-info"><span>ⓘ</span> マネージャーも利用する業務機能は、従来の業務画面に残しています。</p>
    </section>
  );
}
