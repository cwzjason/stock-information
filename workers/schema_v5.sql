-- ============================================================
--  事件雷达 v5：SEC 披露唯一身份（CIK + accession）
--  在已有库上执行，可重复运行
--  执行：npx wrangler d1 execute us_monitor --file=workers/schema_v5.sql --remote
-- ============================================================

-- ③ SEC 文件的唯一身份。同一份文件从"全局最新"和"按公司查"两条路进来时
-- 标题可能不同，但 accession 必然相同 —— 用它去重才不会重复打扰。
ALTER TABLE items_log ADD COLUMN accession TEXT;

CREATE INDEX IF NOT EXISTS idx_items_accession ON items_log(accession);
