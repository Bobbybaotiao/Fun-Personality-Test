-- 在 Cloudflare 控制台 D1 → 你的数据库 → Console 里粘贴执行
CREATE TABLE IF NOT EXISTS submissions (
  id         TEXT PRIMARY KEY,           -- 客户端生成的去重 id
  result     TEXT NOT NULL,              -- 最终水果人格 id
  answers    TEXT NOT NULL,              -- JSON 数组，12 题分别选了哪种水果
  created_at TEXT NOT NULL               -- 提交时间（ISO）
);
