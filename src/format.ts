import type { FailureRecord } from './schema.js';

/**
 * 見出しに載せる文字数。
 *
 * 見出しは「自分の問題と同じか」を判断するためのものである。
 * 当初は attempted（何をしようとしたか）を切り詰めていたが、attempted は
 * どの記録でも似た文になるため区別に使えなかった。observed（何が起きたか）と
 * cause（原因）を並べる。
 */
const HEADING_OBSERVED_CHARS = 50;
const HEADING_CAUSE_CHARS = 32;

/**
 * 要約時の項目ごとの上限文字数。
 *
 * 件数で予算を配分する方式も検討したが、同じ記録が検索結果の件数によって
 * 違う長さで現れることになり分かりにくいため、固定値とした。
 *
 * 値は実データの分布から決めている。各項目の中央値は 85〜115 文字であり、
 * 全体の分量を押し上げているのは一部の長い記録である。中央値付近を切ると
 * 大半の記録が読めなくなるため、**外れ値だけが切られる位置**に上限を置く。
 *
 * attempted のみ低くしている。見出しが observed と cause を載せるようになった
 * ため重複が大きく、かつどの記録でも似た文になるためである。
 *
 * これによる削減幅は大きくない。分量は少数の長い項目ではなく、記録全体が
 * 一様に中程度の長さであることに由来するためである。大幅に削るには
 * workaround を落とす必要があるが、それは対処に直接使う情報であり、
 * 落とすと二度目の呼び出しが必須になる。
 */
const FIELD_LIMITS = {
  attempted: 80,
  observed: 200,
  cause: 140,
  workaround: 240,
} as const;

type FieldName = keyof typeof FIELD_LIMITS;

/** 文字数で切り詰める。バイト数で切ると日本語やサロゲートペアが分断される。 */
function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= max) {
    return { text, truncated: false };
  }
  return { text: `${chars.slice(0, max).join('')}…`, truncated: true };
}

/** 見出し用に一行へ畳む。項目は改行を含みうるため、置換しないと見出しが本文へ食い込む。 */
function toHeadingText(text: string, max: number): string {
  return truncate(text.replace(/\s+/gu, ' ').trim(), max).text;
}

/** 「[domain] 何が起きたか ← なぜか」の形にする。 */
function renderHeading(record: FailureRecord, index: number): string {
  const observed = toHeadingText(record.observed, HEADING_OBSERVED_CHARS);
  const cause = toHeadingText(record.cause, HEADING_CAUSE_CHARS);
  const assumption = record.cause_is_assumption ? '（推定）' : '';
  return `## ${index + 1}. [${record.domain}] ${observed} ← ${cause}${assumption}`;
}

function renderRecord(
  record: FailureRecord,
  index: number,
  truncateFields: boolean,
): { text: string; truncated: boolean } {
  let truncated = false;

  const field = (name: FieldName, value: string): string => {
    if (!truncateFields) {
      return value;
    }
    const result = truncate(value, FIELD_LIMITS[name]);
    truncated = truncated || result.truncated;
    return result.text;
  };

  // 要約時は日付のみとする。時刻とマイクロ秒は判断に使わないうえ、
  // 1 件あたり 20 文字強を占める。
  const createdAt = truncateFields ? record.created_at.slice(0, 10) : record.created_at;

  const lines = [
    renderHeading(record, index),
    `- id: ${record.id}`,
    `- created_at: ${createdAt}`,
    `- environment: ${record.environment}`,
    `- attempted: ${field('attempted', record.attempted)}`,
    `- observed: ${field('observed', record.observed)}`,
    `- cause: ${field('cause', record.cause)}${record.cause_is_assumption ? '（推定）' : ''}`,
  ];
  if (record.workaround !== null) {
    lines.push(`- workaround: ${field('workaround', record.workaround)}`);
  }
  lines.push(`- tags: ${record.tags.length > 0 ? record.tags.join(', ') : '(なし)'}`);

  return { text: lines.join('\n'), truncated };
}

/**
 * 検索結果を人間にもエージェントにも読める形へ整形する。
 *
 * detail が 'full' の場合は切り詰めを行わない。
 */
export function formatSearchResult(records: FailureRecord[], detail: 'summary' | 'full'): string {
  if (records.length === 0) {
    return '該当する失敗談はありません。';
  }

  const rendered = records.map((record, index) =>
    renderRecord(record, index, detail !== 'full'),
  );
  const anyTruncated = rendered.some((r) => r.truncated);

  const header = [
    `該当 ${records.length} 件（新しい順）。`,
    '見出しは「何が起きたか ← 原因」である。',
    '「（推定）」が付く場合、原因は未確認の推定である。',
  ].join('');

  const notice = anyTruncated
    ? '\n\n（本文が長いため一部を省略している。全文が必要な場合は detail に "full" を指定して再取得すること。）'
    : '';

  return [header, ...rendered.map((r) => r.text)].join('\n\n') + notice;
}

/** 登録結果を整形する。登録した本人へ返すものであるため切り詰めない。 */
export function formatRecordResult(record: FailureRecord): string {
  return ['失敗談を登録しました。', '', renderRecord(record, 0, false).text].join('\n');
}
