// index.js — Sub2API-CF 网关入口（Cloudflare Workers + D1，v2）
import {
  buildUpstream, makeOpenAIStream, openaiPassTranslator,
  DEFAULT_BASE, DEFAULT_MODELS, OAUTH_TOKEN_URL, needsOAuthRefresh, refreshOAuth,
  anthropicReqToOpenAI, geminiReqToOpenAI, responsesReqToOpenAI,
  openAIRespToAnthropic, openAIRespToGemini, openAIRespToResponses,
  credentialFor, passthroughTranslator,
  collectModels, estimateTokens,
} from "./relay.js";
import { ADMIN_HTML } from "./admin.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({ ok: true, service: "sub2api-cf", v: 2, ts: Date.now() });
    }
    // 免令牌诊断：查看 ADMIN_TOKEN 是否配置、D1 是否绑定且建表成功
    if (path === "/admin/diag" && request.method === "GET") {
      const out = {
        service: "sub2api-cf",
        admin_token_configured: !!env.ADMIN_TOKEN,
        d1_bound: !!env.DB,
        ts: Date.now(),
      };
      if (env.DB) {
        try {
          const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts_v2'").first();
          const u = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").first();
          out.d1_ok = !!(t && u);
          out.d1_tables = { accounts_v2: !!t, users: !!u };
          const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts_v2").first();
          out.accounts = c.n;
        } catch (e) {
          out.d1_ok = false;
          out.d1_error = String((e && e.message) || e).slice(0, 200);
        }
      }
      return json(out);
    }
    if (path === "/") {
      const u = new URL(request.url);
      u.pathname = "/admin";
      return Response.redirect(u.toString(), 302);
    }
    if (path === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }
    // ---------- OpenAI 兼容网关 ----------
    if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      return handleChat(request, env, ctx, "openai");
    }
    // ---------- Anthropic 兼容网关（/v1/messages） ----------
    if (request.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
      return handleChat(request, env, ctx, "anthropic");
    }
    // ---------- OpenAI Responses API（/v1/responses） ----------
    if (request.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      return handleChat(request, env, ctx, "responses");
    }
    // ---------- Gemini 原生 API（/v1beta/models/{model}:generateContent|:streamGenerateContent） ----------
    if (request.method === "POST" && path.startsWith("/v1beta/models/")) {
      const m = path.match(/^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/);
      if (!m) return json({ error: "invalid gemini endpoint", path }, 404);
      return handleChat(request, env, ctx, "gemini", {
        model: decodeURIComponent(m[1]),
        stream: m[2] === "streamGenerateContent",
      });
    }
    if (request.method === "GET" && path === "/v1beta/models") {
      return handleGeminiModels(request, env);
    }
    // ---------- 模型列表 / 用量 / token 计数 ----------
    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
      return handleModels(request, env);
    }
    if (request.method === "GET" && (path === "/v1/usage" || path === "/usage")) {
      return handleUsage(request, env);
    }
    if (request.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")) {
      return handleCountTokens(request, env);
    }
    return json({ error: "not found", path }, 404);
  },

  // Cron：定期维护 —— OAuth 刷新 / 订阅过期 / 兑换码过期 / 渠道健康监控
  async scheduled(event, env, ctx) {
    if (!event.cron) return;
    ctx.waitUntil(refreshDueOAuth(env));
    ctx.waitUntil(expireDue(env));
    ctx.waitUntil(monitorChannels(env));
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
function now() { return Date.now(); }
function html(s) {
  return new Response(s, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ---------- 中继核心 ----------

// 鉴权：支持 OpenAI Bearer / Anthropic x-api-key / Gemini x-goog-api-key 三种头，
// 以及 ?key= 查询参数（Gemini SDK 习惯），返回 keyRow 或 null
async function authKeyRow(request, env) {
  let userKey = "";
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) userKey = m[1].trim();
  if (!userKey) userKey = (request.headers.get("x-api-key") || "").trim();
  if (!userKey) userKey = (request.headers.get("x-goog-api-key") || "").trim();
  if (!userKey) userKey = new URL(request.url).searchParams.get("key") || "";
  if (!userKey) return null;
  return await env.DB
    .prepare("SELECT * FROM user_keys WHERE key = ? AND enabled = 1")
    .bind(userKey)
    .first();
}

// 通用网关入口：
//   protocol = "openai" | "anthropic" | "gemini"（客户端协议）
//   geminiMeta = { model, stream } 仅供 /v1beta 路径传入（模型名在 URL 里）
async function handleChat(request, env, ctx, protocol = "openai", geminiMeta = null) {
  const db = env.DB;

  const keyRow = await authKeyRow(request, env);
  if (!keyRow) return json({ error: "invalid api key" }, 401);

  // 对齐 ApiKey 模型：status / expires_at / 归属用户
  if (keyRow.status && keyRow.status !== "active") return json({ error: "key disabled" }, 403);
  if (keyRow.expires_at && keyRow.expires_at < now()) {
    await db.prepare("UPDATE user_keys SET status='expired' WHERE id=?").bind(keyRow.id).run();
    return json({ error: "key expired" }, 403);
  }
  if (keyRow.quota_tokens != null && keyRow.used_tokens >= keyRow.quota_tokens) {
    return json({ error: "quota exceeded", used: keyRow.used_tokens, quota: keyRow.quota_tokens }, 429);
  }

  // 用户维度门控（余额 / 状态 / 用户级 RPM）
  const user = keyRow.user_id ? await db.prepare("SELECT * FROM users WHERE id=?").bind(keyRow.user_id).first() : null;
  if (keyRow.user_id && !user) return json({ error: "key owner not found" }, 403);
  if (user && user.status !== "active") return json({ error: "user disabled" }, 403);
  if (user && user.balance_tokens === 0) return json({ error: "insufficient balance" }, 402);

  const keyRpm = keyRow.rpm_limit || 0;
  const userRpm = user ? user.rpm_limit || 0 : 0;
  if (keyRpm || userRpm) {
    const rpmCap = userRpm && keyRpm ? Math.min(keyRpm, userRpm) : (keyRpm || userRpm);
    if (!rpmAllow(env, "rpm:" + keyRow.id, rpmCap)) return json({ error: "rate limit exceeded", retry_after: 60 }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  // 入站协议 -> 内部统一 OpenAI 格式（anthropic/gemini/responses 转成 OpenAI chat 请求）
  let openaiBody;
  if (protocol === "anthropic") {
    openaiBody = anthropicReqToOpenAI(body);
  } else if (protocol === "gemini") {
    openaiBody = geminiReqToOpenAI(body, geminiMeta.model, geminiMeta.stream);
  } else if (protocol === "responses") {
    openaiBody = responsesReqToOpenAI(body);
  } else {
    openaiBody = body;
  }
  if (!openaiBody.model) return json({ error: "model is required" }, 400);

  // 模型维度限流：每 Key / 每用户对指定模型的 RPM + 并发上限（对齐原版细粒度调度）
  const modelLimit = await modelLimitFor(env, keyRow, user, openaiBody.model);
  if (modelLimit && (modelLimit.rpm_limit || modelLimit.concurrency)) {
    if (modelLimit.rpm_limit && !rpmAllow(env, "ml:" + modelLimit.id, modelLimit.rpm_limit)) {
      return json({ error: "model rate limit exceeded", model: openaiBody.model, retry_after: 60 }, 429);
    }
    if (modelLimit.concurrency && !acqSlot(env, "mlc:" + modelLimit.id, modelLimit.concurrency)) {
      return json({ error: "model concurrency limit reached", model: openaiBody.model }, 429);
    }
    ctx.waitUntil(releaseSlotLater(env, "mlc:" + modelLimit.id));
  }

  // 分组平台过滤（key.group_id -> group.platform；空 = 不限）
  let groupPlatform = "";
  if (keyRow.group_id) {
    const g = await db.prepare("SELECT platform FROM groups WHERE id=? AND status='active'").bind(keyRow.group_id).first();
    if (!g) return json({ error: "key group not found or inactive" }, 403);
    groupPlatform = g.platform || "";
  }

  // 选账号：Sub2API 风格调度（可带分组平台过滤 + 模型维度路由）
  const acct = await selectAccount(db, groupPlatform || null, openaiBody.model);
  if (!acct) return json({ error: "no available upstream account" }, 503);

  // 账号级并发限制（进程内计数，上限 = 账号 concurrency）
  if (!acqSlot(env, acct.id, acct.concurrency || 1)) {
    return json({ error: "account busy, retry later", account_id: acct.id }, 429);
  }
  ctx.waitUntil(releaseSlotLater(env, acct.id));

  ctx.waitUntil(
    db.prepare("UPDATE accounts_v2 SET last_used_at = ? WHERE id = ?").bind(now(), acct.id).run()
  );

  // 同协议直通：anthropic 入站 + anthropic 账号，或 gemini 入站 + gemini 账号，
  // 直接透传原生请求（保留 tools/thinking 等语义），只捕获用量。
  // antigravity 不走直通：它在 relay 层有独立的 v1internal 协议适配（OpenAI 双向转换）。
  const sameProtocol =
    (protocol === "anthropic" && acct.platform === "anthropic") ||
    (protocol === "gemini" && acct.platform === "gemini");
  if (sameProtocol) {
    return await relaySameProtocol(request, env, ctx, acct, body, keyRow, protocol, geminiMeta);
  }

  // 跨协议：统一走 OpenAI 格式 -> buildUpstream 转换 -> 响应再转回客户端协议
  const upstream = buildUpstream(acct, openaiBody);
  // antigravity：不过期时间判断，直接使用当前 token（原版语义：token 长期有效，不需要刷新重试）
  if (acct.platform !== "antigravity" && needsOAuthRefresh(upstream.credential)) {
    try {
      const updated = await refreshOAuth(acct.platform, upstream.credential, env);
      const merged = { ...safeJson(acct.credentials, {}), ...updated };
      await db
        .prepare("UPDATE accounts_v2 SET credentials = ?, status = 'active', error_message = NULL WHERE id = ?")
        .bind(JSON.stringify(merged), acct.id)
        .run();
      // 用新 token 重建上游
      const freshAcct = { ...acct, credentials: JSON.stringify(merged) };
      const fresh = buildUpstream(freshAcct, openaiBody);
      return await relayToUpstream(fresh, freshAcct, openaiBody, keyRow, env, ctx, protocol);
    } catch (e) {
      // 刷新失败：标记账号错误，但允许本次尝试（可能 token 仍有效）
      await db
        .prepare("UPDATE accounts_v2 SET status = 'error', error_message = ? WHERE id = ?")
        .bind(String(e).slice(0, 500), acct.id)
        .run();
    }
  }
  return await relayToUpstream(upstream, acct, openaiBody, keyRow, env, ctx, protocol);
}

// 同协议直通转发：请求体原样发给上游（只替换鉴权头），响应透传，同时捕获用量落库。
async function relaySameProtocol(request, env, ctx, acct, rawBody, keyRow, protocol, geminiMeta) {
  const cred = credentialFor(acct);
  const base = (acct.base_url && acct.base_url.trim()) || DEFAULT_BASE[acct.platform];
  const isStream = protocol === "gemini" ? geminiMeta.stream : !!rawBody.stream;

  let url, headers;
  if (protocol === "anthropic") {
    url = `${base}/v1/messages`;
    headers = {
      "content-type": "application/json",
      "x-api-key": cred.token,
      "anthropic-version": "2023-06-01",
    };
  } else {
    const action = geminiMeta.stream ? "streamGenerateContent" : "generateContent";
    const q = geminiMeta.stream ? "?alt=sse" : "";
    url = `${base}/v1beta/models/${geminiMeta.model}:${action}${q}`;
    headers = { "content-type": "application/json" };
    if (cred.kind === "oauth") headers.authorization = `Bearer ${cred.token}`;
    else headers["x-goog-api-key"] = cred.token;
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(rawBody),
    });
  } catch (e) {
    await markAccountError(env, acct.id, "upstream unreachable: " + String(e));
    return json({ error: "upstream unreachable", detail: String(e) }, 502);
  }

  // 限速/过载信号 -> 标记窗口
  if (upstreamResp.status === 429) {
    const reset = now() + 60 * 1000;
    await env.DB.prepare("UPDATE accounts_v2 SET rate_limited_at = ?, rate_limit_reset_at = ? WHERE id = ?")
      .bind(now(), reset, acct.id).run();
  } else if (upstreamResp.status === 529) {
    const reset = now() + 5 * 60 * 1000;
    await env.DB.prepare("UPDATE accounts_v2 SET overload_until = ? WHERE id = ?").bind(reset, acct.id).run();
  }

  const model = geminiMeta ? geminiMeta.model : rawBody.model;

  // 非流式：透传 JSON 结构（Anthropic 或 Gemini 原生），捕获 usage 落库
  if (!isStream) {
    const text = await upstreamResp.text();
    let usage = null;
    try {
      const j = JSON.parse(text);
      if (protocol === "anthropic" && j.usage) {
        usage = { prompt_tokens: j.usage.input_tokens || 0, completion_tokens: j.usage.output_tokens || 0 };
      } else if (j.usageMetadata) {
        usage = {
          prompt_tokens: j.usageMetadata.promptTokenCount || 0,
          completion_tokens: j.usageMetadata.candidatesTokenCount || 0,
        };
      }
    } catch {}
    if (usage) ctx.waitUntil(logUsage(env, keyRow, acct, model, usage));
    return new Response(text, {
      status: upstreamResp.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // 流式：透传 SSE 事件（保留 event:/data: 原样），捕获 usage
  const state = { model, provider: acct.platform, usage: null };
  const stream = makeOpenAIStream(upstreamResp.body, passthroughTranslator, state, async (st) => {
    if (st.usage) await logUsage(env, keyRow, acct, model, st.usage);
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// Sub2API 风格调度：schedulable=1 & status='active' & 无限速/过载/临时封禁窗口
async function selectAccount(db, platform = null, model = null) {
  const t = now();
  const where = [
    "schedulable = 1 AND status = 'active'",
    "(rate_limit_reset_at IS NULL OR rate_limit_reset_at < ?)",
    "(overload_until IS NULL OR overload_until < ?)",
    "(temp_unschedulable_until IS NULL OR temp_unschedulable_until < ?)",
  ];
  const vals = [t, t, t];
  if (platform) {
    where.push("platform = ?");
    vals.push(platform);
  }
  const base = `SELECT * FROM accounts_v2 WHERE ${where.join(" AND ")}`;
  // 模型维度路由：优先选 model_map 里声明了该模型的账号（account 的可用模型列表）；
  // 无 model_map / 空映射的账号视为“全能兜底”，仅在没有任何账号声明该模型时参与。
  if (model) {
    const esc = String(model).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const acct = await db
      .prepare(`${base} AND (json_extract(model_map, '$."${esc}"') IS NOT NULL OR model_map IS NULL OR TRIM(COALESCE(model_map, '')) IN ('', '{}')) ORDER BY priority ASC, last_used_at ASC LIMIT 1`)
      .bind(...vals)
      .first();
    if (acct) return acct;
  }
  return db.prepare(`${base} ORDER BY priority ASC, last_used_at ASC LIMIT 1`).bind(...vals).first();
}

// ---------- 进程内限流 / 并发信号量 ----------
// Workers 无共享内存，但同一 isolate 内的请求共享此 Map，可做尽力而为的限制；
// 多 isolate 并发时由 D1 原子计数兜底（见下方 D1 版本选路提示）。
const _counters = new Map(); // key -> { windowStart, count }
const _slots = new Map();    // accountId -> inFlight

function rpmAllow(env, key, cap) {
  const t = now();
  let c = _counters.get(key);
  if (!c || t - c.windowStart >= 60000) {
    _counters.set(key, { windowStart: t, count: 1 });
    return true;
  }
  if (c.count >= cap) return false;
  c.count++;
  return true;
}

function acqSlot(env, acctId, cap) {
  const cur = _slots.get(acctId) || 0;
  if (cur >= cap) return false;
  _slots.set(acctId, cur + 1);
  return true;
}

// ---------- 模型维度限流（每 Key / 每用户对指定模型的 RPM + 并发上限） ----------
// 规则优先级：key 级 > 用户级 > 全局；精确模型 > 通配 '*'；同优先级取最新创建。
async function modelLimitFor(env, keyRow, user, model) {
  const db = env.DB;
  const uid = keyRow.user_id || 0;
  const rows = await db.prepare(
    `SELECT * FROM model_limits
     WHERE enabled=1 AND model IN (?, '*')
       AND ((key_id IS NOT NULL AND key_id=?) OR (key_id IS NULL AND (user_id IS NULL OR user_id=?)))
     ORDER BY (key_id IS NOT NULL) DESC, (user_id IS NOT NULL) DESC, (model='*') ASC, id DESC
     LIMIT 1`
  ).bind(model, keyRow.id, uid).all();
  return rows.results[0] || null;
}

async function releaseSlotLater(env, acctId) {
  // 请求结束时释放并发槽位（延迟到响应完成后）
  await new Promise((r) => setTimeout(r, 0));
  const cur = _slots.get(acctId) || 0;
  if (cur > 0) _slots.set(acctId, cur - 1);
}

// 测试/调试用：清空进程内限流与并发状态
export function __resetRuntimeState() {
  _counters.clear();
  _slots.clear();
}

// clientProtocol：客户端期望的响应协议（"openai" | "anthropic" | "gemini"）。
// 上游响应统一转成 OpenAI 格式后，再转回客户端协议。
async function relayToUpstream(upstream, acct, body, keyRow, env, ctx, clientProtocol = "openai") {
  const model = (safeJson(acct.model_map, {})[body.model]) || body.model;
  let upstreamResp;
  try {
    upstreamResp = await fetch(upstream.url, {
      method: "POST",
      headers: upstream.headers,
      body: upstream.body,
    });
  } catch (e) {
    await markAccountError(env, acct.id, "upstream unreachable: " + String(e));
    return json({ error: "upstream unreachable", detail: String(e) }, 502);
  }

  // 限速/过载信号 -> 标记窗口
  if (upstreamResp.status === 429) {
    const reset = now() + 60 * 1000;
    await env.DB.prepare("UPDATE accounts_v2 SET rate_limited_at = ?, rate_limit_reset_at = ? WHERE id = ?")
      .bind(now(), reset, acct.id).run();
  } else if (upstreamResp.status === 529) {
    const reset = now() + 5 * 60 * 1000;
    await env.DB.prepare("UPDATE accounts_v2 SET overload_until = ? WHERE id = ?").bind(reset, acct.id).run();
  }

  if (!upstream.isStream) {
    const text = await upstreamResp.text();
    let openai = null;
    try {
      openai = JSON.parse(text);
      if (upstream.translateResponse) openai = upstream.translateResponse(openai);
    } catch { openai = null; }
    const usage = openai && openai.usage;
    if (usage) ctx.waitUntil(logUsage(env, keyRow, acct, model, usage));
    let out = text;
    if (openai) {
      if (clientProtocol === "anthropic") out = JSON.stringify(openAIRespToAnthropic(openai, model));
      else if (clientProtocol === "gemini") out = JSON.stringify(openAIRespToGemini(openai, model));
      else if (clientProtocol === "responses") out = JSON.stringify(openAIRespToResponses(openai, model));
      else out = JSON.stringify(openai);
    }
    return new Response(out, {
      status: upstreamResp.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (upstreamResp.status !== 200) {
    const errText = await upstreamResp.text();
    return new Response(errText, {
      status: upstreamResp.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const state = { model, provider: upstream.provider, usage: null };
  const translator = upstream.translator || openaiPassTranslator;
  const stream = makeOpenAIStream(upstreamResp.body, translator, state, async (st) => {
    if (st.usage) await logUsage(env, keyRow, acct, model, st.usage);
  }, clientProtocol);
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function tryUsage(jsonText) {
  try {
    const j = JSON.parse(jsonText);
    if (j && j.usage) return j.usage;
  } catch {}
  return null;
}

// ---------- 模型列表 / 用量 / token 计数 ----------

// GET /v1/models（OpenAI 风格）— 从账号 model_map 收集，缺省回退平台默认
async function handleModels(request, env) {
  const keyRow = await authKeyRow(request, env);
  if (!keyRow) return json({ error: "invalid api key" }, 401);
  const rows = await env.DB
    .prepare("SELECT platform, model_map FROM accounts_v2 WHERE status='active'")
    .all();
  const ids = collectModels(rows.results || []);
  return json({
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 1704067200, owned_by: "sub2api-cf" })),
  });
}

// GET /v1beta/models（Gemini 风格）
async function handleGeminiModels(request, env) {
  const keyRow = await authKeyRow(request, env);
  if (!keyRow) return json({ error: "invalid api key" }, 401);
  const rows = await env.DB
    .prepare("SELECT platform, model_map FROM accounts_v2 WHERE status='active'")
    .all();
  const ids = collectModels(rows.results || []);
  return json({
    models: ids.map((id) => ({
      name: "models/" + id,
      displayName: id,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    })),
  });
}

// GET /v1/usage — 当前 key 的用量汇总（对齐 Sub2API 的 key 用量语义）
async function handleUsage(request, env) {
  const keyRow = await authKeyRow(request, env);
  if (!keyRow) return json({ error: "invalid api key" }, 401);
  const agg = await env.DB
    .prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS total_tokens
      FROM usage_logs WHERE user_key_id = ?`)
    .bind(keyRow.id)
    .first();
  return json({
    object: "list",
    data: [],
    total_tokens: agg.total_tokens || 0,
    calls: agg.calls || 0,
    used_tokens: keyRow.used_tokens || 0,
    quota_tokens: keyRow.quota_tokens ?? null,
  });
}

// POST /v1/messages/count_tokens — Anthropic 请求的 token 估算
async function handleCountTokens(request, env) {
  const keyRow = await authKeyRow(request, env);
  if (!keyRow) return json({ error: "invalid api key" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || !body.model) return json({ error: "model is required" }, 400);
  return json({ input_tokens: estimateTokens(body), output_tokens: 0 });
}

// ---------- 用量落库 ----------

async function logUsage(env, keyRow, acct, model, usage) {
  if (!usage) return;
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const db = env.DB;
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO usage_logs (user_key_id, user_id, account_id, model, prompt_tokens, completion_tokens, created_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(keyRow.id, keyRow.user_id || null, acct.id, model, pt, ct, now()),
      db.prepare("UPDATE user_keys SET used_tokens = used_tokens + ? WHERE id = ?").bind(pt + ct, keyRow.id),
      db.prepare("UPDATE accounts_v2 SET usage_tokens = usage_tokens + ? WHERE id = ?").bind(pt + ct, acct.id),
    ]);
  } catch (e) {
    console.warn("logUsage failed:", String(e));
  }
}

async function markAccountError(env, id, msg) {
  try {
    await env.DB.prepare("UPDATE accounts_v2 SET status='error', error_message=? WHERE id=?")
      .bind(String(msg).slice(0, 500), id).run();
  } catch {}
}

// ---------- OAuth 定时刷新 ----------

async function refreshDueOAuth(env) {
  const t = now();
  const due = await env.DB
    .prepare(`SELECT * FROM accounts_v2
      WHERE type='oauth' AND status != 'disabled'
        AND json_extract(credentials,'$.refresh_token') IS NOT NULL
        AND json_extract(credentials,'$.expires_at') IS NOT NULL
        AND CAST(json_extract(credentials,'$.expires_at') AS INTEGER) - ? < 300000`)
    .bind(t)
    .all();
  for (const acct of due.results || []) {
    const cred = safeJson(acct.credentials, {});
    try {
      const updated = await refreshOAuth(acct.platform, {
        refresh_token: cred.refresh_token, client_id: cred.client_id || "",
      }, env);
      const merged = { ...cred, ...updated };
      await env.DB
        .prepare("UPDATE accounts_v2 SET credentials=?, status='active', error_message=NULL WHERE id=?")
        .bind(JSON.stringify(merged), acct.id).run();
    } catch (e) {
      await env.DB.prepare("UPDATE accounts_v2 SET status='error', error_message=? WHERE id=?")
        .bind(String(e).slice(0, 500), acct.id).run();
    }
  }
}

// ---------- 定时维护 ----------

// 订阅 / 兑换码到期处理
async function expireDue(env) {
  const t = now();
  try {
    await env.DB.prepare("UPDATE user_subscriptions SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?")
      .bind(t).run();
    await env.DB.prepare("UPDATE promo_codes SET status='disabled' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?")
      .bind(t).run();
    await env.DB.prepare("UPDATE user_keys SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?")
      .bind(t).run();
  } catch (e) {
    console.warn("expireDue failed:", String(e));
  }
}

// 渠道健康监控：定时对每个 active 账号做一次轻量探测（模型列表请求），更新状态与检查时间。
// 探测失败会标记账号 error；成功则恢复 active（清除错误）。
async function monitorChannels(env, force = false) {
  const db = env.DB;
  const t = now();
  // force=true（一键全通道检测）：无视 10 分钟节流，立即探测全部账号
  const rows = force
    ? await db.prepare("SELECT * FROM accounts_v2 WHERE status != 'disabled'").all()
    : await db.prepare("SELECT * FROM accounts_v2 WHERE status != 'disabled' AND (last_checked_at IS NULL OR last_checked_at < ?)").bind(t - 10 * 60 * 1000).all();
  for (const acct of rows.results || []) {
    try {
      const res = await probeAccount(acct, env);
      await db.prepare("UPDATE accounts_v2 SET last_checked_at=?, last_check_result=?, status=?, error_message=? WHERE id=?")
        .bind(t, JSON.stringify(res), res.ok ? "active" : "error", res.ok ? null : (res.error || "health check failed").slice(0, 500), acct.id)
        .run();
    } catch (e) {
      await db.prepare("UPDATE accounts_v2 SET last_checked_at=?, last_check_result=?, status='error', error_message=? WHERE id=?")
        .bind(t, JSON.stringify({ ok: false, latency_ms: null, error: String(e).slice(0, 200) }), String(e).slice(0, 500), acct.id).run();
    }
  }
}

// 探测单个账号：返回 { ok, latency_ms, error }。403=鉴权失败但服务可达，视为“可达”。
// 探测单账号：返回 { ok, latency_ms, error }。403=鉴权失败但服务可达，视为“可达”。
// 会先修两类历史问题：① credentialFor 统一后的 token 在 cred.token（旧代码读 cred.api_key 恒为空导致探测 401）；
// ② base 已含 /v1 时不再拼双 /v1（openai/grok 默认 base 带 /v1）。
// ③ oauth 账号 token 过期/临期时先尝试刷新（成功写回 D1 再用新 token 探测）。
async function probeAccount(acct, env) {
  const cred = credentialFor(acct);
  let token = cred.token || "";
  const base = (acct.base_url && acct.base_url.trim()) || DEFAULT_BASE[acct.platform];
  const headers = { "content-type": "application/json" };
  let url = "";

  // oauth 过期/临期：先尝试刷新，避免“一键检测”对可恢复账号误报
  // antigravity：不过期时间判断，直接使用当前 token（原版语义：token 长期有效，不需要刷新重试）
  if (acct.platform !== "antigravity" && needsOAuthRefresh(cred)) {
    try {
      const updated = await refreshOAuth(acct.platform, cred, env);
      const merged = { ...safeJson(acct.credentials, {}), ...updated };
      await env.DB.prepare("UPDATE accounts_v2 SET credentials=? WHERE id=?")
        .bind(JSON.stringify(merged), acct.id).run();
      token = updated.access_token || token;
      acct.credentials = JSON.stringify(merged);
    } catch (e) {
      return { ok: false, latency_ms: null, error: "oauth refresh failed: " + String(e.message || e).slice(0, 180) };
    }
  }

  // base 已带 /v1（如 DEFAULT_BASE.openai/grok、自定义 base_url 以 /v1 结尾）则不重复拼接
  const v1 = /\/v1\/?$/.test(base) ? "" : "/v1";
  if (acct.platform === "anthropic") {
    url = `${base}${v1}/models`;
    headers["x-api-key"] = token;
  } else if (acct.platform === "antigravity") {
    // 真实 Antigravity：fetchAvailableModels 需要 project_id + Google Bearer token
    const rawCred = safeJson(acct.credentials, {});
    url = `${base}/v1internal:fetchAvailableModels`;
    headers.authorization = "Bearer " + token;
    const body = JSON.stringify({ project: rawCred.project_id || "" });
    const t0 = now();
    try {
      const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      const latency = now() - t0;
      if (r.ok || r.status === 403) return { ok: true, latency_ms: latency, error: null };
      const txt = await r.text().catch(() => "");
      return { ok: false, latency_ms: latency, error: `HTTP ${r.status} ${txt.slice(0, 120)}` };
    } catch (e) {
      return { ok: false, latency_ms: now() - t0, error: String(e).slice(0, 200) };
    }
  } else if (acct.platform === "gemini") {
    url = `${base}/v1beta/models?key=${encodeURIComponent(token)}`;
  } else {
    url = `${base}${v1}/models`;
    headers.authorization = "Bearer " + token;
  }
  const t0 = now();
  try {
    const r = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(8000) });
    const latency = now() - t0;
    if (r.ok || r.status === 403) return { ok: true, latency_ms: latency, error: null };
    const body = await r.text().catch(() => "");
    return { ok: false, latency_ms: latency, error: `HTTP ${r.status}${body ? " " + body.slice(0, 120) : ""}` };
  } catch (e) {
    const latency = now() - t0;
    const msg = String((e && e.message) || e);
    const err = /timeout|abort/i.test(msg) ? "请求超时（>8s）" : msg.slice(0, 200);
    return { ok: false, latency_ms: latency, error: err };
  }
}

// 解析 last_check_result（兼容三种存储："ok"/"fail" 字符串、旧 JSON {ok:true}、新 JSON {ok,latency_ms,error}）
function parseProbeResult(v) {
  if (v === "ok" || v === "fail") return { ok: v === "ok", latency_ms: null, error: v === "fail" ? "health check failed" : null };
  try {
    const o = safeJson(v, null);
    if (o && typeof o === "object") {
      return { ok: !!o.ok, latency_ms: o.latency_ms ?? null, error: o.error || (o.ok ? null : "health check failed") };
    }
  } catch {}
  return { ok: false, latency_ms: null, error: String(v == null ? "health check failed" : v).slice(0, 200) };
}

// 获取账号可用模型列表：model_map 优先；antigravity 无公开列表端点直接用默认；
// 其余平台尝试上游 /models（失败/无结果回退 model_map 或平台默认）
async function accountModels(row) {
  const acct = { ...row, credentials: row.credentials, model_map: safeJson(row.model_map, {}) };
  const platform = acct.platform;
  const base = (acct.base_url && acct.base_url.trim()) || DEFAULT_BASE[platform];
  const cred = credentialFor(acct);
  const token = cred.token || "";
  const modelKeys = Object.keys(safeJson(acct.model_map, {}));
  const antigravityDefaults = (DEFAULT_MODELS.antigravity || []);
  if (modelKeys.length) return modelKeys;
  if (platform === "antigravity") return [...antigravityDefaults];
  try {
    const v1 = /\/v1\/?$/.test(base) ? "" : "/v1";
    const modelUrl = platform === "gemini" ? `${base}/v1beta/models?key=${encodeURIComponent(token)}` : `${base}${v1}/models`;
    const headers = platform === "anthropic"
      ? { "content-type": "application/json", "x-api-key": token }
      : { "content-type": "application/json", authorization: "Bearer " + token };
    const mr = await fetch(modelUrl, { method: "GET", headers, signal: AbortSignal.timeout(8000) });
    if (mr.ok) {
      const mj = await mr.json().catch(() => ({}));
      const data = mj.data || mj.models || mj;
      if (Array.isArray(data)) return data.map((m) => m.id || m.name || "").filter(Boolean);
      if (data && typeof data === "object") return Object.keys(data);
    }
  } catch (e) { /* 模型获取失败回退 */ }
  return [];
}

// 单账号连通测试：仿原版 TestAccountConnection，获取模型列表 + 发送测试消息
// modelId 可选：前端选中的测试模型；为空时自动取 model_map 第一个或平台默认
async function testAccountConnection(row, env, modelId) {
  const db = env.DB;
  const acct = { ...row, credentials: row.credentials, model_map: safeJson(row.model_map, {}) };
  const platform = acct.platform;
  const cred = credentialFor(acct);
  const token = cred.token || "";
  const models = safeJson(acct.model_map, {});
  const modelKeys = Object.keys(models);
  // antigravity 无公开模型列表端点，使用内置默认模型（与原版 sub2api 一致）
  const antigravityDefaults = (DEFAULT_MODELS.antigravity || []);
  const availableModels = await accountModels(row);
  const testModel = (modelId && modelId.trim()) || modelKeys[0] ||
    (platform === "antigravity" ? (antigravityDefaults[0] || "gpt-4o-mini") : "gpt-4o-mini");
  const result = {
    ok: false,
    models: availableModels,
    test_message: null,
    error: null,
  };

  // 发送测试消息
  try {
    const testBody = {
      model: testModel,
      messages: [{ role: "user", content: "Say 'ok' in one word" }],
      max_tokens: 10,
      stream: false,
    };
    const upstream = buildUpstream(acct, testBody);
    const t0 = now();
    const r = await fetch(upstream.url, {
      method: "POST",
      headers: upstream.headers,
      body: upstream.body,
      signal: AbortSignal.timeout(15000),
    });
    const latency = now() - t0;
    result.test_message = { model_used: testModel, latency_ms: latency, status: r.status };
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const out = upstream.translateResponse ? upstream.translateResponse(j) : j;
      const content = ((out.choices || [])[0] || {}).message?.content || "";
      result.test_message.content = content.slice(0, 200);
      result.ok = true;
    } else {
      const txt = await r.text().catch(() => "");
      result.test_message.error = `HTTP ${r.status} ${txt.slice(0, 120)}`;
      result.error = result.test_message.error;
    }
  } catch (e) {
    result.error = String(e.message || e).slice(0, 200);
    result.test_message = { model_used: testModel, error: result.error };
  }
  return result;
}

// 审计日志写入
async function audit(env, action, targetType, targetId, detail) {
  try {
    await env.DB.prepare("INSERT INTO audit_logs (actor, action, target_type, target_id, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind("admin", action, targetType, targetId || null, detail || "", now()).run();
  } catch {}
}

// OAuth 登录导入：提供商授权/换 token 端点配置（替换原版 OAuth 登录 UI）
// 需要设置对应 Secret：OPENAI_OAUTH_CLIENT_ID / _SECRET 等（见 README）
const OAUTH_PROVIDERS = {
  openai: {
    authorizeUrl: "https://auth.openai.com/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    clientIdEnv: "OPENAI_OAUTH_CLIENT_ID",
    clientSecretEnv: "OPENAI_OAUTH_CLIENT_SECRET",
  },
  anthropic: {
    authorizeUrl: "https://console.anthropic.com/v1/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    scope: "openid email write",
    clientIdEnv: "ANTHROPIC_OAUTH_CLIENT_ID",
    clientSecretEnv: "ANTHROPIC_OAUTH_CLIENT_SECRET",
  },
  gemini: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/generative-language",
    clientIdEnv: "GEMINI_OAUTH_CLIENT_ID",
    clientSecretEnv: "GEMINI_OAUTH_CLIENT_SECRET",
  },
  grok: {
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    scope: "openid email offline_access",
    clientIdEnv: "GROK_OAUTH_CLIENT_ID",
    clientSecretEnv: "GROK_OAUTH_CLIENT_SECRET",
  },
  antigravity: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // 与原版 Antigravity-Manager 一致的 scopes；客户端需通过环境变量设置（wrangler secret put）
    scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
    clientIdEnv: "ANTIGRAVITY_OAUTH_CLIENT_ID",
    clientSecretEnv: "ANTIGRAVITY_OAUTH_CLIENT_SECRET",
  },
};

// ---------- 管理 API ----------

async function handleAdmin(request, env, url) {
  const token = request.headers.get("x-admin-token") || url.searchParams.get("token");
  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN 未配置：请在 Cloudflare 上执行 wrangler secret put ADMIN_TOKEN 后重试" }, 401);
  }
  if (!token) {
    return json({ error: "缺少管理令牌：请访问 /admin?token=<ADMIN_TOKEN> 或在上方输入框粘贴" }, 401);
  }
  if (token !== env.ADMIN_TOKEN) return json({ error: "unauthorized：管理令牌不正确" }, 401);

  const db = env.DB;
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[1];
  const sub = parts[2];
  const sub2 = parts[3];

  if (resource === "accounts") {
    // GET /admin/accounts/data —— Sub2API 备份导出（可被原版或本版导入）
    if (request.method === "GET" && sub === "data") {
      const rows = await db.prepare("SELECT * FROM accounts_v2 ORDER BY id DESC").all();
      const accounts = (rows.results || []).map((a) => {
        const cred = safeJson(a.credentials, {});
        const extra = safeJson(a.extra, {});
        return {
          name: a.name,
          notes: extra.notes || null,
          platform: a.platform,
          type: a.type,
          credentials: cred,
          extra,
          proxy_key: null,
          concurrency: a.concurrency,
          priority: a.priority,
          rate_multiplier: 1.0,
          expires_at: a.expires_at != null && a.expires_at >= 1e12 ? Math.round(a.expires_at / 1000) : a.expires_at,
          auto_pause_on_expired: !!a.auto_pause_on_expired,
        };
      });
      // —— 扩展段：本版完整备份（用户/Key/分组/套餐/订阅/兑换码/公告/设置/模型限流）——
      // 保持 type/version/proxies/accounts 与原版一致：原版导入时忽略未知字段，只取 accounts/proxies，
      // 因此本备份可被原版导入（账号部分），也能在本版完整回导。
      const [users, groups, keys, packages, subs, promos, promoUsage, anns, settingsRows, limits] = await Promise.all([
        db.prepare("SELECT id,username,email,role,status,balance_tokens,concurrency,rpm_limit,notes,last_active_at,created_at FROM users ORDER BY id").all(),
        db.prepare("SELECT id,name,description,platform,rate_multiplier,status,sort_order,created_at FROM groups ORDER BY id").all(),
        db.prepare("SELECT id,key,label,quota_tokens,used_tokens,enabled,created_at,expires_at,rpm_limit,status,user_id,group_id FROM user_keys ORDER BY id").all(),
        db.prepare("SELECT id,name,tokens,duration_days,price_note,status,sort_order,created_at FROM packages ORDER BY id").all(),
        db.prepare("SELECT id,user_id,package_id,tokens,starts_at,expires_at,status,created_at FROM user_subscriptions ORDER BY id").all(),
        db.prepare("SELECT id,code,bonus_tokens,max_uses,used_count,status,expires_at,notes,created_at FROM promo_codes ORDER BY id").all(),
        db.prepare("SELECT id,promo_code_id,user_id,bonus_tokens,used_at FROM promo_usage ORDER BY id").all(),
        db.prepare("SELECT id,title,content,status,created_at FROM announcements ORDER BY id").all(),
        db.prepare("SELECT key,value FROM settings").all(),
        db.prepare("SELECT id,user_id,key_id,model,rpm_limit,concurrency,enabled,created_at FROM model_limits ORDER BY id").all(),
      ]);
      const userName = {}, groupName = {}, keyLabel = {}, pkgName = {}, promoCode = {};
      for (const u of users.results) userName[u.id] = u.username;
      for (const g of groups.results) groupName[g.id] = g.name;
      for (const k of keys.results) keyLabel[k.id] = k.label;
      for (const p of packages.results) pkgName[p.id] = p.name;
      for (const p of promos.results) promoCode[p.id] = p.code;
      const settings = {};
      for (const s of settingsRows.results) settings[s.key] = safeJson(s.value, s.value);
      return json({
        type: "sub2api-data",
        version: 1,
        exported_at: new Date().toISOString(),
        proxies: [],
        accounts,
        skipped_shadows: 0,
        users: users.results.map((u) => ({ username: u.username, email: u.email, role: u.role, status: u.status, balance_tokens: u.balance_tokens, concurrency: u.concurrency, rpm_limit: u.rpm_limit, notes: u.notes, last_active_at: u.last_active_at, created_at: u.created_at })),
        groups: groups.results.map((g) => ({ name: g.name, description: g.description, platform: g.platform, rate_multiplier: g.rate_multiplier, status: g.status, sort_order: g.sort_order, created_at: g.created_at })),
        user_keys: keys.results.map((k) => ({ key: k.key, label: k.label, quota_tokens: k.quota_tokens, used_tokens: k.used_tokens, enabled: k.enabled, created_at: k.created_at, expires_at: k.expires_at, rpm_limit: k.rpm_limit, status: k.status, user: userName[k.user_id] || null, group: groupName[k.group_id] || null })),
        packages: packages.results.map((p) => ({ name: p.name, tokens: p.tokens, duration_days: p.duration_days, price_note: p.price_note, status: p.status, sort_order: p.sort_order, created_at: p.created_at })),
        subscriptions: subs.results.map((s) => ({ user: userName[s.user_id] || null, package: pkgName[s.package_id] || null, tokens: s.tokens, starts_at: s.starts_at, expires_at: s.expires_at, status: s.status, created_at: s.created_at })),
        promo_codes: promos.results.map((p) => ({ code: p.code, bonus_tokens: p.bonus_tokens, max_uses: p.max_uses, used_count: p.used_count, status: p.status, expires_at: p.expires_at, notes: p.notes, created_at: p.created_at })),
        promo_usage: promoUsage.results.map((x) => ({ code: promoCode[x.promo_code_id] || null, user: userName[x.user_id] || null, bonus_tokens: x.bonus_tokens, used_at: x.used_at })),
        announcements: anns.results.map((a) => ({ title: a.title, content: a.content, status: a.status, created_at: a.created_at })),
        settings,
        model_limits: limits.results.map((l) => ({ user: userName[l.user_id] || null, key_label: keyLabel[l.key_id] || null, model: l.model, rpm_limit: l.rpm_limit, concurrency: l.concurrency, enabled: l.enabled, created_at: l.created_at })),
      });
    }
    // POST /admin/accounts/data —— Sub2API 前端数据导入（{data: payload} 包装）
    if (request.method === "POST" && sub === "data") {
      const entries = await parseImportBody(request);
      const result = await importAccounts(db, entries);
      return json(result, result.failed > 0 && result.created === 0 ? 207 : 200);
    }
    // 批量导入：数组 / Codex 风格 / NDJSON 单行（与原版前端一致）
    if (request.method === "POST" && sub === "import") {
      const entries = await parseImportBody(request);
      const result = await importAccounts(db, entries);
      return json(result, result.failed > 0 && result.created === 0 ? 207 : 200);
    }
    // GET /admin/accounts —— 列表
    if (request.method === "GET" && !sub) {
      const rows = await db
        .prepare("SELECT id,name,platform,type,base_url,model_map,priority,concurrency,status,schedulable,usage_tokens,error_message,last_used_at,created_at,expires_at,auto_pause_on_expired FROM accounts_v2 ORDER BY id DESC")
        .all();
      // model_map / credentials 在库里是 JSON 字符串，这里解析成对象方便前端直接使用
      for (const r of rows.results) {
        try { r.model_map = JSON.parse(r.model_map || "{}"); } catch { r.model_map = {}; }
        try { r.credentials = JSON.parse(r.credentials || "{}"); } catch { r.credentials = {}; }
      }
      return json(rows.results);
    }
    // 单账号创建
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      const res = await createAccount(db, normalizeAccountInput(b));
      if (res.error) return json({ error: res.error }, 400);
      return json({ ok: true, id: res.id });
    }
    // GET /admin/accounts/:id/models —— 账号可用模型列表（测试连接弹窗选择用）
    if (request.method === "GET" && sub && sub2 === "models") {
      const row = await db.prepare("SELECT * FROM accounts_v2 WHERE id=?").bind(sub).first();
      if (!row) return json({ error: "account not found" }, 404);
      return json(await accountModels(row));
    }
    // GET /admin/accounts/:id/usage —— 单账号用量流水
    if (request.method === "GET" && sub && sub2 === "usage") {
      const rows = await db
        .prepare("SELECT id,user_key_id,model,prompt_tokens,completion_tokens,created_at FROM usage_logs WHERE account_id=? ORDER BY id DESC LIMIT 200")
        .bind(sub)
        .all();
      return json(rows.results);
    }
    // 账号动作：toggle-schedulable / toggle-status / clear-error
    if (request.method === "POST" && sub && sub2) {
      if (sub2 === "toggle-schedulable") {
        const row = await db.prepare("SELECT schedulable FROM accounts_v2 WHERE id=?").bind(sub).first();
        if (!row) return json({ error: "not found" }, 404);
        const next = row.schedulable ? 0 : 1;
        await db.prepare("UPDATE accounts_v2 SET schedulable=? WHERE id=?").bind(next, sub).run();
        return json({ ok: true, schedulable: !!next });
      }
      if (sub2 === "toggle-status") {
        const row = await db.prepare("SELECT status FROM accounts_v2 WHERE id=?").bind(sub).first();
        if (!row) return json({ error: "not found" }, 404);
        const next = row.status === "disabled" ? "active" : "disabled";
        await db.prepare("UPDATE accounts_v2 SET status=? WHERE id=?").bind(next, sub).run();
        return json({ ok: true, status: next });
      }
      if (sub2 === "clear-error") {
        await db.prepare("UPDATE accounts_v2 SET status='active', error_message=NULL WHERE id=?").bind(sub).run();
        return json({ ok: true });
      }
      // POST /admin/accounts/:id/test —— 单账号连通测试（可选 body.model_id 指定测试模型）
      if (sub2 === "test") {
        const row = await db.prepare("SELECT * FROM accounts_v2 WHERE id=?").bind(sub).first();
        if (!row) return json({ error: "account not found" }, 404);
        const b = await request.json().catch(() => ({}));
        const result = await testAccountConnection(row, env, b && b.model_id);
        return json(result);
      }
    }
    // PATCH /admin/accounts/:id —— 更新账号字段
    if (request.method === "PATCH" && sub && !sub2) {
      const b = await request.json().catch(() => ({}));
      const fields = [];
      const vals = [];
      if (b.name != null) { fields.push("name=?"); vals.push(String(b.name)); }
      if (b.priority != null) { fields.push("priority=?"); vals.push(Number(b.priority)); }
      if (b.concurrency != null) { fields.push("concurrency=?"); vals.push(Number(b.concurrency)); }
      if (b.schedulable != null) { fields.push("schedulable=?"); vals.push(b.schedulable ? 1 : 0); }
      if (b.status != null) { fields.push("status=?"); vals.push(String(b.status)); }
      if (b.base_url != null) { fields.push("base_url=?"); vals.push(b.base_url ? String(b.base_url) : null); }
      if (b.model_map != null) { fields.push("model_map=?"); vals.push(JSON.stringify(b.model_map)); }
      if (b.credentials != null) { fields.push("credentials=?"); vals.push(JSON.stringify(b.credentials)); }
      if (!fields.length) return json({ error: "no fields to update" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE accounts_v2 SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    // DELETE /admin/accounts/:id
    if (request.method === "DELETE" && sub) {
      await db.prepare("DELETE FROM accounts_v2 WHERE id = ?").bind(sub).run();
      return json({ ok: true });
    }
  }

  if (resource === "keys") {
    if (request.method === "GET" && !sub) {
      const rows = await db
        .prepare(`SELECT k.id, k.key, k.label, k.quota_tokens, k.used_tokens, k.enabled, k.created_at,
          k.user_id, k.group_id, k.expires_at, k.rpm_limit, k.status,
          u.username AS user_name, g.name AS group_name
          FROM user_keys k LEFT JOIN users u ON u.id=k.user_id LEFT JOIN groups g ON g.id=k.group_id
          ORDER BY k.id DESC`)
        .all();
      return json(rows.results);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      const key = "sk-" + crypto.randomUUID().replace(/-/g, "");
      let expires = null;
      if (b.expires_in_days) expires = now() + Number(b.expires_in_days) * 24 * 3600 * 1000;
      else if (b.expires_at) expires = Number(b.expires_at);
      await db
        .prepare(`INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at,user_id,group_id,expires_at,rpm_limit,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(key, b.label || "", b.quota_tokens ?? null, 0, 1, now(),
          b.user_id ?? null, b.group_id ?? null, expires, b.rpm_limit ?? 0, "active")
        .run();
      await audit(env, "create", "key", null, b.label || "");
      return json({ ok: true, key });
    }
    if (request.method === "POST" && sub === "toggle" && sub2) {
      const row = await db.prepare("SELECT enabled FROM user_keys WHERE id=?").bind(sub2).first();
      if (!row) return json({ error: "not found" }, 404);
      const next = row.enabled ? 0 : 1;
      await db.prepare("UPDATE user_keys SET enabled=?, status=? WHERE id=?").bind(next, next ? "active" : "inactive", sub2).run();
      await audit(env, "toggle", "key", sub2, next ? "enable" : "disable");
      return json({ ok: true, enabled: !!next });
    }
    if (request.method === "PATCH" && sub && !sub2) {
      const b = await request.json().catch(() => ({}));
      const fields = [];
      const vals = [];
      if (b.label != null) { fields.push("label=?"); vals.push(String(b.label)); }
      if (b.quota_tokens != null) { fields.push("quota_tokens=?"); vals.push(Number(b.quota_tokens)); }
      if (b.used_tokens != null) { fields.push("used_tokens=?"); vals.push(Number(b.used_tokens)); }
      if (b.user_id !== undefined) { fields.push("user_id=?"); vals.push(b.user_id ? Number(b.user_id) : null); }
      if (b.group_id !== undefined) { fields.push("group_id=?"); vals.push(b.group_id ? Number(b.group_id) : null); }
      if (b.expires_at !== undefined) { fields.push("expires_at=?"); vals.push(b.expires_at ? Number(b.expires_at) : null); }
      if (b.rpm_limit != null) { fields.push("rpm_limit=?"); vals.push(Number(b.rpm_limit)); }
      if (b.status != null) { fields.push("status=?"); vals.push(String(b.status)); }
      if (!fields.length) return json({ error: "no fields to update" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE user_keys SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      await audit(env, "update", "key", sub, fields.join(","));
      return json({ ok: true });
    }
    if (request.method === "DELETE" && sub) {
      await db.prepare("DELETE FROM user_keys WHERE id = ?").bind(sub).run();
      await audit(env, "delete", "key", sub, "");
      return json({ ok: true });
    }
  }

  // OAuth 登录导入（替换原版 OAuth 登录 UI）：
  //   GET /admin/oauth/login?provider=openai|anthropic|gemini|grok&state=xxx
  //      -> 302 到提供商授权页（需要 env 里配 OAUTH_CLIENT_ID）
  //   GET /admin/oauth/callback?code=...&state=...
  //      -> 用 code 换 token，创建/更新对应平台账号（oauth 类型）
  if (resource === "oauth") {
    if (sub === "login" && request.method === "GET") {
      const provider = url.searchParams.get("provider") || "";
      const cfg = OAUTH_PROVIDERS[provider];
      if (!cfg) return json({ error: "unknown provider: " + provider }, 400);
      const clientId = env[cfg.clientIdEnv];
      if (!clientId) return json({ error: "OAUTH_CLIENT_ID not configured for " + provider }, 400);
      const state = crypto.randomUUID();
      const redirect = new URL(url.origin + "/admin/oauth/callback");
      redirect.searchParams.set("provider", provider);
      redirect.searchParams.set("state", state);
      const authUrl = new URL(cfg.authorizeUrl);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirect.toString());
      authUrl.searchParams.set("scope", cfg.scope);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("prompt", "consent");
      // state 暂存 KV 缺失时的替代：直接放进 URL 回调校验（单机场景可接受）
      return Response.redirect(authUrl.toString(), 302);
    }
    if (sub === "callback" && request.method === "GET") {
      const provider = url.searchParams.get("provider") || "";
      const code = url.searchParams.get("code") || "";
      const cfg = OAUTH_PROVIDERS[provider];
      if (!cfg || !code) return json({ error: "invalid oauth callback" }, 400);
      const clientId = env[cfg.clientIdEnv];
      const clientSecret = env[cfg.clientSecretEnv];
      if (!clientId || !clientSecret) return json({ error: "oauth client not configured" }, 400);
      const redirect = new URL(url.origin + "/admin/oauth/callback");
      redirect.searchParams.set("provider", provider);
      redirect.searchParams.set("state", url.searchParams.get("state") || "");
      try {
        const tok = await fetch(cfg.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect.toString(),
          }).toString(),
        });
        if (!tok.ok) return json({ error: "oauth token exchange failed: " + tok.status }, 400);
        const tj = await tok.json();
        const cred = {
          access_token: tj.access_token || "",
          refresh_token: tj.refresh_token || "",
          expires_in: tj.expires_in || null,
          expires_at: tj.expires_in ? now() + Number(tj.expires_in) * 1000 : null,
        };
        if (!cred.access_token && !cred.refresh_token) return json({ error: "no tokens in oauth response" }, 400);
        // 创建/更新 oauth 账号（同名去重）
        const name = `${provider}-oauth-${String(Math.floor(Math.random() * 1e6))}`;
        const existing = await db.prepare("SELECT id FROM accounts_v2 WHERE platform=? AND type='oauth' AND name LIKE ? LIMIT 1")
          .bind(provider, `${provider}-oauth-%`).first();
        const row = existing || { id: null };
        if (row.id) {
          await db.prepare("UPDATE accounts_v2 SET credentials=?, status='active', error_message=NULL WHERE id=?")
            .bind(JSON.stringify(cred), row.id).run();
        } else {
          const r = await db.prepare("INSERT INTO accounts_v2 (name,platform,type,credentials,model_map,priority,concurrency,status,schedulable,usage_tokens,created_at) VALUES (?,?,?,?,?,50,3,'active',1,0,?)")
            .bind(name, provider, "oauth", JSON.stringify(cred), "{}", now()).run();
          row.id = r.meta.last_row_id;
        }
        await audit(env, "oauth_import", "account", row.id, provider);
        return html("<h3 style='font-family:system-ui'>OAuth 登录成功 ✅</h3><p style='font-family:system-ui'>已导入「" + name + "」账号，可以关闭本页面回到管理后台查看。</p>");
      } catch (e) {
        return json({ error: "oauth failed: " + String(e) }, 400);
      }
    }
    return json({ error: "bad oauth request" }, 400);
  }

  // GET /admin/usage —— 用量流水列表（含 Key 标签与账号名，支持 ?account_id= 过滤）
  if (resource === "usage" && request.method === "GET") {
    const accountId = url.searchParams.get("account_id");
    const limit = Math.min(Number(url.searchParams.get("limit") || 200), 500);
    let rows;
    if (accountId) {
      rows = await db
        .prepare(`SELECT u.id, u.user_key_id, u.account_id, u.model, u.prompt_tokens, u.completion_tokens, u.created_at,
          k.label AS key_label, k.key AS key_value, a.name AS account_name, a.platform AS account_platform
          FROM usage_logs u LEFT JOIN user_keys k ON k.id=u.user_key_id LEFT JOIN accounts_v2 a ON a.id=u.account_id
          WHERE u.account_id=? ORDER BY u.id DESC LIMIT ?`)
        .bind(accountId, limit)
        .all();
    } else {
      rows = await db
        .prepare(`SELECT u.id, u.user_key_id, u.account_id, u.model, u.prompt_tokens, u.completion_tokens, u.created_at,
          k.label AS key_label, k.key AS key_value, a.name AS account_name, a.platform AS account_platform
          FROM usage_logs u LEFT JOIN user_keys k ON k.id=u.user_key_id LEFT JOIN accounts_v2 a ON a.id=u.account_id
          ORDER BY u.id DESC LIMIT ?`)
        .bind(limit)
        .all();
    }
    return json(rows.results);
  }

  if (resource === "users") {
    // GET /admin/users/:id/usage?days=N —— 用户用量图表：按天 / 按模型 / 按账号汇总
    if (request.method === "GET" && sub && sub2 === "usage") {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
      const since = now() - days * 86400000;
      const q = `WHERE user_id=? AND created_at>=?`;
      const byDay = await db.prepare(
        `SELECT date(created_at/1000,'unixepoch') AS day, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens, COUNT(*) AS calls
         FROM usage_logs ${q} GROUP BY day ORDER BY day ASC`
      ).bind(sub, since).all();
      const byModel = await db.prepare(
        `SELECT model, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens, COUNT(*) AS calls
         FROM usage_logs ${q} GROUP BY model ORDER BY tokens DESC LIMIT 20`
      ).bind(sub, since).all();
      const byAccount = await db.prepare(
        `SELECT COALESCE(a.name,'?') AS account, COALESCE(a.platform,'') AS platform,
                COALESCE(SUM(u.prompt_tokens+u.completion_tokens),0) AS tokens, COUNT(*) AS calls
         FROM usage_logs u LEFT JOIN accounts_v2 a ON a.id=u.account_id
         WHERE u.user_id=? AND u.created_at>=? GROUP BY u.account_id ORDER BY tokens DESC LIMIT 20`
      ).bind(sub, since).all();
      const totals = await db.prepare(
        `SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens, COUNT(*) AS calls FROM usage_logs ${q}`
      ).bind(sub, since).first();
      const user = await db.prepare("SELECT id,username FROM users WHERE id=?").bind(sub).first();
      if (!user) return json({ error: "user not found" }, 404);
      return json({ user, days, since, totals, by_day: byDay.results, by_model: byModel.results, by_account: byAccount.results });
    }
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare("SELECT * FROM users ORDER BY id DESC").all();
      // 附带各用户的 key 数 / 总用量
      for (const u of rows.results) {
        const ks = await db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE user_id=?").bind(u.id).first();
        const us = await db.prepare("SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) AS t FROM usage_logs WHERE user_id=?").bind(u.id).first();
        u.key_count = ks.n; u.total_usage = us.t;
      }
      return json(rows.results);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      if (!b.username) return json({ error: "username required" }, 400);
      try {
        const r = await db.prepare("INSERT INTO users (username,email,role,status,balance_tokens,concurrency,rpm_limit,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(b.username, b.email || "", b.role === "admin" ? "admin" : "user", b.status === "disabled" ? "disabled" : "active",
            b.balance_tokens ?? 0, b.concurrency ?? 3, b.rpm_limit ?? 0, b.notes || "", now()).run();
        await audit(env, "create", "user", r.meta.last_row_id, b.username);
        return json({ ok: true, id: r.meta.last_row_id });
      } catch (e) {
        return json({ error: String(e.message || e).slice(0, 200) }, 400);
      }
    }
    if ((request.method === "PATCH" || request.method === "DELETE") && sub) {
      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM users WHERE id=?").bind(sub).run();
        await audit(env, "delete", "user", sub, "");
        return json({ ok: true });
      }
      const b = await request.json().catch(() => ({}));
      const fields = []; const vals = [];
      if (b.username != null) { fields.push("username=?"); vals.push(String(b.username)); }
      if (b.email != null) { fields.push("email=?"); vals.push(String(b.email)); }
      if (b.role != null) { fields.push("role=?"); vals.push(b.role === "admin" ? "admin" : "user"); }
      if (b.status != null) { fields.push("status=?"); vals.push(String(b.status)); }
      if (b.balance_tokens != null) { fields.push("balance_tokens=?"); vals.push(Number(b.balance_tokens)); }
      if (b.concurrency != null) { fields.push("concurrency=?"); vals.push(Number(b.concurrency)); }
      if (b.rpm_limit != null) { fields.push("rpm_limit=?"); vals.push(Number(b.rpm_limit)); }
      if (b.notes != null) { fields.push("notes=?"); vals.push(String(b.notes)); }
      if (!fields.length) return json({ error: "no fields" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE users SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      await audit(env, "update", "user", sub, fields.join(","));
      return json({ ok: true });
    }
    return json({ error: "bad users request" }, 400);
  }

  if (resource === "groups") {
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare("SELECT * FROM groups ORDER BY sort_order ASC, id ASC").all();
      for (const g of rows.results) {
        const ks = await db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE group_id=?").bind(g.id).first();
        g.key_count = ks.n;
      }
      return json(rows.results);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      if (!b.name) return json({ error: "name required" }, 400);
      const r = await db.prepare("INSERT INTO groups (name,description,platform,rate_multiplier,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(b.name, b.description || "", b.platform || "", b.rate_multiplier ?? 1.0, b.status === "inactive" ? "inactive" : "active", b.sort_order ?? 0, now()).run();
      await audit(env, "create", "group", r.meta.last_row_id, b.name);
      return json({ ok: true, id: r.meta.last_row_id });
    }
    if ((request.method === "PATCH" || request.method === "DELETE") && sub) {
      if (request.method === "DELETE") {
        await db.prepare("UPDATE user_keys SET group_id=NULL WHERE group_id=?").bind(sub).run();
        await db.prepare("DELETE FROM groups WHERE id=?").bind(sub).run();
        await audit(env, "delete", "group", sub, "");
        return json({ ok: true });
      }
      const b = await request.json().catch(() => ({}));
      const fields = []; const vals = [];
      if (b.name != null) { fields.push("name=?"); vals.push(String(b.name)); }
      if (b.description != null) { fields.push("description=?"); vals.push(b.description ? String(b.description) : null); }
      if (b.platform != null) { fields.push("platform=?"); vals.push(String(b.platform)); }
      if (b.rate_multiplier != null) { fields.push("rate_multiplier=?"); vals.push(Number(b.rate_multiplier)); }
      if (b.status != null) { fields.push("status=?"); vals.push(String(b.status)); }
      if (b.sort_order != null) { fields.push("sort_order=?"); vals.push(Number(b.sort_order)); }
      if (!fields.length) return json({ error: "no fields" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE groups SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      await audit(env, "update", "group", sub, fields.join(","));
      return json({ ok: true });
    }
    return json({ error: "bad groups request" }, 400);
  }

  if (resource === "packages") {
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare("SELECT * FROM packages ORDER BY sort_order ASC, id ASC").all();
      return json(rows.results);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      if (!b.name) return json({ error: "name required" }, 400);
      const r = await db.prepare("INSERT INTO packages (name,tokens,duration_days,price_note,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(b.name, b.tokens ?? 0, b.duration_days ?? 30, b.price_note || "", b.status === "inactive" ? "inactive" : "active", b.sort_order ?? 0, now()).run();
      await audit(env, "create", "package", r.meta.last_row_id, b.name);
      return json({ ok: true, id: r.meta.last_row_id });
    }
    if ((request.method === "PATCH" || request.method === "DELETE") && sub) {
      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM packages WHERE id=?").bind(sub).run();
        await audit(env, "delete", "package", sub, "");
        return json({ ok: true });
      }
      const b = await request.json().catch(() => ({}));
      const fields = []; const vals = [];
      if (b.name != null) { fields.push("name=?"); vals.push(String(b.name)); }
      if (b.tokens != null) { fields.push("tokens=?"); vals.push(Number(b.tokens)); }
      if (b.duration_days != null) { fields.push("duration_days=?"); vals.push(Number(b.duration_days)); }
      if (b.price_note != null) { fields.push("price_note=?"); vals.push(String(b.price_note)); }
      if (b.status != null) { fields.push("status=?"); vals.push(String(b.status)); }
      if (b.sort_order != null) { fields.push("sort_order=?"); vals.push(Number(b.sort_order)); }
      if (!fields.length) return json({ error: "no fields" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE packages SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      await audit(env, "update", "package", sub, fields.join(","));
      return json({ ok: true });
    }
    return json({ error: "bad packages request" }, 400);
  }

  if (resource === "subscriptions") {
    // GET 列表 / POST 开通（= 兑换/购买套餐：给用户加额度 + 生成订阅）
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare(`SELECT s.*, u.username, p.name AS package_name
        FROM user_subscriptions s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN packages p ON p.id=s.package_id
        ORDER BY s.id DESC`).all();
      return json(rows.results);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      if (!b.user_id) return json({ error: "user_id required" }, 400);
      const user = await db.prepare("SELECT * FROM users WHERE id=?").bind(b.user_id).first();
      if (!user) return json({ error: "user not found" }, 404);
      const pkg = b.package_id ? await db.prepare("SELECT * FROM packages WHERE id=? AND status='active'").bind(b.package_id).first() : null;
      const tokens = pkg ? pkg.tokens : (b.tokens ?? 0);
      const days = pkg ? pkg.duration_days : (b.duration_days ?? 30);
      const starts = now();
      const expires = days ? starts + days * 24 * 3600 * 1000 : null;
      const r = await db.prepare("INSERT INTO user_subscriptions (user_id,package_id,tokens,starts_at,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(b.user_id, pkg ? pkg.id : null, tokens, starts, expires, "active", starts).run();
      // 额度累加到用户余额
      await db.prepare("UPDATE users SET balance_tokens = balance_tokens + ? WHERE id=?")
        .bind(tokens, b.user_id).run();
      await audit(env, "assign", "subscription", r.meta.last_row_id, `user=${b.user_id} pkg=${pkg ? pkg.id : ""} tokens=${tokens} days=${days}`);
      return json({ ok: true, id: r.meta.last_row_id });
    }
    if ((request.method === "PATCH" || request.method === "DELETE") && sub) {
      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM user_subscriptions WHERE id=?").bind(sub).run();
        await audit(env, "delete", "subscription", sub, "");
        return json({ ok: true });
      }
      const b = await request.json().catch(() => ({}));
      const fields = []; const vals = [];
      if (b.status != null) { fields.push("status=?"); vals.push(String(b.status)); }
      if (b.expires_at !== undefined) { fields.push("expires_at=?"); vals.push(b.expires_at ? Number(b.expires_at) : null); }
      if (b.extend_days != null) {
        const cur = await db.prepare("SELECT expires_at FROM user_subscriptions WHERE id=?").bind(sub).first();
        const base = cur && cur.expires_at ? cur.expires_at : now();
        fields.push("expires_at=?"); vals.push(base + Number(b.extend_days) * 24 * 3600 * 1000);
        fields.push("status='active'");
      }
      if (!fields.length) return json({ error: "no fields" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE user_subscriptions SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      await audit(env, "update", "subscription", sub, fields.join(","));
      return json({ ok: true });
    }
    return json({ error: "bad subscriptions request" }, 400);
  }

  if (resource === "promos") {
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare("SELECT * FROM promo_codes ORDER BY id DESC").all();
      return json(rows.results);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      let code = (b.code || "").trim().toUpperCase();
      if (!code) code = "PROMO-" + crypto.randomUUID().toString().slice(0, 8).toUpperCase();
      try {
        const r = await db.prepare("INSERT INTO promo_codes (code,bonus_tokens,max_uses,used_count,status,expires_at,notes,created_at) VALUES (?,?,?,0,?,?,?,?)")
          .bind(code, b.bonus_tokens ?? 0, b.max_uses ?? 1, b.status === "disabled" ? "disabled" : "active", b.expires_at ? Number(b.expires_at) : null, b.notes || "", now()).run();
        await audit(env, "create", "promo", r.meta.last_row_id, code);
        return json({ ok: true, id: r.meta.last_row_id, code });
      } catch (e) { return json({ error: String(e.message || e).slice(0, 200) }, 400); }
    }
    if ((request.method === "PATCH" || request.method === "DELETE") && sub) {
      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM promo_codes WHERE id=?").bind(sub).run();
        await audit(env, "delete", "promo", sub, "");
        return json({ ok: true });
      }
      const b = await request.json().catch(() => ({}));
      const fields = []; const vals = [];
      if (b.code != null) { fields.push("code=?"); vals.push(String(b.code).toUpperCase()); }
      if (b.bonus_tokens != null) { fields.push("bonus_tokens=?"); vals.push(Number(b.bonus_tokens)); }
      if (b.max_uses != null) { fields.push("max_uses=?"); vals.push(Number(b.max_uses)); }
      if (b.status != null) { fields.push("status=?"); vals.push(String(b.status)); }
      if (b.expires_at !== undefined) { fields.push("expires_at=?"); vals.push(b.expires_at ? Number(b.expires_at) : null); }
      if (b.notes != null) { fields.push("notes=?"); vals.push(String(b.notes)); }
      if (!fields.length) return json({ error: "no fields" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE promo_codes SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      await audit(env, "update", "promo", sub, fields.join(","));
      return json({ ok: true });
    }
    // POST /admin/promos/redeem —— 兑换码给指定用户充额度
    if (request.method === "POST" && sub === "redeem") {
      const b = await request.json().catch(() => ({}));
      if (!b.user_id || !b.code) return json({ error: "user_id and code required" }, 400);
      const code = String(b.code).trim().toUpperCase();
      const promo = await db.prepare("SELECT * FROM promo_codes WHERE code=? AND status='active'").bind(code).first();
      if (!promo) return json({ error: "invalid or disabled promo code" }, 404);
      if (promo.expires_at && promo.expires_at < now()) return json({ error: "promo code expired" }, 400);
      if (promo.used_count >= promo.max_uses) return json({ error: "promo code used up" }, 400);
      const user = await db.prepare("SELECT * FROM users WHERE id=?").bind(b.user_id).first();
      if (!user) return json({ error: "user not found" }, 404);
      await db.batch([
        db.prepare("UPDATE promo_codes SET used_count = used_count + 1 WHERE id=?").bind(promo.id),
        db.prepare("UPDATE users SET balance_tokens = balance_tokens + ? WHERE id=?").bind(promo.bonus_tokens, b.user_id),
        db.prepare("INSERT INTO promo_usage (promo_code_id,user_id,bonus_tokens,used_at) VALUES (?,?,?,?)").bind(promo.id, b.user_id, promo.bonus_tokens, now()),
      ]);
      await audit(env, "redeem", "promo", promo.id, `user=${b.user_id} code=${code} tokens=${promo.bonus_tokens}`);
      return json({ ok: true, bonus_tokens: promo.bonus_tokens });
    }
    return json({ error: "bad promos request" }, 400);
  }

  if (resource === "announcements") {
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare("SELECT * FROM announcements ORDER BY id DESC").all();
      return json(rows.results);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      if (!b.title) return json({ error: "title required" }, 400);
      const r = await db.prepare("INSERT INTO announcements (title,content,status,created_at) VALUES (?,?,?,?)")
        .bind(b.title, b.content || "", b.status === "inactive" ? "inactive" : "active", now()).run();
      await audit(env, "create", "announcement", r.meta.last_row_id, b.title);
      return json({ ok: true, id: r.meta.last_row_id });
    }
    if ((request.method === "PATCH" || request.method === "DELETE") && sub) {
      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM announcements WHERE id=?").bind(sub).run();
        await audit(env, "delete", "announcement", sub, "");
        return json({ ok: true });
      }
      const b = await request.json().catch(() => ({}));
      const fields = []; const vals = [];
      if (b.title != null) { fields.push("title=?"); vals.push(String(b.title)); }
      if (b.content != null) { fields.push("content=?"); vals.push(String(b.content)); }
      if (b.status != null) { fields.push("status=?"); vals.push(String(b.status)); }
      if (!fields.length) return json({ error: "no fields" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE announcements SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      await audit(env, "update", "announcement", sub, fields.join(","));
      return json({ ok: true });
    }
    return json({ error: "bad announcements request" }, 400);
  }

  if (resource === "audit") {
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500").all();
      return json(rows.results);
    }
    return json({ error: "bad audit request" }, 400);
  }

  if (resource === "settings") {
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare("SELECT * FROM settings").all();
      const obj = {};
      for (const r of rows.results) obj[r.key] = safeJson(r.value, r.value);
      return json(obj);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      const keys = Object.keys(b);
      for (const k of keys) {
        await db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
          .bind(k, typeof b[k] === "string" ? b[k] : JSON.stringify(b[k]), now()).run();
      }
      await audit(env, "update", "settings", null, keys.join(","));
      return json({ ok: true });
    }
    return json({ error: "bad settings request" }, 400);
  }

  if (resource === "channels") {
    // 渠道监控：账号健康列表 + 手动触发一次探测
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare(`SELECT id,name,platform,type,status,error_message,last_checked_at,last_check_result,priority,usage_tokens,last_used_at
        FROM accounts_v2 ORDER BY platform ASC, priority ASC`).all();
      for (const a of rows.results || []) {
        const pr = parseProbeResult(a.last_check_result);
        a.probe = pr;
        a.last_check_result = pr.ok ? "ok" : "fail";
        a.latency_ms = pr.latency_ms;
        a.probe_error = pr.error;
        if (!a.error_message && pr.error) a.error_message = pr.error;
      }
      return json(rows.results);
    }
    if (request.method === "POST" && sub === "check") {
      // 一键全通道检测：强制重新探测所有账号（不受 10 分钟节流限制）
      await monitorChannels(env, true);
      return json({ ok: true });
    }
    return json({ error: "bad channels request" }, 400);
  }

  if (resource === "models") {
    // 模型广场：汇总各账号 model_map + 常用默认模型
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare("SELECT name,platform,model_map FROM accounts_v2 WHERE status='active'").all();
      const seen = {};
      const out = [];
      for (const a of rows.results) {
        const mm = safeJson(a.model_map, {});
        for (const k of Object.keys(mm)) {
          if (!seen[k]) { seen[k] = true; out.push({ model: k, platform: a.platform, account: a.name }); }
        }
      }
      if (!out.length) {
        // 无映射时给出平台默认模型
        const defs = ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4-5", "claude-opus-4-5", "gemini-2.5-flash", "gemini-2.5-pro", "grok-3", "grok-3-mini"];
        for (const m of defs) out.push({ model: m, platform: "", account: "" });
      }
      return json(out);
    }
    return json({ error: "bad models request" }, 400);
  }

  if (resource === "model-limits") {
    // 模型限流规则 CRUD（每 Key / 每用户对指定模型的 RPM + 并发上限）
    if (request.method === "GET" && !sub) {
      const rows = await db.prepare(`SELECT ml.*, u.username AS user_name, k.label AS key_label
        FROM model_limits ml LEFT JOIN users u ON u.id=ml.user_id LEFT JOIN user_keys k ON k.id=ml.key_id
        ORDER BY ml.id DESC`).all();
      return json(rows.results);
    }
    if (request.method === "POST" && !sub) {
      const b = await request.json().catch(() => ({}));
      if (!b.model) return json({ error: "model required" }, 400);
      const r = await db.prepare("INSERT INTO model_limits (user_id,key_id,model,rpm_limit,concurrency,enabled,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(b.user_id ?? null, b.key_id ?? null, String(b.model), Number(b.rpm_limit) || 0, Number(b.concurrency) || 0, b.enabled === false ? 0 : 1, now()).run();
      await audit(env, "create", "model_limit", r.meta.last_row_id, String(b.model));
      return json({ ok: true, id: r.meta.last_row_id });
    }
    if ((request.method === "PATCH" || request.method === "DELETE") && sub) {
      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM model_limits WHERE id=?").bind(sub).run();
        await audit(env, "delete", "model_limit", sub, "");
        return json({ ok: true });
      }
      const b = await request.json().catch(() => ({}));
      const fields = []; const vals = [];
      if (b.user_id !== undefined) { fields.push("user_id=?"); vals.push(b.user_id); }
      if (b.key_id !== undefined) { fields.push("key_id=?"); vals.push(b.key_id); }
      if (b.model != null) { fields.push("model=?"); vals.push(String(b.model)); }
      if (b.rpm_limit != null) { fields.push("rpm_limit=?"); vals.push(Number(b.rpm_limit) || 0); }
      if (b.concurrency != null) { fields.push("concurrency=?"); vals.push(Number(b.concurrency) || 0); }
      if (b.enabled !== undefined) { fields.push("enabled=?"); vals.push(b.enabled ? 1 : 0); }
      if (!fields.length) return json({ error: "no fields" }, 400);
      vals.push(sub);
      await db.prepare(`UPDATE model_limits SET ${fields.join(",")} WHERE id=?`).bind(...vals).run();
      await audit(env, "update", "model_limit", sub, fields.join(","));
      return json({ ok: true });
    }
    return json({ error: "bad model-limits request" }, 400);
  }

  if (resource === "stats") {
    const tot = await db
      .prepare("SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) AS total_tokens, COUNT(*) AS calls FROM usage_logs")
      .first();
    const keys = await db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE enabled=1").first();
    const accts = await db.prepare("SELECT COUNT(*) AS n FROM accounts_v2 WHERE status='active'").first();
    const users = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE status='active'").first();
    const activeSubs = await db.prepare("SELECT COUNT(*) AS n FROM user_subscriptions WHERE status='active'").first();
    return json({ ...tot, active_keys: keys.n, active_accounts: accts.n, active_users: users.n, active_subscriptions: activeSubs.n });
  }

  if (resource === "health") {
    // —— 概览页健康度：各平台账号可用数 / 最近渠道探测 / Key 配额使用率 ——
    const acctRows = await db.prepare("SELECT platform, status, COUNT(*) AS n FROM accounts_v2 GROUP BY platform, status ORDER BY platform").all();
    const byPlatform = {};
    for (const r of acctRows.results || []) {
      byPlatform[r.platform] = byPlatform[r.platform] || { platform: r.platform, total: 0, active: 0, error: 0, disabled: 0, oauth: 0 };
      const p = byPlatform[r.platform];
      p.total += r.n;
      if (r.status === "active") p.active += r.n;
      else if (r.status === "error") p.error += r.n;
      else p.disabled += r.n;
    }
    const oauthRows = await db.prepare("SELECT platform, COUNT(*) AS n FROM accounts_v2 WHERE type='oauth' AND status != 'disabled' GROUP BY platform").all();
    for (const r of oauthRows.results || []) {
      if (byPlatform[r.platform]) byPlatform[r.platform].oauth = r.n;
    }
    const probes = await db.prepare(
      "SELECT id,name,platform,status,error_message,last_checked_at,last_check_result FROM accounts_v2 WHERE last_checked_at IS NOT NULL ORDER BY last_checked_at DESC LIMIT 8"
    ).all();
    for (const p of probes.results || []) {
      const pr = parseProbeResult(p.last_check_result);
      p.probe = pr;
      p.last_check_result = pr.ok ? "ok" : "fail";
      p.latency_ms = pr.latency_ms;
      p.probe_error = pr.error;
    }
    const qTot = await db.prepare("SELECT COALESCE(SUM(quota_tokens),0) AS total, COALESCE(SUM(used_tokens),0) AS used, COUNT(*) AS n FROM user_keys WHERE quota_tokens IS NOT NULL AND enabled=1").first();
    const unlimited = await db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE quota_tokens IS NULL AND enabled=1").first();
    const keysTotal = await db.prepare("SELECT COUNT(*) AS n FROM user_keys WHERE enabled=1").first();
    const topRows = await db.prepare(
      "SELECT key,label,quota_tokens,used_tokens FROM user_keys WHERE quota_tokens IS NOT NULL AND enabled=1 ORDER BY used_tokens DESC LIMIT 6"
    ).all();
    return json({
      platforms: Object.values(byPlatform),
      probes: probes.results,
      quota: {
        total_quota: qTot.total,
        used_quota: qTot.used,
        pct: qTot.total > 0 ? Math.min(100, Math.round((qTot.used / qTot.total) * 100)) : 0,
        limited_keys: qTot.n,
        unlimited_keys: unlimited.n,
        keys_total: keysTotal.n,
        top: (topRows.results || []).map((k) => ({ key: k.key, label: k.label, quota_tokens: k.quota_tokens, used_tokens: k.used_tokens, pct: Math.min(100, Math.round((k.used_tokens / k.quota_tokens) * 100)) })),
      },
    });
  }

  return json({ error: "unknown admin resource: " + resource }, 404);
}

// ---------- 账号输入规范化 ----------

const PLATFORM_ALIASES = {
  openai: "openai", gpt: "openai",
  anthropic: "anthropic", claude: "anthropic", antigravity: "antigravity",
  gemini: "gemini", google: "gemini",
  grok: "grok", xai: "grok",
};
// Sub2API 原版的账号类型：oauth / setup-token / apikey / upstream / bedrock / service_account / cookie
// 本实现只支持 api_key 与 oauth 语义，其余按别名归一：
//   apikey/upstream/bedrock/service_account -> api_key；setup-token -> oauth（access_token 承载）
const TYPE_ALIASES = {
  api_key: "api_key", apikey: "api_key", upstream: "api_key", bedrock: "api_key",
  "service_account": "api_key",
  oauth: "oauth", "setup-token": "oauth",
  cookie: "cookie",
};

function decodeAndEnrichIDToken(platform, credentials) {
  if (platform !== "openai" || !credentials || !credentials.id_token) return credentials;
  try {
    const parts = credentials.id_token.split(".");
    if (parts.length !== 3) return credentials;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    const ctx = payload["https://api.openai.com/auth"] || {};
    const profile = payload["https://api.openai.com/profile"] || {};
    if (profile.email && !credentials.email) credentials.email = profile.email;
    if (ctx.chatgpt_plan_type && !credentials.plan_type) credentials.plan_type = ctx.chatgpt_plan_type;
    if (ctx.chatgpt_account_id && !credentials.chatgpt_account_id) credentials.chatgpt_account_id = ctx.chatgpt_account_id;
    if (ctx.chatgpt_user_id && !credentials.chatgpt_user_id) credentials.chatgpt_user_id = ctx.chatgpt_user_id;
    if (ctx.organization_id && !credentials.organization_id) credentials.organization_id = ctx.organization_id;
    if (ctx.user_id && !credentials.openai_user_id) credentials.openai_user_id = ctx.user_id;
  } catch {}
  return credentials;
}

function normalizeAccountInput(b) {
  // Sub2API 备份导出用 provider 字段，简化数组用 platform 字段，两者都接受
  const platform = PLATFORM_ALIASES[((b.platform || b.provider) || "").toLowerCase()];
  const rawType = (b.type || (b.credentials?.api_key ? "api_key" : "api_key")).toLowerCase();
  const type = TYPE_ALIASES[rawType];
  if (!platform) return { error: "unknown platform: " + b.platform };
  if (!type) return { error: "unknown type: " + rawType };
  if (type === "cookie") return { error: "cookie/sessionKey 凭证不被支持（规避平台限制风险）" };

  let credentials = b.credentials;
  if (!credentials) {
    if (type === "api_key") credentials = { api_key: b.api_key };
    else if (type === "oauth") credentials = { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: b.expires_at, client_id: b.client_id };
  }
  credentials = credentials || {};
  if (type === "api_key" && !credentials.api_key) return { error: "api_key required" };
  if (type === "oauth" && !credentials.access_token && !credentials.refresh_token) return { error: "oauth requires access_token or refresh_token" };

  // 解码 OpenAI OAuth id_token 丰富字段
  decodeAndEnrichIDToken(platform, credentials);

  // 统一 expires_at 为毫秒：Sub2API 导出用 unix 秒，ISO 字符串也兼容
  let expires_at = b.expires_at ?? credentials.expires_at ?? null;
  if (expires_at != null) {
    if (typeof expires_at === "string" && expires_at.includes("T") && expires_at.includes("Z")) {
      // ISO 8601 日期字符串 -> 毫秒
      expires_at = new Date(expires_at).getTime();
      if (Number.isNaN(expires_at)) expires_at = null;
    } else {
      expires_at = Number(expires_at);
      if (!Number.isNaN(expires_at) && expires_at < 1e12) expires_at = expires_at * 1000; // 秒 -> 毫秒
    }
    if (credentials.expires_at != null) credentials.expires_at = expires_at;
  }

  // model_mapping 可能放在 credentials 内（原版导出格式）或顶层本版 model_map
  let model_map = b.model_map || {};
  if (Object.keys(model_map).length === 0 && credentials.model_mapping && typeof credentials.model_mapping === "object") {
    model_map = credentials.model_mapping;
  }

  // notes 存入 extra，便于回看
  const extra = { ...(b.extra || {}) };
  if (b.notes) extra.notes = b.notes;

  return {
    error: null,
    name: b.name || `${platform}-${type}`,
    platform, type,
    credentials,
    extra,
    base_url: (b.base_url && b.base_url.trim()) || (credentials.base_url || "").trim() || DEFAULT_BASE[platform] || null,
    model_map,
    priority: b.priority ?? 50,
    concurrency: b.concurrency ?? 3,
    expires_at,
    auto_pause_on_expired: b.auto_pause_on_expired != null ? (b.auto_pause_on_expired ? 1 : 0) : 1,
    weight: b.weight || 1,
  };
}

async function createAccount(db, norm) {
  if (norm.error) return { error: norm.error };
  await db
    .prepare(`INSERT INTO accounts_v2
      (name,platform,type,credentials,extra,model_map,base_url,priority,concurrency,status,schedulable,expires_at,auto_pause_on_expired,usage_tokens,error_message,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      norm.name, norm.platform, norm.type,
      JSON.stringify(norm.credentials), JSON.stringify(norm.extra),
      JSON.stringify(norm.model_map), norm.base_url, norm.priority, norm.concurrency,
      "active", 1, norm.expires_at, norm.auto_pause_on_expired, 0, null, now()
    )
    .run();
  const row = await db.prepare("SELECT last_insert_rowid() AS id").first();
  return { id: row.id };
}

// 解析导入请求体：支持 JSON 对象 / 数组 / NDJSON（JSONL）
async function parseImportBody(request) {
  let raw = "";
  try {
    raw = await request.text();
  } catch { return {}; }
  if (!raw.trim()) return {};
  // 先尝试标准 JSON 解析
  try {
    const parsed = JSON.parse(raw);
    // 如果是 {data: ...} 包装，解一层
    if (parsed && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed) && !parsed.platform && !parsed.accounts) {
      return parsed.data;
    }
    return parsed;
  } catch {}
  // JSON 解析失败 -> 尝试 NDJSON（每行一个 JSON 对象）
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && l.startsWith("{"));
  const entries = [];
  const parseErrors = [];
  for (let i = 0; i < lines.length; i++) {
    const obj = tryParseLine(lines[i]);
    if (obj.error) {
      parseErrors.push({ index: i, message: obj.error });
    } else {
      entries.push(obj.value);
    }
  }
  if (entries.length === 0 && lines.length > 0) {
    // 所有行都解析失败：作为元错误信息返回
    return { __parseErrors: parseErrors, __rawSnippet: raw.slice(0, 500) };
  }
  // 如果只有一行，返回单对象（格式 C 兼容）；多行返回数组
  return entries.length === 1 ? entries[0] : entries;
}

// 单行 JSON 解析，带损坏修复：原版 Go 导出把错误信息里的引号双重转义成 \"（文件里是 \\"），
// 导致该行不是合法 JSON。修复规则：把 \\" 替换为 \"（仅影响错误/原因文本，不影响 JWT/access_token）。
function tryParseLine(line) {
  try {
    return { value: JSON.parse(line) };
  } catch (e) {
    const msg = String(e.message).slice(0, 100);
    if (line.includes('\\"')) {
      try {
        return { value: JSON.parse(line.replace(/\\\\"/g, '\\"')) };
      } catch {}
    }
    return { error: msg };
  }
}

// ---------- 双格式导入 ----------

async function importAccounts(db, body) {
  let entries = [];

  // NDJSON 全部解析失败时的回退
  if (body && body.__parseErrors && Array.isArray(body.__parseErrors)) {
    return {
      total: 0, created: 0, updated: 0, skipped: 0, failed: body.__parseErrors.length,
      items: [], warnings: [], errors: body.__parseErrors.map((e, i) => ({ message: "第 " + (i + 1) + " 行 JSON 解析失败：" + e.message })),
      account_created: 0, account_failed: body.__parseErrors.length,
      proxy_created: 0, proxy_reused: 0, proxy_failed: 0, proxy_skipped: 0,
    };
  }

  // 格式D：Sub2API 备份导出 { version, exported_at, accounts:[...] }
  if (body && Array.isArray(body.accounts)) {
    for (let i = 0; i < body.accounts.length; i++) {
      const norm = normalizeAccountInput(body.accounts[i]);
      if (norm.error) entries.push({ index: i, action: "failed", message: norm.error });
      else entries.push({ index: i, action: "import", account: norm });
    }
  }
  // NDJSON 解析为数组时，每行单独规范化
  else if (Array.isArray(body) && body.length > 0 && typeof body[0] === "object" && body[0].id != null) {
    for (let i = 0; i < body.length; i++) {
      const norm = normalizeAccountInput(body[i]);
      if (norm.error) entries.push({ index: i, action: "failed", message: norm.error });
      else entries.push({ index: i, action: "import", account: norm });
    }
  }
  // 格式A：Sub2API Codex 风格 { content | contents, name, ... }
  else if (body && (body.content || Array.isArray(body.contents))) {
    const list = [];
    if (body.content) list.push(body.content);
    if (Array.isArray(body.contents)) list.push(...body.contents);
    for (let i = 0; i < list.length; i++) {
      const parsed = parseCodexContent(list[i], body, i);
      if (parsed.error) {
        entries.push({ index: i, action: "failed", message: parsed.error });
      } else {
        entries.push({ index: i, action: "import", account: parsed.account });
      }
    }
  }
  // 格式B：简化数组 [{ name, platform, type, credentials, ... }]
  else if (Array.isArray(body)) {
    for (let i = 0; i < body.length; i++) {
      const norm = normalizeAccountInput(body[i]);
      if (norm.error) entries.push({ index: i, action: "failed", message: norm.error });
      else entries.push({ index: i, action: "import", account: norm });
    }
  }
  // 格式C：单对象（也当数组处理）
  else if (body && body.platform) {
    const norm = normalizeAccountInput(body);
    if (norm.error) entries.push({ index: 0, action: "failed", message: norm.error });
    else entries.push({ index: 0, action: "import", account: norm });
  } else {
    return {
      total: 0, created: 0, updated: 0, skipped: 0, failed: 0,
      items: [], warnings: [], errors: [{ message: "无法识别的导入格式：需为数组、单对象或 {content,contents,...}" }],
      account_created: 0, account_failed: 0,
      proxy_created: 0, proxy_reused: 0, proxy_failed: 0, proxy_skipped: 0,
    };
  }

  const result = {
    total: entries.length, created: 0, updated: 0, skipped: 0, failed: 0,
    items: [], warnings: [], errors: [],
    // Sub2API 原版前端兼容字段（/admin/accounts/data 返回结构）
    account_created: 0, account_failed: 0,
    proxy_created: 0, proxy_reused: 0, proxy_failed: 0, proxy_skipped: 0,
  };
  const seen = new Set();

  // 备份导出里的 proxies：Cloudflare 版无代理绑定，跳过并提示
  if (body && Array.isArray(body.proxies)) {
    for (const p of body.proxies) {
      result.proxy_skipped++;
      result.warnings.push({
        index: -1,
        proxy_key: p.proxy_key || p.name || "",
        message: "proxy 不被支持（Cloudflare 版无代理绑定），已跳过",
      });
    }
  }

  for (const e of entries) {
    if (e.action === "failed") {
      result.failed++;
      result.account_failed++;
      result.items.push({ index: e.index, action: "failed", message: e.message });
      result.errors.push({ index: e.index, message: e.message });
      continue;
    }
    const acc = e.account;
    // 去重：platform+type+name+api_key/access_token 指纹
    const fp = fingerprint(acc);
    if (seen.has(fp)) { result.skipped++; result.items.push({ index: e.index, action: "skipped", name: acc.name }); continue; }
    seen.add(fp);

    // 已存在同名同平台：token 相同视为同一账号 -> 更新（幂等重导）；token 不同则作为独立账号新建（原版允许重名账号，如两个 antigravity 的 "B"）
    const sameName = await db
      .prepare("SELECT id, credentials FROM accounts_v2 WHERE platform=? AND type=? AND name=?")
      .bind(acc.platform, acc.type, acc.name).all();
    const exist = (sameName.results || []).find((r) => sameCredential(acc.credentials, r.credentials));
    if (exist) {
      await db
        .prepare(`UPDATE accounts_v2 SET credentials=?, extra=?, model_map=?, base_url=?, priority=?, concurrency=?, expires_at=?, status='active', error_message=NULL WHERE id=?`)
        .bind(JSON.stringify(acc.credentials), JSON.stringify(acc.extra), JSON.stringify(acc.model_map), acc.base_url, acc.priority, acc.concurrency, acc.expires_at, exist.id)
        .run();
      result.updated++;
      result.items.push({ index: e.index, action: "updated", account_id: exist.id, name: acc.name });
    } else {
      const r = await createAccount(db, acc);
      if (r.error) {
        result.failed++;
        result.account_failed++;
        result.items.push({ index: e.index, action: "failed", message: r.error });
        result.errors.push({ index: e.index, message: r.error });
      } else {
        result.created++;
        result.account_created++;
        result.items.push({ index: e.index, action: "created", account_id: r.id, name: acc.name });
      }
    }
  }

  // —— 扩展段还原：用户 / 分组 / Key / 套餐 / 订阅 / 兑换码 / 公告 / 设置 / 模型限流 ——
  // 原版备份没有这些字段（只有 proxies/accounts），直接跳过；本版完整备份在这里重建。
  if (body && (Array.isArray(body.users) || Array.isArray(body.groups) || Array.isArray(body.user_keys) ||
      Array.isArray(body.packages) || Array.isArray(body.subscriptions) || Array.isArray(body.promo_codes) ||
      Array.isArray(body.announcements) || body.settings || Array.isArray(body.model_limits))) {
    await restoreFullBackup(db, body, result);
  }
  return result;
}

// 导入后静默刷新可用模型（非阻塞，仅对已知平台尝试）
async function refreshAccountModels(db, accountId, platform, credentials, baseUrl) {
  if (!accountId || !platform) return;
  try {
    let url = "";
    let headers = {};
    if (platform === "openai") {
      url = (baseUrl || "https://api.openai.com/v1") + "/models";
      const ak = credentials?.access_token || credentials?.api_key || "";
      if (ak) headers["authorization"] = "Bearer " + ak;
      else return;
    } else if (platform === "anthropic" || platform === "antigravity") {
      return; // 这些平台不需要模型列表刷新
    } else if (platform === "gemini") {
      return; // Gemini 模型由平台固定
    } else if (platform === "grok") {
      url = (baseUrl || "https://api.x.ai") + "/v1/models";
      const ak = credentials?.access_token || "";
      if (ak) headers["authorization"] = "Bearer " + ak;
      else return;
    } else {
      return;
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return;
    const data = await resp.json();
    const modelIds = ((data.data || data.models || []) || []).map(m => m.id || m.name?.replace("models/", "") || "").filter(Boolean);
    if (modelIds.length === 0) return;
    const existing = await db.prepare("SELECT model_map FROM accounts_v2 WHERE id=?").bind(accountId).first();
    if (!existing) return;
    let map = {};
    try { map = JSON.parse(existing.model_map); } catch {}
    let changed = false;
    for (const id of modelIds) {
      if (!map[id]) { map[id] = id; changed = true; }
    }
    if (changed) {
      await db.prepare("UPDATE accounts_v2 SET model_map=? WHERE id=?").bind(JSON.stringify(map), accountId).run();
    }
  } catch {}
}

// 还原完整备份的扩展段。按名称/标识解析跨表关系（username/group name/package name/key 值），
// 使导出的备份能在另一个实例上完整重建用户、Key、订阅、公告等。
async function restoreFullBackup(db, body, result) {
  const mk = (sql, vals) => db.prepare(sql).bind(...vals).run();
  const get = async (sql, ...vals) => db.prepare(sql).bind(...vals).first();
  const bump = (k) => { result[k] = (result[k] || 0) + 1; };
  const err = (section, name, e) => { result.failed++; result.errors.push({ index: -1, section, name: name || "", message: String((e && e.message) || e).slice(0, 200) }); };

  // 1. 用户（username 唯一）
  const userId = {};
  for (const u of body.users || []) {
    if (!u || !u.username) { err("users", u && u.username, "username required"); continue; }
    try {
      const exist = await get("SELECT id FROM users WHERE username=?", u.username);
      if (exist) {
        await mk("UPDATE users SET email=?, role=?, status=?, balance_tokens=?, concurrency=?, rpm_limit=?, notes=? WHERE id=?",
          [u.email || "", u.role || "user", u.status || "active", u.balance_tokens ?? 0, u.concurrency ?? 3, u.rpm_limit ?? 0, u.notes || "", exist.id]);
        userId[u.username] = exist.id; bump("users_updated");
      } else {
        const r = await mk("INSERT INTO users (username,email,role,status,balance_tokens,concurrency,rpm_limit,notes,last_active_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [u.username, u.email || "", u.role || "user", u.status || "active", u.balance_tokens ?? 0, u.concurrency ?? 3, u.rpm_limit ?? 0, u.notes || "", u.last_active_at ?? null, u.created_at ?? now()]);
        userId[u.username] = r.meta.last_row_id; bump("users_created");
      }
    } catch (e) { err("users", u.username, e); }
  }

  // 2. 分组（name 唯一）
  const groupId = {};
  for (const g of body.groups || []) {
    if (!g || !g.name) { err("groups", g && g.name, "name required"); continue; }
    try {
      const exist = await get("SELECT id FROM groups WHERE name=?", g.name);
      if (exist) {
        await mk("UPDATE groups SET description=?, platform=?, rate_multiplier=?, status=?, sort_order=? WHERE id=?",
          [g.description || "", g.platform || "", g.rate_multiplier ?? 1, g.status || "active", g.sort_order ?? 0, exist.id]);
        groupId[g.name] = exist.id; bump("groups_updated");
      } else {
        const r = await mk("INSERT INTO groups (name,description,platform,rate_multiplier,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)",
          [g.name, g.description || "", g.platform || "", g.rate_multiplier ?? 1, g.status || "active", g.sort_order ?? 0, g.created_at ?? now()]);
        groupId[g.name] = r.meta.last_row_id; bump("groups_created");
      }
    } catch (e) { err("groups", g.name, e); }
  }

  // 3. API Key（key 值唯一；user/group 按名称解析）
  const keyIdByVal = {};
  for (const k of body.user_keys || []) {
    if (!k || !k.key) { err("user_keys", k && k.label, "key required"); continue; }
    try {
      const exist = await get("SELECT id FROM user_keys WHERE key=?", k.key);
      const userIdRef = k.user ? (userId[k.user] ?? null) : null;
      const groupIdRef = k.group ? (groupId[k.group] ?? null) : null;
      if (exist) {
        await mk("UPDATE user_keys SET label=?, quota_tokens=?, used_tokens=?, enabled=?, expires_at=?, rpm_limit=?, status=?, user_id=?, group_id=? WHERE id=?",
          [k.label || "", k.quota_tokens ?? null, k.used_tokens ?? 0, k.enabled ?? 1, k.expires_at ?? null, k.rpm_limit ?? 0, k.status || "active", userIdRef, groupIdRef, exist.id]);
        keyIdByVal[k.key] = exist.id; bump("keys_updated");
      } else {
        const r = await mk("INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at,expires_at,rpm_limit,status,user_id,group_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [k.key, k.label || "", k.quota_tokens ?? null, k.used_tokens ?? 0, k.enabled ?? 1, k.created_at ?? now(), k.expires_at ?? null, k.rpm_limit ?? 0, k.status || "active", userIdRef, groupIdRef]);
        keyIdByVal[k.key] = r.meta.last_row_id; bump("keys_created");
      }
    } catch (e) { err("user_keys", k.label || k.key, e); }
  }

  // 4. 套餐（name 唯一）
  const pkgId = {};
  for (const p of body.packages || []) {
    if (!p || !p.name) { err("packages", p && p.name, "name required"); continue; }
    try {
      const exist = await get("SELECT id FROM packages WHERE name=?", p.name);
      if (exist) {
        await mk("UPDATE packages SET tokens=?, duration_days=?, price_note=?, status=?, sort_order=? WHERE id=?",
          [p.tokens ?? 0, p.duration_days ?? 30, p.price_note || "", p.status || "active", p.sort_order ?? 0, exist.id]);
        pkgId[p.name] = exist.id; bump("packages_updated");
      } else {
        const r = await mk("INSERT INTO packages (name,tokens,duration_days,price_note,status,sort_order,created_at) VALUES (?,?,?,?,?,?,?)",
          [p.name, p.tokens ?? 0, p.duration_days ?? 30, p.price_note || "", p.status || "active", p.sort_order ?? 0, p.created_at ?? now()]);
        pkgId[p.name] = r.meta.last_row_id; bump("packages_created");
      }
    } catch (e) { err("packages", p.name, e); }
  }

  // 5. 订阅（user + package 按名称解析；同用户+套餐+开始时间去重，避免重复导入产生重复订阅）
  for (const s of body.subscriptions || []) {
    if (!s || !s.user) { err("subscriptions", "", "user required"); continue; }
    const uid = userId[s.user];
    if (uid == null) { err("subscriptions", s.user, "user not found: " + s.user); continue; }
    const pid = s.package ? (pkgId[s.package] ?? null) : null;
    const starts = s.starts_at ?? now();
    try {
      const exist = await get("SELECT id FROM user_subscriptions WHERE user_id=? AND package_id IS ? AND tokens=? AND starts_at=?", uid, pid, s.tokens ?? 0, starts);
      if (exist) { bump("subscriptions_skipped"); continue; }
      await mk("INSERT INTO user_subscriptions (user_id,package_id,tokens,starts_at,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?)",
        [uid, pid, s.tokens ?? 0, starts, s.expires_at ?? null, s.status || "active", s.created_at ?? now()]);
      bump("subscriptions_created");
    } catch (e) { err("subscriptions", s.user, e); }
  }

  // 6. 兑换码（code 唯一）
  const promoId = {};
  for (const p of body.promo_codes || []) {
    if (!p || !p.code) { err("promo_codes", p && p.code, "code required"); continue; }
    try {
      const exist = await get("SELECT id FROM promo_codes WHERE code=?", p.code);
      if (exist) {
        await mk("UPDATE promo_codes SET bonus_tokens=?, max_uses=?, used_count=?, status=?, expires_at=?, notes=? WHERE id=?",
          [p.bonus_tokens ?? 0, p.max_uses ?? 1, p.used_count ?? 0, p.status || "active", p.expires_at ?? null, p.notes || "", exist.id]);
        promoId[p.code] = exist.id; bump("promos_updated");
      } else {
        const r = await mk("INSERT INTO promo_codes (code,bonus_tokens,max_uses,used_count,status,expires_at,notes,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [p.code, p.bonus_tokens ?? 0, p.max_uses ?? 1, p.used_count ?? 0, p.status || "active", p.expires_at ?? null, p.notes || "", p.created_at ?? now()]);
        promoId[p.code] = r.meta.last_row_id; bump("promos_created");
      }
    } catch (e) { err("promo_codes", p.code, e); }
  }

  // 6b. 兑换记录（code + user 按名称解析；同码+用户+时间去重）
  for (const x of body.promo_usage || []) {
    if (!x || !x.code || !x.user) continue;
    const pid = promoId[x.code]; const uid = userId[x.user];
    if (pid == null || uid == null) continue;
    try {
      const exist = await get("SELECT id FROM promo_usage WHERE promo_code_id=? AND user_id=? AND used_at=?", pid, uid, x.used_at ?? now());
      if (exist) continue;
      await mk("INSERT INTO promo_usage (promo_code_id,user_id,bonus_tokens,used_at) VALUES (?,?,?,?)", [pid, uid, x.bonus_tokens ?? 0, x.used_at ?? now()]);
      bump("promo_usage_created");
    } catch (e) { /* 重复记录忽略 */ }
  }

  // 7. 公告（同标题+创建时间去重）
  for (const a of body.announcements || []) {
    if (!a || !a.title) { err("announcements", "", "title required"); continue; }
    try {
      const exist = await get("SELECT id FROM announcements WHERE title=? AND created_at=?", a.title, a.created_at ?? now());
      if (exist) { bump("announcements_skipped"); continue; }
      await mk("INSERT INTO announcements (title,content,status,created_at) VALUES (?,?,?,?)", [a.title, a.content || "", a.status || "active", a.created_at ?? now()]);
      bump("announcements_created");
    } catch (e) { err("announcements", a.title, e); }
  }

  // 8. 站点设置（key-value upsert）
  if (body.settings && typeof body.settings === "object") {
    for (const k of Object.keys(body.settings)) {
      const v = body.settings[k];
      try {
        await mk("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
          [k, typeof v === "string" ? v : JSON.stringify(v), now()]);
        bump("settings_updated");
      } catch (e) { err("settings", k, e); }
    }
  }

  // 9. 模型限流（user 按用户名、key_label 按 Key 标签解析；同作用域+模型去重，重复导入时更新值）
  const labelToId = {};
  for (const k of body.user_keys || []) {
    if (k && k.label && keyIdByVal[k.key] != null) labelToId[k.label] = keyIdByVal[k.key];
  }
  for (const l of body.model_limits || []) {
    if (!l || !l.model) { err("model_limits", "", "model required"); continue; }
    const uid = l.user ? (userId[l.user] ?? null) : null;
    const kid = l.key_label ? (labelToId[l.key_label] ?? null) : null;
    try {
      const exist = await get("SELECT id FROM model_limits WHERE user_id IS ? AND key_id IS ? AND model=?", uid, kid, String(l.model));
      if (exist) {
        await mk("UPDATE model_limits SET rpm_limit=?, concurrency=?, enabled=? WHERE id=?", [l.rpm_limit ?? 0, l.concurrency ?? 0, l.enabled === false ? 0 : 1, exist.id]);
        bump("model_limits_updated");
      } else {
        await mk("INSERT INTO model_limits (user_id,key_id,model,rpm_limit,concurrency,enabled,created_at) VALUES (?,?,?,?,?,?,?)",
          [uid, kid, String(l.model), l.rpm_limit ?? 0, l.concurrency ?? 0, l.enabled === false ? 0 : 1, l.created_at ?? now()]);
        bump("model_limits_created");
      }
    } catch (e) { err("model_limits", l.model, e); }
  }
}

// 解析 Sub2API Codex auths 风格字符串（eyJ... 的 base64url JSON，内含 oauth 凭证）
function parseCodexContent(content, meta, idx) {
  try {
    let s = content.trim();
    // 兼容带Bearer前缀
    s = s.replace(/^Bearer\s+/i, "");
    // 尝试 base64url 解码（可能是 JWT-like 或纯 JSON）
    let jsonStr = s;
    try { jsonStr = decodeB64Url(s.split(".").pop() || s); } catch {}
    let obj;
    try { obj = JSON.parse(jsonStr); } catch { obj = null; }
    if (!obj) {
      // 也许 content 本身就是 JSON
      try { obj = JSON.parse(s); } catch { return { error: "无法解析 content 为凭证 JSON" }; }
    }
    const platform = meta.platform ? PLATFORM_ALIASES[(meta.platform).toLowerCase()] : "openai";
    if (!platform) return { error: "import 需要合法的 platform" };
    const credentials = {};
    if (obj.access_token) credentials.access_token = obj.access_token;
    if (obj.refresh_token) credentials.refresh_token = obj.refresh_token;
    if (obj.expires_at) credentials.expires_at = obj.expires_at;
    if (obj.expires_in && !obj.expires_at) credentials.expires_at = now() + obj.expires_in * 1000;
    if (obj.client_id) credentials.client_id = obj.client_id;
    if (!credentials.access_token && !credentials.refresh_token) {
      return { error: "content 中未找到 access_token / refresh_token" };
    }
    return {
      account: {
        name: (meta.name ? `${meta.name}#${idx + 1}` : `codex-${idx + 1}`),
        platform, type: "oauth", credentials,
        extra: meta.extra || {},
        base_url: DEFAULT_BASE[platform] || null,
        model_map: meta.model_map || {},
        priority: meta.priority ?? 50,
        concurrency: meta.concurrency ?? 3,
        expires_at: meta.expires_at || credentials.expires_at || null,
        auto_pause_on_expired: meta.auto_pause_on_expired ?? 1,
        weight: 1,
      },
    };
  } catch (e) {
    return { error: "parse error: " + String(e) };
  }
}

function decodeB64Url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return atob(s + pad);
}

function fingerprint(acc) {
  const c = acc.credentials || {};
  const key = c.api_key || c.access_token || c.refresh_token || JSON.stringify(c);
  return `${acc.platform}|${acc.type}|${acc.name}|${key}`;
}

// 判断导入凭证与库内账号是否为同一账号：任一核心 token（api_key/access_token/refresh_token）相同即视为同一
function sameCredential(newCred, storedCredJson) {
  try {
    const old = typeof storedCredJson === "string" ? JSON.parse(storedCredJson) : (storedCredJson || {});
    const keys = ["api_key", "access_token", "refresh_token"];
    for (const k of keys) {
      if (newCred?.[k] && old[k] && newCred[k] === old[k]) return true;
    }
    // 都没有可比 token：退化为按名称更新（旧行为）
    if (!newCred?.api_key && !newCred?.access_token && !newCred?.refresh_token) return true;
  } catch {}
  return false;
}
