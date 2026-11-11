# D1 への移行計画

失敗談ストアを Supabase (PostgreSQL) から Cloudflare D1 (SQLite) へ移す計画。

**本書は計画のみである。** 実装は始めていない。着手の判断は人が行う。

移行の動機は Supabase 無料プランの自動停止である。2026-10-29 と 2026-11-11 の
2 回停止し、いずれも人がダッシュボードから復旧した。週 2 回・1 行ずつの
keep-alive では回避できないことが実測で分かっている（`6b444914`）。

---

## 1. 調査結果（一次情報・2026-11-11 取得）

出典は `developers.cloudflare.com`。取得できなかった項目は「確認できなかった」と書く。

### 停止について

**D1 の `limits` / `pricing` / 概要の 3 ページに、非アクティブ停止の記述は 1 つも無い。**
`inactiv` `idle` `pause` `sleep` `hibernat` `dormant` `evict` のいずれも 0 件。
代わりに `pricing` に次がある。

> **Scale-to-zero:** You are not billed for hours or capacity units.
> If you are not running queries against your database, you are not billed for compute.

各 D1 データベースは Durable Object 1 つに支えられており、常時起動のインスタンスを持たない。

**ただし「停止しない」と明記した文は見つかっていない。** 記述が無いことと、
停止が無いことは別である。Supabase が自動停止を明示的に文書化しているのに対し、
D1 は停止に触れず scale-to-zero を謳っている、というのが確認できた範囲である。

### 無料枠の上限（`limits` ページ / Last updated Oct 30, 2026）

| 項目 | Free | Workers Paid |
| --- | --- | --- |
| データベース数 | 10 | 1,000,000（10 万まで込み、超過 $0.10/個/月） |
| 1 DB の最大サイズ | 500 MB | 10 GB（**引き上げ不可**） |
| アカウント合計ストレージ | 5 GB | 1 TB |
| 行読み取り | **500 万 / 日** | 月 250 億込み + $0.001/百万行 |
| 行書き込み | **10 万 / 日** | 月 5,000 万込み + $1.00/百万行 |
| Time Travel（PITR） | **7 日** | 30 日 |
| Worker 1 呼び出しあたりのクエリ数 | 50 | 1,000 |

クエリ単位の上限は両プラン共通。SQL 文 100 KB / バインド引数 100 /
1 テーブルの列数 100 / 行・BLOB 2 MB / クエリ 30 秒 / **結果サイズ 50 MB**。

### 2026 年の変更

| 日付 | 内容 |
| --- | --- |
| 2026-09-01 | **無料枠の日次クエリ上限が強制されるようになった。** 超えると Binding API / REST API がエラーを返し、**UTC 0 時まで**クエリできない。**保存データは影響を受けない。** 上限到達時にメール通知 |
| 2026-10-23 | 削除した DB の undelete は**削除後 7 日以内**のみ |
| 2026-11-04 | クエリ結果 50 MB 上限の強制開始 |

### SQL の対応範囲（`sql-api/sql-statements` ページ）

- **FTS5 が使える**（`fts5vocab` を含む）。JSON 拡張、数学関数も使える
- `PRAGMA table_xinfo` が生成列を含む旨の記述があり、生成列は存在する
- **`wrangler d1 export` は仮想テーブルを含む DB をエクスポートできない**
  （"Export is not supported for virtual tables, including databases with virtual tables"）

### 入出力（`best-practices/import-export-data` ページ）

- 取り込みは `wrangler d1 execute <db> --remote --file=dump.sql`。**5 GiB 上限**
- **生の `.sqlite3` は直接取り込めない。** SQL 文へ変換してから渡す
- `_cf_KV` という予約テーブルが見える。クエリ不可、課金対象外

### 確認できなかったこと

- **FTS5 の `tokenize='trigram'` が D1 のビルドで有効かどうか。** ドキュメントは
  トークナイザを列挙していない。後述のとおり**この計画では FTS5 を使わない**ため、
  検証は不要にしてある
