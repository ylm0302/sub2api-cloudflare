// relay.js — 上游供应商协议适配层（Sub2API-CF v2）
// 支持 platform: openai | anthropic | gemini | grok | antigravity
// 支持 type:     api_key | oauth
//   - api_key:   credentials = { api_key }
//   - oauth:     credentials = { access_token, refresh_token?, expires_at?, client_id? }
// cookie 类型由导入层拒绝，这里不实现。
//
// 目标：把统一的 OpenAI 格式请求，转成各家上游格式；把各家上游响应（含 SSE）转回 OpenAI 格式。

export const DEFAULT_BASE = {
  openai:     "https://api.openai.com/v1",
  anthropic:  "https://api.anthropic.com",
  gemini:     "https://generativelanguage.googleapis.com",
  grok:       "https://api.x.ai/v1",
  antigravity:"https://cloudcode-pa.googleapis.com", // 真实 Antigravity（Google）API
};

// Antigravity API 端点（prod 优先，daily sandbox 备用，与 Antigravity-Manager 一致）
export const ANTIGRAVITY_BASES = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

// Antigravity OAuth 客户端（Google OAuth）—— 密钥通过环境变量设置，见 README.md
//   ANTIGRAVITY_OAUTH_CLIENT_ID     — 必须（wrangler secret put）
//   ANTIGRAVITY_OAUTH_CLIENT_SECRET — 必须（wrangler secret put）

// OAuth 刷新端点（已核实）
export const OAUTH_TOKEN_URL = {
  openai:   "https://auth.openai.com/oauth/token",
  gemini:   "https://oauth2.googleapis.com/token",
  grok:     "https://auth.x.ai/oauth2/token",
  antigravity: "https://oauth2.googleapis.com/token",
  // anthropic OAuth 走 sessionKey（cookie），本实现不支持
};

const SUPPORTED_PLATFORMS = Object.keys(DEFAULT_BASE);

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
function safeCred(acct) {
  return safeJson(acct.credentials, {});
}

// 取当前可用的访问令牌：
// - api_key 类型：返回 { kind:"apikey", token }
// - oauth 类型：返回 { kind:"oauth", token, refresh_token, expires_at, client_id }
export function credentialFor(acct) {
  const c = safeJson(acct.credentials, {});
  // 兼容旧顶层 api_key 字段
  if (!c.api_key && acct.api_key) c.api_key = acct.api_key;
  if (acct.type === "oauth") {
    return {
      kind: "oauth",
      token: c.access_token || "",
      refresh_token: c.refresh_token || "",
      expires_at: c.expires_at || 0,
      client_id: c.client_id || "",
    };
  }
  // 默认按 api_key
  return { kind: "apikey", token: c.api_key || "" };
}

// 把 system 消息从 messages 中拆出来（Anthropic / Gemini 需要单独字段）
function splitSystem(messages = []) {
  let system = "";
  const rest = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n" : "") + (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    } else {
      rest.push(m);
    }
  }
  return { system, rest };
}

function mapFinish(reason) {
  const m = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls" };
  return m[reason] || "stop";
}

// 主入口：构建访问上游所需的 {url, headers, body, isStream, translator, provider}
// 返回的对象带 `credential` 信息，供 index.js 决定是否刷新。
export function buildUpstream(acct, body) {
  const map = safeJson(acct.model_map, {});
  const model = map[body.model] || body.model;
  const isStream = !!body.stream;
  // 兼容旧字段 provider 与新字段 platform
  const platform = acct.platform || acct.provider;
  const base = (acct.base_url && acct.base_url.trim()) || DEFAULT_BASE[platform];
  const cred = credentialFor({ ...acct, platform });

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`unsupported platform: ${platform}`);
  }

  // ---------- OpenAI 兼容（openai / grok / antigravity 走 OpenAI 协议） ----------
  if (platform === "openai" || platform === "grok") {
    // openai OAuth 账号（ChatGPT 网页登录）：走 ChatGPT 内部 Codex API（对齐原版 sub2api）
    if (platform === "openai" && cred.kind === "oauth") {
      const { system, rest } = splitSystem(body.messages || []);
      const input = rest.map((m) => ({
        role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
        content: [{ type: "input_text", text: msgText(m.content) }],
      }));
      // Codex 模型归一化：与真实转发一致（gpt-5.3 -> gpt-5.3-codex、gpt-5 -> gpt-5.4 等）
      const upstreamModel = normalizeCodexModel(model);
      const out = {
        model: upstreamModel,
        input: input.length ? input : [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: true, // ChatGPT Codex API 强制流式（实测 stream:false 返回 400）
        store: false,
      };
      if (system) out.instructions = system;
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${cred.token}`,
        accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        originator: "codex-tui",
        "user-agent": "codex-tui/0.44.4",
      };
      // 账号级 ChatGPT 账号标识头（对齐原版 setOpenAIChatGPTAccountHeaders）
      const rawCred = safeCred(acct);
      if (rawCred && rawCred.chatgpt_account_id) headers["chatgpt-account-id"] = rawCred.chatgpt_account_id;
      return {
        provider: platform,
        // 上游强制流式，但按客户端意图标记 isStream，便于 relayToUpstream 决定聚合为 JSON 还是透传 SSE
        isStream,
        forceStreamUpstream: true,
        credential: cred,
        url: "https://chatgpt.com/backend-api/codex/responses",
        headers,
        body: JSON.stringify(out),
        translateResponse: responsesRespToOpenAI,
        translator: responsesTranslator,
      };
    }
    const out = { ...body, model, stream: isStream };
    if (isStream) {
      out.stream_options = { ...(body.stream_options || {}), include_usage: true };
    }
    const headers = { "content-type": "application/json", authorization: `Bearer ${cred.token}` };
    if (platform === "grok" && cred.kind === "oauth") {
      // Grok OAuth 需要区分头，保持 Bearer 即可
    }
    return {
      provider: platform,
      isStream,
      credential: cred,
      url: `${base}/chat/completions`,
      headers,
      body: JSON.stringify(out),
      translateResponse: (j) => j,
      translator: openaiPassTranslator,
    };
  }

  // ---------- Antigravity（真实 Google API，v1internal Gemini 格式） ----------
  if (platform === "antigravity") {
    const rawCred = safeCred(acct);
    const projectId = (rawCred && rawCred.project_id) || "";
    const upstreamModel = antigravityModelFor(rawCred, model);
    const payload = openAIToAntigravity(body, upstreamModel, projectId);
    const action = isStream ? "streamGenerateContent" : "generateContent";
    return {
      provider: "antigravity",
      isStream,
      credential: cred,
      url: `${base}/v1internal:${action}${isStream ? "?alt=sse" : ""}`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cred.token}`,
        "user-agent": "antigravity/1.23.2 windows/amd64",
      },
      body: JSON.stringify(payload),
      translateResponse: (j) => antigravityToOpenAI(j, upstreamModel),
      translator: antigravityTranslator,
    };
  }

  // ---------- Anthropic（Claude 协议） ----------
  if (platform === "anthropic") {
    const { system, rest } = splitSystem(body.messages || []);
    const payload = {
      model,
      max_tokens: body.max_tokens ?? 1024,
      stream: isStream,
      messages: rest,
      ...(system ? { system } : {}),
      ...(body.temperature != null ? { temperature: body.temperature } : {}),
      ...(body.top_p != null ? { top_p: body.top_p } : {}),
      ...(body.stop ? { stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
    };
    const headers = {
      "content-type": "application/json",
      "x-api-key": cred.token,
      "anthropic-version": "2023-06-01",
    };
    return {
      provider: platform,
      isStream,
      credential: cred,
      url: `${base}/v1/messages`,
      headers,
      body: JSON.stringify(payload),
      translateResponse: (j) => anthropicToOpenAI(j, model),
      translator: anthropicTranslator,
    };
  }

  // ---------- Gemini ----------
  if (platform === "gemini") {
    const payload = openAIToGemini(body, model);
    const q = isStream ? "?alt=sse" : "";
    const headers = { "content-type": "application/json" };
    if (cred.kind === "oauth") headers.authorization = `Bearer ${cred.token}`;
    else headers["x-goog-api-key"] = cred.token;
    return {
      provider: "gemini",
      isStream,
      credential: cred,
      url: `${base}/v1beta/models/${model}:streamGenerateContent${q}`,
      headers,
      body: JSON.stringify(payload),
      translateResponse: (j) => geminiToOpenAI(j, model),
      translator: geminiTranslator,
    };
  }

  throw new Error(`unsupported platform: ${platform}`);
}

// ---------- 模型列表 / token 估算 ----------

// 各平台默认模型（/v1/models 与 /v1beta/models 兜底）
export const DEFAULT_MODELS = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "text-embedding-3-small", "text-embedding-3-large"],
  anthropic: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-3-7-sonnet-latest", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
  grok: ["grok-4", "grok-3", "grok-3-mini", "grok-2-latest"],
  // 对齐原版 sub2api pkg/antigravity DefaultModels（Claude + Gemini）
  antigravity: [
    // Claude
    "claude-fable-5", "claude-opus-4-5-thinking", "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking", "claude-opus-4-6", "claude-opus-4-6-thinking",
    "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6",
    // Gemini
    "gemini-2.5-flash", "gemini-2.5-flash-image", "gemini-2.5-flash-image-preview",
    "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking", "gemini-3-flash",
    "gemini-3-pro-low", "gemini-3-pro-high", "gemini-3.1-pro-low", "gemini-3.1-pro-high",
    "gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", "gemini-3.6-flash",
    "gemini-3.6-flash-high", "gemini-3.6-flash-low", "gemini-3.6-flash-medium",
    "gemini-3.6-flash-tiered", "gemini-3-pro-preview", "gemini-3-pro-image",
  ],
};

