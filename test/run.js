// test/run.js
// Sub2API-CF 端到端测试 harness。
// 用 node:sqlite 模拟 D1、用 mock fetch 模拟上游，直接调用真实的 src/index.js handler，
// 跑通「鉴权 → LRU 选账号 → 上游协议适配 → 流式转换 → 用量落库 → 额度 → 管理 API」全链路。
import worker, { __resetRuntimeState } from "../src/index.js";
import {
  buildUpstream,
  openaiPassTranslator,
  anthropicToOpenAI,
  geminiToOpenAI,
  anthropicReqToOpenAI,
  geminiReqToOpenAI,
  responsesReqToOpenAI,
  openAIRespToAnthropic,
  openAIRespToGemini,
  openAIRespToResponses,
  collectModels,
  estimateTokens,
  DEFAULT_MODELS,
} from "../src/relay.js";
import { makeD1 } from "./d1.js";
import { installFetchMock } from "./mock-fetch.js";

// ---------- 极简测试框架 ----------
let pass = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    failures.push(msg);
    throw new Error(msg);
  }
}
function eq(a, b, msg) {
  assert(a === b, `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`);
}
function includes(hay, needle, msg) {
  assert(hay && hay.includes(needle), `${msg} (应含 ${JSON.stringify(needle)})`);
}
async function test(name, fn) {
  try {
    await fn();
    console.log("  \x1b[32m✓\x1b[0m", name);
  } catch (e) {
    console.log("  \x1b[31m✗\x1b[0m", name, "\x1b[31m->\x1b[0m", e.message);
  }
}

