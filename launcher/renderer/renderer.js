const $ = (id) => document.getElementById(id);
const BASE = "http://127.0.0.1:8787";
const DEFAULT_MODEL = "gpt-web-port";
let refreshing = false;
let asking = false;

/* ---------- persisted defaults ---------- */
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : v; } catch (e) { return fb; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
let protocol = store.get("gwp_protocol", "native"); // native | oai
let loginVisible = true;

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

/* ---------- 1-click copy ---------- */
async function copyToClipboard(text, btn) {
  const orig = btn ? btn.textContent : "";
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { /* fallback below */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) { ok = false; }
  }
  if (ok) {
    if (btn) {
      btn.textContent = "已複製";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1500);
    }
    toast("已複製");
  } else {
    toast("複製失敗");
  }
}

/* ---------- login status auto-refresh ---------- */
function fmtTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await window.gptPort.loginStatus();
    const badge = $("loginBadge");
    if (s.loggedIn) {
      $("dot").className = "dot ok";
      badge.textContent = "[已登入]";
      badge.className = "badge ok";
    } else {
      $("dot").className = "dot";
      badge.textContent = "[未登入]";
      badge.className = "badge err";
    }
    $("autoNote").textContent = "自動刷新中 · 更新於 " + fmtTime(new Date());
    // 若主程式有回報面板可見性，同步切換鈕（支援舊版無此欄位）
    if (typeof s.loginVisible === "boolean") setLoginVisible(s.loginVisible, true);
  } catch (e) {
    $("dot").className = "dot err";
    $("loginBadge").textContent = "[檢查失敗]";
    $("loginBadge").className = "badge err";
    $("autoNote").textContent = "自動刷新中 · " + String((e && e.message) || e);
  } finally {
    refreshing = false;
  }
}

/* ---------- help cards（重整後：URL / 模型 ID 各一，單一用途拷貝） ---------- */
const HELP_ITEMS = [
  { title: "服務位址", sub: "瀏覽器開此 URL", text: BASE },
  { title: "OpenAI BaseURL", sub: "外部 App 填這組", text: BASE + "/v1" },
  { title: "模型 ID", sub: "Model 欄位填這個", text: DEFAULT_MODEL },
  { title: "查看模型（GET /v1/models）", sub: "取可用 ID 列表", text: "curl " + BASE + "/v1/models" },
  {
    title: "對話（OpenAI 相容）",
    sub: "與 SDK 相同的路徑",
    text: 'curl -X POST ' + BASE + '/v1/chat/completions -H "Content-Type: application/json" -d "{\\"model\\":\\"' + DEFAULT_MODEL + '\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}"',
  },
  {
    title: "對話（原生 /chat）",
    sub: "簡單測試用",
    text: 'curl -X POST ' + BASE + '/chat -H "Content-Type: application/json" -d "{\\"prompt\\":\\"你好\\"}"',
  },
];

function buildHelp() {
  const box = $("helpCards");
  box.innerHTML = "";
  HELP_ITEMS.forEach((item) => {
    const card = document.createElement("div");
    card.className = "copy-card";
    const cap = document.createElement("div");
    cap.className = "cap";
    const titleBox = document.createElement("div");
    titleBox.style.flex = "1";
    const strong = document.createElement("strong");
    strong.textContent = item.title;
    const sub = document.createElement("div");
    sub.className = "hint";
    sub.style.marginTop = "0";
    sub.textContent = item.sub || "";
    titleBox.appendChild(strong);
    if (item.sub) titleBox.appendChild(sub);
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "複製";
    btn.onclick = () => copyToClipboard(item.text, btn);
    cap.appendChild(titleBox);
    cap.appendChild(btn);
    const pre = document.createElement("pre");
    pre.textContent = item.text;
    card.appendChild(cap);
    card.appendChild(pre);
    box.appendChild(card);
  });
}

/* ---------- single toggle: 顯示 / 隱藏登入頁 ---------- */
function setLoginVisible(v, silent) {
  loginVisible = !!v;
  const btn = $("btnToggleLogin");
  btn.textContent = loginVisible ? "隱藏登入頁" : "顯示登入頁";
  btn.setAttribute("aria-pressed", String(loginVisible));
  if (!silent) {
    if (window.gptPort.toggleLogin) {
      window.gptPort.toggleLogin().then((r) => {
        if (r && typeof r.loginVisible === "boolean") setLoginVisible(r.loginVisible, true);
      }).catch(() => {});
    } else if (loginVisible) {
      window.gptPort.showLogin();
    } else {
      window.gptPort.showPanel();
    }
  }
}

/* ---------- protocol segmented toggle ---------- */
function setProtocol(p, silent) {
  protocol = p === "oai" ? "oai" : "native";
  if (!silent) store.set("gwp_protocol", protocol);
  $("segNative").classList.toggle("active", protocol === "native");
  $("segOai").classList.toggle("active", protocol === "oai");
  $("segNative").setAttribute("aria-selected", String(protocol === "native"));
  $("segOai").setAttribute("aria-selected", String(protocol === "oai"));
  updateHint();
}

function updateHint() {
  const cont = $("cont").checked ? "沿用上一輪" : "每次重開";
  const mode = $("chatMode").value === "normal" ? "一般紀錄" : "無痕模式";
  const way = protocol === "oai" ? "OpenAI 相容 /v1/chat/completions" : "原生 /chat";
  $("askHint").textContent = "目前：" + way + " · " + cont + " · " + mode + "。";
}

