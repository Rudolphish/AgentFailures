-- 検索の実行を記録する表。
--
-- 目的は計測である。現在は検索が呼ばれたかどうかも、0 件で返ったかどうかも
-- 記録されていない。docs/mcp-optimization-plan.md §7 の判定（意味検索を
-- 見直す条件）は、この記録が 30 日たまって初めて可能になる。
--
-- 設計で効いている点を 3 つ書く。
--
--   * **記録の本文は入れない。** 受け取った入力と件数だけを持つ。失敗談の
--     本文は failures にあり、重複して保存する意味が無い。
--
--   * **source で「検索」と「書き込み確認」を分ける。** 記録に失敗しても
--     検索は返す設計（計測のために本体を落とさない）であるため、この表が
--     空のとき「誰も検索していない」と「記録が壊れている」を区別できない。
--     keep-alive（週 2 回の Cron）が source='writable-check' の行を入れるので、
--     検索の行が無くても書き込み確認の行があれば機構は生きていると分かる。
--     両方無ければ機構が壊れている。
--     2026-10-13 に、退避処理が「修正が効いていない状態」を正常動作と
--     区別できない形になっており、マイグレーションが 14 日間未適用のまま
--     誰も気づけなかった（失敗談 5a236586-a826-4b30-a38b-e1f85252c374）。
--     同じ形を避けるための列である。
--
--   * **検索の行では件数列を NOT NULL と同等に強制する。** CHECK で source
--     ごとに要求を変える。件数が入らない検索の行は計測に使えないため、
--     静かに混ざらないようにする。
CREATE TABLE search_log (
  id             TEXT    PRIMARY KEY,
  ran_at         TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  -- 以下は source='search' のときだけ入る。
  query          TEXT,
  domain         TEXT,
  environment    TEXT,
  limit_value    INTEGER,
  -- and / or / none。or は AND が 0 件で語が 2 つ以上あったときだけ入る。
  combine        TEXT,
  -- limit で切る前の一致総数。
  matched_count  INTEGER,
  -- 実際に返した件数。
  returned_count INTEGER,

  CHECK (source IN ('search', 'writable-check')),
  CHECK (
    source <> 'search'
    OR (
      limit_value    IS NOT NULL
      AND matched_count  IS NOT NULL
      AND returned_count IS NOT NULL
      AND combine IN ('and', 'or', 'none')
    )
  ),
  CHECK (
    source <> 'writable-check'
    OR (
      query IS NULL AND domain IS NULL AND environment IS NULL
      AND limit_value IS NULL AND combine IS NULL
      AND matched_count IS NULL AND returned_count IS NULL
    )
  )
);

-- 30 日ぶんを時刻で切り出す用。
CREATE INDEX idx_search_log_ran_at ON search_log(ran_at DESC);
-- 「検索の行だけ」「書き込み確認の行だけ」を引く用。
CREATE INDEX idx_search_log_source_ran_at ON search_log(source, ran_at DESC);
