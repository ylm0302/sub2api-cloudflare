-- Sub2API-CF D1 schema v3
-- 对齐上游 Sub2API 的核心管理模型：用户 / 分组 / 套餐订阅 / 兑换码 / 公告 / 审计日志 / 设置
-- 替换方案说明：
--   * 余额计费：用 token 额度（balance_tokens）替代 USD 计费；-1 = 不限
--   * 支付：用「兑换码 + 离线开通」替代在线支付（可选接 Stripe Checkout，Worker 可调用）
--   * 用户注册/登录：用「管理员创建用户」替代自服务注册（无 SMTP/OAuth 站点登录）

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT NOT NULL UNIQUE,
  email            TEXT DEFAULT '',
  role             TEXT NOT NULL DEFAULT 'user',      -- admin | user
  status           TEXT NOT NULL DEFAULT 'active',    -- active | disabled
  balance_tokens   INTEGER NOT NULL DEFAULT 0,        -- 剩余 token 额度，-1 = 不限
  concurrency      INTEGER NOT NULL DEFAULT 3,        -- 用户级并发上限
  rpm_limit        INTEGER NOT NULL DEFAULT 0,        -- 用户级 RPM 上限（0 = 不限）
  notes            TEXT,
  last_active_at   INTEGER,
  created_at       INTEGER NOT NULL
);

-- 分组表
CREATE TABLE IF NOT EXISTS groups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT,
  platform        TEXT DEFAULT '',                    -- '' = 通用；openai/anthropic/gemini/grok/antigravity
  rate_multiplier REAL NOT NULL DEFAULT 1.0,          -- 计费倍率（本版仅展示/预留）
  status          TEXT NOT NULL DEFAULT 'active',     -- active | inactive
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- 套餐表（订阅来源）
CREATE TABLE IF NOT EXISTS packages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  tokens        INTEGER NOT NULL DEFAULT 0,           -- 套餐赠送 token 额度
  duration_days INTEGER NOT NULL DEFAULT 30,          -- 订阅时长（天）
  price_note    TEXT DEFAULT '',                      -- 价格说明（离线/兑换码计费）
  status        TEXT NOT NULL DEFAULT 'active',       -- active | inactive
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 用户订阅表
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  package_id  INTEGER,
  tokens      INTEGER NOT NULL DEFAULT 0,             -- 该订阅赠送的 token 额度
  starts_at   INTEGER NOT NULL,
  expires_at  INTEGER,                                -- null = 永久
  status      TEXT NOT NULL DEFAULT 'active',         -- active | expired | revoked | suspended
  created_at  INTEGER NOT NULL
);

-- 兑换码表
CREATE TABLE IF NOT EXISTS promo_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  bonus_tokens INTEGER NOT NULL DEFAULT 0,
  max_uses     INTEGER NOT NULL DEFAULT 1,
  used_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active',        -- active | disabled
  expires_at   INTEGER,
  notes        TEXT,
  created_at   INTEGER NOT NULL
);

-- 兑换记录
CREATE TABLE IF NOT EXISTS promo_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_code_id INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  bonus_tokens  INTEGER NOT NULL DEFAULT 0,
  used_at       INTEGER NOT NULL
);

-- 公告表
CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',         -- active | inactive
  created_at  INTEGER NOT NULL
);

-- 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT DEFAULT '',                        -- admin / 具体管理员
  action      TEXT NOT NULL,                          -- create/update/delete/redeem/assign...
  target_type TEXT DEFAULT '',                        -- account/key/user/group/package/subscription/promo/announcement/settings
  target_id   INTEGER,
  detail      TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- 站点设置表（key-value）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

-- user_keys 扩展列（对齐 ApiKey 模型：归属用户、分组、过期、RPM、IP）
ALTER TABLE user_keys ADD COLUMN user_id INTEGER;
ALTER TABLE user_keys ADD COLUMN group_id INTEGER;
ALTER TABLE user_keys ADD COLUMN expires_at INTEGER;
ALTER TABLE user_keys ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_keys ADD COLUMN last_used_ip TEXT;
ALTER TABLE user_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- accounts_v2 增加渠道监控列
ALTER TABLE accounts_v2 ADD COLUMN last_checked_at INTEGER;
ALTER TABLE accounts_v2 ADD COLUMN last_check_result TEXT;

-- usage_logs 增加用户归属（用于用户维度用量统计）
ALTER TABLE usage_logs ADD COLUMN user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_user_keys_user  ON user_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_user       ON user_subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_promo_code     ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_logs(created_at);
