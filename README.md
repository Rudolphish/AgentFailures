# AgentFailures

AI エージェント群が「失敗談」を蓄積・参照するためのナレッジストア、および
それを読み書きするリモート MCP サーバー。

エージェントはタスクの実行計画を立てる前に `search_failures` を呼び出して
同種の失敗が記録されていないかを確認し、失敗が発生した場合は `record_failure`
で記録する。人間が中身を見る場合は、Cloudflare の D1 コンソール（または
`wrangler d1 execute`）から `failures` を引く。

初めてセットアップする場合は、実行順に沿った [`docs/setup-guide.md`](docs/setup-guide.md) を参照すること。
本書は各項目のリファレンスであり、作業手順は同ファイルにまとめている。

要件の詳細は [`docs/requirements.md`](docs/requirements.md) を参照。

## 構成

| 区分 | 採用技術 |
| --- | --- |
| ストア | Cloudflare D1 (SQLite)。binding 名 `DB`、データベース名 `agent-failures` |
| MCP サーバー | TypeScript / Cloudflare Workers / Streamable HTTP |
| SDK | `@modelcontextprotocol/sdk` |
| デプロイ | `main` への push で GitHub Actions が自動実行（手動は wrangler） |

**2026-11-20 に Supabase (PostgreSQL) から D1 へ移行した。** 動機は無料プランの
自動停止であり、経緯と対応関係は
[`docs/d1-migration-plan.md`](docs/d1-migration-plan.md) にある。

```
src/
├── index.ts      Worker のエントリポイント。ルーティング・認証・Cron ハンドラ
├── auth.ts       固定トークンの定数時間比較
├── transport.ts  Workers 用のステートレス Streamable HTTP トランスポート
├── mcp.ts        MCP サーバー定義とツール登録
├── schema.ts     zod による入力スキーマ
├── store.ts      D1 アクセス
├── format.ts     検索結果の整形
└── env.ts        binding とシークレットの型・存在検査
d1/migrations/
└── 0001_create_failures.sql    failures / 索引 2 本 / keepalive_log
supabase/migrations/            移行前のもの。履歴として残している
├── 20260908000001_create_failures.sql
└── 20260927000001_create_keepalive_log.sql
```

## 提供ツール

### `search_failures`

過去の失敗談を新しい順に検索する。

| 入力 | 必須 | 説明 |
| --- | --- | --- |
| `domain` | 任意 | 技術。完全一致で判定する（[`docs/taxonomy.md`](docs/taxonomy.md)） |
| `environment` | 任意 | 実行環境。大文字小文字を無視した部分一致で判定する |
| `query` | 任意 | キーワード検索。全項目を連結した文字列に対する部分一致 |
| `limit` | 任意 | 返却件数。既定 3、上限 5 |
| `detail` | 任意 | `summary`（既定）または `full`。`summary` は長い項目を切り詰める |

結果の見出しは `[domain] 何が起きたか ← 原因` の形で、原因が推定である場合は
`（推定）` が付く。判断に使うのは `observed`（何が起きたか）であり、
`attempted`（何をしようとしたか）はどの記録でも似た文になるため見出しに用いない。

`summary` での切り詰めは、実データに対しては 3% 程度しか分量を減らさない。
各項目の中央値が 85〜115 文字と一様であり、分量が少数の長い項目に由来しないためである。
上限の主目的は削減ではなく、1 項目あたり 4000 文字まで許すスキーマに対する歯止めである。

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

### 2. D1 データベースの準備

データベースを作成し、`wrangler.jsonc` の `database_id` を書き換えたうえで
マイグレーションを適用する。

```bash
npx wrangler d1 create agent-failures
# 出力された database_id を wrangler.jsonc の d1_databases[0] へ書く
npx wrangler d1 migrations apply agent-failures --remote
```

`database_id` は識別子であり秘密ではない。**コミットしてよい。**

マイグレーション（`d1/migrations/0001_create_failures.sql`）は以下を行う。

- `failures` テーブルと、検索対象を連結した生成列 `search_text`（`STORED`）の作成
- 必須項目に対する `NOT NULL` および空文字を拒否する `CHECK` 制約の付与
- `created_at` 降順索引と `domain` 索引の作成。`environment` と `search_text` は
  部分一致のため索引が効かず、全表走査になる（134 行での実測は 1 検索あたり
  最大 263 行読みであり、無料枠に対して桁が余る）
