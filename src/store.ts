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
 * 件数だけでなく**どう解釈して引いたか**を返す。`query` の分割・結合方法・
 * 一致総数は呼び出し側から見えないため、これを返さないと応答に書けない。
 */
export interface SearchResult {
  records: FailureRecord[];
  /** `query` を分割して実際に使った語。`query` 未指定なら空配列。 */
  terms: string[];
  /** 上限 `QUERY_TERMS_MAX` を超えて使わなかった語の数。 */
  droppedTerms: number;
  /**
   * 条件に一致した総数。**`limit` で切る前の数である。**
   *
   * `records.length` を一致数として読ませないために別に持つ。
   * 10 件一致して 3 件返したとき、`records.length` だけでは「3 件しかない」と
   * 読まれ、`limit` を上げる理由が与えられない。
   */
  matchedCount: number;
  /**
   * 語の結合方法。
   *
   * `and` が既定。**`and` が 0 件で語が 2 つ以上あるときだけ `or` へ落とす。**
   * `none` は `query` を与えられなかった場合（語がないため結合も無い）。
   */
  combine: 'and' | 'or' | 'none';
}

/** 組み立てた WHERE / ORDER BY と、その順に対応するバインド値。 */
interface BuiltQuery {
  where: string;
  whereBindings: string[];
  order: string;
  orderBindings: string[];
}

/**
 * 条件と並び順を組み立てる。
 *
 * **バインド値は SQL 本文に `?` が現れる順でなければならない。** そのため
 * WHERE と ORDER BY の値を別に持ち、呼び出し側で WHERE → ORDER BY → LIMIT の
 * 順に連結する。1 本の配列へ混ぜて積むと、並び順の式を足したとたんに
 * 条件側とずれる。
 *
 * 並び順は 3 段で、**上から順に効く**。
 *
 * 1. **一致語数の降順**（`or` のときのみ）。`and` では返る行がすべて全語一致
 *    であるため、この段は定数になり並びを変えない。だから付けない
 * 2. **出現回数の合計の降順。** `キャッシュ` の 1 語で 11 件一致する実データで、
 *    出現回数は 1〜7 回に分かれる。`created_at` だけで並べると出現 7 回の
 *    2 件（いずれも 2026-09 の記録）は既定 limit 3 に入らず、永久に出ない。
 *    **1 語のクエリで効くのはこの段だけである**（一致語数は全行 1 になる）
 * 3. **`created_at` の降順。** 「新しい順に返る」という既存の約束を、
 *    関連度が同じ場合の並びとして残す
 *
 * 出現回数は `lower()` を通して数える。**SQLite の `LIKE` は ASCII について
 * 大文字小文字を無視するが、`replace()` は区別する。** 通さないと `Cron` で
 * 引いたときに条件は一致するのに出現回数が 0 になり、並びが壊れる。
 * `lower()` が畳むのは ASCII のみだが、取り違えが起きるのも ASCII だけである。
 */
