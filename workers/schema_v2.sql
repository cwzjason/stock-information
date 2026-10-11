-- ============================================================
--  事件雷达 v2：观测与排队（P0 / P2）
--  在已有库上执行，全部 IF NOT EXISTS，可重复运行
-- ============================================================

-- 来源健康度：发现长期失效的源（如 BLS 一直 403）
CREATE TABLE IF NOT EXISTS source_status (
  source   TEXT PRIMARY KEY,
  ok       INTEGER NOT NULL DEFAULT 0,      -- 本次是否成功
  items    INTEGER NOT NULL DEFAULT 0,      -- 本次抓到几条
  fail_streak INTEGER NOT NULL DEFAULT 0,   -- 连续失败次数
  last_try_at TEXT,
  last_ok_at  TEXT,
  last_content_at TEXT,                     -- 最近一次真的拿到内容的时间
  note     TEXT
);

-- 被过滤掉的内容：用来抽查"没推给你的"，比只看推送更容易发现漏报
CREATE TABLE IF NOT EXISTS dropped (
  fp       TEXT,
  title    TEXT,
  source   TEXT,
  reason   TEXT,                            -- no_relevance / no_signal / noise / dup ...
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (fp, reason)
);

-- 送达与延迟：发布 → 发现 → 推送，三段耗时
CREATE TABLE IF NOT EXISTS delivery (
  fp          TEXT,
  level       TEXT,
  relevance   TEXT,
  fact_status TEXT,
  published_at TEXT,                        -- 来源给的时间；来源没给就是 NULL（不拿抓取时间冒充）
  found_at    TEXT,
  pushed_at   TEXT,
  hooks_ok    TEXT,                         -- 各机器人结果，如 "1:ok,2:fail"
  PRIMARY KEY (fp, found_at)
);

CREATE INDEX IF NOT EXISTS idx_dropped_at ON dropped(created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_at ON delivery(found_at);
