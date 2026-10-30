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
        run: |
          set -euo pipefail
          SRC='https://raw.githubusercontent.com/Rudolphish/AgentFailures/main/CLAUDE.md'
          curl -fsSL "$SRC" -o /tmp/source.md
          # --input-type=module は必須。runner の既定 Node 版によっては
          # 標準入力が CommonJS として扱われ、import が構文エラーになる。
          node --input-type=module - <<'JS'
          import { readFileSync, writeFileSync } from 'node:fs';
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
          BRANCH="agentfailures-rules/$(date -u +%Y%m%d)"
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          # 同じ日に 2 回走ると -c は既存ブランチで失敗する（手動実行で起きる）。
          # -C と force-with-lease で、同じブランチへ上書きして PR を更新する。
          git switch -C "$BRANCH"
          git add CLAUDE.md
          git commit -m 'chore: AgentFailures の規則を CLAUDE.md へ取り込む'
          git push -u --force-with-lease origin "$BRANCH"
          # 既に PR があるときに gh pr create は失敗する。push で更新済みなので作らない。
          if [ -n "$(gh pr list --head "$BRANCH" --state open --json number --jq '.[].number')" ]; then
            echo '既存の pull request を更新しました。'
            exit 0
          fi
          gh pr create \
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

**Settings → Actions → General の「Allow GitHub Actions to create and approve pull
requests」を有効にしておくこと。** 無効のままだと `gh pr create` が失敗する。

なお、**前回の PR がマージされていなくても、翌週は別のブランチで新しい PR が出る。**
ブランチ名が日付（UTC）であるため、週をまたぐと別物になる。規則が毎週変わるものでは
ないため実際にはまれだが、溜まったら古い方を閉じること。
同じ日に 2 回走った場合は、同じブランチへ上書きして既存の PR を更新する
（手動実行で起きる。`git switch -c` のままでは既存ブランチで落ちた）。

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
