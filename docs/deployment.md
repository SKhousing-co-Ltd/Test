# Deployment Guide for Windows

このアプリケーションは Vite + React + TypeScript 構成で、Windows 環境から Vercel へデプロイすることを前提にしています。

## 前提条件

Windows に以下をインストールしておきます。

- Node.js LTS
- npm
- Git for Windows

コマンドは Windows PowerShell で実行する想定です。プロジェクトのルートディレクトリへ移動してから作業してください。

```powershell
cd path\to\Test
```

## ビルド出力

Vite の既定のビルド出力先は `dist` です。`vercel.json` では Vercel の Output Directory として `dist` を明示しています。

## Vercel の環境変数

Vercel の Project Settings で、以下の環境変数を設定してください。

| Name | Description | Environment |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Supabase プロジェクトの URL | Production / Preview / Development |
| `VITE_SUPABASE_ANON_KEY` | Supabase プロジェクトの anon public key | Production / Preview / Development |

Vite でクライアント側から参照する環境変数は `VITE_` プレフィックスが必要です。値を変更した場合は、Vercel で再デプロイしてください。

## ローカル開発（Windows PowerShell）

1. 依存関係をインストールします。

   ```powershell
   npm install
   ```

   `react` や `@types/react` が見つからない場合は、まずこのコマンドが実行済みか確認してください。

2. ローカル用の環境変数ファイル `.env.local` を作成します。

   ```powershell
   New-Item -ItemType File -Path .env.local -Force
   ```

3. `.env.local` をメモ帳で開きます。

   ```powershell
   notepad .env.local
   ```

4. `.env.local` に以下を記載して保存します。

   ```dotenv
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
   ```

   値は実際の Supabase プロジェクトの URL と anon public key に置き換えてください。

5. 開発サーバーを起動します。

   ```powershell
   npm run dev
   ```

6. PowerShell に表示されたローカル URL をブラウザで開きます。通常は `http://localhost:5173/` です。

## 本番ビルド（Windows PowerShell）

本番向けのビルドは次のコマンドで実行します。

```powershell
npm run build
```

このコマンドは TypeScript の型チェックを実行した後、Vite で `dist` に静的ファイルを生成します。

生成された本番ビルドをローカルで確認する場合は次を実行します。

```powershell
npm run preview
```

PowerShell に表示された URL をブラウザで開き、ビルド後の画面を確認します。

## Vercel へのデプロイ手順

1. 変更を GitHub などの Git リポジトリへ push します。
2. Vercel で Git リポジトリを Import します。
3. Framework Preset は `Vite` を選択します。
4. Build Command が `npm run build`、Output Directory が `dist` になっていることを確認します。これらは `vercel.json` でも明示しています。
5. Project Settings の Environment Variables に `VITE_SUPABASE_URL` と `VITE_SUPABASE_ANON_KEY` を設定します。
6. Production にデプロイします。

## Windows でよくある確認ポイント

- `npm run build` で `react` や `react-dom` が見つからない場合は、`npm install` を実行してください。
- `npm` コマンドが見つからない場合は、Node.js LTS がインストールされているか確認してください。
- `.env.local` は Vercel にはアップロードしません。Vercel 側の環境変数は Project Settings で別途設定します。
- PowerShell でスクリプト実行ポリシーのエラーが出る場合は、Node.js を再インストールするか、管理者権限の PowerShell で npm が使えることを確認してください。

## SPA ルーティング

`vercel.json` には、すべてのパスを `/index.html` に戻す rewrite を設定しています。これにより、React Router などのクライアントサイドルーティングで直接 URL にアクセスしてもアプリケーションが表示されます。
