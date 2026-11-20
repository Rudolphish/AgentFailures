import { z } from 'zod';

/** search_failures の既定件数。 */
export const SEARCH_LIMIT_DEFAULT = 3;

/** search_failures の最大件数。この値を超えて返却しない。 */
export const SEARCH_LIMIT_MAX = 5;

/** 空文字・空白のみを拒否する必須テキスト。 */
const requiredText = (max = 4000) => z.string().trim().min(1).max(max);

/**
 * domain の例として説明文に載せる値。
 *
 * **ここは語彙の正本ではない。** かつては正本のつもりで 7 個を列挙していたが、
 * 実データには 32 種類あり（2026-11-19 時点、136 件）、列挙は現実と乖離していた。
 * `playwright` の 7 件のように、列挙だけを見ていると到達できない値が生まれる。
 * 手で書く一覧は風化するため、**全件の列挙はやめて件数上位のみを例として示す。**
 *
 * 値はデプロイ時点の実データの上位 3 件で、合計 78 件（全体の 57%）を占める。
 * 絞り込みの正しいやり方は、列挙を覚えることではなく
 * 「値が不確かなら domain を省いて query で引く」である（説明文に明記する）。
 */
export const COMMON_DOMAINS = ['claude-code', 'nextjs', 'github-actions'] as const;

/** tags に含めることを推奨する、失敗の性質を表す語。 */
const TAG_NATURE_EXAMPLES = [
  'silent-failure',
  'security',
  'data-loss',
  'encoding',
  'quota',
  'race-condition',
  'permissions',
] as const;

export const searchFailuresInputShape = {
  domain: requiredText(200)
    .optional()
    .describe(
      '技術による絞り込み。**完全一致で判定する。**' +
        `値は 30 種類以上あり、ここに挙げるのは件数上位の例にすぎない: ${COMMON_DOMAINS.join(' / ')}。` +
        '**値が不確かな場合は domain を省略し、query だけで検索すること。** ' +
        '存在しない値を渡すと、該当する記録があっても 0 件になる。' +
        '話題や設計パターンで絞り込みたい場合も、domain ではなく query を用いる。',
    ),
  environment: requiredText(500)
    .optional()
    .describe('実行環境による絞り込み。大文字小文字を無視した部分一致で判定する（例: wrangler 4）。'),
  query: requiredText(500)
    .optional()
    .describe(
      'キーワードによる全文検索。domain / environment / attempted / observed / cause / workaround / tags を連結した文字列を対象とする。' +
        '**空白（半角・全角とも）で語に分割し、すべての語を含む記録を返す（AND）。** ' +
        '語の並び順と隣接は問わないため、「cron 曜日」と「曜日 cron」は同じ結果になる。' +
        '語を増やすほど絞り込まれ 0 件へ寄るため、0 件のときは語を減らすこと。語数の上限は 8。' +
        '各語は大文字小文字を無視した部分一致で判定する。',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .optional()
    .describe(`返却する最大件数。既定 ${SEARCH_LIMIT_DEFAULT}、上限 ${SEARCH_LIMIT_MAX}。`),
  detail: z
    .enum(['summary', 'full'])
    .optional()
    .describe(
      '返却する情報量。既定は summary で、本文が長い場合は各項目を切り詰める。' +
        '見出しと id / created_at / environment / tags は切り詰めない。' +
        '省略された本文が必要な場合のみ full を指定する。' +
        'full は情報量が多いため、まず summary で該当を絞り込むこと。',
    ),
};

export const recordFailureInputShape = {
  domain: requiredText(200).describe(
    '失敗が起きた場所の主たる技術。完全一致で検索するため、**表記の揺れは絞り込みを壊す。** ' +
      '既存の値を再利用すること。確実なやり方は、記録の前に search_failures で同種の記録を引き、' +
      `その domain に合わせることである（件数上位の例: ${COMMON_DOMAINS.join(' / ')}）。` +
      '該当が無い場合に限り、技術・製品の名称を小文字とハイフンで新たに作る。' +
      '「notification-design」「api-cache-design」のような話題や設計パターンの名称は domain に用いない。' +
      'それらは tags へ入れること。',
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
    .describe(
      '検索用のタグ。小文字とハイフンで表記する。次の3種類を意識して付けること。' +
        `(1) 失敗の性質を表す語を最低1つ（例: ${TAG_NATURE_EXAMPLES.join(' / ')}）。` +
        '(2) 話題や設計パターン（例: caching / idempotency / authorization / notification）。' +
        'domain に入らなかった観点はここへ入れる。' +
        '(3) domain 以外の関連技術（例: prisma / pnpm / discord）。' +
        '該当するものが無い場合は空配列を渡す。',
    ),
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
