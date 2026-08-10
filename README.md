# Sub2API-CF · Cloudflare 原生版 (v2)

> 这是 [sub2api](https://github.com/Wei-Shaw/sub2api)（AI API 中转站）的 **Cloudflare 原生分支 / 移植版**。
> 原版依赖 Go 后端 + PostgreSQL + Redis；本分支把核心能力**重写到 Cloudflare Workers + D1** 上，零成本跑在边缘网络，无需任何 VPS。

一个**纯跑在 Cloudflare 上**的 AI API 中转站，对齐 sub2api 的核心能力：

- 支持 **5 个平台**：`openai` / `anthropic`(Claude) / `gemini` / `grok`(xAI) / `antigravity`
- 支持 **api_key** 与 **oauth** 两种凭证类型（**cookie/sessionKey 类型明确不支持**，规避平台限制风险）
- **Sub2API 风格批量导入**：简化数组 / Codex 风格 `content` / 原版备份导出 `sub2api-data` / NDJSON 四格式
- **多账号调度**：priority + schedulable + 限速/过载时间窗（对齐 Sub2API 调度策略）
- **OAuth 自动刷新**：Cron 每 10 分钟刷新临近过期的 token
- **管理模型**：用户 / 分组 / 套餐订阅 / 兑换码 / 公告 / 审计日志 / 站点设置 / 渠道监控 / 模型广场 / 模型限流（对齐原版后台页面）
- **网关门控**：Key 归属用户 → 用户状态/余额校验、Key 过期/停用、用户级 RPM 限流、账号级并发、**模型维度限流**（每 Key / 每用户对指定模型的 RPM + 并发上限）
- **API Key 分发** 给下游（Claude Code / Cursor / OpenCode / 任意 OpenAI 客户端）
- **令牌级用量统计** 与额度上限
- **零成本**：仅 Cloudflare Workers + D1（免费额度足够个人/小团队）

---

## 架构

```
下游客户端 (Claude Code / Cursor / OpenCode …)
   │  Authorization: Bearer sk-xxxx
   ▼
Cloudflare Worker  (sub2api-cf)
   ├─ 鉴权 user_keys 表 (D1)
   ├─ 选上游账号 (Sub2API 风格调度: priority + 限速/过载窗)
   ├─ OAuth 过期前自动刷新 (refreshOAuth)
   ├─ 协议转换 (OpenAI ⇄ Anthropic / Gemini；Grok/Antigravity 走 OpenAI 协议)
   ├─ 流式 SSE 转发
   └─ 用量落库 (D1 usage_logs)
   │
   ▼  fetch 上游
OpenAI / Anthropic / Gemini / xAI API
```

## 部署（5 步）

需要 Node.js ≥ 18（仅部署/运行 `wrangler` 命令；**`npm test` 与本地预览服务需要 Node ≥ 22**，因为用到内置 `node:sqlite`）与一个 Cloudflare 账号。

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 建 D1 数据库，把输出的 id 填进 wrangler.toml 的 database_id
npx wrangler d1 create sub2api-cf

# 4. 建表（远程）
npx wrangler d1 migrations apply sub2api-cf --remote

# 5. 设置管理令牌（强随机串），并部署
npx wrangler secret put ADMIN_TOKEN
#   在弹出的编辑器里输入：openssl rand -hex 32  的结果
npx wrangler deploy
```

部署完得到 `https://<你的子域>.workers.dev`（或 wrangler.toml 里配置的自定义域名）。

> 可选：Gemini OAuth 刷新需要 client_secret，用 `wrangler secret put GEMINI_OAUTH_CLIENT_SECRET` 设置。

### 管理令牌设置（二选一）

方式一（推荐，密钥不进仓库）：
```bash
npx wrangler secret put ADMIN_TOKEN
```

方式二（个人使用偷懒方案：直接写进 wrangler.toml 的 `[vars]`，改完 `wrangler deploy` 生效）：
```toml
[vars]
ADMIN_TOKEN = "sk-换成你的强随机串"
```

### 打不开后台？先看诊断页

部署后若 `/admin` 报 `unauthorized`，先打开**免令牌诊断页** `https://<你的地址>/admin/diag`，它会直接告诉你：

```json
{ "admin_token_configured": true,   // false = ADMIN_TOKEN 没设置（按上面方式一/二设置）
  "d1_bound": true,                  // false = D1 绑定缺失（检查 wrangler.toml 的 database_id）
  "d1_ok": true,                     // false = 表没建（执行 wrangler d1 migrations apply sub2api-cf --remote）
  "d1_tables": { "accounts_v2": true, "users": true } }
```

然后带令牌访问：`/admin?token=<你的ADMIN_TOKEN>`。如果之前输错过令牌，浏览器会记住，用 `localStorage.removeItem("sub2api_cf_token")` 清掉再刷新。

---

## 导入账号（核心能力）

### 格式 A：简化数组（推荐）

```bash
curl -X POST https://<你的地址>/admin/accounts/import \
  -H "x-admin-token: <ADMIN_TOKEN>" -H "content-type: application/json" -d '[
  {"name":"账号1","platform":"openai","type":"api_key",
   "credentials":{"api_key":"sk-xxx"}},
  {"name":"账号2","platform":"gemini","type":"oauth",
   "credentials":{"access_token":"...","refresh_token":"...","expires_at":1735689600000}}
]'
```

字段说明：

| 字段 | 说明 |
|---|---|
| `name` | 账号显示名（同名同平台重复导入会更新） |
| `platform` | `openai` / `anthropic` / `gemini` / `grok` / `antigravity` |
| `type` | `api_key` 或 `oauth`（`cookie` 会被拒绝） |
| `credentials` | `api_key` 类型：`{api_key}`；`oauth` 类型：`{access_token, refresh_token?, expires_at?, client_id?}` |
| `base_url` | 可选，留空用官方默认；第三方兼容网关填它的 base |
| `model_map` | 可选，`{"对外名":"上游真实名"}` |
| `priority` | 可选，越小越优先（默认 50） |
| `concurrency` | 可选，最大并发（默认 3） |

返回 `{total, created, updated, skipped, failed, items, errors}`，与 Sub2API 导入返回结构一致。

### 格式 B：Sub2API Codex 风格

```bash
curl -X POST https://<你的地址>/admin/accounts/import \
  -H "x-admin-token: <ADMIN_TOKEN>" -H "content-type: application/json" -d '{
  "content":"eyJhY2Nlc3NfdG9rZW4iOiAiLi4uIn0",
  "contents":["eyJ..."],
  "name":"批量",
  "platform":"openai"
}'
```

- `content` / `contents` 为 base64url(JSON) 形式的 OAuth 凭证串，自动解析出 `access_token` / `refresh_token` / `expires_at`。
- 每个 `content` 导入为一个 oauth 账号。

> 去重规则：相同 `platform + type + name + 凭证指纹` 不会重复建。

---

## 使用

### 1. 打开管理后台
浏览器访问 `https://<你的地址>/admin?token=<ADMIN_TOKEN>`，或直接打开 `/admin` 后在页面里粘贴令牌。侧边栏共 16 个页面：

- **概览**：累计 tokens / 调用次数 / 活跃用户 / Key / 账号 / 订阅统计 + **健康度卡片**（各平台账号可用/异常数、最近渠道探测结果含**延迟 ms** 与失败原因、Key 配额使用率进度条）
- **上游账号**：列表 + 手动添加 + 批量导入（四格式，含 NDJSON `.txt`）+ 开关 / 改名 / 清错 / 删除 / 单账号用量
- **API Keys**：生成 / 启停 / 额度调整 / 归属用户分组
- **用量记录**：逐条流水，带 Key 标签 / 账号名 / 模型 / token 数
- **用户 / 分组 / 套餐 / 订阅 / 兑换码**：原版管理模型，均可增删改；用户行点 **📊** 打开用量图表（按天 / 按模型 / 按账号的 token 与调用次数柱状图，纯 CSS 无外部依赖）
- **模型限流**：为指定 Key / 用户 / 全部流量设置某模型的每分钟请求数（RPM）与最大并发；模型名支持 `*` 通配，规则优先级 Key > 用户 > 全局、精确 > 通配（管理 API：`GET/POST /admin/model-limits`、`PATCH/DELETE /admin/model-limits/:id`）
- **公告 / 审计日志 / 渠道监控 / 模型广场 / 设置 / 接入说明**（渠道监控的探测结果带延迟 ms 与失败原因摘要；立即检测可手动触发）

下游客户端接入：在"接入说明"页复制对应协议的 curl 示例，API Key 填生成的 `sk-xxxx`。

### 2. 在客户端里接入
任意支持 OpenAI 格式的工具，把 API Base 指向你的 Worker 地址、API Key 填生成的 `sk-xxxx`。

```bash
# OpenAI 兼容（Claude Code / Cursor / OpenCode / 任意 OpenAI 客户端）
curl https://<你的地址>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

除 OpenAI 协议外，网关还提供与原版 Sub2API 一致的协议入口，客户端无需改协议即可直连：

| 客户端协议 | 端点 | 鉴权头 |
|---|---|---|
| OpenAI | `POST /v1/chat/completions`（别名 `/chat/completions`） | `Authorization: Bearer sk-xxxx` |
| OpenAI Responses | `POST /v1/responses`（别名 `/responses`，非流式 + 流式 SSE 均支持） | `Authorization: Bearer sk-xxxx` |
| Anthropic | `POST /v1/messages`（别名 `/messages`） | `x-api-key: sk-xxxx` + `anthropic-version: 2023-06-01` |
| Gemini 原生 | `POST /v1beta/models/{model}:generateContent` / `:streamGenerateContent` | `x-goog-api-key: sk-xxxx` 或 `?key=` |
| 模型列表 | `GET /v1/models`（OpenAI 风格）/ `GET /v1beta/models`（Gemini 风格） | 同上任意一种 |
| 用量 | `GET /v1/usage` | `Authorization: Bearer sk-xxxx` |
| Token 计数 | `POST /v1/messages/count_tokens` | `x-api-key: sk-xxxx` |

```bash
# OpenAI Responses API（新版 SDK / Assistants 类客户端）
curl https://<你的地址>/v1/responses \
  -H "Authorization: Bearer sk-xxxx" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","instructions":"你是个助手","input":"你好","stream":true}'
# 入站自动把 responses 格式转成内部 chat 请求，响应再转回 Responses 结构；
# 流式返回标准 Responses SSE 事件（response.created / output_text.delta / completed）

# Anthropic 原生（Claude Code / Claude CLI）
curl https://<你的地址>/v1/messages \
  -H "x-api-key: sk-xxxx" -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'

# Gemini 原生（Gemini CLI / SDK）
curl https://<你的地址>/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: sk-xxxx" -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"你好"}]}]}'
```

入站协议自动适配：客户端用哪种协议进来，就用哪种协议返回；上游账号用哪种平台（openai/anthropic/gemini/grok/antigravity），网关自动做协议翻译。

### 3. 查看用量
后台"概览"显示累计 tokens、调用次数、可用 Key / 账号数；客户端也能用 `GET /v1/usage` 查询自己的用量。

### 4. 与原版互导备份（数据管理）
后台"批量导入"支持**原版 Sub2API 的备份导出**（`type: "sub2api-data"`，含 `accounts` 数组），可以从原版后台"数据导出"得到的 JSON 直接粘贴/上传导入；也支持 **NDJSON/JSONL**（原版"账号列表"导出的 `.txt`，每行一个 JSON 对象，含 `id`/`name`/`platform`/`credentials`/`extra` 等原始字段）——直接上传原文件即可整批导入。字段自动归一：`apikey`/`setup-token` 等类型名、unix 秒或 ISO 字符串 `expires_at`（`2026-08-01T20:46:05Z`）、`notes`、`model_mapping`（自动提取为可用模型）、OpenAI `id_token`（自动解码补全 email/plan_type/chatgpt 账号 ID，与原版 `enrichCredentialsFromIDToken` 对齐）。备份里的 `proxies` 会被跳过（Cloudflare 版无代理绑定），导入结果同时返回原版兼容的 `account_created` / `account_failed` / `proxy_*` 字段。

**兼容原版导出里的损坏行**：原版 Go 导出会把错误信息里的引号双重转义成 `\\"`（文件里为 `\\\\"`），导致整行不是合法 JSON（典型：`temp_unschedulable_reason` 含 `GROK_OAUTH_REQUEST_FAILED` 的账号行）。导入器会自动修复（`\\\\"` → `\\"`，仅影响错误文本，不影响 JWT/token），坏行不再导致整批失败。

**同名账号按 token 区分**：原版允许重名账号（如两个 antigravity 的 `B`，不同邮箱/token）。本版导入时：同名同平台账号若 token（access_token/refresh_token）相同则视为同一账号做更新（幂等重导）；token 不同则作为独立账号新建，与你的原始数据保持一致。

**导出是原版格式的兼容超集**：头部 `type/version/exported_at/proxies/accounts` 与原版完全一致（`version: 1`），因此本版导出的备份可以直接导入回**原版**（原版忽略未知字段，只取账号部分）；同时额外携带完整扩展段，可在本版实例间**整体迁移**：

| 段 | 内容 |
|---|---|
| `users` / `groups` | 用户（含余额/并发/RPM）与分组 |
| `user_keys` | 分发 Key（含额度/过期/状态，带 `user`/`group` 名称引用） |
| `packages` / `subscriptions` | 套餐与订阅（带 `user`/`package` 名称引用） |
| `promo_codes` / `promo_usage` | 兑换码与兑换记录 |
| `announcements` / `settings` | 公告与站点设置 |
| `model_limits` | 模型限流规则（带 `user`/`key_label` 引用） |

导入时按名称/标识自动重建跨表关系（username / 分组名 / 套餐名 / Key 值），同一备份可重复导入（同名/同 Key 更新而非重复建），导入结果返回 `users_created` / `keys_created` / `subscriptions_created` 等分段计数。

对应管理 API（均需 `x-admin-token`）：

- `POST /admin/accounts/import` —— 多格式批量导入（数组 / Codex 风格 / 备份导出 / NDJSON）
- `POST /admin/accounts/import/codex-session` —— 与原版前端同路径的 Codex 会话导入
- `POST /admin/accounts/data` —— 原版"数据导入"路径（`{data: payload}` 包装）
- `GET /admin/accounts/data` —— 导出 `sub2api-data` 兼容超集备份（账号段可反向导入原版，扩展段在本版间迁移）

---

## 支持的供应商与模型映射

| 平台 | 默认 Base | 协议 | 凭证类型 |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | OpenAI 兼容 | api_key / oauth |
| `anthropic` | `https://api.anthropic.com` | Anthropic Messages | api_key / oauth |
| `gemini` | `https://generativelanguage.googleapis.com` | Gemini v1beta | api_key / oauth |
| `grok` | `https://api.x.ai/v1` | OpenAI 兼容 | api_key / oauth |
| `antigravity` | `https://cloudcode-pa.googleapis.com` | Antigravity v1internal（真实 Google API） | oauth（project_id + Google token） |

模型别名：在账号的 `model_map` 写 `{"对外名":"上游真实名"}`，例如 `claude-3-5-sonnet` → `claude-3-5-sonnet-20241022`。

**模型维度路由**：选账号时优先选 `model_map` 里声明了该模型的账号（每个账号只服务自己可用模型列表中的模型），`model_map` 为空/未配置的账号作为全能兜底；同优先级下 `priority` 小的先选。所以多平台混合使用时，`gpt-4o` 自动走 openai 账号、`grok-3` 走 grok 账号、`claude-*` 走 anthropic/antigravity 账号，互不抢单。

Antigravity 说明：账号 `credentials` 需含 `project_id`（Google Cloud 项目 ID）+ `access_token`（Google OAuth）。入站 `/v1/chat/completions`（OpenAI）与 `/v1/messages`（Anthropic）双协议自动翻译为 Antigravity `v1internal:generateContent` / `:streamGenerateContent?alt=sse`；模型名走 `model_map` 或内置别名（`claude-opus-4-6` → `claude-opus-4-6-thinking` 等）。

---

## OAuth 刷新

- 调度选中 oauth 账号时，若 `expires_at` 距现在 < 5 分钟，自动用 `refresh_token` 换取新 `access_token` 并写回 D1。
- Cron Trigger `*/10 * * * *` 会批量刷新所有临近过期的 oauth 账号。
- 刷新端点：`openai`→`auth.openai.com/oauth/token`，`gemini`→`oauth2.googleapis.com/token`，`grok`→`auth.x.ai/oauth2/token`，`antigravity`→`oauth2.googleapis.com/token`（antigravity 无 `client_id` 时用内置官方客户端，可用 `ANTIGRAVITY_CLIENT_ID/SECRET` 覆盖）。

---

## 本地测试

```bash
npm test
# 等价于：node --experimental-sqlite test/run.js
```

覆盖 relay 协议适配（OpenAI/Anthropic/Gemini/**Responses**）、导入（三格式/去重/cookie拒绝）、Sub2API 调度（priority/限速窗）、OAuth 刷新、Grok 平台、管理后台 API（账号/Key 增删改、用量流水）、用户/分组/套餐/兑换码/公告/设置/审计、用户用量图表汇总、网关用户门控与 RPM 限流、**模型维度限流**、**完整备份导出/跨实例回导**、**概览健康度 + 渠道探测延迟/失败原因**等 **336 项断言**，任一失败会非零退出。

## 本地预览管理后台（模拟服务）

**账号连通性测试**（自动化）：`npm run test:accounts` 或直接 `bash test/check-accounts.sh`，验证部署后 `https://你的域名/v1 + key` 能访问模型——步骤：① `GET /v1/models`（key 可列出模型）② 逐账号取 model_map 里一个模型非流式调用 ③ 同模型流式调用。模型维度路由会自动把请求打到声明该模型的账号，无需逐个禁用。

```bash
BASE=https://你的域名 ADMIN_TOKEN=你的令牌 bash test/check-accounts.sh
# 只测某平台：ONLY_PLATFORM=openai bash test/check-accounts.sh
# 本地：BASE=http://127.0.0.1:8788 ADMIN_TOKEN=dev-admin-token bash test/check-accounts.sh
```

**后台一键全通道检测**：渠道监控页「⚡ 一键全通道检测」按钮强制重新探测全部账号（不受 10 分钟节流限制），顶部生成「✓ 通过 X · ✗ 失败 Y」报告，每个失败账号给出可执行的恢复建议（凭证无效/上游不可达/限流/403 封锁/OAuth 过期等）。

注意需在能访问公网的环境运行（本机或已部署的 Worker）；部分数据中心 IP 会被 Anthropic 拒（403 Request not allowed），属网络侧限制而非账号问题。

不依赖 wrangler/Cloudflare，直接在浏览器里跑真实 worker + 内存 D1（node:sqlite），可完整操作后台（账号/Key/用量的增删改、批量导入）：

```bash
PORT=8788 node dev-server.mjs
# 打开 http://127.0.0.1:8788/admin?token=dev-admin-token
```

启动时自动灌入示例数据：4 个上游账号、3 个 Key、6 条用量流水、3 个用户、2 个分组、3 个套餐、3 张订阅、2 个兑换码、2 条公告、审计日志、站点设置、渠道监控结果；数据在内存中，重启即重置。令牌默认 `dev-admin-token`，可用 `ADMIN_TOKEN` 覆盖。注意：环境变量里已有 `PORT=60040`，必须显式指定 `PORT=8788`。

---

## 与原版的功能对齐表

| 原版 Sub2API 功能 | 本版状态 | 实现 / 替换方案 |
|---|---|---|
| 多协议网关（OpenAI/Anthropic/Gemini） | ✅ | `/v1/chat/completions`、`/v1/messages`、`/v1beta/*` + 自动协议转换 |
| 多账号调度（priority/限速/过载窗） | ✅ | 同款调度策略，D1 存储 |
| OAuth 自动刷新 | ✅ | Cron 每 10 分钟刷新临近过期 token |
| API Key 分发 + 用量统计 | ✅ | user_keys + usage_logs |
| 批量导入（数组/Codex/备份） | ✅ | 三格式导入 + 与原版互导备份 |
| 用户 / 分组管理 | ✅ | users / groups 表 + 后台页面（替代方案：管理员创建，无自注册） |
| 套餐 / 订阅 | ✅ | packages + user_subscriptions + 定时过期（替代方案：token 额度替代 USD 计费） |
| 兑换码 | ✅ | promo_codes + 兑换 API（替代方案：替代在线支付） |
| 公告 / 审计日志 / 站点设置 | ✅ | 对应表 + 后台页面 |
| 渠道监控 | ✅ | 账号健康探测（Cron + 手动触发），检测账号异常 |
| 模型广场 | ✅ | 汇总各账号 model_map + 平台默认模型 |
| 用户余额计费 | 🟡 替换 | `balance_tokens` token 额度替代 USD 余额；-1 = 不限 |
| 在线支付 | 🟡 替换 | 兑换码 + 管理员离线开通；可另接 Stripe Checkout（Worker 可调用） |
| 用户注册 / 登录（OAuth 站点） | 🟡 替换 | 管理员后台创建用户；`/admin/login/import` 保留 Codex 会话导入端点 |
| OAuth 登录导入 UI（网页扫码） | 🟡 替换 | 后台直接粘贴 token / 上传备份 JSON |
| 代理绑定 / 代理池 | ❌ 不支持 | Cloudflare 出口固定，无代理概念；导入时 `proxies` 跳过不报错 |
| cookie / sessionKey 账号 | ❌ 不支持 | 规避平台限制/会话重放风险，导入会被拒绝 |
| 用户级 RPM / 并发精确控制 | ✅ | 用户级 / Key 级 RPM + 账号级并发 + **模型维度限流**（每 Key / 每用户对指定模型设 RPM 与并发，支持 `*` 通配，优先级 Key > 用户 > 全局、精确 > 通配） |
| 单 Worker 边缘部署 | ✅ 独有 | 原版需 VPS + PostgreSQL + Redis，本版零成本纯 CF |

## 已知边界（MVP）

- **不支持 `cookie` / `sessionKey` 类型账号**（规避平台限制/会话重放风险，导入会被拒绝）。
- 备份导入中的 `proxies` 会被跳过（Cloudflare 版无代理绑定），不会报错。
- `/v1/messages/count_tokens` 与 `/v1/usage` 为轻量实现：token 计数是字符粗估，`/v1/usage` 只返回当前 Key 的汇总而非逐条流水。
- 定时任务（订阅/兑换码过期、渠道探测）依赖 Cloudflare Cron，免费版最低 1 分钟间隔，无内网穿透/回调能力。
- 单 Worker 的 CPU / 响应时长有上限（免费版约 10s CPU），超大模型长对话建议开 Workers Paid 提额。
- 不要把管理令牌和 Key 写进客户端日志；Key 泄露 ≈ 上游账号暴露。

## License

MIT