// 从账号列表收集对外模型名：优先 model_map 的对外 key，缺省回退平台默认列表
// model_map 兼容字符串（DB 存储）与对象（直接传入）两种形态
export function collectModels(accounts) {
  const seen = new Set();
  const list = [];
  const push = (id) => {
    if (id && typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      list.push(id);
    }
  };
  for (const a of accounts || []) {
    const raw = a && a.model_map;
    const map = typeof raw === "string" ? safeJson(raw, {}) : raw || {};
    const keys = Object.keys(map);
    if (keys.length) keys.forEach(push);
    else (DEFAULT_MODELS[a && a.platform] || []).forEach(push);
  }
  if (!list.length) {
    for (const models of Object.values(DEFAULT_MODELS)) models.forEach(push);
  }
  return list;
}

// 粗略 token 估算（/v1/messages/count_tokens 用，约 4 字符/token）
export function estimateTokens(body) {
  let n = 0;
  const count = (s) => {
    if (typeof s === "string") n += Math.max(1, Math.ceil(s.length / 4));
  };
  if (body && body.system) count(typeof body.system === "string" ? body.system : JSON.stringify(body.system));
  for (const m of (body && body.messages) || []) {
    if (typeof m.content === "string") count(m.content);
    else if (Array.isArray(m.content)) m.content.forEach((b) => count(b && b.text));
  }
  return n;
}

// 判断 oauth credential 是否需在发送前刷新（提前 5 分钟窗口）
export function needsOAuthRefresh(cred) {
  if (cred.kind !== "oauth") return false;
  if (!cred.refresh_token) return false;
  if (!cred.expires_at) return false;
  const now = Date.now();
  const window = 5 * 60 * 1000;
  return cred.expires_at - now < window;
}

// 同步刷新 OAuth token（返回新的 credentials 子集）
export async function refreshOAuth(platform, cred, env) {
  const url = OAUTH_TOKEN_URL[platform];
  if (!url) throw new Error(`no oauth endpoint for platform: ${platform}`);
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", cred.refresh_token);
  // Antigravity 账号的 credentials 不含 client_id，使用环境变量配置的 OAuth 客户端
  if (platform === "antigravity") params.set("client_id", cred.client_id || (env && env.ANTIGRAVITY_OAUTH_CLIENT_ID) || "");
  else if (cred.client_id) params.set("client_id", cred.client_id);
  // Google 系（gemini/antigravity）需要 client_secret；antigravity 从环境变量读取
  if (platform === "gemini" && env && env.GEMINI_OAUTH_CLIENT_SECRET) {
    params.set("client_secret", env.GEMINI_OAUTH_CLIENT_SECRET);
  } else if (platform === "antigravity") {
    params.set("client_secret", (env && env.ANTIGRAVITY_OAUTH_CLIENT_SECRET) || "");
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`oauth refresh failed (${resp.status}): ${txt.slice(0, 200)}`);
  }
  const j = await resp.json();
  const expires_at = j.expires_in ? Date.now() + j.expires_in * 1000 : cred.expires_at;
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || cred.refresh_token,
    expires_at,
  };
}

// ---------- OpenAI 格式 -> 各家 ----------

function openAIToGemini(body) {
  const { system, rest } = splitSystem(body.messages || []);
  const contents = rest.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
  }));
  const generationConfig = {};
  if (body.temperature != null) generationConfig.temperature = body.temperature;
  if (body.max_tokens != null) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.top_p != null) generationConfig.topP = body.top_p;
  const payload = { contents };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;
  return payload;
}

// ---------- Antigravity（Google v1internal Gemini 格式）适配 ----------

function uid() {
  try { return crypto.randomUUID(); } catch { return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10); }
}

