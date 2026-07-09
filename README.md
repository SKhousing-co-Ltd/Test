# Vite + React + TypeScript

Vite の標準構成に近い React + TypeScript プロジェクトです。Vercel では通常、Framework Preset に `Vite`、Build Command に `npm run build`、Output Directory に `dist` を指定すると扱いやすい構成です。


## ディレクトリ構成

React アプリ内の主なディレクトリと役割は次の通りです。

| ディレクトリ | 役割 |
| --- | --- |
| `src/components/` | 複数の画面や機能から利用する共通 UI コンポーネントを配置します。 |
| `src/features/` | 業務機能ごとのコンポーネント、フック、状態管理、API 呼び出しなどをまとめます。 |
| `src/lib/` | Supabase など、外部サービスやライブラリとの接続設定を配置します。 |
| `src/pages/` | 画面単位のコンポーネントを配置します。 |
| `src/routes/` | ルーティング定義や画面遷移に関する設定を配置します。 |
| `src/types/` | アプリ全体で共有する TypeScript 型定義を配置します。 |
| `src/utils/` | 特定の機能に依存しない汎用関数を配置します。 |

各ディレクトリには、初期状態でも Git 管理できるように `.gitkeep` を配置しています。


## Supabase 連携

このアプリは `@supabase/supabase-js` を使って Supabase Auth と連携しています。`src/lib/supabase.ts` で Vite の環境変数から Supabase クライアントを作成し、`src/App.tsx` でセッション確認、メールアドレス・パスワードによるログイン、新規登録、ログアウトを実行します。

ローカルでは `.env.local` を作成し、以下を設定してください。

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

Supabase 側では Authentication > Providers で Email provider を有効化してください。メール確認を有効にしている場合、新規登録後に確認メールのリンクを開くまでログインできないことがあります。

## セットアップ

```sh
npm install
```

## 開発

```sh
npm run dev
```

## 検証

型チェックだけを確認する場合は次を実行します。

```sh
npm run typecheck
```

本番ビルドまで確認する場合は次を実行します。

```sh
npm run build
```

## npm registry で 403 が出る場合

`npm install` が `403 Forbidden` で失敗する場合は、プロジェクトのコードではなく実行環境の registry / proxy 設定が原因の可能性があります。まず以下を確認してください。

```sh
npm config get registry
npm config get proxy
npm config get https-proxy
```

社内 proxy や CI のネットワーク制限がある環境では、許可済みの npm registry を使うか、proxy 設定を管理者に確認してから依存関係をインストールしてください。
