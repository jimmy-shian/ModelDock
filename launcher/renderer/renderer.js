const $ = (id) => document.getElementById(id);
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;
let asking = false;

/* ===== Persisted Preferences ===== */
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : v; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

/* ===== Toast ===== */
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ===== 1-Click Copy (OpenDesign) ===== */
async function copyToClipboard(text, btn) {
  const orig = btn ? btn.textContent : '';
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch {}
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    ok = document.execCommand('copy');
    document.body.removeChild(ta);
  }
  if (ok) {
    if (btn) { btn.textContent = '已複製'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500); }
    toast('已複製');
  } else { toast('複製失敗'); }
}

/* ===== Theme Toggle ===== */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  store.set('md_theme', t);
  try { if (window.modelDock?.setTheme) window.modelDock.setTheme(t); } catch {}
}
$('btnTheme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
};
applyTheme(store.get('md_theme', 'dark'));

/* ===== Custom dropdown（下拉式選單動畫.txt）===== */
function dropdownValue(id) {
  const el = $(id);
  return (el && el.dataset && el.dataset.value) || '';
}
function setDropdownValue(id, value, silent) {
  const el = $(id);
  if (!el) return;
  const opts = el.querySelectorAll('.option');
  let label = value;
  opts.forEach((o) => {
    const match = o.dataset.value === value;
    o.classList.toggle('selected', match);
    if (match) label = o.textContent;
  });
  el.dataset.value = value;
  const lab = el.querySelector('.select-label');
  if (lab) lab.textContent = label;
  if (!silent) el.dispatchEvent(new CustomEvent('dropdown-change', { detail: { value } }));
}
function closeAllDropdowns(except) {
  document.querySelectorAll('.custom-select.open').forEach((el) => {
    if (el !== except) {
      el.classList.remove('open');
      const t = el.querySelector('.select-trigger');
      if (t) t.setAttribute('aria-expanded', 'false');
    }
  });
}
function initCustomDropdowns() {
  document.querySelectorAll('.custom-select').forEach((el) => {
    const trigger = el.querySelector('.select-trigger');
    if (!trigger) return;
    const toggle = (e) => {
      if (e) e.stopPropagation();
      const willOpen = !el.classList.contains('open');
      closeAllDropdowns(el);
      el.classList.toggle('open', willOpen);
      trigger.setAttribute('aria-expanded', String(willOpen));
    };
    trigger.addEventListener('click', toggle);
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
      if (e.key === 'Escape') { el.classList.remove('open'); }
    });
    el.querySelectorAll('.option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        setDropdownValue(el.id, opt.dataset.value);
        el.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      });
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-select')) closeAllDropdowns(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllDropdowns(null);
  });
}

/* ===== Tab Switching（作用域分開：瀏覽器分頁 vs 底部事件/診斷）===== */
function initPanelTabs() {
  document.querySelectorAll('.card-head .tab-bar .tab-btn[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      const target = btn.dataset.tab;
      const card = btn.closest('.card');
      const scope = card || document;
      scope.querySelectorAll('.tab-btn[data-tab]').forEach((b) => b.classList.remove('active'));
      scope.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = scope.querySelector('#' + target) || $(target);
      if (panel) panel.classList.add('active');
    };
  });
}

