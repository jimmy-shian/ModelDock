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

/* ===== Tab Switching ===== */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(target).classList.add('active');
  };
});

/* ===== Help Modal ===== */
const HELP_ITEMS = [
  { title: 'OpenAI BaseURL', sub: '外部 App 填這組', text: BASE + '/v1' },
  { title: '模型 ID（預設）', sub: 'Model 欄位填', text: 'gemini-web/flash' },
  { title: '對話（OpenAI 相容）', sub: 'curl 指令', text: `curl -X POST ${BASE}/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"gemini-web/flash","messages":[{"role":"user","content":"你好"}]}'` },
  { title: 'MCP 設定（Antigravity / Cursor）', sub: '複製此段到設定檔', text: JSON.stringify({ mcpServers: { "modeldock": { command: "C:\\Users\\Administrator\\venv\\Scripts\\python.exe", args: ["C:\\Users\\Administrator\\Desktop\\html_test\\ModelDock\\mcp_server.py"] } } }, null, 2) },
];
function buildHelp() {
  const box = $('helpCards'); box.innerHTML = '';
  HELP_ITEMS.forEach(item => {
    const card = document.createElement('div'); card.className = 'copy-card';
    card.innerHTML = `<div class="copy-card-head"><div style="flex:1"><strong>${item.title}</strong>${item.sub ? `<div class="hint-text" style="margin-top:0">${item.sub}</div>` : ''}</div><button class="btn-ghost copy-trigger">複製</button></div><pre>${item.text}</pre>`;
    card.querySelector('.copy-trigger').onclick = function() { copyToClipboard(item.text, this); };
    box.appendChild(card);
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

document.querySelectorAll('#browserTabBar .tab-btn').forEach(btn => {
  btn.onclick = () => {
    const provider = btn.dataset.provider;
    document.querySelectorAll('#browserTabBar .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (window.modelDock?.switchBrowserTab) {
      window.modelDock.switchBrowserTab(provider);
    }
    toast('切換內嵌分頁至 ' + provider);
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
  const model = $('modelSelect').value;
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
  const cfg = JSON.stringify({ baseUrl: BASE + '/v1', model: $('modelSelect').value, apiKey: 'not-needed' }, null, 2);
  copyToClipboard(cfg, $('btnCopyConfig'));
};
$('btnCopyLogs').onclick = () => {
  const items = document.querySelectorAll('.event-item');
  const text = Array.from(items).map(el => el.textContent).join('\n');
  copyToClipboard(text || '(no events)', $('btnCopyLogs'));
};
$('btnRefresh').onclick = () => refreshStatus();

/* ===== Init ===== */
buildHelp();
refreshStatus();
setInterval(() => { if (!asking) refreshStatus(); }, 5000);
