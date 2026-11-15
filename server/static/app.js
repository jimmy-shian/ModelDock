/* WebChat2Local Dashboard — 淺色 Zinc 主題 */
let isStreaming = false;
let lastLogs = [];
const $ = (id) => document.getElementById(id);

function esc(s) {
  const M = {
    '&': String.fromCharCode(38) + 'amp;',
    '<': String.fromCharCode(38) + 'lt;',
    '>': String.fromCharCode(38) + 'gt;',
    '"': String.fromCharCode(38) + 'quot;',
    "'": String.fromCharCode(38) + '#39;',
  };
  return String(s ?? '').replace(/[&<>"']/g, (c) => M[c]);
}
function relative(ts) {
  if (!ts) return '—';
  const d = Math.max(0, Date.now() / 1000 - ts);
  return d < 2 ? '剛剛' : `${Math.round(d)} 秒前`;
}

const MODE_LABEL = { auto: '自動', direct: '直連 (Cookie)', extension: 'Web 視窗' };

/* ========== 自訂下拉選單（動畫） ========== */
function closeAllSelects(except) {
  document.querySelectorAll('.cselect.open').forEach((el) => {
    if (el !== except) el.classList.remove('open');
  });
}
function initCustomSelect(el, onChange) {
  const trigger = el.querySelector('.cs-trigger');
  const label = el.querySelector('.cs-label');
  const options = el.querySelector('.cs-options');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllSelects(el);
    const willOpen = !el.classList.contains('open');
    if (willOpen && options) {
      /* 依可用空間決定向下或向上展開，避免被視窗/面板邊緣遮擋 */
      const rect = trigger.getBoundingClientRect();
      const need = options.scrollHeight || 320;
      const below = window.innerHeight - rect.bottom;
      el.classList.toggle('dropup', below < Math.min(need + 20, 320) && rect.top > below);
    }
    el.classList.toggle('open');
  });
  el.querySelectorAll('.cs-option').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      el.querySelectorAll('.cs-option').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      el.dataset.value = opt.dataset.value;
      label.textContent = opt.textContent;
      el.classList.remove('open');
      if (onChange) onChange(opt.dataset.value, opt.textContent);
    });
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.cselect')) closeAllSelects(null);
});

/* 摺疊面板 */
function togglePanel(id) {
  const p = $(id);
  if (p) p.classList.toggle('open');
}

/* 底部 Tab 切換（事件 / 診斷） */
function switchTab(bodyId, tabBtn) {
  document.querySelectorAll('#bottomPanel .tab-body').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#bottomPanel .tab').forEach((t) => t.classList.remove('active'));
  const body = $(bodyId);
  if (body) body.classList.add('active');
  if (tabBtn) tabBtn.classList.add('active');
}

/* ========== Transport ========== */
async function fetchTransport() {
  try {
    const r = await fetch('/v1/transport', { cache: 'no-store' });
    if (!r.ok) throw 0;
    const d = await r.json();
    const sel = $('transportMode');
    if (sel && sel.dataset.value !== d.mode) setSelectValue(sel, d.mode, MODE_LABEL[d.mode] || d.mode);
    updateTransportUI(d);
  } catch (e) {
    const m = $('modeMsg');
    if (m) m.textContent = '無法讀取傳輸狀態（伺服器未啟動？）。';
  }
}

function setSelectValue(el, value, text) {
  if (!el) return;
  el.dataset.value = value;
  const label = el.querySelector('.cs-label');
  if (label) label.textContent = text || value;
  let found = false;
  el.querySelectorAll('.cs-option').forEach((o) => {
    const match = o.dataset.value === value;
    o.classList.toggle('selected', match);
    if (match) {
      found = true;
      if (label && o.textContent) label.textContent = o.textContent;
    }
  });
  if (!found && label) label.textContent = text || value;
}

function updateTransportUI(d) {
  const badge = $('transportBadge');
  if (badge) badge.textContent = '傳輸：' + (MODE_LABEL[d.mode] || d.mode);
  const m = $('modeMsg');
  if (m) {
    const hints = [];
    if (d.mode === 'direct' && !d.direct_configured)
      hints.push('直連需要 cookie：開啟 gemini.google.com 自動同步，或手動設定 gemini_cookies.json。');
    if (d.mode === 'extension' && !d.browser_connected)
      hints.push('Web 視窗模式需要開啟 gemini.google.com 分頁。');
    if (d.mode === 'auto' && !d.direct_configured && !d.browser_connected)
      hints.push('尚無可用通道：開啟 gemini.google.com 或設定 cookie。');
    if (!hints.length)
      hints.push('目前：' + (MODE_LABEL[d.mode] || d.mode) +
        (d.direct_configured ? ' · Cookie 可用' : '') +
        (d.browser_connected ? ' · 擴充套件連線' : ''));
    m.textContent = hints.join('　');
  }
}

