# 利用者の意見収集

- 投稿ボタンは `VITE_USER_FEEDBACK_ENABLED` が `false` 以外のとき表示されます。
- 試験運用終了時は、デプロイ環境の `VITE_USER_FEEDBACK_ENABLED=false` を設定して再ビルド・デプロイします。管理者ページと保存データはそのまま残ります。
- 添付画像はSupabase Storageの非公開バケット `user-feedback-images` に保存します。管理者だけが閲覧・削除できます。
- 投稿と添付画像の削除は管理者ページの確認ダイアログから行います。
