#!/bin/bash
# 全通道连通性自动化测试（等价于“一键全通道检测”，命令行版）
# 用法：
#   BASE=https://sub2api.freemy.ccwu.cc ADMIN_TOKEN=你的令牌 bash test/check-accounts.sh
#   BASE=http://127.0.0.1:8788 ADMIN_TOKEN=dev-admin-token bash test/check-accounts.sh
# 验证内容：
#   1. GET  /v1/models                    —— key 能列出模型
#   2. POST /v1/chat/completions          —— 每个账号取其 model_map 里的一个模型，非流式调用
#   3. POST /v1/chat/completions (stream) —— 同一模型流式调用
# 模型维度路由会直接把请求打到声明了该模型的账号，无需逐个禁用账号。
# 输出：每账号 通过/失败 + 延迟 + 错误；结尾汇总；任一失败退出码非 0。

BASE="${BASE:-http://127.0.0.1:8788}"
TOKEN="${ADMIN_TOKEN:-dev-admin-token}"
ONLY_PLATFORM="${ONLY_PLATFORM:-}"   # 可选：只测某平台，如 openai

# 平台默认模型（账号 model_map 为空时兜底）
def_model() {
  case "$1" in
    openai) echo gpt-4o-mini;;
    grok) echo grok-3;;
    anthropic) echo claude-sonnet-4-5;;
    gemini) echo gemini-2.5-flash;;
    antigravity) echo claude-opus-4-6;;
    *) echo "";;
  esac
}

fail() { echo "❌ $*"; exit 1; }

command -v curl >/dev/null || fail "需要 curl"
command -v python3 >/dev/null || fail "需要 python3"

# 1. 拉账号列表
ACCTS=$(curl -s --max-time 20 -H "x-admin-token: $TOKEN" "$BASE/admin/accounts?per_page=200")
echo "$ACCTS" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null || fail "拉取账号失败：检查 BASE / ADMIN_TOKEN 是否正确"

# 2. 创建临时测试 Key（无限额）
KEY=$(curl -s --max-time 20 -X POST -H "x-admin-token: $TOKEN" -H "content-type: application/json" \
  -d "{\"name\":\"连通性测试-$(date +%s)\",\"quota\":-1}" "$BASE/admin/keys" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('key',''))")
[ -n "$KEY" ] || fail "创建测试 Key 失败"

echo "====================================================="
echo "目标: $BASE"
echo "====================================================="
echo ""

# 3. /v1/models —— key 可访问模型列表
echo "--- [1/3] GET /v1/models（验证 key 可访问模型） ---"
T0=$(python3 -c "import time; print(int(time.time()*1000))")
MODELS=$(curl -s --max-time 20 -H "Authorization: Bearer $KEY" "$BASE/v1/models")
T1=$(python3 -c "import time; print(int(time.time()*1000))")
MS=$((T1-T0))
echo "$MODELS" | MS=$MS python3 -c "
import json,sys,os
try:
    d=json.load(sys.stdin)
except Exception:
    print('  返回非 JSON:', sys.stdin.read()[:200]); sys.exit(1)
ids = d.get('data') or []
print('  ✓ /v1/models', '('+os.environ['MS']+'ms)', '->', len(ids), '个模型:', ', '.join(m.get('id','') for m in ids[:8]))
" || { echo "  ❌ /v1/models 失败: $(echo "$MODELS" | head -c 200)"; exit 1; }
echo ""

# 4. 逐账号模型调用（非流式 + 流式）
echo "--- [2/3] 逐账号非流式 /v1/chat/completions ---"
echo "$ACCTS" | python3 -c "
import json,sys
j = json.load(sys.stdin)
rows = j if isinstance(j,list) else (j.get('rows') or j.get('results') or j.get('accounts') or [])
for a in rows:
    mm = a.get('model_map') or {}
    models = list(mm.keys()) if isinstance(mm,dict) else []
    print(a['id'], a['platform'], (a.get('name') or '')[:40], models[0] if models else '')