async function onTransportChange(value) {
  try {
    const r = await fetch('/v1/transport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: value }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      $('modeMsg').textContent = e.detail || '切換失敗。';
      return;
    }
    const d = await r.json();
    updateTransportUI(d);
  } catch (e) {
    $('modeMsg').textContent = '切換失敗: ' + e.message;
  }
}

/* ========== Status ========== */
async function fetchStatus() {
  try {
    const r = await fetch('/v1/status', { cache: 'no-store' });
    if (!r.ok) throw 0;
    const d = await r.json();
    const b = d.browser_info || {};
    const connected = !!d.browser_connected;
    const direct = !!(d.transport && d.transport.direct_configured);
    const s = $('status');
    s.className = 'pill ' + ((connected || direct) ? (d.has_active_turn ? 'busy' : 'ok') : 'bad');
    $('statusText').textContent = d.has_active_turn ? '生成中'
      : (connected ? '擴充套件已連線' : (direct ? '直連就緒' : '等待連線'));

    /* 摘要列（摺疊時也可見） */
    const sum = $('statusSummary');
    if (sum) {
      sum.textContent = d.has_active_turn ? '生成中'
        : (connected ? '擴充套件連線' : (direct ? '直連就緒' : '離線'));
    }
    const mini = $('statusMiniDot');
    if (mini) {
      mini.className = 'mini-dot ' + (d.has_active_turn ? 'warning'
        : (connected || direct) ? 'ok' : 'error');
    }

    if (d.transport) {
      const t = d.transport;
      updateTransportUI(t);
      const dir = $('directState');
      if (dir) {
        dir.textContent = t.direct_configured ? '已設定' : '未設定';
        dir.className = 'value ' + (t.direct_configured ? 'green' : 'red');
      }
    }
    const ext = $('extState');
    if (ext) {
      ext.textContent = connected ? '已連線' : '離線';
      ext.className = 'value ' + (connected ? 'green' : 'red');
    }
    const plat = $('platformState');
    if (plat) {
      // 優先用各分頁普查（雙開分頁時 browser_info 只顯示最後回報者）。
      const counts = d.platforms || (d.transport && d.transport.platforms) || null;
      if (counts && Object.keys(counts).length) {
        const name = (p) => p === 'chatgpt' ? 'ChatGPT' : p === 'gemini' ? 'Gemini' : p;
        plat.textContent = Object.keys(counts).sort()
          .map((p) => counts[p] > 1 ? `${name(p)}×${counts[p]}` : name(p)).join('＋');
      } else {
        const p = b.platform || '';
        plat.textContent = p ? (p === 'chatgpt' ? 'ChatGPT' : p === 'gemini' ? 'Gemini' : p) : '—';
      }
    }
    const tabs = $('tabsState');
    if (tabs) tabs.textContent = d.active_tabs ?? 0;
    const seen = $('seenState');
    if (seen) seen.textContent = relative(b.last_seen);
  } catch (e) {
    const s = $('status');
    if (s) { s.className = 'pill bad'; $('statusText').textContent = '本機服務無回應'; }
    const sum = $('statusSummary');
    if (sum) sum.textContent = '無回應';
  }
}

/* ========== Logs ========== */
function renderEventDetails(details) {
  // details 內含被呼叫的端點/模型、輸入、輸出等參數，事件列要看得見。
  if (!details || typeof details !== 'object') return '';
  const entries = Object.entries(details).filter(([, v]) =>
    v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
  if (!entries.length) return '';
  const rows = entries.map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return '<div class="ev-det"><span class="ev-det-k">' + esc(k) + '</span>' +
      '<span class="ev-det-v">' + esc(text) + '</span></div>';
  }).join('');
  return '<div class="ev-details">' + rows + '</div>';
}

