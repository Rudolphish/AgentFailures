import { z } from 'zod';

/** search_failures の既定件数。 */
export const SEARCH_LIMIT_DEFAULT = 3;

/** search_failures の最大件数。この値を超えて返却しない。 */
export const SEARCH_LIMIT_MAX = 5;

/** 空文字・空白のみを拒否する必須テキスト。 */
const requiredText = (max = 4000) => z.string().trim().min(1).max(max);

export const searchFailuresInputShape = {
  domain: requiredText(200)
    .optional()
    .describe('対象領域による絞り込み。完全一致で判定する（例: app-dev）。'),
  environment: requiredText(500)
    .optional()
    .describe('実行環境による絞り込み。大文字小文字を無視した部分一致で判定する（例: wrangler 4）。'),
  query: requiredText(500)
    .optional()
    .describe(
      'キーワードによる全文検索。domain / environment / attempted / observed / cause / workaround / tags を連結した文字列に対し、大文字小文字を無視した部分一致で判定する。',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .optional()
    .describe(`返却する最大件数。既定 ${SEARCH_LIMIT_DEFAULT}、上限 ${SEARCH_LIMIT_MAX}。`),
};

export const recordFailureInputShape = {
  domain: requiredText(200).describe(
    '対象領域。既存の失敗談と揃うよう短い識別子を用いる（例: app-dev, notion-integration, scheduling）。',
  ),
  environment: requiredText(500).describe(
    '実行環境およびバージョン情報（例: Node.js 22.22 / wrangler 4.129 / macOS 15.3）。',
  ),
  attempted: requiredText().describe('何をしようとしたか。'),
  observed: requiredText().describe(
    '実際に何が起きたか。エラーメッセージや終了コードなど、観測された事実のみを記載する。解釈や推測を含めない。',
  ),
  cause: requiredText().describe('原因。'),
  cause_is_assumption: z
    .boolean()
    .describe('原因が確認済みの事実ではなく推定である場合は true にする。'),
  workaround: requiredText()
    .optional()
    .describe('回避策。判明していない場合は省略する。'),
  tags: z
    .array(requiredText(100))
    .max(20)
    .describe('検索用のタグ。該当するものが無い場合は空配列を渡す。'),
};

export const searchFailuresInputSchema = z.object(searchFailuresInputShape);
export const recordFailureInputSchema = z.object(recordFailureInputShape);

export type SearchFailuresInput = z.infer<typeof searchFailuresInputSchema>;
export type RecordFailureInput = z.infer<typeof recordFailureInputSchema>;

/** データベースから読み出した失敗談 1 件。 */
export interface FailureRecord {
  id: string;
  created_at: string;
  domain: string;
  environment: string;
  attempted: string;
  observed: string;
  cause: string;
  cause_is_assumption: boolean;
  workaround: string | null;
  tags: string[];
}
