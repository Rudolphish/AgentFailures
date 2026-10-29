#!/usr/bin/env node
/**
 * docs/rules.md の規則を、対象の CLAUDE.md にある管理ブロックへ差し込む。
 *
 * 使い方:
 *   node scripts/sync-rules.mjs --target CLAUDE.md
 *   node scripts/sync-rules.mjs --target CLAUDE.md --source <path|url>
 *   node scripts/sync-rules.mjs --target CLAUDE.md --check     # 差分があれば exit 1
 *
 * **ブロックの外側は一切触らない。** 対象にブロックが無い場合は、黙って挿入せず
 * エラーで止める。CLAUDE.md はエージェントの振る舞いを縛るファイルなので、
 * 置き場所は人が明示的に決める。
 *
 * 配られるのは、各規則の見出し直後の段落だけである。以降の箇条書き（由来・備考）は
 * 本書にのみ残る。**同じ文を二箇所に持たないため**で、重複は必ず片方が古くなる。
 *
 * 刻印について。`updated=` は「規則の内容が最後に変わった日」であり、
 * 「最後に同期を確認した日」ではない。毎回打ち直すと、内容が変わっていなくても
 * 週ごとに差分が出て PR の山になり、確認せずマージする習慣を作ってしまうため。
 * **同期そのものが止まったことは、この刻印では検知できない。** 既知の穴である。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const START = '<!-- agentfailures:rules:start';
const END = '<!-- agentfailures:rules:end -->';

/** 既定の取得元。public なのでトークンは要らない。 */
const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/Rudolphish/AgentFailures/main/docs/rules.md';

function parseArgs(argv) {
  const args = { target: null, source: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target') args.target = argv[(i += 1)];
    else if (a === '--source') args.source = argv[(i += 1)];
    else if (a === '--check') args.check = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  if (args.target === null) throw new Error('--target が必要です');
  return args;
}

async function loadSource(source) {
  if (source === null) {
    // 既定はリポジトリ内の docs/rules.md。AgentFailures 自身で動かす場合はこれで済む。
    try {
      return { text: readFileSync('docs/rules.md', 'utf8'), origin: 'docs/rules.md' };
    } catch {
      return { text: await fetchText(DEFAULT_SOURCE), origin: DEFAULT_SOURCE };
    }
  }
  if (/^https?:\/\//.test(source)) {
    return { text: await fetchText(source), origin: source };
  }
  return { text: readFileSync(source, 'utf8'), origin: source };
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`取得に失敗しました: ${url} → HTTP ${res.status}`);
  }
  return await res.text();
}

/**
 * 各規則の「見出し直後の段落」を取り出す。
 *
 * `---` より後ろだけを対象にする。それより前は本書の説明であり、規則ではない。
 */
function extractRules(markdown) {
  const separator = markdown.indexOf('\n---\n');
  const body = separator === -1 ? markdown : markdown.slice(separator + 5);

  const rules = [];
  const sections = body.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section.split('\n');
    const id = lines[0].trim();
    // 見出しの次の、最初の空行でない行から、次の空行までを本文とする。
    let i = 1;
    while (i < lines.length && lines[i].trim() === '') i += 1;
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '') {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    const text = paragraph.join(' ').trim();
    if (id === '' || text === '') {
      throw new Error(`規則 "${id}" の本文が空です。見出しの直後に段落を置いてください。`);
    }
    if (text.startsWith('-')) {
      throw new Error(`規則 "${id}" の見出し直後が箇条書きです。段落を置いてください。`);
    }
    rules.push({ id, text });
  }
  if (rules.length === 0) {
    throw new Error('規則が 1 つも見つかりませんでした。');
  }
  return rules;
}

function renderRules(rules) {
  return rules.map((r) => `- ${r.text}`).join('\n');
}

function sourceRevision(origin) {
  if (/^https?:\/\//.test(origin)) return 'remote';
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function splice(targetText, rendered, revision) {
  const startIdx = targetText.indexOf(START);
  const endIdx = targetText.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `対象に管理ブロックがありません。次の 2 行を CLAUDE.md の置きたい位置へ入れてください。\n${START} -->\n${END}`,
    );
  }

  // 既存ブロックの中身（刻印の行を除く）を取り出して比較する。
  const startLineEnd = targetText.indexOf('\n', startIdx);
  const currentBody = targetText.slice(startLineEnd + 1, endIdx).trim();
  const unchanged = currentBody === rendered.trim();

  // 内容が変わっていなければ刻印も打ち直さない（毎週の空の差分を作らないため）。
  const today = new Date().toISOString().slice(0, 10);
  const existingStamp = targetText.slice(startIdx, startLineEnd);
  const stamp = unchanged
    ? existingStamp
    : `${START} updated=${today} source=${revision} -->`;

  const next =
    targetText.slice(0, startIdx) + stamp + '\n' + rendered + '\n' + targetText.slice(endIdx);

  return { next, unchanged };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { text: sourceText, origin } = await loadSource(args.source);
  const rules = extractRules(sourceText);
  const rendered = renderRules(rules);

  const targetText = readFileSync(args.target, 'utf8');
  const { next, unchanged } = splice(targetText, rendered, sourceRevision(origin));

  if (unchanged) {
    console.log(`規則 ${rules.length} 本。${args.target} は最新です。`);
    return;
  }

  if (args.check) {
    console.error(`規則 ${rules.length} 本。${args.target} が古くなっています。`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(args.target, next);
  console.log(`規則 ${rules.length} 本を ${args.target} へ反映しました（取得元: ${origin}）。`);
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
