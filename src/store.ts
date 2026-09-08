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
 * Supabase 無料プランの自動停止を回避するための最小クエリ。
 * 行が存在しなくても DB へのアクセスとしては成立する。
 */
export async function ping(store: Store): Promise<void> {
  const { error } = await store.from(TABLE).select('id').limit(1);
  if (error !== null) {
    throw new Error(`keep-alive クエリに失敗しました: ${error.message}`);
  }
}
