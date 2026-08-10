-- Sub2API-CF D1 schema v4
-- 模型维度限流：每 Key / 每用户对指定模型的 RPM 与并发上限（0 = 不限）
-- model 支持精确模型名或 '*'（通配所有模型）
-- 规则优先级（取最具体的一条）：key+model > key+* > user+model > user+* > 全局+model > 全局+*
CREATE TABLE IF NOT EXISTS model_limits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,                          -- NULL = 所有用户
  key_id      INTEGER,                          -- NULL = 该用户所有 Key
  model       TEXT NOT NULL,                    -- 模型名；'*' = 通配
  rpm_limit   INTEGER NOT NULL DEFAULT 0,       -- 每分钟请求上限，0 = 不限
  concurrency INTEGER NOT NULL DEFAULT 0,       -- 最大并发请求数，0 = 不限
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_limits_lookup ON model_limits(enabled, model, key_id, user_id);
