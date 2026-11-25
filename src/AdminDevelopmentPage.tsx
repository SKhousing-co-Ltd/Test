import { Link } from 'react-router-dom';
import './AdminDevelopmentPage.css';

const features = [
  { key: 'deposits', title: '敷金管理', description: '新規入居時の敷金管理と請求に関する画面', path: '/admin/development/deposits' },
  { key: 'brokerage-fees', title: '仲介料管理', description: '仲介料の管理に関する画面', path: '/admin/development/brokerage-fees' },
  { key: 'garage-certificates', title: '車庫証明発行管理', description: '発行・請求履歴を登録します。', path: '/admin/development/garage-certificates' },
  { key: 'security-cards', title: 'セキュリティカード発注管理', description: '発注履歴と物件別の請求単価を管理します。', path: '/admin/development/security-cards' },
] as const;

export function AdminDevelopmentHomePage() {
  return <section className="admin-development-page">
    <header className="admin-console-page-heading"><p className="section-kicker">DEVELOPMENT</p><h1>開発中の機能</h1><p>仕様確認中の機能を、管理者コンソール内で作成・検証します。</p></header>
    <div className="admin-development-grid">{features.map((feature) => <Link key={feature.key} to={feature.path} className="admin-development-card"><span className="admin-development-status">仕様確認中</span><h2>{feature.title}</h2><p>{feature.description}</p><span className="admin-development-link">画面を開く →</span></Link>)}</div>
  </section>;
}

export function AdminDevelopmentFeaturePage({ feature }: { feature: (typeof features)[number]['key'] }) {
  const current = features.find((item) => item.key === feature)!;
  return <section className="admin-development-page">
    <header className="admin-console-page-heading"><p className="section-kicker">DEVELOPMENT / {current.key.toUpperCase()}</p><h1>{current.title}</h1><p>管理者コンソール内で仕様を確認しながら構築する画面です。</p></header>
    <div className="admin-development-workspace"><span className="admin-development-status">仕様確認中</span><h2>{current.title}の作業画面</h2><p>管理項目・計算方法・請求との連携などの仕様を受けて、ここに管理テーブルを実装します。</p><Link to="/admin/development">開発中の機能へ戻る</Link></div>
  </section>;
}
