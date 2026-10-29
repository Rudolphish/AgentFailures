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

### fetch ハンドラは async として宣言する

`export default` のハンドラは、必ず `async fetch(...)` と宣言し、
`return await ...` の形で返すこと。

Promise を返す非 async のメソッドとして書いた場合、ローカルの `wrangler dev` では
正常に動作するが、**デプロイ先では**リクエストのたびに
`TypeError: Callback returned incorrect type; expected 'Promise'` が発生し、
Cloudflare の error 1101 となる。

あわせて、ハンドラ全体を try/catch で囲むこと。例外を捕捉しない場合、
Cloudflare が返すのは 1101 のエラーページのみで、原因を示す情報が
ログにも応答にも一切残らない。捕捉して `console.error` へ出せば
`wrangler tail` で内容を確認できる。

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

### Cron の曜日は 1 始まりで、1 が日曜である

`wrangler.jsonc` の `0 3 * * 1,4` は**日曜と水曜**であり、月曜と木曜ではない。

Cloudflare の cron パーサ（`cloudflare/saffron`）は曜日を 1 始まりで数える。
`saffron/src/parse.rs` の `dow_expr` のテストが
`SUN=1 / MON=2 / TUE=3 / WED=4 / THU=5 / FRI=6 / SAT=7` を示している。
一般的な Unix cron（0=日曜）とは 1 つずれるため、他所から持ってきた式は
そのまま使えない。

実際の発火日はダッシュボードの Settings → Trigger Events に
「At 03:00 AM on Sunday and Wednesday」のように文章で表示される。
**式を変えたらここを必ず読むこと。** 式だけを見て判断すると 1 日ずれる。

なお同リポジトリの `saffron/src/lib.rs` にある `byte_to_weekday` は
`0 => Sun` と書かれているが、これはパース後に -1 された内部表現であり、
入力の番号付けではない。ここを入力側と取り違えて誤った結論を出した。

### 停止中でも Supabase のログは読める

プロジェクトが停止すると `execute_sql` は
`Database is possibly not accessible at the moment` を返し、Worker 経由は
Cloudflare の error code 1016 になる。**この状態でも `query_logs`（ログ参照）は
使える。** 停止前後の記録を読めるため、復旧を待たずに切り分けられる。

- `edge_logs` — keep-alive の `POST | 201 | /rest/v1/keepalive_log` と応答コード。
  **keep-alive が発火したかどうかはここで分かる。** `keepalive_log` を読めなくてよい
- `postgres_logs` — `database system was interrupted; last known up at ...` に
  停止時刻が出る。`checkpoint starting: immediate force wait` と
  `restore point ... created` の並びが停止操作の直前に現れる

**最終書き込み時刻と停止時刻の差を必ず確認すること。** keep-alive を入れてあると
「無アクセスで停止した」と決めつけがちだが、2026-10-29 の停止は最終書き込みの
26 時間 36 分後であり、無アクセスでは説明できなかった。

復旧は point-in-time recovery を伴う（`selected new timeline ID` が出る）。
復旧後はデータの件数を実際に数えて欠落が無いことを確認すること。

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

### 手動実行では標準入力を閉じる

```bash
node .claude/hooks/auto-review.mjs --range <sha> < /dev/null
```

`auto-review.mjs` は冒頭の `readStdinJson()` で標準入力を読む。フックから
起動された場合は JSON が渡されて閉じられるが、標準入力が開いたままの文脈で
実行すると EOF を待って停止する。**出力もログも残らないため、プロセスの
経過時間を見るまで異常だと気づけない。** 実際に 13 分 34 秒停止した。

`runReviewer` の `execSync` には 4 分の打ち切りがあるが、そこへ到達する前に
止まるため機能しない。

またレビューは 2 分から 4 分を要するため、**他の処理と 1 つのコマンドに繋げない
こと。** コマンドの上限時間を超えてバックグラウンドへ移され、この停止を誘発する。

### review-decisions.csv へ書いてよいもの

このファイルはレビュアーへ「決着済みの論点」として渡され、同じ指摘を
繰り返させないために使う。開発側が自分への指摘を無効化できる構造であるため、
書き込める内容を次のとおり限定する。

- **開発側が書いてよいのは `accepted` のみ**。かつ「指摘を受けて修正し、その修正
  コミット自体が自動レビューで独立して PASS を得ている」ものに限る。
  evidence 欄には修正コミットと、その PASS を示すレビューログを記載する。
- **`rejected`（指摘の却下）は人が書く。** 開発側の判断で指摘を無効化しないこと。
  却下すべきと考える根拠がある場合は、ファイルへ書かずユーザーへ提示して判断を仰ぐ。
- `deferred` も同様に人が書く。
