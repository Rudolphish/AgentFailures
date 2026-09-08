#!/usr/bin/env node
/**
 * SessionStart hook: セッションの最初に「前のセッションまでの学び」と
 * 「いま未レビューで残っているもの」を出す。
 *
 * **なぜファイルを置くだけでは足りないか。**
 * `.claude/hooks/review-decisions.csv` は「決着済みの論点を書き足す」ための
 * ファイルだったが、作った日以降1行も増えていない。手で書きに行く前提のものは
 * 例外なく風化する。だから読ませる側を仕組みにする。
 *
 * 出力はセッションの冒頭コンテキストに載る。長いほど読まれなくなるので、
 * docs/lessons.md が肥大したら畳むよう警告する（中身の要約はしない。
 * 要約すると「何が起きたか」が落ちて、判断に使えない項目だけが残る）。
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const LESSONS = join(REPO_ROOT, "docs", "lessons.md");
const LEDGER = join(HERE, "review-ledger.csv");

// これを超えたら畳む合図。CLAUDE.mdと合わせて毎回読む量なので、無制限には増やせない。
// **単位は文字数**（バイト数ではない）。日本語はUTF-8で1文字3バイトなので、
// バイトで見ると3倍ゆるい別の基準になる。読む量が問題なのだから文字で数える
// （ファイルサイズと突き合わせて「警告が出ないのはおかしい」と誤読しかけた）。
const LESSONS_SOFT_LIMIT_CHARS = 8192;

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const out = [];

// ── 自動レビューが止まっていないか ──
// `.review-off` は「止まらなくなった時の逃げ道」だが、置いたことを誰も通知しない。
// 消し忘れると**以後ずっとレビューされないまま、見た目は今までと何も変わらない**。
// 走らなかったことが見えない状態を作らない、というのがこの一連の修正の主旨なので、
// キルスイッチ自体も見えるようにしておく。
const SKIP_FILE = join(HERE, ".review-off");
if (existsSync(SKIP_FILE)) {
  out.push(
    `> ⚠ **自動レビューは停止中です**（\`.claude/hooks/.review-off\` があります）。\n` +
      `> 意図的でなければ削除してください。置いたままだとコミットは一切レビューされません。\n`
  );
}

// ── 進め方の記録 ──
if (existsSync(LESSONS)) {
  const text = readFileSync(LESSONS, "utf8");
  out.push("## docs/lessons.md（進め方でやらかしたことの記録・全文）\n");
  out.push(text.trim());
  if (text.length > LESSONS_SOFT_LIMIT_CHARS) {
    out.push(
      `\n> ⚠ docs/lessons.md が ${text.length} 文字あります` +
        `（目安 ${LESSONS_SOFT_LIMIT_CHARS} 文字）。似た項目を統合して畳んでください。`
    );
  }
} else {
  out.push("docs/lessons.md がありません。進め方でやらかしたことは、ここに残してください。");
}

// ── いま未レビューで残っているもの ──
// レビューが飛んでいたことに気づけなかった原因は「走らなかったのが見えない」ことだった。
// セッションの頭で残件を出しておけば、前のセッションの積み残しをそのまま引き継げる。
const head = git("rev-parse", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (head && existsSync(LEDGER)) {
  let base = null;
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const tip = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    if (!tip) continue;
    const fork = git("merge-base", head, tip);
    if (fork && fork !== head) {
      base = fork;
      break;
    }
  }

  if (base) {
    // コミットごとに**最後の判定**を持つ。PASSとFAILを別の集合で持つと、
    // 一度PASSしたあとに再レビューでFAILしたコミットが「レビュー済み」に吸収されて消える。
    // SKIP行は判定として扱わない（見送りは「レビューしていない」の記録なので、
    // これを済み扱いにすると見落としがそのまま固定化する）。
    const verdictOf = new Map();
    for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
      const cols = parseCsvLine(line);
      if (cols.length < 6) continue;
      const [, , , commits, verdict] = cols;
      if (verdict !== "PASS" && verdict !== "FAIL") continue;
      for (const sha of commits.split(";").filter(Boolean)) verdictOf.set(sha, verdict);
    }

    const commits = (git("rev-list", `${base}..${head}`) ?? "").split("\n").filter(Boolean);
    const pending = commits.filter((c) => verdictOf.get(c) !== "PASS");
    if (pending.length > 0) {
      out.push(`\n## いまのブランチ（${branch}）に未レビューのコミットが ${pending.length} 件あります\n`);
      for (const c of pending.slice(0, 10)) {
        const subject = git("log", "-1", "--format=%s", c) ?? "";
        out.push(
          `- ${verdictOf.get(c) === "FAIL" ? "FAIL" : "未レビュー"} ${c.slice(0, 7)} ${subject.slice(0, 60)}`
        );
      }
      out.push(`\nマージ前に \`node .claude/hooks/review-status.mjs --range\` で確認してください。`);
    }
  }
}

console.log(out.join("\n"));

// auto-review.mjs と同じ解釈（findings列はSKIP行だけ自由記述でカンマを含みうる）
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