async function fetchLogs() {
  try {
    const r = await fetch('/v1/logs?limit=80', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    lastLogs = d.logs || [];
    const c = $('logContainer');
    if (c) {
      c.innerHTML = lastLogs.length
        ? lastLogs.map((x) =>
            '<div class="event"><span class="ev-time">' + esc(x.time) + '</span>' +
            '<span class="ev-level ' + esc(String(x.level || 'info').toLowerCase()) + '">' + esc(x.level) + '</span>' +
            '<span class="ev-src">' + esc(x.source) + '</span>' +
            '<span class="ev-msg">' + esc(x.message) + '</span>' +
            renderEventDetails(x.details) + '</div>'
          ).join('')
        : '<div class="event empty">尚無事件</div>';
        const summary = $('logsSummary');
        if (summary) {
          const errs = lastLogs.filter((x) => String(x.level).toLowerCase() === 'error').length;
          summary.textContent = lastLogs.length ? String(lastLogs.length) : '0';
          summary.classList.toggle('error', errs > 0);
        }
    }
  } catch (e) {}
}

/* ========== Doctor ========== */
async function fetchDoctor() {
  try {
    const r = await fetch('/v1/doctor', { cache: 'no-store' });
    const d = await r.json();
    const el = $('doctor');
    const sum = $('doctorSummary');
    const checks = d.checks || [];
    if (el) {
      el.innerHTML = checks.map((c) =>
        '<div class="check"><span class="check-dot ' + esc(c.status) + '"></span>' +
        '<div><b>' + esc(c.message) + '</b>' +
        (c.detail ? '<div class="check-detail">' + esc(c.detail) + '</div>' : '') + '</div></div>'
      ).join('') || '目前沒有診斷項目。';
    }
    if (sum) {
      const bad = checks.filter((c) => c.status === 'error').length;
      const warn = checks.filter((c) => c.status === 'warning').length;
      sum.textContent = checks.length
        ? (bad ? `${bad} 異常` : warn ? `${warn} 警告` : '正常')
        : '—';
    }
  } catch (e) {
    const el = $('doctor');
    if (el) el.textContent = '診斷端點無法讀取。';
    const sum = $('doctorSummary');
    if (sum) sum.textContent = '無法讀取';
  }
}

/* ========== Chat（通用型顯示：依當前模型/傳輸動態更新） ========== */
function modelDisplay(model) {
  const m = String(model || '');
  if (m.startsWith('chatgpt')) return { avatar: 'GPT', who: 'ChatGPT' };
  if (m.startsWith('gemini')) return { avatar: 'GM', who: 'Gemini' };
  if (m.startsWith('webchat')) return { avatar: '自', who: '自動路由' };
  if (!m) return { avatar: 'AI', who: '助理' };
  return { avatar: m.slice(0, 2).toUpperCase(), who: m };
}

function addMessage(kind, model, transport, text) {
  const disp = modelDisplay(model);
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + kind;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = kind === 'user' ? '你' : disp.avatar;

  const body = document.createElement('div');
  body.className = 'msg-body';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const who = kind === 'user' ? '使用者' : disp.who;
  meta.textContent = who + (kind === 'assistant' ? ' · ' + model + (transport ? ' · ' + (MODE_LABEL[transport] || transport) : '') : '');

  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.style.display = 'none';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (typeof text === 'string' && text.length > 0) bubble.textContent = text;

  body.append(meta, thinking, bubble);
  wrap.append(avatar, body);
  const out = $('chatOutput');
  out.appendChild(wrap);
  out.scrollTop = out.scrollHeight;
  return { wrap, meta, thinking, bubble };
}

async function sendDevPrompt() {
  if (isStreaming) return;
  const input = $('promptInput');
  const prompt = input.value.trim();
  if (!prompt) return;
  const modelSel = $('modelSelect');
  const model = modelSel ? modelSel.dataset.value : 'webchat/auto';

  isStreaming = true;
  $('sendBtn').disabled = true;
  input.value = '';

  // 使用者泡泡必須顯示本次輸入內容（修正：先前直接丟棄，回傳空白泡泡）
  addMessage('user', model, null, prompt);
  const a = addMessage('assistant', model);
  a.bubble.classList.add('pending');
  a.bubble.textContent = '…';

  let text = '', thought = '';
  const started = performance.now();
  try {
    const r = await fetch('/v1/dev/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      a.bubble.classList.remove('pending');
      a.bubble.classList.add('error');
      a.bubble.textContent = '[錯誤] ' + (e.detail || '請求失敗 (' + r.status + ')');
      return;
    }
    const transport = r.headers.get('X-W2L-Transport');
    if (transport) {
      const who = modelDisplay(model).who;
      a.meta.textContent = who + ' · ' + model + ' · ' + (MODE_LABEL[transport] || transport);
    }
    a.bubble.classList.remove('pending');
    a.bubble.textContent = '';

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          const delta = d.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            thought += delta.reasoning_content;
            a.thinking.style.display = 'block';
            a.thinking.textContent = thought;
          }
          if (delta?.content) {
            text += delta.content;
            a.bubble.textContent = text;
            $('chatOutput').scrollTop = $('chatOutput').scrollHeight;
          }
        } catch {}
      }
    }
    if (!text && !thought) {
      a.bubble.classList.add('error');
      a.bubble.textContent = '[空回應] 傳輸通道未回傳任何內容。';
    }
  } catch (e) {
    a.bubble.classList.remove('pending');
    a.bubble.classList.add('error');
    a.bubble.textContent = '[連線異常] ' + e.message;
  } finally {
    const ms = Math.round(performance.now() - started);
    const footer = document.createElement('div');
    footer.className = 'msg-footer';
    footer.textContent = '完成 · ' + ms + ' ms' + (thought ? ' · 思考 ' + thought.length + ' 字' : '');
    a.wrap.querySelector('.msg-body').appendChild(footer);
    isStreaming = false;
    $('sendBtn').disabled = false;
    setTimeout(fetchLogs, 100);
    setTimeout(fetchStatus, 100);
  }
}