/* ---------- models: GET /v1/models ---------- */
async function fetchModels(silent) {
  const list = $("modelList");
  try {
    const r = await fetch(BASE + "/v1/models");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id).filter(Boolean);
    list.innerHTML = "";
    ids.forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      list.appendChild(opt);
    });
    if (ids.length > 0) {
      const cur = $("oaiModel").value.trim();
      if (silent) {
        // 靜默初始化只補 datalist，不覆寫使用者已存的自訂模型
        if (!cur) $("oaiModel").value = ids[0];
      } else {
        if (!cur || !ids.includes(cur)) $("oaiModel").value = ids[0];
        store.set("gwp_model", $("oaiModel").value.trim());
        toast("模型：" + ids.join("、"));
      }
    } else if (!silent) {
      toast("沒有可用模型");
    }
    return ids;
  } catch (e) {
    if (!silent) toast("取得模型失敗：" + String((e && e.message) || e));
    return [];
  }
}

/* ---------- wiring ---------- */
$("btnToggleLogin").onclick = () => setLoginVisible(!loginVisible, false);
$("btnNewChat").onclick = async () => {
  await window.gptPort.newChat();
  refresh();
};
$("segNative").onclick = () => setProtocol("native");
$("segOai").onclick = () => setProtocol("oai");
$("oaiModel").onchange = () => store.set("gwp_model", $("oaiModel").value.trim());
$("btnModels").onclick = () => fetchModels(false);
$("chatMode").onchange = () => {
  const v = $("chatMode").value;
  store.set("gwp_chat_mode", v);
  if (window.gptPort.setTemporaryChat) {
    window.gptPort.setTemporaryChat(v !== "normal").catch(() => {});
  }
  updateHint();
};
$("cont").onchange = () => {
  if ($("contDefault").checked) store.set("gwp_cont_default", $("cont").checked ? "1" : "0");
  updateHint();
};
$("contDefault").onchange = () => {
  if ($("contDefault").checked) store.set("gwp_cont_default", $("cont").checked ? "1" : "0");
  else store.set("gwp_cont_default", "");
};
$("btnClear").onclick = () => {
  $("prompt").value = "";
  $("askOut").textContent = "回覆會顯示在這裡…";
};
$("btnAsk").onclick = async () => {
  const p = $("prompt").value.trim();
  if (!p) { toast("先填 prompt"); return; }
  if (asking) return;
  asking = true;
  $("askState").textContent = "waiting";
  $("btnAsk").disabled = true;
  const cont = $("cont").checked;
  try {
    if (protocol === "oai") {
      // 走真正的 OpenAI 相容端口，驗證外部 App 看到的同一條路
      const model = $("oaiModel").value.trim() || DEFAULT_MODEL;
      const r = await fetch(BASE + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: p }], continue: cont }),
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch (e) { throw new Error("HTTP " + r.status + " " + text.slice(0, 500)); }
      if (!r.ok) throw new Error("HTTP " + r.status + " " + text.slice(0, 500));
      const content = body.choices && body.choices[0] && body.choices[0].message
        ? body.choices[0].message.content
        : JSON.stringify(body, null, 2);
      $("askOut").textContent = content + "\n\nmodel: " + (body.model || model);
      $("askState").textContent = "done (oai)";
    } else {
      const r = await window.gptPort.ask(p, cont);
      $("askOut").textContent = r.reply + "\n\nurl: " + r.conversationUrl + "\n" + r.durationMs + "ms";
      $("askState").textContent = "done";
    }
  } catch (e) {
    $("askOut").textContent = String((e && e.message) || e);
    $("askState").textContent = "error";
  } finally {
    asking = false;
    $("btnAsk").disabled = false;
    refresh();
  }
};

/* help modal */
$("btnHelp").onclick = () => $("helpOverlay").classList.add("open");
$("btnCloseHelp").onclick = () => $("helpOverlay").classList.remove("open");
$("helpOverlay").addEventListener("click", (e) => {
  if (e.target === $("helpOverlay")) $("helpOverlay").classList.remove("open");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("helpOverlay").classList.remove("open");
});

/* theme */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("gwp_theme", t); } catch (e) {}
  try { if (window.gptPort && window.gptPort.setTheme) window.gptPort.setTheme(t); } catch (e) {}
}
$("btnTheme").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(cur === "light" ? "dark" : "light");
};
try {
  applyTheme(localStorage.getItem("gwp_theme") || "light");
} catch (e) { applyTheme("light"); }

/* init defaults: 接續 vs 重開、無痕 vs 一般、上次的協定與模型 */
(function initDefaults() {
  const contDef = store.get("gwp_cont_default", "");
  $("cont").checked = contDef === "1";
  $("contDefault").checked = contDef === "1" || contDef === "0";
  const savedMode = store.get("gwp_chat_mode", "temporary");
  $("chatMode").value = savedMode === "normal" ? "normal" : "temporary";
  $("oaiModel").value = store.get("gwp_model", DEFAULT_MODEL);
  setProtocol(protocol, true);
  setLoginVisible(true, true);
  // 若主程式支援，同步無痕偏好
  if (window.gptPort.setTemporaryChat) {
    window.gptPort.setTemporaryChat($("chatMode").value !== "normal").catch(() => {});
  }
  updateHint();
})();

buildHelp();
fetchModels(true);
refresh();
setInterval(() => { if (!asking) refresh(); }, 5000);
