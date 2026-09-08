-- 失敗談ナレッジストアの基礎テーブルを作成する。
--
-- 方針:
--   * 書き込みは MCP サーバー（service_role キー）のみが行う。
--   * 閲覧は人間も Supabase ダッシュボード経由で行うため、平文の text 列で保持する。
--   * query による全文検索は日本語を分かち書きできないため tsvector ではなく
--     pg_trgm による部分一致で実現する。

create extension if not exists pg_trgm;

-- 検索対象列を 1 つに連結するためのヘルパー。
-- 生成列から呼び出すため immutable として宣言する。
-- concat_ws / array_to_string は型出力関数を経由する都合で stable 扱いだが、
-- text および text[] のみを引数に取る本関数の結果は決定的である。
create or replace function public.failures_search_text(
  p_domain      text,
  p_environment text,
  p_attempted   text,
  p_observed    text,
  p_cause       text,
  p_workaround  text,
  p_tags        text[]
) returns text
language sql
immutable
parallel safe
as $$
  select concat_ws(
    ' ',
    p_domain,
    p_environment,
    p_attempted,
    p_observed,
    p_cause,
    coalesce(p_workaround, ''),
    array_to_string(coalesce(p_tags, '{}'::text[]), ' ')
  )
$$;

create table public.failures (
  id                  uuid        primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),

  -- 対象領域（例: app-dev, notion-integration, scheduling）
  domain              text        not null check (length(btrim(domain)) > 0),

  -- 実行環境およびバージョン情報
  environment         text        not null check (length(btrim(environment)) > 0),

  -- 何をしようとしたか
  attempted           text        not null check (length(btrim(attempted)) > 0),

  -- 実際に何が起きたか（観測された事実のみ）
  observed            text        not null check (length(btrim(observed)) > 0),

  -- 原因
  cause               text        not null check (length(btrim(cause)) > 0),

  -- 原因が推定である場合は true
  cause_is_assumption boolean     not null,

  -- 回避策（任意）
  workaround          text        check (workaround is null or length(btrim(workaround)) > 0),

  tags                text[]      not null default '{}'::text[],

  -- 全文検索用の連結列
  search_text         text        generated always as (
    public.failures_search_text(
      domain, environment, attempted, observed, cause, workaround, tags
    )
  ) stored
);

comment on table  public.failures                     is 'AI エージェントが蓄積する失敗談。書き込みは MCP サーバーのみ。';
comment on column public.failures.observed            is '観測された事実のみを記載する。解釈や推測は cause に書く。';
comment on column public.failures.cause_is_assumption is '原因が確認済みの事実ではなく推定である場合に true。';
comment on column public.failures.search_text         is 'search_failures の query 用に検索対象列を連結した生成列。';

-- 新しい順の取得が既定の読み出しパターンであるため降順索引を張る。
create index failures_created_at_idx on public.failures (created_at desc);

-- domain は完全一致で絞り込む。
create index failures_domain_idx on public.failures (domain);

-- environment / query は部分一致で絞り込むため trigram 索引を張る。
create index failures_environment_trgm_idx on public.failures using gin (environment gin_trgm_ops);
create index failures_search_text_trgm_idx on public.failures using gin (search_text gin_trgm_ops);

create index failures_tags_idx on public.failures using gin (tags);

-- RLS を有効化し、ポリシーを一切定義しないことで anon / authenticated からの
-- 到達を遮断する。service_role は RLS をバイパスするため MCP サーバーのみが読み書きできる。
alter table public.failures enable row level security;

revoke all on table public.failures from anon, authenticated;
