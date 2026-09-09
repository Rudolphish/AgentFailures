# レビューチェックリスト（自動レビュー用）

このプロジェクト（AgentFailures）で守るべき不変条件。自動レビューはこのリストと
照らして差分をチェックする。

**本来ここに足すのは、一度やらかしたことだけ。** 現時点ではまだ運用実績が無いため、
要件定義（[`requirements.md`](./requirements.md)）から導いた「壊してはいけない約束」を
初期値として置いている。実際に事故が起きたら、その項目をここへ追記すること。

背景は [`CLAUDE.md`](../CLAUDE.md)（コードの落とし穴）と
[`lessons.md`](./lessons.md)（進め方の落とし穴）にある。

## 1. シークレット（最重要）

- [ ] `.env` / `.dev.vars` がコミットされていないか。`.gitignore` の該当行を消していないか
- [ ] `SUPABASE_SERVICE_ROLE_KEY` や `MCP_AUTH_TOKEN` の実値が、
      ソース・README・テストコード・コミットメッセージに書かれていないか
- [ ] `.env.example` に実値が入っていないか（プレースホルダのままか）
- [ ] service_role キーがクライアントへ渡りうる経路が増えていないか
      （このキーは RLS をバイパスするため、Worker の外へ出た時点で全データが読み書き可能になる）

## 2. 認証

- [ ] `/mcp` への到達経路すべてで `isAuthorized` を通しているか。
      新しいパスやメソッドを足したとき、認証の前に処理を書いていないか
- [ ] トークン比較を `===` や `!==` による素の文字列比較に戻していないか
      （`src/auth.ts` の SHA-256 経由の定数時間比較を迂回していないか）
- [ ] エラーレスポンスにトークンや接続文字列が混入していないか
      （Supabase のエラーメッセージをそのまま返す経路が増えていないか）
- [ ] `/health` が状態以外（件数・スキーマ・環境変数など）を返していないか

## 3. MCP ツール仕様

- [ ] ツールが `search_failures` と `record_failure` の 2 つだけか。
      スコープ外（削除・更新・分類・同期）のツールが増えていないか
- [ ] `search_failures` が上限件数を超えて返しうる経路が無いか。
      zod の `.max(5)` と `store.ts` の `Math.min` の**二重の防御を両方**維持しているか
- [ ] 既定件数 3 / 上限 5 の値を変えていないか
- [ ] 結果が `created_at` の降順（新しい順）で返っているか
- [ ] `record_failure` の必須項目
      （`domain` / `environment` / `attempted` / `observed` / `cause` /
      `cause_is_assumption` / `tags`）が required から外れていないか
- [ ] 必須項目が欠落した入力で、DB へ到達する前にエラーを返しているか
      （検証を通さず insert する経路が増えていないか）
- [ ] `record_failure` の説明文に
      「原因が推定である場合は cause_is_assumption を true にすること」が残っているか
- [ ] `observed` の説明から「観測された事実のみ」という指示が消えていないか

## 4. データベース

- [ ] `failures` の必須列から `NOT NULL` または空文字を拒否する `CHECK` を外していないか
- [ ] RLS を無効化していないか。`anon` / `authenticated` にポリシーや権限を与えていないか
- [ ] 生成列 `search_text` が参照する関数の `immutable` 宣言を外していないか
      （`concat_ws` / `array_to_string` は stable 扱いのため、
      ラッパー関数を経由しないと生成列を作れない）
- [ ] `pg_trgm` 拡張と trigram 索引を消していないか
      （消すと日本語の `query` 検索が全表走査になる）
- [ ] マイグレーションを破壊的に書き換えていないか
      （適用済みのファイルを編集するのではなく、新しいファイルを足す）

## 5. Cloudflare Workers

- [ ] Node 固有 API（`process` / `Buffer` / `fs` 等）に依存するコードを足していないか
- [ ] リクエストを跨いで状態を保持していないか
      （Worker のインスタンスは使い回されるため、
      ユーザー単位・リクエスト単位の情報をモジュールスコープに置くと他リクエストへ漏れる）
- [ ] keep-alive の Cron Trigger（`wrangler.jsonc` の `triggers.crons`）を消していないか。
      実行間隔が 7 日以上空く設定になっていないか（Supabase 無料プランが自動停止する）
- [ ] `scheduled` ハンドラの失敗を握りつぶしていないか（`console.error` まで消していないか）

## 6. スコープ

- [ ] 要件でスコープ外とした機能（Notion 連携 / ベクトル検索・pgvector /
      自動分類・審査エージェント・削除機構 / 管理用 UI）を先回りして実装していないか

## 7. レビュー機構自体

- [ ] `.claude/hooks/review-decisions.csv` に開発側が `rejected` / `deferred` を
      書き足していないか（開発側が書けるのは `accepted` のみ。詳細は
      [`CLAUDE.md`](../CLAUDE.md) の「review-decisions.csv へ書いてよいもの」）
- [ ] `accepted` の evidence に、修正コミットと独立した PASS の根拠が書かれているか

## 8. 一般的なコード品質

- [ ] TypeScript の型エラーがないか（`npm run typecheck`）
- [ ] 明らかなデッドコード・デバッグ用 `console.log` の残置がないか
- [ ] エラーハンドリングを握りつぶしていないか（catch で無言の return をしていないか）
- [ ] README の手順が現在のコードと合っているか
      （エンドポイント・環境変数名・コマンドが実装とずれていないか）

---

## 出力フォーマット（自動レビューが従う形式）

レビュー結果は必ず最初の行に以下のいずれかを書くこと：

```
VERDICT: PASS
```
または
```
VERDICT: FAIL
```

FAIL の場合は、その後に箇条書きで具体的な修正指示を書くこと
（ファイルパスと直すべき内容を明記）。