- Cloudflare アカウント全体の、無料枠リソースに対する非アクティブ削除方針。
  D1 のドキュメントには無い

---

## 2. 全文検索をどうするか（この移行の要）

現在の実装は `pg_trgm` に依存している。SQLite に `pg_trgm` は無い。

選択肢は 2 つあった。**索引なしの素の `LIKE` を選ぶ。**

### 選んだ案: 索引なしの `LIKE '%...%'` 全表走査

**根拠は分量である。** 1 検索が読む行数は、そのままテーブルの行数になる。

| 行数 | 1 検索の行読み | 500 万行読み/日 で可能な検索回数 |
| --- | --- | --- |
| 134（2026-11-11 時点） | 134 | 約 37,000 回 |
| 1,000 | 1,000 | 5,000 回 |
| 10,000 | 10,000 | 500 回 |

**実測で 5 日間に検索 0 件・書き込み 10 件だったストアである。** 1 日 500 回でも
桁が 2 つ余る。1 万件に達するのは、現在の増加ペース（2 週間で約 20 件）では数年先である。

SQLite の `LIKE` は ASCII については既定で大文字小文字を区別しないため、
`environment` の照合（例: `wrangler 4`）は現在の `ilike` と同じ挙動になる。
日本語には大小の区別が無いため影響しない。

### 採らなかった案: FTS5（trigram トークナイザ）

**理由は 2 つ。**

1. **`wrangler d1 export` が使えなくなる。** 仮想テーブルを含む DB は
   エクスポートできない。Time Travel（無料 7 日）はあるが、**手元へ落とせる
   バックアップを失う**のは、移行の目的（可用性を上げる）と逆行する
2. trigram トークナイザが D1 のビルドで有効かどうかが**確認できていない**。
   分量の計算で不要と分かっているものに、未検証の依存を増やす理由が無い

**行数が 1 万を大きく超えた時点で再検討する。** そのときは「エクスポートを
捨てるか、FTS5 を別 DB に分けるか」という判断になる。本書にその条件を書いておく。

---

## 3. スキーマの対応

現在の `failures` / `keepalive_log` を SQLite へ写す。左が現在、右が移行後。

| 現在 (PostgreSQL) | 移行後 (SQLite / D1) | 備考 |
| --- | --- | --- |
| `uuid primary key default gen_random_uuid()` | `TEXT PRIMARY KEY` | **id は Worker 側で `crypto.randomUUID()` を生成して渡す。** SQLite に uuid 生成関数は無い |
| `timestamptz not null default now()` | `TEXT NOT NULL`（ISO 8601 UTC） | **Worker 側で `new Date().toISOString()` を渡す。** `CURRENT_TIMESTAMP` は書式が `YYYY-MM-DD HH:MM:SS` で ISO と異なるため、既定値には使わず経路を 1 つに絞る |
| `boolean not null` | `INTEGER NOT NULL CHECK (x IN (0,1))` | 読み出し時に真偽へ戻す |
| `tags text[] not null default '{}'` | `TEXT NOT NULL DEFAULT '[]'`（JSON 配列） | JSON 拡張が使えるため、タグ絞り込みは `json_each` で書ける |
| `check (length(btrim(x)) > 0)` | `CHECK (length(trim(x)) > 0)` | SQLite に `btrim` は無い。`trim` が同義 |
| `search_text` 生成列 + `failures_search_text()` immutable 関数 | `search_text` 生成列（`STORED`） | **ラッパー関数は不要になる。** SQLite に `immutable` の概念が無く、生成列の式に `||` と `coalesce` を直接書ける。`CLAUDE.md` の「生成列から呼ぶ関数は immutable でなければならない」は Postgres 固有の罠として残す |
| `bigint generated always as identity` | `INTEGER PRIMARY KEY AUTOINCREMENT` | `keepalive_log` 用。keep-alive を廃止するなら不要（§6） |
| 索引: `created_at desc` / `domain` | 同じものを張る | 読み出しの既定が新しい順、`domain` は完全一致 |
| 索引: `environment` / `search_text` の trigram GIN | **張らない** | §2 のとおり全表走査にする |
| 索引: `tags` GIN | **張らない** | タグ絞り込みは現在 MCP の入力に無い |
| RLS 有効 + ポリシー無し + `revoke` | **不要** | **D1 は Worker の binding からのみ到達できる。** anon キーに相当するものが存在しないため、遮断のための仕掛けが要らない。認証は現在どおり固定トークンのヘッダ照合 |

