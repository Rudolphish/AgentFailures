-- 既存レコードの domain を、技術を表す語彙へ揃えるための一度きりの整理。
--
-- 経緯: 運用開始から数時間で記録 9 件に対し domain が 8 種類まで分散し、
-- domain による絞り込みが成立しない状態になった。話題を表す名称
-- （notification-design / api-cache-design 等）が domain に入っていたことが原因である。
-- 規約は docs/taxonomy.md を参照。
--
-- 適用方法: Supabase ダッシュボードの SQL Editor へ貼り付けて実行する。
-- マイグレーションではなくデータの整理であるため、supabase/migrations には置かない。
--
-- 実行前に、下の SELECT で対象と現在値を確認すること。

-- 1. 現状の確認
select domain, count(*) as 件数
from public.failures
group by domain
order by 件数 desc, domain;

-- 2. 疎通確認用のダミーを削除する
--    （setup ドメインはこの 1 件のみ。実データが入っていないことを確認してから実行する）
select id, domain, attempted from public.failures where domain = 'setup';

delete from public.failures where domain = 'setup';

-- 3. 話題を表す domain を、技術を表す domain へ置き換える
--    話題そのものは既に tags 側へ入っているため、情報は失われない。

-- 週次通知の取りこぼし。Next.js の cron ルートで発生した。
-- tags に notification / idempotency / discord が入っている。
update public.failures
set domain = 'nextjs'
where domain = 'notification-design';

-- 外部APIキャッシュの設計。Next.js + Prisma の構成で発生した。
-- tags に caching / external-api / api-design が入っている。
update public.failures
set domain = 'nextjs'
where domain = 'api-cache-design';

-- Claude Code の permissions.deny とプロキシによる拒否。
update public.failures
set domain = 'claude-code'
where domain = 'agent-environment';

-- 4. 結果の確認
--    docs/taxonomy.md の語彙に無い domain が残っていないことを確かめる。
select domain, count(*) as 件数
from public.failures
group by domain
order by 件数 desc, domain;

select id, domain, left(attempted, 40) as attempted
from public.failures
where domain not in (
  'nextjs',
  'cloudflare-workers',
  'supabase',
  'github-actions',
  'claude-code',
  'windows-powershell',
  'discord-api'
);
