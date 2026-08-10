// admin.js — 管理后台 HTML（被 Worker 直接 serve，无需构建）
// 注意：整个 HTML 包在一个外层模板字符串里，因此内部 <script> 不得出现：
//   1) 反引号（会提前结束外层模板字面量）
//   2) 反斜杠（会被模板字面量当作转义吞掉）
//   3) ${（会被模板字面量当作插值）
// 需要单引号时用 HTML 实体 &#39;，需要换行时用 &#10;，JS 内换行用 String.fromCharCode(10)。
// 对齐 Sub2API 管理后台：账号/Keys/用户/分组/套餐/订阅/兑换码/公告/用量/渠道监控/模型广场/审计/设置
export const ADMIN_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sub2API-CF 管理后台</title>
<style>
  :root{
    --bg:#0b0d12;--panel:#12151c;--panel2:#171b24;--bd:#232836;--bd2:#2b3245;
    --fg:#e8eaf0;--mut:#8b93a7;--mut2:#5b6378;
    --acc:#4f8cff;--acc2:#6ba2ff;--grn:#34c77b;--red:#f2635f;--amb:#f2b544;
    --radius:10px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,Segoe UI,Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
  a{color:var(--acc)}
  .layout{display:flex;min-height:100vh}
  /* ---------- 侧边栏 ---------- */
  .sidebar{width:218px;flex-shrink:0;background:var(--panel);border-right:1px solid var(--bd);display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
  .brand{display:flex;align-items:center;gap:10px;padding:18px 16px;border-bottom:1px solid var(--bd)}
  .brand .logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--acc),#7c5cff);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:15px}
  .brand .bt{font-weight:600;font-size:15px}
  .brand .bs{font-size:11px;color:var(--mut)}
  .nav{padding:10px 8px;flex:1;overflow-y:auto}
  .nav .sec{font-size:11px;color:var(--mut2);text-transform:uppercase;letter-spacing:.08em;padding:12px 10px 4px}
  .nav a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;color:var(--mut);text-decoration:none;font-size:13.5px;margin-bottom:2px;transition:background .15s,color .15s}
  .nav a .ic{width:18px;text-align:center;font-size:15px}
  .nav a:hover{background:var(--panel2);color:var(--fg)}
  .nav a.active{background:rgba(79,140,255,.13);color:var(--acc2);font-weight:600}
  .side-foot{padding:14px 16px;border-top:1px solid var(--bd);font-size:11px;color:var(--mut2)}
  /* ---------- 主区 ---------- */
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .topbar{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--bd);background:var(--panel);position:sticky;top:0;z-index:20}
  .topbar h1{font-size:16px;margin:0;font-weight:600}
  .topbar .spacer{flex:1}
  .topbar input{background:var(--bg);border:1px solid var(--bd);color:var(--fg);border-radius:7px;padding:7px 11px;font-size:13px;width:280px}
  .content{padding:20px 22px 60px;max-width:1180px;width:100%}
  /* ---------- 卡片 ---------- */
  .card{background:var(--panel);border:1px solid var(--bd);border-radius:var(--radius);padding:18px;margin-bottom:16px}
  .card h2{font-size:14px;margin:0 0 14px;color:var(--acc2);display:flex;align-items:center;justify-content:space-between}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:18px}
  .stat{background:var(--panel);border:1px solid var(--bd);border-radius:var(--radius);padding:16px}
  .stat .v{font-size:24px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
  .stat .l{font-size:12px;color:var(--mut)}
  .stat.grn .v{color:var(--grn)} .stat.acc .v{color:var(--acc2)} .stat.amb .v{color:var(--amb)} .stat.red .v{color:var(--red)}
  /* ---------- 概览健康度 ---------- */
  .health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-bottom:16px}
  .health-grid .card{margin-bottom:0}
  .plat{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--bd);border-radius:8px;margin-bottom:8px;background:var(--panel2)}
  .plat:last-child{margin-bottom:0}
  .plat .pc{font-size:12px;color:var(--mut)}
  .plat .pc b.g{color:var(--grn)} .plat .pc b.r{color:var(--red)} .plat .pc b.m{color:var(--mut2)}
  .probe{padding:7px 2px;border-bottom:1px solid var(--bd);font-size:12px}
  .probe:last-child{border-bottom:0}
  .probe-main{display:flex;align-items:center;gap:8px}
  .probe .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .probe .dot.ok{background:var(--grn)} .probe .dot.fail{background:var(--red)} .probe .dot.na{background:var(--mut2)}
  .probe .pname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
  .probe .platency{color:var(--mut2);font-size:11px;flex-shrink:0;font-family:ui-monospace,Menlo,Consolas,monospace}
  .probe .ptime{color:var(--mut2);font-size:11px;flex-shrink:0}
  .probe .perr{color:var(--red);font-size:11px;margin:4px 0 0 16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .qbar-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px}
  .qbar-row .ql{width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mut);flex-shrink:0}
  .qbar-row .qt{flex:1}
  .qbar-row .qv{width:110px;text-align:right;color:var(--mut2);font-size:11px;flex-shrink:0}
  .qbar-row .qv .pct{color:var(--fg);margin-left:0}
  /* ---------- 表格 ---------- */
  .tbl-wrap{overflow-x:auto;border:1px solid var(--bd);border-radius:var(--radius);background:var(--panel)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 12px;background:var(--panel2);color:var(--mut);font-weight:600;font-size:12px;border-bottom:1px solid var(--bd);white-space:nowrap}
  td{padding:9px 12px;border-bottom:1px solid var(--bd);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  tbody tr:hover{background:rgba(255,255,255,.02)}
  .empty{padding:28px;text-align:center;color:var(--mut2)}
  /* ---------- 徽章 ---------- */
  .badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:600}
  .b-openai{background:rgba(16,163,127,.15);color:#3ddc97}
  .b-anthropic{background:rgba(217,119,6,.16);color:#f2b544}
  .b-gemini{background:rgba(79,140,255,.15);color:#6ba2ff}
  .b-grok{background:rgba(167,139,250,.15);color:#c4b5fd}
  .b-antigravity{background:rgba(236,72,153,.15);color:#f9a8d4}
  .b-active{background:rgba(52,199,123,.15);color:var(--grn)}
  .b-disabled{background:rgba(91,99,120,.2);color:var(--mut)}
  .b-error{background:rgba(242,99,95,.15);color:var(--red)}
  .b-oauth{background:rgba(167,139,250,.15);color:#c4b5fd}
  .b-api_key,.b-apikey{background:rgba(16,163,127,.15);color:#3ddc97}
  .b-on{background:rgba(52,199,123,.15);color:var(--grn)}
  .b-off{background:rgba(91,99,120,.2);color:var(--mut)}
  .b-admin{background:rgba(242,181,68,.18);color:var(--amb)}
  .b-user{background:rgba(79,140,255,.15);color:var(--acc2)}
  .b-key{background:rgba(192,132,252,.15);color:#c084fc}
  .b-expired{background:rgba(91,99,120,.25);color:var(--mut)}
  .b-inactive{background:rgba(91,99,120,.2);color:var(--mut)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  /* ---------- 按钮 ---------- */
  .btn{display:inline-flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--bd2);color:var(--fg);border-radius:7px;padding:6px 13px;font-size:13px;cursor:pointer;transition:all .15s;text-decoration:none}
  .btn:hover{border-color:var(--acc);color:var(--acc2)}
  .btn.primary{background:var(--acc);border-color:var(--acc);color:#fff}
  .btn.primary:hover{background:var(--acc2);color:#fff}
  .btn.danger:hover{border-color:var(--red);color:var(--red)}
  .btn.sm{padding:3px 9px;font-size:12px}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .row-actions{display:flex;gap:5px;flex-wrap:wrap}
  .icon-btn{background:none;border:none;color:var(--mut);cursor:pointer;font-size:14px;padding:3px 6px;border-radius:6px}
  .icon-btn:hover{background:var(--panel2);color:var(--fg)}
  /* ---------- 表单 ---------- */
  label{display:block;color:var(--mut);font-size:12.5px;margin:12px 0 5px}
  input,select,textarea{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--fg);border-radius:7px;padding:8px 11px;font:inherit;font-size:13px}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc)}
  textarea{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;resize:vertical}
  .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
  .form-grid .full{grid-column:1/-1}
  .hint{font-size:12px;color:var(--mut2);margin-top:4px}
  /* ---------- 弹窗 ---------- */
  .modal-mask{position:fixed;inset:0;background:rgba(5,6,10,.66);display:none;align-items:flex-start;justify-content:center;padding:40px 16px;z-index:100;overflow-y:auto}
  .modal-mask.open{display:flex}
  .modal{background:var(--panel);border:1px solid var(--bd2);border-radius:12px;width:560px;max-width:100%;padding:20px}
  .modal.wide{width:720px}
  .modal h3{margin:0 0 4px;font-size:15px}
  .modal .m-sub{color:var(--mut);font-size:12.5px;margin-bottom:12px}
  .modal .foot{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
  /* ---------- 用量图表（纯 CSS 柱状图） ---------- */
  .chart-card{margin:12px 0;padding:12px 14px;background:var(--panel2);border:1px solid var(--bd2);border-radius:10px}
  .chart-card:first-of-type{margin-top:0}
  .chart-title{font-size:13px;font-weight:600;color:var(--fg);margin-bottom:10px;display:flex;align-items:center;gap:8px}
  .chart-title .ct-sub{font-size:11px;color:var(--mut2);font-weight:400}
  .cbar{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px}
  .cbar:last-child{margin-bottom:0}
  .cbar-label{width:140px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}
  .cbar-track{flex:1;height:14px;background:#21262d;border-radius:7px;overflow:hidden}
  .cbar-fill{height:100%;border-radius:7px;background:linear-gradient(90deg,var(--acc),#7aa2ff);min-width:2px;transition:width .3s ease}
  .cbar-fill.alt{background:linear-gradient(90deg,#2fbf71,#6fe3a3)}
  .cbar-val{width:120px;color:var(--fg);text-align:right;flex-shrink:0;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace}
  .cbar-val .cv-calls{color:var(--mut2)}
  .chart-empty{padding:14px;text-align:center;color:var(--mut2);font-size:12.5px;border:1px dashed var(--bd2);border-radius:10px;margin:10px 0}
  /* ---------- toast ---------- */
  .toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:200}
  .toast{background:var(--panel2);border:1px solid var(--bd2);border-left:3px solid var(--acc);border-radius:8px;padding:10px 14px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:360px;animation:slideIn .18s ease}
  .toast.err{border-left-color:var(--red)}
  .toast.ok{border-left-color:var(--grn)}
  @keyframes slideIn{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}
  .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .toolbar .grow{flex:1}
  .toolbar input{width:220px}
  pre.result{background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:12px;overflow:auto;max-height:260px;font-size:12px}
  .progress{height:6px;background:var(--bg);border-radius:99px;overflow:hidden;min-width:90px}
  .progress>i{display:block;height:100%;background:var(--acc)}
  .progress>i.warn{background:var(--amb)}
  .progress>i.danger{background:var(--red)}
  .pct{font-size:11px;color:var(--mut);margin-left:6px}
  .kv{font-size:12px;color:var(--mut)}
  .sub{color:var(--mut)}
  .ann{background:rgba(79,140,255,.08);border:1px solid var(--bd);border-left:3px solid var(--acc);border-radius:8px;padding:10px 14px;margin-bottom:12px}
  .ann .t{font-weight:600;font-size:13px}
  .ann .c{font-size:12.5px;color:var(--mut);margin-top:4px;white-space:pre-wrap}
  @media (max-width:860px){.sidebar{display:none}.topbar input{width:170px}}
</style>
</head>
<body>
<div class="layout">
  <!-- 侧边栏 -->
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">S</div>
      <div><div class="bt">Sub2API-CF</div><div class="bs">Cloudflare 管理后台</div></div>
    </div>
    <nav class="nav" id="nav">
      <div class="sec">总览</div>
      <a href="#" data-view="dashboard" class="active"><span class="ic">📊</span>概览</a>
      <div class="sec">管理</div>
      <a href="#" data-view="accounts"><span class="ic">🧩</span>上游账号</a>
      <a href="#" data-view="keys"><span class="ic">🔑</span>API Keys</a>
      <a href="#" data-view="users"><span class="ic">👤</span>用户</a>
      <a href="#" data-view="groups"><span class="ic">🗂</span>分组</a>
      <a href="#" data-view="model-limits"><span class="ic">🎯</span>模型限流</a>
      <a href="#" data-view="usage"><span class="ic">📈</span>用量记录</a>
      <div class="sec">运营</div>
      <a href="#" data-view="packages"><span class="ic">📦</span>套餐</a>
      <a href="#" data-view="subscriptions"><span class="ic">🎫</span>订阅</a>
      <a href="#" data-view="promos"><span class="ic">🎟</span>兑换码</a>
      <a href="#" data-view="announcements"><span class="ic">📢</span>公告</a>
      <div class="sec">系统</div>
      <a href="#" data-view="channels"><span class="ic">🩺</span>渠道监控</a>
      <a href="#" data-view="models"><span class="ic">🧠</span>模型广场</a>
      <a href="#" data-view="audit"><span class="ic">🧾</span>审计日志</a>
      <a href="#" data-view="settings"><span class="ic">⚙️</span>设置</a>
      <div class="sec">帮助</div>
      <a href="#" data-view="help"><span class="ic">🛠</span>接入说明</a>
    </nav>
    <div class="side-foot">Workers + D1 · v2</div>
  </aside>

  <!-- 主区 -->
  <div class="main">
    <div class="topbar">
      <h1 id="pageTitle">概览</h1>
      <div class="spacer"></div>
      <input id="token" placeholder="ADMIN_TOKEN（粘贴后自动加载）" autocomplete="off">
    </div>
    <div class="content" id="content"></div>
  </div>
</div>

<!-- 弹窗容器 -->
<div id="modalRoot"></div>
<div class="toasts" id="toasts"></div>

<script>
var $=function(id){return document.getElementById(id);};
var state={view:"dashboard",accounts:[],keys:[],users:[],groups:[],modelLimits:[],packages:[],subs:[],promos:[],anns:[],channels:[],models:[],audit:[],usage:[],stats:null,settings:{}};

/* ---------- 基础工具 ---------- */
function esc(s){
  return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function token(){return $("token").value.trim();}
function toast(msg,type){
  var t=document.createElement("div");
  t.className="toast "+(type||"");
  t.textContent=msg;
  $("toasts").appendChild(t);
  setTimeout(function(){t.style.opacity="0";t.style.transition="opacity .3s";},3200);
  setTimeout(function(){t.remove();},3600);
}
function fmtTs(ts){
  if(!ts) return "-";
  var d=new Date(Number(ts));
  if(isNaN(d)) return "-";
  function p(n){return (n<10?"0":"")+n;}
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());
}
function fmtNum(n){
  n=Number(n||0);
  if(n>=1e9) return (n/1e9).toFixed(2)+"B";
  if(n>=1e6) return (n/1e6).toFixed(2)+"M";
  if(n>=1e3) return (n/1e3).toFixed(1)+"K";
  return String(n);
}
function fmtFull(n){return Number(n||0).toLocaleString("en-US");}
function badge(classes,label){return '<span class="badge '+classes+'">'+label+"</span>";}
function platformBadge(p){return badge("b-"+String(p).toLowerCase(),esc(p));}
function typeBadge(t){return badge("b-"+String(t).toLowerCase(),esc(t));}
function statusBadge(s){
  if(s==="active") return badge("b-active","● 正常");
  if(s==="error") return badge("b-error","● 异常");
  if(s==="expired") return badge("b-expired","● 已过期");
  if(s==="inactive") return badge("b-inactive","● 停用");
  return badge("b-disabled","● "+esc(s||"停用"));
}
function userStatusBadge(u){
  if(u.status==="disabled") return badge("b-disabled","已停用");
  return u.role==="admin"?badge("b-admin","管理员"):badge("b-user","用户");
}
function subStatusBadge(s){
  if(s==="active") return badge("b-active","生效中");
  if(s==="expired") return badge("b-expired","已过期");
  if(s==="revoked") return badge("b-off","已撤销");
  if(s==="suspended") return badge("b-disabled","已冻结");
  return badge("b-off",esc(s));
}
function progressPct(used,quota){
  if(quota==null||quota<=0) return null;
  var pct=Math.min(100,Math.round(used/quota*100));
  var cls=pct>=90?"danger":(pct>=70?"warn":"");
  return '<div class="progress" style="display:inline-block"><i class="'+cls+'" style="width:'+pct+'%"></i></div><span class="pct">'+pct+"%</span>";
}
function copyText(s){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(s).then(function(){toast("已复制到剪贴板","ok");});
  }else{
    var ta=document.createElement("textarea");ta.value=s;document.body.appendChild(ta);ta.select();
    try{document.execCommand("copy");toast("已复制到剪贴板","ok");}catch(e){toast("复制失败","err");}
    ta.remove();
  }
}
function maskKey(k){return k.slice(0,8)+"…"+k.slice(-4);}

/* ---------- API ---------- */
function api(path,opts){
  opts=opts||{};
  var headers=Object.assign({},opts.headers||{},{"x-admin-token":token()});
  if(opts.body) headers["content-type"]="application/json";
  return fetch(path,{method:opts.method||"GET",body:opts.body,headers:headers})
    .then(function(r){return r.json().then(function(j){
      if(!r.ok){var e=new Error(j.error||("HTTP "+r.status));e.status=r.status;e.body=j;throw e;}
      return j;
    });});
}

/* ---------- 视图切换 ---------- */
var VIEWS={
  dashboard:{title:"概览",render:loadDashboard},
  accounts:{title:"上游账号",render:renderAccounts},
  keys:{title:"API Keys",render:renderKeys},
  users:{title:"用户",render:renderUsers},
  groups:{title:"分组",render:renderGroups},
  "model-limits":{title:"模型限流",render:renderModelLimits},
  usage:{title:"用量记录",render:renderUsage},
  packages:{title:"套餐",render:renderPackages},
  subscriptions:{title:"订阅",render:renderSubs},
  promos:{title:"兑换码",render:renderPromos},
  announcements:{title:"公告",render:renderAnns},
  channels:{title:"渠道监控",render:renderChannels},
  models:{title:"模型广场",render:renderModels},
  audit:{title:"审计日志",render:renderAudit},
  settings:{title:"设置",render:renderSettings},
  help:{title:"接入说明",render:renderHelp}
};
function switchView(v){
  state.view=v;
  $("pageTitle").textContent=(VIEWS[v]||VIEWS.dashboard).title;
  var navs=$("nav").querySelectorAll("a[data-view]");
  for(var i=0;i<navs.length;i++){navs[i].className=navs[i].getAttribute("data-view")===v?"active":"";}
  if(v==="dashboard") loadDashboard();
  else if(v==="accounts") loadAccounts();
  else if(v==="keys") loadKeys();
  else if(v==="users") loadUsers();
  else if(v==="groups") loadGroups();
  else if(v==="model-limits") loadModelLimits();
  else if(v==="usage") loadUsage();
  else if(v==="packages") loadPackages();
  else if(v==="subscriptions") loadSubs();
  else if(v==="promos") loadPromos();
  else if(v==="announcements") loadAnns();
  else if(v==="channels") loadChannels();
  else if(v==="models") loadModels();
  else if(v==="audit") loadAudit();
  else if(v==="settings") loadSettings();
  else renderHelp();
}
function bindNav(){
  var navs=$("nav").querySelectorAll("a[data-view]");
  for(var i=0;i<navs.length;i++){
    navs[i].addEventListener("click",function(e){e.preventDefault();switchView(this.getAttribute("data-view"));});
  }
}
function loadError(c,e){c.innerHTML='<div class="card"><span class="badge b-error">加载失败：'+esc(e.message)+"</span></div>";}

/* ---------- 概览 ---------- */
function renderHealth(h){
  if(!h) return "";
  var platHtml="";
  (h.platforms||[]).forEach(function(p){
    platHtml+='<div class="plat"><div class="pn">'+platformBadge(p.platform)+'</div><div class="pc">'+
      '可用 <b class="g">'+p.active+'</b>/'+p.total+
      (p.error?' · 异常 <b class="r">'+p.error+'</b>':'')+
      (p.oauth?' · OAuth <b class="m">'+p.oauth+'</b>':'')+
      "</div></div>";
  });
  if(!platHtml) platHtml='<div class="sub">暂无账号，去「上游账号」导入</div>';
  var probeHtml="";
  (h.probes||[]).forEach(function(p){
    var ok=p.last_check_result==="ok";
    var lat=p.latency_ms!=null?" · "+p.latency_ms+"ms":"";
    probeHtml+='<div class="probe"><div class="probe-main"><span class="dot '+(ok?"ok":"fail")+'"></span><span class="pname">'+esc(p.name)+'</span><span>'+platformBadge(p.platform)+'</span><span class="platency">'+lat+'</span><span class="ptime">'+fmtTs(p.last_checked_at)+'</span></div>'+
      (ok?"":'<div class="perr" title="'+esc(p.probe_error||"")+'">'+esc(p.probe_error||"探测失败")+'</div>')+
      "</div>";
  });
  if(!probeHtml) probeHtml='<div class="sub">还没有探测记录，可在「渠道监控」页手动检测</div>';
  var q=h.quota||{};
  var qbar="";
  if(q.limited_keys){
    var qcls=q.pct>=90?"danger":(q.pct>=70?"warn":"");
    qbar+='<div class="qbar-row"><div class="ql">全部有限额 Key</div><div class="qt"><div class="progress"><i class="'+qcls+'" style="width:'+q.pct+'%"></i></div></div><div class="qv"><span class="pct">'+q.pct+'%</span> '+fmtNum(q.used_quota)+" / "+fmtNum(q.total_quota)+"</div></div>";
    (q.top||[]).forEach(function(k){
      var cls=k.pct>=90?"danger":(k.pct>=70?"warn":"");
      qbar+='<div class="qbar-row"><div class="ql" title="'+esc(k.key)+'">'+esc(k.label||k.key)+'</div><div class="qt"><div class="progress"><i class="'+cls+'" style="width:'+k.pct+'%"></i></div></div><div class="qv"><span class="pct">'+k.pct+'%</span> '+fmtNum(k.used_tokens)+" / "+fmtNum(k.quota_tokens)+"</div></div>";
    });
  }else{
    qbar='<div class="sub">还没有带额度的 Key，可在「API Keys」生成</div>';
  }
  if(q.unlimited_keys) qbar+='<div class="sub" style="margin-top:8px">另有 '+q.unlimited_keys+' 个不限额度 Key</div>';
  return '<div class="health-grid">'+
    '<div class="card"><h2>平台健康</h2>'+platHtml+"</div>"+
    '<div class="card"><h2>最近渠道探测</h2>'+probeHtml+"</div>"+
    '<div class="card"><h2>Key 配额使用率</h2>'+qbar+"</div>"+
    "</div>";
}
function loadDashboard(){
  var c=$("content");
  c.innerHTML='<div class="sub" style="margin-bottom:16px">加载中…</div>';
  Promise.all([api("/admin/stats"),api("/admin/announcements").catch(function(){return [];}),api("/admin/health").catch(function(){return null;})]).then(function(res){
    var s=res[0],anns=(res[1]||[]).filter(function(a){return a.status==="active";}),h=res[2];
    state.stats=s;
    var annHtml="";
    anns.forEach(function(a){annHtml+='<div class="ann"><div class="t">📢 '+esc(a.title)+'</div><div class="c">'+esc(a.content)+"</div></div>";});
    c.innerHTML=
      annHtml+
      '<div class="stats">'+
        '<div class="stat acc"><div class="l">累计 Tokens</div><div class="v">'+fmtNum(s.total_tokens)+'</div></div>'+
        '<div class="stat grn"><div class="l">调用次数</div><div class="v">'+fmtFull(s.calls)+'</div></div>'+
        '<div class="stat amb"><div class="l">可用 API Key</div><div class="v">'+s.active_keys+'</div></div>'+
        '<div class="stat red"><div class="l">可用上游账号</div><div class="v">'+s.active_accounts+'</div></div>'+
        '<div class="stat acc"><div class="l">活跃用户</div><div class="v">'+s.active_users+'</div></div>'+
        '<div class="stat grn"><div class="l">生效订阅</div><div class="v">'+s.active_subscriptions+'</div></div>'+
      '</div>'+
      renderHealth(h)+
      '<div class="card"><h2>快捷操作</h2>'+
        '<div style="display:flex;gap:10px;flex-wrap:wrap">'+
          '<button class="btn primary" onclick="openImportModal()">批量导入账号</button>'+
          '<button class="btn" onclick="openOAuthModal()">OAuth 登录导入</button>'+
          '<button class="btn" onclick="openAccountModal()">手动添加账号</button>'+
          '<button class="btn" onclick="openKeyModal()">生成 API Key</button>'+
          '<button class="btn" onclick="openUserModal()">新建用户</button>'+
          '<button class="btn" onclick="openSubModal()">开通订阅</button>'+
          '<a class="btn" href="/admin/accounts/data" onclick="return exportData(event)">导出备份</a>'+
        '</div></div>';
  }).catch(function(e){loadError(c,e);});
}
function exportData(e){
  e.preventDefault();
  return fetch("/admin/accounts/data",{headers:{"x-admin-token":token()}})
    .then(function(r){return r.json();})
    .then(function(j){
      var blob=new Blob([JSON.stringify(j,null,2)],{type:"application/json"});
      var a=document.createElement("a");a.href=URL.createObjectURL(blob);
      a.download="sub2api-backup-"+new Date().toISOString().slice(0,10)+".json";a.click();
      toast("备份已导出","ok");
    })
    .catch(function(e){toast("导出失败："+e.message,"err");});
  return false;
}

/* ---------- 账号管理 ---------- */
var acctSearch="",acctPlatform="";
function loadAccounts(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/accounts").then(function(list){state.accounts=list;renderAccounts();}).catch(function(e){loadError(c,e);});
}
function renderAccounts(){
  var q=acctSearch.toLowerCase();
  var rows=state.accounts.filter(function(a){
    if(acctPlatform&&a.platform!==acctPlatform) return false;
    if(q&&!(String(a.name).toLowerCase().indexOf(q)>=0||String(a.id).indexOf(q)>=0)) return false;
    return true;
  });
  var platforms=["openai","anthropic","gemini","grok","antigravity"];
  var platOpts='<option value="">全部平台</option>';
  platforms.forEach(function(p){platOpts+='<option value="'+p+'"'+(acctPlatform===p?" selected":"")+">"+p+"</option>";});
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openImportModal()">批量导入</button>'+
      '<button class="btn" onclick="openOAuthModal()">OAuth 登录</button>'+
      '<button class="btn" onclick="openAccountModal()">手动添加</button>'+
      '<div class="grow"></div>'+
      '<select style="width:140px" onchange="acctPlatform=this.value;renderAccounts()">'+platOpts+"</select>"+
      '<input placeholder="搜索名称 / ID…" value="'+esc(acctSearch)+'" oninput="acctSearch=this.value;renderAccounts()">'+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>名称</th><th>平台</th><th>类型</th><th>状态</th><th>调度</th><th>优先级</th><th>用量</th><th>上次使用</th><th>操作</th>"+
    '</tr></thead><tbody id="acctTbody"></tbody></table></div>';
  var tb=$("acctTbody");
  if(!rows.length){tb.innerHTML='<tr><td colspan="10" class="empty">暂无账号，点击「批量导入」或「手动添加」</td></tr>';return;}
  rows.forEach(function(a){
    var map=a.model_map||{};
    var maps=Object.keys(map);
    var mapStr=maps.length?"<div class='kv' style='margin-top:2px'>"+esc(maps.slice(0,4).join(", "))+(maps.length>4?" …":"")+"</div>":"";
    var err=a.error_message?'<div class="kv" style="color:var(--red);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(a.error_message)+'">'+esc(a.error_message)+"</div>":"";
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+a.id+"</td>"+
        '<td><div style="font-weight:600">'+esc(a.name)+"</div>"+mapStr+err+"</td>"+
        '<td>'+platformBadge(a.platform)+"</td>"+
        '<td>'+typeBadge(a.type)+"</td>"+
        '<td>'+statusBadge(a.status)+"</td>"+
        '<td>'+(a.schedulable?badge("b-on","参与调度"):badge("b-off","已暂停"))+"</td>"+
        '<td class="mono">'+a.priority+"</td>"+
        '<td class="mono">'+fmtNum(a.usage_tokens)+"</td>"+
        '<td class="kv">'+fmtTs(a.last_used_at)+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="编辑" onclick="openAccountModal('+a.id+')">✏️</button>'+
          '<button class="icon-btn" title="'+(a.schedulable?"暂停调度":"恢复调度")+'" onclick="toggleSchedulable('+a.id+')">'+(a.schedulable?"⏸":"▶️")+"</button>"+
          (a.status==="error"?'<button class="icon-btn" title="清除错误" onclick="clearAcctError('+a.id+')">🧹</button>':"")+
          '<button class="icon-btn" title="用量" onclick="openAcctUsage('+a.id+')">📈</button>'+
          '<button class="icon-btn" title="删除" onclick="deleteAccount('+a.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function findAccount(id){return state.accounts.find(function(x){return x.id===id;});}
function toggleSchedulable(id){
  api("/admin/accounts/"+id+"/toggle-schedulable",{method:"POST"}).then(function(){toast("已更新调度状态","ok");loadAccounts();}).catch(function(e){toast(e.message,"err");});
}
function clearAcctError(id){
  api("/admin/accounts/"+id+"/clear-error",{method:"POST"}).then(function(){toast("已清除错误","ok");loadAccounts();}).catch(function(e){toast(e.message,"err");});
}
function deleteAccount(id){
  var a=findAccount(id);
  if(!confirm("确定删除账号「"+(a?a.name:id)+"」？该操作不可恢复。")) return;
  api("/admin/accounts/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadAccounts();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 账号弹窗（新建/编辑） ---------- */
function openAccountModal(id){
  var a=id?findAccount(id):null;
  var m=openModal(
    (a?"编辑账号":"手动添加账号"),
    '<div class="form-grid">'+
      '<div><label>名称 *</label><input id="am_name" value="'+esc(a?a.name:"")+'"></div>'+
      '<div><label>平台 *</label><select id="am_platform">'+platformOptions(a?a.platform:"openai")+"</select></div>"+
      '<div><label>类型</label><select id="am_type">'+
        '<option value="api_key"'+(a&&a.type==="api_key"?" selected":"")+'>api_key</option>'+
        '<option value="oauth"'+(a&&a.type==="oauth"?" selected":"")+'>oauth</option>'+
      "</select></div>"+
      '<div><label>API Key / Access Token</label><input id="am_key" placeholder="sk-… / access_token" value="'+esc((a&&a.credentials&&a.credentials.api_key)||"")+'"></div>'+
      '<div><label>优先级（越小越优先）</label><input id="am_priority" type="number" value="'+(a?a.priority:50)+'"></div>'+
      '<div><label>并发</label><input id="am_concurrency" type="number" value="'+(a?a.concurrency:3)+'"></div>'+
      '<div class="full"><label>Base URL（可选，留空用默认）</label><input id="am_base" placeholder="https://api.openai.com/v1" value="'+esc(a?a.base_url||"":"")+'"></div>'+
      '<div class="full"><label>模型别名映射（JSON，可选）</label><textarea id="am_map" style="height:70px">'+esc(a?JSON.stringify(a.model_map||{},null,2):"")+'</textarea></div>'+
    "</div>",
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveAccount('+(a?a.id:"null")+')">保存</button>'
  );
}
function platformOptions(sel){
  var list=["openai","anthropic","gemini","grok","antigravity"];
  var out="";
  list.forEach(function(p){out+='<option value="'+p+'"'+(p===sel?" selected":"")+">"+p+"</option>";});
  return out;
}
function saveAccount(id){
  var body={
    name:$("am_name").value,
    platform:$("am_platform").value,
    type:$("am_type").value,
    priority:Number($("am_priority").value)||50,
    concurrency:Number($("am_concurrency").value)||3,
    base_url:$("am_base").value.trim(),
    model_map:{}
  };
  try{body.model_map=$("am_map").value.trim()?JSON.parse($("am_map").value):{};}catch(e){toast("模型映射不是合法 JSON","err");return;}
  var key=$("am_key").value.trim();
  if(id){
    api("/admin/accounts/"+id,{method:"PATCH",body:JSON.stringify({
      name:body.name,priority:body.priority,concurrency:body.concurrency,
      base_url:body.base_url,model_map:body.model_map
    })}).then(function(){toast("已保存","ok");closeModal();loadAccounts();}).catch(function(e){toast(e.message,"err");});
  }else{
    if(!body.name){toast("请填写名称","err");return;}
    if(!key&&body.type==="api_key"){toast("api_key 类型需要填 API Key","err");return;}
    body.credentials=body.type==="api_key"?{api_key:key}:{access_token:key};
    api("/admin/accounts",{method:"POST",body:JSON.stringify(body)})
      .then(function(){toast("已创建","ok");closeModal();loadAccounts();})
      .catch(function(e){toast(e.message,"err");});
  }
}

/* ---------- OAuth 登录导入（替换原版 OAuth 登录 UI） ---------- */
function openOAuthModal(){
  var provs=["openai","anthropic","gemini","grok","antigravity"];
  var btns="";
  provs.forEach(function(p){
    btns+='<button class="btn" style="margin-right:8px;margin-bottom:8px" onclick="oauthLogin(&#39;'+p+'&#39;)">'+esc(p)+" 登录</button>";
  });
  openModal("OAuth 登录导入",
    '<div class="m-sub">在提供商页面授权后，自动创建/更新对应平台的 oauth 类型账号（与 Sub2API 的 OAuth 登录导入一致）。需要先在环境变量配置该平台的 OAUTH_CLIENT_ID / SECRET。</div>'+
    '<div>'+btns+"</div>"+
    '<div class="hint" style="margin-top:10px">点击后浏览器会跳转到提供商授权页；授权完成后会回到本页面并自动导入账号。</div>',
    '<button class="btn" onclick="closeModal()">关闭</button>'
  );
}
function oauthLogin(provider){
  window.location.href="/admin/oauth/login?provider="+encodeURIComponent(provider);
}

/* ---------- 批量导入 ---------- */
function openImportModal(){
  var nl="&#10;";
  var ph="[ "+nl+'  {"name":"acc1","platform":"openai","type":"api_key","credentials":{"api_key":"sk-xxx"}}'+nl+"]"+nl+nl+'或 {"content":"eyJ...","name":"batch","platform":"openai"}'+nl+nl+'或 {"type":"sub2api-data","version":1,"proxies":[],"accounts":[...]}'+nl+nl+'或 NDJSON（每行一个 JSON 对象，原版账号列表导出 .txt）';
  var m=openModal("批量导入账号（Sub2API 格式）",
    '<div class="m-sub">支持四种格式：简化数组、Codex 风格 content、sub2api-data 备份导出、NDJSON（原版账号列表导出 .txt，每行一个 JSON 对象，自动跳过坏行）。</div>'+
    '<label>平台（Codex 风格 content 导入用）</label><select id="im_platform">'+platformOptions("openai")+"</select>"+
    '<label>导入内容（JSON）</label><textarea id="im_payload" style="height:210px" placeholder="'+ph+'"></textarea>'+
    '<div style="display:flex;align-items:center;gap:10px;margin-top:10px"><label style="margin:0">或上传 JSON 文件</label><input id="im_file" type="file" accept=".json,application/json" style="width:auto"></div>'+
    '<pre class="result" id="im_result" style="display:none"></pre>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="doImport()">导入</button>'
  );
}
function doImport(){
  var raw=$("im_payload").value.trim();
  if(!raw&&$("im_file").files.length){
    var f=$("im_file").files[0],fr=new FileReader();
    fr.onload=function(){submitImport(fr.result);};
    fr.readAsText(f);return;
  }
  submitImport(raw);
}
function submitImport(raw){
  var payload;
  try{payload=JSON.parse(raw);}
  catch(e){
    // JSON 整体解析失败 -> 尝试 NDJSON（每行一个 JSON 对象，原版账号列表导出 .txt）
    var lines=raw.split(String.fromCharCode(10)).map(function(l){return l.trim();}).filter(function(l){return l&&l.charAt(0)==="{";});
    var arr=[],bad=0;
    for(var i=0;i<lines.length;i++){
      try{arr.push(JSON.parse(lines[i]));}catch(e2){bad++;}
    }
    if(arr.length===0){toast("JSON 解析失败："+e.message,"err");return;}
    payload=arr;
  }
  if(payload&&!Array.isArray(payload)&&typeof payload==="object"&&!payload.platform&&payload.content){
    payload.platform=$("im_platform").value;
  }
  $("im_result").style.display="block";
  $("im_result").textContent="导入中…";
  api("/admin/accounts/import",{method:"POST",body:JSON.stringify(payload)})
    .then(function(r){
      var lines=["账号：成功 "+r.created+" · 更新 "+r.updated+" · 跳过 "+r.skipped+" · 失败 "+r.failed];
      var extra=[];
      if(r.users_created||r.users_updated) extra.push("用户 +"+r.users_created+"/更新 "+(r.users_updated||0));
      if(r.keys_created||r.keys_updated) extra.push("Key +"+r.keys_created+"/更新 "+(r.keys_updated||0));
      if(r.groups_created||r.groups_updated) extra.push("分组 +"+r.groups_created+"/更新 "+(r.groups_updated||0));
      if(r.packages_created||r.packages_updated) extra.push("套餐 +"+r.packages_created+"/更新 "+(r.packages_updated||0));
      if(r.subscriptions_created) extra.push("订阅 +"+r.subscriptions_created);
      if(r.promos_created||r.promos_updated) extra.push("兑换码 +"+r.promos_created+"/更新 "+(r.promos_updated||0));
      if(r.announcements_created) extra.push("公告 +"+r.announcements_created);
      if(r.settings_updated) extra.push("设置 "+r.settings_updated+" 项");
      if(r.model_limits_created) extra.push("限流规则 +"+r.model_limits_created);
      if(extra.length) lines.push("其他："+extra.join(" · "));
      if(r.proxy_skipped) lines.push("代理已跳过 "+r.proxy_skipped+"（不支持代理绑定）");
      if(r.warnings&&r.warnings.length) r.warnings.forEach(function(w){lines.push("⚠ "+w.message);});
      if(r.errors&&r.errors.length) r.errors.forEach(function(er){lines.push("✗ "+(er.section?er.section+" ":"")+er.message);});
      $("im_result").textContent=lines.join(String.fromCharCode(10));
      toast("导入完成："+r.created+" 成功"+(r.failed?"，"+r.failed+" 失败":""),"ok");
      loadAccounts();
    })
    .catch(function(e){$("im_result").textContent="导入失败："+e.message;toast(e.message,"err");});
}

/* ---------- 账号用量 ---------- */
function openAcctUsage(id){
  var a=findAccount(id);
  var m=openModal("账号用量 · "+(a?a.name:"#"+id),
    '<div id="au_body"><div class="sub">加载中…</div></div>',
    '<button class="btn" onclick="closeModal()">关闭</button>',true);
  api("/admin/accounts/"+id+"/usage").then(function(rows){
    var html=rows.length?
      '<div class="tbl-wrap" style="margin-top:8px"><table><thead><tr><th>时间</th><th>模型</th><th>Prompt</th><th>Completion</th><th>合计</th></tr></thead><tbody>'+
      rows.map(function(r){
        return "<tr><td class='kv'>"+fmtTs(r.created_at)+"</td><td class='mono'>"+esc(r.model)+"</td><td class='mono'>"+r.prompt_tokens+"</td><td class='mono'>"+r.completion_tokens+"</td><td class='mono'>"+(r.prompt_tokens+r.completion_tokens)+"</td></tr>";
      }).join("")+"</tbody></table></div>"
      :'<div class="sub" style="margin-top:8px">暂无用量记录</div>';
    $("au_body").innerHTML="<div class='m-sub'>最近 "+rows.length+" 条</div>"+html;
  }).catch(function(e){$("au_body").innerHTML='<span class="badge b-error">'+esc(e.message)+"</span>";});
}

/* ---------- API Keys ---------- */
function loadKeys(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/keys").then(function(list){state.keys=list;renderKeys();}).catch(function(e){loadError(c,e);});
}
function findKey(id){return state.keys.find(function(x){return x.id===id;});}
function renderKeys(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openKeyModal()">生成 API Key</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.keys.length+" 个 Key</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>Key</th><th>备注</th><th>归属用户</th><th>分组</th><th>额度</th><th>已用</th><th>过期</th><th>状态</th><th>操作</th>"+
    '</tr></thead><tbody id="keyTbody"></tbody></table></div>';
  var tb=$("keyTbody");
  if(!state.keys.length){tb.innerHTML='<tr><td colspan="9" class="empty">还没有 API Key，点击「生成 API Key」</td></tr>';return;}
  state.keys.forEach(function(k){
    var quota=k.quota_tokens==null?"不限":fmtFull(k.quota_tokens);
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td><span class="mono">'+esc(maskKey(k.key))+'</span> <button class="icon-btn" title="复制完整 Key" onclick="copyKey('+k.id+')">📋</button></td>'+
        '<td>'+esc(k.label||"-")+"</td>"+
        '<td>'+(k.user_name?esc(k.user_name):'-')+"</td>"+
        '<td>'+(k.group_name?esc(k.group_name):'-')+"</td>"+
        '<td class="mono">'+quota+"</td>"+
        '<td><span class="mono">'+fmtFull(k.used_tokens)+"</span>"+(k.quota_tokens!=null?"<br>"+progressPct(k.used_tokens,k.quota_tokens):"")+"</td>"+
        '<td class="kv">'+fmtTs(k.expires_at)+"</td>"+
        '<td>'+statusBadge(k.status)+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="启用/停用" onclick="toggleKey('+k.id+')">'+(k.enabled?"⏸":"▶️")+"</button>"+
          '<button class="icon-btn" title="编辑" onclick="openKeyModal('+k.id+')">✏️</button>'+
          '<button class="icon-btn" title="删除" onclick="deleteKey('+k.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function copyKey(id){
  var k=findKey(id);
  if(k) copyText(k.key);
}
function toggleKey(id){
  api("/admin/keys/toggle/"+id,{method:"POST"}).then(function(){toast("已切换状态","ok");loadKeys();}).catch(function(e){toast(e.message,"err");});
}
function deleteKey(id){
  var k=findKey(id);
  if(!confirm("确定删除 Key「"+(k?(k.label||k.key):id)+"」？")) return;
  api("/admin/keys/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadKeys();}).catch(function(e){toast(e.message,"err");});
}
function userOpts(sel){
  var out='<option value="">— 无 —</option>';
  state.users.forEach(function(u){out+='<option value="'+u.id+'"'+(sel===u.id?" selected":"")+">"+esc(u.username)+"</option>";});
  return out;
}
function groupOpts(sel){
  var out='<option value="">— 无 —</option>';
  state.groups.forEach(function(g){out+='<option value="'+g.id+'"'+(sel===g.id?" selected":"")+">"+esc(g.name)+"</option>";});
  return out;
}
function openKeyModal(id){
  var k=id?findKey(id):null;
  openModal(id?"编辑 API Key":"生成 API Key",
    '<div class="form-grid">'+
      '<div><label>备注</label><input id="km_label" value="'+esc(k?k.label:"")+'" placeholder="例如：小明 / 团队A"></div>'+
      '<div><label>归属用户</label><select id="km_user">'+userOpts(k?k.user_id:null)+"</select></div>"+
      '<div><label>分组</label><select id="km_group">'+groupOpts(k?k.group_id:null)+"</select></div>"+
      '<div><label>额度上限 tokens（留空=不限）</label><input id="km_quota" type="number" value="'+(k&&k.quota_tokens!=null?k.quota_tokens:"")+'" placeholder="例如 1000000"></div>'+
      '<div><label>RPM 上限（0=不限）</label><input id="km_rpm" type="number" value="'+(k?k.rpm_limit||0:0)+'"></div>'+
      '<div><label>有效期天数（留空=永久）</label><input id="km_days" type="number" value="" placeholder="例如 30"></div>'+
    "</div>"+(id?"":'<div class="hint">保存后会一次性展示完整 Key，请立即妥善保存。</div>'),
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveKey('+(k?k.id:"null")+')">保存</button>'
  );
}
function saveKey(id){
  var label=$("km_label").value.trim();
  var quota=$("km_quota").value;
  quota=quota===""?null:Number(quota);
  var userId=$("km_user").value?Number($("km_user").value):null;
  var groupId=$("km_group").value?Number($("km_group").value):null;
  var rpm=$("km_rpm").value?Number($("km_rpm").value):0;
  var days=$("km_days").value?Number($("km_days").value):null;
  if(id){
    var patch={label:label,user_id:userId,group_id:groupId,rpm_limit:rpm};
    if(quota!=null) patch.quota_tokens=quota;
    api("/admin/keys/"+id,{method:"PATCH",body:JSON.stringify(patch)}).then(function(){toast("已保存","ok");closeModal();loadKeys();}).catch(function(e){toast(e.message,"err");});
  }else{
    var body={label:label,quota_tokens:quota,user_id:userId,group_id:groupId,rpm_limit:rpm};
    if(days) body.expires_in_days=days;
    api("/admin/keys",{method:"POST",body:JSON.stringify(body)})
      .then(function(r){
        closeModal();
        openModal("新 API Key（请妥善保存）",
          '<p>此 Key 只显示一次：</p><div style="display:flex;gap:8px;align-items:center"><code class="mono" style="background:var(--bg);padding:10px;border-radius:8px;border:1px solid var(--bd);word-break:break-all">'+esc(r.key)+'</code><button class="btn primary" onclick="copyText(&#39;'+esc(r.key)+'&#39;)">复制</button></div>',
          '<button class="btn primary" onclick="closeModal()">我已保存</button>'
        );
        loadKeys();
      })
      .catch(function(e){toast(e.message,"err");});
  }
}

/* ---------- 用户 ---------- */
function loadUsers(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/users").then(function(list){state.users=list;renderUsers();}).catch(function(e){loadError(c,e);});
}
function findUser(id){return state.users.find(function(x){return x.id===id;});}
function renderUsers(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openUserModal()">新建用户</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.users.length+" 个用户</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>用户名</th><th>邮箱</th><th>角色</th><th>状态</th><th>余额 tokens</th><th>并发</th><th>RPM</th><th>Key 数</th><th>总用量</th><th>操作</th>"+
    '</tr></thead><tbody id="userTbody"></tbody></table></div>';
  var tb=$("userTbody");
  if(!state.users.length){tb.innerHTML='<tr><td colspan="11" class="empty">还没有用户，点击「新建用户」</td></tr>';return;}
  state.users.forEach(function(u){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+u.id+"</td>"+
        '<td><div style="font-weight:600">'+esc(u.username)+"</div></td>"+
        '<td>'+esc(u.email||"-")+"</td>"+
        '<td>'+userStatusBadge(u)+"</td>"+
        '<td>'+(u.status==="disabled"?badge("b-disabled","已停用"):badge("b-active","正常"))+"</td>"+
        '<td class="mono">'+(u.balance_tokens===-1?"不限":fmtFull(u.balance_tokens))+"</td>"+
        '<td class="mono">'+u.concurrency+"</td>"+
        '<td class="mono">'+(u.rpm_limit||0)+"</td>"+
        '<td class="mono">'+(u.key_count||0)+"</td>"+
        '<td class="mono">'+fmtNum(u.total_usage||0)+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="用量图表" onclick="openUserUsage('+u.id+')">📊</button>'+
          '<button class="icon-btn" title="编辑" onclick="openUserModal('+u.id+')">✏️</button>'+
          '<button class="icon-btn" title="充额度" onclick="openRechargeModal('+u.id+')">💰</button>'+
          '<button class="icon-btn" title="开通订阅" onclick="openSubModal('+u.id+')">🎫</button>'+
          '<button class="icon-btn" title="兑换码充值" onclick="openRedeemModal('+u.id+')">🎟</button>'+
          '<button class="icon-btn" title="删除" onclick="deleteUser('+u.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function openUserModal(id){
  var u=id?findUser(id):null;
  openModal(id?"编辑用户":"新建用户",
    '<div class="form-grid">'+
      '<div><label>用户名 *</label><input id="um_name" value="'+esc(u?u.username:"")+'"></div>'+
      '<div><label>邮箱</label><input id="um_email" value="'+esc(u?u.email||"":"")+'"></div>'+
      '<div><label>角色</label><select id="um_role">'+
        '<option value="user"'+(u&&u.role==="user"?" selected":"")+'>user</option>'+
        '<option value="admin"'+(u&&u.role==="admin"?" selected":"")+'>admin</option>'+
      "</select></div>"+
      '<div><label>状态</label><select id="um_status">'+
        '<option value="active"'+(u&&u.status!=="disabled"?" selected":"")+'>active</option>'+
        '<option value="disabled"'+(u&&u.status==="disabled"?" selected":"")+'>disabled</option>'+
      "</select></div>"+
      '<div><label>余额 tokens（-1=不限）</label><input id="um_balance" type="number" value="'+(u?u.balance_tokens:-1)+'"></div>'+
      '<div><label>并发</label><input id="um_concurrency" type="number" value="'+(u?u.concurrency:3)+'"></div>'+
      '<div class="full"><label>RPM 上限（0=不限）</label><input id="um_rpm" type="number" value="'+(u?u.rpm_limit||0:0)+'"></div>'+
      '<div class="full"><label>备注</label><input id="um_notes" value="'+esc(u?u.notes||"":"")+'"></div>'+
      '<div class="hint">新用户默认 -1（不限额度）；余额为 0 时该用户的所有 Key 会被网关拒绝（402）。</div>'+
    "</div>",
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveUser('+(u?u.id:"null")+')">保存</button>'
  );
}
function saveUser(id){
  var body={
    username:$("um_name").value.trim(),
    email:$("um_email").value.trim(),
    role:$("um_role").value,
    status:$("um_status").value,
    balance_tokens:Number($("um_balance").value)||0,
    concurrency:Number($("um_concurrency").value)||3,
    rpm_limit:Number($("um_rpm").value)||0,
    notes:$("um_notes").value.trim()
  };
  if(!body.username){toast("请填写用户名","err");return;}
  if(id){
    api("/admin/users/"+id,{method:"PATCH",body:JSON.stringify(body)}).then(function(){toast("已保存","ok");closeModal();loadUsers();}).catch(function(e){toast(e.message,"err");});
  }else{
    api("/admin/users",{method:"POST",body:JSON.stringify(body)})
      .then(function(){toast("已创建","ok");closeModal();loadUsers();})
      .catch(function(e){toast(e.message,"err");});
  }
}
function deleteUser(id){
  var u=findUser(id);
  if(!confirm("确定删除用户「"+(u?u.username:id)+"」？其 Key 将一并删除。")) return;
  api("/admin/users/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadUsers();}).catch(function(e){toast(e.message,"err");});
}
function openRechargeModal(id){
  var u=findUser(id);
  openModal("充额度 · "+(u?u.username:"#"+id),
    '<div class="m-sub">直接给用户余额追加 token 额度（-1 表示设为不限）。</div>'+
    '<label>追加 tokens</label><input id="rm_amount" type="number" value="1000000">',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveRecharge('+id+')">充值</button>'
  );
}
function saveRecharge(id){
  var amount=Number($("rm_amount").value)||0;
  var u=findUser(id);
  if(!u) return;
  var newBal=amount===-1?-1:(u.balance_tokens+(u.balance_tokens===-1?0:amount));
  api("/admin/users/"+id,{method:"PATCH",body:JSON.stringify({balance_tokens:newBal})})
    .then(function(){toast("已充值","ok");closeModal();loadUsers();}).catch(function(e){toast(e.message,"err");});
}
function openRedeemModal(id){
  var u=findUser(id);
  openModal("兑换码充值 · "+(u?u.username:"#"+id),
    '<label>兑换码</label><input id="rd_code" placeholder="PROMO-XXXX">',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="doRedeem('+id+')">兑换</button>'
  );
}
function doRedeem(id){
  var code=$("rd_code").value.trim();
  if(!code){toast("请输入兑换码","err");return;}
  api("/admin/promos/redeem",{method:"POST",body:JSON.stringify({user_id:id,code:code})})
    .then(function(r){toast("兑换成功 +"+fmtFull(r.bonus_tokens)+" tokens","ok");closeModal();loadUsers();})
    .catch(function(e){toast(e.message,"err");});
}

/* ---------- 用户用量图表 ---------- */
function openUserUsage(id){
  var u=findUser(id);
  openModal("用量图表 · "+(u?u.username:"#"+id),
    '<div class="m-sub">加载中…</div>',
    '<button class="btn" onclick="closeModal()">关闭</button>', true
  );
  api("/admin/users/"+id+"/usage?days=30").then(function(d){renderUserUsage(d);}).catch(function(e){
    var c=document.querySelector("#activeModalMask .modal-body");
    if(c)c.innerHTML='<div class="m-sub" style="color:var(--red)">加载失败：'+esc(e.message)+"</div>";
  });
}
function usageChart(title, sub, rows, alt){
  if(!rows||!rows.length)return "";
  var max=1;
  rows.forEach(function(r){if(Number(r.tokens)>max)max=Number(r.tokens);});
  var h='<div class="chart-card"><div class="chart-title">'+esc(title)+'<span class="ct-sub">'+esc(sub)+"</span></div>";
  rows.slice(0,14).forEach(function(r){
    var pct=Math.max(2,Math.round(Number(r.tokens)/max*100));
    h+='<div class="cbar"><div class="cbar-label" title="'+esc(r.label)+'">'+esc(r.label)+"</div>"+
      '<div class="cbar-track"><div class="cbar-fill'+(alt?" alt":"")+'" style="width:'+pct+'%"></div></div>'+
      '<div class="cbar-val">'+fmtNum(r.tokens)+' <span class="cv-calls">/ '+r.calls+'次</span></div></div>';
  });
  return h+"</div>";
}
function renderUserUsage(d){
  var c=document.querySelector("#activeModalMask .modal-body");
  if(!c)return;
  var t=d.totals||{tokens:0,calls:0};
  var byDay=(d.by_day||[]).map(function(x){return {label:x.day,tokens:x.tokens,calls:x.calls};});
  var byModel=(d.by_model||[]).map(function(x){return {label:x.model,tokens:x.tokens,calls:x.calls};});
  var byAcct=(d.by_account||[]).map(function(x){return {label:x.account+(x.platform?" · "+x.platform:""),tokens:x.tokens,calls:x.calls};});
  var h='<div class="m-sub">近 '+d.days+' 天 · 共 <b>'+fmtFull(t.tokens)+"</b> tokens / <b>"+t.calls+"</b> 次调用</div>";
  if(!byDay.length){
    h+='<div class="chart-empty">该用户近 '+d.days+" 天暂无用量记录</div>";
  }else{
    h+=usageChart("按天","近 "+d.days+" 天",byDay,false);
    h+=usageChart("按模型","tokens 降序",byModel,true);
    h+=usageChart("按账号","tokens 降序",byAcct,false);
  }
  c.innerHTML=h;
}

/* ---------- 分组 ---------- */
function loadGroups(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/groups").then(function(list){state.groups=list;renderGroups();}).catch(function(e){loadError(c,e);});
}
function findGroup(id){return state.groups.find(function(x){return x.id===id;});}
function renderGroups(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openGroupModal()">新建分组</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.groups.length+" 个分组</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>名称</th><th>平台</th><th>倍率</th><th>状态</th><th>Key 数</th><th>排序</th><th>操作</th>"+
    '</tr></thead><tbody id="groupTbody"></tbody></table></div>';
  var tb=$("groupTbody");
  if(!state.groups.length){tb.innerHTML='<tr><td colspan="8" class="empty">还没有分组，点击「新建分组」</td></tr>';return;}
  state.groups.forEach(function(g){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+g.id+"</td>"+
        '<td><div style="font-weight:600">'+esc(g.name)+"</div>"+(g.description?'<div class="kv">'+esc(g.description)+"</div>":"")+"</td>"+
        '<td>'+(g.platform?platformBadge(g.platform):badge("b-off","通用"))+"</td>"+
        '<td class="mono">'+(g.rate_multiplier==null?1:g.rate_multiplier)+"</td>"+
        '<td>'+(g.status==="active"?badge("b-active","启用"):badge("b-disabled","停用"))+"</td>"+
        '<td class="mono">'+(g.key_count||0)+"</td>"+
        '<td class="mono">'+(g.sort_order||0)+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="编辑" onclick="openGroupModal('+g.id+')">✏️</button>'+
          '<button class="icon-btn" title="删除" onclick="deleteGroup('+g.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function openGroupModal(id){
  var g=id?findGroup(id):null;
  openModal(id?"编辑分组":"新建分组",
    '<div class="form-grid">'+
      '<div><label>名称 *</label><input id="gm_name" value="'+esc(g?g.name:"")+'"></div>'+
      '<div><label>平台（空=通用）</label><select id="gm_platform">'+
        '<option value=""'+(g&&!g.platform?" selected":"")+'>通用</option>'+
        '<option value="openai"'+(g&&g.platform==="openai"?" selected":"")+'>openai</option>'+
        '<option value="anthropic"'+(g&&g.platform==="anthropic"?" selected":"")+'>anthropic</option>'+
        '<option value="gemini"'+(g&&g.platform==="gemini"?" selected":"")+'>gemini</option>'+
        '<option value="grok"'+(g&&g.platform==="grok"?" selected":"")+'>grok</option>'+
        '<option value="antigravity"'+(g&&g.platform==="antigravity"?" selected":"")+'>antigravity</option>'+
      "</select></div>"+
      '<div><label>计费倍率</label><input id="gm_rate" type="number" step="0.1" value="'+(g?(g.rate_multiplier==null?1:g.rate_multiplier):1)+'"></div>'+
      '<div><label>状态</label><select id="gm_status">'+
        '<option value="active"'+(g&&g.status!=="inactive"?" selected":"")+'>active</option>'+
        '<option value="inactive"'+(g&&g.status==="inactive"?" selected":"")+'>inactive</option>'+
      "</select></div>"+
      '<div class="full"><label>描述</label><input id="gm_desc" value="'+esc(g?g.description||"":"")+'"></div>'+
      '<div class="full"><label>排序（越小越靠前）</label><input id="gm_sort" type="number" value="'+(g?g.sort_order||0:0)+'"></div>'+
    "</div>",
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveGroup('+(g?g.id:"null")+')">保存</button>'
  );
}
function saveGroup(id){
  var body={
    name:$("gm_name").value.trim(),
    platform:$("gm_platform").value,
    rate_multiplier:Number($("gm_rate").value)||1,
    status:$("gm_status").value,
    description:$("gm_desc").value.trim(),
    sort_order:Number($("gm_sort").value)||0
  };
  if(!body.name){toast("请填写名称","err");return;}
  if(id){
    api("/admin/groups/"+id,{method:"PATCH",body:JSON.stringify(body)}).then(function(){toast("已保存","ok");closeModal();loadGroups();}).catch(function(e){toast(e.message,"err");});
  }else{
    api("/admin/groups",{method:"POST",body:JSON.stringify(body)})
      .then(function(){toast("已创建","ok");closeModal();loadGroups();})
      .catch(function(e){toast(e.message,"err");});
  }
}
function deleteGroup(id){
  var g=findGroup(id);
  if(!confirm("确定删除分组「"+(g?g.name:id)+"」？其下 Key 将变为未分组。")) return;
  api("/admin/groups/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadGroups();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 模型限流 ---------- */
function loadModelLimits(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  // 同时拉取用户 / Key 列表，用于创建规则的「指定用户 / 指定 Key」下拉
  Promise.all([api("/admin/model-limits"),api("/admin/users"),api("/admin/keys")])
    .then(function(rs){state.modelLimits=rs[0];state.users=rs[1];state.keys=rs[2];renderModelLimits();})
    .catch(function(e){loadError(c,e);});
}
function findModelLimit(id){return state.modelLimits.find(function(x){return x.id===id;});}
function renderModelLimits(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openModelLimitModal()">新建限流规则</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.modelLimits.length+' 条规则 · 优先级：Key &gt; 用户 &gt; 全局，精确模型 &gt; * 通配</span>'+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>范围</th><th>模型</th><th>RPM</th><th>并发</th><th>状态</th><th>创建时间</th><th>操作</th>"+
    '</tr></thead><tbody id="mlTbody"></tbody></table></div>';
  var tb=$("mlTbody");
  if(!state.modelLimits.length){tb.innerHTML='<tr><td colspan="8" class="empty">还没有限流规则。可对指定 Key / 用户 / 全部流量设置某模型的每分钟请求数与并发上限。</td></tr>';return;}
  state.modelLimits.forEach(function(r){
    var scope;
    if(r.key_id!=null) scope='<span class="mono">Key#'+r.key_id+'</span> '+esc(r.key_label||"")+badge("b-key","Key 级");
    else if(r.user_id!=null) scope='<span class="mono">用户#'+r.user_id+'</span> '+esc(r.user_name||"")+badge("b-user","用户级");
    else scope=badge("b-off","全局");
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+r.id+"</td>"+
        '<td>'+scope+"</td>"+
        '<td class="mono">'+esc(r.model)+(r.model==="*"?"（通配）":"")+"</td>"+
        '<td class="mono">'+(r.rpm_limit?r.rpm_limit+" 次/分":"不限")+"</td>"+
        '<td class="mono">'+(r.concurrency?r.concurrency+" 并发":"不限")+"</td>"+
        '<td>'+(r.enabled?badge("b-active","启用"):badge("b-disabled","停用"))+"</td>"+
        '<td class="mono">'+fmtTs(r.created_at)+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="编辑" onclick="openModelLimitModal('+r.id+')">✏️</button>'+
          '<button class="icon-btn" title="删除" onclick="deleteModelLimit('+r.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function openModelLimitModal(id){
  var r=id?findModelLimit(id):null;
  var scope=r?((r.key_id!=null)?"key":(r.user_id!=null?"user":"global")):"global";
  var userOpts='<option value="">选择用户…</option>'+state.users.map(function(u){return '<option value="'+u.id+'"'+(r&&r.user_id==u.id?" selected":"")+'>'+esc(u.username)+"</option>";}).join("");
  var keyOpts='<option value="">选择 Key…</option>'+state.keys.map(function(k){return '<option value="'+k.id+'"'+(r&&r.key_id==k.id?" selected":"")+'>'+esc(k.label||k.key)+"</option>";}).join("");
  openModal(id?"编辑限流规则":"新建限流规则",
    '<div class="form-grid">'+
      '<div class="full"><label>作用范围</label><select id="mlm_scope">'+
        '<option value="global"'+(scope==="global"?" selected":"")+'>全局（所有用户 / 所有 Key）</option>'+
        '<option value="user"'+(scope==="user"?" selected":"")+'>指定用户</option>'+
        '<option value="key"'+(scope==="key"?" selected":"")+'>指定 Key</option>'+
      '</select></div>'+
      '<div id="mlm_userWrap" class="full"'+(scope==="user"?"":' style="display:none"')+'><label>用户</label><select id="mlm_user">'+userOpts+"</select></div>"+
      '<div id="mlm_keyWrap" class="full"'+(scope==="key"?"":' style="display:none"')+'><label>Key</label><select id="mlm_key">'+keyOpts+"</select></div>"+
      '<div><label>模型 *（* = 通配所有模型）</label><input id="mlm_model" value="'+esc(r?r.model:"")+'" placeholder="gpt-4o"></div>'+
      '<div><label>状态</label><select id="mlm_enabled">'+
        '<option value="1"'+(r&&r.enabled===0?"":" selected")+'>启用</option>'+
        '<option value="0"'+(r&&r.enabled===0?" selected":"")+'>停用</option>'+
      '</select></div>'+
      '<div><label>RPM 上限（0=不限）</label><input id="mlm_rpm" type="number" value="'+(r?r.rpm_limit||0:0)+'"></div>'+
      '<div><label>并发上限（0=不限）</label><input id="mlm_con" type="number" value="'+(r?r.concurrency||0:0)+'"></div>'+
    '</div>',
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveModelLimit('+(r?r.id:"null")+')">保存</button>'
  );
  var sc=$("mlm_scope");
  sc.addEventListener("change",function(){
    $("mlm_userWrap").style.display=sc.value==="user"?"":"none";
    $("mlm_keyWrap").style.display=sc.value==="key"?"":"none";
  });
}
function saveModelLimit(id){
  var scope=$("mlm_scope").value;
  var body={
    model:$("mlm_model").value.trim(),
    rpm_limit:Number($("mlm_rpm").value)||0,
    concurrency:Number($("mlm_con").value)||0,
    enabled:$("mlm_enabled").value==="1"
  };
  if(!body.model){toast("请填写模型名","err");return;}
  if(scope==="global"){body.user_id=null;body.key_id=null;}
  if(scope==="user"){var uid=Number($("mlm_user").value);if(!uid){toast("请选择用户","err");return;}body.user_id=uid;}
  if(scope==="key"){var kid=Number($("mlm_key").value);if(!kid){toast("请选择 Key","err");return;}body.key_id=kid;}
  if(id){
    api("/admin/model-limits/"+id,{method:"PATCH",body:JSON.stringify(body)}).then(function(){toast("已保存","ok");closeModal();loadModelLimits();}).catch(function(e){toast(e.message,"err");});
  }else{
    api("/admin/model-limits",{method:"POST",body:JSON.stringify(body)})
      .then(function(){toast("已创建","ok");closeModal();loadModelLimits();})
      .catch(function(e){toast(e.message,"err");});
  }
}
function deleteModelLimit(id){
  var r=findModelLimit(id);
  if(!confirm("确定删除该限流规则？"+(r?"（"+r.model+"）":""))) return;
  api("/admin/model-limits/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadModelLimits();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 用量记录 ---------- */
var usageFilter="";
function loadUsage(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/usage").then(function(rows){state.usage=rows;renderUsage();}).catch(function(e){loadError(c,e);});
}
function renderUsage(){
  var rows=state.usage;
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<div class="grow"></div>'+
      '<input placeholder="搜索 Key / 账号 / 模型…" value="'+esc(usageFilter)+'" oninput="usageFilter=this.value;renderUsage()">'+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>时间</th><th>API Key</th><th>上游账号</th><th>模型</th><th>Prompt</th><th>Completion</th><th>合计</th>"+
    '</tr></thead><tbody id="usageTbody"></tbody></table></div>';
  var tb=$("usageTbody");
  if(!rows.length){tb.innerHTML='<tr><td colspan="7" class="empty">还没有调用记录</td></tr>';return;}
  var q=usageFilter.toLowerCase();
  var shown=rows.filter(function(r){
    if(!q) return true;
    return (r.key_label||"").toLowerCase().indexOf(q)>=0||(r.account_name||"").toLowerCase().indexOf(q)>=0||(r.model||"").toLowerCase().indexOf(q)>=0;
  });
  if(!shown.length){tb.innerHTML='<tr><td colspan="7" class="empty">没有匹配的记录</td></tr>';return;}
  shown.forEach(function(r){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="kv">'+fmtTs(r.created_at)+"</td>"+
        '<td class="mono">'+esc(r.key_label||maskKey(r.key_value||"?"))+"</td>"+
        '<td>'+(r.account_name?esc(r.account_name)+" "+platformBadge(r.account_platform):"-")+"</td>"+
        '<td class="mono">'+esc(r.model)+"</td>"+
        '<td class="mono">'+r.prompt_tokens+"</td>"+
        '<td class="mono">'+r.completion_tokens+"</td>"+
        '<td class="mono">'+(r.prompt_tokens+r.completion_tokens)+"</td>"+
      "</tr>");
  });
}

/* ---------- 套餐 ---------- */
function loadPackages(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/packages").then(function(list){state.packages=list;renderPackages();}).catch(function(e){loadError(c,e);});
}
function findPkg(id){return state.packages.find(function(x){return x.id===id;});}
function renderPackages(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openPkgModal()">新建套餐</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.packages.length+" 个套餐</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>名称</th><th>Tokens</th><th>时长(天)</th><th>价格说明</th><th>状态</th><th>排序</th><th>操作</th>"+
    '</tr></thead><tbody id="pkgTbody"></tbody></table></div>';
  var tb=$("pkgTbody");
  if(!state.packages.length){tb.innerHTML='<tr><td colspan="8" class="empty">还没有套餐，点击「新建套餐」</td></tr>';return;}
  state.packages.forEach(function(p){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+p.id+"</td>"+
        '<td><div style="font-weight:600">'+esc(p.name)+"</div></td>"+
        '<td class="mono">'+fmtFull(p.tokens)+"</td>"+
        '<td class="mono">'+p.duration_days+"</td>"+
        '<td>'+esc(p.price_note||"-")+"</td>"+
        '<td>'+(p.status==="active"?badge("b-active","上架"):badge("b-disabled","下架"))+"</td>"+
        '<td class="mono">'+(p.sort_order||0)+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="编辑" onclick="openPkgModal('+p.id+')">✏️</button>'+
          '<button class="icon-btn" title="删除" onclick="deletePkg('+p.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function openPkgModal(id){
  var p=id?findPkg(id):null;
  openModal(id?"编辑套餐":"新建套餐",
    '<div class="form-grid">'+
      '<div><label>名称 *</label><input id="pm_name" value="'+esc(p?p.name:"")+'"></div>'+
      '<div><label>赠送 tokens</label><input id="pm_tokens" type="number" value="'+(p?p.tokens:1000000)+'"></div>'+
      '<div><label>时长（天）</label><input id="pm_days" type="number" value="'+(p?p.duration_days:30)+'"></div>'+
      '<div><label>状态</label><select id="pm_status">'+
        '<option value="active"'+(p&&p.status!=="inactive"?" selected":"")+'>active</option>'+
        '<option value="inactive"'+(p&&p.status==="inactive"?" selected":"")+'>inactive</option>'+
      "</select></div>"+
      '<div class="full"><label>价格说明（离线/兑换码计费时展示）</label><input id="pm_price" value="'+esc(p?p.price_note||"":"")+'" placeholder="例如：¥9.9 / 100万 tokens"></div>'+
      '<div class="full"><label>排序</label><input id="pm_sort" type="number" value="'+(p?p.sort_order||0:0)+'"></div>'+
    "</div>",
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="savePkg('+(p?p.id:"null")+')">保存</button>'
  );
}
function savePkg(id){
  var body={
    name:$("pm_name").value.trim(),
    tokens:Number($("pm_tokens").value)||0,
    duration_days:Number($("pm_days").value)||30,
    status:$("pm_status").value,
    price_note:$("pm_price").value.trim(),
    sort_order:Number($("pm_sort").value)||0
  };
  if(!body.name){toast("请填写名称","err");return;}
  if(id){
    api("/admin/packages/"+id,{method:"PATCH",body:JSON.stringify(body)}).then(function(){toast("已保存","ok");closeModal();loadPackages();}).catch(function(e){toast(e.message,"err");});
  }else{
    api("/admin/packages",{method:"POST",body:JSON.stringify(body)})
      .then(function(){toast("已创建","ok");closeModal();loadPackages();})
      .catch(function(e){toast(e.message,"err");});
  }
}
function deletePkg(id){
  var p=findPkg(id);
  if(!confirm("确定删除套餐「"+(p?p.name:id)+"」？")) return;
  api("/admin/packages/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadPackages();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 订阅 ---------- */
function loadSubs(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/subscriptions").then(function(list){state.subs=list;renderSubs();}).catch(function(e){loadError(c,e);});
}
function findSub(id){return state.subs.find(function(x){return x.id===id;});}
function renderSubs(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openSubModal()">开通订阅</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.subs.length+" 条订阅</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>用户</th><th>套餐</th><th>Tokens</th><th>开始</th><th>过期</th><th>状态</th><th>操作</th>"+
    '</tr></thead><tbody id="subTbody"></tbody></table></div>';
  var tb=$("subTbody");
  if(!state.subs.length){tb.innerHTML='<tr><td colspan="8" class="empty">还没有订阅，点击「开通订阅」</td></tr>';return;}
  state.subs.forEach(function(s){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+s.id+"</td>"+
        '<td>'+(s.username?esc(s.username):"#"+s.user_id)+"</td>"+
        '<td>'+esc(s.package_name||"-")+"</td>"+
        '<td class="mono">'+fmtFull(s.tokens)+"</td>"+
        '<td class="kv">'+fmtTs(s.starts_at)+"</td>"+
        '<td class="kv">'+fmtTs(s.expires_at)+"</td>"+
        '<td>'+subStatusBadge(s.status)+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="续期" onclick="extendSub('+s.id+')">➕</button>'+
          '<button class="icon-btn" title="撤销" onclick="revokeSub('+s.id+')">⛔</button>'+
          '<button class="icon-btn" title="删除" onclick="deleteSub('+s.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function pkgOpts(sel){
  var out='<option value="">— 自定义 —</option>';
  state.packages.forEach(function(p){out+='<option value="'+p.id+'"'+(sel===p.id?" selected":"")+">"+esc(p.name)+"</option>";});
  return out;
}
function openSubModal(userId){
  var u=userId?findUser(userId):null;
  openModal("开通订阅",
    '<div class="m-sub">开通后自动给用户余额追加套餐 tokens，并生成一条订阅记录（到期自动过期）。</div>'+
    '<div class="form-grid">'+
      '<div><label>用户 *</label><select id="sm_user">'+userOpts(userId||null)+"</select></div>"+
      '<div><label>套餐</label><select id="sm_pkg">'+pkgOpts(null)+"</select></div>"+
      '<div><label>自定义 tokens（选套餐时忽略）</label><input id="sm_tokens" type="number" value="1000000"></div>'+
      '<div><label>自定义时长（天）</label><input id="sm_days" type="number" value="30"></div>'+
    "</div>"+(u?'<div class="hint">为用户「'+esc(u.username)+'」开通</div>':""),
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveSub()">开通</button>'
  );
}
function saveSub(){
  var userId=$("sm_user").value?Number($("sm_user").value):null;
  var pkgId=$("sm_pkg").value?Number($("sm_pkg").value):null;
  if(!userId){toast("请选择用户","err");return;}
  var body={user_id:userId,package_id:pkgId,tokens:Number($("sm_tokens").value)||0,duration_days:Number($("sm_days").value)||30};
  api("/admin/subscriptions",{method:"POST",body:JSON.stringify(body)})
    .then(function(){toast("已开通","ok");closeModal();loadSubs();if(state.view==="users")loadUsers();})
    .catch(function(e){toast(e.message,"err");});
}
function extendSub(id){
  var s=findSub(id);
  var days=prompt("续期天数（"+((s&&s.username)||"#"+id)+"）：","30");
  if(days==null) return;
  api("/admin/subscriptions/"+id,{method:"PATCH",body:JSON.stringify({extend_days:Number(days)||0})})
    .then(function(){toast("已续期","ok");loadSubs();}).catch(function(e){toast(e.message,"err");});
}
function revokeSub(id){
  if(!confirm("确定撤销该订阅？")) return;
  api("/admin/subscriptions/"+id,{method:"PATCH",body:JSON.stringify({status:"revoked"})})
    .then(function(){toast("已撤销","ok");loadSubs();}).catch(function(e){toast(e.message,"err");});
}
function deleteSub(id){
  if(!confirm("确定删除该订阅记录？")) return;
  api("/admin/subscriptions/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadSubs();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 兑换码 ---------- */
function loadPromos(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/promos").then(function(list){state.promos=list;renderPromos();}).catch(function(e){loadError(c,e);});
}
function findPromo(id){return state.promos.find(function(x){return x.id===id;});}
function renderPromos(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openPromoModal()">生成兑换码</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.promos.length+" 个兑换码</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>兑换码</th><th>Tokens</th><th>用量</th><th>状态</th><th>过期</th><th>备注</th><th>操作</th>"+
    '</tr></thead><tbody id="promoTbody"></tbody></table></div>';
  var tb=$("promoTbody");
  if(!state.promos.length){tb.innerHTML='<tr><td colspan="8" class="empty">还没有兑换码，点击「生成兑换码」</td></tr>';return;}
  state.promos.forEach(function(p){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+p.id+"</td>"+
        '<td><span class="mono">'+esc(p.code)+'</span> <button class="icon-btn" title="复制" onclick="copyText(&#39;'+esc(p.code)+'&#39;)">📋</button></td>'+
        '<td class="mono">'+fmtFull(p.bonus_tokens)+"</td>"+
        '<td class="mono">'+(p.used_count||0)+" / "+(p.max_uses||0)+"</td>"+
        '<td>'+(p.status==="active"?badge("b-active","可用"):badge("b-disabled","停用"))+"</td>"+
        '<td class="kv">'+fmtTs(p.expires_at)+"</td>"+
        '<td>'+esc(p.notes||"-")+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="编辑" onclick="openPromoModal('+p.id+')">✏️</button>'+
          '<button class="icon-btn" title="删除" onclick="deletePromo('+p.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function openPromoModal(id){
  var p=id?findPromo(id):null;
  openModal(id?"编辑兑换码":"生成兑换码",
    '<div class="form-grid">'+
      '<div><label>兑换码（留空自动生成）</label><input id="promo_code" value="'+esc(p?p.code:"")+'" placeholder="PROMO-XXXX"></div>'+
      '<div><label>Tokens</label><input id="promo_tokens" type="number" value="'+(p?p.bonus_tokens:1000000)+'"></div>'+
      '<div><label>最大使用次数</label><input id="promo_uses" type="number" value="'+(p?p.max_uses:1)+'"></div>'+
      '<div><label>状态</label><select id="promo_status">'+
        '<option value="active"'+(p&&p.status!=="disabled"?" selected":"")+'>active</option>'+
        '<option value="disabled"'+(p&&p.status==="disabled"?" selected":"")+'>disabled</option>'+
      "</select></div>"+
      '<div class="full"><label>过期时间戳（毫秒，留空=永久）</label><input id="promo_exp" type="number" value="'+(p&&p.expires_at?p.expires_at:"")+'"></div>'+
      '<div class="full"><label>备注</label><input id="promo_notes" value="'+esc(p?p.notes||"":"")+'"></div>'+
    "</div>",
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="savePromo('+(p?p.id:"null")+')">保存</button>'
  );
}
function savePromo(id){
  var body={
    code:$("promo_code").value.trim(),
    bonus_tokens:Number($("promo_tokens").value)||0,
    max_uses:Number($("promo_uses").value)||1,
    status:$("promo_status").value,
    expires_at:$("promo_exp").value?Number($("promo_exp").value):null,
    notes:$("promo_notes").value.trim()
  };
  if(id){
    api("/admin/promos/"+id,{method:"PATCH",body:JSON.stringify(body)}).then(function(){toast("已保存","ok");closeModal();loadPromos();}).catch(function(e){toast(e.message,"err");});
  }else{
    api("/admin/promos",{method:"POST",body:JSON.stringify(body)})
      .then(function(r){toast("已生成："+r.code,"ok");closeModal();loadPromos();})
      .catch(function(e){toast(e.message,"err");});
  }
}
function deletePromo(id){
  var p=findPromo(id);
  if(!confirm("确定删除兑换码「"+(p?p.code:id)+"」？")) return;
  api("/admin/promos/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadPromos();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 公告 ---------- */
function loadAnns(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/announcements").then(function(list){state.anns=list;renderAnns();}).catch(function(e){loadError(c,e);});
}
function findAnn(id){return state.anns.find(function(x){return x.id===id;});}
function renderAnns(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="openAnnModal()">发布公告</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.anns.length+" 条公告</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>标题</th><th>内容</th><th>状态</th><th>发布时间</th><th>操作</th>"+
    '</tr></thead><tbody id="annTbody"></tbody></table></div>';
  var tb=$("annTbody");
  if(!state.anns.length){tb.innerHTML='<tr><td colspan="6" class="empty">还没有公告，点击「发布公告」</td></tr>';return;}
  state.anns.forEach(function(a){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+a.id+"</td>"+
        '<td><div style="font-weight:600">'+esc(a.title)+"</div></td>"+
        '<td style="max-width:320px"><div class="kv" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.content||"")+"</div></td>"+
        '<td>'+(a.status==="active"?badge("b-active","展示中"):badge("b-disabled","已隐藏"))+"</td>"+
        '<td class="kv">'+fmtTs(a.created_at)+"</td>"+
        '<td><div class="row-actions">'+
          '<button class="icon-btn" title="编辑" onclick="openAnnModal('+a.id+')">✏️</button>'+
          '<button class="icon-btn" title="删除" onclick="deleteAnn('+a.id+')">🗑</button>'+
        "</div></td>"+
      "</tr>");
  });
}
function openAnnModal(id){
  var a=id?findAnn(id):null;
  openModal(id?"编辑公告":"发布公告",
    '<label>标题 *</label><input id="ann_title" value="'+esc(a?a.title:"")+'">'+
    '<label>内容</label><textarea id="ann_content" style="height:120px">'+esc(a?a.content||"":"")+'</textarea>'+
    '<label>状态</label><select id="ann_status">'+
      '<option value="active"'+(a&&a.status!=="inactive"?" selected":"")+'>active</option>'+
      '<option value="inactive"'+(a&&a.status==="inactive"?" selected":"")+'>inactive</option>'+
    "</select>",
    '<button class="btn" onclick="closeModal()">取消</button><button class="btn primary" onclick="saveAnn('+(a?a.id:"null")+')">保存</button>'
  );
}
function saveAnn(id){
  var body={title:$("ann_title").value.trim(),content:$("ann_content").value,status:$("ann_status").value};
  if(!body.title){toast("请填写标题","err");return;}
  if(id){
    api("/admin/announcements/"+id,{method:"PATCH",body:JSON.stringify(body)}).then(function(){toast("已保存","ok");closeModal();loadAnns();}).catch(function(e){toast(e.message,"err");});
  }else{
    api("/admin/announcements",{method:"POST",body:JSON.stringify(body)})
      .then(function(){toast("已发布","ok");closeModal();loadAnns();})
      .catch(function(e){toast(e.message,"err");});
  }
}
function deleteAnn(id){
  if(!confirm("确定删除该公告？")) return;
  api("/admin/announcements/"+id,{method:"DELETE"}).then(function(){toast("已删除","ok");loadAnns();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 渠道监控 ---------- */
function loadChannels(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/channels").then(function(list){state.channels=list;renderChannels();}).catch(function(e){loadError(c,e);});
}
// 根据探测错误给出可执行的恢复建议（供“一键全通道检测”报告展示）
function channelSuggest(err, acct){
  var e = (err||"").toLowerCase();
  if(!e) return "";
  if(/401|invalid api key|unauthorized|authentication/.test(e)) return "凭证无效：重新 OAuth 登录导入，或更换 API Key";
  if(/403/.test(e)) return "服务可达但被拒(403)：数据中心 IP 被上游封锁，或账号权限/套餐不足";
  if(/fetch failed|timeout|timed out|econn|enetunreach|超时|网络/.test(e)) return "上游不可达：域名被墙或网络受限（本机/沙箱常见）；部署到 Cloudflare 后 Worker 出网正常";
  if(/429|rate limit/.test(e)) return "上游限流(429)：稍等自动恢复";
  if(/5\d\d/.test(e)) return "上游服务异常("+err+")：稍后重试或检查账号状态";
  if(/refresh|expired|token/.test(e)) return "OAuth token 刷新/过期：重新授权该账号";
  return "见错误详情，必要时重新导入该账号";
}
function renderChannels(){
  var list = state.channels||[];
  var okN = list.filter(function(a){return a.last_check_result==="ok";}).length;
  var failN = list.filter(function(a){return a.last_check_result==="fail";}).length;
  var noneN = list.length - okN - failN;
  var rep = '';
  if(list.length){
    rep = '<div class="card" style="margin:0 0 12px"><div style="font-weight:700;margin-bottom:6px">一键全通道检测报告</div>'+
      '<div>'+
        (okN?badge("b-active","✓ 通过 "+okN):"")+" "+
        (failN?badge("b-error","✗ 失败 "+failN):"")+" "+
        (noneN?badge("b-off","未检测 "+noneN):"")+
        '<span class="kv" style="margin-left:8px">共 '+list.length+" 个账号 · 失败项见下方建议</span>"+
      '</div></div>';
  }
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<button class="btn primary" onclick="checkChannels()">⚡ 一键全通道检测</button>'+
      '<div class="grow"></div>'+
      '<span class="kv">定时任务每 10 分钟自动探测一次（Workers Cron）</span>'+
    '</div>'+
    rep+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>ID</th><th>名称</th><th>平台</th><th>状态</th><th>最近检测</th><th>结果</th><th>错误 / 恢复建议</th>"+
    '</tr></thead><tbody id="channelTbody"></tbody></table></div>';
  var tb=$("channelTbody");
  if(!list.length){tb.innerHTML='<tr><td colspan="7" class="empty">还没有账号</td></tr>';return;}
  list.forEach(function(a){
    var err = a.error_message||a.probe_error||"";
    var sug = a.last_check_result==="fail" ? channelSuggest(err, a) : "";
    var errCell = a.last_check_result==="ok" ? '<span class="kv">-</span>' :
      '<div class="kv" title="'+esc(err)+'" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(err||"-")+"</div>"+
      (sug?'<div class="warn" style="color:#e8a33d;font-size:12px">💡 '+esc(sug)+"</div>":"");
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="mono">#'+a.id+"</td>"+
        '<td><div style="font-weight:600">'+esc(a.name)+"</div></td>"+
        '<td>'+platformBadge(a.platform)+"</td>"+
        '<td>'+statusBadge(a.status)+"</td>"+
        '<td class="kv">'+fmtTs(a.last_checked_at)+"</td>"+
        '<td>'+(a.last_check_result==="ok"?badge("b-active","✓ 正常"+(a.latency_ms!=null?" · "+a.latency_ms+"ms":"")):(a.last_check_result==="fail"?badge("b-error","✗ 失败"+(a.latency_ms!=null?" · "+a.latency_ms+"ms":"")):badge("b-off","未检测")))+"</td>"+
        '<td>'+errCell+"</td>"+
      "</tr>");
  });
}
function checkChannels(){
  api("/admin/channels/check",{method:"POST"}).then(function(){toast("全通道检测完成","ok");loadChannels();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 模型广场 ---------- */
function loadModels(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/models").then(function(list){state.models=list;renderModels();}).catch(function(e){loadError(c,e);});
}
function renderModels(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<div class="grow"></div>'+
      '<span class="kv">共 '+state.models.length+" 个可用模型（来自各账号 model_map 汇总）</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>模型名</th><th>平台</th><th>来源账号</th>"+
    '</tr></thead><tbody id="modelTbody"></tbody></table></div>';
  var tb=$("modelTbody");
  if(!state.models.length){tb.innerHTML='<tr><td colspan="3" class="empty">没有可用模型</td></tr>';return;}
  state.models.forEach(function(m){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td><span class="mono" style="font-weight:600">'+esc(m.model)+'</span></td>'+
        '<td>'+(m.platform?platformBadge(m.platform):badge("b-off","默认"))+"</td>"+
        '<td class="kv">'+esc(m.account||"-")+"</td>"+
      "</tr>");
  });
}

/* ---------- 审计日志 ---------- */
function loadAudit(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/audit").then(function(list){state.audit=list;renderAudit();}).catch(function(e){loadError(c,e);});
}
function renderAudit(){
  $("content").innerHTML=
    '<div class="toolbar">'+
      '<div class="grow"></div>'+
      '<span class="kv">最近 '+state.audit.length+" 条管理操作</span>"+
    '</div>'+
    '<div class="tbl-wrap"><table><thead><tr>'+
      "<th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th>"+
    '</tr></thead><tbody id="auditTbody"></tbody></table></div>';
  var tb=$("auditTbody");
  if(!state.audit.length){tb.innerHTML='<tr><td colspan="5" class="empty">暂无审计记录</td></tr>';return;}
  state.audit.forEach(function(a){
    tb.insertAdjacentHTML("beforeend",
      '<tr>'+
        '<td class="kv">'+fmtTs(a.created_at)+"</td>"+
        '<td>'+esc(a.actor||"-")+"</td>"+
        '<td><span class="mono">'+esc(a.action)+"</span></td>"+
        '<td>'+(a.target_type?esc(a.target_type)+(a.target_id?" #"+a.target_id:""):"-")+"</td>"+
        '<td class="kv" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.detail||"-")+"</td>"+
      "</tr>");
  });
}

/* ---------- 设置 ---------- */
function loadSettings(){
  var c=$("content");
  c.innerHTML='<div class="sub">加载中…</div>';
  api("/admin/settings").then(function(s){state.settings=s;renderSettings();}).catch(function(e){loadError(c,e);});
}
function renderSettings(){
  var s=state.settings;
  $("content").innerHTML=
    '<div class="card"><h2>站点设置</h2>'+
      '<div class="form-grid">'+
        '<div><label>站点名称</label><input id="set_site_name" value="'+esc(s.site_name||"Sub2API-CF")+'"></div>'+
        '<div><label>默认备注（新 Key 前缀）</label><input id="set_default_label" value="'+esc(s.default_label||"")+'"></div>'+
        '<div class="full"><label>维护公告（显示在概览页顶部）</label><input id="set_notice" value="'+esc(s.notice||"")+'"></div>'+
        '<div class="full"><label>支付说明（离线/兑换码方式）</label><textarea id="set_payment_note" style="height:80px">'+esc(s.payment_note||"本服务使用「兑换码 + 离线开通」方式计费：联系管理员获取兑换码，在「用户 → 兑换码充值」中兑换。")+'</textarea></div>'+
      "</div>"+
      '<div class="foot" style="margin-top:16px"><button class="btn primary" onclick="saveSettings()">保存设置</button></div>'+
    '</div>'+
    '<div class="card"><h2>运行环境</h2>'+
      '<div class="kv">'+
        "<div>存储：Cloudflare D1（SQLite）— 替代原版 PostgreSQL + Redis</div>"+
        "<div>定时任务：Workers Cron（每 10 分钟：OAuth 刷新 / 订阅过期 / 渠道监控）</div>"+
        "<div>代理绑定：不支持（Workers 无出站代理绑定），导入时自动跳过并提示</div>"+
        "<div>在线支付：可接 Stripe Checkout（Worker 可调用），当前默认走兑换码/离线</div>"+
      "</div>"+
    '</div>';
}
function saveSettings(){
  var body={
    site_name:$("set_site_name").value.trim()||"Sub2API-CF",
    default_label:$("set_default_label").value.trim(),
    notice:$("set_notice").value.trim(),
    payment_note:$("set_payment_note").value
  };
  api("/admin/settings",{method:"POST",body:JSON.stringify(body)})
    .then(function(){toast("已保存","ok");loadSettings();}).catch(function(e){toast(e.message,"err");});
}

/* ---------- 接入说明 ---------- */
function renderHelp(){
  var nl="&#10;";
  $("content").innerHTML=
    '<div class="card"><h2>OpenAI 兼容</h2><pre class="result">curl https://&lt;你的地址&gt;/v1/chat/completions'+nl+'  -H "Authorization: Bearer sk-xxxx" -H "Content-Type: application/json"'+nl+    '  -d &#39;{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"stream":true}&#39;</pre></div>'+
    '<div class="card"><h2>Anthropic 原生（/v1/messages）</h2><pre class="result">curl https://&lt;你的地址&gt;/v1/messages'+nl+'  -H "x-api-key: sk-xxxx" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json"'+nl+    '  -d &#39;{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}&#39;</pre></div>'+
    '<div class="card"><h2>Gemini 原生（/v1beta）</h2><pre class="result">curl https://&lt;你的地址&gt;/v1beta/models/gemini-2.5-flash:generateContent'+nl+'  -H "x-goog-api-key: sk-xxxx" -H "Content-Type: application/json"'+nl+    '  -d &#39;{"contents":[{"parts":[{"text":"hi"}]}]}&#39;</pre></div>'+
    '<div class="card"><h2>OpenAI Responses（/v1/responses）</h2><pre class="result">curl https://&lt;你的地址&gt;/v1/responses'+nl+'  -H "Authorization: Bearer sk-xxxx" -H "Content-Type: application/json"'+nl+    '  -d &#39;{"model":"gpt-4o","instructions":"你是个助手","input":"hi","stream":true}&#39;</pre></div>'+
    '<div class="card"><h2>模型列表 / 用量</h2><pre class="result">curl https://&lt;你的地址&gt;/v1/models -H "Authorization: Bearer sk-xxxx"'+nl+'curl https://&lt;你的地址&gt;/v1/usage -H "Authorization: Bearer sk-xxxx"</pre></div>';
}

/* ---------- 弹窗 ---------- */
function openModal(title,body,foot,wide){
  closeModal();
  var m=document.createElement("div");
  m.className="modal-mask open";
  m.id="activeModalMask";
  m.innerHTML='<div class="modal'+(wide?" wide":"")+'"><h3>'+title+"</h3>"+
    '<div class="modal-body">'+body+"</div>"+
    (foot?'<div class="foot">'+foot+"</div>":"")+"</div>";
  $("modalRoot").appendChild(m);
  m.addEventListener("click",function(e){if(e.target===m)closeModal();});
  return m;
}
function closeModal(){
  var m=$("activeModalMask");
  if(m)m.remove();
}

/* ---------- 初始化 ---------- */
function init(){
  bindNav();
  var t="";
  try{t=new URLSearchParams(location.search).get("token")||localStorage.getItem("sub2api_cf_token")||"";}catch(e){}
  $("token").value=t;
  $("token").addEventListener("input",function(){
    try{localStorage.setItem("sub2api_cf_token",this.value.trim());}catch(e){}
    if(this.value.trim())switchView(state.view);else $("content").innerHTML='<div class="card"><span class="sub">请先在上方输入 ADMIN_TOKEN</span></div>';
  });
  if(t)switchView("dashboard");
  else $("content").innerHTML='<div class="card"><span class="sub">请先在上方输入 ADMIN_TOKEN 以加载后台数据。</span><br><span class="sub">提示：也可以直接访问 /admin?token=&lt;ADMIN_TOKEN&gt; 自动填入。</span></div>';
}
document.addEventListener("DOMContentLoaded",init);
</script>
</body>
</html>`;
