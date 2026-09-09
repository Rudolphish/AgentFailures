import type { FailureRecord } from './schema.js';

/** 見出しに載せる attempted の長さ。全文は本文の attempted 行で読める。 */
const HEADING_MAX_CHARS = 40;

/**
 * 見出し用に一行へ畳んで切り詰める。
 * attempted は改行を含みうるため、置換しないと見出しが本文へ食い込む。
 */
function toHeadingText(text: string): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  // 文字数で数える。バイト数で切ると日本語が途中で分断される。
  const chars = [...oneLine];
  return chars.length > HEADING_MAX_CHARS
    ? `${chars.slice(0, HEADING_MAX_CHARS).join('')}…`
    : oneLine;
}

function renderRecord(record: FailureRecord, index: number): string {
  const lines = [
    `## ${index + 1}. [${record.domain}] ${toHeadingText(record.attempted)}`,
    `- id: ${record.id}`,
    `- created_at: ${record.created_at}`,
    `- environment: ${record.environment}`,
    `- attempted: ${record.attempted}`,
    `- observed: ${record.observed}`,
    `- cause: ${record.cause}${record.cause_is_assumption ? '（推定）' : ''}`,
  ];
  if (record.workaround !== null) {
    lines.push(`- workaround: ${record.workaround}`);
  }
  lines.push(`- tags: ${record.tags.length > 0 ? record.tags.join(', ') : '(なし)'}`);
  return lines.join('\n');
}

/** 検索結果を人間にもエージェントにも読める形へ整形する。 */
export function formatSearchResult(records: FailureRecord[]): string {
  if (records.length === 0) {
    return '該当する失敗談はありません。';
  }
  const header = `該当 ${records.length} 件（新しい順）。cause に「（推定）」が付く場合、原因は未確認の推定である。`;
  return [header, ...records.map(renderRecord)].join('\n\n');
}

/** 登録結果を整形する。 */
export function formatRecordResult(record: FailureRecord): string {
  return ['失敗談を登録しました。', '', renderRecord(record, 0)].join('\n');
}