/* ===== Help Modal（終端指令已修為 PowerShell/CMD 安全版；MCP 改自然語言+自動路徑）===== */
function psCurlJson() {
  // PowerShell 5.1 的 curl 是 Invoke-WebRequest 別名，單引號 JSON 會壞；改用 curl.exe + 雙引號轉義。
  return `curl.exe -X POST ${BASE}/v1/chat/completions -H "Content-Type: application/json" --data "{\\"model\\":\\"gemini-web/flash\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}"`;
}
function psSimpleChat() {
  // 最穩：純文字 /chat，完全避開 JSON 引號地獄。
  return `curl.exe -X POST ${BASE}/chat -H "Content-Type: text/plain" --data-binary "你好"`;
}
function psInvokeRest() {
  return `$body = @{ model = "gemini-web/flash"; messages = @(@{ role = "user"; content = "你好" }) } | ConvertTo-Json -Depth 5\nInvoke-RestMethod -Uri "${BASE}/v1/chat/completions" -Method Post -ContentType "application/json" -Body $body`;
}
function mcpJsonText(pythonExe, serverScript) {
  return JSON.stringify({ mcpServers: { "modeldock": { command: pythonExe, args: [serverScript] } } }, null, 2);
}
function mcpNaturalLanguage(installDir, serverScript) {
  return `ModelDock 已安裝在本機的「${installDir}」，MCP 伺服器入口是「${serverScript}」。請你自動偵測本機 Python（優先用同目錄 venv 或系統 python），把上述 mcp_server.py 以 stdio 方式註冊為名為 modeldock 的 MCP server，不需要我手動填絕對路徑；若路徑含空格請自動加引號處理，註冊後呼叫 mcp_doctor 回報是否就緒。`;
}
const HELP_ITEMS = [
  { title: 'OpenAI BaseURL', sub: '外部 App 填這組', text: BASE + '/v1' },
  { title: '模型 ID（預設）', sub: 'Model 欄位填', text: 'gemini-web/flash' },
  { title: '對話（最穩・純文字・無 JSON 問題）', sub: 'PowerShell / CMD 直接貼', text: psSimpleChat() },
  { title: '對話（OpenAI 相容・curl.exe 版）', sub: '已轉義・CMD/PowerShell 皆可', text: psCurlJson() },
  { title: '對話（PowerShell 原生版）', sub: 'Invoke-RestMethod，無引號地獄', text: psInvokeRest() },
  { title: 'MCP 設定（給 AI 的一句話・自動抓路徑）', sub: '貼給 AI，它會自己抓取並設定', text: '載入中…（啟動後自動填入本機安裝路徑）', id: 'mcpNL' },
  { title: 'MCP 設定（JSON・路徑已自動填入）', sub: '複製此段到設定檔', text: '載入中…', id: 'mcpJSON' },
];
function buildHelp() {
  const box = $('helpCards'); box.innerHTML = '';
  HELP_ITEMS.forEach(item => {
    const card = document.createElement('div'); card.className = 'copy-card';
    card.innerHTML = `<div class="copy-card-head"><div style="flex:1"><strong>${item.title}</strong>${item.sub ? `<div class="hint-text" style="margin-top:0">${item.sub}</div>` : ''}</div><button class="btn-ghost copy-trigger">複製</button></div><pre${item.id ? ` id="help-${item.id}"` : ''}></pre>`;
    card.querySelector('pre').textContent = item.text;
    card.querySelector('.copy-trigger').onclick = function() { copyToClipboard(card.querySelector('pre').textContent, this); };
    box.appendChild(card);
  });
  refreshMcpHelp();
}
async function refreshMcpHelp() {
  // 路徑自動抓取：問主程式拿真實安裝目錄，每個人不同也不用手填。
  let installDir = '(未知路徑)';
  let pythonExe = 'python';
  let serverScript = 'mcp_server.py';
  try {
    if (window.modelDock?.getPaths) {
      const p = await window.modelDock.getPaths();
      if (p) {
        installDir = p.workspaceRoot || installDir;
        pythonExe = p.pythonExe || pythonExe;
        serverScript = p.serverScript || serverScript;
      }
    }
  } catch {}
  const nl = mcpNaturalLanguage(installDir, serverScript);
  const js = mcpJsonText(pythonExe, serverScript);
  const nlEl = document.getElementById('help-mcpNL');
  const jsEl = document.getElementById('help-mcpJSON');
  if (nlEl) nlEl.textContent = nl;
  if (jsEl) jsEl.textContent = js;
  HELP_ITEMS.forEach((it) => {
    if (it.id === 'mcpNL') it.text = nl;
    if (it.id === 'mcpJSON') it.text = js;
  });
}
$('btnHelp').onclick = () => $('helpOverlay').classList.add('open');
$('btnCloseHelp').onclick = () => $('helpOverlay').classList.remove('open');
$('helpOverlay').addEventListener('click', (e) => { if (e.target === $('helpOverlay')) $('helpOverlay').classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('helpOverlay').classList.remove('open'); });

