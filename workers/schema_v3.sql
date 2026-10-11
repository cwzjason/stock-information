-- ============================================================
--  事件雷达 v3：事件化 + 采集/发送分离 + 定时汇总
--  在已有库上执行，全部 IF NOT EXISTS，可重复运行
--  执行：npx wrangler d1 execute us_monitor --file=workers/schema_v3.sql --remote
-- ============================================================

-- ① 事件表：以"主体 + 事件类型"为中心，同源报道合并成一个事件
CREATE TABLE IF NOT EXISTS events (
  ekey        TEXT PRIMARY KEY,   -- hash(主体|事件类型)
  subject     TEXT,               -- 主体：公司名 / 宏观指标 / 市场
  etype       TEXT,               -- 事件类型：业绩 / 指引 / 评级 / 宏观数据 ...
  title       TEXT,               -- 首次标题
  last_title  TEXT,               -- 最新标题
  level       TEXT,               -- 最高级别
  relevance   TEXT,
  fact_status TEXT,
  first_seen  TEXT,
  last_seen   TEXT,
  hits        INTEGER NOT NULL DEFAULT 1,   -- 累计报道条数
  versions    INTEGER NOT NULL DEFAULT 1,   -- 事件版本：有实质更新才 +1
  pushed      INTEGER NOT NULL DEFAULT 0,   -- 已即时推送次数（限流用）
  last_link   TEXT
);

-- ② 全量流水：所有通过过滤的条目都留档，汇总报告靠它
CREATE TABLE IF NOT EXISTS items_log (
  fp          TEXT PRIMARY KEY,
  ekey        TEXT,
  title       TEXT,
  content     TEXT,
  zh_title    TEXT,
  zh_content  TEXT,
  source      TEXT,
  link        TEXT,
  level       TEXT,
  relevance   TEXT,
  fact_status TEXT,
  impact      TEXT,
  bias        TEXT,
  subject     TEXT,
  etype       TEXT,
  published_at TEXT,
  found_at    TEXT,
  pushed      INTEGER NOT NULL DEFAULT 0    -- 是否即时推送过（0=只进了汇总）
);

-- ③ 待发送队列：采集只管写，发送只管发，失败重试、积压转摘要
CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT,               -- alert / update / digest
  ekey        TEXT,
  fp          TEXT,
  level       TEXT,
  payload     TEXT,               -- JSON
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending / sent / folded / failed
  tries       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT,
  sent_at     TEXT,
  next_try_at TEXT,
  hooks_ok    TEXT
);

-- ④ 汇总发送记录：保证同一时段只发一次（幂等）
CREATE TABLE IF NOT EXISTS digests (
  slot        TEXT PRIMARY KEY,   -- 2026-10-10-daily / 2026-10-12-weekend
  kind        TEXT,
  window_from TEXT,
  window_to   TEXT,
  items       INTEGER,
  hooks_ok    TEXT,
  sent_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_found  ON items_log(found_at);
CREATE INDEX IF NOT EXISTS idx_items_level  ON items_log(level, found_at);
CREATE INDEX IF NOT EXISTS idx_outbox_queue ON outbox(status, next_try_at, level);
CREATE INDEX IF NOT EXISTS idx_events_seen  ON events(last_seen);
