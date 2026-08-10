-- Sub2API-CF D1 schema v2
-- 对齐上游 Sub2API 账号模型：platform / type(api_key|oauth|cookie) / credentials(JSON) / 调度字段
-- 注：cookie 类型仅用于明示拒绝，不作为功能实现（规避平台限制/会话重放）。

CREATE TABLE IF NOT EXISTS accounts_v2 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  platform      TEXT    NOT NULL,            -- openai | anthropic | gemini | grok | antigravity
  type          TEXT    NOT NULL,            -- api_key | oauth | cookie
  credentials   TEXT    NOT NULL,            -- JSON: {api_key} | {access_token,refresh_token,expires_at,client_id?} | {session_key}
  extra         TEXT    NOT NULL DEFAULT '{}',
  model_map     TEXT    NOT NULL DEFAULT '{}',
  base_url      TEXT,                       -- 留空走默认
  priority      INTEGER NOT NULL DEFAULT 50,-- 越小越优先
  concurrency   INTEGER NOT NULL DEFAULT 3, -- 最大并发（调度参考）
  status        TEXT    NOT NULL DEFAULT 'active', -- active | error | disabled
  schedulable   INTEGER NOT NULL DEFAULT 1, -- 是否参与调度
  rate_limited_at         INTEGER,          -- 触发 429 时间
  rate_limit_reset_at     INTEGER,          -- 限速预计解除
  overload_until          INTEGER,          -- 过载解除
  temp_unschedulable_until INTEGER,         -- 临时不可调度解除
  last_used_at            INTEGER,
  expires_at              INTEGER,          -- 账号过期（订阅到期）
  auto_pause_on_expired   INTEGER NOT NULL DEFAULT 1,
  usage_tokens            INTEGER NOT NULL DEFAULT 0,
  error_message           TEXT,
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_sched   ON accounts_v2(schedulable, status, priority, last_used_at);
CREATE INDEX IF NOT EXISTS idx_v2_plat   ON accounts_v2(platform, type);
CREATE INDEX IF NOT EXISTS idx_v2_ident   ON accounts_v2(platform, type, name);
