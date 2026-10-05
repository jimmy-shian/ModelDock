const $ = (id) => document.getElementById(id);
const BASE = "http://127.0.0.1:8787";
let refreshing = false;
let asking = false;

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
  } catch (e) {
    $("dot").className = "dot err";
    $("loginBadge").textContent = "[檢查失敗]";
    $("loginBadge").className = "badge err";
    $("autoNote").textContent = "自動刷新中 · " + String((e && e.message) || e);
  } finally {
    refreshing = false;
  }
}

/* ---------- help cards ---------- */
const HELP_ITEMS = [
  { title: "服務位址", text: BASE },
  {
    title: "POST /chat（原生）",
    text: 'curl -X POST ' + BASE + '/chat -H "content-type: application/json" -d \'{"prompt":"你好"}\'',
  },
  { title: "GET /health（狀態）", text: "curl " + BASE + "/health" },
  {
    title: "OpenAI 相容",
    text: "BaseURL=" + BASE + "/v1\nModel=gpt-web-port",
  },
  {
    title: "Python 範例",
    text: 'from openai import OpenAI\nc = OpenAI(base_url="' + BASE + '/v1", api_key="not-needed")\nprint(c.chat.completions.create(model="gpt-web-port", messages=[{"role": "user", "content": "你好"}]).choices[0].message.content)',
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
    const strong = document.createElement("strong");
    strong.textContent = item.title;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "複製";
    btn.onclick = () => copyToClipboard(item.text, btn);
    cap.appendChild(strong);
    cap.appendChild(btn);
    const pre = document.createElement("pre");
    pre.textContent = item.text;
    card.appendChild(cap);
    card.appendChild(pre);
    box.appendChild(card);
  });
}

/* ---------- wiring ---------- */
$("btnShowLogin").onclick = () => window.gptPort.showLogin();
$("btnHideLogin").onclick = () => window.gptPort.showPanel();
$("btnNewChat").onclick = async () => {
  await window.gptPort.newChat();
  refresh();
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
  try {
    const r = await window.gptPort.ask(p, $("cont").checked);
    $("askOut").textContent = r.reply + "\n\nurl: " + r.conversationUrl + "\n" + r.durationMs + "ms";
    $("askState").textContent = "done";
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

buildHelp();
refresh();
setInterval(() => { if (!asking) refresh(); }, 5000);