`search_text` の生成列は次の形になる見込み（検証前）。

```sql
search_text TEXT GENERATED ALWAYS AS (
  domain || ' ' || environment || ' ' || attempted || ' ' || observed || ' ' ||
  cause || ' ' || coalesce(workaround, '') || ' ' ||
  coalesce(replace(replace(replace(tags, '[', ''), ']', ''), '"', ''), '')
) STORED
```

タグの連結は JSON の角括弧と引用符を落とす形にしてある。`json_each` は生成列の
式に使えない可能性があるため、**ここは §5 の検証項目に入れる。**

---

## 4. コードの対応

| 現在 | 移行後 |
| --- | --- |
| `@supabase/supabase-js` の `createClient` | **依存を削除。** `env.DB`（`D1Database`）をそのまま使う |
| `env.SUPABASE_URL` / `env.SUPABASE_SERVICE_ROLE_KEY` | **不要。** binding は `wrangler.jsonc` の `d1_databases` で宣言する。シークレットが 2 つ減る |
| `store.from(TABLE).select(...).eq(...).ilike(...)` | `env.DB.prepare(sql).bind(...).all()` |
| `escapeLikePattern()` の `*` → 空白置換 | **不要。** これは PostgREST が `ilike` の値の `*` を `%` として扱うことへの対処であり、D1 には無い。`\` `%` `_` のエスケープは**引き続き必要**（`LIKE ... ESCAPE '\'` を明示する） |
| 返却件数の二重の切り詰め | **そのまま残す。** 「上限超過を返さない」は要件であり、SQL の `LIMIT` だけに依存させない |
| `ping()` | §6 |

SQL は 1 本に組み立てる。バインド引数の上限は 100 で、本クエリは最大 4 個なので余裕がある。

```sql
SELECT id, created_at, domain, environment, attempted, observed,
       cause, cause_is_assumption, workaround, tags
  FROM failures
 WHERE (?1 IS NULL OR domain = ?1)
   AND (?2 IS NULL OR environment LIKE ?2 ESCAPE '\')
   AND (?3 IS NULL OR search_text LIKE ?3 ESCAPE '\')
 ORDER BY created_at DESC
 LIMIT ?4
```

`tags` は JSON 文字列で返るため、Worker 側で `JSON.parse` する。
`cause_is_assumption` は 0/1 で返るため真偽へ戻す。**この 2 箇所が、
移行で最も取り違えやすい。** 型の変換を 1 箇所（行→`FailureRecord` の写し取り）に閉じる。

`src/transport.ts` と MCP サーバーの構成（1 リクエスト = 1 JSON レスポンス、
ステートレス）は**変更しない**。移行の影響は `store.ts` と `env.ts`、
`wrangler.jsonc` に収まる。

---

## 5. 事前に検証すること

**`--local` で通ったことは `--remote` で通る保証にならない**（`docs/lessons.md`）。
各項目を `--remote` で確かめる。

