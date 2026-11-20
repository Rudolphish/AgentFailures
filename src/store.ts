import type { Env } from './env.js';
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type FailureRecord,
  type RecordFailureInput,
  type SearchFailuresInput,
} from './schema.js';

const COLUMNS =
  'id, created_at, domain, environment, attempted, observed, cause, cause_is_assumption, workaround, tags';

export type Store = D1Database;

export function createStore(env: Env): Store {
  return env.DB;
}

/**
 * D1 から返る 1 行。
 *
 * **SQLite には真偽値も配列も無い。** `cause_is_assumption` は 0/1 の整数、
 * `tags` は JSON 配列の文字列で返る。この 2 つが移行で最も取り違えやすいため、
 * 変換は `toRecord` の 1 箇所に閉じる。
 */
interface FailureRow {
  id: string;
  created_at: string;
  domain: string;
  environment: string;
  attempted: string;
  observed: string;
  cause: string;
  cause_is_assumption: number;
  workaround: string | null;
  tags: string;
}

/** `tags` の JSON を配列へ戻す。壊れた値で検索全体を落とさない。 */
function parseTags(value: string, id: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string')) {
      return parsed;
    }
  } catch {
    // 下の console.error へ落ちる。
  }
  console.error(`tags を配列として解釈できませんでした（id: ${id}）。空配列として扱います。`);
  return [];
}

function toRecord(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    created_at: row.created_at,
    domain: row.domain,
    environment: row.environment,
    attempted: row.attempted,
    observed: row.observed,
    cause: row.cause,
    cause_is_assumption: row.cause_is_assumption !== 0,
    workaround: row.workaround,
    tags: parseTags(row.tags, row.id),
  };
}

/**
 * LIKE パターンとして解釈される文字を無効化する。
 *
 * SQLite の `LIKE` は既定でエスケープ文字を持たないため、問い合わせ側で
 * `ESCAPE '\'` を明示したうえで `\` `%` `_` を退避する。
 *
 * PostgREST 時代にあった `*` の空白置換は不要になった。あれは PostgREST が
 * `ilike` の値に含まれる `*` を `%` として扱うことへの対処であり、D1 には無い。
 * `*` はただの文字として一致する。
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 部分一致のパターンを作る。 */
function likePattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

/**
 * `query` を語へ分割したときに使う語数の上限。
 *
 * **これは D1 の制約ではない。** 実測では `search_text LIKE ?` を 24 個
 * `AND` で重ねても通る（2026-11-20、本番 138 行）。バインド引数も
 * 8 + 3 = 11 個で、D1 の上限 100 に対して余裕がある。
 *
 * 上限を置く理由は関連度である。`AND` は語を増やすほど 0 件へ寄るため、
 * 語数の多いクエリは「絞り込んだ」のではなく「何も返らない」になる。
 */
export const QUERY_TERMS_MAX = 8;

/**
 * `query` を語へ分割する。
 *
 * 区切りは JavaScript の `\s` であり、**全角空白 (U+3000) を含む。**
 * `/\s/.test()` に全角空白を渡して true になることを実際に確認した。
 * 日本語入力では全角空白が来るため、半角のみでは分割できない。
 *
 * 上限を超えた語は使わないが、**捨てたことは呼び出し側へ返す。**
 * 黙って捨てると、エージェントは絞り込んだつもりのまま別の条件で
 * 検索した結果を受け取ることになる。
 */
export function splitQueryTerms(query: string): { terms: string[]; dropped: number } {
  const all = query.split(/\s+/).filter((term) => term.length > 0);
  return {
    terms: all.slice(0, QUERY_TERMS_MAX),
    dropped: Math.max(0, all.length - QUERY_TERMS_MAX),
  };
}

/**
 * 検索の結果。
 *
 * 件数だけでなく**どう解釈して引いたか**を返す。`query` の分割は呼び出し側から
 * 見えないため、これを返さないと応答に判定方法を書けない。
 */
export interface SearchResult {
  records: FailureRecord[];
  /** `query` を分割して実際に `AND` で使った語。`query` 未指定なら空配列。 */
  terms: string[];
  /** 上限 `QUERY_TERMS_MAX` を超えて使わなかった語の数。 */
  droppedTerms: number;
}

/**
 * 失敗談を新しい順に検索する。返却件数は必ず上限以下になる。
 *
 * `query` は**空白で語へ分割し、語ごとの `AND`** で判定する。連結文字列への
 * 1 回の部分一致ではない。したがって語の並び順と隣接は問わない。
 * 変更前は `cron 曜日` のような複数語が原理的に 0 件になっていた。
 *
 * 索引は `created_at` と `domain` にのみ張ってある。`environment` と
 * `search_text` は部分一致のため索引が効かず、全表走査になる。
 * 134 行での実測は 1 検索あたり最大 263 行読みであり、無料枠に対して桁が余る。
 */