// 模型名解析：账号 model_map（对外名 -> 上游名）优先，其次默认别名表，最后透传
// 默认别名表对齐原版 sub2api domain.DefaultAntigravityModelMapping（新模型替换旧型号）
const ANTIGRAVITY_MODEL_ALIASES = {
  // Claude：旧型号迁移 / 简称映射
  "claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
  "claude-opus-4-5-20251101": "claude-opus-4-6-thinking",
  "claude-opus-4-6": "claude-opus-4-6-thinking",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
  // Claude Haiku → Sonnet（上游无 Haiku 支持）
  "claude-haiku-4-5": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-sonnet-4-6",
  // Gemini image preview → image
  "gemini-2.5-flash-image-preview": "gemini-2.5-flash-image",
  // Gemini 3 preview
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3-pro-preview": "gemini-3-pro-high",
  // Gemini 3.1 Pro → gemini-pro-agent 上游路由
  "gemini-3.1-pro": "gemini-pro-agent",
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3.1-pro-preview": "gemini-pro-agent",
  // Gemini 3.1 image preview → image
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image",
  // Gemini 3 image 兼容映射（向 3.1 image 迁移）
  "gemini-3-pro-image": "gemini-3.1-flash-image",
  "gemini-3-pro-image-preview": "gemini-3.1-flash-image",
};
export function antigravityModelFor(rawCred, model) {
  if (rawCred && rawCred.model_mapping && typeof rawCred.model_mapping === "object" && rawCred.model_mapping[model]) {
    return rawCred.model_mapping[model];
  }
  if (ANTIGRAVITY_MODEL_ALIASES[model]) return ANTIGRAVITY_MODEL_ALIASES[model];
  return model;
}

// OpenAI chat 请求 -> Antigravity v1internal（Gemini 风格）请求
// v1internal 端点：POST {base}/v1internal:generateContent | :streamGenerateContent?alt=sse
// 请求体：{ project, requestId, userAgent:"antigravity", requestType:"agent", model, request:{...} }
// 基于第一条 user 消息内容生成稳定 session ID（对齐原版 generateStableSessionID）：
// 重连/重试时同一对话复用同一 session，避免上游把重连当作新对话重新生成（codex 重连重复数据）
function stableSessionId(contents) {
  for (const c of contents) {
    if (c.role !== "user" || !c.parts || !c.parts.length) continue;
    const text = c.parts.map((p) => p.text || "").join("");
    if (text) {
      let h = 0;
      for (let i = 0; i < text.length; i++) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
      return "-" + Math.abs(h);
    }
  }
  return uid();
}

// OpenAI 工具（type:function/function:{name,description,parameters}）-> Gemini functionDeclarations
function openAIToolsToGemini(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const funcDecls = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const fn = t.type === "function" ? t.function : t;
    if (!fn || !fn.name) continue;
    funcDecls.push({
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
    });
  }
  return funcDecls.length ? [{ functionDeclarations: funcDecls }] : undefined;
}

function openAIToAntigravity(body, model, projectId) {
  const { system, rest } = splitSystem(body.messages || []);
  const contents = [];
  // tool_call_id -> 函数名 映射（来自 assistant tool_calls，供 tool 消息的 functionResponse.name 复用）
  const toolIdToName = {};
  for (const m of rest) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.id && tc.function && tc.function.name) toolIdToName[tc.id] = tc.function.name;
      }
    }
  }
  for (const m of rest) {
    const role = m.role === "assistant" ? "model" : m.role === "tool" ? "user" : "user";
    const parts = [];
    // assistant tool_calls -> functionCall 部分
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        if (!tc || tc.type !== "function" || !tc.function || !tc.function.name) continue;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
    }
    // user tool 消息 -> functionResponse 部分（结果文本内嵌在 response 里，不额外发 text part）
    if (m.role === "tool" && m.tool_call_id) {
      const name = toolIdToName[m.tool_call_id] || m.name || "tool";
      // Gemini 要求 function_response.response 是 Struct（对象）；标量/数组需包一层 output
      let resp;
      try {
        const parsed = JSON.parse(m.content);
        resp = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output: String(m.content == null ? "" : m.content) };
      } catch {
        resp = { output: String(m.content == null ? "" : m.content) };
      }
      parts.push({ functionResponse: { name, response: resp } });
    } else {
      const text = msgText(m.content);
      if (text) parts.push({ text });
    }
    if (!parts.length) parts.push({ text: "" });
    contents.push({ role, parts });
  }
  const request = { contents, sessionId: stableSessionId(contents) };
  if (system) request.systemInstruction = { role: "user", parts: [{ text: system }] };
  const tools = openAIToolsToGemini(body.tools);
  if (tools) {
    request.tools = tools;
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  const gc = {};
  if (body.max_tokens != null) gc.maxOutputTokens = body.max_tokens;
  if (body.temperature != null) gc.temperature = body.temperature;
  if (body.top_p != null) gc.topP = body.top_p;
  if (Object.keys(gc).length) request.generationConfig = gc;
  return {
    project: projectId,
    requestId: "agent-" + uid(),
    userAgent: "antigravity",
    requestType: "agent",
    model,
    request,
  };
}

// Antigravity v1internal 响应 -> OpenAI chat 响应（解 response 包装；usage 带 thinking tokens）
function unwrapV1Resp(j) {
  return j && j.response && typeof j.response === "object" ? j.response : (j || {});
}
function mapAntigravityFinish(fr) {
  if (!fr || fr === "STOP" || fr === "" ) return "stop";
  if (fr === "MAX_TOKENS") return "length";
  if (fr === "SAFETY" || fr === "RECITATION" || fr === "BLOCKLIST" || fr === "PROHIBITED_CONTENT") return "content_filter";
  if (fr === "MALFORMED_FUNCTION_CALL") return "tool_calls";
  return "stop";
}
// Gemini functionCall 部分 -> OpenAI tool_calls 数组
function geminiFunctionCallsToOpenAI(parts) {
  const toolCalls = [];
  for (const p of parts) {
    const fc = p && p.functionCall;
    if (!fc || !fc.name) continue;
    toolCalls.push({
      id: fc.id || ("call_" + fc.name + "_" + Math.random().toString(36).slice(2, 8)),
      type: "function",
      function: { name: fc.name, arguments: JSON.stringify(fc.args || {}) },
    });
  }
  return toolCalls.length ? toolCalls : undefined;
}

export function antigravityToOpenAI(j, model) {
  const resp = unwrapV1Resp(j);
  const parts = resp.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => p.text != null && !p.thought).map((p) => p.text).join("");
  const toolCalls = geminiFunctionCallsToOpenAI(parts);
  const u = resp.usageMetadata || {};
  const pTok = u.promptTokenCount || 0;
  const cTok = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  // 出现 functionCall 时强制 finish=tool_calls（对齐原版：usedTool -> stop_reason "tool_use"）
  const fr = toolCalls ? "tool_calls" : mapAntigravityFinish(resp.candidates?.[0]?.finishReason);
  return {
    id: "chatcmpl-ag" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text || null, tool_calls: toolCalls },
      finish_reason: fr,
    }],
    usage: {
      prompt_tokens: pTok,
      completion_tokens: cTok,
      total_tokens: pTok + cTok,
    },
  };
}

