# AgentFailures

AI エージェント群が「失敗談」を蓄積・参照するためのナレッジストア、および
それを読み書きするリモート MCP サーバー。

エージェントはタスクの実行計画を立てる前に `search_failures` を呼び出して
同種の失敗が記録されていないかを確認し、失敗が発生した場合は `record_failure`
で記録する。人間は Supabase ダッシュボードから内容を閲覧する。

初めてセットアップする場合は、実行順に沿った [`docs/setup-guide.md`](docs/setup-guide.md) を参照すること。
本書は各項目のリファレンスであり、作業手順は同ファイルにまとめている。

要件の詳細は [`docs/requirements.md`](docs/requirements.md) を参照。

## 構成

| 区分 | 採用技術 |
| --- | --- |
| ストア | Supabase (PostgreSQL) |
| MCP サーバー | TypeScript / Cloudflare Workers / Streamable HTTP |
| SDK | `@modelcontextprotocol/sdk` |
| デプロイ | wrangler |

```
src/
├── index.ts      Worker のエントリポイント。ルーティング・認証・Cron ハンドラ
├── auth.ts       固定トークンの定数時間比較
├── transport.ts  Workers 用のステートレス Streamable HTTP トランスポート
├── mcp.ts        MCP サーバー定義とツール登録
├── schema.ts     zod による入力スキーマ
├── store.ts      Supabase アクセス
├── format.ts     検索結果の整形
└── env.ts        シークレットの型と存在検査
supabase/migrations/
└── 20260908000001_create_failures.sql
```

## 提供ツール

### `search_failures`

過去の失敗談を新しい順に検索する。

| 入力 | 必須 | 説明 |
| --- | --- | --- |
| `domain` | 任意 | 対象領域。完全一致で判定する |
| `environment` | 任意 | 実行環境。大文字小文字を無視した部分一致で判定する |
| `query` | 任意 | キーワード検索。全項目を連結した文字列に対する部分一致 |
| `limit` | 任意 | 返却件数。既定 3、上限 5 |

### `record_failure`

失敗を 1 件登録する。必須項目が欠落している場合はエラーを返し、登録は行わない。

| 入力 | 必須 | 説明 |
| --- | --- | --- |
| `domain` | 必須 | 対象領域（例: `app-dev`） |
| `environment` | 必須 | 実行環境およびバージョン情報 |
| `attempted` | 必須 | 何をしようとしたか |
| `observed` | 必須 | 実際に何が起きたか（観測された事実のみ） |
| `cause` | 必須 | 原因 |
| `cause_is_assumption` | 必須 | 原因が推定である場合は `true` |
| `workaround` | 任意 | 回避策 |
| `tags` | 必須 | タグの配列。該当が無い場合は空配列 |

## セットアップ

### 1. 依存関係の取得

```bash
npm install
```

### 2. Supabase プロジェクトの準備

Supabase でプロジェクトを作成したうえで、
`supabase/migrations/20260908000001_create_failures.sql` を適用する。

Supabase CLI を利用する場合:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

CLI を用いない場合は、上記 SQL の内容を Supabase ダッシュボードの
SQL Editor に貼り付けて実行する。

このマイグレーションは以下を行う。

- `pg_trgm` 拡張の有効化
- `failures` テーブルおよび全文検索用の生成列 `search_text` の作成
- 必須項目に対する `NOT NULL` および空文字を拒否する `CHECK` 制約の付与
- `created_at` 降順索引、`domain` 索引、`environment` / `search_text` の
  trigram 索引、`tags` の GIN 索引の作成
- RLS の有効化。ポリシーを一切定義しないことで `anon` / `authenticated` からの
  到達を遮断し、`service_role` を用いる MCP サーバーのみが読み書きできる状態にする

### 3. シークレットの設定

`.env.example` に必要な環境変数を記載している。値は以下から取得する。

| 変数 | 取得元 |
| --- | --- |
| `SUPABASE_URL` | Supabase ダッシュボード → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | 同上。RLS をバイパスするため厳重に扱う |
| `MCP_AUTH_TOKEN` | 任意の乱数。`openssl rand -base64 48` などで生成する |

ローカル開発では `.dev.vars` に配置する。

```bash
cp .env.example .dev.vars
# .dev.vars を編集して値を設定する
```

