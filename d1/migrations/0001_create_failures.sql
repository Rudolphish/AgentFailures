-- failures / keepalive_log を D1 (SQLite) へ作る。
--
-- Supabase (PostgreSQL) からの移行である。対応関係と、そうした理由は
-- docs/d1-migration-plan.md の §3 にある。事前検証の結果は §5。
--
-- Postgres 版との主な違い。
--   * id と created_at は Worker 側で生成して渡す。SQLite に uuid 生成関数は
--     無く、CURRENT_TIMESTAMP は ISO 8601 と書式が異なるため、経路を 1 つに絞る。
--   * boolean は INTEGER 0/1。文字列 "0"/"1" を bind しても INTEGER affinity で
--     整数になり、下の CHECK を通ることを実測で確認している。
--   * tags は JSON 配列の文字列。json_each で絞り込めることを確認済み。
--   * search_text の生成列に immutable のラッパー関数は要らない。SQLite には
--     immutable の概念が無く、|| と coalesce を式に直接書ける。
--   * RLS に相当する仕掛けは置かない。D1 へは Worker の binding からしか
--     到達できず、anon キーに相当するものが存在しない。

CREATE TABLE failures (
  id                  TEXT    PRIMARY KEY,
  created_at          TEXT    NOT NULL,
  domain              TEXT    NOT NULL CHECK (length(trim(domain)) > 0),
  environment         TEXT    NOT NULL CHECK (length(trim(environment)) > 0),
  attempted           TEXT    NOT NULL CHECK (length(trim(attempted)) > 0),
  observed            TEXT    NOT NULL CHECK (length(trim(observed)) > 0),
  cause               TEXT    NOT NULL CHECK (length(trim(cause)) > 0),
  cause_is_assumption INTEGER NOT NULL CHECK (cause_is_assumption IN (0, 1)),
  workaround          TEXT,
  tags                TEXT    NOT NULL DEFAULT '[]',
  search_text         TEXT    GENERATED ALWAYS AS (
    domain || ' ' || environment || ' ' || attempted || ' ' || observed || ' ' ||
    cause || ' ' || coalesce(workaround, '') || ' ' ||
    coalesce(replace(replace(replace(tags, '[', ''), ']', ''), '"', ''), '')
  ) STORED
);

-- 読み出しの既定が新しい順であるため created_at、domain は完全一致で絞るため domain。
-- environment と search_text には索引を張らない（部分一致のため効かない）。
-- 実測では 134 行で 1 検索あたり最大 263 行読みであり、無料枠に対して桁が余る。
CREATE INDEX idx_failures_created_at ON failures (created_at DESC);
CREATE INDEX idx_failures_domain     ON failures (domain);

-- keep-alive の記録。自動停止の対策ではなく、最後に書き込めた時刻を残すため。
-- D1 で停止が起きないことを 30 日観測したうえで削除する（計画 §6）。
CREATE TABLE keepalive_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL
);
