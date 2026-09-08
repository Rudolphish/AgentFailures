#!/usr/bin/env node
/**
 * いまのHEADがレビュー済みかを表示する。
 *
 * 自動レビュー（auto-review.mjs）はStopフックで静かに走るため、
 * **「PASSした」のか「そもそも走らなかった」のかが外から区別できない。**
 * 実際に2件のコミット（#47・#48）が未レビューのままマージされ、
 * 誰も気づかなかった。これはその穴を塞ぐための確認用コマンド。
 *
 *   node .claude/hooks/review-status.mjs         … HEADの状態を出す
 *   node .claude/hooks/review-status.mjs --range … セッション開始地点からの全コミット
 *
 * 終了コード: 0=レビュー済みでPASS / 1=未レビュー / 2=FAILのまま
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, "review-ledger.csv");
const STATE = join(HERE, ".review-state.json");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/**
 * 台帳を「コミット → 直近の判定」に畳む（同じコミットが再レビューされたら後勝ち）。
 *
 * **commits列は複数のSHAをセミコロンで連ねた形になりうる。**
 * auto-review.mjs は範囲にコミットが複数あればまとめて1回でレビューし、
 * `pending.shas.join(";")` で1行に書く。ここを単一SHAとして扱うと、
 * まとめてレビューされたコミットが軒並み「未レビュー」に見える
 * （＝レビュー済みを未レビューと誤検知する。このコマンドの信頼を落とす一番まずい壊れ方）。
 */
function loadVerdicts() {
  if (!existsSync(LEDGER)) return new Map();
  const map = new Map();
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    const cols = parseCsvLine(line);
    if (cols.length < 6) continue;
    const [at, , range, commits, verdict, findings, logFile] = cols;
    for (const commit of commits.split(";").filter(Boolean)) {
      // 実際に走ったレビュー（PASS/FAIL）が既にあるなら、後から来たSKIPで上書きしない。
      // まとめてスキップされた範囲に、個別にレビュー済みのコミットが混じることがあるため。
      if (verdict === "SKIP" && map.has(commit) && map.get(commit).verdict !== "SKIP") continue;
      map.set(commit, { at, range, verdict, findings, logFile });
    }
  }
  return map;
}

// findings列にはSKIP行だけ理由（自由記述）が入り、カンマを含みうるので
// 単純なsplit(",")では列がずれる。auto-review.mjs側と同じ解釈をする。
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c !== '"') cur += c;
      else if (line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = false;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells;
}

const verdicts = loadVerdicts();
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const head = git("rev-parse", "HEAD");
const headShort = head.slice(0, 7);
const subject = git("log", "-1", "--format=%s", head);

const uncommitted = git("status", "--porcelain");
if (uncommitted) {
  console.log("⚠ 未コミットの変更があります。レビュー対象はコミット後に確定します。\n");
}

// --range の起点＝既定ブランチとの分岐点。つまり「このブランチで足したコミット全部」。
//
// セッション開始地点(baseCommit)ではなくこちらを使う。**確認したいのはマージ直前で、
// その時点ではフックが baseCommit を HEAD まで進め終えている。** baseCommitを起点にすると
// 「対象コミットがありません」としか出ず、一番確認したいタイミングで何も分からなかった。
// 分岐点ならレビュー範囲もマージされる中身も同じになる（auto-review.mjs 側の起点と一致）。
function rangeBase() {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    try {
      const fork = git("merge-base", head, git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`));
      if (fork && fork !== head) return { base: fork, from: `既定ブランチとの分岐点` };
    } catch {
      // この候補は無い
    }
  }
  // 分岐点が求められない（既定ブランチ上にいる等）。セッション開始地点に戻る。
  // ただしHEADから辿れない起点は使わない（無関係なコミット群が返るため）。
  if (state.baseCommit) {
    try {
      git("merge-base", "--is-ancestor", state.baseCommit, head);
      return { base: state.baseCommit, from: "セッション開始地点" };
    } catch {
      // 辿れない
    }
  }
  return { base: head, from: "起点なし" };
}

const rangeMode = process.argv.includes("--range");
const range = rangeMode ? rangeBase() : null;
const wanted = rangeMode ? git("rev-list", `${range.base}..HEAD`).split("\n").filter(Boolean) : [head];

// **空を「問題なし」と表示してはいけない。** ここで黙って通すと、
// 「レビュー済み」と「そもそも対象が無い」が区別できず、
// このコマンドを作った理由そのものを再現してしまう。
if (rangeMode && wanted.length === 0) {
  console.log(
    `対象コミットがありません（起点: ${range.from} ${range.base.slice(0, 7)} = HEAD ${headShort}）。\n\n` +
      `既定ブランチ上にいるか、まだ何もコミットしていない状態です。\n` +
      `マージ前の確認は、対象のブランチに切り替えてから実行してください。`
  );
  process.exit(1);
}

if (rangeMode) console.log(`起点: ${range.from} ${range.base.slice(0, 7)} → HEAD ${headShort}\n`);

let worst = 0;
for (const commit of wanted) {
  const short = commit.slice(0, 7);
  const title = git("log", "-1", "--format=%s", commit).slice(0, 48);
  const found = verdicts.get(commit);
  if (!found) {
    console.log(`✗ ${short} ${title}\n    未レビュー（台帳に記録がありません）`);
    worst = Math.max(worst, 1);
  } else if (found.verdict === "SKIP") {
    // レビューは走らなかった。PASSと混ぜないこと（混ぜたら見送りが見えなくなる）。
    console.log(`✗ ${short} ${title}\n    未レビュー（見送り: ${found.findings}）`);
    worst = Math.max(worst, 1);
  } else if (found.verdict === "PASS") {
    console.log(`✓ ${short} ${title}\n    PASS（${found.at}）`);
  } else {
    console.log(`✗ ${short} ${title}\n    ${found.verdict} 指摘${found.findings}件 → docs/review-log/${found.logFile}`);
    worst = Math.max(worst, 2);
  }
}

if (wanted.length === 1 && wanted[0] === head) {
  console.log(`\nHEAD: ${headShort} ${subject.slice(0, 60)}`);
}
console.log(
  worst === 0
    ? "\n判定: レビュー済み（PASS）"
    : worst === 1
      ? "\n判定: 未レビュー。マージ前に確認すること"
      : "\n判定: 指摘が残っています"
);
process.exit(worst);
