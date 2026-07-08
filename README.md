# Vite + React + TypeScript

Vite の標準構成に近い React + TypeScript プロジェクトです。Vercel では通常、Framework Preset に `Vite`、Build Command に `npm run build`、Output Directory に `dist` を指定すると扱いやすい構成です。

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