// Antigravity SSE（data: v1internal 响应）-> OpenAI chunk 翻译器
const antigravityTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return []; }
    const resp = unwrapV1Resp(j);
    const parts = resp.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p) => p.text != null && !p.thought).map((p) => p.text).join("");
    const toolCalls = geminiFunctionCallsToOpenAI(parts);
    const out = [];
    // 注意：用独立 flag（trStarted），避免与 makeOpenAIStream 客户端协议转换器（openAIChunkToAnthropic 等）共用的 state.started 冲突
    if (!state.trStarted) {
      state.trStarted = true;
      out.push({
        id: "chatcmpl-ag" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    }
    if (text) out.push({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    if (toolCalls) out.push({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
    if (resp.usageMetadata) {
      const u = resp.usageMetadata;
      state.usage = {
        prompt_tokens: u.promptTokenCount || 0,
        completion_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
        total_tokens: (u.promptTokenCount || 0) + (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      };
    }
    const fr = resp.candidates?.[0]?.finishReason;
    // 出现 functionCall 时强制 finish=tool_calls（对齐原版：usedTool -> stop_reason "tool_use"），
    // 一旦出现过工具调用就保持 tool_calls，避免后续无 parts 的 finishReason chunk 覆盖
    if (toolCalls) {
      state.sawToolCalls = true;
      state.finishReason = "tool_calls";
    } else if (!state.sawToolCalls && fr) {
      state.finishReason = mapAntigravityFinish(fr);
    }
    return out;
  },
  flush(state) {
    const u = state.usage || {};
    return [{
      id: "x",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: state.finishReason || "stop" }],
      usage: {
        prompt_tokens: u.prompt_tokens || 0,
        completion_tokens: u.completion_tokens || 0,
        total_tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      },
    }];
  },
};

// ---------- 入站协议适配：Anthropic / Gemini 原生请求 -> 内部 OpenAI 格式 ----------

function msgText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && (b.type === "text" || b.text))
    .map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)))
    .join("");
}

// Anthropic /v1/messages 请求 -> OpenAI chat 请求（保持 stream / max_tokens 等）
// Claude 工具 schema（name/description/input_schema）-> OpenAI chat tools 格式
function claudeToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    // MCP custom 工具：{type:"custom", name, custom:{input_schema}}
    const schema = t.type === "custom" ? (t.custom && t.custom.input_schema) : t.input_schema;
    const name = t.name;
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: (t.type === "custom" && t.custom && t.custom.description) || t.description || "",
        parameters: schema && typeof schema === "object" ? schema : { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

// Claude 消息内容块 -> OpenAI 消息列表（text / tool_use -> tool_calls；tool_result -> tool 角色）
function claudeContentToOpenAIMessages(m, messages) {
  const content = m.content;
  if (typeof content === "string") {
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content });
    return;
  }
  if (!Array.isArray(content)) return;
  const role = m.role === "assistant" ? "assistant" : "user";
  // 拆分：文本 / tool_use / tool_result
  const textParts = [];
  const toolUses = [];
  const toolResults = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_use") toolUses.push(b);
    else if (b.type === "tool_result") toolResults.push(b);
    else if (b.type === "text" || typeof b.text === "string") textParts.push(b.text);
    else if (b.type === "thinking" || b.type === "redacted_thinking") { /* 丢弃思考块，上游由系统提示接管 */ }
  }
  const text = textParts.join("");
  if (toolResults.length) {
    // 每个 tool_result 独立成一条 tool 消息（OpenAI 要求 tool_call_id 与 assistant tool_calls 一一对应）
    for (const tr of toolResults) {
      let result = tr.content;
      if (Array.isArray(result)) result = result.map((p) => (typeof p === "string" ? p : p && p.text != null ? p.text : JSON.stringify(p))).join("");
      messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: String(result == null ? "" : result) });
    }
  } else if (role === "assistant" && toolUses.length) {
    const msg = { role: "assistant", content: text || null, tool_calls: toolUses.map((tu) => ({
      id: tu.id || ("call_" + Math.random().toString(36).slice(2, 10)),
      type: "function",
      function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
    })) };
    messages.push(msg);
  } else if (text || !toolUses.length) {
    messages.push({ role, content: text });
  }
}

export function anthropicReqToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system : msgText(body.system);
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const m of body.messages || []) {
    claudeContentToOpenAIMessages(m, messages);
  }
  if (!messages.length) messages.push({ role: "user", content: "" });
  const out = {
    model: body.model,
    messages,
    stream: !!body.stream,
    max_tokens: body.max_tokens ?? 1024,
  };
  const tools = claudeToolsToOpenAI(body.tools);
  if (tools) out.tools = tools;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  return out;
}

// OpenAI Responses API 请求 -> OpenAI chat 请求（/v1/responses 入站转换）
// 上游统一走 /v1/chat/completions，响应再转回 Responses 格式，兼容全部平台账号。
export function responsesReqToOpenAI(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const input = body.input;
  const inputArr = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : [];
  for (const m of inputArr) {
    if (typeof m === "string") { messages.push({ role: "user", content: m }); continue; }
    if (!m || typeof m !== "object") continue;
    const role = m.role === "system" || m.role === "developer" ? "system" : m.role === "assistant" ? "assistant" : "user";
    let text = "";
    const content = m.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((p) => (typeof p === "string" ? p : p && p.text ? p.text : p && p.type === "input_image" ? "[image]" : ""))
        .filter(Boolean)
        .join("");
    }
    if (text) messages.push({ role, content: text });
  }
  if (!messages.length) messages.push({ role: "user", content: "" });
  const maxOut = body.max_output_tokens ?? body.max_tokens;
  const out = {
    model: body.model,
    messages,
    stream: !!body.stream,
  };
  if (maxOut != null) { out.max_tokens = maxOut; out.max_completion_tokens = maxOut; }
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop != null) out.stop = body.stop;
  // Responses tools 格式 {type:"function", name, description, parameters} -> chat 格式
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => {
      if (!t || typeof t !== "object") return null;
      if (t.type === "function") return { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } };
      if (t.type === "web_search_preview") return { type: "web_search" }; // 降级为 web_search
      return { type: t.type, ...t };
    }).filter(Boolean);
  }
  if (body.tool_choice != null) out.tool_choice = body.tool_choice;
  if (body.prompt_cache_key != null) out.prompt_cache_key = body.prompt_cache_key;
  return out;
}