本番環境では wrangler のシークレットとして登録する。

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put MCP_AUTH_TOKEN
```

`.env` および `.dev.vars` は `.gitignore` により除外している。
シークレットをコミットしないこと。

## ローカルでの動作確認

```bash
npm run dev
```

既定で `http://127.0.0.1:8787` が待ち受ける。別の端末から以下を実行する。

```bash
export MCP_URL=http://127.0.0.1:8787
export MCP_AUTH_TOKEN=<.dev.vars に設定した値>
```

### 疎通確認

```bash
# 1. ヘルスチェック（認証不要）
curl -sS "$MCP_URL/health"
# => {"status":"ok"}

# 2. 認証の確認。トークン無しでは 401 が返る
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$MCP_URL/mcp" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# => 401

# 3. initialize
curl -sS -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{"protocolVersion":"2025-06-18","capabilities":{},
              "clientInfo":{"name":"curl","version":"0"}}
  }'

# 4. ツール一覧
curl -sS -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 5. 失敗談の登録
curl -sS -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{
      "name":"record_failure",
      "arguments":{
        "domain":"notion-integration",
        "environment":"Notion API 2022-06-28 / Node.js 22",
        "attempted":"データベースのページを一括更新しようとした",
        "observed":"HTTP 429 rate_limited が返り、3 件目以降が失敗した",
        "cause":"Notion API のレート上限は平均 3 リクエスト/秒である",
        "cause_is_assumption": false,
        "workaround":"250ms のスリープを挟んで直列実行する",
        "tags":["notion","rate-limit"]
      }
    }
  }'

# 6. 失敗談の検索
curl -sS -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":4,"method":"tools/call",
    "params":{"name":"search_failures","arguments":{"query":"レート上限","limit":3}}
  }'
```

### Cron の動作確認

```bash
curl -sS "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

`wrangler dev` を実行している端末に keep-alive の結果が出力される。

## デプロイ

`main` へマージされた変更は GitHub Actions が自動でデプロイする。
型検査とビルド検証を通したうえでデプロイし、デプロイ後に `/health` が `ok` を
返すことまで確認する。定義は
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) にある。
設定手順は [`docs/setup-guide.md`](docs/setup-guide.md) の手順 6 を参照。

手作業で行う場合は以下のとおり。

```bash
npx wrangler deploy
```

デプロイ後のエンドポイントは
`https://agent-failures-mcp.<アカウントのサブドメイン>.workers.dev/mcp` となる。

本番に対しても上記と同じ curl で疎通を確認できる。

```bash
export MCP_URL=https://agent-failures-mcp.<アカウントのサブドメイン>.workers.dev
export MCP_AUTH_TOKEN=<wrangler secret に設定した値>
```

## MCP クライアントの設定

### Claude Code