// ---------- 测试工具 ----------
function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => {
      pending.push(p);
      return p;
    },
    async drain() {
      for (const p of pending) {
        try {
          await p;
        } catch (e) {
          console.log("    (waitUntil error:", e.message, ")");
        }
      }
      pending.length = 0;
    },
  };
}
async function readBody(res) {
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
    return out;
  }
  return await res.text();
}
function parseSSE(text) {
  const events = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      events.push({ done: true });
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return events;
}
function setup() {
  const db = makeD1();
  db.migrate();
  const env = { DB: db, ADMIN_EMAIL: "admin@test.com", ADMIN_PASSWORD: "test-pass" };
  const ctx = makeCtx();
  __resetRuntimeState(); // 清空跨测试残留的进程内限流/并发计数
  return { db, env, ctx };
}
async function seedAccount(db, acct) {
  // 兼容新旧字段：新 v2 表优先
  const existsV2 = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts_v2'").first();
  if (existsV2) {
    const norm = {
      name: acct.name,
      platform: acct.provider || acct.platform,
      type: acct.type || "api_key",
      credentials: acct.credentials || { api_key: acct.api_key },
      base_url: acct.base_url || DEFAULT_BASE[(acct.provider || acct.platform)],
      model_map: acct.model_map || {},
      priority: acct.priority ?? 50,
    };
    await db
      .prepare(`INSERT INTO accounts_v2
        (name,platform,type,credentials,extra,model_map,base_url,priority,concurrency,status,schedulable,expires_at,auto_pause_on_expired,usage_tokens,error_message,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(norm.name, norm.platform, norm.type, JSON.stringify(norm.credentials), "{}",
        JSON.stringify(norm.model_map), norm.base_url, norm.priority, 3, "active", 1,
        acct.expires_at || null, 1, 0, null, Date.now())
      .run();
    return;
  }
  await db
    .prepare(
      "INSERT INTO accounts (provider,name,api_key,base_url,model_map,weight,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .bind(acct.provider, acct.name, acct.api_key, acct.base_url || "", JSON.stringify(acct.model_map || {}), acct.weight || 1, 1, Date.now())
    .run();
}

// 直接插入 v2 账号（测试调度窗口用）
async function seedAccountV2(db, acct) {
  await db
    .prepare(`INSERT INTO accounts_v2
      (name,platform,type,credentials,extra,model_map,base_url,priority,concurrency,status,schedulable,rate_limit_reset_at,overload_until,temp_unschedulable_until,expires_at,auto_pause_on_expired,usage_tokens,error_message,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(acct.name, acct.platform, acct.type || "api_key",
      JSON.stringify(acct.credentials || { api_key: "k" }), "{}",
      JSON.stringify(acct.model_map || {}), acct.base_url || DEFAULT_BASE[acct.platform],
      acct.priority ?? 50, acct.concurrency ?? 3, acct.status ?? "active",
      acct.schedulable ?? 1, acct.rate_limit_reset_at || null, acct.overload_until || null,
      acct.temp_unschedulable_until || null, acct.expires_at || null, acct.auto_pause_on_expired ?? 1, 0, null, Date.now())
    .run();
}

import { DEFAULT_BASE } from "../src/relay.js";
async function seedKey(db, quota = null) {
  const key = "sk-" + crypto.randomUUID().replace(/-/g, "");
  await db
    .prepare("INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at) VALUES (?,?,?,?,?,?)")
    .bind(key, "k", quota, 0, 1, Date.now())
    .run();
  return key;
}

// ============================================================
//  UNIT TESTS —— relay.js 协议适配层
// ============================================================
async function unitTests() {
  console.log("\n\x1b[1m[Unit] relay.js 协议适配\x1b[0m");

  await test("buildUpstream: openai 非流式", () => {
    const up = buildUpstream(
      { provider: "openai", api_key: "k", base_url: "", model_map: "{}" },
      { model: "gpt-4o" }
    );
    eq(up.url, "https://api.openai.com/v1/chat/completions", "openai url");
    eq(up.headers.authorization, "Bearer k", "openai auth");
    eq(JSON.parse(up.body).stream, false, "openai stream=false");
  });

  await test("buildUpstream: openai 流式自动注入 stream_options.include_usage", () => {
    const up = buildUpstream(
      { provider: "openai", api_key: "k", base_url: "", model_map: "{}" },
      { model: "gpt-4o", stream: true }
    );
    eq(up.isStream, true, "openai isStream");
    const b = JSON.parse(up.body);
    eq(b.stream, true, "openai body.stream=true");
    eq(b.stream_options.include_usage, true, "自动注入 include_usage");
  });

  await test("buildUpstream: openai 流式不覆盖客户端已有 stream_options", () => {
    const up = buildUpstream(
      { provider: "openai", api_key: "k", base_url: "", model_map: "{}" },
      { model: "gpt-4o", stream: true, stream_options: { include_usage: false, other: 1 } }
    );
    const b = JSON.parse(up.body);
    eq(b.stream_options.include_usage, true, "仍强制 include_usage=true");
    eq(b.stream_options.other, 1, "保留客户端其它 stream_options");
  });

  await test("buildUpstream: anthropic 拆分 system 消息", () => {
    const up = buildUpstream(
      { provider: "anthropic", api_key: "k", base_url: "", model_map: "{}" },
      {
        model: "claude-3",
        max_tokens: 100,
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi" },
        ],
      }
    );
    eq(up.url, "https://api.anthropic.com/v1/messages", "anthropic url");
    eq(up.headers["x-api-key"], "k", "anthropic x-api-key");
    eq(up.headers["anthropic-version"], "2023-06-01", "anthropic-version");
    const b = JSON.parse(up.body);
    eq(b.system, "be nice", "system 字段");
    eq(b.messages.length, 1, "user 消息保留");
    eq(b.messages[0].role, "user", "user role");
    eq(b.max_tokens, 100, "max_tokens 透传");
  });

  await test("buildUpstream: gemini 流式 url 带 alt=sse", () => {
    const up = buildUpstream(
      { provider: "gemini", api_key: "k", base_url: "", model_map: "{}" },
      { model: "gemini-1.5", messages: [{ role: "user", content: "hi" }], stream: true }
    );
    includes(up.url, "/v1beta/models/gemini-1.5:streamGenerateContent?alt=sse", "gemini 流式 url");
  });

  await test("anthropicToOpenAI: 非流式转换", () => {
    const o = anthropicToOpenAI(
      { content: [{ text: "hi" }], usage: { input_tokens: 2, output_tokens: 1 }, stop_reason: "end_turn" },
      "claude"
    );
    eq(o.choices[0].message.content, "hi", "内容");
    eq(o.usage.prompt_tokens, 2, "prompt_tokens");
    eq(o.usage.completion_tokens, 1, "completion_tokens");
    eq(o.choices[0].finish_reason, "stop", "finish_reason");
  });

  await test("geminiToOpenAI: 非流式转换", () => {
    const o = geminiToOpenAI(
      { candidates: [{ content: { parts: [{ text: "yo" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } },
      "gem"
    );
    eq(o.choices[0].message.content, "yo", "内容");
    eq(o.usage.prompt_tokens, 1, "prompt_tokens");
    eq(o.usage.completion_tokens, 2, "completion_tokens");
  });

  await test("openaiPassTranslator: 透传并捕获 usage", () => {
    const state = { usage: null };
    const chunks = openaiPassTranslator.onData(
      JSON.stringify({ choices: [{ delta: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      state
    );
    eq(state.usage.prompt_tokens, 1, "捕获 prompt_tokens");
    eq(chunks[0].usage.prompt_tokens, 1, "chunk 带 usage");
  });

  await test("anthropicReqToOpenAI: 拆分 system + 转角色", () => {
    const o = anthropicReqToOpenAI({
      model: "claude-3",
      max_tokens: 100,
      stream: true,
      system: "be nice",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "yo" }] },
      ],
    });
    eq(o.model, "claude-3", "model");
    eq(o.stream, true, "stream");
    eq(o.messages[0].role, "system", "首条为 system");
    eq(o.messages[0].content, "be nice", "system 内容");
    eq(o.messages[1].role, "user", "user 角色");
    eq(o.messages[2].role, "assistant", "assistant 角色");
    eq(o.messages[2].content, "yo", "text block 内容");
  });

  await test("geminiReqToOpenAI: contents/generationConfig 转换", () => {
    const o = geminiReqToOpenAI({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { parts: [{ text: "sys" }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 512, topP: 0.9 },
    }, "gemini-2.5-flash", true);
    eq(o.model, "gemini-2.5-flash", "URL 模型名注入");
    eq(o.stream, true, "stream 由 action 决定");
    eq(o.max_tokens, 512, "maxOutputTokens -> max_tokens");
    eq(o.messages[0].role, "system", "systemInstruction -> system");
    eq(o.messages[1].role, "user", "user 内容");
  });

  await test("openAIRespToAnthropic: 非流式转 Anthropic", () => {
    const a = openAIRespToAnthropic(
      { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      "claude-3"
    );
    eq(a.type, "message", "type=message");
    eq(a.content[0].text, "hi", "text");
    eq(a.usage.input_tokens, 2, "input_tokens");
    eq(a.usage.output_tokens, 1, "output_tokens");
    eq(a.stop_reason, "end_turn", "stop_reason");
  });

  await test("openAIRespToGemini: 非流式转 Gemini", () => {
    const g = openAIRespToGemini(
      { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      "gemini-2.5-flash"
    );
    eq(g.candidates[0].content.parts[0].text, "hi", "parts text");
    eq(g.usageMetadata.promptTokenCount, 2, "promptTokenCount");
    eq(g.usageMetadata.candidatesTokenCount, 1, "candidatesTokenCount");
  });

  await test("responsesReqToOpenAI: /v1/responses 请求转 chat", () => {
    const o = responsesReqToOpenAI({
      model: "gpt-4o",
      instructions: "你是个助手",
      input: [
        { role: "user", content: [{ type: "input_text", text: "你好" }] },
        { role: "developer", content: "规则" },
      ],
      max_output_tokens: 512,
      stream: true,
      tools: [{ type: "function", name: "get_weather", description: "查天气", parameters: { type: "object" } }],
    });
    eq(o.model, "gpt-4o", "model");
    eq(o.messages.length, 3, "system + user + developer->system");
    eq(o.messages[0].role, "system", "instructions -> system");
    eq(o.messages[0].content, "你是个助手", "instructions 内容");
    eq(o.messages[1].role, "user", "input user 角色");
    eq(o.messages[1].content, "你好", "input 内容取 text");
    eq(o.messages[2].role, "system", "developer -> system");
    eq(o.max_tokens, 512, "max_output_tokens -> max_tokens");
    eq(o.stream, true, "stream");
    eq(o.tools[0].type, "function", "tool type");
    eq(o.tools[0].function.name, "get_weather", "tool function.name");
    // input 为字符串
    const s = responsesReqToOpenAI({ model: "gpt-4o", input: "直接问" });
    eq(s.messages.length, 1, "字符串 input -> 1 条");
    eq(s.messages[0].role, "user", "字符串 input 角色");
    eq(s.messages[0].content, "直接问", "字符串 input 内容");
  });

  await test("openAIRespToResponses: 非流式转 Responses", () => {
    const r = openAIRespToResponses(
      { id: "chatcmpl-abc", created: 1700000000, choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
      "gpt-4o"
    );
    eq(r.object, "response", "object=response");
    eq(r.status, "completed", "status");
    eq(r.output[0].type, "message", "output 是 message");
    eq(r.output[0].content[0].type, "output_text", "content 是 output_text");
    eq(r.output[0].content[0].text, "hi", "文本内容");
    eq(r.usage.input_tokens, 2, "input_tokens");
    eq(r.usage.output_tokens, 1, "output_tokens");
    eq(r.usage.total_tokens, 3, "total_tokens");
  });

  await test("collectModels: 优先 model_map 对外名，缺省平台默认", () => {
    const ids = collectModels([
      { platform: "openai", model_map: { "my-gpt": "gpt-4o" } },
      { platform: "gemini", model_map: {} },
    ]);
    assert(ids.includes("my-gpt"), "model_map 对外名");
    assert(ids.includes("gemini-2.5-pro"), "gemini 默认模型");
  });

  await test("estimateTokens: 粗估非零", () => {
    const n = estimateTokens({ model: "x", system: "hello", messages: [{ role: "user", content: "hello world" }] });
    assert(n > 0, "估算 > 0");
    eq(n, Math.max(1, Math.ceil(5 / 4)) + Math.max(1, Math.ceil(11 / 4)), "估算值");
  });
}

// ============================================================
//  INTEGRATION TESTS —— 直接调用真实 handler
// ============================================================
async function integrationTests(mock) {
  console.log("\n\x1b[1m[Integration] index.js 全链路\x1b[0m");

  await test("GET /health 返回 ok", async () => {
    const { env, ctx } = setup();
    const r = await worker.fetch(new Request("https://x/health"), env, ctx);
    const j = await r.json();
    eq(j.ok, true, "health.ok");
    eq(j.service, "sub2api-cf", "service 名");
  });

  await test("裸域名 / 302 跳转到 /admin", async () => {
    const { env, ctx } = setup();
    const r = await worker.fetch(new Request("https://x/"), env, ctx);
    eq(r.status, 302, "status 302");
    eq(new URL(r.headers.get("location")).pathname, "/admin", "Location 指向 /admin");
  });

  await test("/admin 返回后台 HTML", async () => {
    const { env, ctx } = setup();
    const r = await worker.fetch(new Request("https://x/admin"), env, ctx);
    eq(r.status, 200, "status 200");
    const t = await r.text();
    assert(t.includes("管理后台"), "含后台标题");
    assert(t.includes('id="login_email"'), "含登录表单");
  });

  await test("无 key 调用 /v1/chat/completions -> 401", async () => {
    const { env, ctx } = setup();
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 401, "status 401");
  });

  await test("管理 API 无 token -> 401，有 token -> 200", async () => {
    const { env, ctx } = setup();
    const noTok = await worker.fetch(new Request("https://x/admin/stats"), env, ctx);
    eq(noTok.status, 401, "无 token 401");
    const withTok = await worker.fetch(
      new Request("https://x/admin/stats", { headers: { authorization: "Basic " + btoa("admin@test.com:test-pass") } }),
      env,
      ctx
    );
    eq(withTok.status, 200, "有 token 200");
    const j = await withTok.json();
    assert("total_tokens" in j && "active_accounts" in j, "stats 字段齐全");
  });

  await test("管理 API 建账号/建 key (真实 D1 写)", async () => {
    const { env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const a = await worker.fetch(
      new Request("https://x/admin/accounts", { method: "POST", headers: H, body: JSON.stringify({ name: "acc", platform: "openai", type: "api_key", credentials: { api_key: "sk-x" } }) }),
      env,
      ctx
    );
    eq(a.status, 200, "建账号 200");
    const k = await worker.fetch(
      new Request("https://x/admin/keys", { method: "POST", headers: H, body: JSON.stringify({ label: "k1", quota_tokens: 500 }) }),
      env,
      ctx
    );
    const kj = await k.json();
    eq(k.status, 200, "建 key 200");
    assert(kj.key.startsWith("sk-"), "返回 sk- 前缀 key");
    const list = await worker.fetch(new Request("https://x/admin/keys", { headers: H }), env, ctx);
    const rows = await list.json();
    eq(rows.length, 1, "库里恰好 1 个 key");
  });

  await test("OpenAI 非流式：响应 + 用量落库", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.choices[0].message.content, "Hello world", "内容正确");
    eq(j.usage.total_tokens, 8, "usage 正确");
    await ctx.drain();
    const log = await db.prepare("SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) AS t FROM usage_logs").first();
    eq(log.t, 8, "用量落库 8 token");
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "key 已扣额度");
  });

  await test("OpenAI 流式：SSE 转换 + 末尾 [DONE] + 用量落库", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env,
      ctx
    );
    eq(r.status, 200, "status 200");
    eq(r.headers.get("content-type").includes("text/event-stream"), true, "SSE content-type");
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    const contents = evs.filter((e) => e.choices && e.choices[0].delta.content).map((e) => e.choices[0].delta.content);
    eq(contents.join(""), "Hello world", "流式内容拼接");
    assert(evs.some((e) => e.done), "以 [DONE] 结尾");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "流式用量落库 8 token");
  });

  await test("Anthropic 流式：转成 OpenAI SSE", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "anthropic", name: "an", api_key: "sk-anthropic", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env,
      ctx
    );
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    const contents = evs.filter((e) => e.choices && e.choices[0].delta.content).map((e) => e.choices[0].delta.content);
    eq(contents.join(""), "Hello world", "anthropic 内容拼接");
    const last = evs.filter((e) => e.choices && e.choices[0].finish_reason).pop();
    eq(last.choices[0].finish_reason, "stop", "finish_reason=stop");
    await ctx.drain();
  });

  await test("Gemini 流式：转成 OpenAI SSE", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "gemini", name: "gm", api_key: "sk-gemini", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-1.5", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env,
      ctx
    );
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    const contents = evs.filter((e) => e.choices && e.choices[0].delta.content).map((e) => e.choices[0].delta.content);
    eq(contents.join(""), "Hello world", "gemini 内容拼接");
    await ctx.drain();
  });

  await test("额度耗尽 -> 429", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db, 0); // 额度 0
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 429, "status 429");
  });

  await test("Anthropic 非流式：JSON 转换 + 用量落库", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "anthropic", name: "an", api_key: "sk-anthropic", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.choices[0].message.content, "Hello world", "内容");
    eq(j.usage.total_tokens, 8, "usage");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "用量落库");
  });

  await test("Gemini 非流式：JSON 转换 + 用量落库", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "gemini", name: "gm", api_key: "sk-gemini", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-1.5", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.choices[0].message.content, "Hello world", "内容");
    eq(j.usage.total_tokens, 8, "usage");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "用量落库");
  });

  await test("流式上游报错：坏 key -> 401 透传（不静默空响应）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-bad-key", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env,
      ctx
    );
    eq(r.status, 401, "流式坏 key 也返回 401");
    const j = await r.json();
    assert(j.error, "透传上游错误体");
  });

  await test("非流式上游报错：坏 key -> 401 透传", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-bad-key", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 401, "非流式坏 key 401");
    const j = await r.json();
    assert(j.error, "透传上游错误体");
  });

  await test("全部账号禁用 -> 503", async () => {
    const { db, env, ctx } = setup();
    await db
      .prepare("INSERT INTO accounts (provider,name,api_key,base_url,model_map,weight,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind("openai", "off", "sk-x", "", "{}", 1, 0, Date.now())
      .run();
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    eq(r.status, 503, "无可用账号 503");
  });

  await test("模型映射：请求 gpt-4 转发为 gpt-4o", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "", model_map: { "gpt-4": "gpt-4o" } });
    const key = await seedKey(db);
    mock.calls.length = 0;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx
    );
    await r.json();
    const call = mock.calls.find((c) => c.host === "api.openai.com");
    eq(call.body.model, "gpt-4o", "上游收到映射后的模型名");
  });

  await test("LRU 轮询：两个账号交替被选中", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "A", api_key: "sk-A", base_url: "" });
    await seedAccount(db, { provider: "openai", name: "B", api_key: "sk-B", base_url: "" });
    const key = await seedKey(db);
    const openaiCalls = () =>
      mock.calls.filter((c) => c.host === "api.openai.com").map((c) => c.headers.authorization);
    const chat = async () => {
      mock.calls.length = 0;
      const r = await worker.fetch(
        new Request("https://x/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + key, "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
        ctx
      );
      await r.json();
      await ctx.drain();
      return openaiCalls()[0];
    };
    const first = await chat();
    const second = await chat();
    const third = await chat();
    assert(first && second && first !== second, "前两次选中不同账号");
    eq(first, third, "第三次回到第一个账号（LRU 循环）");
  });

  // ---------- 新增：导入 / 调度 / OAuth / cookie 拒绝 ----------

  await test("双格式导入：简化数组批量建账号", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", {
        method: "POST", headers: H,
        body: JSON.stringify([
          { name: "oa1", platform: "openai", type: "api_key", credentials: { api_key: "sk-arr-1" } },
          { name: "gm1", platform: "gemini", type: "api_key", credentials: { api_key: "key-g" } },
        ]),
      }),
      env, ctx
    );
    const j = await r.json();
    eq(j.total, 2, "total=2");
    eq(j.created, 2, "created=2");
    const list = await worker.fetch(new Request("https://x/admin/accounts", { headers: H }), env, ctx);
    const rows = await list.json();
    eq(rows.length, 2, "库里 2 个账号");
  });

  await test("导入去重：同名同平台重复导入 -> skipped/updated", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const one = { name: "dup", platform: "openai", type: "api_key", credentials: { api_key: "sk-dup" } };
    await worker.fetch(new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify([one]) }), env, ctx);
    const r2 = await worker.fetch(new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify([one]) }), env, ctx);
    const j2 = await r2.json();
    eq(j2.updated + j2.skipped, 1, "第二次重复被 skipped 或 updated");
  });

  await test("cookie/sessionKey 类型导入被拒绝", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", {
        method: "POST", headers: H,
        body: JSON.stringify([{ name: "ck", platform: "anthropic", type: "cookie", credentials: { session_key: "xxx" } }]),
      }),
      env, ctx
    );
    const j = await r.json();
    eq(j.failed, 1, "failed=1");
    assert(j.errors[0].message.includes("cookie"), "错误提示含 cookie");
  });

  await test("Sub2API 调度：rate_limit_reset_at 未来的账号被跳过", async () => {
    const { db, env, ctx } = setup();
    await seedAccountV2(db, { name: "blocked", platform: "openai", credentials: { api_key: "sk-x" }, rate_limit_reset_at: Date.now() + 60000 });
    await seedAccountV2(db, { name: "ok", platform: "openai", credentials: { api_key: "sk-y" } });
    const key = await seedKey(db);
    mock.calls.length = 0;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await r.json();
    await ctx.drain();
    const auths = mock.calls.filter((c) => c.host === "api.openai.com").map((c) => c.headers.authorization);
    eq(auths[0], "Bearer sk-y", "选中未限速的账号");
  });

  await test("Sub2API 调度：priority 小的优先", async () => {
    const { db, env, ctx } = setup();
    await seedAccountV2(db, { name: "low", platform: "openai", credentials: { api_key: "sk-low" }, priority: 80 });
    await seedAccountV2(db, { name: "high", platform: "openai", credentials: { api_key: "sk-high" }, priority: 10 });
    const key = await seedKey(db);
    mock.calls.length = 0;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await r.json();
    await ctx.drain();
    const auths = mock.calls.filter((c) => c.host === "api.openai.com").map((c) => c.headers.authorization);
    eq(auths[0], "Bearer sk-high", "priority 小的先选");
  });

  await test("模型维度路由：各账号只服务自己 model_map 声明的模型", async () => {
    const { db, env, ctx } = setup();
    // 两个 openai 账号，priority 相同；只有其中一个声明了 gpt-4o
    await seedAccountV2(db, { name: "ma-other", platform: "openai", credentials: { api_key: "sk-other" }, model_map: { "gpt-4o-mini": "gpt-4o-mini" }, priority: 10 });
    await seedAccountV2(db, { name: "ma-gpt4o", platform: "openai", credentials: { api_key: "sk-gpt4o" }, model_map: { "gpt-4o": "gpt-4o" }, priority: 20 });
    const key = await seedKey(db);
    const chat = async (model) => {
      mock.calls.length = 0;
      const r = await worker.fetch(
        new Request("https://x/v1/chat/completions", {
          method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        }), env, ctx
      );
      await r.json();
      await ctx.drain();
      const calls = mock.calls.filter((c) => c.host === "api.openai.com");
      return (calls[0] && calls[0].headers.authorization) || "";
    };
    eq(await chat("gpt-4o"), "Bearer sk-gpt4o", "gpt-4o 路由到声明它的账号（即使 priority 更大）");
    eq(await chat("gpt-4o-mini"), "Bearer sk-other", "gpt-4o-mini 路由到声明它的账号");
  });

  await test("OAuth 账号：即将过期时自动刷新（mock fetch 命中 refresh 端点）", async () => {
    // 装一个能识别 refresh 端点的 fetch mock
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = new URL(typeof url === "string" ? url : url.toString());
      if (u.host === "auth.openai.com" && u.pathname.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return orig(url, opts);
    };
    const { db, env, ctx } = setup();
    await seedAccountV2(db, {
      name: "oa-oauth", platform: "openai", type: "oauth",
      credentials: { access_token: "old-at", refresh_token: "old-rt", expires_at: Date.now() - 1000 },
    });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await r.json();
    await ctx.drain();
    const row = await db.prepare("SELECT credentials FROM accounts_v2 WHERE name=?").bind("oa-oauth").first();
    const cred = JSON.parse(row.credentials);
    eq(cred.access_token, "new-at", "OAuth token 已刷新");
    globalThis.fetch = orig;
  });

  await test("Grok 平台：OAuth 走 OpenAI 兼容协议", async () => {
    const { db, env, ctx } = setup();
    await seedAccountV2(db, { name: "grok1", platform: "grok", type: "api_key", credentials: { api_key: "sk-grok" } });
    const key = await seedKey(db);
    mock.calls.length = 0;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-3", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await r.json();
    await ctx.drain();
    const grokCalls = mock.calls.filter((c) => c.host === "api.x.ai");
    eq(grokCalls.length, 1, "请求发到 api.x.ai");
    eq(grokCalls[0].headers.authorization, "Bearer sk-grok", "带 Bearer key");
  });

  await test("诊断端点 /admin/diag + 令牌未配置提示", async () => {
    const { db, env, ctx } = setup();
    // 正常环境：令牌已配置、D1 已建表
    const d = await worker.fetch(new Request("https://x/admin/diag"), env, ctx).then((r) => r.json());
    eq(d.admin_configured, true, "管理员已配置");
    eq(d.d1_ok, true, "D1 建表正常");
    eq(d.d1_tables.accounts_v2, true, "accounts_v2 表存在");
    // 令牌没配：diag 明确指出 + admin API 返回明确提示
    const envNoTok = { DB: db }; // 无管理员账号配置
    const d2 = await worker.fetch(new Request("https://x/admin/diag"), envNoTok, ctx).then((r) => r.json());
    eq(d2.admin_configured, false, "diag 显示未配置");
    const r = await worker.fetch(new Request("https://x/admin/stats", { headers: { authorization: "Basic " + btoa("anything:wrong") } }), envNoTok, ctx);
    eq(r.status, 401, "未配置时 401");
    const j = await r.json();
    assert(/管理员账号未配置/.test(j.error), "提示未配置");
    // 有配置但凭证错 / 缺失：对应提示
    const r2 = await worker.fetch(new Request("https://x/admin/stats", { headers: { authorization: "Basic " + btoa("wrong@x.com:wrong") } }), env, ctx);
    const j2 = await r2.json();
    assert(/unauthorized/.test(j2.error), "提示未授权");
    const r3 = await worker.fetch(new Request("https://x/admin/stats"), env, ctx);
    const j3 = await r3.json();
    assert(/请先登录/.test(j3.error), "提示请先登录");
    // 正确令牌正常
    const ok = await worker.fetch(new Request("https://x/admin/stats", { headers: { authorization: "Basic " + btoa("admin@test.com:test-pass") } }), env, ctx);
    eq(ok.status, 200, "正确令牌 200");
  });

  await test("真实 Sub2API 备份导出格式 {accounts:[...],expires_at秒} 可导入", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    // 复刻 Sub2API ExportData 真实结构（外层 accounts、unix 秒 expires_at）
    const exportPayload = {
      version: 1,
      exported_at: "2026-07-18T08:14:00Z",
      accounts: [
        { name: "real-oa", notes: "备份", platform: "openai", type: "api_key",
          credentials: { api_key: "sk-real-1" }, concurrency: 3, priority: 50,
          rate_multiplier: 1.0, expires_at: 1999999999, auto_pause_on_expired: true },
        { name: "real-oauth", notes: "oauth备份", platform: "openai", type: "oauth",
          credentials: { access_token: "at", refresh_token: "rt", expires_at: 1999999999 },
          concurrency: 5, priority: 20 },
      ],
    };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify(exportPayload) }),
      env, ctx
    );
    const j = await r.json();
    eq(j.total, 2, "total=2");
    eq(j.created, 2, "created=2");
    const row = await db.prepare("SELECT credentials, extra, priority FROM accounts_v2 WHERE name=?").bind("real-oa").first();
    const cred = JSON.parse(row.credentials);
    eq(cred.api_key, "sk-real-1", "api_key 正确导入");
    eq(row.priority, 50, "priority 导入");
    // 验证 expires_at 秒已被转成毫秒
    const oauthRow = await db.prepare("SELECT credentials FROM accounts_v2 WHERE name=?").bind("real-oauth").first();
    const ocred = JSON.parse(oauthRow.credentials);
    eq(ocred.expires_at, 1999999999000, "expires_at 秒->毫秒转换");
  });

  // ============ 新增：协议兼容网关 + 数据导入/导出 ============

  await test("GET /v1/models 返回模型列表（OpenAI 风格）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-x", model_map: { "my-gpt": "gpt-4o" } });
    const key = await seedKey(db);
    const r = await worker.fetch(new Request("https://x/v1/models", { headers: { authorization: "Bearer " + key } }), env, ctx);
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.object, "list", "object=list");
    assert(j.data.some((m) => m.id === "my-gpt"), "含 model_map 对外模型");
  });

  await test("POST /v1/messages（Anthropic 入站）→ OpenAI 账号中转 → 回 Anthropic 响应", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-3", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.type, "message", "Anthropic type=message");
    eq(j.content[0].text, "Hello world", "内容");
    eq(j.usage.input_tokens, 5, "input_tokens");
    eq(j.usage.output_tokens, 3, "output_tokens");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "用量落库");
  });

  await test("POST /v1/messages（Anthropic 入站）→ Anthropic 账号直通", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "anthropic", name: "an", api_key: "sk-anthropic", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-3", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.type, "message", "Anthropic 原生响应");
    eq(j.content[0].text, "Hello world", "内容");
    eq(j.usage.input_tokens, 5, "input_tokens");
    await ctx.drain();
  });

  await test("POST /v1/messages 流式：Anthropic 入站 → OpenAI SSE 转回 Anthropic 事件", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    assert(evs.some((e) => e.type === "message_start"), "含 message_start");
    const texts = evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text);
    eq(texts.join(""), "Hello world", "文本拼接");
    assert(evs.some((e) => e.type === "message_stop"), "以 message_stop 结束");
    await ctx.drain();
  });

  // ============ Antigravity 真实网关（v1internal Gemini 协议） ============

  await test("POST /v1/chat/completions → Antigravity 账号（非流式，v1internal 转换）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, {
      provider: "antigravity", name: "ag", type: "oauth",
      credentials: { access_token: "ya29.test", refresh_token: "1//rt", project_id: "proj-1" },
    });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.choices[0].message.content, "Hello world", "Antigravity 上游文本");
    eq(j.usage.prompt_tokens, 5, "prompt_tokens");
    eq(j.usage.completion_tokens, 3, "completion_tokens");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "用量落库");
    // 上游请求体是 v1internal 格式：含 project + requestId + request.contents
    const call = mock.calls.find((c) => c.host === "cloudcode-pa.googleapis.com");
    assert(call, "确实打到 Antigravity 端点");
    eq(call.url.includes("/v1internal:generateContent"), true, "generateContent 端点");
    eq(call.body.project, "proj-1", "project_id 传入");
    eq(call.body.model, "claude-sonnet-4-6", "模型透传");
    eq(call.body.request.contents[0].parts[0].text, "hi", "消息转换");
  });

  await test("Antigravity 模型映射：claude-opus-4-6 → claude-opus-4-6-thinking 上游", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, {
      provider: "antigravity", name: "ag", type: "oauth",
      credentials: { access_token: "ya29.test", refresh_token: "1//rt", project_id: "proj-1" },
    });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const agCalls = mock.calls.filter((c) => c.host === "cloudcode-pa.googleapis.com");
    const call = agCalls[agCalls.length - 1];
    eq(call.body.model, "claude-opus-4-6-thinking", "默认别名映射");
    await ctx.drain();
  });

  await test("POST /v1/chat/completions → Antigravity 账号（流式 SSE）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, {
      provider: "antigravity", name: "ag", type: "oauth",
      credentials: { access_token: "ya29.test", refresh_token: "1//rt", project_id: "proj-1" },
    });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const sse = await readBody(r);
    const chunks = parseSSE(sse);
    const texts = chunks.filter((c) => c.choices && c.choices[0].delta && c.choices[0].delta.content).map((c) => c.choices[0].delta.content);
    eq(texts.join(""), "Hello world", "流式文本拼接");
    assert(chunks.some((c) => c.choices && c.choices[0].finish_reason === "stop"), "以 stop 结束");
    await ctx.drain();
  });

  await test("空响应自动重试：上游空流 → 自动切换下一个候选账号", async () => {
    const { db, env, ctx } = setup();
    // 账号 A：proj-empty（mock 返回空流）优先，账号 B：proj-ok 正常兜底
    await seedAccount(db, {
      provider: "antigravity", name: "ag-empty", type: "oauth",
      credentials: { access_token: "ya29.empty", refresh_token: "1//rt", project_id: "proj-empty" },
      priority: 1,
    });
    await seedAccount(db, {
      provider: "antigravity", name: "ag-ok", type: "oauth",
      credentials: { access_token: "ya29.ok", refresh_token: "1//rt", project_id: "proj-ok" },
      priority: 2,
    });
    const key = await seedKey(db);
    const callStart = mock.calls.length;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "重试后返回 200");
    const sse = await readBody(r);
    const chunks = parseSSE(sse);
    const texts = chunks.filter((c) => c.choices && c.choices[0].delta && c.choices[0].delta.content).map((c) => c.choices[0].delta.content);
    eq(texts.join(""), "Hello world", "内容来自第二个账号（重试成功）");
    const agCalls = mock.calls.slice(callStart).filter((c) => c.host === "cloudcode-pa.googleapis.com");
    eq(agCalls.length, 2, "两个候选账号都被尝试");
    eq(agCalls[0].body.project, "proj-empty", "先试空响应账号");
    eq(agCalls[1].body.project, "proj-ok", "再试正常账号");
    await ctx.drain();
  });

  await test("空响应自动重试（非流式）：上游空 JSON → 自动切换下一个候选账号", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, {
      provider: "antigravity", name: "ag-empty", type: "oauth",
      credentials: { access_token: "ya29.empty", refresh_token: "1//rt", project_id: "proj-empty" },
      priority: 1,
    });
    await seedAccount(db, {
      provider: "antigravity", name: "ag-ok", type: "oauth",
      credentials: { access_token: "ya29.ok", refresh_token: "1//rt", project_id: "proj-ok" },
      priority: 2,
    });
    const key = await seedKey(db);
    const callStart = mock.calls.length;
    const r = await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "重试后返回 200");
    const j = await r.json();
    eq(j.choices[0].message.content, "Hello world", "内容来自第二个账号（非流式重试成功）");
    const agCalls = mock.calls.slice(callStart).filter((c) => c.host === "cloudcode-pa.googleapis.com");
    eq(agCalls.length, 2, "两个候选账号都被尝试");
    await ctx.drain();
  });

  await test("POST /v1/messages（Anthropic 入站）→ Antigravity 账号（Claude 协议转换）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, {
      provider: "antigravity", name: "ag", type: "oauth",
      credentials: { access_token: "ya29.test", refresh_token: "1//rt", project_id: "proj-1" },
    });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.type, "message", "Anthropic 响应格式");
    eq(j.content[0].text, "Hello world", "内容");
    eq(j.usage.input_tokens, 5, "input_tokens");
    await ctx.drain();
  });

  await test("POST /v1/messages 流式（Anthropic 入站）→ Antigravity 账号", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, {
      provider: "antigravity", name: "ag", type: "oauth",
      credentials: { access_token: "ya29.test", refresh_token: "1//rt", project_id: "proj-1" },
    });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    assert(evs.some((e) => e.type === "message_start"), "含 message_start");
    const texts = evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text);
    eq(texts.join(""), "Hello world", "文本拼接");
    assert(evs.some((e) => e.type === "message_stop"), "以 message_stop 结束");
    await ctx.drain();
  });

  await test("Antigravity：不过期时间判断，token 保持原样（对齐原版语义）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, {
      provider: "antigravity", name: "ag", type: "oauth",
      credentials: { access_token: "ya29.stale", refresh_token: "1//rt", project_id: "proj-1", expires_at: Date.now() - 1000 },
    });
    const key = await seedKey(db);
    let refreshCalled = false;
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
        refreshCalled = true;
        return new Response(JSON.stringify({ access_token: "ya29.fresh", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return orig(url, opts);
    };
    try {
      const r = await worker.fetch(
        new Request("https://x/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + key, "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
        }),
        env, ctx
      );
      eq(r.status, 200, "调用成功");
      const j = await r.json();
      eq(j.choices[0].message.content, "Hello world", "内容");
      // token 保持原样，未触发刷新
      const row = await db.prepare("SELECT credentials FROM accounts_v2 WHERE name=?").bind("ag").first();
      const cred = JSON.parse(row.credentials);
      eq(cred.access_token, "ya29.stale", "token 未变（antigravity 不过期时间判断）");
      eq(refreshCalled, false, "未触发 Google 刷新");
    } finally {
      globalThis.fetch = orig;
    }
    await ctx.drain();
  });

  await test("POST /v1/responses（OpenAI Responses 入站，非流式）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", instructions: "你是个助手", input: "hi", max_output_tokens: 200 }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.object, "response", "object=response");
    eq(j.status, "completed", "status=completed");
    eq(j.output[0].type, "message", "output message");
    eq(j.output[0].content[0].type, "output_text", "output_text");
    eq(j.output[0].content[0].text, "Hello world", "文本");
    eq(j.usage.input_tokens, 5, "input_tokens");
    eq(j.usage.output_tokens, 3, "output_tokens");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "用量落库");
  });

  await test("POST /v1/responses 流式：Responses SSE 事件序列", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: [{ role: "user", content: "hi" }], stream: true }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    assert(evs.some((e) => e.type === "response.created"), "含 response.created");
    assert(evs.some((e) => e.type === "response.output_item.added"), "含 output_item.added");
    const deltas = evs.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta);
    eq(deltas.join(""), "Hello world", "文本拼接");
    assert(evs.some((e) => e.type === "response.output_text.done"), "含 output_text.done");
    assert(evs.some((e) => e.type === "response.completed"), "以 response.completed 结束");
    const done = evs.find((e) => e.done);
    assert(done, "以 [DONE] 收尾");
    await ctx.drain();
  });

  await test("POST /v1beta/models/{model}:generateContent（Gemini 入站）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "gemini", name: "gm", api_key: "key-g", base_url: "" });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1beta/models/gemini-2.5-flash:generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.candidates[0].content.parts[0].text, "Hello world", "Gemini 内容");
    eq(j.usageMetadata.promptTokenCount, 5, "promptTokenCount");
    await ctx.drain();
    const uk = await db.prepare("SELECT used_tokens FROM user_keys WHERE key=?").bind(key).first();
    eq(uk.used_tokens, 8, "用量落库");
  });

  await test("Gemini 原生流式（入站 → Antigravity）末尾 chunk 必须带 finishReason", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, {
      provider: "antigravity", name: "ag", type: "oauth",
      credentials: { access_token: "ya29.test", refresh_token: "1//rt", project_id: "proj-1" },
    });
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1beta/models/gemini-3.1-pro-high:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const sse = await readBody(r);
    const evs = parseSSE(sse);
    const texts = evs
      .flatMap((e) => (e.candidates || []).flatMap((c) => (c.content && c.content.parts || []).map((p) => p.text || "")))
      .filter(Boolean);
    eq(texts.join(""), "Hello world", "流式文本拼接");
    const fins = evs.flatMap((e) => (e.candidates || []).map((c) => c.finishReason).filter(Boolean));
    eq(fins.includes("STOP"), true, "流式末尾带 finishReason STOP（客户端依赖它判定结束）");
    await ctx.drain();
  });

  await test("GET /v1beta/models 返回 Gemini 风格模型列表", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "gemini", name: "gm", api_key: "key-g" });
    const key = await seedKey(db);
    const r = await worker.fetch(new Request("https://x/v1beta/models", { headers: { "x-goog-api-key": key } }), env, ctx);
    eq(r.status, 200, "status 200");
    const j = await r.json();
    assert(Array.isArray(j.models) && j.models.length > 0, "models 数组");
    assert(j.models[0].name.startsWith("models/"), "name 前缀 models/");
  });

  await test("POST /v1/messages/count_tokens 返回估算", async () => {
    const { db, env, ctx } = setup();
    const key = await seedKey(db);
    const r = await worker.fetch(
      new Request("https://x/v1/messages/count_tokens", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3", messages: [{ role: "user", content: "hello world" }] }),
      }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    assert(typeof j.input_tokens === "number" && j.input_tokens > 0, "input_tokens > 0");
  });

  await test("GET /v1/usage 返回 key 用量", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-openai" });
    const key = await seedKey(db);
    await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await ctx.drain();
    const r = await worker.fetch(new Request("https://x/v1/usage", { headers: { authorization: "Bearer " + key } }), env, ctx);
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.used_tokens, 8, "used_tokens=8");
    eq(j.calls, 1, "calls=1");
  });

  await test("POST /admin/accounts/data（sub2api-data 格式，proxies 跳过 + apikey 别名）", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const payload = {
      data: {
        type: "sub2api-data", version: 1, exported_at: "2026-07-18T08:14:00Z",
        proxies: [{ proxy_key: "p1", name: "proxy1", protocol: "http", host: "1.2.3.4", port: 8080, status: "active" }],
        accounts: [
          { name: "oa-apikey", platform: "openai", type: "apikey", credentials: { api_key: "sk-alias" }, priority: 40 },
          { name: "an-setup", platform: "anthropic", type: "setup-token", credentials: { access_token: "st-1" } },
          { name: "gm-provider", provider: "google", type: "apikey", api_key: "AIza-pv" },
        ],
      },
      skip_default_group_bind: true,
    };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/data", { method: "POST", headers: H, body: JSON.stringify(payload) }),
      env, ctx
    );
    const j = await r.json();
    eq(j.total, 3, "total=3");
    eq(j.created, 3, "created=3");
    const gm = await db.prepare("SELECT platform FROM accounts_v2 WHERE name=?").bind("gm-provider").first();
    eq(gm.platform, "gemini", "provider=google 归一为 gemini");
    eq(j.proxy_skipped, 1, "proxy_skipped=1");
    eq(j.account_created, 3, "account_created 兼容字段");
    const row = await db.prepare("SELECT type FROM accounts_v2 WHERE name=?").bind("oa-apikey").first();
    eq(row.type, "api_key", "apikey 别名归一为 api_key");
  });

  await test("GET /admin/accounts/data 导出 sub2api-data 格式", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "oa", api_key: "sk-export" });
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass") };
    const r = await worker.fetch(new Request("https://x/admin/accounts/data", { headers: H }), env, ctx);
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.type, "sub2api-data", "type=sub2api-data");
    assert(Array.isArray(j.accounts) && j.accounts.length === 1, "accounts 数组");
    assert(Array.isArray(j.proxies), "proxies 数组");
    eq(j.accounts[0].name, "oa", "账号名");
  });

  await test("完整备份导出/导入：用户/Key/分组/套餐/订阅/兑换码/公告/设置/限流全量回导", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    // 造一套完整数据
    await worker.fetch(new Request("https://x/admin/users", { method: "POST", headers: H, body: JSON.stringify({ username: "alice", email: "a@x.com", balance_tokens: 5000 }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/groups", { method: "POST", headers: H, body: JSON.stringify({ name: "VIP", platform: "openai" }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/packages", { method: "POST", headers: H, body: JSON.stringify({ name: "标准版", tokens: 1000000, duration_days: 30 }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/keys", { method: "POST", headers: H, body: JSON.stringify({ label: "alice-key", user_id: 1, group_id: 1 }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/subscriptions", { method: "POST", headers: H, body: JSON.stringify({ user_id: 1, package_id: 1 }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/promos", { method: "POST", headers: H, body: JSON.stringify({ code: "MIGRATE", bonus_tokens: 999 }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/announcements", { method: "POST", headers: H, body: JSON.stringify({ title: "迁移公告", content: "hi" }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/settings", { method: "POST", headers: H, body: JSON.stringify({ site_name: "CF-OLD" }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/model-limits", { method: "POST", headers: H, body: JSON.stringify({ user_id: 1, model: "gpt-4o", rpm_limit: 30 }) }), env, ctx);
    // 导出
    const r = await worker.fetch(new Request("https://x/admin/accounts/data", { headers: H }), env, ctx);
    eq(r.status, 200, "导出 200");
    const j = await r.json();
    eq(j.type, "sub2api-data", "头部兼容原版");
    eq(j.version, 1, "版本 1（原版可导入）");
    eq(j.users.length, 1, "导出含用户");
    eq(j.groups.length, 1, "导出含分组");
    eq(j.user_keys.length, 1, "导出含 Key");
    eq(j.user_keys[0].user, "alice", "Key 带用户名");
    eq(j.user_keys[0].group, "VIP", "Key 带分组名");
    eq(j.subscriptions.length, 1, "导出含订阅");
    eq(j.subscriptions[0].user, "alice", "订阅带用户名");
    eq(j.subscriptions[0].package, "标准版", "订阅带套餐名");
    eq(j.promo_codes.length, 1, "导出含兑换码");
    eq(j.announcements.length, 1, "导出含公告");
    eq(j.settings.site_name, "CF-OLD", "导出含设置");
    eq(j.model_limits.length, 1, "导出含限流规则");
    eq(j.model_limits[0].user, "alice", "限流规则带用户名");

    // 全新实例回导（跨实例迁移）
    const db2 = makeD1(); db2.migrate();
    const env2 = { DB: db2, ADMIN_EMAIL: "admin@test.com", ADMIN_PASSWORD: "test-pass" };
    const ctx2 = makeCtx();
    const r2 = await worker.fetch(new Request("https://x/admin/accounts/data", { method: "POST", headers: H, body: JSON.stringify({ data: j }) }), env2, ctx2);
    eq(r2.status, 200, "回导 200");
    const res = await r2.json();
    eq(res.users_created, 1, "用户已建");
    eq(res.groups_created, 1, "分组已建");
    eq(res.keys_created, 1, "Key 已建");
    eq(res.subscriptions_created, 1, "订阅已建");
    eq(res.promos_created, 1, "兑换码已建");
    eq(res.announcements_created, 1, "公告已建");
    eq(res.model_limits_created, 1, "限流规则已建");
    assert(res.settings_updated >= 1, "设置已建");
    // 校验跨表关系与字段保留
    const k = await db2.prepare("SELECT user_id,group_id FROM user_keys WHERE label=?").bind("alice-key").first();
    eq(k.user_id, 1, "Key 绑定用户 id=1");
    eq(k.group_id, 1, "Key 绑定分组 id=1");
    const u = await db2.prepare("SELECT balance_tokens FROM users WHERE username=?").bind("alice").first();
    eq(u.balance_tokens, 1005000, "用户余额保留（5000 + 订阅套餐 1000000）");
    const sub = await db2.prepare("SELECT package_id FROM user_subscriptions WHERE user_id=1").first();
    eq(sub.package_id, 1, "订阅绑定套餐 id=1");
    const ml = await db2.prepare("SELECT user_id,rpm_limit FROM model_limits WHERE model=?").bind("gpt-4o").first();
    eq(ml.user_id, 1, "限流绑定用户");
    eq(ml.rpm_limit, 30, "限流值保留");
    const st = await db2.prepare("SELECT value FROM settings WHERE key=?").bind("site_name").first();
    eq(st.value, "CF-OLD", "设置保留");
    const ann = await db2.prepare("SELECT title FROM announcements").first();
    eq(ann.title, "迁移公告", "公告保留");
    // 重复导入同一备份：不产生重复数据（幂等）
    await worker.fetch(new Request("https://x/admin/accounts/data", { method: "POST", headers: H, body: JSON.stringify({ data: j }) }), env2, ctx2);
    const cnt = async (sql) => (await db2.prepare(sql).first()).n;
    eq(await cnt("SELECT COUNT(*) AS n FROM users"), 1, "重复导入用户不重复");
    eq(await cnt("SELECT COUNT(*) AS n FROM groups"), 1, "重复导入分组不重复");
    eq(await cnt("SELECT COUNT(*) AS n FROM user_keys"), 1, "重复导入 Key 不重复");
    eq(await cnt("SELECT COUNT(*) AS n FROM packages"), 1, "重复导入套餐不重复");
    eq(await cnt("SELECT COUNT(*) AS n FROM user_subscriptions"), 1, "重复导入订阅不重复");
    eq(await cnt("SELECT COUNT(*) AS n FROM promo_codes"), 1, "重复导入兑换码不重复");
    eq(await cnt("SELECT COUNT(*) AS n FROM announcements"), 1, "重复导入公告不重复");
    eq(await cnt("SELECT COUNT(*) AS n FROM model_limits"), 1, "重复导入限流不重复");
  });

  await test("POST /admin/accounts/import 支持 NDJSON（每行一个账号对象）", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const ndjson = JSON.stringify({ id: 1, name: "acc-a", platform: "openai", type: "oauth", credentials: { access_token: "sk-a", refresh_token: "rt-a", expires_at: 1700000000 } })
      + "\n"
      + JSON.stringify({ id: 2, name: "acc-b", platform: "gemini", type: "oauth", credentials: { access_token: "sk-b", refresh_token: "rt-b" } })
      + "\n";
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: ndjson }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.total, 2, "total=2");
    eq(j.created, 2, "created=2");
    eq(j.failed, 0, "no failures");
    const a = await db.prepare("SELECT platform, expires_at FROM accounts_v2 WHERE name=? AND platform=?").bind("acc-a", "openai").first();
    eq(a.platform, "openai", "acc-a platform");
    eq(a.expires_at, 1700000000000, "expires_at 秒->毫秒");
  });

  await test("POST /admin/accounts/import 修复 \\\" 双重转义损坏行（原版 Go 导出）", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    // 原版导出的 temp_unschedulable_reason 里出现 \\"，导致整行不是合法 JSON
    const badLine = JSON.stringify({ id: 26, name: "B #2", platform: "grok", type: "oauth", credentials: { access_token: "sk-grok", refresh_token: "rt-grok" } })
      .replace("}", ",\"temp_unschedulable_reason\":\"token refresh retry exhausted: code=*** reason=\\\\\"GROK_OAUTH_REQUEST_FAILED\\\\\"\"}");
    // 确保该行确实解析失败
    let rawFails = false;
    try { JSON.parse(badLine); } catch { rawFails = true; }
    assert(rawFails, "损坏行原始解析应失败");
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: badLine + "\n" }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.created, 1, "修复后 created=1");
    eq(j.failed, 0, "无失败");
    const row = await db.prepare("SELECT name, platform FROM accounts_v2 WHERE name=?").bind("B #2").first();
    eq(row.platform, "grok", "grok 账号落库");
  });

  await test("POST /admin/accounts/import 支持 ISO 日期字符串 expires_at（原版 grok 导出）", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const payload = [{
      id: 26, name: "B #2", platform: "grok", type: "oauth",
      credentials: { access_token: "sk-grok", refresh_token: "rt-grok", expires_at: "2026-08-01T20:46:05Z" },
    }];
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify(payload) }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.created, 1, "created=1");
    const row = await db.prepare("SELECT platform, expires_at FROM accounts_v2 WHERE name=?").bind("B #2").first();
    eq(row.platform, "grok", "platform grok");
    assert(row.expires_at > 1700000000000, "ISO 日期字符串转毫秒成功");
  });

  await test("POST /admin/accounts/import 同名不同 token 账号各自独立（原版允许重名）", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const two = [
      { id: 70, name: "B", platform: "antigravity", type: "oauth", credentials: { email: "a@x.com", access_token: "ya29.aaa", refresh_token: "1//aaa" } },
      { id: 74, name: "B", platform: "antigravity", type: "oauth", credentials: { email: "b@x.com", access_token: "ya29.bbb", refresh_token: "1//bbb" } },
    ];
    const r1 = await worker.fetch(new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify(two) }), env, ctx);
    const j1 = await r1.json();
    eq(j1.created, 2, "首次导入同名不同 token 都创建");
    // 重复导入：应全部更新，不产生新行
    const r2 = await worker.fetch(new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify(two) }), env, ctx);
    const j2 = await r2.json();
    eq(j2.created, 0, "重导不新建");
    eq(j2.updated, 2, "重导全部更新");
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM accounts_v2 WHERE platform='antigravity' AND name='B'").first()).n;
    eq(n, 2, "库里保持两条同名账号");
  });

  await test("POST /admin/accounts/import 支持 antigravity 平台（OAuth）", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const payload = [{
      id: 70, name: "B", platform: "antigravity", type: "oauth", concurrency: 10,
      credentials: { email: "test@example.com", access_token: "ya29.abc", refresh_token: "1//xyz", expires_at: 1786343035 },
    }];
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import", { method: "POST", headers: H, body: JSON.stringify(payload) }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const j = await r.json();
    eq(j.created, 1, "created=1");
    const row = await db.prepare("SELECT platform, type, concurrency FROM accounts_v2 WHERE name=? AND platform=?").bind("B", "antigravity").first();
    eq(row.platform, "antigravity", "platform antigravity");
    eq(row.type, "oauth", "type oauth");
    eq(row.concurrency, 10, "concurrency 保留");
  });

  await test("POST /admin/accounts/import/codex-session 子路径（与原版前端一致）", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/import/codex-session", {
        method: "POST", headers: H,
        body: JSON.stringify({ content: "eyJhY2Nlc3NfdG9rZW4iOiAic2stY29kZXgifQ", name: "codex", platform: "openai" }),
      }),
      env, ctx
    );
    const j = await r.json();
    eq(j.total, 1, "total=1");
    eq(j.created, 1, "created=1");
    const row = await db.prepare("SELECT type FROM accounts_v2 WHERE name=?").bind("codex#1").first();
    eq(row.type, "oauth", "codex 内容导入为 oauth");
  });

  // ============ 新增：管理 API（表格后台用） ============

  await test("GET /admin/health 概览健康度（平台/探测/配额）", async () => {
    const { db, env, ctx } = setup();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    await seedAccount(db, { name: "oa1", platform: "openai", api_key: "sk-1" });
    await seedAccount(db, { name: "oa2", platform: "openai", api_key: "sk-2" });
    await seedAccount(db, { name: "an1", platform: "anthropic", api_key: "sk-3" });
    await db.prepare("UPDATE accounts_v2 SET status='error', error_message='boom' WHERE name='an1'").run();
    await db.prepare("UPDATE accounts_v2 SET last_checked_at=?, last_check_result='ok' WHERE name='oa1'").bind(Date.now()).run();
    await db.prepare("UPDATE accounts_v2 SET last_checked_at=?, last_check_result='fail' WHERE name='an1'").bind(Date.now()).run();
    // 两个带额度 Key + 一个不限额度 Key
    const mk = (q) => db.prepare("INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at,status) VALUES (?,?,?,?,?,?,?)")
      .bind("sk-h" + Math.random().toString(36).slice(2), "k", q, 0, 1, Date.now(), "active").run();
    await mk(1000); await mk(2000);
    await db.prepare("INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at,status) VALUES (?,?,?,?,?,?,?)")
      .bind("sk-h-unlimited", "un", null, 10, 1, Date.now(), "active").run();
    await db.prepare("UPDATE user_keys SET used_tokens=800 WHERE label='k' AND quota_tokens=1000").run();
    const r = await worker.fetch(new Request("https://x/admin/health", { headers: H }), env, ctx);
    eq(r.status, 200, "status 200");
    const j = await r.json();
    assert(Array.isArray(j.platforms) && j.platforms.length === 2, "2 个平台");
    const oa = j.platforms.find((p) => p.platform === "openai");
    eq(oa.active, 2, "openai 可用 2");
    eq(oa.error, 0, "openai 异常 0");
    const an = j.platforms.find((p) => p.platform === "anthropic");
    eq(an.error, 1, "anthropic 异常 1");
    eq(j.probes.length, 2, "2 条探测记录");
    assert(j.probes.every((p) => p.last_check_result === "ok" || p.last_check_result === "fail"), "探测结果字段");
    // 旧数据 last_check_result 可能是 JSON 对象 {ok:true}，应归一为 "ok"/"fail"
    await db.prepare("UPDATE accounts_v2 SET last_check_result=? WHERE name='oa1'").bind(JSON.stringify({ ok: true, latency_ms: 120 })).run();
    const j2 = await worker.fetch(new Request("https://x/admin/health", { headers: H }), env, ctx).then((r) => r.json());
    const oa1p = j2.probes.find((p) => p.name === "oa1");
    eq(oa1p.last_check_result, "ok", "JSON {ok:true} 归一为 ok");
    eq(j.quota.total_quota, 3000, "配额总量 3000");
    eq(j.quota.used_quota, 800, "配额已用 800");
    eq(j.quota.limited_keys, 2, "有限额 Key 2 个");
    eq(j.quota.unlimited_keys, 1, "不限额度 Key 1 个");
    eq(j.quota.top.length, 2, "top 2 个");
    const top0 = j.quota.top.find((k) => k.quota_tokens === 1000);
    eq(top0.pct, 80, "1000 额度 Key 用 80%");
  });

  await test("PATCH /admin/accounts/:id 更新字段", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "edit-me", api_key: "sk-x" });
    const row = await db.prepare("SELECT id FROM accounts_v2 WHERE name=?").bind("edit-me").first();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const r = await worker.fetch(
      new Request("https://x/admin/accounts/" + row.id, { method: "PATCH", headers: H, body: JSON.stringify({ priority: 5, schedulable: false }) }),
      env, ctx
    );
    eq(r.status, 200, "status 200");
    const after = await db.prepare("SELECT priority, schedulable FROM accounts_v2 WHERE id=?").bind(row.id).first();
    eq(after.priority, 5, "priority 已更新");
    eq(after.schedulable, 0, "schedulable 已关闭");
  });

  await test("POST /admin/accounts/:id/toggle-schedulable 切换调度", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "tog", api_key: "sk-x" });
    const row = await db.prepare("SELECT id FROM accounts_v2 WHERE name=?").bind("tog").first();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass") };
    const r1 = await worker.fetch(new Request("https://x/admin/accounts/" + row.id + "/toggle-schedulable", { method: "POST", headers: H }), env, ctx);
    const j1 = await r1.json();
    eq(j1.schedulable, false, "切到暂停调度");
    const r2 = await worker.fetch(new Request("https://x/admin/accounts/" + row.id + "/toggle-schedulable", { method: "POST", headers: H }), env, ctx);
    const j2 = await r2.json();
    eq(j2.schedulable, true, "切回参与调度");
  });

  await test("POST /admin/accounts/:id/clear-error 清除错误", async () => {
    const { db, env, ctx } = setup();
    await seedAccountV2(db, { name: "err-acc", platform: "openai", credentials: { api_key: "sk-x" }, status: "error" });
    await db.prepare("UPDATE accounts_v2 SET error_message='boom' WHERE name='err-acc'").run();
    const row = await db.prepare("SELECT id FROM accounts_v2 WHERE name=?").bind("err-acc").first();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass") };
    const r = await worker.fetch(new Request("https://x/admin/accounts/" + row.id + "/clear-error", { method: "POST", headers: H }), env, ctx);
    eq(r.status, 200, "status 200");
    const after = await db.prepare("SELECT status, error_message FROM accounts_v2 WHERE id=?").bind(row.id).first();
    eq(after.status, "active", "状态恢复 active");
    eq(after.error_message, null, "错误已清空");
  });

  await test("POST /admin/keys/toggle/:id + PATCH /admin/keys/:id", async () => {
    const { db, env, ctx } = setup();
    const key = await seedKey(db);
    const row = await db.prepare("SELECT id FROM user_keys WHERE key=?").bind(key).first();
    const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    const t = await worker.fetch(new Request("https://x/admin/keys/toggle/" + row.id, { method: "POST", headers: H }), env, ctx);
    const tj = await t.json();
    eq(tj.enabled, false, "Key 已停用");
    const p = await worker.fetch(
      new Request("https://x/admin/keys/" + row.id, { method: "PATCH", headers: H, body: JSON.stringify({ label: "renamed", quota_tokens: 123 }) }),
      env, ctx
    );
    eq(p.status, 200, "PATCH 200");
    const after = await db.prepare("SELECT label, quota_tokens FROM user_keys WHERE id=?").bind(row.id).first();
    eq(after.label, "renamed", "label 已更新");
    eq(after.quota_tokens, 123, "额度已更新");
  });

  await test("GET /admin/usage 返回用量流水（含 Key 标签/账号名）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "usage-acc", api_key: "sk-openai" });
    const key = await seedKey(db);
    await worker.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }), env, ctx
    );
    await ctx.drain();
    const r = await worker.fetch(new Request("https://x/admin/usage", { headers: { authorization: "Basic " + btoa("admin@test.com:test-pass") } }), env, ctx);
    eq(r.status, 200, "status 200");
    const rows = await r.json();
    eq(rows.length, 1, "1 条流水");
    eq(rows[0].account_name, "usage-acc", "带账号名");
    eq(rows[0].key_label, "k", "带 Key 标签");
    eq(rows[0].prompt_tokens + rows[0].completion_tokens, 8, "token 数正确");
  });
}