/* ===== Login View & Browser Tab Switching ===== */
let loginVisible = true;
function setLoginVisible(v, silent) {
  loginVisible = !!v;
  const btn = $('btnToggleLogin');
  if (btn) {
    btn.textContent = loginVisible ? '隱藏登入頁' : '顯示登入頁';
    btn.setAttribute('aria-pressed', String(loginVisible));
  }
  if (!silent && window.modelDock?.toggleLogin) {
    window.modelDock.toggleLogin().then((r) => {
      if (r && typeof r.loginVisible === 'boolean') setLoginVisible(r.loginVisible, true);
    }).catch(() => {});
  }
}
if ($('btnToggleLogin')) $('btnToggleLogin').onclick = () => setLoginVisible(!loginVisible, false);
if ($('btnReloadPage')) $('btnReloadPage').onclick = async () => {
  const btn = $('btnReloadPage');
  btn.disabled = true;
  try {
    if (window.modelDock?.reloadBrowserTab) await window.modelDock.reloadBrowserTab();
    toast('內嵌頁重整中…');
  } catch { toast('重整失敗'); }
  finally { btn.disabled = false; }
};

let browserSwitching = false;
document.querySelectorAll('#browserTabBar .tab-btn').forEach(btn => {
  btn.onclick = async () => {
    if (browserSwitching) return;
    const provider = btn.dataset.provider;
    // 樂觀更新：先亮燈，切換體感更快；主程式同域不重載、常駐 view 秒切。
    document.querySelectorAll('#browserTabBar .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (window.modelDock?.switchBrowserTab) {
      browserSwitching = true;
      try { await window.modelDock.switchBrowserTab(provider); }
      catch {} finally { browserSwitching = false; }
    }
  };
});

/* ===== Status Polling ===== */
let refreshing = false;
async function refreshStatus() {
  if (refreshing) return;
  refreshing = true;
  try {
    if (window.modelDock?.loginStatus) {
      const s = await window.modelDock.loginStatus();
      setDot('dotChatGPT', s.chatgpt ? 'ok' : 'err');
      setDot('dotGemini', s.gemini ? 'ok' : 'warn');
      setDot('dotDeepSeek', s.deepseek ? 'ok' : 'warn');
      $('httpStatus').textContent = 'Running';
      $('httpStatus').className = 'stat-value ok';
      if (typeof s.loginVisible === 'boolean') setLoginVisible(s.loginVisible, true);
      if (s.activeProvider) {
        document.querySelectorAll('#browserTabBar .tab-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.provider === s.activeProvider);
        });
      }
    } else {
      // Fallback: check HTTP health
      try {
        const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const j = await r.json();
          $('httpStatus').textContent = 'Running';
          $('httpStatus').className = 'stat-value ok';
          if (j.gemini_direct) { setDot('dotGemini', 'ok'); }
          if (j.deepseek_direct) { setDot('dotDeepSeek', 'ok'); }
        }
      } catch {
        $('httpStatus').textContent = 'Offline';
        $('httpStatus').className = 'stat-value err';
      }
    }
  } catch {} finally { refreshing = false; }
}
function setDot(id, cls) {
  const dot = $(id);
  dot.className = 'status-dot';
  if (cls) dot.classList.add(cls);
}

