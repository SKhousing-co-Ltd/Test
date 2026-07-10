import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from './lib/supabase';

type AuthMode = 'sign-in' | 'sign-up';
type DatabaseCheckStatus = 'idle' | 'loading' | 'success' | 'mismatch' | 'error' | 'not-configured';

type ConnectionCheckSample = {
  key: string;
  label: string;
  expected_value: string;
  sort_order: number;
};

const expectedSamples = [
  {
    key: 'database_connection',
    label: 'データベース接続',
    expected_value: '接続確認用ダミーデータ',
  },
  {
    key: 'rls_read_access',
    label: 'RLS 読み取り権限',
    expected_value: 'anon と authenticated で参照可能',
  },
  {
    key: 'sample_version',
    label: 'サンプルデータ版',
    expected_value: 'v1',
  },
] as const;

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [statusMessage, setStatusMessage] = useState('Supabase の接続状態を確認しています...');
  const [isLoading, setIsLoading] = useState(false);
  const [databaseCheckStatus, setDatabaseCheckStatus] = useState<DatabaseCheckStatus>('idle');
  const [databaseCheckMessage, setDatabaseCheckMessage] = useState('');
  const [databaseSamples, setDatabaseSamples] = useState<ConnectionCheckSample[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const checkDatabase = async () => {
    if (!supabase) {
      setDatabaseCheckStatus('not-configured');
      setDatabaseCheckMessage('Supabase の環境変数を設定すると、データベース接続を確認できます。');
      setDatabaseSamples([]);
      setCheckedAt(null);
      return;
    }

    setDatabaseCheckStatus('loading');
    setDatabaseCheckMessage('connection_check_samples を取得しています...');

    const { data, error } = await supabase
      .from('connection_check_samples')
      .select('key, label, expected_value, sort_order')
      .order('sort_order');

    if (error) {
      setDatabaseCheckStatus('error');
      setDatabaseCheckMessage(`取得に失敗しました: ${error.message}`);
      setDatabaseSamples([]);
      setCheckedAt(null);
      return;
    }

    const samples = (data ?? []) as ConnectionCheckSample[];
    const isExactMatch =
      samples.length === expectedSamples.length &&
      expectedSamples.every((expectedSample, index) => {
        const sample = samples[index];
        return (
          sample?.key === expectedSample.key &&
          sample.label === expectedSample.label &&
          sample.expected_value === expectedSample.expected_value
        );
      });

    setDatabaseSamples(samples);
    setDatabaseCheckStatus(isExactMatch ? 'success' : 'mismatch');
    setDatabaseCheckMessage(
      isExactMatch
        ? 'ダミーデータを期待値どおりに取得できました。'
        : 'データは取得できましたが、件数または内容が期待値と一致しません。',
    );
    setCheckedAt(new Date().toLocaleString('ja-JP'));
  };

  useEffect(() => {
    if (!supabase) {
      setStatusMessage('Supabase の環境変数が未設定です。');
      void checkDatabase();
      return;
    }

    let isMounted = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!isMounted) {
        return;
      }

      if (error) {
        setStatusMessage(`セッション取得に失敗しました: ${error.message}`);
        return;
      }

      setSession(data.session);
      setStatusMessage(
        data.session
          ? 'Supabase Auth に接続済みです。'
          : 'Supabase Auth に接続しました。ログインできます。',
      );
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setStatusMessage(
        nextSession ? 'ログイン状態を同期しました。' : 'ログアウトしました。',
      );
    });

    void checkDatabase();

    return () => {
      isMounted = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  const handleAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setStatusMessage('Supabase の URL と anon key を設定してください。');
      return;
    }

    setIsLoading(true);
    setStatusMessage(mode === 'sign-in' ? 'ログインしています...' : 'アカウントを作成しています...');

    const authRequest =
      mode === 'sign-in'
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });

    const { error } = await authRequest;

    if (error) {
      setStatusMessage(error.message);
    } else {
      setStatusMessage(
        mode === 'sign-in'
          ? 'ログインしました。'
          : '確認メールが有効な場合は、メールを確認して登録を完了してください。',
      );
      setPassword('');
    }

    setIsLoading(false);
  };

  const handleSignOut = async () => {
    if (!supabase) {
      return;
    }

    setIsLoading(true);
    const { error } = await supabase.auth.signOut();
    setStatusMessage(error ? error.message : 'ログアウトしました。');
    setIsLoading(false);
  };

  return (
    <main className="app-shell">
      <section className="hero-card">
        <p className="eyebrow">Vite + React + TypeScript + Supabase</p>
        <h1>Supabase 接続・データ取得確認</h1>
        <p className="description">
          Supabase の設定状態、認証状態、接続確認用ダミーデータの取得結果を確認できます。
        </p>

        <div className={isSupabaseConfigured ? 'status status-ready' : 'status status-warning'}>
          {statusMessage}
        </div>

        <section className="database-check" aria-labelledby="database-check-heading">
          <div className="database-check-heading">
            <div>
              <p className="section-label">Database check</p>
              <h2 id="database-check-heading">ダミーデータ取得確認</h2>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void checkDatabase()}
              disabled={!isSupabaseConfigured || databaseCheckStatus === 'loading'}
            >
              {databaseCheckStatus === 'loading' ? '確認中...' : '再確認'}
            </button>
          </div>

          <p className={`database-result database-result-${databaseCheckStatus}`}>
            {databaseCheckMessage}
          </p>

          {databaseSamples.length > 0 && (
            <div className="database-table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>確認項目</th>
                    <th>取得値</th>
                  </tr>
                </thead>
                <tbody>
                  {databaseSamples.map((sample) => (
                    <tr key={sample.key}>
                      <td>{sample.label}</td>
                      <td>{sample.expected_value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {checkedAt && <p className="checked-at">最終確認: {checkedAt}</p>}
        </section>

        {session ? (
          <div className="auth-panel">
            <p className="signed-in-label">ログイン中</p>
            <strong>{session.user.email}</strong>
            <button type="button" onClick={handleSignOut} disabled={isLoading}>
              ログアウト
            </button>
          </div>
        ) : (
          <form className="auth-panel" onSubmit={handleAuth}>
            <div className="mode-switch" aria-label="認証モード">
              <button
                type="button"
                className={mode === 'sign-in' ? 'active' : ''}
                onClick={() => setMode('sign-in')}
              >
                ログイン
              </button>
              <button
                type="button"
                className={mode === 'sign-up' ? 'active' : ''}
                onClick={() => setMode('sign-up')}
              >
                新規登録
              </button>
            </div>

            <label>
              メールアドレス
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                disabled={!isSupabaseConfigured || isLoading}
              />
            </label>

            <label>
              パスワード
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={6}
                required
                disabled={!isSupabaseConfigured || isLoading}
              />
            </label>

            <button type="submit" disabled={!isSupabaseConfigured || isLoading}>
              {isLoading ? '処理中...' : mode === 'sign-in' ? 'ログインする' : '登録する'}
            </button>
          </form>
        )}

        <div className="actions" aria-label="Required environment variables">
          <code>VITE_SUPABASE_URL</code>
          <code>VITE_SUPABASE_ANON_KEY</code>
        </div>
      </section>
    </main>
  );
}

export default App;
