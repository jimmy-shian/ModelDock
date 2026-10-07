/** 單檔 Web UI：狀態 / 登入 / 測試 / 設定 / OpenAI 說明。零依賴，inline CSS+JS。 */
export function renderUi(): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>gpt-web-port · 設定介面</title>
<style>
:root { color-scheme: light dark; --bg:#0b0d12; --card:#151923; --line:#262c3a; --txt:#e8ecf3; --mut:#9aa4b5; --acc:#4da3ff; --ok:#34c77b; --warn:#ff9f43; --err:#ff5d5d; }
*{box-sizing:border-box} body{margin:0;font-family:"Microsoft JhengHei","Noto Sans TC",system-ui,sans-serif;background:var(--bg);color:var(--txt)}
.wrap{max-width:1060px;margin:0 auto;padding:20px 16px 60px}
header{display:flex;align-items:center;gap:12px;margin:6px 0 16px}
.dot{width:12px;height:12px;border-radius:50%;background:var(--warn)}
.dot.ok{background:var(--ok)} .dot.err{background:var(--err)}
h1{font-size:20px;margin:0} .sub{color:var(--mut);font-size:13px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px} @media(max-width:860px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card h2{margin:0 0 10px;font-size:15px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
label{font-size:12px;color:var(--mut);display:block;margin:10px 0 4px}
input,textarea,select{width:100%;background:#0e1219;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:9px 10px;font-size:14px}
textarea{min-height:110px;resize:vertical;font-family:inherit}
button{background:var(--acc);border:0;color:#fff;border-radius:8px;padding:9px 14px;font-size:14px;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--txt)}
button.warn{background:var(--warn)} button:disabled{opacity:.55;cursor:wait}
.kv{font-size:13px;line-height:1.9} .kv b{color:#fff}
.mono{font-family:Consolas,Menlo,monospace;font-size:12.5px;background:#0e1219;border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
.pill{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:20px;padding:2px 10px;color:var(--mut)}
.pill.ok{color:var(--ok);border-color:var(--ok)} .pill.err{color:var(--err);border-color:var(--err)}
.hint{font-size:12.5px;color:var(--mut);line-height:1.7}
a{color:var(--acc)} .check{display:flex;align-items:center;gap:8px;font-size:14px;margin-top:10px} .check input{width:auto}
footer{margin-top:18px;color:var(--mut);font-size:12px}
</style>
</head>
<body>
<div class="wrap">
<header><div class="dot" id="dot"></div><div style="flex:1"><h1>gpt-web-port · 本機設定介面</h1><div class="sub" id="addr">http://127.0.0.1:8787 · OpenAI Compatible + 網頁版 ChatGPT 橋接</div></div><div style="min-width:220px"><label style="margin:0">API_KEY（有設才需填）</label><input id="gkey" type="password" placeholder="x-api-key / Bearer" /></div></header>

<div class="grid">
<div class="card"><h2>1 · 服務狀態</h2><div class="kv" id="status">載入中…</div><div class="row" style="margin-top:10px"><button class="ghost" id="btnHealth">重新檢查</button><button class="ghost" id="btnOpenChat">開啟 ChatGPT 網頁</button></div><div class="hint" style="margin-top:8px">loggedIn = false 時先到第 2 步登入。browserStarted 只是本機分頁是否開著。</div></div>

<div class="card"><h2>2 · 登入 GPT 網頁（v2）</h2><div class="hint">點下面會開一個「真 Chrome」登入視窗（跟自動化完全分開，不會搶、不會閃退）。<br/>步驟：在 Chrome 登入 ChatGPT → 看到輸入框 → 把 Chrome「完全關掉」→ 本頁會顯示登入完成。<br/>登入狀態存在 storageState.json，不是 profile 目錄。</div><div class="row" style="margin-top:10px"><button id="btnLogin">開啟登入視窗</button><button class="ghost" id="btnLogout">登出（清除狀態）</button><span class="pill" id="loginState">idle</span></div><div class="mono" id="loginMsg" style="margin-top:10px">尚未登入操作。</div></div>

<div class="card"><h2>3 · 對話測試（原生 /chat）</h2><label>prompt</label><textarea id="prompt" placeholder="用一句話介紹台灣"></textarea><div class="check"><input type="checkbox" id="cont" /><span>沿用上一輪對話（continue=true）</span></div><div class="row" style="margin-top:10px"><button id="btnAsk">送出</button><button class="ghost" id="btnClear">清空</button><span class="pill" id="askState">idle</span></div><div class="mono" id="askOut" style="margin-top:10px">回覆會顯示在這裡…</div></div>

<div class="card"><h2>4 · OpenAI 相容測試（/v1/chat/completions）</h2><label>messages（JSON）</label><textarea id="msgs" style="min-height:130px">[{"role":"user","content":"用一句話介紹台灣"}]</textarea><div class="row"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="oaiStream" style="width:auto" /> stream（SSE 假串流）</label><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="oaiCont" style="width:auto" /> continue</label></div><div class="row" style="margin-top:10px"><button id="btnOai">送出 OpenAI 格式</button><span class="pill" id="oaiState">idle</span></div><div class="mono" id="oaiOut" style="margin-top:10px">…</div><div class="hint" style="margin-top:8px">外部 App 填：BaseURL=http://127.0.0.1:8787/v1 · API Key=下面設的（可空）· Model=gpt-web-port</div></div>
</div>

<div class="card" style="margin-top:14px"><h2>5 · 數值設定（等待時間等）</h2>
<div class="grid">
<div><label>HOST（改了要重啟）</label><input id="s_host" /></div>
<div><label>PORT（改了要重啟）</label><input id="s_port" type="number" /></div>
<div><label>等待回覆逾時（秒）· 即時生效</label><input id="s_timeout" type="number" min="10" max="1800" /></div>
<div><label>HEADLESS 背景執行（取消=顯示視窗，建議重啟）</label><select id="s_headless"><option value="true">1 · 背景（預設）</option><option value="false">0 · 顯示瀏覽器視窗</option></select></div>
<div><label>PROFILE_DIR（舊版相容，v2 已不用）</label><input id="s_profile" /></div>
<div><label>CHROME_PATH（改了要重啟）</label><input id="s_chrome" /></div>
<div style="grid-column:1/-1"><label>API_KEY（空=不驗證；支援 x-api-key 或 Authorization: Bearer；即時生效）</label><input id="s_key" type="password" placeholder="留空表示不設密碼" /></div>
</div>
<div class="row" style="margin-top:12px"><button id="btnSave">儲存設定</button><button class="ghost" id="btnReload">重新讀取</button><span class="pill" id="saveState">idle</span></div>
<div class="mono" id="saveMsg" style="margin-top:10px">…</div>
<div class="hint">存檔位置：~/.gpt-web-port/config.json，環境變數（PORT/HOST…）優先權高於檔案。PORT/HOST 改完要重啟服務；逾時秒數存完立刻生效。</div>
</div>

 <div class="card" style="margin-top:14px"><h2>6 · 接線範例（Windows 請用 curl.exe，勿用 curl 別名）</h2>
 <div class="mono" id="sample">REM 最穩（無 JSON 引號問題）&#10;curl.exe -X POST http://127.0.0.1:8787/chat -H "content-type: text/plain" --data-binary "你好"&#10;&#10;REM OpenAI 相容（已轉義）&#10;curl.exe -X POST http://127.0.0.1:8787/v1/chat/completions -H "content-type: application/json" --data "{\"model\":\"gpt-web-port\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"stream\":false}"

# Python OpenAI SDK
# from openai import OpenAI
# c = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
# print(c.chat.completions.create(model="gpt-web-port", messages=[{"role":"user","content":"你好"}]).choices[0].message.content)</div>
<div class="hint">非串流回傳 OpenAI 標準 chat.completion；stream=true 回傳 SSE（假串流：等整段回來再切塊送）。原生的 POST /chat 照舊可用。</div></div>

<footer>關閉此分頁服務不會停。要縮到 Win 右下角托盤請用 <span class="mono" style="display:inline">bun run tray.ps1</span>（見下方說明）常駐，右鍵可 開啟介面 / 離開。</footer>
</div>
<script>
const $=id=>document.getElementById(id);
function authHeaders(){const k=($("gkey").value||"").trim()||localStorage.getItem("gwp_key")||"";return k?{"x-api-key":k}:{};}
async function jget(u){const r=await fetch(u,{headers:{...authHeaders()}});if(r.status===401)throw new Error("401 未授權：右上角填 API_KEY 後重試。");return r.json();}
async function jpost(u,b,isStream){
  const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json",...authHeaders()},body:JSON.stringify(b)});
  const ct=r.headers.get("content-type")||"";
  if(!r.ok){let t=await r.text();throw new Error("HTTP "+r.status+" "+t.slice(0,500));}
  if(ct.includes("text/event-stream")){return {sse:await r.text()};}
  return r.json();
}
async function refresh(){
  try{
    const h=await jget("/health");
    $("dot").className="dot "+(h.loggedIn?"ok":"");
    const busy=h.loginBusy?"<br/>登入視窗開著：去真 Chrome 登入，完全關掉即完成。":"";
    $("status").innerHTML="browserStarted: <b>"+h.browserStarted+"</b><br/>loggedIn: <b>"+h.loggedIn+"</b><br/>pageUrl: <b>"+(h.pageUrl||"-")+"</b>"+busy+(h.error?"<br/>error: "+h.error:"");
  }catch(e){$("dot").className="dot err";$("status").textContent="連線失敗："+e.message;}
}
async function loadSettings(){
  try{
    const s=await jget("/api/settings");
    $("s_host").value=s.host||"";$("s_port").value=s.port||"";$("s_timeout").value=s.turnTimeoutSec||"";
    $("s_headless").value=String(!!s.headless);$("s_profile").value=s.profileDir||"";
    $("s_chrome").value=s.chromeExecutablePath||"";$("s_key").value=s.apiKey||"";
    $("saveMsg").textContent="已讀取（逾時 "+s.turnTimeoutMs+"ms）。檔案：~/.gpt-web-port/config.json";
  }catch(e){$("saveMsg").textContent="讀取失敗："+e.message;}
}
$("btnHealth").onclick=refresh;$("btnOpenChat").onclick=()=>window.open("https://chatgpt.com/?temporary-chat=true","_blank");
$("btnReload").onclick=loadSettings;
$("btnLogin").onclick=async()=>{
  if(!confirm("會開啟真 Chrome 登入視窗。登入後請把 Chrome「完全關掉」才會完成，這段時間按確定後請勿重複點擊。繼續？"))return;
  $("loginState").textContent="waiting-login…（去 Chrome 登入，關掉即完成，最長10分鐘）";$("btnLogin").disabled=true;
  try{const r=await jpost("/api/login/open",{});$("loginMsg").textContent=JSON.stringify(r,null,2);$("loginState").textContent=r.ok?"done":"error";}
  catch(e){$("loginMsg").textContent=String(e.message||e);$("loginState").textContent="error";}
  finally{$("btnLogin").disabled=false;refresh();}
};
$("btnLogout").onclick=async()=>{
  if(!confirm("確定清除登入狀態？"))return;
  try{const r=await jpost("/api/login/logout",{});$("loginMsg").textContent=JSON.stringify(r,null,2);}catch(e){$("loginMsg").textContent=String(e.message||e);}
  finally{refresh();}
};
$("btnAsk").onclick=async()=>{
  const p=$("prompt").value.trim();if(!p){alert("先填 prompt");return;}
  $("askState").textContent="waiting…";$("btnAsk").disabled=true;
  try{const r=await jpost("/chat",{prompt:p,continue:$("cont").checked});$("askOut").textContent="reply:\\n"+r.reply+"\\n\\nurl: "+r.conversationUrl+"\\n"+r.durationMs+"ms";$("askState").textContent="done";}
  catch(e){$("askOut").textContent=String(e.message||e);$("askState").textContent="error";}
  finally{$("btnAsk").disabled=false;}
};
$("btnClear").onclick=()=>{$("prompt").value="";$("askOut").textContent="回覆會顯示在這裡…";};
$("gkey").value=localStorage.getItem("gwp_key")||"";
$("gkey").onchange=()=>{localStorage.setItem("gwp_key",$("gkey").value.trim());};
$("btnOai").onclick=async()=>{
  let msgs;try{msgs=JSON.parse($("msgs").value);}catch{alert("messages 不是合法 JSON");return;}
  $("oaiState").textContent="waiting…";$("btnOai").disabled=true;
  try{
    if($("oaiStream").checked){
      const r=await fetch("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json",...authHeaders()},body:JSON.stringify({model:"gpt-web-port",messages:msgs,stream:true,continue:$("oaiCont").checked})});
      $("oaiOut").textContent=await r.text();$("oaiState").textContent="done (sse)";
    }else{
      const r=await jpost("/v1/chat/completions",{model:"gpt-web-port",messages:msgs,stream:false,continue:$("oaiCont").checked});
      $("oaiOut").textContent=JSON.stringify(r,null,2);$("oaiState").textContent="done";
    }
  }catch(e){$("oaiOut").textContent=String(e.message||e);$("oaiState").textContent="error";}
  finally{$("btnOai").disabled=false;}
};
$("btnSave").onclick=async()=>{
  $("saveState").textContent="saving…";
  try{
    const r=await jpost("/api/settings",{host:$("s_host").value,port:Number($("s_port").value),turnTimeoutSec:Number($("s_timeout").value),headless:$("s_headless").value==="true",profileDir:$("s_profile").value,chromeExecutablePath:$("s_chrome").value,apiKey:$("s_key").value});
    $("saveMsg").textContent=JSON.stringify(r,null,2);$("saveState").textContent="done";
  }catch(e){$("saveMsg").textContent=String(e.message||e);$("saveState").textContent="error";}
};
refresh();loadSettings();setInterval(refresh,8000);
</script>
</body>
</html>`;
}
