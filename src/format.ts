import type { FailureRecord } from './schema.js';

function renderRecord(record: FailureRecord, index: number): string {
  const lines = [
    `## ${index + 1}. [${record.domain}] ${record.attempted}`,
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