function buildQuery(
  input: SearchFailuresInput,
  terms: string[],
  combine: 'and' | 'or' | 'none',
): BuiltQuery {
  const whereBindings: string[] = [];
  const orderBindings: string[] = [];

  // domain / environment は語の結合方法によらず常に AND で絞る。
  // 「nextjs の中から探す」という指定を or で緩めてはいけない。
  const filters: string[] = [];
  if (input.domain !== undefined) {
    filters.push('domain = ?');
    whereBindings.push(input.domain);
  }
  if (input.environment !== undefined) {
    filters.push("environment LIKE ? ESCAPE '\\'");
    whereBindings.push(likePattern(input.environment));
  }

  const termConditions = terms.map((term) => {
    whereBindings.push(likePattern(term));
    return "search_text LIKE ? ESCAPE '\\'";
  });

  if (termConditions.length > 0) {
    // or のときは語の条件を括って 1 つの要素として扱う。括らないと
    // `domain = ? AND t1 OR t2` と解釈され、domain の絞り込みが外れる。
    filters.push(
      combine === 'or' ? `(${termConditions.join(' OR ')})` : termConditions.join(' AND '),
    );
  }

  const where = filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`;

  const orderKeys: string[] = [];

  if (combine === 'or' && terms.length > 1) {
    const matched = terms.map((term) => {
      orderBindings.push(likePattern(term));
      return "(search_text LIKE ? ESCAPE '\\')";
    });
    orderKeys.push(`(${matched.join(' + ')}) DESC`);
  }

  if (terms.length > 0) {
    const occurrences = terms.map((term) => {
      // raw な語を 2 回。**likePattern を通してはいけない。**
      // `\` を足した文字列は replace() では一致しない。
      orderBindings.push(term, term);
      return "((length(lower(search_text)) - length(replace(lower(search_text), lower(?), ''))) / length(?))";
    });
    orderKeys.push(`(${occurrences.join(' + ')}) DESC`);
  }

  orderKeys.push('created_at DESC');

  return { where, whereBindings, order: `ORDER BY ${orderKeys.join(', ')}`, orderBindings };
}

/**
 * 1 つの結合方法で、一致総数と行を 1 往復で取る。
 *
 * `batch()` は 1 回のリクエストで複数の文を流せる。件数のために往復を
 * 増やさないためにこれを使う。
 */
async function runSearch(
  store: Store,
  input: SearchFailuresInput,
  terms: string[],
  combine: 'and' | 'or' | 'none',
  limit: number,
): Promise<{ rows: FailureRow[]; matchedCount: number }> {
  const built = buildQuery(input, terms, combine);

  const countStatement = store
    .prepare(`SELECT count(*) AS n FROM failures ${built.where}`)
    .bind(...built.whereBindings);

  const rowsStatement = store
    .prepare(
      `SELECT ${COLUMNS}
         FROM failures
        ${built.where}
        ${built.order}
        LIMIT ?`,
    )
    .bind(...built.whereBindings, ...built.orderBindings, limit);

  try {
    const [countResult, rowsResult] = await store.batch<Record<string, unknown>>([
      countStatement,
      rowsStatement,
    ]);
    const n = countResult?.results?.[0]?.['n'];
    if (typeof n !== 'number') {
      throw new Error('一致総数を数値として読み出せませんでした。');
    }
    return { rows: (rowsResult?.results ?? []) as unknown as FailureRow[], matchedCount: n };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`失敗談の検索に失敗しました: ${message}`);
  }
}

/**
 * 失敗談を検索する。返却件数は必ず上限以下になる。
 *
 * `query` は**空白で語へ分割し、語ごとの `AND`** で判定する。連結文字列への
 * 1 回の部分一致ではない。したがって語の並び順と隣接は問わない。
 * 変更前は `cron 曜日` のような複数語が原理的に 0 件になっていた。
 *
 * **`AND` が 0 件で語が 2 つ以上あるときだけ `OR` へ落とす。** 絞りすぎと
 * 広すぎの双方を避けるためである。`OR` を既定にすると、実データで
 * `キャッシュ 古い` が 22 件（全体の 16%）一致し、既定 limit 3 では
 * ほとんど絞り込めていない結果が返る。
 *
 * 並び順は `buildQuery` を参照。**「新しい順」だけではなくなった。**
 *
 * 索引は `created_at` と `domain` にのみ張ってある。`environment` と
 * `search_text` は部分一致のため索引が効かず、全表走査になる。
 * 134 行での実測は 1 検索あたり最大 263 行読みであり、無料枠に対して桁が余る。
 * 一致総数のための `count(*)` は `batch()` で同じ往復に載せている。
 */
export async function searchFailures(
  store: Store,
  input: SearchFailuresInput,
): Promise<SearchResult> {
  const limit = Math.min(input.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  const { terms, dropped } =
    input.query === undefined
      ? { terms: [] as string[], dropped: 0 }
      : splitQueryTerms(input.query);

  const first = terms.length === 0 ? 'none' : 'and';
  let combine: 'and' | 'or' | 'none' = first;
  let { rows, matchedCount } = await runSearch(store, input, terms, first, limit);

  // AND で 0 件、かつ語が 2 つ以上あるときだけ OR へ落とす。
  // 語が 1 つなら OR は AND と同じ結果になるため、往復を増やす意味が無い。
  if (matchedCount === 0 && terms.length > 1) {
    combine = 'or';
    ({ rows, matchedCount } = await runSearch(store, input, terms, 'or', limit));
  }

  // 上限超過を返さないことは要件であるため、SQL の LIMIT に加えてここでも切り詰める。
  return {
    records: rows.slice(0, limit).map(toRecord),
    terms,
    droppedTerms: dropped,
    matchedCount,
    combine,
  };
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