function currentModel() {
  const el = $('modelSelect');
  return (el && el.dataset.value) || 'webchat/auto';
}

function baseUrl() {
  return window.location.origin || 'http://127.0.0.1:8765';
}

function clearChat() {
  const out = $('chatOutput');
  out.innerHTML = '';
  addMessage('assistant', currentModel()).bubble.textContent =
    '對話已清除。輸入訊息測試目前傳輸模式與所選模型的完整串流。';
}

/* ========== Models（動態載入 /v1/models，不再硬編碼） ========== */
async function fetchModels() {
  try {
    const r = await fetch('/v1/models', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    const list = (d.data || []).filter((m) => !String(m.id).includes('->') && !m.parent);
    if (!list.length) return;
    const sel = $('modelSelect');
    if (!sel) return;
    const prev = currentModel();
    const opts = sel.querySelector('.cs-options');
    const label = sel.querySelector('.cs-label');
    if (opts) {
      opts.innerHTML = '';
      list.forEach((m) => {
        const div = document.createElement('div');
        div.className = 'cs-option';
        div.dataset.value = m.id;
        div.textContent = m.display_name ? `${m.id}（${m.display_name}）` : m.id;
        opts.appendChild(div);
      });
      // 重新綁定選項點擊（initCustomSelect 只綁定初始節點）
      sel.querySelectorAll('.cs-option').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          sel.querySelectorAll('.cs-option').forEach((o) => o.classList.remove('selected'));
          opt.classList.add('selected');
          sel.dataset.value = opt.dataset.value;
          if (label) label.textContent = opt.textContent;
          sel.classList.remove('open');
        });
      });
      const keep = list.some((m) => m.id === prev) ? prev : (list[0] && list[0].id);
      if (keep) {
        const target = Array.from(sel.querySelectorAll('.cs-option')).find((o) => o.dataset.value === keep);
        sel.querySelectorAll('.cs-option').forEach((o) => o.classList.remove('selected'));
        if (target) {
          target.classList.add('selected');
          sel.dataset.value = keep;
          if (label) label.textContent = target.textContent;
        }
      }
    }
  } catch (_) {}
}

/* ========== Copy helpers ========== */
function copyEndpoint() {
  navigator.clipboard.writeText(baseUrl() + '/v1');
  flashCopied('copyEpBtn', '已複製');
}
function copyClientConfig() {
  const cfg = {
    apiProvider: 'openai',
    openAiBaseUrl: baseUrl() + '/v1',
    openAiApiKey: 'sk-local',
    openAiModelId: currentModel(),
    customModelInfo: {
      supportsPromptCache: false,
      maxTokens: 16384,
      contextWindow: 32768,
      supportsThinking: true,
    },
  };
  navigator.clipboard.writeText(JSON.stringify(cfg, null, 2));
  flashCopied('copyCfgBtn', '已複製');
}
function copyLogs() {
  navigator.clipboard.writeText(
    lastLogs.map((x) =>
      '[' + x.time + '] [' + x.level + '] [' + x.source + '] ' + x.message +
      (Object.keys(x.details || {}).length ? ' ' + JSON.stringify(x.details) : '')
    ).join('\n')
  );
  flashCopied('copyLogsBtn', '已複製');
}
function flashCopied(id, label) {
  const el = document.getElementById(id);
  if (!el) return;
  const old = el.textContent;
  el.textContent = label || '已複製';
  setTimeout(() => { el.textContent = old; }, 1400);
}

function refreshAll() { fetchStatus(); fetchLogs(); fetchDoctor(); fetchTransport(); fetchModels(); }

/* ========== init ========== */
document.addEventListener('DOMContentLoaded', () => {
  initCustomSelect($('transportMode'), onTransportChange);
  initCustomSelect($('modelSelect'));
  const ep = $('endpointBox');
  if (ep) ep.textContent = baseUrl() + '/v1';
  if ($('chatOutput') && !$('chatOutput').children.length) {
    addMessage('assistant', currentModel()).bubble.textContent =
      '輸入訊息測試目前傳輸模式（直連 Cookie 或瀏覽器擴充套件）與所選模型的完整串流。';
  }
  refreshAll();
});
setInterval(fetchStatus, 2000);
setInterval(fetchLogs, 1500);
setInterval(fetchTransport, 5000);