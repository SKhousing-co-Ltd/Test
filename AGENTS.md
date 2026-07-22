# Git 運用

- GitHubへのリモート操作は、Windows Credential Manager を参照できるホスト権限で実行する。隔離環境のみで `git push` や `git ls-remote` を実行すると、`SEC_E_NO_CREDENTIALS` になる場合がある。
- ステージングは `git add .` を使わず、実装対象のファイルを明示して行う。診断ログ・生成物は `.gitignore` の対象とする。
- コミット前に `git diff --cached --check` を実行し、必要に応じてビルドを確認する。
- 通常の手順は「変更を確認 → 対象ファイルのみステージング → コミット → 現在のブランチを origin へプッシュ」とする。
