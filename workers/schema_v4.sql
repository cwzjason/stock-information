-- ============================================================
--  事件雷达 v4：源元数据 + 事实准确率自检
--  在已有库上执行，可重复运行
--  执行：npx wrangler d1 execute us_monitor --file=workers/schema_v4.sql --remote
-- ============================================================

-- ③ 每个源的访问方式与轮询频率：失效时能看出"这源本来该多久拉一次"
ALTER TABLE source_status ADD COLUMN mode     TEXT;
ALTER TABLE source_status ADD COLUMN interval TEXT;

-- ⑩ 事实准确率自检：主体 / 时间 / 来源域名是否自洽，抽查用
CREATE TABLE IF NOT EXISTS fact_check (
  fp          TEXT PRIMARY KEY,
  subject     TEXT,
  subject_ok  INTEGER,   -- 主体是否真的出现在标题里
  time_ok     INTEGER,   -- 发布时间是否合理（不晚于发现时间）
  source_ok   INTEGER,   -- 原文链接域名是否与来源匹配
  issues      TEXT,      -- 具体问题描述；数字与口径无法自动校验，另行抽查
  checked_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_fact_checked ON fact_check(checked_at);