```bash
claude mcp add --transport http agent-failures \
  https://agent-failures-mcp.<アカウントのサブドメイン>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

### 設定ファイルで指定する場合

`.mcp.json` またはクライアントの設定ファイルに以下を記載する。

```json
{
  "mcpServers": {
    "agent-failures": {
      "type": "http",
      "url": "https://agent-failures-mcp.<アカウントのサブドメイン>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

設定ファイルにトークンを直接記載する場合、当該ファイルをバージョン管理に
含めないこと。

## エージェントへの組み込み

クライアントの設定を済ませただけでは、エージェントは自発的にこのサーバーを
使わない。利用させるには、以下のいずれかで指示を与える。

### 都度指示する

```
失敗談ストアに似た事例がないか調べてから始めて
```

```
いま詰まった件、失敗談に記録して
```

確実だが、指示を忘れた回は当然参照されない。

### CLAUDE.md に記載する（Claude Code）

利用したいリポジトリの `CLAUDE.md` へ記載しておくと、そのプロジェクトでの作業時に
毎回適用される。貼り付ける文面は
[`docs/claude-md-snippet.md`](docs/claude-md-snippet.md) に用意している。

`domain` と `tags` の使い分けは [`docs/taxonomy.md`](docs/taxonomy.md) に定めている。
`domain` には技術（`nextjs` / `cloudflare-workers` など）を、`tags` には失敗の性質や
話題を入れる。語彙の正本は `src/schema.ts` の `KNOWN_DOMAINS` にあり、
ツールの説明文を通じて記録するエージェントへ伝わるため、
クライアント側の設定だけに依存しない。

### カスタム指示に記載する（デスクトップ / スマートフォン）

チャットでは `CLAUDE.md` が読み込まれないため、プロジェクト機能のカスタム指示へ
同じ内容を記載する。プロジェクトを用いない場合は都度指示する。

### 想定する分担

ツールの説明文には「タスクの実行計画を立てる前に呼び出すこと」と記載しているが、
説明文のみで自発的に呼ばれるとは限らない。当面は次の分担を想定する。

| 操作 | 契機 |
| --- | --- |
| 参照 | `CLAUDE.md` またはカスタム指示による自動化を狙う |
| 記録 | 詰まりが解決した時点で、利用者が明示的に指示する |

しばらく運用して自発的に呼ばれないようであれば、文面を強めるか、フックによる
強制を検討する。実際の挙動を観測してから判断すること。

## 運用上の注意

### Supabase の自動停止

Supabase の無料プランは、7 日間データベースへのアクセスが無いとプロジェクトが
自動的に停止する。停止した場合、ダッシュボードから手動で復旧する必要がある。

これを回避するため、Cron Trigger（`wrangler.jsonc` の `triggers.crons`）で
毎週月曜・木曜の 03:00 UTC に軽量なクエリを実行している。アクセス間隔は
最大 4 日となり、自動停止の閾値を下回る。

### 認証

`Authorization: Bearer <MCP_AUTH_TOKEN>` ヘッダによる固定トークン照合のみを
行う。OAuth は実装していない。トークンが漏洩した場合は
`wrangler secret put MCP_AUTH_TOKEN` で更新し、全クライアントの設定を
差し替えること。

### 検索の特性

`query` は `pg_trgm` による部分一致で実装している。日本語の文章に対しても
語の切れ目に依存せず一致するが、表記ゆれ（全角・半角、送り仮名など）は
吸収しない。安定した検索を行うには `tags` を活用すること。

## 自動レビュー

Claude Code の Stop フックで、そのセッションの変更を自動レビューする仕組みを
同梱している。レビュー担当として `claude -p` を別プロセスで起動し、
[`docs/review-checklist.md`](docs/review-checklist.md) の観点で差分を確認する。

判定が `VERDICT: FAIL` の場合、フックは exit code 2 で Stop をブロックし、
指摘を開発側へ差し戻して修正させる。修正後に再度 Stop が発火して再レビューが走る。

### 有効化

フック定義を含む `.claude/settings.json` はリポジトリに含めていない。
内容を確認したうえで、以下のコマンドで設置すること。

```bash
cp docs/claude-settings.example.json .claude/settings.json
```

このファイルは Claude Code に任意のコマンドを実行させる設定であるため、
設置前に必ず中身を読むこと。

### 構成

| ファイル | 役割 |
| --- | --- |
| `.claude/hooks/auto-review.mjs` | レビュー本体。SessionStart で起点を記録し、Stop でレビューする |
| `.claude/hooks/review-status.mjs` | いまのコミットがレビュー済みかを確認する |
| `.claude/hooks/session-brief.mjs` | セッション冒頭に `docs/lessons.md` と未レビュー分を出す |
| `.claude/hooks/review-decisions.csv` | 決着済みの論点。レビュアーが同じ指摘を蒸し返さないための記録 |
| `docs/review-checklist.md` | レビュー観点 |
| `docs/review-log/` | レビュー結果（gitignore 対象、最新 20 件まで保持） |
| `.claude/hooks/review-ledger.csv` | レビュー台帳（gitignore 対象） |

### 手動での実行

```bash
# 特定のコミット、または範囲をレビューする
node .claude/hooks/auto-review.mjs --range <sha>
node .claude/hooks/auto-review.mjs --range <from>..<to>

# いまのブランチのレビュー状況を確認する（マージ前の確認用）
node .claude/hooks/review-status.mjs --range
```

### 止め方

```bash
touch .claude/hooks/.review-off
```

このファイルがある間、自動レビューは何もせず終了する。削除すれば元に戻る。
`--range` による手動実行はこのファイルの影響を受けない。

### 注意

- レビューのたびに `claude -p` を起動するため、実行のたびに利用量を消費する。
- 無限ループ防止として、同一差分での連続 FAIL は 3 回、1 セッションの通算実行は
  6 回、連続 FAIL は 3 回で打ち切る。打ち切られた場合は
  `docs/review-log/` の最新ログを確認すること。

## 本フェーズのスコープ外

以下は将来的な拡張候補であり、実装していない。

- Notion 連携・同期
- ベクトル検索 / pgvector
- カテゴリの自動分類、審査エージェント、削除機構
- 管理用 UI
