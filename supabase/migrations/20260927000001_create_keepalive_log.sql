-- keep-alive の実行記録を保持するテーブルを作成する。
--
-- 背景:
--   2026-09-27、Cron による keep-alive を設定していたにもかかわらず Supabase
--   プロジェクトが無操作で自動停止した。原因の切り分けができなかった理由は、
--   keep-alive が読み取りクエリのみであり、**実行されたかどうかを後から
--   確認する手段が DB 側に一切無かった**ことである。
--
-- 方針:
--   * keep-alive を書き込みにすることで、アクティビティとして数えられない
--     可能性を消す。
--   * 同時に「最後に成功したのはいつか」が SQL で追えるようにする。通知や
--     外部ログに依存せず、停止しかけているかどうかを DB 単体で判定できる。
--   * failures と同じ遮断方針を敷く（RLS 有効・ポリシー無し・権限剥奪）。

create table public.keepalive_log (
  id     bigint      generated always as identity primary key,
  ran_at timestamptz not null default now()
);

comment on table  public.keepalive_log        is 'keep-alive Cron の実行記録。行の存在そのものが「その時刻に DB へ書き込めた」証跡である。';
comment on column public.keepalive_log.ran_at is '書き込みを行った時刻。max(ran_at) が最後に keep-alive が成功した時刻となる。';

-- 索引は張らない。週 2 回の追記であり年間 100 行程度に留まるため、
-- max(ran_at) は逐次走査で足りる。

alter table public.keepalive_log enable row level security;

revoke all on table public.keepalive_log from anon, authenticated;