| # | 確認すること | 方法 | 落ちたらどうするか |
| --- | --- | --- | --- |
| 1 | 生成列の式が受け付けられるか | §3 の `CREATE TABLE` を `--remote` で実行 | `replace` の入れ子を諦め、`tags` を連結せずに別列で持つ |
| 2 | 日本語の `LIKE '%...%'` が一致するか | 日本語を含む行を入れて `LIKE` で引く | 一致しない場合は移行そのものを再検討（検索が成立しない） |
| 3 | `ESCAPE '\'` が効くか | `%` `_` を含む語で引く | エスケープを Worker 側の除去に変える |
| 4 | `json_each` でタグを絞り込めるか | `SELECT ... FROM failures, json_each(tags)` | タグ絞り込みは将来の課題として降ろす（現在 MCP の入力に無い） |
| 5 | 134 行での 1 検索の行読み数 | `meta.rows_read` を読む | 想定（≒行数）と大きく違えば §2 の計算をやり直す |
| 6 | `wrangler d1 export` が通るか | `--remote` でエクスポート | 仮想テーブルを作っていないので通るはず。通らなければ原因を特定する |

**5 は特に省かない。** 「索引なしの全表走査で足りる」という §2 の判断は
行読み数の見積もりに乗っているため、実測しないまま進めると根拠が無くなる。

---

## 6. keep-alive をどうするか

**停止が無くなるなら keep-alive は不要になる。** ただし即座には消さない。

| 段階 | 扱い |
| --- | --- |
| 移行直後 | **残す。** Cron の宛先を D1 の `keepalive_log` へ向け、書き込みが通り続けることを見る |
| 30 日ほど様子を見たあと | 停止が起きないことを確認して**削除する**。Cron Trigger、`keepalive_log`、`ping()`、`review-checklist.md` の該当項目をまとめて落とす |

残す理由は 2 つある。**「D1 は停止しない」が文書で明記されていない**（§1）ため、
30 日は観測で裏を取りたい。もう 1 つは、`keepalive_log` が
「最後に書き込めたのはいつか」の記録として働いており、**移行直後の
切り分けにそのまま使える**ことである。

なお D1 の日次上限は書き込み 10 万行/日で、週 2 回 1 行では一切影響しない。

---

## 7. 失われるもの

移行で**無くなる**ものを先に書く。ここを数えずに進めると後から気づく。

| 失うもの | 影響 | 代替 |
| --- | --- | --- |
| **Supabase MCP コネクタ（`execute_sql`）** | エージェントが SQL を直接叩いて件数を数える・調査するができなくなる。**本セッションで多用した** | `npx wrangler d1 execute <db> --remote --command "..."`、または D1 の REST API。ダッシュボードにもコンソールがある |
| **`query_logs`（停止中でもログが読める）** | 停止の切り分け手段。`CLAUDE.md` に項目として書いてある | **停止が無くなるなら不要になる。** Worker 側のログは `wrangler tail` |
| **Supabase ダッシュボードでの人間の閲覧** | 最初のマイグレーションのコメントに「閲覧は人間も Supabase ダッシュボード経由で行う」と書いてある | D1 のダッシュボードのコンソール。表形式の閲覧体験は落ちる |
| **PITR 30 日相当** | 無料プランの Time Travel は **7 日** | 7 日で足りるかの判断が必要。足りないなら定期エクスポートを別途仕込む |
| 行数の目安が見える UI | — | `wrangler d1 info` |

**`CLAUDE.md` の落とし穴 3 件は Postgres 固有であり、移行後は該当しなくなる**
（生成列と immutable、PostgREST の `ilike` のパターン文字、日本語と tsvector）。
削除せず「Supabase を使っていた時期の記録」として残すか、別の節へ移すかを決める。

---

## 8. 手順

並行稼働はしない。**データが 134 行と小さく、停止を許容できる時間帯があるため、
切り替えは一度で行う。**

