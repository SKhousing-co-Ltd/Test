# Deployment Guide

このアプリケーションは Vite + React + TypeScript 構成で、Vercel へのデプロイを前提にしています。

## ビルド出力

Vite の既定のビルド出力先は `dist` です。`vercel.json` では Vercel の Output Directory として `dist` を明示しています。

## Vercel の環境変数

Vercel の Project Settings で、以下の環境変数を設定してください。

| Name | Description | Environment |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Supabase プロジェクトの URL | Production / Preview / Development |
| `VITE_SUPABASE_ANON_KEY` | Supabase プロジェクトの anon public key | Production / Preview / Development |

Vite でクライアント側から参照する環境変数は `VITE_` プレフィックスが必要です。値を変更した場合は、Vercel で再デプロイしてください。

## ローカル開発

1. 依存関係をインストールします。

   ```bash
   npm install
   ```

2. ローカル用の環境変数を `.env.local` に設定します。

   ```bash
   VITE_SUPABASE_URL="https://your-project.supabase.co"
   VITE_SUPABASE_ANON_KEY="your-supabase-anon-key"
   ```

3. 開発サーバーを起動します。

   ```bash
   npm run dev
   ```

## 本番ビルド

本番向けのビルドは次のコマンドで実行します。

```bash
npm run build
```

このコマンドは TypeScript の型チェックを実行した後、Vite で `dist` に静的ファイルを生成します。

生成された本番ビルドをローカルで確認する場合は次を実行します。

```bash
npm run preview
```

## Vercel へのデプロイ手順

1. Vercel で Git リポジトリを Import します。
2. Framework Preset は `Vite` を選択します。
3. Build Command が `npm run build`、Output Directory が `dist` になっていることを確認します。これらは `vercel.json` でも明示しています。
4. Project Settings の Environment Variables に `VITE_SUPABASE_URL` と `VITE_SUPABASE_ANON_KEY` を設定します。
5. Production にデプロイします。

## SPA ルーティング

`vercel.json` には、すべてのパスを `/index.html` に戻す rewrite を設定しています。これにより、React Router などのクライアントサイドルーティングで直接 URL にアクセスしてもアプリケーションが表示されます。
