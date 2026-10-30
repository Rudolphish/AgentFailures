# 規則の配り方

[`docs/rules.md`](rules.md) の規則を、他のリポジトリの `CLAUDE.md` へ届けるための手順。

## 仕組み

```
docs/rules.md            ← 規則の本体（編集はここ。PR のマージが承認）
   │  scripts/sync-rules.mjs（CI が一致を検査）
   ▼
AgentFailures/CLAUDE.md  ← 管理ブロック。**配布元はここ**
   │  各リポジトリの週次ワークフローが取得
   ▼
各リポジトリ/CLAUDE.md   ← 管理ブロック。PR のマージが承認
```

**配布元を `rules.md` ではなく AgentFailures の `CLAUDE.md` にしているのは意図的である。**

- 消費側は**マーカー間を切り貼りするだけ**でよく、`rules.md` を解析するロジックを
  複製しなくて済む。同じロジックを 2 箇所に置くと、必ず片方が古くなる
- このブロックは CI（`.github/workflows/rules.yml`）が `rules.md` との一致を検査して
  いる。**自分自身に配れていない状態のものは、他へ流れない**

取得するのは**データだけ**で、スクリプトは取得しない。他リポジトリから持ってきた
コードを実行する形にはしない。

AgentFailures は public なので、**トークンは要らない**。

## 配布先

| リポジトリ | 置き場所 | 状態 |
| --- | --- | --- |
| AgentFailures | `CLAUDE.md` の `## 共通の規則` | 配布元。CI が `rules.md` との一致を検査する |
| gamers-highlight | `CLAUDE.md` の `## DB（Supabase）` の直前 | 設置済み |
| kukuWebApp | `CLAUDE.md` の末尾 | 設置済み。**このリポジトリの独自記述は 248 文字**で、配布分の方が大きい |
| LearnAI | `CLAUDE.md` の `## Git の規則` の直前 | 設置済み。**`prettier --check .` が CLAUDE.md を検査する**（下記） |
| Tasquest | — | **対象外。** `CLAUDE.md` が無く、2026-09-17 以降 push が無い |

**Tasquest を外したのは意図的である。** `CLAUDE.md` が存在せず、中身が配布規則だけの
ファイルを新規に作ると、設計の向きが逆になる（リポジトリ自身の指示書の中に規則を
間借りさせる、が前提）。休止中のリポジトリに配っても読まれない。再開してリポジトリ
自身の `CLAUDE.md` ができた時点で、「受け取る側の設定」の手順を踏めばよい。

**この表は手で書いている。** 配布先が増減したら直すこと。自動で集める手段は無く、
後述の「既知の穴」と同じ性質の弱点である。

## 受け取る側の設定

### 1. CLAUDE.md にブロックを置く

規則を置きたい位置へ、次の 2 行を入れてコミットする。

```markdown
<!-- agentfailures:rules:start -->
<!-- agentfailures:rules:end -->
```

**黙って挿入する作りにはしていない。** `CLAUDE.md` はエージェントの振る舞いを縛る
ファイルなので、置き場所は人が決める。

### 2. ワークフローを置く

`.github/workflows/agentfailures-rules.yml` として保存する。

