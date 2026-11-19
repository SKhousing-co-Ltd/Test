# Google Workspace ログイン設定

アプリ側の実装後、環境ごとに以下の設定が必要です。OAuth クライアントシークレットは Google Cloud や Supabase Dashboard で管理し、フロントエンド環境変数や Git に登録しないでください。

## Google Cloud

1. Web 用 OAuth クライアントを作成する。
2. OAuth アプリの対象ユーザーを Workspace 内部に設定し、会社の Workspace 組織で利用できるようにする。
3. 承認済みリダイレクト URI に `https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback` を登録する。
4. 発行された Client ID と Client Secret を控える。

アプリから渡す `hd=sk-housing.jp` は Workspace ドメインを選ぶためのヒントです。許可ドメインの強制には Google Cloud 側の内部向け設定を使います。

## Supabase

1. Authentication の Providers で Google を有効化する。
2. Google Cloud の Client ID と Client Secret を登録する。
3. URL Configuration の Site URL と Redirect URLs に、アプリの `/login` URL を環境ごとに登録する。例: `https://<APP_HOST>/login`。
4. 一般ユーザーのサインアップは無効のままにする。管理者登録時に Auth ユーザーを事前作成するため、社員自身による未承認ユーザー作成は不要。

## 移行・動作確認

1. 既存社員の Supabase Auth メールアドレスと Google Workspace メールアドレスが完全一致することを確認する。
2. まず既存アカウント1件で Google ログインし、同じ `auth.users.id` と `user_profiles` の社員・ロールが維持されることを確認する。
3. 既存社員のログインを確認した後、残りのアカウントへ展開する。
4. 管理画面で新規アカウントを作成し、直ちに Google ログインできること、異なるメールアドレスや停止済みアカウントでは業務画面に入れないことを確認する。