- `keepalive_log` の作成

**RLS に相当する仕掛けは置かない。** D1 へは Worker の binding からのみ到達でき、
`anon` キーに相当するものが存在しないためである。認証は MCP サーバー側の
固定トークン照合のみで行う。

適用されたかどうかは一覧で確かめられる（ネットワークを要しない）。

```bash
npx wrangler d1 migrations list agent-failures --local
```

> **注意**: `migrations_dir` は `wrangler.jsonc` の `d1_databases[]` の**中**に
> 書く。トップレベルに書くと警告 1 行だけで無視され、既定の `./migrations` を
> 見に行くため「マイグレーションが無い」ことになる。

### 3. シークレットの設定

シークレットは `MCP_AUTH_TOKEN` の 1 つだけである。ストアへの接続情報は
秘密ではなく、`wrangler.jsonc` の `d1_databases`（binding 名 `DB`）で宣言している。

`.env.example` に必要な環境変数を記載している。

| 変数 | 取得元 |
| --- | --- |
| `MCP_AUTH_TOKEN` | 任意の乱数。`openssl rand -base64 48` などで生成する |

ローカル開発では `.dev.vars` に配置する。

```bash
cp .env.example .dev.vars
# .dev.vars を編集して値を設定する
```

ファイルを作らずに渡すこともできる（秘密を書き出さずに済む）。

```bash
npx wrangler dev --var MCP_AUTH_TOKEN:<任意の値>
```

本番環境では wrangler のシークレットとして登録する。

```bash
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

> **Windows PowerShell 5.1 では、以下の `curl` をそのまま実行できない。**
> `curl` が `Invoke-WebRequest` の別名であり、引数体系が違う。`-s` は
> `-SessionVariable` の前方一致として解釈され、URL をその値として飲み込むため、
> `次のパラメーターに値を指定してください: Uri:` で止まる。**実際に踏んだ。**
> `curl.exe` を明示するか、`Invoke-RestMethod <URL>` を用いること。
> 日本語を含む本文を送る場合は、`-Body` に文字列ではなく
> `[System.Text.Encoding]::UTF8.GetBytes()` のバイト列を渡す
> （文字列のままでは保存された値が文字化けし、**応答は成功として返る**）。

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
成功時は `keepalive_log へ追記しました` と出る。

追記されたかどうかは D1 側からも確認できる。

```bash
npx wrangler d1 execute agent-failures --remote \
  --command "select max(ran_at) from keepalive_log"
```

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

> **測定結果（2026-10-29）**: 5 日分の edge ログを数えたところ、
> **書き込み 10 件に対し検索 0 件**だった。記録は自然に起きるが、検索は起きない。
> 同一原因の失敗が 6 回記録された例もある（`pkill` 自殺）。
> **自発的な検索は当てにならない。** そのため、蓄積した記録を規則へ蒸留して
> 各リポジトリの `CLAUDE.md` へ配る経路を別に用意した。
> [`docs/rules.md`](docs/rules.md)（規則の本体）と
> [`docs/rules-distribution.md`](docs/rules-distribution.md)（配り方）を参照。

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
`domain` には技術（`claude-code` / `nextjs` など）を、`tags` には失敗の性質や
話題を入れる。**`domain` の値に固定の一覧は持たない**（30 種類以上あり、手で書いた
一覧は追随できなかった）。規約はツールの説明文を通じて記録するエージェントへ伝わるため、
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

### 自動停止と keep-alive

**D1 に自動停止は無い。** 公式ドキュメントに該当する記述が無く、課金は使った分
のみである（scale-to-zero）。これが Supabase から移行した動機そのものである。

移行前の Supabase 無料プランは、**7 日以上にわたり「十分な活動量」
（sufficient activity）が無い**とプロジェクトを自動停止した。**判定基準は活動の
「量」であり、アクセスの間隔ではない。** これは Supabase から届いた通知の文面
（have not seen sufficient activity for more than 7 days）による。
そのため keep-alive を週 2 回入れても止まり、**実測で 4 回停止した。**

| 停止日 | 直前の状況 |
| --- | --- |
| 2026-09-27 | keep-alive が読み取りのみで、Cron が動いたかを確かめられなかった |
| 2026-10-13 | — |
| 2026-10-29 | 最終書き込みの 26 時間 36 分後 |
| 2026-11-11 | 最後の keep-alive（11-08 03:00）の 2 日 21 時間後。**次の keep-alive の 2 時間半前** |

間隔が一定でないことからも、間隔ではなく量で判定していたと読める。
**間隔を詰めることは対策にならなかった。**

Cron Trigger（`wrangler.jsonc` の `triggers.crons`）で毎週日曜・水曜の 03:00 UTC に
`keepalive_log` へ 1 行追記する処理は、**移行後も 30 日は残す。** 目的は 2 つで、
(1)「D1 は停止しない」を文書だけでなく観測で裏づけること、(2) `select max(ran_at)`
で「最後に書き込めたのはいつか」が分かること。観測が済んだら、Cron・
`keepalive_log`・`ping()` をまとめて落とす。

設定値は `0 3 * * 1,4` である。**Cloudflare の cron は曜日を 1 始まりで数え、
1 が日曜である**ため、この式は月曜・木曜ではなく日曜・水曜を指す。
詳細は [`wrangler.jsonc`](wrangler.jsonc) の注釈を参照。

```bash
# 最後に keep-alive が成功した時刻
npx wrangler d1 execute agent-failures --remote \
  --command "select max(ran_at) from keepalive_log"
