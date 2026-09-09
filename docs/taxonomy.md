# domain と tags の使い分け

`domain` は完全一致で検索するため、表記が揺れると絞り込みが機能しなくなる。
実際、運用開始から数時間で記録 9 件に対し `domain` が 8 種類まで分散し、
`domain` による絞り込みが成立しない状態になった。本書はその対応として定めた規約である。

規約の正本は [`src/schema.ts`](../src/schema.ts) の `KNOWN_DOMAINS` および
各項目の説明文にある。記録するエージェントはツールの説明文を通じてこれを読むため、
本書と実装が食い違った場合は実装が優先される。

## 使い分け

| 項目 | 表すもの | 例 |
| --- | --- | --- |
| `domain` | 失敗が起きた場所の**技術** | `nextjs` / `cloudflare-workers` |
| `tags` | 失敗の**性質・話題・関連技術** | `silent-failure` / `caching` / `prisma` |

判断の基準は「**その技術に触るときに引きたいか**」である。
Next.js のアプリを触るなら `domain: nextjs` で関連する失敗を一望できる、という単位にする。

`notification-design` や `api-cache-design` のような話題の名称を `domain` に入れると、
記録ごとに新しい値が生まれて一望できなくなる。話題は `tags` へ入れる。

## domain の語彙

現在使用している値は以下のとおり。追加するには
[`src/schema.ts`](../src/schema.ts) の `KNOWN_DOMAINS` を変更してデプロイする必要がある。
手軽に増やせないことは意図した制約であり、安易な新語を防ぐためのものである。

| 値 | 対象 |
| --- | --- |
| `nextjs` | Next.js / React / App Router を用いたアプリケーション |
| `cloudflare-workers` | Cloudflare Workers / wrangler |
| `supabase` | Supabase / PostgreSQL |
| `github-actions` | CI ワークフロー |
| `claude-code` | Claude Code の設定・フック・MCP・実行環境 |
| `windows-powershell` | Windows のシェル環境 |
| `discord-api` | Discord への投稿・Bot |

## tags の付け方

次の 3 種類を意識して付ける。

1. **失敗の性質**（最低 1 つ）
   `silent-failure` / `security` / `data-loss` / `encoding` / `quota` /
   `race-condition` / `permissions` など
2. **話題・設計パターン**
   `caching` / `idempotency` / `authorization` / `notification` / `planning` など
3. **`domain` 以外の関連技術**
   `prisma` / `pnpm` / `discord` / `cron` など

1 を必ず含めるのは、**技術が変わっても失敗の性質は繰り返される**ためである。
`silent-failure` で横断的に引けることには、`domain` による絞り込みとは別の価値がある。

## 語彙が増えすぎたときは

`domain` が増え続ける場合、それは技術が増えたのではなく、規約が守られていない可能性が高い。
[`docs/claude-md-snippet.md`](./claude-md-snippet.md) の記載と、
ツールの説明文の両方が最新かを確認すること。
