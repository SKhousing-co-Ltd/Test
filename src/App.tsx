import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from './lib/supabase';

type AuthMode = 'sign-in' | 'sign-up';

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [statusMessage, setStatusMessage] = useState('Supabase の接続状態を確認しています...');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setStatusMessage('Supabase の環境変数が未設定です。');
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
        <h1>Supabase と連携した認証スターター</h1>
        <p className="description">
          Supabase Auth のセッション取得、メールアドレスでのログイン・登録、ログアウトを
          Vite アプリから実行できます。
        </p>

        <div className={isSupabaseConfigured ? 'status status-ready' : 'status status-warning'}>
          {statusMessage}
        </div>

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