```

この値が 4 日以上前であれば Cron が動いていない。

### 認証

`Authorization: Bearer <MCP_AUTH_TOKEN>` ヘッダによる固定トークン照合のみを
行う。OAuth は実装していない。トークンが漏洩した場合は
`wrangler secret put MCP_AUTH_TOKEN` で更新し、全クライアントの設定を
差し替えること。

### 検索の特性

`query` は `search_text`（全項目を連結した生成列）に対する `LIKE '%...%'` の
部分一致で実装している。日本語の文章に対しても語の切れ目に依存せず一致するが、
制約が 2 つある。

- **表記ゆれ（全角・半角、送り仮名など）は吸収しない。** 安定した検索を行うには
  `tags` を活用すること
- **渡した文字列が全体で 1 つの部分列として扱われる。** そのため複数語を
  空白で区切って渡すと、その並びがそのまま含まれる記録しか一致しない
  （実測では 0 件になる）。語を分割して AND で評価する改修は
  [`docs/mcp-optimization-plan.md`](docs/mcp-optimization-plan.md) の Phase 1 にある。
  **現状は 1 語ずつ渡すこと**

## 自動レビュー

Claude Code の Stop フックで、そのセッションの変更を自動レビューする仕組みを
同梱している。レビュー担当として `claude -p` を別プロセスで起動し、
[`docs/review-checklist.md`](docs/review-checklist.md) の観点で差分を確認する。

判定が `VERDICT: FAIL` の場合、フックは exit code 2 で Stop をブロックし、
指摘を開発側へ差し戻して修正させる。修正後に再度 Stop が発火して再レビューが走る。

### 有効化

フック定義は [`.claude/settings.json`](.claude/settings.json) にあり、
リポジトリに追跡されている。clone した時点で有効になるため、設置作業は要らない。

当初は手動コピーの手順としていたが、**5 週間コピーされないまま放置され、
その間レビューは一度も自動実行されていなかった。** 手作業を挟む設計をやめ、
ファイルそのものを追跡対象とした。

このファイルは Claude Code に `.claude/hooks/` 配下のスクリプトを実行させる。
初回はツール側が確認を求めるため、その際に中身を読むこと。

一時的に止めたい場合は、設定を消すのではなくキルスイッチを使う。

```bash
touch .claude/hooks/.review-off   # 消せば元に戻る
```

なお `permissions.deny` は多層防御であって境界ではない。
文字列一致で判定するため、コマンドの書き方を変えれば回避の余地がある。
危険な操作を確実に塞ぐ手段として当てにしないこと。

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

## 今後の改善案

着手していない案は [`docs/ideas.md`](docs/ideas.md) にまとめている。
判断の根拠と着手すべき時期を添えてある。

## 本フェーズのスコープ外

以下は将来的な拡張候補であり、実装していない。

- Notion 連携・同期
- ベクトル検索 / pgvector
- カテゴリの自動分類、審査エージェント、削除機構
- 管理用 UI
