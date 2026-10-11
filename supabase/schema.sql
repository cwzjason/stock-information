-- ============================================================
--  美股监控 · 去重表
--  用法：Supabase Dashboard -> SQL Editor -> 粘贴整段执行
--  Python 端通过 PostgREST 读写，替代本地 dedup_cache.json
-- ============================================================

create table if not exists public.news_dedup (
  hash        text primary key,
  created_at  timestamptz not null default now()
);

create index if not exists news_dedup_created_at_idx
  on public.news_dedup (created_at desc);

-- 开启 RLS（Supabase 要求；下面用 policy 放开 anon 访问）
alter table public.news_dedup enable row level security;

-- 表内只有新闻标题的 md5，无敏感数据，允许 anon key 读写。
-- 若你改用 service_role key 放 Secrets，可以跳过这几条 policy。
drop policy if exists "dedup anon select" on public.news_dedup;
create policy "dedup anon select" on public.news_dedup
  for select to anon using (true);

drop policy if exists "dedup anon insert" on public.news_dedup;
create policy "dedup anon insert" on public.news_dedup
  for insert to anon with check (true);

drop policy if exists "dedup anon delete" on public.news_dedup;
create policy "dedup anon delete" on public.news_dedup
  for delete to anon using (true);

-- 清理过期记录：Python 每次运行结束调用一次，防止表无限增长
create or replace function public.prune_dedup(retention_days int default 30)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.news_dedup
  where created_at < now() - make_interval(days => greatest(coalesce(retention_days, 30), 1));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

grant execute on function public.prune_dedup(int) to anon, authenticated;
