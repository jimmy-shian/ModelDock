/**
 * ChatGPT Web raw transport interceptor (MAIN world, document_start).
 *
 * Guest ("unauth-mweb") mode streams the assistant answer through
 *   POST /unauth-mweb/conversation/updates
 * with content type "text/vnd.openai.web-mobile-partial+html" (a long-lived
 * HTML partial stream), and logged-in desktop mode uses
 *   POST /backend-api/conversation
 * (SSE with JSON events).
 *
 * Capturing the raw stream directly makes answer extraction independent of
 * DOM selectors, so text and <tool_call> payloads survive DOM rendering.
 */
(function () {
  if (window.__WebChat2Local_Chatgpt_Interceptor_Loaded) return;
  window.__WebChat2Local_Chatgpt_Interceptor_Loaded = true;

  const originalFetch = window.fetch;
  const OriginalXHR = window.XMLHttpRequest;
  let activeRequestId = null;
  let lockedStreamKey = null;
  const processors = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== "webchat2local-content") return;
    if (event.data.type === "W2L_SET_ACTIVE_REQUEST") {
      activeRequestId = event.data.request_id;
      lockedStreamKey = null;
      processors.clear();
    } else if (event.data.type === "W2L_CLEAR_ACTIVE_REQUEST") {
      activeRequestId = null;
      lockedStreamKey = null;
      processors.clear();
    } else if (event.data.type === "W2L_PING_INTERCEPTOR") {
      postToContent({ type: "W2L_INTERCEPTOR_PONG", version: "1.0.0-chatgpt" });
    }
  });

  function postToContent(payload) {
    payload.source = "webchat2local-network";
    window.postMessage(payload, "*");
  }

  // Turn 期間全 POST 錄製：不再猜端點名。凡是發往 chatgpt.com 的 POST
  // 一律錄下回應體，再由解析層（SSE / 單 JSON / HTML）萃取答案；
  // 明確的輔助端點才排除。就算官方改路徑也不會再全瞎。
  function isSameOriginChatgpt(url) {
    try {
      const u = new URL(String(url || ""), window.location.href);
      const host = u.hostname.toLowerCase();
      return host === "chatgpt.com" || host.endsWith(".chatgpt.com");
    } catch (_) {
      return String(url || "").startsWith("/");
    }
  }

  // 答案流可能是 POST，也可能是 GET（SSE 更新流）。GET 只收「資料型」
  // content-type（event-stream / json / vnd），文件型 text/html 一律跳過，
  // 否則整頁 HTML 會被當成答案。
  function isStreamableContentType(ct, method) {
    const t = String(ct || "").toLowerCase();
    if (!t) return true; // 拿不到標頭時先收，解析層再過濾
    if (/image\/|audio\/|video\/|font\/|application\/(octet-stream|zip|gzip|pdf|x-protobuf|grpc)/i.test(t)) return false;
    if (String(method).toUpperCase() === "GET") {
      if (/text\/html/i.test(t)) return false;
      return /event-stream|json|vnd\.|text\/plain/i.test(t);
    }
    return true;
  }

  function isChatgptStreamUrl(url, method) {
    const m = String(method || "GET").toUpperCase();
    if (m !== "POST" && m !== "GET") return false;
    if (!isSameOriginChatgpt(url)) return false;
    const lower = String(url || "").toLowerCase();
    const EXCLUDES = [
      "/moderation", "/telemetry", "/sentinel", "/gen_title", "/lat", "/statsig",
      "/login", "/auth", "/signup", "/token", "/oauth", "/sentry", "/beacon",
      "/rum", "/cdn-cgi", "analytics", ".js", ".css", ".woff", "fonts",
      // Client-event telemetry + handshake endpoints: they answer tiny JSON
      // like {"success":true} / {"conduit_token":"..."} which is NEVER the
      // assistant answer. Capturing them lets a telemetry ACK win the turn
      // (verified: https://chatgpt.com/ces/v1/t returned {"success":true}
      // and completed the turn with garbage).
      "/ces/", "ces/v1", "/conversation/prepare", "prepare?lightweight",
    ];
    return !EXCLUDES.some((p) => lower.includes(p));
  }

  function shouldCapture(url) {
    if (!activeRequestId) {
      console.log(`[ChatGPT-Interceptor] SKIP no activeRequestId url=${url}`);
      return false;
    }
    if (!lockedStreamKey || lockedStreamKey === url) return true;
    console.log(`[ChatGPT-Interceptor] BLOCKED locked=${lockedStreamKey} url=${url}`);
    return false;
  }

  // ---------- entity decoding ----------
  let decodeEl = null;
  function decodeEntities(s) {
    try {
      if (!decodeEl) decodeEl = document.createElement("textarea");
      decodeEl.innerHTML = s;
      return decodeEl.value != null ? decodeEl.value : decodeEl.textContent || "";
    } catch (_) {
      return s;
    }
  }

  // ---------- HTML partial stream extraction ----------
  function extractVisibleText(raw) {
    let s = raw;

    // Hold back an unterminated trailing tag (<div class="x ...) so it never
    // leaks as literal text before the closing ">" arrives.
    const lastLt = s.lastIndexOf("<");
    const lastGt = s.lastIndexOf(">");
    if (lastLt > lastGt) s = s.slice(0, lastLt);

    // Hold back a possibly-incomplete trailing entity (&am / &#12)
    const amp = s.lastIndexOf("&");
    const semi = s.lastIndexOf(";");
    if (amp > semi && s.length - amp <= 10) s = s.slice(0, amp);

    // Drop script/style blocks entirely.
    s = s.replace(/<script[\s\S]*?<\/script>/gi, " ")
         .replace(/<style[\s\S]*?<\/style>/gi, " ");

    // ChatGPT unauth HTML partials wrap content in <template> tags which are
    // invisible in the DOM but DO contain the real text. Extract inner content
    // of <template>...</template> before stripping tags.
    s = s.replace(/<template[\s\S]*?>([\s\S]*?)<\/template>/gi, (_, inner) => " " + inner + " ");

    // Newlines for block-level boundaries.
    s = s.replace(/<br[^>]*>/gi, "\n")
         .replace(/<\/(?:p|div|h[1-6]|li|tr|pre|table|thead|tbody|ul|ol|blockquote|section|article)>/gi, "\n");

    // Strip all remaining tags.
    s = s.replace(/<[^>]+>/g, " ");

    return decodeEntities(s).replace(/[ \t]+\n/g, "\n");
  }

  function looksLikeSse(raw) {
    const t = raw.slice(0, 16384).trimStart();
    return t.startsWith("data:") || t.startsWith("event:") || /\n\s*data:/.test(t);
  }

  // ChatGPT's newer "conduit" infrastructure returns a handshake JSON like
  // {"conduit_token":"eyJ..."} from a conversation-related POST. It is NOT the
  // assistant answer and must never be forwarded as one.
  function looksLikeConduitToken(s) {
    const t = String(s || "").trim();
    if (!t.startsWith("{")) return false;
    return t.indexOf('"conduit_token"') >= 0 || t.indexOf('"conduit_uuid"') >= 0;
  }

  // Telemetry-shaped ACKs ({"success":true}, {"status":"ok",...}) are transport
  // receipts, never the assistant answer. A processor stuck with only such a
  // payload must die silently so the real answer stream can own the turn.
  function looksLikeTelemetryAck(s) {
    const t = String(s || "").trim();
    if (!t.startsWith("{") || t.length > 300) return false;
    if (!/^\{\s*"(success|status|ok)"\s*:/.test(t)) return false;
    // A real answer never serializes to a single tiny flat JSON object.
    return /^[^{}]*$/.test(t.slice(1, -1).replace(/"(?:[^"\\]|\\.)*"/g, ""));
  }

  // ---------- SSE (backend-api/conversation) parsing ----------
  function createSseState() {
    return { lineBuf: "", lastLineDone: false };
  }

  function feedSse(state, chunk, onEvent) {
    state.lineBuf += chunk;
    let nl;
    while ((nl = state.lineBuf.indexOf("\n")) >= 0) {
      const line = state.lineBuf.slice(0, nl).replace(/\r$/, "");
      state.lineBuf = state.lineBuf.slice(nl + 1);
      handleSseLine(line, onEvent);
    }
  }

  function handleSseLine(line, onEvent) {
    const t = line.trim();
    if (!t || t.startsWith(":") || t.startsWith("event:") || t.startsWith("id:")) return;
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      onEvent({ done: true });
      return;
    }
    let obj = null;
    try { obj = JSON.parse(payload); } catch (_) { return; }
    if (!obj || typeof obj !== "object") return;

    if (obj.error || obj.detail) {
      const msg = typeof obj.error === "string"
        ? obj.error
        : (obj.error && obj.error.message) || (typeof obj.detail === "string" ? obj.detail : "") || "ChatGPT stream error";
      onEvent({ error: String(msg) });
      return;
    }

    // Replacement-value patches: {"v": "...", "p": "/message/content/parts/0"}
    if (typeof obj.v === "string") {
      onEvent({ text: obj.v, replace: true });
      return;
    }
    // Full message snapshots: {"message": {"content": {"parts": ["..."]}}}
    if (obj.message && obj.message.content && Array.isArray(obj.message.content.parts)) {
      const parts = obj.message.content.parts.filter((p) => typeof p === "string");
      if (parts.length > 0) {
        onEvent({ text: parts.join("\n"), replace: true });
      }
      return;
    }
    if (typeof obj.content === "string") {
      onEvent({ text: obj.content, replace: true });
    }
  }

  // ---------- processor ----------
  function createProcessor(reqId, streamKeyVal) {
    let accumulatedRaw = "";
    let extracted = "";
    let fullText = "";
    let sseState = null;
    let mode = null; // "sse" | "html"
    let finished = false;
    let evidenceSent = false;
    // HTML partial (unauth 免費版) 每次都是整表 rebuild：後端只認 replacement
    // 語義 (參考 codex-chatgpt-web DOM .markdown 做法)，這裡同樣維護
    // htmlBest 取代語義，避免 accumulatedRaw 串接造成「前半 + 完整」重複。
    let htmlBest = "";

    function lock() {
      if (!lockedStreamKey) lockedStreamKey = streamKeyVal;
    }

    // 回報抓取證據：URL / content-type / 首 200 字，供 /v1/logs 直接判斷
    // GPT 網頁版到底回什麼（只送一次，避免洗版）。
    function sendEvidence(kind, preview) {
      if (evidenceSent) return;
      evidenceSent = true;
      try {
        const clean = String(preview || "").replace(/\s+/g, " ").slice(0, 200);
        postToContent({
          type: "debug",
          request_id: reqId,
          scope: "chatgpt-" + kind,
          text: String(streamKeyVal).slice(0, 160) + " | mode=" + (mode || "?") + " | head=" + clean,
        });
      } catch (_) {}
    }

    // 非串流單 JSON 回應（如 {"message":{"content":{"parts":[...]}}} 或
    // OpenAI 式 {"choices":[{"message":{"content":...}}]}）直接萃取答案。
    // 回傳 null 表示不是完整 JSON，呼叫方走原本的 HTML/SSE 路徑。
    function tryJsonAnswer(raw) {
      const t = String(raw || "").trim();
      if (!t.startsWith("{")) return null;
      let obj = null;
      try { obj = JSON.parse(t); } catch (_) { return null; }
      if (!obj || typeof obj !== "object") return null;
      if (typeof obj.v === "string" && obj.v.trim()) return obj.v;
      try {
        const parts = obj.message && obj.message.content && obj.message.content.parts;
        if (Array.isArray(parts)) {
          const s = parts.filter((p) => typeof p === "string").join("\n").trim();
          if (s) return s;
        }
      } catch (_) {}
      if (typeof obj.content === "string" && obj.content.trim()) return obj.content;
      try {
        const ch = obj.choices && obj.choices[0];
        const cm = ch && ch.message;
        if (cm) {
          if (typeof cm.content === "string" && cm.content.trim()) return cm.content;
          if (Array.isArray(cm.content)) {
            const s = cm.content
              .map((b) => (b && (b.text || b.content)) || "")
              .filter((x) => typeof x === "string").join("\n").trim();
            if (s) return s;
          }
        }
        if (typeof ch.text === "string" && ch.text.trim()) return ch.text;
      } catch (_) {}
      return null;
    }

    let jsonAnswer = "";

    // 與後端 _dedup_leading_repeat 同語義：HEAD + 換行 + REST，
    // REST 更長且以 HEAD 開頭即視為 rebuild 拼接，只留 REST。
    function dedupLeadingRepeat(t) {
      let s = String(t || "");
      for (let i = 0; i < 2; i++) {
        let m = s.match(/^(.+?)\r?\n[ \t\xa0]*\r?\n([\s\S]+)$/);
        if (m) {
          const head = m[1].trim(), rest = m[2], rs = rest.trim();
          if (head && rs.length >= head.length) {
            if (!(rs === head && rest === rs)
              && (rs.startsWith(head) || (head.length >= 4 && rs.includes(head)))) {
              s = rest.replace(/^[ \t\xa0]+/, "");
              continue;
            } else if (rs === head && rest === rs) {
              break; // 乾淨逐字重複，保留
            } else break;
          } else if (head) break;
        }
        m = s.match(/^(.+?)\r?\n[ \t\xa0]*([\s\S]+)$/);
        if (!m) break;
        const head = m[1].trim(), rest = m[2], rs = rest.trim();
        if (!head || head.length < 2 || rs.length < head.length + 2) break;
        if (rs.startsWith(head)) {
          s = rest.replace(/^[ \t\xa0]+/, "");
        } else break;
      }
      return s;
    }

    // Replacement 語義合併：新候選若包含舊最佳 (或反之)，取較長者；
    // 否則若有前後綴重疊則拼接，否則直接附加。
    function mergeReplacement(prev, inc) {
      if (!inc) return prev;
      if (!prev) return inc;
      const a = dedupLeadingRepeat(inc);
      const p = dedupLeadingRepeat(prev);
      if (a.startsWith(p)) return a;
      if (p.startsWith(a) || p.includes(a) && a.length >= 4) return p;
      if (a.length >= 4 && p.endsWith(a)) return p;
      const probe = a.replace(/^\s+/, "") || a;
      const maxk = Math.min(probe.length, p.length);
      let k = maxk;
      while (k >= 4 && !p.endsWith(probe.slice(0, k))) k--;
      if (k >= 4) return p + probe.slice(k);
      if (a.length >= 4 && p.includes(a)) return p;
      return dedupLeadingRepeat(p + "\n" + a);
    }

    function emitDelta() {
      const candidate = mode === "sse" ? fullText : (jsonAnswer || extractVisibleText(accumulatedRaw));
      if (!candidate) {
        if (accumulatedRaw.length > 100 && accumulatedRaw.length < 50000) {
          console.log(`[ChatGPT-Interceptor] EMPTY candidate raw_len=${accumulatedRaw.length} head=${accumulatedRaw.slice(0, 500)}`);
        }
        return;
      }
      if (looksLikeConduitToken(candidate)) {
        console.log(`[ChatGPT-Interceptor] CONDUIT SKIP (${candidate.length} chars)`);
        return;
      }

      // HTML partial streams (ChatGPT unauth) send FULL table rebuilds on each row.
      // Text extraction from each rebuild differs (structure changes), so streaming
      // produces garbage. Only emit on DONE for HTML mode; SSE mode streams cleanly.
      if (mode === "html") {
        return;
      }

      let delta = "";
      if (candidate.startsWith(extracted)) {
        delta = candidate.slice(extracted.length);
      } else {
        extracted = "";
        delta = candidate;
      }
      if (delta.length > 0) {
        extracted = candidate;
        lock();
        console.log(`[ChatGPT-Interceptor] EMIT delta=${delta.length} total=${extracted.length} mode=${mode}`);
        postToContent({ type: "chunk", request_id: reqId, delta, accumulated: extracted });
      }
    }

    function emitDone() {
      if (finished) return;
      finished = true;
      // HTML 模式：用 replacement 語義的 htmlBest，而非串接全文的
      // extractVisibleText(accumulatedRaw)——後者會把每次 rebuild 的
      // 前半重複算進去 (免費版「你好！+ 你好！很高兴...」即此成因)。
      const finalText = mode === "html"
        ? dedupLeadingRepeat(htmlBest || jsonAnswer || extractVisibleText(accumulatedRaw))
        : (extracted || fullText);
      console.log(`[ChatGPT-Interceptor] DONE extracted=${finalText.length} mode=${mode}`);
      if (looksLikeConduitToken(finalText)) {
        console.log(`[ChatGPT-Interceptor] DONE conduit detected, UNLOCKING stream key immediately`);
        postToContent({ type: "done", request_id: reqId, full_text: "" });
        if (lockedStreamKey === streamKeyVal) lockedStreamKey = null;
        return;
      }
      if (looksLikeTelemetryAck(finalText)) {
        console.log(`[ChatGPT-Interceptor] DONE telemetry ACK detected, suppressing (real stream owns the turn)`);
        if (lockedStreamKey === streamKeyVal) lockedStreamKey = null;
        return;
      }
      postToContent({ type: "done", request_id: reqId, full_text: finalText });
    }

    function handleSseEvent(ev) {
      if (ev.error) {
        if (!finished) {
          finished = true;
          postToContent({ type: "stream_error", request_id: reqId, error: ev.error });
        }
        return;
      }
      if (ev.done) {
        emitDone();
        return;
      }
      if (ev.replace && typeof ev.text === "string") {
        fullText = ev.text;
        emitDelta();
      }
    }

    // 單輪單 URL 累積上限：全 POST 錄製下避免分析請求等大體積
    // 回應把記憶體撐爆。超限後直接結束該 processor（DOM 路徑仍可兜底）。
    const MAX_RAW = 2000000;

    function feed(chunkText) {
      if (finished) return;
      if (accumulatedRaw.length > MAX_RAW) {
        finished = true;
        try { proc_end_on_overflow(); } catch (_) {}
        return;
      }
      accumulatedRaw += chunkText;
      // Telemetry ACK (e.g. {"success":true} from ces/v1/t) that slipped past
      // the URL filter: kill this processor silently, never let it own done.
      if (looksLikeTelemetryAck(accumulatedRaw)) {
        finished = true;
        console.log(`[ChatGPT-Interceptor] TELEMETRY SKIP (${accumulatedRaw.length} chars), releasing stream`);
        if (lockedStreamKey === streamKeyVal) lockedStreamKey = null;
        return;
      }
      console.log(`[ChatGPT-Interceptor] FEED chunk=${chunkText.length} accumulated=${accumulatedRaw.length} mode=${mode || "?"}`);

      if (!mode) {
        mode = looksLikeSse(accumulatedRaw) ? "sse" : "html";
        if (mode === "sse") sseState = createSseState();
        sendEvidence("first-chunk", accumulatedRaw);
        console.log(`[ChatGPT-Interceptor] MODE DETECTED: ${mode}`);
      }

      if (mode === "sse") {
        feedSse(sseState, chunkText, handleSseEvent);
      } else {
        // HTML partial stream. If a chunk restarts a full document, replace
        // the accumulated raw instead of appending duplicates.
        const trimmed = chunkText.trimStart();
        if (/^<!doctype|^<html[\s>]/i.test(trimmed) && accumulatedRaw.length > chunkText.length) {
          accumulatedRaw = chunkText;
          jsonAnswer = "";
          htmlBest = "";
        }
        const j = tryJsonAnswer(accumulatedRaw);
        if (j != null && j !== jsonAnswer) {
          if (!j.startsWith(jsonAnswer)) jsonAnswer = "";
          if (j.length > jsonAnswer.length) {
            jsonAnswer = j;
          }
        }
        // 每個 chunk 取可見文字，以 replacement 語義累積 htmlBest。
        // 單純 accumulatedRaw 串接會把 rebuild 的舊行重複保留。
        try {
          const cur = dedupLeadingRepeat(extractVisibleText(chunkText));
          if (cur && !looksLikeConduitToken(cur)) {
            const merged = mergeReplacement(htmlBest, cur);
            if (merged !== htmlBest) htmlBest = merged;
          } else if (!cur) {
            // 碎片 chunk (半個 tag) 萃不出文字：退回用全文重算一次，
            // 但同樣走 replacement 語義而非直接串接。
            const whole = dedupLeadingRepeat(extractVisibleText(accumulatedRaw));
            if (whole && !looksLikeConduitToken(whole)) {
              htmlBest = mergeReplacement(htmlBest, whole);
            }
          }
        } catch (_) {}
        emitDelta();
      }
    }

    function proc_end_on_overflow() {
      postToContent({ type: "done", request_id: reqId, full_text: "" });
    }

    return { feed, end: emitDone, isFinished: () => finished };
  }

  function getProcessor(url) {
    // Empty URL (e.g. relative fetch) — use a generated key so lock() doesn't
    // set lockedStreamKey="" which would block ALL subsequent real-URL captures.
    const streamKey = url || ("_gen_" + activeRequestId + "_" + Date.now());
    let proc = processors.get(streamKey);
    if (proc && proc.isFinished && proc.isFinished()) {
      processors.delete(streamKey);
      proc = null;
    }
    if (!proc) {
      proc = createProcessor(activeRequestId || "req_" + Date.now(), streamKey);
      processors.set(streamKey, proc);
      while (processors.size > 24) {
        let evicted = false;
        for (const [k, v] of processors) {
          if (v && v.isFinished && v.isFinished()) {
            processors.delete(k);
            evicted = true;
            break;
          }
        }
        if (!evicted) processors.delete(processors.keys().next().value);
      }
    }
    return proc;
  }

  // ---------- fetch hook ----------
  window.fetch = async function (...args) {
    let url = "";
    let method = "GET";
    try {
      if (typeof args[0] === "string") {
        url = args[0]; method = (args[1] && args[1].method) || "GET";
      } else if (args[0] && args[0].url) {
        url = args[0].url; method = (args[1] && args[1].method) || args[0].method || "GET";
      }
    } catch (_) {}

    const response = await originalFetch.apply(this, args);
    if (!isChatgptStreamUrl(url, method) || !response?.body || !shouldCapture(url)) return response;

    const contentType = (() => {
      try { return response.headers.get("content-type") || ""; } catch (_) { return ""; }
    })();
    if (!isStreamableContentType(contentType, method)) {
      return response;
    }

    console.log(`[ChatGPT-Interceptor] CAPTURE ${method} ${url.slice(0, 120)} ct=${contentType.slice(0, 80)}`);
    postToContent({
      type: "capture_attempt",
      url: String(url).slice(0, 200),
      transport: String(url).toLowerCase().includes("unauth") ? "unauth-updates" : "backend-api",
      gated: false,
    });

    const proc = getProcessor(url);
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder("utf-8");
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          proc.feed(decoder.decode(value, { stream: true }));
        }
        proc.end();
      } catch (e) {
        console.warn("[ChatGpt Bridge] raw fetch capture failed", e);
        proc.end();
      }
    })();
    return response;
  };

  // ---------- XHR hook (fallback transport) ----------
  if (OriginalXHR) {
    function HookedXHR() {
      const xhr = new OriginalXHR();
      let xhrUrl = "";
      let xhrMethod = "GET";
      let lastLen = 0;
      let proc = null;
      const origOpen = xhr.open;
      xhr.open = function (method, url) {
        xhrMethod = String(method || "GET");
        xhrUrl = String(url || "");
        return origOpen.apply(this, arguments);
      };
      xhr.addEventListener("readystatechange", () => {
        if (xhr.readyState < 3 || !isChatgptStreamUrl(xhrUrl, xhrMethod) || !shouldCapture(xhrUrl)) return;
        try {
          if (String(xhrMethod).toUpperCase() === "GET") {
            let ct = "";
            try { ct = xhr.getResponseHeader("content-type") || ""; } catch (_) {}
            if (!isStreamableContentType(ct, "GET")) return;
          }
          if (!proc) {
            console.log(`[ChatGPT-Interceptor] XHR CAPTURE ${xhrMethod} ${xhrUrl.slice(0, 120)}`);
            proc = getProcessor(xhrUrl);
          }
          const text = xhr.responseText;
          if (typeof text === "string" && text.length > lastLen) {
            proc.feed(text.slice(lastLen));
            lastLen = text.length;
          }
          if (xhr.readyState === 4) proc.end();
        } catch (_) {}
      });
      return xhr;
    }
    HookedXHR.prototype = OriginalXHR.prototype;
    Object.assign(HookedXHR, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });
    window.XMLHttpRequest = HookedXHR;
  }
})();