/* ===== Send Prompt ===== */
$('btnAsk').onclick = async () => {
  const p = $('prompt').value.trim();
  if (!p) { toast('先填 prompt'); return; }
  if (asking) return;
  asking = true;
  $('askState').textContent = 'waiting';
  $('btnAsk').disabled = true;
  const model = dropdownValue('modelSelect') || 'gemini-web/flash';
  const cont = $('contCheck').checked;
  try {
    // Prefer IPC for chatgpt-web
    if (model.startsWith('chatgpt-web') && window.modelDock?.ask) {
      const r = await window.modelDock.ask(p, cont);
      $('askOut').textContent = r.reply + '\n\nurl: ' + r.conversationUrl + '\n' + r.durationMs + 'ms';
    } else {
      // Use HTTP /v1/chat/completions
      const r = await fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: p }], stream: false }),
      });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 500)); }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (body.error?.message || text.slice(0, 500)));
      const content = body.choices?.[0]?.message?.content ?? JSON.stringify(body, null, 2);
      $('askOut').textContent = content + '\n\nmodel: ' + (body.model || model);
    }
    $('askState').textContent = 'done';
  } catch (e) {
    $('askOut').textContent = String(e?.message || e);
    $('askState').textContent = 'error';
  } finally {
    asking = false;
    $('btnAsk').disabled = false;
  }
};

/* ===== Wiring ===== */
$('btnClear').onclick = () => { $('prompt').value = ''; $('askOut').textContent = '回覆會顯示在這裡…'; };
$('btnNewChat').onclick = async () => {
  if (window.modelDock?.newChat) await window.modelDock.newChat();
  toast('已開新對話');
};
$('btnCopyEndpoint').onclick = () => copyToClipboard(BASE + '/v1', $('btnCopyEndpoint'));
$('btnCopyConfig').onclick = () => {
  const cfg = JSON.stringify({ baseUrl: BASE + '/v1', model: dropdownValue('modelSelect') || 'gemini-web/flash', apiKey: 'not-needed' }, null, 2);
  copyToClipboard(cfg, $('btnCopyConfig'));
};
$('btnCopyLogs').onclick = () => {
  const items = document.querySelectorAll('.event-item');
  const text = Array.from(items).map(el => el.textContent).join('\n');
  copyToClipboard(text || '(no events)', $('btnCopyLogs'));
};
$('btnRefresh').onclick = () => refreshStatus();

/* ===== Init ===== */
initCustomDropdowns();
initPanelTabs();
// 還原偏好 + 對話模式接線（修：原本 chatMode 選了沒送給主程式）
try {
  const savedModel = store.get('md_model', '');
  if (savedModel) setDropdownValue('modelSelect', savedModel, true);
  const savedMode = store.get('md_chatmode', dropdownValue('chatMode') || 'temporary');
  setDropdownValue('chatMode', savedMode, true);
} catch {}
$('modelSelect').addEventListener('dropdown-change', (e) => {
  try { store.set('md_model', e.detail.value); } catch {}
});
$('chatMode').addEventListener('dropdown-change', (e) => {
  const v = e.detail.value || 'temporary';
  try { store.set('md_chatmode', v); } catch {}
  // Gemini 無免登入；ChatGPT 有 temporary 無痕。登入後預設仍是無痕，不留紀錄。
  const temporary = v !== 'normal';
  const hint = $('chatModeHint');
  if (hint) hint.textContent = temporary ? '登入後仍開無痕對話，不留紀錄；切一般才會保留。' : '一般模式：對話會保留在帳號紀錄中。';
  try { if (window.modelDock?.setTemporaryChat) window.modelDock.setTemporaryChat(temporary); } catch {}
});
try {
  const cur = dropdownValue('chatMode');
  if (window.modelDock?.setTemporaryChat) window.modelDock.setTemporaryChat(cur !== 'normal');
} catch {}
// 背景分頁不輪詢，省 CPU 也避免切換卡頓感
let pageVisible = !document.hidden;
document.addEventListener('visibilitychange', () => { pageVisible = !document.hidden; });
buildHelp();
refreshStatus();
setInterval(() => { if (!asking && pageVisible) refreshStatus(); }, 5000);