```yaml
name: AgentFailures Rules

# Rudolphish/AgentFailures の規則を CLAUDE.md の管理ブロックへ取り込む。
# 差分があれば pull request を出すだけで、自動では反映しない（マージが承認）。
#
# 取得元は AgentFailures 自身の CLAUDE.md にある管理ブロック。向こうの CI が
# docs/rules.md との一致を検査しているため、**自分に配れていないものは流れてこない**。
# 取得するのはデータだけで、スクリプトは取得しない（他所のコードを実行しない）。
# AgentFailures は public なのでトークンは要らない。
#
# 手順と既知の穴は次を参照。
# https://github.com/Rudolphish/AgentFailures/blob/main/docs/rules-distribution.md

on:
  schedule:
    - cron: '41 2 * * 1'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: agentfailures-rules
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: 規則を取り込む
        id: sync
        run: |
          set -euo pipefail
          SRC='https://raw.githubusercontent.com/Rudolphish/AgentFailures/main/CLAUDE.md'
          curl -fsSL "$SRC" -o /tmp/source.md
          # --input-type=module は必須。runner の既定 Node 版によっては
          # 標準入力が CommonJS として扱われ、import が構文エラーになる。
          node --input-type=module - <<'JS'
          import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
          const START = '<!-- agentfailures:rules:start';
          const END = '<!-- agentfailures:rules:end -->';
          const cut = (text, what) => {
            const s = text.indexOf(START);
            const e = text.indexOf(END);
            if (s === -1 || e === -1 || e < s) throw new Error(`${what} に管理ブロックがありません`);
            return { s, e, inner: text.slice(text.indexOf('\n', s) + 1, e) };
          };
          const source = readFileSync('/tmp/source.md', 'utf8');
          const src = cut(source, '取得元');
          const stamp = source.slice(src.s, source.indexOf('\n', src.s));
          if (src.inner.trim() === '') throw new Error('取得元のブロックが空です');

          // ブランチ名に入れる版。刻印の source= を使い、**内容とブランチを 1 対 1 にする**。
          // 日付だけだと、同じ日に内容が 2 回変わったときに古い中身の pull request が残る。
          const rev = (stamp.match(/source=(\S+)/) ?? [, 'unknown'])[1].replace(/[^A-Za-z0-9._-]/g, '');
          appendFileSync(process.env.GITHUB_OUTPUT, `rev=${rev}\n`);

          const target = readFileSync('CLAUDE.md', 'utf8');
          const dst = cut(target, 'CLAUDE.md');
          if (dst.inner.trim() === src.inner.trim()) {
            console.log('最新です。');
            process.exit(0);
          }
          // 箇条書きの前後に空行を置く。Prettier は HTML コメントに隣接する箇条書きを
          // 整形対象とみなし、空行が無いと --check で落ちる（LearnAI の CI で実測）。
          writeFileSync(
            'CLAUDE.md',
            target.slice(0, dst.s) + stamp + '\n\n' + src.inner.trim() + '\n\n' + target.slice(dst.e),
          );
          console.log('CHANGED');
          JS

      - name: 差分があれば pull request を出す
        run: |
          set -euo pipefail
          if git diff --quiet -- CLAUDE.md; then
            echo '差分なし。'
            exit 0
          fi
          BRANCH="agentfailures-rules/$(date -u +%Y%m%d)-${{ steps.sync.outputs.rev }}"
          # **force push はしない。** 同じ内容なら同じブランチ名になるため、既にあれば
          # それを使う。runner の checkout には remote-tracking ref が無く、
          # force-with-lease が効くかを確かめられなかったので、force 自体を使わない。
          if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
            echo "ブランチ $BRANCH は既にあります。push は行いません。"
          else
            git config user.name 'github-actions[bot]'
            git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
            git switch -c "$BRANCH"
            git add CLAUDE.md
            git commit -m 'chore: AgentFailures の規則を CLAUDE.md へ取り込む'
            git push -u origin "$BRANCH"
          fi
          # **push だけ成功して pull request が出ない状態を残さない。**
          # 「Allow GitHub Actions to create and approve pull requests」が無効だと
          # gh pr create だけが失敗し、ブランチが残って誰も気づかない（kukuWebApp で実際に起きた）。
          # ここを毎回通すことで、設定を有効にした次の実行で自動的に回復する。
          if [ -n "$(gh pr list --head "$BRANCH" --state open --json number --jq '.[].number')" ]; then
            echo '既存の pull request があります。'
            exit 0
          fi
          gh pr create \
            --head "$BRANCH" \
            --base "$GITHUB_REF_NAME" \
            --title 'chore: AgentFailures の規則を取り込む' \
            --body '[AgentFailures](https://github.com/Rudolphish/AgentFailures/blob/main/docs/rules.md) の規則を CLAUDE.md の管理ブロックへ取り込みます。ブロックの外は変更していません。内容に異論があれば、このリポジトリではなく AgentFailures の docs/rules.md へ提案してください。'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`cron` の分を 41 にしているのは、0 分に集中するスケジュールを避けるため。

### 3. 整形検査（Prettier 等）がある場合

**`CLAUDE.md` が整形検査の対象かどうかを確かめること。** 対象であれば、設置した
`CLAUDE.md` がその検査を通ることを必ず確認する。通らない状態で設置すると、
**週次の pull request が毎回 CI で落ちる**（整形の問題ではなく、配布が止まる問題になる）。

LearnAI では `npm run check` が `prettier --check .` を含み、`.prettierignore` に
`CLAUDE.md` が入っていなかった。実測したところ、Prettier は規則の本文には手を付けないが、
**HTML コメントに隣接する箇条書きは、間に空行が無いと落ちる。** 上の雛形が箇条書きの
前後に空行を置いているのはこのためである。

確認は 2 点を守ること。

- **「変更前のファイルが検査を通ること」を基準線に取ってから行う。** これが無いと、
  元から落ちているのか、こちらが落としたのかを区別できない
- **消費側が固定しているバージョンで測る。** `npx prettier@3.3.3` で確認して通したものが、
  リポジトリが使う 3.9.9 で落ちた。3.3.3 は刻印の次の空行だけを要求し、3.9.9 は終了
  マーカーの前も要求する。**整形規則はバージョンで変わるため、`package-lock.json` の
  解決済みバージョンを見てから流す**（`npm ci` を済ませて `npx prettier` を使えば確実）

ワークフローの YAML も `prettier --check .` の対象になる。こちらはリポジトリごとに
`prettier --write` で整形してよい。**週次で配り直すのは `CLAUDE.md` のブロックだけ**で、
ワークフローは設置時に 1 回置くだけだからである。

### 4. リポジトリ側の設定を確認する

**Settings → Actions → General → Workflow permissions の「Allow GitHub Actions to create
and approve pull requests」を有効にしておくこと。**

無効のままだと、**`git push` は成功して `gh pr create` だけが失敗する。**
ブランチが残り pull request が出ないため、**誰も気づかないまま規則が届かなくなる。**
kukuWebApp で実際に起きた（`GraphQL: GitHub Actions is not permitted to create or
approve pull requests`）。

上の雛形は、この状態から自動で回復するようにしてある。

- **ブランチ名を `日付-source`（UTC の日付と刻印の `source=`）にし、内容とブランチを
  1 対 1 にする。** 理由は雛形の該当箇所のコメントに書いてある
- 同名のブランチが既にあれば push しない（**force push は使わない**）
- **pull request が無ければ毎回作りに行く。** 設定を有効にした次の実行で回復する

`git switch -C` と `--force-with-lease` は使わない。runner の checkout には対象
ブランチの remote-tracking ref が無く、その状態で lease が効くかを**確認できなかった**
ため、force 自体を避けている。

ブランチが溜まったときの扱いは次のとおり。

- **前回の PR がマージされていなくても、内容が変われば別のブランチで新しい PR が出る**
  （ブランチ名に `source=` が入るため）。規則が毎週変わるものではないため実際には
  まれだが、溜まったら古い方を閉じること
- **同じ内容で 2 回走った場合は、同名のブランチが既にあるため push せず、
  pull request が無いときだけ作る。** 手動実行で起きる
- **人が PR を閉じて却下した場合、同じ内容で再実行すると PR が作り直される**
  （開いている PR が無いため）。ブランチごと削除するか、却下は配布元の
  `rules.md` 側で行うこと

## 実際に通った経路（2026-10-30）

**gamers-highlight で全経路が一度通っている。** 設置しただけで動作を確認していない
状態を残さないため、ここに記録する。

| 経路 | 確認 |
| --- | --- |
| 取得と差し込み（差分なし） | run #1。`最新です。` → `差分なし。` |
| 取得と差し込み（差分あり） | run #2。規則が 11 本から 12 本へ変わった回 |
| **`gh pr create`** | run #2 が [#160](https://github.com/Rudolphish/gamers-highlight/pull/160) を自動で作成。作成者は `github-actions[bot]`、ブランチは `agentfailures-rules/20261030` |
| 差分の範囲 | 管理ブロックの中 2 行（刻印と新規則）のみ。ブロックの外は変わっていない |

**`gh pr create` は最後まで未検証だった箇所である。** 規則の内容が変わる回が来るまで
通らないため、設置から 1 日後にようやく確認できた。「Allow GitHub Actions to create
and approve pull requests」は有効だった。

**ただし、通ったのは旧方式のブランチ名（`agentfailures-rules/20261030`）の回である。**
回復処理を入れた後の分岐（同名ブランチがあるので push せず、pull request だけ作る）は
**まだ実際には通っていない。** 次に規則が変わる回、または kukuWebApp で設定を
有効にした回に通る。

## 既知の穴

**同期そのものが止まったことは検知できない。**

管理ブロックの `updated=` は「規則の内容が最後に変わった日」であり、「最後に同期を
確認した日」ではない。毎回打ち直すと、内容が変わっていなくても週ごとに PR が出て、
確認せずマージする習慣を作ってしまうため、こうしている。

このリポジトリでは、動いていない仕組みに気づかず放置した例が 2 件ある
（keep-alive の退避が 14 日間不活性だった `5a236586`、フック定義が 5 週間設置
されていなかった件）。**同じ形の穴が、ここにも残っていることを明記しておく。**

塞ぐなら、ワークフローの実行自体を別経路から見張る必要がある
（[`ideas.md`](ideas.md) の案 4「サービスの生存確認」と同じ問題）。
