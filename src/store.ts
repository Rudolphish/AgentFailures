import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type FailureRecord,
  type RecordFailureInput,
  type SearchFailuresInput,
} from './schema.js';

const TABLE = 'failures';

/** keep-alive の実行記録を追記するテーブル。 */
const KEEPALIVE_TABLE = 'keepalive_log';

const COLUMNS =
  'id, created_at, domain, environment, attempted, observed, cause, cause_is_assumption, workaround, tags';

export type Store = SupabaseClient;

export function createStore(env: Env): Store {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * LIKE パターンとして解釈される文字を無効化する。
 * PostgREST は ilike の値に含まれる `*` を `%` として扱うため、あわせて除去する。
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`).replace(/\*/g, ' ');
}

/** 失敗談を新しい順に検索する。返却件数は必ず上限以下になる。 */
export async function searchFailures(
  store: Store,
  input: SearchFailuresInput,
): Promise<FailureRecord[]> {
  const limit = Math.min(input.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);

  let request = store
    .from(TABLE)
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (input.domain !== undefined) {
    request = request.eq('domain', input.domain);
  }
  if (input.environment !== undefined) {
    request = request.ilike('environment', `%${escapeLikePattern(input.environment)}%`);
  }
  if (input.query !== undefined) {
    request = request.ilike('search_text', `%${escapeLikePattern(input.query)}%`);
  }

  const { data, error } = await request;
  if (error !== null) {
    throw new Error(`失敗談の検索に失敗しました: ${error.message}`);
  }

  // 上限超過を返さないことは要件であるため、クエリ側の limit に加えてここでも切り詰める。
  return (data as unknown as FailureRecord[]).slice(0, limit);
}

/** 失敗談を 1 件登録し、登録された行を返す。 */
export async function recordFailure(
  store: Store,
  input: RecordFailureInput,
): Promise<FailureRecord> {
  const row = {
    domain: input.domain,
    environment: input.environment,
    attempted: input.attempted,
    observed: input.observed,
    cause: input.cause,
    cause_is_assumption: input.cause_is_assumption,
    workaround: input.workaround ?? null,
    tags: [...new Set(input.tags)],
  };

  const { data, error } = await store.from(TABLE).insert(row).select(COLUMNS).single();
  if (error !== null) {
    throw new Error(`失敗談の登録に失敗しました: ${error.message}`);
  }

  return data as unknown as FailureRecord;
}

/**
 * keep-alive の結果。
 *
 * 記録まで到達したかどうかを呼び出し側へ返す。疎通はできたが記録できなかった
 * 場合を「成功」として片付けると、可観測性を足した意味が無くなるためである。
 */
export type PingResult = { recorded: true } | { recorded: false; reason: string };

/**
 * Supabase 無料プランの自動停止を回避する。
 *
 * 読み取りではなく `keepalive_log` への 1 行追記とする。理由は 2 つある。
 *
 *   1. 読み取りが「アクティビティ」として数えられない可能性を排除できる。
 *      書き込みであれば、その曖昧さが残らない。
 *   2. 「最後に keep-alive が成功したのはいつか」が DB を見れば分かる。
 *      2026-09-27 の停止では Cron が動いたかどうかを確かめる手段が無く、
 *      これが切り分けを最も妨げた。
 *
 * 追記に失敗した場合は `failures` の読み取りへ退避する。keepalive_log の
 * マイグレーション適用とデプロイの順序はどちらが先にもなりうるため、
 * テーブルがまだ無いあいだ停止回避そのものを失わせないための措置である。
 * 退避したことは理由とともに呼び出し側へ返し、ログへ残す。
 */
export async function ping(store: Store): Promise<PingResult> {
  // PostgREST へ空のオブジェクトを渡す挙動に依存しないよう、時刻は明示的に送る。
  // 列側の既定値は SQL エディタからの手動追記のために残してある。
  const { error: insertError } = await store
    .from(KEEPALIVE_TABLE)
    .insert({ ran_at: new Date().toISOString() });

  if (insertError === null) {
    return { recorded: true };
  }

  const { error: selectError } = await store.from(TABLE).select('id').limit(1);
  if (selectError !== null) {
    throw new Error(
      `keep-alive に失敗しました: 追記 = ${insertError.message} / 読み取り = ${selectError.message}`,
    );
  }

  return { recorded: false, reason: insertError.message };
}