export async function searchFailures(
  store: Store,
  input: SearchFailuresInput,
): Promise<SearchResult> {
  const limit = Math.min(input.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  const { terms, dropped } = input.query === undefined
    ? { terms: [] as string[], dropped: 0 }
    : splitQueryTerms(input.query);

  // 条件は指定されたものだけを並べる。未指定の列を `?N IS NULL OR ...` で
  // 無効化する書き方はやめた。語数が可変になり番号付けが合わないうえ、
  // 条件を書かなければ `domain` の索引がそのまま使える。
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (input.domain !== undefined) {
    conditions.push('domain = ?');
    bindings.push(input.domain);
  }
  if (input.environment !== undefined) {
    conditions.push("environment LIKE ? ESCAPE '\\'");
    bindings.push(likePattern(input.environment));
  }
  // 語ごとに 1 条件。語の並び順も隣接も問わないため、`cron 曜日` と
  // `曜日 cron` は同じ結果になる。
  for (const term of terms) {
    conditions.push("search_text LIKE ? ESCAPE '\\'");
    bindings.push(likePattern(term));
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  bindings.push(limit);

  const statement = store
    .prepare(
      `SELECT ${COLUMNS}
         FROM failures
        ${where}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(...bindings);

  let rows: FailureRow[];
  try {
    const result = await statement.all<FailureRow>();
    rows = result.results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`失敗談の検索に失敗しました: ${message}`);
  }

  // 上限超過を返さないことは要件であるため、SQL の LIMIT に加えてここでも切り詰める。
  return { records: rows.slice(0, limit).map(toRecord), terms, droppedTerms: dropped };
}

/**
 * 失敗談を 1 件登録し、登録された行を返す。
 *
 * **`id` と `created_at` は Worker 側で作って渡す。** SQLite に uuid の生成関数は
 * 無く、`CURRENT_TIMESTAMP` の書式は `YYYY-MM-DD HH:MM:SS` で ISO 8601 と異なる。
 * 既定値に頼ると経路によって書式が割れるため、生成をここへ一本化する。
 */
export async function recordFailure(
  store: Store,
  input: RecordFailureInput,
): Promise<FailureRecord> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const statement = store
    .prepare(
      `INSERT INTO failures
         (id, created_at, domain, environment, attempted, observed, cause,
          cause_is_assumption, workaround, tags)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       RETURNING ${COLUMNS}`,
    )
    .bind(
      id,
      createdAt,
      input.domain,
      input.environment,
      input.attempted,
      input.observed,
      input.cause,
      input.cause_is_assumption ? 1 : 0,
      input.workaround ?? null,
      JSON.stringify([...new Set(input.tags)]),
    );

  let row: FailureRow | null;
  try {
    row = await statement.first<FailureRow>();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`失敗談の登録に失敗しました: ${message}`);
  }

  if (row === null) {
    throw new Error('失敗談の登録に失敗しました: 登録した行を読み出せませんでした。');
  }

  return toRecord(row);
}

/**
 * keep-alive の結果。
 *
 * 記録まで到達したかどうかを呼び出し側へ返す。疎通はできたが記録できなかった
 * 場合を「成功」として片付けると、可観測性を足した意味が無くなるためである。
 */
export type PingResult = { recorded: true } | { recorded: false; reason: string };

/**
 * `keepalive_log` へ 1 行追記する。
 *
 * **D1 に自動停止は無い**（公式ドキュメントに記述が無く、課金は使った分のみ）。
 * それでも移行直後は残してある。「停止しない」ことを文書で確認できていないため
 * 30 日は観測で裏を取る、というのが残している理由である（移行計画 §6）。
 * あわせて `select max(ran_at)` で最後に書き込めた時刻が分かるため、
 * 障害時の切り分けにそのまま使える。
 *
 * 追記に失敗した場合は `failures` の読み取りへ退避する。マイグレーションの適用と
 * デプロイの順序はどちらが先にもなりうるため、`keepalive_log` がまだ無いあいだ
 * 疎通確認そのものを失わせないための措置である。退避したことは理由とともに
 * 呼び出し側へ返し、ログへ残す。
 */
export async function ping(store: Store): Promise<PingResult> {
  try {
    await store
      .prepare('INSERT INTO keepalive_log (ran_at) VALUES (?1)')
      .bind(new Date().toISOString())
      .run();
    return { recorded: true };
  } catch (insertError) {
    const insertMessage = insertError instanceof Error ? insertError.message : String(insertError);

    try {
      await store.prepare('SELECT id FROM failures LIMIT 1').first();
    } catch (selectError) {
      const selectMessage = selectError instanceof Error ? selectError.message : String(selectError);
      throw new Error(
        `keep-alive に失敗しました: 追記 = ${insertMessage} / 読み取り = ${selectMessage}`,
      );
    }

    return { recorded: false, reason: insertMessage };
  }
}