| 段階 | やること | 完了の判定 |
| --- | --- | --- |
| 0 | §5 の検証を `--remote` で実施 | 6 項目すべてに結果が付いている。落ちた項目の対処が決まっている |
| 1 | D1 データベースを作る（`wrangler d1 create`）。`wrangler.jsonc` に binding を宣言 | `wrangler d1 info` が引ける |
| 2 | スキーマのマイグレーションを書き、`--remote` へ適用 | `PRAGMA table_xinfo("failures")` が生成列を含む全列を返す |
| 3 | Supabase から全行を取り出し、`INSERT` 文へ変換 | **行数が一致する。** 変換は `tags` を JSON 文字列、`cause_is_assumption` を 0/1、時刻を ISO 8601 にする |
| 4 | `wrangler d1 execute --remote --file=dump.sql` で取り込む | **件数を数えて一致を確認する。** 加えて日本語を含む 1 件を目で読んで文字化けが無いことを見る |
| 5 | `store.ts` / `env.ts` を書き換え、`npm run typecheck` | 型が通る |
| 6 | `wrangler dev` で `search_failures` / `record_failure` を通す | README の疎通確認 curl が通る。**日本語の往復で文字列が一致する** |
| 7 | デプロイし、**デプロイ先で**同じ curl を流す | 同上。`fetch` ハンドラが async であることは既存のまま |
| 8 | Supabase 側は**消さずに残す**（読み取り専用の退避先として） | — |
| 9 | 文書を直す（§9） | — |

**3 と 4 を分けてある。** 取り込みが失敗したときに、変換の誤りか取り込みの
誤りかを切り分けられるようにするためである。

### 後戻り

段階 7 で問題が出た場合、`store.ts` を戻して再デプロイすれば Supabase へ復帰できる。
**段階 8 で Supabase を消さないのはこのためである。** 移行後 30 日は残す。

ただし**その 30 日の間に Supabase 側が自動停止する**。復帰させるなら
ダッシュボードから Restore が必要になる。これは「後戻りは即座ではない」という
意味であり、段階 6 と 7 の確認を省かない理由になる。

---

## 9. 直す文書

移行とは独立に、**現時点で既に誤っている記述がある。**

| 場所 | 現在の記述 | 問題 |
| --- | --- | --- |
| `README.md` の「Supabase の自動停止」 | 「アクセス間隔は最大 4 日となり、自動停止の閾値を下回る」 | **2 回の停止で誤りと分かっている。** 判定は活動量であり、間隔ではない |
| `docs/requirements.md` §7 | 「7 日間データベースへのアクセスが無い場合に自動停止する」 | 同上 |
| `docs/ideas.md` 案 4 の根拠 | 「7 日間アクセスが無いと自動停止する」 | 同上 |

**これは移行の前に直す。** 移行しない判断になった場合でも、この 3 箇所は誤っている。
放置すると次に読んだエージェントが「4 日間隔なら大丈夫」と判断する。

移行を実施した場合に直すもの。

- `README.md` の構成・セットアップ手順・疎通確認（Supabase の項を D1 へ）
- `docs/requirements.md` の §1 構成と §7 可用性
- `CLAUDE.md` の落とし穴（§7 のとおり、Postgres 固有の 3 件の扱いを決める）
- `docs/review-checklist.md` の keep-alive の項目（§6 の段階に合わせる）
- `docs/setup-guide.md` の Supabase の節

---

## 10. やらない判断をする条件

次のいずれかに当たったら、移行を止めて Supabase に留まる。

- §5 の **2（日本語の `LIKE` 一致）が通らない。** 検索が成立しないため、
  代替は FTS5 の trigram しかなく、それも未検証である
- 無料枠の **Time Travel 7 日では足りない**と判断した場合。別のバックアップ手段を
  用意する手間が、停止を手で復旧する手間を上回るなら、移行の意味が薄い
- **Supabase を Pro へ上げる判断をした場合。** 停止が無くなるため、移行の動機そのものが消える

---

## 11. 規模の見積もり

| 段階 | 見込み |
| --- | --- |
| §5 の検証 | 1 時間 |
| スキーマとデータの移行（§8 の 1〜4） | 1〜2 時間 |
| コードの書き換え（5〜7） | 2〜3 時間 |
| 文書（9） | 1〜2 時間 |

**`docs/ideas.md` の案 4「サービスの生存確認」とは独立である。** 移行しても
しなくても、停止や異常に気づく手段は別途必要になる（gamers-highlight と
もう 1 つの Supabase プロジェクトは依然として対象外のままである）。