// ============================================================
//  功能对齐测试（用户/分组/套餐/订阅/兑换码/公告/审计/设置/渠道监控/模型广场 + 网关门控）
// ============================================================
async function parityTests(mock) {
  console.log("\n\x1b[1m[Parity] 管理模型对齐\x1b[0m");
  const H = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
  const call = (path, opts) => worker.fetch(new Request("https://x" + path, opts || {}), ...Object.values({}));
  const adm = (path, method, body) =>
    worker.fetch(new Request("https://x" + path, { method: method || "GET", headers: H, body: body ? JSON.stringify(body) : undefined }), ...Object.values({}));

  await test("用户 CRUD + 审计日志", async () => {
    const { db, env, ctx } = setup();
    const r = await worker.fetch(new Request("https://x/admin/users", { method: "POST", headers: H, body: JSON.stringify({ username: "alice", email: "a@x.com", balance_tokens: 5000 }) }), env, ctx);
    const j = await r.json();
    eq(j.ok, true, "创建用户");
    const list = await worker.fetch(new Request("https://x/admin/users", { headers: H }), env, ctx);
    const users = await list.json();
    eq(users.length, 1, "1 个用户");
    eq(users[0].username, "alice", "用户名");
    eq(users[0].balance_tokens, 5000, "余额");
    // 更新余额
    await worker.fetch(new Request("https://x/admin/users/1", { method: "PATCH", headers: H, body: JSON.stringify({ balance_tokens: 9000 }) }), env, ctx);
    const u2 = await worker.fetch(new Request("https://x/admin/users", { headers: H }), env, ctx).then((r) => r.json());
    eq(u2[0].balance_tokens, 9000, "余额已更新");
    // 审计里有记录
    const audit = await worker.fetch(new Request("https://x/admin/audit", { headers: H }), env, ctx).then((r) => r.json());
    assert(audit.length >= 2, "审计记录了 create+update");
    eq(audit[0].action, "update", "最近一条是 update");
  });

  await test("用户用量图表：按天 / 按模型 / 按账号汇总", async () => {
    const { db, env, ctx } = setup();
    await worker.fetch(new Request("https://x/admin/users", { method: "POST", headers: H, body: JSON.stringify({ username: "chart-user" }) }), env, ctx);
    await seedAccount(db, { name: "oa-1", platform: "openai", api_key: "sk-1" });
    await seedAccount(db, { name: "an-1", platform: "anthropic", api_key: "sk-2" });
    const nowMs = Date.now();
    const d = 86400000;
    const ins = db.prepare(
      "INSERT INTO usage_logs (user_key_id,user_id,account_id,model,prompt_tokens,completion_tokens,created_at) VALUES (?,?,?,?,?,?,?)"
    );
    await ins.bind(1, 1, 1, "gpt-4o", 100, 50, nowMs).run();
    // 昨天那条比 24h 边界再提前 5s，避免同一毫秒内 now() 恰好等于 nowMs 导致边界包含
    await ins.bind(1, 1, 1, "gpt-4o", 200, 100, nowMs - d - 5000).run();
    await ins.bind(1, 1, 2, "claude-sonnet-4-5", 300, 150, nowMs - 2 * d).run();
    await ins.bind(1, 1, 2, "claude-sonnet-4-5", 400, 200, nowMs - 3 * d).run();
    const r = await worker.fetch(new Request("https://x/admin/users/1/usage?days=30", { headers: H }), env, ctx);
    eq(r.status, 200, "用量接口 200");
    const j = await r.json();
    eq(j.totals.tokens, 1500, "总 tokens = 150+300+450+600");
    eq(j.totals.calls, 4, "总调用 4 次");
    eq(j.by_day.length, 4, "按天 4 个桶");
    eq(j.by_model.length, 2, "按模型 2 个");
    const gpt = j.by_model.find((m) => m.model === "gpt-4o");
    eq(gpt.tokens, 450, "gpt-4o 汇总 450");
    eq(gpt.calls, 2, "gpt-4o 2 次");
    eq(j.by_account.length, 2, "按账号 2 个");
    const oa = j.by_account.find((a) => a.account === "oa-1");
    eq(oa.tokens, 450, "oa-1 账号汇总 450");
    eq(oa.platform, "openai", "带平台名");
    // 只查 1 天：只剩今天一条
    const r1 = await worker.fetch(new Request("https://x/admin/users/1/usage?days=1", { headers: H }), env, ctx);
    const j1 = await r1.json();
    eq(j1.totals.calls, 1, "近 1 天只 1 条");
    // 不存在的用户 404
    const r404 = await worker.fetch(new Request("https://x/admin/users/999/usage", { headers: H }), env, ctx);
    eq(r404.status, 404, "用户不存在 404");
  });

  await test("分组 CRUD + Key 归属", async () => {
    const { db, env, ctx } = setup();
    await worker.fetch(new Request("https://x/admin/groups", { method: "POST", headers: H, body: JSON.stringify({ name: "VIP", platform: "openai", rate_multiplier: 1.5 }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/users", { method: "POST", headers: H, body: JSON.stringify({ username: "bob" }) }), env, ctx);
    // 生成 Key 并绑定用户 + 分组
    const k = await worker.fetch(new Request("https://x/admin/keys", { method: "POST", headers: H, body: JSON.stringify({ label: "bob-key", user_id: 1, group_id: 1, expires_in_days: 30 }) }), env, ctx).then((r) => r.json());
    eq(k.ok, true, "生成 Key");
    const keys = await worker.fetch(new Request("https://x/admin/keys", { headers: H }), env, ctx).then((r) => r.json());
    eq(keys.length, 1, "1 个 Key");
    eq(keys[0].user_name, "bob", "带用户名");
    eq(keys[0].group_name, "VIP", "带分组名");
    assert(keys[0].expires_at > Date.now(), "有过期时间");
    // 删除分组后 Key 解除绑定
    await worker.fetch(new Request("https://x/admin/groups/1", { method: "DELETE", headers: H }), env, ctx);
    const keys2 = await worker.fetch(new Request("https://x/admin/keys", { headers: H }), env, ctx).then((r) => r.json());
    eq(keys2[0].group_id, null, "分组删除后 Key 解除绑定");
  });

  await test("套餐 + 订阅开通（余额累加）+ 定时过期", async () => {
    const { db, env, ctx } = setup();
    await worker.fetch(new Request("https://x/admin/packages", { method: "POST", headers: H, body: JSON.stringify({ name: "标准版", tokens: 1000000, duration_days: 30 }) }), env, ctx);
    await worker.fetch(new Request("https://x/admin/users", { method: "POST", headers: H, body: JSON.stringify({ username: "carol" }) }), env, ctx);
    const s = await worker.fetch(new Request("https://x/admin/subscriptions", { method: "POST", headers: H, body: JSON.stringify({ user_id: 1, package_id: 1 }) }), env, ctx);
    eq(s.status, 200, "开通订阅");
    const users = await worker.fetch(new Request("https://x/admin/users", { headers: H }), env, ctx).then((r) => r.json());
    eq(users[0].balance_tokens, 1000000, "余额累加套餐 tokens");
    const subs = await worker.fetch(new Request("https://x/admin/subscriptions", { headers: H }), env, ctx).then((r) => r.json());
    eq(subs.length, 1, "1 条订阅");
    eq(subs[0].package_name, "标准版", "带套餐名");
    // 手动把订阅改成已过期，跑 scheduled 验证过期逻辑
    await db.prepare("UPDATE user_subscriptions SET expires_at=? WHERE id=1").bind(Date.now() - 1000).run();
    await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
    await ctx.drain();
    const subs2 = await worker.fetch(new Request("https://x/admin/subscriptions", { headers: H }), env, ctx).then((r) => r.json());
    eq(subs2[0].status, "expired", "订阅已过期");
  });

  await test("兑换码：生成 + 兑换 + 次数用尽", async () => {
    const { db, env, ctx } = setup();
    const p = await worker.fetch(new Request("https://x/admin/promos", { method: "POST", headers: H, body: JSON.stringify({ code: "WELCOME", bonus_tokens: 88888, max_uses: 2 }) }), env, ctx).then((r) => r.json());
    eq(p.code, "WELCOME", "生成兑换码（大写）");
    await worker.fetch(new Request("https://x/admin/users", { method: "POST", headers: H, body: JSON.stringify({ username: "dave" }) }), env, ctx);
    const r1 = await worker.fetch(new Request("https://x/admin/promos/redeem", { method: "POST", headers: H, body: JSON.stringify({ user_id: 1, code: "welcome" }) }), env, ctx).then((r) => r.json());
    eq(r1.bonus_tokens, 88888, "兑换成功");
    await worker.fetch(new Request("https://x/admin/promos/redeem", { method: "POST", headers: H, body: JSON.stringify({ user_id: 1, code: "WELCOME" }) }), env, ctx);
    const r3 = await worker.fetch(new Request("https://x/admin/promos/redeem", { method: "POST", headers: H, body: JSON.stringify({ user_id: 1, code: "WELCOME" }) }), env, ctx);
    eq(r3.status, 400, "次数用尽返回 400");
    const users = await worker.fetch(new Request("https://x/admin/users", { headers: H }), env, ctx).then((r) => r.json());
    eq(users[0].balance_tokens, 88888 * 2, "余额累加两次");
  });

  await test("公告 CRUD + 概览展示", async () => {
    const { db, env, ctx } = setup();
    await worker.fetch(new Request("https://x/admin/announcements", { method: "POST", headers: H, body: JSON.stringify({ title: "维护通知", content: "今晚升级" }) }), env, ctx);
    const anns = await worker.fetch(new Request("https://x/admin/announcements", { headers: H }), env, ctx).then((r) => r.json());
    eq(anns.length, 1, "1 条公告");
    eq(anns[0].title, "维护通知", "标题");
    await worker.fetch(new Request("https://x/admin/announcements/1", { method: "PATCH", headers: H, body: JSON.stringify({ status: "inactive" }) }), env, ctx);
    const anns2 = await worker.fetch(new Request("https://x/admin/announcements", { headers: H }), env, ctx).then((r) => r.json());
    eq(anns2[0].status, "inactive", "已隐藏");
  });

  await test("设置 GET/POST", async () => {
    const { db, env, ctx } = setup();
    await worker.fetch(new Request("https://x/admin/settings", { method: "POST", headers: H, body: JSON.stringify({ site_name: "My API", notice: "hi" }) }), env, ctx);
    const s = await worker.fetch(new Request("https://x/admin/settings", { headers: H }), env, ctx).then((r) => r.json());
    eq(s.site_name, "My API", "站点名");
    eq(s.notice, "hi", "公告");
  });

  await test("渠道监控列表 + 立即检测", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "ch-acc", api_key: "sk-ch" });
    const r = await worker.fetch(new Request("https://x/admin/channels/check", { method: "POST", headers: H }), env, ctx);
    eq(r.status, 200, "触发检测");
    await ctx.drain();
    const list = await worker.fetch(new Request("https://x/admin/channels", { headers: H }), env, ctx).then((r) => r.json());
    eq(list.length, 1, "1 个渠道");
    assert(list[0].last_checked_at, "有检测时间");
    eq(list[0].last_check_result, "ok", "mock 上游可达 -> ok");
    assert(typeof list[0].latency_ms === "number", "带延迟 ms");
    // 探测失败：记录结构化错误 + 错误原因摘要（一键检测为强制模式，不受 10 分钟节流限制，直接重测）
    mock.nextStatus = 500;
    await worker.fetch(new Request("https://x/admin/channels/check", { method: "POST", headers: H }), env, ctx);
    await ctx.drain();
    mock.nextStatus = null;
    const list2 = await worker.fetch(new Request("https://x/admin/channels", { headers: H }), env, ctx).then((r) => r.json());
    eq(list2[0].last_check_result, "fail", "500 -> fail");
    eq(list2[0].status, "error", "账号被标记 error");
    assert(list2[0].probe_error && /HTTP 500/.test(list2[0].probe_error), "错误原因含 HTTP 500");
    eq(list2[0].error_message, list2[0].probe_error, "error_message 同步为真实原因");
  });

  await test("渠道探测：携带真实凭证 + 不拼双 /v1（回归：探测曾恒发空 token 导致全部 401 / 404）", async () => {
    const { db, env, ctx } = setup();
    // openai：默认 base 以 /v1 结尾（api.openai.com/v1），探测 URL 应为 /v1/models 而不是 /v1/v1/models
    await seedAccount(db, { provider: "openai", name: "pr-oa", api_key: "sk-probe-real", base_url: "" });
    await seedAccount(db, { provider: "anthropic", name: "pr-an", api_key: "sk-probe-ant", base_url: "" });
    await seedAccount(db, { provider: "gemini", name: "pr-gm", api_key: "sk-probe-gem", base_url: "" });
    mock.calls.length = 0;
    await worker.fetch(new Request("https://x/admin/channels/check", { method: "POST", headers: H }), env, ctx);
    await ctx.drain();
    const oa = mock.calls.find((c) => c.host === "api.openai.com");
    assert(oa, "探测打到 api.openai.com");
    eq(oa.url, "https://api.openai.com/v1/models", "URL 不带双 /v1");
    eq(oa.headers.authorization, "Bearer sk-probe-real", "openai 探测带真实 Bearer token");
    const an = mock.calls.find((c) => c.host === "api.anthropic.com");
    eq(an.url, "https://api.anthropic.com/v1/models", "anthropic /v1/models");
    eq(an.headers["x-api-key"], "sk-probe-ant", "anthropic 探测带真实 x-api-key");
    const gm = mock.calls.find((c) => c.host === "generativelanguage.googleapis.com");
    assert(gm.url.includes("/v1beta/models?key=sk-probe-gem"), "gemini 探测带真实 key 参数");
    // 自定义 base_url 以 /v1 结尾（如 grok 的 cli-chat-proxy.grok.com/v1）也不应拼双 /v1
    await seedAccountV2(db, { name: "pr-grok", platform: "grok", credentials: { api_key: "sk-grok-x" }, base_url: "https://cli-chat-proxy.grok.com/v1" });
    mock.calls.length = 0;
    await worker.fetch(new Request("https://x/admin/channels/check", { method: "POST", headers: H }), env, ctx);
    await ctx.drain();
    const gk = mock.calls.find((c) => c.host === "cli-chat-proxy.grok.com");
    assert(gk, "grok 探测打到自定义 base");
    eq(gk.url, "https://cli-chat-proxy.grok.com/v1/models", "自定义 base 带 /v1 不重复拼接");
    eq(gk.headers.authorization, "Bearer sk-grok-x", "grok 探测带真实 token");
  });

  await test("渠道探测：过期 oauth 先自动刷新再探测（新 token 写回 D1）", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = new URL(typeof url === "string" ? url : url.toString());
      if (u.host === "auth.openai.com" && u.pathname.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return orig(url, opts);
    };
    const { db, env, ctx } = setup();
    await seedAccountV2(db, {
      name: "pr-oauth", platform: "openai", type: "oauth",
      credentials: { access_token: "old-at", refresh_token: "old-rt", expires_at: Date.now() - 1000 },
    });
    mock.calls.length = 0;
    await worker.fetch(new Request("https://x/admin/channels/check", { method: "POST", headers: H }), env, ctx);
    await ctx.drain();
    const oa = mock.calls.find((c) => c.host === "api.openai.com");
    assert(oa, "刷新后仍探测 openai");
    eq(oa.headers.authorization, "Bearer new-at", "探测使用刷新后的新 token");
    const row = await db.prepare("SELECT credentials FROM accounts_v2 WHERE name='pr-oauth'").first();
    const c = JSON.parse(row.credentials);
    eq(c.access_token, "new-at", "新 token 已写回 D1");
    globalThis.fetch = orig;
  });

  await test("模型广场汇总 model_map", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "m-acc", api_key: "sk-m", model_map: { "gpt-4o": "gpt-4o" } });
    const list = await worker.fetch(new Request("https://x/admin/models", { headers: H }), env, ctx).then((r) => r.json());
    assert(list.some((m) => m.model === "gpt-4o"), "含 gpt-4o");
  });

  await test("网关：用户停用 / 余额耗尽 / Key 过期 / RPM 限流", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "g-acc", api_key: "sk-g" });
    const mkKey = async (over) => {
      const b = { username: "u" + Math.random(), ...(over.user || {}) };
      await worker.fetch(new Request("https://x/admin/users", { method: "POST", headers: H, body: JSON.stringify(b) }), env, ctx);
      const key = "sk-" + crypto.randomUUID().replace(/-/g, "");
      await db.prepare(`INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at,user_id,rpm_limit,expires_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(key, "k", over.quota ?? null, 0, 1, Date.now(), 1, over.rpm ?? 0, over.expires ?? null, over.keyStatus ?? "active").run();
      return key;
    };
    const chat = async (key) => {
      mock.calls.length = 0;
      const r = await worker.fetch(new Request("https://x/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }) }), env, ctx);
      await ctx.drain();
      return r.status;
    };
    // 用户停用
    let key = await mkKey({});
    await db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    eq(await chat(key), 403, "用户停用 -> 403");
    await db.prepare("UPDATE users SET status='active' WHERE id=1").run();
    // 余额耗尽
    await db.prepare("UPDATE users SET balance_tokens=0 WHERE id=1").run();
    eq(await chat(key), 402, "余额 0 -> 402");
    await db.prepare("UPDATE users SET balance_tokens=-1 WHERE id=1").run();
    // Key 过期
    key = await mkKey({ expires: Date.now() - 1000 });
    eq(await chat(key), 403, "Key 过期 -> 403");
    // RPM 限流
    key = await mkKey({ rpm: 2 });
    eq(await chat(key), 200, "第一次通过");
    eq(await chat(key), 200, "第二次通过");
    eq(await chat(key), 429, "第三次触发 RPM 限流");
    __resetRuntimeState();
  });

  await test("网关：分组平台过滤（只走 openai 账号）", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { provider: "openai", name: "grp-oa", api_key: "sk-oa" });
    await seedAccount(db, { provider: "anthropic", name: "grp-an", api_key: "sk-an" });
    await worker.fetch(new Request("https://x/admin/groups", { method: "POST", headers: H, body: JSON.stringify({ name: "OA-ONLY", platform: "openai" }) }), env, ctx);
    const key = "sk-" + crypto.randomUUID().replace(/-/g, "");
    await db.prepare("INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at,group_id,status) VALUES (?,?,?,?,?,?,?,?)")
      .bind(key, "g", null, 0, 1, Date.now(), 1, "active").run();
    mock.calls.length = 0;
    const r = await worker.fetch(new Request("https://x/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }) }), env, ctx);
    await r.json();
    await ctx.drain();
    const hosts = mock.calls.map((c) => c.host);
    assert(hosts.includes("api.openai.com"), "走了 openai 上游");
    assert(!hosts.includes("api.anthropic.com"), "没走 anthropic 上游");
  });

  await test("模型限流：用户级 / Key 级 RPM + 并发 + 优先级", async () => {
    const { db, env, ctx } = setup();
    await seedAccount(db, { name: "oa", platform: "openai", api_key: "sk-oa" });
    const H2 = { authorization: "Basic " + btoa("admin@test.com:test-pass"), "content-type": "application/json" };
    await worker.fetch(new Request("https://x/admin/users", { method: "POST", headers: H2, body: JSON.stringify({ username: "u1", balance_tokens: -1 }) }), env, ctx);
    const mkKey = async () => {
      const key = "sk-" + crypto.randomUUID().replace(/-/g, "");
      await db.prepare("INSERT INTO user_keys (key,label,quota_tokens,used_tokens,enabled,created_at,user_id,rpm_limit,status) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(key, "k", null, 0, 1, Date.now(), 1, 0, "active").run();
      return key;
    };
    const chat = async (key, model) => {
      mock.calls.length = 0;
      const r = await worker.fetch(new Request("https://x/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ model: model || "gpt-4o", messages: [{ role: "user", content: "hi" }] }) }), env, ctx);
      await ctx.drain();
      return r.status;
    };
    const addRule = (body) => worker.fetch(new Request("https://x/admin/model-limits", { method: "POST", headers: H2, body: JSON.stringify(body) }), env, ctx);

    // 用户级：claude-sonnet-4-5 RPM=2
    await addRule({ user_id: 1, model: "claude-sonnet-4-5", rpm_limit: 2 });
    let key = await mkKey();
    eq(await chat(key, "claude-sonnet-4-5"), 200, "claude 第一次通过");
    eq(await chat(key, "claude-sonnet-4-5"), 200, "claude 第二次通过");
    eq(await chat(key, "claude-sonnet-4-5"), 429, "claude 第三次触发用户级模型 RPM 限流");
    eq(await chat(key, "gpt-4o"), 200, "其他模型不受影响");

    // 优先级：用户级 gpt-4o RPM=100（宽松）vs Key 级 gpt-4o RPM=1（严格）→ 应取 Key 级
    await addRule({ user_id: 1, model: "gpt-4o", rpm_limit: 100 });
    await addRule({ key_id: 1, model: "gpt-4o", rpm_limit: 1 });
    eq(await chat(key, "gpt-4o"), 200, "Key 级规则第一次通过");
    eq(await chat(key, "gpt-4o"), 429, "Key 级规则覆盖用户级（RPM=1）");
    eq(await chat(key, "claude-sonnet-4-5"), 429, "用户级 claude 规则仍生效");
    __resetRuntimeState();

    // 并发上限=1：两个并发请求只有一个成功
    await addRule({ user_id: 1, model: "gemini-2.5-flash", concurrency: 1 });
    const mkReq = () => new Request("https://x/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }) });
    const r1 = worker.fetch(mkReq(), env, ctx);
    const r2 = worker.fetch(mkReq(), env, ctx);
    const st = await Promise.all([r1, r2]);
    const sts = st.map((r) => r.status).sort();
    eq(sts[0], 200, "并发=1 时第一个通过");
    eq(sts[1], 429, "并发=1 时第二个被拒");
    await ctx.drain();
    __resetRuntimeState();

    // 管理 API：列表带用户名 / Key 标签、编辑、删除
    const list = await worker.fetch(new Request("https://x/admin/model-limits", { headers: H2 }), env, ctx).then((r) => r.json());
    eq(list.length, 4, "4 条规则");
    assert(list.some((x) => x.user_name === "u1"), "带用户名");
    assert(list.some((x) => x.key_label === "k"), "带 Key 标签");
    const first = list[0];
    await worker.fetch(new Request("https://x/admin/model-limits/" + first.id, { method: "PATCH", headers: H2, body: JSON.stringify({ rpm_limit: 5, enabled: false }) }), env, ctx);
    const l2 = await worker.fetch(new Request("https://x/admin/model-limits", { headers: H2 }), env, ctx).then((r) => r.json());
    const patched = l2.find((x) => x.id === first.id);
    eq(patched.rpm_limit, 5, "RPM 已更新");
    eq(patched.enabled, 0, "已停用");
    await worker.fetch(new Request("https://x/admin/model-limits/" + first.id, { method: "DELETE", headers: H2 }), env, ctx);
    const l3 = await worker.fetch(new Request("https://x/admin/model-limits", { headers: H2 }), env, ctx).then((r) => r.json());
    eq(l3.length, 3, "删除后剩 3 条");
    // 停用后规则不拦截
    await addRule({ user_id: 1, model: "gpt-4o", rpm_limit: 1, enabled: false });
    __resetRuntimeState();
    eq(await chat(key, "gpt-4o"), 200, "停用的规则不生效");
    __resetRuntimeState();
  });
}

// ============================================================
//  入口
// ============================================================
export async function runTests() {
  console.log("\x1b[1mSub2API-CF 测试\x1b[0m");
  const mock = installFetchMock();
  try {
    await unitTests();
    await integrationTests(mock);
    await parityTests(mock);
  } finally {
    mock.restore();
  }
  console.log("\n\x1b[1m结果:\x1b[0m", pass, "通过,", failures.length, "失败");
  if (failures.length) {
    console.log("\x1b[31m失败项:\x1b[0m");
    failures.forEach((f) => console.log("  -", f));
    return false;
  }
  console.log("\x1b[32m全部通过 ✅\x1b[0m");
  return true;
}

// 直接运行：node --experimental-sqlite test/run.js
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((ok) => process.exit(ok ? 0 : 1));
}