// Gemini /v1beta/models/{model}:generateContent 请求 -> OpenAI chat 请求
// 模型名由 URL 传入（body.model 兜底），stream 由 action 决定（streamGenerateContent）。
export function geminiReqToOpenAI(body, model, stream) {
  const messages = [];
  if (body.systemInstruction) {
    const sys = (body.systemInstruction.parts || []).map((p) => p.text || "").join("");
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const c of body.contents || []) {
    const role = c.role === "model" ? "assistant" : "user";
    const text = (c.parts || []).map((p) => p.text || "").join("");
    if (text) messages.push({ role, content: text });
  }
  const gc = body.generationConfig || {};
  const out = {
    model: model || body.model,
    messages,
    stream: !!stream,
    max_tokens: gc.maxOutputTokens ?? 1024,
  };
  if (gc.temperature != null) out.temperature = gc.temperature;
  if (gc.topP != null) out.top_p = gc.topP;
  return out;
}

// ---------- 各家 -> OpenAI 格式（非流式） ----------

export function anthropicToOpenAI(j, model) {
  const content = (j.content || []).map((c) => c.text || "").join("");
  const usage = j.usage || {};
  return {
    id: "chatcmpl-" + (j.id || Date.now()),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: mapFinish(j.stop_reason),
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

export function geminiToOpenAI(j, model) {
  const parts = j.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  const u = j.usageMetadata || {};
  return {
    id: "chatcmpl-g" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: u.promptTokenCount || 0,
      completion_tokens: u.candidatesTokenCount || 0,
      total_tokens: (u.promptTokenCount || 0) + (u.candidatesTokenCount || 0),
    },
  };
}

// ---------- 出站协议适配：OpenAI 响应 -> Anthropic / Gemini（非流式） ----------

// OpenAI chat 响应 -> Anthropic /v1/messages 响应
export function openAIRespToAnthropic(j, model) {
  const choice = (j.choices || [])[0] || {};
  const text = choice.message?.content || "";
  const toolCalls = (choice.message && Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [])
    .filter((tc) => tc && tc.type === "function" && tc.function && tc.function.name);
  const u = j.usage || {};
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const tc of toolCalls) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: tc.id || ("toolu_" + Date.now()), name: tc.function.name, input });
  }
  return {
    id: "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason:
      choice.finish_reason === "tool_calls" ? "tool_use" :
      choice.finish_reason === "length" ? "max_tokens" :
      "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
    },
  };
}

// Codex 模型归一化（对齐原版 openai_codex_transform.go 的 codexModelMap）
// openai OAuth 账号（ChatGPT Codex）上游只认 codex 模型名，如 gpt-5.3 -> gpt-5.3-codex、gpt-5 -> gpt-5.4
const CODEX_MODEL_MAP = {
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.5": "gpt-5.5",
  "gpt-5.5-pro": "gpt-5.5-pro",
  "codex-auto-review": "codex-auto-review",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.4-none": "gpt-5.4",
  "gpt-5.4-low": "gpt-5.4",
  "gpt-5.4-medium": "gpt-5.4",
  "gpt-5.4-high": "gpt-5.4",
  "gpt-5.4-xhigh": "gpt-5.4",
  "gpt-5.4-chat-latest": "gpt-5.4",
  "gpt-5.3": "gpt-5.3-codex",
  "gpt-5.3-none": "gpt-5.3-codex",
  "gpt-5.3-low": "gpt-5.3-codex",
  "gpt-5.3-medium": "gpt-5.3-codex",
  "gpt-5.3-high": "gpt-5.3-codex",
  "gpt-5.3-xhigh": "gpt-5.3-codex",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-none": "gpt-5.2",
  "gpt-5.2-low": "gpt-5.2",
  "gpt-5.2-medium": "gpt-5.2",
  "gpt-5.2-high": "gpt-5.2",
  "gpt-5.2-xhigh": "gpt-5.2",
  "gpt-5": "gpt-5.4",
  "gpt-5-mini": "gpt-5.4",
  "gpt-5-nano": "gpt-5.4",
  "gpt-5.1": "gpt-5.4",
  "gpt-5.1-codex": "gpt-5.3-codex",
  "gpt-5.1-codex-max": "gpt-5.3-codex",
  "gpt-5.1-codex-mini": "gpt-5.3-codex",
  "gpt-5.2-codex": "gpt-5.2",
  "codex-mini-latest": "gpt-5.3-codex",
  "gpt-5-codex": "gpt-5.3-codex",
};

export function normalizeCodexModel(model) {
  const m = String(model || "").trim();
  if (!m) return "gpt-5.4";
  const key = m.split("/").pop().toLowerCase().replace(/\s+/g, "-");
  if (CODEX_MODEL_MAP[key]) return CODEX_MODEL_MAP[key];
  // 带日期后缀的版本（如 gpt-5.2-2025-12-11）原样保留；gpt-5.x-chat-latest 类后缀已在上表
  return m;
}

