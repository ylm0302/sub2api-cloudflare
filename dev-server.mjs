// dev-server.mjs — 本地模拟服务
// 用 node:sqlite 模拟 D1，直接跑真实的 src/index.js worker，让管理后台预览页
// 能在浏览器里加载真实的账号 / Key / 用量数据，并完成增删改操作。
//
// 用法：  node dev-server.mjs            （默认 127.0.0.1:8788，token=dev-admin-token）
//         PORT=9000 ADMIN_TOKEN=abc node dev-server.mjs
// 打开：  http://127.0.0.1:8788/admin?token=dev-admin-token
import http from "node:http";
import worker from "./src/index.js";
import { makeD1 } from "./test/d1.js";

const PORT = Number(process.env.PORT || 8788);
const HOST = "127.0.0.1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token";

// ---------- D1 模拟 + 种子数据 ----------
const db = makeD1();
db.migrate();
await seed(db);

async function seed(db) {
  const now = Date.now();
  const h = 3600 * 1000;
  const insAcct = db.prepare(
    "INSERT INTO accounts_v2 (name,platform,type,credentials,model_map,base_url,priority,concurrency,status,schedulable,last_used_at,usage_tokens,error_message,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  const accts = [
    {
      name: "acc-openai-01",
      platform: "openai",
      type: "api_key",
      credentials: { api_key: "sk-proj-demo-openai-0001" },
      model_map: { "gpt-4o": "gpt-4o", "gpt-4o-mini": "gpt-4o-mini", "claude-sonnet-4-5": "claude-3-5-sonnet" },
      base_url: null,
      priority: 10,
      concurrency: 5,
      status: "active",
      schedulable: 1,
      last_used_at: now - h,
      usage_tokens: 1234567,
      error_message: null,
    },
    {
      name: "acc-anthropic-02",
      platform: "anthropic",
      type: "oauth",
      credentials: { access_token: "sk-ant-demo", refresh_token: "rt-demo", expires_at: now + 7 * 24 * h },
      model_map: { "claude-sonnet-4-5": "claude-sonnet-4-5", "claude-opus-4-5": "claude-opus-4-5" },
      base_url: null,
      priority: 20,
      concurrency: 3,
      status: "error",
      schedulable: 0,
      last_used_at: now - 3 * h,
      usage_tokens: 89012,
      error_message: "auth failed: 401 invalid access token",
    },
    {
      name: "acc-gemini-03",
      platform: "gemini",
      type: "api_key",
      credentials: { api_key: "AIza-demo-gemini-0003" },
      model_map: { "gemini-2.5-flash": "gemini-2.5-flash", "gemini-2.5-pro": "gemini-2.5-pro" },
      base_url: null,
      priority: 30,
      concurrency: 4,
      status: "active",
      schedulable: 1,
      last_used_at: now - 30 * 60 * 1000,
      usage_tokens: 456789,
      error_message: null,
    },
    {
      name: "acc-grok-04",
      platform: "grok",
      type: "api_key",
      credentials: { api_key: "xai-demo-grok-0004" },
      model_map: { "grok-3": "grok-3", "grok-3-mini": "grok-3-mini" },
      base_url: "https://api.x.ai/v1",
      priority: 40,
      concurrency: 2,
      status: "active",
      schedulable: 1,
      last_used_at: null,
      usage_tokens: 0,
      error_message: null,
    },
  ];
  for (const a of accts) {
    await insAcct
      .bind(
        a.name, a.platform, a.type, JSON.stringify(a.credentials), JSON.stringify(a.model_map),
        a.base_url, a.priority, a.concurrency, a.status, a.schedulable,
        a.last_used_at, a.usage_tokens, a.error_message, now
      )
      .run();
  }

  const insKey = db.prepare(
    "INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at) VALUES (?,?,?,?,?,?)"
  );
  await insKey.bind("sk-1234567890abcdefghijklmnopqrstuvwxyz123456", "小明", 1000000, 512345, 1, now - 10 * 24 * h).run();
  await insKey.bind("sk-fedcba0987654321zyxwvutsrqponmlkjihgfedcba", "团队A", null, 999, 1, now - 5 * 24 * h).run();
  await insKey.bind("sk-0000000000000000000000000000000000000000", "已停用的 Key", 500000, 100, 0, now - 2 * 24 * h).run();

  const insLog = db.prepare(
    "INSERT INTO usage_logs (user_key_id,user_id,account_id,model,prompt_tokens,completion_tokens,created_at) VALUES (?,?,?,?,?,?,?)"
  );
  // 时间跨度 40 天，方便用量图表展示按天分布（key1/key2 归 alice，key3 归 bob）
  const logs = [
    [1, 2, 1, "gpt-4o", 120, 80, now - 5 * 60 * 1000],
    [1, 2, 3, "gemini-2.5-flash", 300, 150, now - 2 * h],
    [2, 2, 2, "claude-sonnet-4-5", 800, 220, now - 6 * h],
    [2, 2, 1, "gpt-4o-mini", 50, 30, now - 24 * h],
    [1, 2, 4, "grok-3", 640, 128, now - 30 * h],
    [1, 2, 1, "gpt-4o", 90, 60, now - 40 * h],
    [2, 2, 1, "gpt-4o", 410, 190, now - 45 * 24 * h],
    [1, 2, 3, "gemini-2.5-pro", 900, 300, now - 48 * 24 * h],
    [3, 3, 1, "gpt-4o", 90, 60, now - 40 * h],
  ];
  for (const l of logs) {
    await insLog.bind(...l).run();
  }

  // ---- 对齐原版管理模型的新表种子数据 ----
  const d = 24 * h;
  const ins = (sql, vals) => db.prepare(sql).bind(...vals).run();

  // 用户（对应原版 User/用户管理）
  await ins("INSERT INTO users (username,email,role,status,balance_tokens,concurrency,rpm_limit,notes,last_active_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ["admin", "admin@sub2api.dev", "admin", "active", -1, 10, 0, "超级管理员", now - d, now - 60 * d]);
  await ins("INSERT INTO users (username,email,role,status,balance_tokens,concurrency,rpm_limit,notes,last_active_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ["alice", "alice@example.com", "user", "active", 500000, 3, 60, "核心用户", now - 2 * h, now - 30 * d]);
  await ins("INSERT INTO users (username,email,role,status,balance_tokens,concurrency,rpm_limit,notes,last_active_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ["bob", "bob@example.com", "user", "disabled", 1000, 3, 0, "欠费停用", now - 10 * d, now - 15 * d]);

  // 分组
  await ins("INSERT INTO groups (name,description,platform,rate_multiplier,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)", ["通用组", "默认分组，全部平台可用", "", 1.0, "active", 0, now]);
  await ins("INSERT INTO groups (name,description,platform,rate_multiplier,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)", ["OpenAI 专属", "只走 openai 账号", "openai", 1.0, "active", 1, now]);

  // 套餐
  await ins("INSERT INTO packages (name,tokens,duration_days,price_note,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)", ["入门版", 100000, 30, "¥19.9 / 月", "active", 0, now]);
  await ins("INSERT INTO packages (name,tokens,duration_days,price_note,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)", ["专业版", 1000000, 30, "¥99 / 月", "active", 1, now]);
  await ins("INSERT INTO packages (name,tokens,duration_days,price_note,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)", ["旗舰版", 10000000, 90, "¥299 / 季", "active", 2, now]);

  // 用户订阅（alice 两张，一张已过期）
  await ins("INSERT INTO user_subscriptions (user_id,package_id,tokens,starts_at,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?)", [2, 2, 1000000, now - 10 * d, now + 20 * d, "active", now - 10 * d]);
  await ins("INSERT INTO user_subscriptions (user_id,package_id,tokens,starts_at,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?)", [2, 1, 100000, now - 40 * d, now - 10 * d, "expired", now - 40 * d]);
  await ins("INSERT INTO user_subscriptions (user_id,package_id,tokens,starts_at,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?)", [1, 3, 10000000, now - 5 * d, null, "active", now - 5 * d]);

  // 兑换码
  await ins("INSERT INTO promo_codes (code,bonus_tokens,max_uses,used_count,status,expires_at,notes,created_at) VALUES (?,?,?,?,?,?,?,?)", ["WELCOME2026", 50000, 10, 2, "active", now + 30 * d, "新人礼包", now]);
  await ins("INSERT INTO promo_codes (code,bonus_tokens,max_uses,used_count,status,expires_at,notes,created_at) VALUES (?,?,?,?,?,?,?,?)", ["VIP-ONLY", 500000, 1, 1, "disabled", null, "已停用", now - 5 * d]);
  await ins("INSERT INTO promo_usage (promo_code_id,user_id,bonus_tokens,used_at) VALUES (?,?,?,?)", [1, 2, 50000, now - 3 * d]);
  await ins("INSERT INTO promo_usage (promo_code_id,user_id,bonus_tokens,used_at) VALUES (?,?,?,?)", [1, 3, 50000, now - 2 * d]);

  // 公告
  await ins("INSERT INTO announcements (title,content,status,created_at) VALUES (?,?,?,?)", ["系统升级通知", "今晚 24:00-02:00 进行维护，期间暂停服务", "active", now - 1 * d]);
  await ins("INSERT INTO announcements (title,content,status,created_at) VALUES (?,?,?,?)", ["新增 Grok 通道", "已接入 xAI Grok 3 系列模型，欢迎体验", "active", now - 3 * d]);

  // 审计日志
  await ins("INSERT INTO audit_logs (actor,action,target_type,target_id,detail,created_at) VALUES (?,?,?,?,?,?)", ["admin", "create", "user", 2, "创建用户 alice", now - 10 * d]);
  await ins("INSERT INTO audit_logs (actor,action,target_type,target_id,detail,created_at) VALUES (?,?,?,?,?,?)", ["admin", "create", "account", 1, "添加上游账号 acc-openai-01", now - 9 * d]);
  await ins("INSERT INTO audit_logs (actor,action,target_type,target_id,detail,created_at) VALUES (?,?,?,?,?,?)", ["admin", "redeem", "promo", 1, "兑换码 WELCOME2026 被 alice 使用", now - 3 * d]);

  // 站点设置
  await ins("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)", ["site_name", "Sub2API-CF", now]);
  await ins("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)", ["announcement_enabled", "true", now]);
  await ins("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)", ["default_rpm_limit", "0", now]);

  // 渠道监控字段（给 1 个账号模拟检查结果；与生产 monitorChannels 写入的 ok/fail 字符串一致）
  await ins("UPDATE accounts_v2 SET last_checked_at=?, last_check_result=? WHERE id=1", [now - 30 * 60 * 1000, "ok"]);
  await ins("UPDATE accounts_v2 SET last_checked_at=?, last_check_result=? WHERE id=2", [now - 2 * h, "fail"]);

  // 让已有 Key 归属到用户/分组，展示归属信息
  await ins("UPDATE user_keys SET user_id=2, group_id=1 WHERE id=1", []);
  await ins("UPDATE user_keys SET user_id=2, group_id=2 WHERE id=2", []);
  await ins("UPDATE user_keys SET user_id=3, group_id=1, status='disabled' WHERE id=3", []);

  // 模型限流规则（全局 / 用户级 / Key 级，精确模型 / 通配）
  await ins("INSERT INTO model_limits (user_id,key_id,model,rpm_limit,concurrency,enabled,created_at) VALUES (?,?,?,?,?,?,?)", [null, null, "gpt-4o", 60, 5, 1, now]);
  await ins("INSERT INTO model_limits (user_id,key_id,model,rpm_limit,concurrency,enabled,created_at) VALUES (?,?,?,?,?,?,?)", [2, null, "claude-sonnet-4-5", 10, 1, 1, now]);
  await ins("INSERT INTO model_limits (user_id,key_id,model,rpm_limit,concurrency,enabled,created_at) VALUES (?,?,?,?,?,?,?)", [null, 1, "*", 120, 0, 1, now]);

  console.log("seeded: 4 accounts, 3 keys, 9 usage rows, 3 users, 2 groups, 3 packages, 3 subs, 2 promos, 2 announcements, 3 audit rows, 3 model limits");
}

// ---------- HTTP 服务器：所有请求转发给真实 worker ----------
const env = { DB: db, ADMIN_TOKEN };
const ctx = {
  waitUntil(p) {
    return p;
  },
};

function readReq(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://" + HOST + ":" + PORT);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v != null) headers[k] = String(v);
    }
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await readReq(req);
    }
    const r = await worker.fetch(new Request(url, { method: req.method, headers, body }), env, ctx);
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    if (r.body && r.body.getReader) {
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    console.error("ERR:", e && e.stack ? e.stack : e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log("Sub2API-CF dev server -> http://" + HOST + ":" + PORT + "/admin?token=" + ADMIN_TOKEN);
});
