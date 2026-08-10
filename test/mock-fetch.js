// test/mock-fetch.js
// 本地替身上游：拦截 globalThis.fetch，模拟 OpenAI / Anthropic / Gemini 的响应。
// 关键：SSE 响应以「整段字符串」作为 body 返回（与真实上游行为一致），
// 这样被 handler 用 ReadableStream 重新流式化时不会触发 undici 的死锁。
export function installFetchMock() {
  const orig = globalThis.fetch;
  const mock = { calls: [], nextStatus: null };
  mock.restore = () => {
    globalThis.fetch = orig;
  };

  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const body = opts.body ? JSON.parse(opts.body) : null;
    const auth = (opts.headers && (opts.headers.authorization || opts.headers.Authorization)) || "";
    mock.calls.push({ url: u.toString(), host: u.host, headers: opts.headers || {}, body });
    console.log("    ↳ upstream ->", u.host, JSON.stringify(body?.model || ""));

    // 测试钩子：下一次上游调用强制返回指定状态码（探测失败场景用）
    if (mock.nextStatus) {
      const s = mock.nextStatus;
      mock.nextStatus = null;
      return new Response(JSON.stringify({ error: { message: "mock forced error", type: "mock" } }), {
        status: s,
        headers: { "content-type": "application/json" },
      });
    }

    // 坏 key：无论流式与否都返回 401 JSON（模拟上游鉴权失败）
    if (auth.includes("bad")) {
      return new Response(JSON.stringify({ error: { message: "invalid api key", type: "auth_error" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    if (u.host === "api.openai.com") return mockOpenAI(body);
    if (u.host === "chatgpt.com") return mockCodexResponses(body); // openai OAuth（ChatGPT Codex）
    if (u.host === "api.anthropic.com") return mockAnthropic(body);
    if (u.host === "generativelanguage.googleapis.com") return mockGemini(body, u);
    if (u.host === "api.x.ai") return mockOpenAI(body); // Grok 走 OpenAI 兼容协议
    if (u.host === "cloudcode-pa.googleapis.com") return mockAntigravity(body, u);
    return new Response("not found", { status: 404 });
  };

  return mock;
}

// openai OAuth（ChatGPT 网页登录）：走 chatgpt.com/backend-api/codex/responses（Responses 格式，强制 stream:true）
function mockCodexResponses(body) {
  if (!body?.stream) {
    return new Response(JSON.stringify({ detail: "Stream must be set to true" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })}`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: " world" })}`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } })}`,
  ].join("\n\n");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mockOpenAI(body) {
  if (body?.stream) {
    const sse = [
      `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`,
      `data: [DONE]`,
    ].join("\n\n");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function mockAnthropic(body) {
  if (body?.stream) {
    const sse = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":5}}}`,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}`,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}`,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`,
      `event: message_stop`,
      `data: {"type":"message_stop"}`,
    ].join("\n\n");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  // 非流式
  return new Response(
    JSON.stringify({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "Hello world" }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: "end_turn",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function mockAntigravity(body, u) {
  // 真实 Antigravity v1internal 响应（V1InternalResponse 包装）
  // project 为 proj-empty 时返回空响应（模拟上游配额耗尽/静默空流），用于测试空响应自动重试
  if (body && body.project === "proj-empty") {
    const isStream = u.pathname.endsWith("streamGenerateContent");
    if (isStream) {
      const sse = [
        `data: ${JSON.stringify({ response: { candidates: [], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } } })}`,
        `data: [DONE]`,
      ].join("\n\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ response: { candidates: [], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const geminiResp = (text) => ({
    response: {
      candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      responseId: "resp-ag-1",
    },
    modelVersion: "claude-sonnet-4-6",
  });
  const isStream = u.pathname.endsWith("streamGenerateContent");
  if (isStream) {
    const sse = [
      `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello" }] } }] } })}`,
      `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: " world" }] } }] } })}`,
      `data: ${JSON.stringify(geminiResp(""))}`,
      `data: [DONE]`,
    ].join("\n\n");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  if (u.pathname.endsWith("fetchAvailableModels")) {
    return new Response(JSON.stringify({ models: { "claude-sonnet-4-6": { status: "AVAILABLE" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(geminiResp("Hello world")), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockGemini(body, u) {
  // Gemini 的流式靠 URL 的 ?alt=sse 标识（上游 body 不含 stream 字段），故按 URL 判断
  const isStream = u.searchParams.get("alt") === "sse";
  if (isStream) {
    const sse = [
      `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}`,
      `data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}`,
    ].join("\n\n");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  // 非流式
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Hello world" }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