// ChatGPT Codex /v1/responses 响应 -> OpenAI chat 响应（openai OAuth 上游转换）
export function responsesRespToOpenAI(j, model) {
  const text = (j.output || [])
    .filter((o) => o && (o.type === "message" || o.type === "reasoning"))
    .flatMap((o) => (o.content || []).map((p) => p.text || ""))
    .join("");
  const u = j.usage || {};
  const inputTokens = u.input_tokens || u.prompt_tokens || 0;
  const outputTokens = u.output_tokens || u.completion_tokens || 0;
  return {
    id: "chatcmpl-" + String(j.id || Date.now()).replace(/^resp_/, ""),
    object: "chat.completion",
    created: j.created_at || Math.floor(Date.now() / 1000),
    model: j.model || model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: j.status === "completed" ? "stop" : "stop",
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// OpenAI chat 响应 -> Responses API 响应（/v1/responses 出站转换）
export function openAIRespToResponses(j, model) {
  const choice = (j.choices || [])[0] || {};
  const text = choice.message?.content || "";
  const u = j.usage || {};
  const inputTokens = u.prompt_tokens || 0;
  const outputTokens = u.completion_tokens || 0;
  return {
    id: "resp_" + (j.id ? String(j.id).replace(/^chatcmpl-/, "") : Date.now()),
    object: "response",
    created_at: j.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: j.model || model,
    output: [{
      id: "msg_" + Date.now(),
      type: "message",
      status: "completed",
      role: "assistant",
      content: text ? [{ type: "output_text", text, annotations: [] }] : [],
    }],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: u.total_tokens || inputTokens + outputTokens,
    },
  };
}

// OpenAI chat 响应 -> Gemini generateContent 响应
export function openAIRespToGemini(j, model) {
  const choice = (j.choices || [])[0] || {};
  const text = choice.message?.content || "";
  const u = j.usage || {};
  return {
    candidates: [{
      content: { role: "model", parts: text ? [{ text }] : [] },
      finishReason: choice.finish_reason === "length" ? "MAX_TOKENS" : "STOP",
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: u.prompt_tokens || 0,
      candidatesTokenCount: u.completion_tokens || 0,
      totalTokenCount: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
    },
    modelVersion: model,
  };
}

// ---------- 流式转换器（SSE -> OpenAI SSE） ----------

// ---------- 出站协议适配：OpenAI 流式 chunk -> Anthropic / Gemini SSE ----------

// OpenAI chat chunk -> Anthropic SSE 事件列表
// 支持 text + tool_calls（delta.tool_calls -> tool_use 块 + input_json_delta），
// 兼容增量式（OpenAI 原生逐段 arguments）与整块式（Gemini functionCall 一次性给出）两种上游。
function openAIChunkToAnthropic(j, state) {
  const out = [];
  const choice = (j.choices || [])[0] || {};
  const delta = choice.delta || {};
  const text = delta.content;
  if (!state.started) {
    state.started = true;
    state.blockIndex = 0;
    state.currentBlock = null; // "text" | "tool_use" | null
    state.toolState = new Map(); // tool index -> { id, name, args, started }
    out.push({
      type: "message_start",
      message: { id: "msg_" + Date.now(), type: "message", role: "assistant", model: state.model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }
  const closeBlock = () => {
    if (state.currentBlock) {
      out.push({ type: "content_block_stop", index: state.blockIndex - 1 });
      state.currentBlock = null;
    }
  };
  const openTextBlock = () => {
    if (state.currentBlock === "text") return;
    closeBlock();
    out.push({ type: "content_block_start", index: state.blockIndex++, content_block: { type: "text", text: "" } });
    state.currentBlock = "text";
  };
  if (text) {
    openTextBlock();
    out.push({ type: "content_block_delta", index: state.blockIndex - 1, delta: { type: "text_delta", text } });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const key = tc.index != null ? tc.index : 0;
      let ts = state.toolState.get(key);
      if (!ts) {
        ts = { id: tc.id || "", name: (tc.function && tc.function.name) || "", args: "", started: false };
        state.toolState.set(key, ts);
      }
      if (tc.id) ts.id = tc.id;
      if (tc.function && tc.function.name) ts.name = tc.function.name;
      if (tc.function && tc.function.arguments) ts.args += tc.function.arguments;
      if (!ts.started) {
        if (state.currentBlock === "text") closeBlock();
        const id = ts.id || ("toolu_" + Date.now() + "_" + key);
        out.push({
          type: "content_block_start",
          index: state.blockIndex++,
          content_block: { type: "tool_use", id, name: ts.name || "function", input: {} },
        });
        ts.started = true;
        state.currentBlock = "tool_use";
      }
      if (tc.function && tc.function.arguments) {
        out.push({ type: "content_block_delta", index: state.blockIndex - 1, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
      }
    }
  }
  if (j.usage) {
    state.usage = { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 };
    state.outputTokens = j.usage.completion_tokens || 0;
  }
  if (choice.finish_reason) {
    closeBlock();
    out.push({
      type: "message_delta",
      delta: {
        stop_reason:
          choice.finish_reason === "tool_calls" ? "tool_use" :
          choice.finish_reason === "length" ? "max_tokens" :
          "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: state.outputTokens || 0 },
    });
    state.finished = true;
  }
  return out;
}

function flushAnthropic(state) {
  const out = [];
  // 上游完全无数据（空 200 / 无候选内容）时，仍要输出合法的 Anthropic SSE 结构：
  // 缺少 message_start 的流会让 Claude Code 报 "Stream ended without receiving any events"
  if (!state.started) {
    state.started = true;
    out.push({
      type: "message_start",
      message: { id: "msg_" + Date.now(), type: "message", role: "assistant", model: state.model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    });
    out.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    out.push({ type: "content_block_stop", index: 0 });
  } else if (!state.finished) {
    // 未收到 finish_reason（上游提前断流）：关闭当前打开的块（text 或 tool_use）
    if (state.currentBlock) out.push({ type: "content_block_stop", index: state.blockIndex - 1 });
  }
  if (!state.finished) {
    // 用 translator 累积的 finishReason（如 antigravity 的 tool_calls）决定 stop_reason
    const fr = state.finishReason || "";
    out.push({
      type: "message_delta",
      delta: {
        stop_reason:
          fr === "tool_calls" ? "tool_use" :
          fr === "length" ? "max_tokens" :
          "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: state.outputTokens || 0 },
    });
  }
  out.push({ type: "message_stop" });
  return out;
}

// OpenAI chat chunk -> Gemini SSE chunk 列表
function openAIChunkToGemini(j, state) {
  const choice = (j.choices || [])[0] || {};
  const text = choice.delta?.content || "";
  const out = [];
  if (text) out.push({ candidates: [{ index: 0, content: { role: "model", parts: [{ text }] } }] });
  // Gemini 流式协议要求结束 chunk 带 finishReason，否则客户端（Cherry Studio / Gemini CLI）
  // 报 "stream ended without a finish reason" / "finish reason other"（见 gemini-cli issue #10678）
  if (choice.finish_reason) {
    const fr =
      choice.finish_reason === "length" ? "MAX_TOKENS" :
      choice.finish_reason === "content_filter" ? "SAFETY" :
      "STOP";
    out.push({ candidates: [{ index: 0, finishReason: fr }] });
  }
  if (j.usage) {
    state.usage = { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 };
    out.push({
      candidates: [],
      usageMetadata: {
        promptTokenCount: j.usage.prompt_tokens || 0,
        candidatesTokenCount: j.usage.completion_tokens || 0,
        totalTokenCount: (j.usage.prompt_tokens || 0) + (j.usage.completion_tokens || 0),
      },
    });
  }
  return out;
}

// OpenAI chat chunk -> Responses API SSE 事件（/v1/responses 流式出站转换）
// 返回 { event, data } 列表；响应体字段名与官方 Responses streaming 事件一致。
// 支持 text（output_text）与 tool_calls（function_call 项）。
function openAIChunkToResponses(j, state) {
  const out = [];
  const choice = (j.choices || [])[0] || {};
  const delta = choice.delta || {};
  const text = delta.content;
  if (!state.started) {
    state.started = true;
    state.responseId = "resp_" + Date.now();
    state.items = []; // { kind: "message" | "function_call", id, outputIndex, text?, callId?, name?, args? }
    state.toolState = new Map();
    state.model = state.model || j.model || "";
    const created = Math.floor(Date.now() / 1000);
    out.push({
      event: "response.created",
      data: { type: "response.created", response: { id: state.responseId, object: "response", created_at: created, status: "in_progress", model: state.model, output: [] } },
    });
  }
  // 惰性创建 text 消息项（首个文本 chunk 时）
  const ensureTextItem = () => {
    let item = state.items.find((i) => i.kind === "message");
    if (item) return item;
    item = { kind: "message", id: "msg_" + Date.now(), outputIndex: state.items.length, text: "" };
    state.items.push(item);
    out.push({
      event: "response.output_item.added",
      data: { type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } },
    });
    out.push({
      event: "response.content_part.added",
      data: { type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    });
    return item;
  };
  if (text) {
    const item = ensureTextItem();
    out.push({
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", item_id: item.id, output_index: item.outputIndex, content_index: 0, delta: text },
    });
    item.text += text;
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const key = tc.index != null ? tc.index : 0;
      let ts = state.toolState.get(key);
      if (!ts) {
        // function_call 项在文本项之后追加（output_index 递增）
        const item = { kind: "function_call", id: "fc_" + Date.now() + "_" + key, outputIndex: state.items.length, callId: tc.id || ("call_" + Date.now() + "_" + key), name: (tc.function && tc.function.name) || "", args: "" };
        state.items.push(item);
        ts = { item, started: false };
        state.toolState.set(key, ts);
        out.push({
          event: "response.output_item.added",
          data: { type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "in_progress", call_id: item.callId, name: item.name, arguments: "" } },
        });
      }
      if (tc.id) ts.item.callId = tc.id;
      if (tc.function && tc.function.name) ts.item.name = tc.function.name;
      if (tc.function && tc.function.arguments) {
        ts.item.args += tc.function.arguments;
        out.push({
          event: "response.function_call_arguments.delta",
          data: { type: "response.function_call_arguments.delta", item_id: ts.item.id, output_index: ts.item.outputIndex, delta: tc.function.arguments },
        });
      }
    }
  }
  if (j.usage) {
    state.usage = { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 };
  }
  if (choice.finish_reason) state.finished = true;
  return out;
}

function flushResponses(state) {
  const out = [];
  if (!state.started) {
    state.started = true;
    state.responseId = "resp_" + Date.now();
    state.items = [];
    state.model = state.model || "";
    out.push({
      event: "response.created",
      data: { type: "response.created", response: { id: state.responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: state.model, output: [] } },
    });
  }
  // 无任何项时补一个空 text 项，保证 response.completed 的 output 非空
  if (!state.items.length) {
    const item = { kind: "message", id: "msg_" + Date.now(), outputIndex: 0, text: "" };
    state.items.push(item);
  }
  const output = [];
  for (const item of state.items) {
    if (item.kind === "message") {
      const text = item.text || "";
      out.push({ event: "response.output_text.done", data: { type: "response.output_text.done", item_id: item.id, output_index: item.outputIndex, content_index: 0, text } });
      out.push({ event: "response.content_part.done", data: { type: "response.content_part.done", item_id: item.id, output_index: item.outputIndex, content_index: 0, part: { type: "output_text", text, annotations: [] } } });
      out.push({
        event: "response.output_item.done",
        data: { type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
      });
      output.push({ id: item.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
    } else if (item.kind === "function_call") {
      const args = item.args || "";
      out.push({ event: "response.function_call_arguments.done", data: { type: "response.function_call_arguments.done", item_id: item.id, output_index: item.outputIndex, arguments: args } });
      out.push({
        event: "response.output_item.done",
        data: { type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: args } },
      });
      output.push({ id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: args });
    }
  }
  const u = state.usage || {};
  out.push({
    event: "response.completed",
    data: {
      type: "response.completed",
      response: {
        id: state.responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: state.model,
        output,
        usage: {
          input_tokens: u.prompt_tokens || 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: u.completion_tokens || 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
        },
      },
    },
  });
  return out;
}

// 同协议直通时使用：原样透传上游 SSE 数据行，同时捕获 usage（OpenAI/Anthropic/Gemini 三种形态都识别）
export const passthroughTranslator = {
  onData(data, state) {
    let j;
    try { j = JSON.parse(data); } catch { return []; }
    // OpenAI: { usage: {...} }；Anthropic: message_start / message_delta 带 usage；Gemini: usageMetadata
    if (j.type === "message_start" && j.message && j.message.usage) {
      state.usage = {
        prompt_tokens: j.message.usage.input_tokens || 0,
        completion_tokens: j.message.usage.output_tokens || 0,
      };
      state.inputTokens = j.message.usage.input_tokens || 0;
    } else if (j.type === "message_delta" && j.usage) {
      state.usage = {
        prompt_tokens: state.inputTokens || 0,
        completion_tokens: j.usage.output_tokens || 0,
      };
    } else if (j.usageMetadata) {
      state.usage = {
        prompt_tokens: j.usageMetadata.promptTokenCount || 0,
        completion_tokens: j.usageMetadata.candidatesTokenCount || 0,
      };
    } else if (j.usage) {
      state.usage = {
        prompt_tokens: j.usage.prompt_tokens || 0,
        completion_tokens: j.usage.completion_tokens || 0,
      };
    }
    return [j];
  },
  flush() { return []; },
};

export const openaiPassTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return null; }
    if (j && j.usage) state.usage = j.usage;
    return [j];
  },
  flush() { return []; },
};

// ChatGPT Codex /v1/responses SSE -> OpenAI chat SSE（openai OAuth 上游流式转换）
export const responsesTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return []; }
    const type = state.event || j.type;
    const out = [];
    if (type === "response.output_text.delta") {
      const text = j.delta;
      if (text) {
        if (!state.started) {
          state.started = true;
          out.push({ id: "chatcmpl-" + Date.now(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        }
        out.push({ id: "chatcmpl-" + Date.now(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      }
    } else if (type === "response.completed" && j.response) {
      const r = j.response;
      if (r.usage) state.usage = {
        prompt_tokens: r.usage.input_tokens || 0,
        completion_tokens: r.usage.output_tokens || 0,
        total_tokens: (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0),
      };
    } else if (type === "error") {
      state.upstreamError = j.message || "upstream error";
    }
    return out;
  },
  flush(state) {
    return [{
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: state.usage || undefined,
    }];
  },
};

const anthropicTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return []; }
    const type = state.event || j.type;
    const out = [];
    if (type === "message_start") {
      state.inputTokens = j.message?.usage?.input_tokens || 0;
      state.usage = { prompt_tokens: state.inputTokens, completion_tokens: 0 };
      out.push({
        id: "chatcmpl-" + (j.message?.id || Date.now()),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    } else if (type === "content_block_delta") {
      const text = j.delta?.text;
      if (text) out.push({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    } else if (type === "message_delta") {
      state.stopReason = j.delta?.stop_reason;
      if (j.usage?.output_tokens != null) {
        state.outputTokens = j.usage.output_tokens;
        state.usage = { prompt_tokens: state.inputTokens || 0, completion_tokens: state.outputTokens };
      }
    } else if (type === "message_stop") {
      out.push({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: mapFinish(state.stopReason) }] });
    }
    return out;
  },
  flush() { return []; },
};

const geminiTranslator = {
  onData(data, state) {
    let j; try { j = JSON.parse(data); } catch { return []; }
    const parts = j.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("");
    const out = [];
    if (!state.trStarted) {
      state.trStarted = true;
      out.push({
        id: "chatcmpl-g" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
    }
    if (text) out.push({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    if (j.usageMetadata) {
      state.usage = {
        prompt_tokens: j.usageMetadata.promptTokenCount || 0,
        completion_tokens: j.usageMetadata.candidatesTokenCount || 0,
        total_tokens: (j.usageMetadata.promptTokenCount || 0) + (j.usageMetadata.candidatesTokenCount || 0),
      };
    }
    return out;
  },
  flush(state) {
    const u = state.usage || {};
    return [{
      id: "x",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: u.prompt_tokens || 0,
        completion_tokens: u.completion_tokens || 0,
        total_tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      },
    }];
  },
};

// 把上游的 SSE 流，按 translator 转成 OpenAI SSE 流；
// clientProtocol = "anthropic" | "gemini" 时再把 OpenAI chunk 转成对应协议的 SSE 事件。
export function makeOpenAIStream(upstreamBody, translator, state, onDone, clientProtocol = "openai") {
  const reader = upstreamBody.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buf = "";

  function emit(controller, c) {
    if (c == null) return;
    if (clientProtocol === "anthropic") {
      for (const ev of openAIChunkToAnthropic(c, state)) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify(ev) + "\n\n"));
      }
    } else if (clientProtocol === "gemini") {
      for (const g of openAIChunkToGemini(c, state)) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify(g) + "\n\n"));
      }
    } else if (clientProtocol === "responses") {
      // Responses SSE 需要 event: 行 + data: 行
      for (const ev of openAIChunkToResponses(c, state)) {
        controller.enqueue(encoder.encode("event: " + ev.event + "\ndata: " + JSON.stringify(ev.data) + "\n\n"));
      }
    } else {
      controller.enqueue(encoder.encode("data: " + JSON.stringify(c) + "\n\n"));
    }
  }

  function consume(controller, isFinal) {
    if (!buf) return;
    const lines = buf.split("\n");
    if (!isFinal) buf = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("event:")) { state.event = line.slice(6).trim(); continue; }
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const chunks = translator.onData(data, state) || [];
        for (const c of chunks) emit(controller, c);
      }
    }
  }

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        consume(controller, true);
        if (clientProtocol === "anthropic") {
          for (const ev of flushAnthropic(state)) {
            controller.enqueue(encoder.encode("data: " + JSON.stringify(ev) + "\n\n"));
          }
        } else if (clientProtocol === "responses") {
          for (const ev of flushResponses(state)) {
            controller.enqueue(encoder.encode("event: " + ev.event + "\ndata: " + JSON.stringify(ev.data) + "\n\n"));
          }
        } else {
          const tail = translator.flush ? (translator.flush(state) || []) : [];
          for (const c of tail) emit(controller, c);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        if (onDone) await onDone(state);
        controller.close();
        return;
      }
      buf += decoder.decode(value, { stream: true });
      consume(controller, false);
    },
  });
}