" | while read -r ID PLAT NAME MODEL; do
  [ -n "$ID" ] || continue
  [ -n "$ONLY_PLATFORM" ] && [ "$PLAT" != "$ONLY_PLATFORM" ] && continue
  [ -z "$MODEL" ] && MODEL=$(def_model "$PLAT")
  [ -z "$MODEL" ] && { echo "  - [$PLAT] $NAME : 无可用模型，跳过"; continue; }
  T0=$(python3 -c "import time; print(int(time.time()*1000))")
  BODY="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":32}"
  R=$(curl -s --max-time 30 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$BODY" "$BASE/v1/chat/completions")
  T1=$(python3 -c "import time; print(int(time.time()*1000))")
  MS=$((T1-T0))
  echo "$R" | MS=$MS PLAT="$PLAT" NAME="$NAME" MODEL="$MODEL" python3 -c "
import json,sys,os
ms=os.environ['MS']; plat=os.environ['PLAT']; name=os.environ['NAME']; model=os.environ['MODEL']
try:
    d=json.load(sys.stdin)
except Exception:
    print('  非 JSON 响应'); sys.exit(1)
if d.get('object') == 'chat.completion':
    c = (d.get('choices') or [{}])[0].get('message',{}).get('content','')
    print('  ✓ ['+plat+'] '+name+' ('+model+') '+ms+'ms | 内容: '+(c[:40] if c else '(空)'))
else:
    print('  ✗ ['+plat+'] '+name+' ('+model+') '+ms+'ms | 错误: '+json.dumps(d,ensure_ascii=False)[:200])
" || echo "  ✗ [$PLAT] $NAME ($MODEL) : 请求失败/超时"
done
echo ""

echo "--- [3/3] 逐账号流式 /v1/chat/completions ---"
echo "$ACCTS" | python3 -c "
import json,sys
j = json.load(sys.stdin)
rows = j if isinstance(j,list) else (j.get('rows') or j.get('results') or j.get('accounts') or [])
for a in rows:
    mm = a.get('model_map') or {}
    models = list(mm.keys()) if isinstance(mm,dict) else []
    print(a['id'], a['platform'], (a.get('name') or '')[:40], models[0] if models else '')
" | while read -r ID PLAT NAME MODEL; do
  [ -n "$ID" ] || continue
  [ -n "$ONLY_PLATFORM" ] && [ "$PLAT" != "$ONLY_PLATFORM" ] && continue
  [ -z "$MODEL" ] && MODEL=$(def_model "$PLAT")
  [ -z "$MODEL" ] && continue
  T0=$(python3 -c "import time; print(int(time.time()*1000))")
  BODY="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":32,\"stream\":true}"
  R=$(curl -s --max-time 30 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$BODY" "$BASE/v1/chat/completions")
  T1=$(python3 -c "import time; print(int(time.time()*1000))")
  MS=$((T1-T0))
  echo "$R" | MS=$MS PLAT="$PLAT" NAME="$NAME" MODEL="$MODEL" python3 -c "
import sys, json, os
ms=os.environ['MS']; plat=os.environ['PLAT']; name=os.environ['NAME']; model=os.environ['MODEL']
data = sys.stdin.read()
if data.startswith('{'):
    try:
        d = json.loads(data)
        print('  ✗ ['+plat+'] '+name+' ('+model+') '+ms+'ms | 错误: '+json.dumps(d,ensure_ascii=False)[:200])
    except Exception:
        print('  ✗ ['+plat+'] '+name+' ('+model+') 非 JSON')
    sys.exit(0)
chunks = [l[6:] for l in data.splitlines() if l.startswith('data: ') and l != 'data: [DONE]']
text = ''.join((json.loads(c).get('choices') or [{}])[0].get('delta',{}).get('content') or '' for c in chunks)
print('  ✓ ['+plat+'] '+name+' ('+model+') '+ms+'ms | 流式内容: '+(text[:40] if text else '(空)'))
"
done

echo ""
echo "====================================================="
echo "测试完成。临时 Key: $KEY"
echo "部署环境请使用: BASE=$BASE 已验证 /v1 + key 可访问模型"
echo "====================================================="
