# セットアップ手順書

本書は、リポジトリを取得した状態から MCP サーバーを稼働させるまでの作業手順を示す。
所要時間の目安は 30 分程度である。

各手順の末尾に「完了の判定」を記載している。そこに書かれた結果が得られない場合は、
次の手順へ進まず、[トラブルシューティング](#トラブルシューティング)を参照すること。

なお、リファレンスとしての各項目の説明は [`README.md`](../README.md) にある。
本書は実行順序に沿った作業指示のみを扱う。

## 全体像

| 手順 | 内容 | 前提 |
| --- | --- | --- |
| 手順 0 | 前提環境の確認 | — |
| 手順 1 | 自動レビューの有効化 | 手順 0 |
| 手順 2 | Supabase の準備 | 手順 0 |
| 手順 3 | Cloudflare へのデプロイとシークレット設定 | 手順 2 |
| 手順 4 | 疎通確認 | 手順 3 |
| 手順 5 | MCP クライアントの接続 | 手順 4 |

手順 1 は開発時の自動レビューに関するものであり、サーバーの稼働とは独立している。
サーバーを先に動かしたい場合は、手順 1 を後回しにしてもよい。

取り扱う秘密情報は次の 3 点である。いずれもリポジトリにコミットしてはならない。

| 名称 | 用途 | 発行元 |
| --- | --- | --- |
| `SUPABASE_URL` | 接続先プロジェクトの識別 | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | データベースの読み書き | Supabase |
| `MCP_AUTH_TOKEN` | MCP サーバーへのアクセス制限 | 自身で生成する |

---

## 手順 0. 前提環境の確認

### 0-1. アカウント

以下の 2 つのアカウントを用意する。いずれも無料プランで足り、
クレジットカードの登録は不要である。

- Cloudflare — https://dash.cloudflare.com
- Supabase — https://supabase.com

### 0-2. ローカル環境

Node.js 18 以上が必要である。

```bash
node -v
```

### 0-3. 依存関係の取得

リポジトリのルートで実行する。

```bash
npm install
npm run typecheck
```

**完了の判定**: `npm run typecheck` が何も出力せずに終了すること。

---

## 手順 1. 自動レビューの有効化

Claude Code のフックとして動作する自動レビュー機構を有効にする。
この手順を行わない場合、レビューは自動実行されない（手動実行は可能である）。

### 1-1. 設定内容の確認

設置するファイルの内容を確認する。このファイルは Claude Code に対して
任意のコマンドの実行を許可する設定を含むため、必ず目を通すこと。

```bash
cat docs/claude-settings.example.json
```

確認すべき点は次の 2 点である。

- `hooks` に定義されたコマンドが `.claude/hooks/` 配下のスクリプトのみを指していること
- `permissions.deny` に、意図しない破壊的操作が漏れていないこと

### 1-2. 設置

```bash
cp docs/claude-settings.example.json .claude/settings.json
```

### 1-3. 反映

フックはセッション開始時に読み込まれる。実行中の Claude Code がある場合は
一度終了し、起動し直すこと。

### 1-4. 動作確認

```bash
node .claude/hooks/review-status.mjs --range
```

**完了の判定**: コミットごとのレビュー状況が一覧表示されること。

自動レビューを一時的に止めたい場合は `.claude/hooks/.review-off` を作成する。
削除すれば再開する。

---

## 手順 2. Supabase の準備

### 2-1. プロジェクトの作成

Supabase にログインし、新しいプロジェクトを作成する。
入力を求められる項目と指針は次のとおりである。

| 項目 | 指針 |
| --- | --- |
| Name | 任意（例: `agent-failures`） |
| Database Password | 自動生成し、パスワード管理ツールへ保管する |
| Region | `Northeast Asia (Tokyo)` など、利用地域に近いもの |

プロジェクトの作成完了まで数分を要する。

### 2-2. 接続情報の取得

ダッシュボードでプロジェクトを開き、**Project Settings → API** を参照する。
以下の 2 つの値を控える。

| 取得する値 | 画面上の項目 | 形式 |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL | `https://<英数字>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | API キーのうち `service_role` のもの | 長い文字列 |

> **注意**: `anon` / `public` と表示されている方のキーではない。
> `service_role` キーは行単位のアクセス制御（RLS）を迂回できるため、
> 公開すると全データの読み書きが可能になる。
> Cloudflare のシークレットとして登録する以外の場所へ複製しないこと。

> **補足**: Supabase の管理画面は改定されることがあり、本書執筆時点の
> 画面構成と異なる可能性がある。`service_role` に相当する項目が
> 見当たらない場合は、公開してはならない旨の警告が添えられているキーを探すこと。

### 2-3. マイグレーションの適用

データベースにテーブルを作成する。次のいずれかの方法で実施する。

#### 方法 A: Supabase CLI を用いる

```bash
supabase login
supabase link --project-ref <プロジェクトの ref>
supabase db push
```

`<プロジェクトの ref>` は、ダッシュボードの URL
（`https://supabase.com/dashboard/project/<ref>`）に含まれる英数字である。

#### 方法 B: SQL Editor に貼り付ける

CLI を導入しない場合は、以下のファイルの内容をすべてコピーし、
ダッシュボードの **SQL Editor** に貼り付けて実行する。

```
supabase/migrations/20260908000001_create_failures.sql
```

### 2-4. 適用結果の確認

ダッシュボードの **Table Editor** を開く。

**完了の判定**: `failures` テーブルが存在し、`id` / `created_at` / `domain` /
`environment` / `attempted` / `observed` / `cause` / `cause_is_assumption` /
`workaround` / `tags` / `search_text` の各列が並んでいること。

---

## 手順 3. Cloudflare へのデプロイとシークレット設定

### 3-1. Cloudflare へのログイン

```bash
npx wrangler login
```

ブラウザが開き、認可を求められる。許可すると認証情報がローカルへ保存される。
この操作は初回のみでよい。

### 3-2. デプロイ

```bash
npx wrangler deploy
```

出力に表示される `https://agent-failures-mcp.<サブドメイン>.workers.dev` が、
本サーバーのエンドポイントである。以降の手順で使用するため控えておく。

この時点ではシークレットが未設定であり、サーバーは要求を処理できない。
それが正常な状態である。

```bash
curl -sS https://agent-failures-mcp.<サブドメイン>.workers.dev/health
```

上記が `{"status":"misconfigured"}` を返すことを確認する。

### 3-3. 認証トークンの生成

MCP サーバーへのアクセスを制限するためのトークンを生成する。
これは Supabase とは無関係であり、自身で決める値である。

```bash
openssl rand -base64 48
```

出力された文字列を控える。手順 5 で MCP クライアントの設定にも使用するため、
パスワード管理ツールへ保管すること。

### 3-4. シークレットの登録

3 つのシークレットを 1 つずつ登録する。Worker 名は `wrangler.jsonc` から
自動的に解決されるため、指定は不要である。

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put MCP_AUTH_TOKEN
```

各コマンドは値の入力待ちとなる。値を貼り付けて Enter を押す。

> **補足**: 入力中の文字は画面へ表示されない。これは仕様であり、
> 入力が受け付けられていないわけではない。

### 3-5. 登録結果の確認

```bash
npx wrangler secret list
```

3 件の名称が表示される。値は暗号化して保管されるため、表示されない。

```bash
curl -sS https://agent-failures-mcp.<サブドメイン>.workers.dev/health
```

**完了の判定**: `{"status":"ok"}` が返ること。
シークレットの登録は即時に反映されるため、再デプロイは不要である。

---

## 手順 4. 疎通確認

エンドポイントとトークンを環境変数へ設定する。

```bash
export MCP_URL=https://agent-failures-mcp.<サブドメイン>.workers.dev
export MCP_AUTH_TOKEN=<手順 3-3 で生成した値>
```

### 4-1. 認証の確認

トークンを付けずに要求し、拒否されることを確認する。

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$MCP_URL/mcp" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

**完了の判定**: `401` が返ること。

### 4-2. ツール一覧の取得

```bash
curl -sS -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**完了の判定**: `search_failures` と `record_failure` の 2 件が返ること。

### 4-3. 登録の確認

ここで初めて、Worker から Supabase への書き込みが行われる。

```bash
curl -sS -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{
      "name":"record_failure",
      "arguments":{
        "domain":"setup",
        "environment":"Cloudflare Workers / Supabase",
        "attempted":"疎通確認のため、失敗談を1件登録した",
        "observed":"登録に成功した",
        "cause":"疎通確認のためのダミーデータである",
        "cause_is_assumption": false,
        "tags":["setup","dummy"]
      }
    }
  }'
```

**完了の判定**: 登録された内容が整形されて返ること。
Supabase の Table Editor でも 1 行増えていることを確認できる。

### 4-4. 検索の確認

```bash
curl -sS -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{"name":"search_failures","arguments":{"query":"疎通確認","limit":3}}
  }'
```

**完了の判定**: 手順 4-3 で登録した内容が返ること。

確認が済んだダミーデータは、Supabase の Table Editor から削除してよい。

---

## 手順 5. MCP クライアントの接続

### Claude Code の場合

```bash
claude mcp add --transport http agent-failures \
  "$MCP_URL/mcp" \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

### 設定ファイルで指定する場合

```json
{
  "mcpServers": {
    "agent-failures": {
      "type": "http",
      "url": "https://agent-failures-mcp.<サブドメイン>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

**完了の判定**: クライアント側で `search_failures` と `record_failure` が
利用可能なツールとして認識されること。

> **注意**: 設定ファイルにトークンを直接記載する場合、
> そのファイルをバージョン管理へ含めないこと。

---

## トラブルシューティング

### `/health` が `misconfigured` のまま変わらない

`npx wrangler secret list` で 3 件すべてが登録されているかを確認する。
名称の綴りが 1 文字でも異なると未設定として扱われる。

### 手順 4-3 で「失敗談の登録に失敗しました」が返る

Worker から Supabase への接続で問題が生じている。次の順に確認する。

1. `SUPABASE_URL` の末尾に `/` や余分な空白が含まれていないか
2. 登録したキーが `anon` ではなく `service_role` であるか
3. 手順 2-4 のとおり `failures` テーブルが作成されているか

値を訂正する場合は、同じ `npx wrangler secret put <名称>` を再実行すれば
上書きされる。

### 401 が返る

送信しているトークンと、`npx wrangler secret put MCP_AUTH_TOKEN` で
登録した値が一致しているかを確認する。
`Authorization: Bearer ` に続けて値を置く形式である点にも注意する。

### しばらく使わずにいたら接続できなくなった

Supabase の無料プランは、7 日間データベースへのアクセスがないと
プロジェクトを自動停止する。ダッシュボードから復旧できる。

これを避けるため、Cron Trigger による定期アクセスを設定してある
（`wrangler.jsonc` の `triggers.crons`）。停止が繰り返される場合は、
当該設定が有効なままか確認すること。

### 自動レビューが止まらない

`.claude/hooks/.review-off` を作成すると即座に停止する。

```bash
touch .claude/hooks/.review-off
```

削除すれば元に戻る。

---

## 秘密情報の取り扱い

- `.env` および `.dev.vars` は `.gitignore` の対象である。この設定を変更しない。
- `SUPABASE_SERVICE_ROLE_KEY` と `MCP_AUTH_TOKEN` を、
  課題管理システム・チャット・コミットメッセージへ貼り付けない。
- トークンの漏洩が疑われる場合は、`openssl rand -base64 48` で新しい値を生成し、
  `npx wrangler secret put MCP_AUTH_TOKEN` で上書きしたうえで、
  クライアント側の設定も差し替える。上書きにより旧トークンは即座に無効となる。