// 空响应自动重试用的流：自驱动读取上游 body，缓冲到“出现首个有内容的 chunk”或 EOF 才放行。
// 返回 { stream, emptiness }：
//   - 上游正常（首个内容 chunk 到达）→ emptiness resolve false，缓冲放行，之后实时透传
//   - 上游空响应（流结束仍无任何内容）→ emptiness resolve true，stream 不会被客户端消费
// start 驱动（非 pull 驱动），避免返回 Response 前无人拉取导致的死锁。
export function makeOpenAIStreamRetryable(upstreamBody, translator, state, onDone, clientProtocol = "openai") {
  const reader = upstreamBody.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buf = "";
  let released = false;
  let empty = true;
  const pending = []; // 已转换但尚未放行的源 chunk
  let resolveEmpty = null;
  const emptiness = new Promise((r) => (resolveEmpty = r));

  function chunkHasContent(c) {
    if (!c || typeof c !== "object") return false;
    const d = (c.choices && c.choices[0] && c.choices[0].delta) || {};
    if (typeof d.content === "string" && d.content.length > 0) return true;
    return Array.isArray(d.tool_calls) && d.tool_calls.length > 0;
  }

  function emit(controller, c) {
    if (c == null) return;
    if (clientProtocol === "anthropic") {
      for (const ev of openAIChunkToAnthropic(c, state)) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify(ev) + "\n\n"));
      }
    } else if (clientProtocol === "gemini") {
      for (const g of openAIChunkToGemini(c, state)) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify(g) + "\n\n"));
      }
    } else if (clientProtocol === "responses") {
      for (const ev of openAIChunkToResponses(c, state)) {
        controller.enqueue(encoder.encode("event: " + ev.event + "\ndata: " + JSON.stringify(ev.data) + "\n\n"));
      }
    } else {
      controller.enqueue(encoder.encode("data: " + JSON.stringify(c) + "\n\n"));
    }
  }

  function release(controller) {
    if (released) return;
    released = true;
    for (const c of pending) emit(controller, c);
    pending.length = 0;
  }

  function consume(controller, isFinal) {
    if (!buf) return;
    const lines = buf.split("\n");
    if (!isFinal) buf = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("event:")) { state.event = line.slice(6).trim(); continue; }
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const chunks = translator.onData(data, state) || [];
        for (const c of chunks) {
          if (chunkHasContent(c)) empty = false;
          if (!released) { pending.push(c); continue; }
          emit(controller, c);
        }
        // 首个内容 chunk 到达：放行缓冲并标记非空
        if (!released && !empty) {
          release(controller);
          if (resolveEmpty) { resolveEmpty(false); resolveEmpty = null; }
        }
      }
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              consume(controller, true);
              if (clientProtocol === "anthropic") {
                for (const ev of flushAnthropic(state)) {
                  controller.enqueue(encoder.encode("data: " + JSON.stringify(ev) + "\n\n"));
                }
              } else if (clientProtocol === "responses") {
                for (const ev of flushResponses(state)) {
                  controller.enqueue(encoder.encode("event: " + ev.event + "\ndata: " + JSON.stringify(ev.data) + "\n\n"));
                }
              } else {
                const tail = translator.flush ? (translator.flush(state) || []) : [];
                for (const c of tail) emit(controller, c);
              }
              if (resolveEmpty) { resolveEmpty(empty); resolveEmpty = null; }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              if (onDone) await onDone(state);
              controller.close();
              return;
            }
            buf += decoder.decode(value, { stream: true });
            consume(controller, false);
          }
        } catch (e) {
          if (resolveEmpty) { resolveEmpty(false); resolveEmpty = null; }
          try { controller.error(e); } catch {}
        }
      })();
    },
  });

  return { stream, emptiness };
}
