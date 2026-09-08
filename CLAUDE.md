# CLAUDE.md

AgentFailures — AI エージェントが失敗談を蓄積・参照するためのナレッジストアと
リモート MCP サーバー。

要件は [`docs/requirements.md`](docs/requirements.md)、
セットアップ手順は [`README.md`](README.md) にある。

## 構成

- ストア: Supabase (PostgreSQL)
- MCP サーバー: TypeScript / Cloudflare Workers / Streamable HTTP
- SDK: `@modelcontextprotocol/sdk`
- デプロイ: wrangler

## コマンド

```bash
npm run dev        # wrangler dev（.dev.vars が必要）
npm run typecheck  # tsc --noEmit
npm run deploy     # wrangler deploy
```

## コードの落とし穴

このファイルには**このリポジトリで実際に踏んだ**コード上の罠を書く。
進め方の話は [`docs/lessons.md`](docs/lessons.md) に書く。

### SDK 同梱のトランスポートは Workers で動かない

`@modelcontextprotocol/sdk` の `StreamableHTTPServerTransport` は Node の
`IncomingMessage` / `ServerResponse` を前提としており、Workers 上では動作しない。
`src/transport.ts` の `WorkersHttpTransport`（1 リクエスト = 1 JSON レスポンス、
SSE なし、セッションなし）を使うこと。SDK の `Server` コア自体はトランスポート
非依存なので、差し替えられるのはこの層だけである。

ステートレス構成のため、リクエストごとに `McpServer` を新しく作って `connect` し、
終わったら `close` する。`initialize` を受けたインスタンスは次のリクエストには
残らない。セッション ID は発行しない。

### 生成列から呼ぶ関数は immutable でなければならない

`concat_ws` と `array_to_string` は型出力関数を経由する都合で PostgreSQL 上
`stable` 扱いであり、生成列の式に直接書くと `CREATE TABLE` が失敗する。
`public.failures_search_text(...)` という `immutable` 宣言のラッパー関数を挟んで
回避している。この宣言を外すとマイグレーションが通らなくなる。

### PostgREST の ilike はパターン文字を解釈する

`store.ts` の `escapeLikePattern` で `\` `%` `_` をエスケープしている。
加えて PostgREST は `ilike` の値に含まれる `*` を `%` として扱うため、
これはエスケープではなく空白へ置換している（`*` を打ち消す手段が無いため）。
ユーザー入力をそのまま `ilike` に渡さないこと。

### 日本語の全文検索に tsvector は使えない

PostgreSQL 標準の `tsvector` は日本語を分かち書きできず、`simple` 設定では
空白区切りになるため日本語の文章はほぼヒットしない。`pg_trgm` による部分一致で
実装している。trigram 索引を消すと全表走査になる。

## 変更時の確認

- `npm run typecheck` を通す
- スキーマを変えたら、マイグレーションを実 PostgreSQL に適用して確認する
  （適用済みファイルの編集ではなく、新しいマイグレーションを足す）
- MCP の挙動を変えたら、README の疎通確認 curl を実際に流す

## 自動レビュー

Stop フックで `claude -p` によるレビューが走る。詳細は
[`.claude/hooks/auto-review.mjs`](.claude/hooks/auto-review.mjs) の
先頭コメントを読むこと。観点は
[`docs/review-checklist.md`](docs/review-checklist.md)。

止まらなくなったら `.claude/hooks/.review-off` を置けば無効化できる
（消せば元に戻る）。
