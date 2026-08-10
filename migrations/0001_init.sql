-- Sub2API-CF D1 schema (SQLite)
-- 上游账号表：每个 AI 订阅账号一行
CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT    NOT NULL,                       -- openai | anthropic | gemini
  name        TEXT    NOT NULL,
  api_key     TEXT    NOT NULL,
  base_url    TEXT    NOT NULL,                       -- 上游 base（留空用默认）
  model_map   TEXT    NOT NULL DEFAULT '{}',          -- {"gpt-4o":"gpt-4o"} 模型别名映射
  weight      INTEGER NOT NULL DEFAULT 1,             -- 权重（预留，当前按 least-recently-used 选）
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_used   INTEGER,                                -- 上次使用时间戳，用于轮询
  usage_tokens INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 用户 API Key 表：分发给下游调用方
CREATE TABLE IF NOT EXISTS user_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT    NOT NULL UNIQUE,               -- sk-xxxx
  label        TEXT    DEFAULT '',
  quota_tokens INTEGER,                                -- 额度上限（token），NULL=不限
  used_tokens  INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- 用量流水表
CREATE TABLE IF NOT EXISTS usage_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key_id      INTEGER,
  account_id       INTEGER,
  model            TEXT,
  prompt_tokens    INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_keys_key ON user_keys(key);
CREATE INDEX IF NOT EXISTS idx_usage_user    ON usage_logs(user_key_id);
CREATE INDEX IF NOT EXISTS idx_accounts_enabled ON accounts(enabled, last_used);
