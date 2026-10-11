-- D1(SQLite) 去重表
-- 执行：npx wrangler d1 execute us_monitor --file=workers/schema.sql

CREATE TABLE IF NOT EXISTS news_dedup (
  hash       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_news_dedup_created_at
  ON news_dedup (created_at DESC);
